/**
 * Mistral family wire.
 *
 * Pure protocol module: builds Mistral request bodies, parses
 * responses. NO endpoints, NO API keys, NO network calls. Vendors
 * (direct Mistral, Azure-Mistral, Vertex Marketplace, etc.) own the
 * transport.
 *
 * Surfaces covered:
 *
 *   - `/v1/chat/completions`     — chat (OpenAI-compat plus Mistral extras)
 *   - `/v1/fim/completions`      — fill-in-the-middle code completion (Codestral)
 *   - `/v1/embeddings`           — embeddings
 *   - `/v1/classifiers`          — toxicity / moderation / custom classify
 *   - `/v1/ocr`                  — PDF / image OCR with bbox + structured annotation
 *
 * Spec: https://docs.mistral.ai/api/
 */

import type { Call, Message, Tool, Choice, Usage } from "../../core.js";
import {
    asRecord,
    clean,
    findAttachmentUrl,
    normalizeOpenAIUsage,
    stripResponsesParams,
} from "../shared/index.js";
import * as lower from "../shared/schema.js";
import type {
    OcrDocument,
    OcrPage,
    OcrPageImage,
    OcrRequest,
    OcrResult,
} from "../modalities/ocr.js";
import type {
    ClassificationRequest,
    ClassificationResult,
    ClassificationResultEntry,
    ClassificationLabel,
} from "../modalities/classification.js";
import { ocrBillingMetrics } from "../modalities/ocr.js";
import { classifyBillingMetrics } from "../modalities/classification.js";

// ---------------------------------------------------------------------------
// Path constants — vendors prefix these with their host
// ---------------------------------------------------------------------------

export const MISTRAL_PATH_CHAT = "/v1/chat/completions";
export const MISTRAL_PATH_EMBEDDINGS = "/v1/embeddings";
export const MISTRAL_PATH_FIM = "/v1/fim/completions";
export const MISTRAL_PATH_CLASSIFIERS = "/v1/classifiers";
export const MISTRAL_PATH_OCR = "/v1/ocr";

// ---------------------------------------------------------------------------
// Chat (OpenAI-compatible plus Mistral-native knobs)
// ---------------------------------------------------------------------------

export interface MistralChatOptions {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    randomSeed?: number;
    stop?: string | string[];
    stream?: boolean;
    safePrompt?: boolean;
    presencePenalty?: number;
    frequencyPenalty?: number;
    promptCacheKey?: string;
    promptMode?: "reasoning";
    reasoningEffort?: "high" | "none";
    parallelToolCalls?: boolean;
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: unknown;
    customParams?: Record<string, unknown>;
    wireModelId?: string;
}

export interface MistralChatResult {
    text: string;
    reasoningContent?: string;
    toolCalls?: Call[];
    finishReason?: string;
    usage?: Usage;
    raw: unknown;
}

function toolsToWire(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: lower.object(tool.parameters),
        },
    }));
}

function toolChoiceToWire(choice: Choice | undefined): unknown {
    if (!choice || typeof choice === "string") return choice;
    return { type: "function", function: { name: choice.name } };
}

export function mapFinishReason(value: unknown, hasTools = false): string {
    const reason = clean(value);
    if (hasTools || reason === "tool_calls") return "tool-calls";
    if (reason === "model_length") return "length";
    return reason || "stop";
}

function extractMistralContent(content: unknown): { text: string; reasoning: string } {
    if (typeof content === "string") return { text: content, reasoning: "" };
    if (!Array.isArray(content)) return { text: "", reasoning: "" };
    const texts: string[] = [];
    const reasonings: string[] = [];
    for (const part of content) {
        const record = asRecord(part);
        if (!record) continue;
        const type = clean(record.type);
        if (type === "text" && typeof record.text === "string") {
            texts.push(record.text);
        } else if (type === "thinking") {
            if (typeof record.thinking === "string") {
                reasonings.push(record.thinking);
            } else if (Array.isArray(record.thinking)) {
                for (const sub of record.thinking) {
                    const subRec = asRecord(sub);
                    if (typeof subRec?.text === "string") reasonings.push(subRec.text);
                }
            }
        }
    }
    return { text: texts.join(""), reasoning: reasonings.join("") };
}

function parseMistralToolCalls(message: Record<string, unknown>): Call[] | undefined {
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const out: Call[] = [];
    for (const rawCall of rawCalls) {
        const record = asRecord(rawCall);
        const fn = asRecord(record?.function);
        const name = clean(fn?.name);
        if (!record || !fn || !name) continue;
        out.push({
            id: clean(record.id) || `call_${out.length}`,
            name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
    }
    return out.length > 0 ? out : undefined;
}

export function buildChatBody(
    modelId: string,
    messages: Message[],
    options: MistralChatOptions = {},
    streaming = false,
): Record<string, unknown> {
    const isStream = streaming || Boolean(options.stream);
    const params = stripResponsesParams(options.customParams);
    return {
        model: options.wireModelId || modelId,
        messages,
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.randomSeed === "number" ? { random_seed: options.randomSeed } : {}),
        ...(options.stop ? { stop: options.stop } : {}),
        ...(typeof options.safePrompt === "boolean" ? { safe_prompt: options.safePrompt } : {}),
        ...(typeof options.presencePenalty === "number" ? { presence_penalty: options.presencePenalty } : {}),
        ...(typeof options.frequencyPenalty === "number" ? { frequency_penalty: options.frequencyPenalty } : {}),
        ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
        ...(options.promptMode ? { prompt_mode: options.promptMode } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(typeof options.parallelToolCalls === "boolean" ? { parallel_tool_calls: options.parallelToolCalls } : {}),
        ...(options.tools ? { tools: toolsToWire(options.tools) } : {}),
        ...(options.toolChoice ? { tool_choice: toolChoiceToWire(options.toolChoice) } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(isStream ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...params,
    };
}

export function parseChatResponse(raw: unknown): MistralChatResult {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};
    const { text, reasoning } = extractMistralContent(message.content);
    const reasoningContent = reasoning || (typeof message.reasoning_content === "string" ? message.reasoning_content : "");
    const toolCalls = parseMistralToolCalls(message);
    return {
        text,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        finishReason: mapFinishReason(first.finish_reason, Boolean(toolCalls?.length)),
        usage: normalizeOpenAIUsage(root.usage),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Streaming — SSE parser
// ---------------------------------------------------------------------------

export type MistralStreamEvent =
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
    | { type: "finish"; finishReason?: string; usage?: Usage };

export function createStreamParser() {
    let lastUsage: Usage | undefined;
    let lastFinishReason = "";
    let sawTools = false;

    function feed(payload: unknown): MistralStreamEvent[] {
        const chunk = asRecord(payload);
        if (!chunk) return [];
        const events: MistralStreamEvent[] = [];
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const first = asRecord(choices[0]);
        const delta = asRecord(first?.delta);
        if (delta) {
            const { text, reasoning } = extractMistralContent(delta.content);
            const reasoningText = reasoning || (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "");
            if (reasoningText) events.push({ type: "reasoning-delta", text: reasoningText });
            if (text) events.push({ type: "text-delta", text });
            const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const rawCall of toolCalls) {
                const record = asRecord(rawCall);
                if (!record) continue;
                const index = typeof record.index === "number" ? record.index : 0;
                const fn = asRecord(record.function);
                events.push({
                    type: "tool-call-delta",
                    index,
                    ...(clean(record.id) ? { id: clean(record.id) } : {}),
                    ...(clean(fn?.name) ? { name: clean(fn?.name) } : {}),
                    ...(typeof fn?.arguments === "string" && fn.arguments.length > 0 ? { argumentsDelta: fn.arguments } : {}),
                });
                sawTools = true;
            }
        }
        const usage = normalizeOpenAIUsage(chunk.usage);
        if (usage) lastUsage = usage;
        if (first?.finish_reason != null) {
            lastFinishReason = clean(first.finish_reason);
        }
        return events;
    }

    function finalize(): Extract<MistralStreamEvent, { type: "finish" }> {
        return {
            type: "finish",
            finishReason: mapFinishReason(lastFinishReason, sawTools),
            ...(lastUsage ? { usage: lastUsage } : {}),
        };
    }

    return { feed, finalize };
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface MistralEmbeddingResult {
    embeddings: number[][];
    usage?: Usage;
    raw: unknown;
}

export function buildEmbeddingsBody(
    modelId: string,
    input: string[],
    options: { customParams?: Record<string, unknown> } = {},
): Record<string, unknown> {
    return { model: modelId, input, ...(options.customParams ?? {}) };
}

export function parseEmbeddingsResponse(raw: unknown): MistralEmbeddingResult {
    const root = asRecord(raw) || {};
    const data = Array.isArray(root.data) ? root.data : [];
    const out = data
        .map((item) => asRecord(item)?.embedding)
        .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((v) => typeof v === "number"));
    return { embeddings: out, usage: normalizeOpenAIUsage(root.usage), raw };
}

// ---------------------------------------------------------------------------
// Fill-in-the-middle (Codestral)
// ---------------------------------------------------------------------------

export interface MistralFimOptions {
    suffix?: string;
    stop?: string | string[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    randomSeed?: number;
    customParams?: Record<string, unknown>;
}

export interface MistralFimResult {
    text: string;
    usage?: Usage;
    raw: unknown;
}

export function buildFimBody(
    modelId: string,
    prompt: string,
    options: MistralFimOptions = {},
): Record<string, unknown> {
    return {
        model: modelId,
        prompt,
        ...(options.suffix ? { suffix: options.suffix } : {}),
        ...(options.stop ? { stop: options.stop } : {}),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.randomSeed === "number" ? { random_seed: options.randomSeed } : {}),
        ...(options.customParams ?? {}),
    };
}

export function parseFimResponse(raw: unknown): MistralFimResult {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};
    return { text: clean(message.content) || clean(first.text), usage: normalizeOpenAIUsage(root.usage), raw };
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

export function buildClassifyBody(modelId: string, request: ClassificationRequest): { body: Record<string, unknown>; inputCount: number } {
    const rawInputs = Array.isArray(request.inputs) ? request.inputs : [request.inputs];
    const inputs: string[] = [];
    for (const input of rawInputs) {
        if (typeof input === "string") {
            inputs.push(input);
        } else if (input && typeof input === "object" && "type" in input && input.type === "text" && typeof (input as { text?: unknown }).text === "string") {
            inputs.push((input as { text: string }).text);
        } else if (input && typeof input === "object" && !("type" in input)) {
            // Plain string-record fallback: skip non-text shapes.
            throw new Error(`Mistral classifiers only accept text inputs`);
        } else {
            throw new Error(`Mistral classifiers only accept text inputs`);
        }
    }
    return {
        inputCount: inputs.length,
        body: {
            model: modelId,
            input: inputs,
            ...(request.candidate_labels ? { labels: request.candidate_labels } : {}),
            ...(request.customParams ?? {}),
        },
    };
}

export function parseClassifyResponse(raw: unknown, inputCount: number): ClassificationResult {
    const root = asRecord(raw) || {};
    const results = Array.isArray(root.results) ? root.results : [];
    const items: ClassificationResultEntry[] = results.map((entry, index) => {
        const record = asRecord(entry) || {};
        const categories = asRecord(record.categories) || {};
        const scores = asRecord(record.category_scores) || {};
        const labels: ClassificationLabel[] = [];
        for (const [label, score] of Object.entries(scores)) {
            if (typeof score === "number") labels.push({ label, score });
        }
        labels.sort((a, b) => b.score - a.score);
        // Fall back to boolean categories.
        if (labels.length === 0) {
            for (const [label, flag] of Object.entries(categories)) {
                if (typeof flag === "boolean") labels.push({ label, score: flag ? 1 : 0 });
            }
        }
        const flagged = labels.some((entry) => entry.score >= 0.5);
        return { index, labels, ...(flagged ? { flagged: true } : {}) };
    });
    return {
        results: items,
        usage: {
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            billingMetrics: classifyBillingMetrics(inputCount),
        },
        raw,
    };
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

function ocrDocumentToWire(doc: OcrDocument): Record<string, unknown> {
    switch (doc.type) {
        case "document_url": return { type: "document_url", document_url: doc.documentUrl };
        case "image_url": return { type: "image_url", image_url: { url: doc.imageUrl } };
        case "file_id": return { type: "file_id", file_id: doc.fileId };
        case "base64": {
            const mediaType = doc.mediaType || "application/pdf";
            const dataUrl = `data:${mediaType};base64,${doc.data}`;
            return mediaType.startsWith("image/")
                ? { type: "image_url", image_url: { url: dataUrl } }
                : { type: "document_url", document_url: dataUrl };
        }
    }
}

export function buildOcrBody(modelId: string, request: OcrRequest): Record<string, unknown> {
    return {
        model: modelId,
        document: ocrDocumentToWire(request.document),
        ...(request.pages ? { pages: request.pages } : {}),
        ...(typeof request.include_image_base64 === "boolean" ? { include_image_base64: request.include_image_base64 } : {}),
        ...(typeof request.image_limit === "number" ? { image_limit: request.image_limit } : {}),
        ...(typeof request.image_min_size === "number" ? { image_min_size: request.image_min_size } : {}),
        ...(request.table_format ? { table_format: request.table_format } : {}),
        ...(typeof request.extract_header === "boolean" ? { extract_header: request.extract_header } : {}),
        ...(typeof request.extract_footer === "boolean" ? { extract_footer: request.extract_footer } : {}),
        ...(request.confidence_scores ? { confidence_scores_granularity: request.confidence_scores } : {}),
        ...(request.document_annotation_format ? { document_annotation_format: request.document_annotation_format } : {}),
        ...(request.document_annotation_prompt ? { document_annotation_prompt: request.document_annotation_prompt } : {}),
        ...(request.bbox_annotation_format ? { bbox_annotation_format: request.bbox_annotation_format } : {}),
        ...(request.customParams ?? {}),
    };
}

export function parseOcrResponse(raw: unknown): OcrResult {
    const root = asRecord(raw) || {};
    const pagesIn = Array.isArray(root.pages) ? root.pages : [];
    const pages: OcrPage[] = pagesIn.map((entry) => {
        const record = asRecord(entry) || {};
        const dimensions = asRecord(record.dimensions);
        const imagesIn = Array.isArray(record.images) ? record.images : [];
        const images: OcrPageImage[] = imagesIn.map((image) => {
            const ir = asRecord(image) || {};
            return {
                id: clean(ir.id),
                topLeft: { x: Number(ir.top_left_x) || 0, y: Number(ir.top_left_y) || 0 },
                bottomRight: { x: Number(ir.bottom_right_x) || 0, y: Number(ir.bottom_right_y) || 0 },
                ...(typeof ir.image_base64 === "string" ? { imageBase64: ir.image_base64 } : {}),
            };
        });
        return {
            index: typeof record.index === "number" ? record.index : 1,
            markdown: clean(record.markdown),
            images,
            ...(dimensions ? {
                dimensions: {
                    ...(typeof dimensions.dpi === "number" ? { dpi: dimensions.dpi } : {}),
                    ...(typeof dimensions.width === "number" ? { width: dimensions.width } : {}),
                    ...(typeof dimensions.height === "number" ? { height: dimensions.height } : {}),
                }
            } : {}),
        };
    });
    const usageInfo = asRecord(root.usage_info);
    const pagesProcessed = typeof usageInfo?.pages_processed === "number" ? usageInfo.pages_processed : pages.length;
    return {
        pages,
        ...(typeof root.document_annotation === "string" ? { documentAnnotation: root.document_annotation } : {}),
        pagesProcessed,
        ...(typeof usageInfo?.doc_size_bytes === "number" ? { docSizeBytes: usageInfo.doc_size_bytes } : {}),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: ocrBillingMetrics(pagesProcessed) },
        raw,
    };
}

/**
 * Convenience: extract a Mistral OCR document from a `Message[]`
 * by walking image_url attachments. Used by vendor adapters.
 */
export function ocrDocumentFromMessages(messages: Message[]): OcrDocument | null {
    const url = findAttachmentUrl(messages, "image_url");
    if (!url) return null;
    return { type: "image_url", imageUrl: url };
}
