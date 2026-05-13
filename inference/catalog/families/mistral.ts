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

import type { UnifiedMessage, UnifiedTool, UnifiedToolChoice, UnifiedUsage } from "../../core.js";
import {
    asRecord,
    clean,
    findAttachmentUrl,
    normalizeOpenAIUsage,
} from "../shared/index.js";
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
    tools?: UnifiedTool[];
    toolChoice?: UnifiedToolChoice;
    responseFormat?: unknown;
    customParams?: Record<string, unknown>;
    wireModelId?: string;
}

export interface MistralChatResult {
    text: string;
    finishReason?: string;
    usage?: UnifiedUsage;
    raw: unknown;
}

export function buildChatBody(
    modelId: string,
    messages: UnifiedMessage[],
    options: MistralChatOptions = {},
): Record<string, unknown> {
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
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(options.stream ? { stream: true } : {}),
        ...(options.customParams ?? {}),
    };
}

export function parseChatResponse(raw: unknown): MistralChatResult {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};
    return {
        text: clean(message.content),
        finishReason: clean(first.finish_reason) || undefined,
        usage: normalizeOpenAIUsage(root.usage),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface MistralEmbeddingResult {
    embeddings: number[][];
    usage?: UnifiedUsage;
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
    usage?: UnifiedUsage;
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
 * Convenience: extract a Mistral OCR document from a `UnifiedMessage[]`
 * by walking image_url attachments. Used by vendor adapters.
 */
export function ocrDocumentFromMessages(messages: UnifiedMessage[]): OcrDocument | null {
    const url = findAttachmentUrl(messages, "image_url");
    if (!url) return null;
    return { type: "image_url", imageUrl: url };
}
