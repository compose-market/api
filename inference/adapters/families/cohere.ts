/**
 * Cohere family wire.
 *
 * Pure protocol module: builds Cohere request bodies, translates
 * Compose `Message[]` into Cohere chat-message shape, and
 * decodes Cohere responses (chat / embed / rerank / classify) into
 * canonical Compose types. NO endpoints, NO API keys, NO network.
 *
 * Vendors that route Cohere models (direct Cohere, Azure-hosted under
 * `/providers/cohere/...`, Bedrock, etc.) own the transport. This
 * module exposes:
 *
 *   - Path constants for the four Cohere surfaces.
 *   - `usageFromCohere`: meta-shaped usage normalizer.
 *   - `mapMessagesForCohere`: Message[] → Cohere chat shape.
 *   - `buildChatBody` / `parseChatResponse` (chat v2).
 *   - `buildEmbedBody` / `parseEmbedResponse` (embed v2).
 *   - `buildRerankBody` / `parseRerankResponse` (rerank v2).
 *   - `buildClassifyBody` / `parseClassifyResponse` (classify v1).
 *
 * Spec: https://docs.cohere.com/reference/about
 */

import type { Call, Message, Tool, Choice, Usage } from "../../core.js";
import { asRecord, assignMetric, clean, readNonNeg, stripResponsesParams } from "../shared/index.js";
import * as lower from "../shared/schema.js";
import type { RerankRequest, RerankResult, RerankResultItem } from "../modalities/rerank.js";
import { rerankBillingMetrics } from "../modalities/rerank.js";
import type { ClassificationRequest, ClassificationResult, ClassificationResultEntry, ClassificationLabel } from "../modalities/classification.js";
import { classifyBillingMetrics } from "../modalities/classification.js";

// ---------------------------------------------------------------------------
// Path constants — vendors prefix with their own origin
// ---------------------------------------------------------------------------

export const COHERE_PATH_CHAT = "/v2/chat";
export const COHERE_PATH_EMBED = "/v2/embed";
export const COHERE_PATH_RERANK = "/v2/rerank";
/** Classify is the legacy v1 surface. */
export const COHERE_PATH_CLASSIFY = "/v1/classify";

// ---------------------------------------------------------------------------
// Usage normalizer (Cohere `meta.billed_units` + `meta.tokens`)
// ---------------------------------------------------------------------------

export function usageFromCohere(rawMeta: unknown): Usage | undefined {
    const meta = asRecord(rawMeta);
    if (!meta) return undefined;
    const billed = asRecord(meta.billed_units) || {};
    const tokens = asRecord(meta.tokens) || {};
    const inputTokens = readNonNeg(tokens, ["input_tokens"]) ?? readNonNeg(billed, ["input_tokens"]) ?? 0;
    const outputTokens = readNonNeg(tokens, ["output_tokens"]) ?? readNonNeg(billed, ["output_tokens"]) ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const cachedTokens = readNonNeg(meta, ["cached_tokens"]);
    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", inputTokens);
    assignMetric(billingMetrics, "output_tokens", outputTokens);
    assignMetric(billingMetrics, "total_tokens", totalTokens);
    assignMetric(billingMetrics, "cached_input_tokens", cachedTokens);
    assignMetric(billingMetrics, "search_units", readNonNeg(billed, ["search_units"]));
    assignMetric(billingMetrics, "classifications", readNonNeg(billed, ["classifications"]));
    assignMetric(billingMetrics, "image_tokens", readNonNeg(billed, ["image_tokens"]));
    assignMetric(billingMetrics, "images", readNonNeg(billed, ["images"]));
    return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        ...(typeof cachedTokens === "number" ? { cachedInputTokens: cachedTokens } : {}),
        billingMetrics,
        raw: meta,
    };
}

// ---------------------------------------------------------------------------
// Chat v2 — message translation + body builder + response parser
// ---------------------------------------------------------------------------

export interface CohereChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
}

export function mapMessagesForCohere(messages: Message[]): CohereChatMessage[] {
    return messages.map((message) => {
        if (typeof message.content === "string") {
            return {
                role: message.role,
                content: message.content,
                ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
                ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            };
        }
        if (!Array.isArray(message.content)) return { role: message.role };
        const blocks = message.content
            .map((part) => {
                if (part.type === "text" && typeof part.text === "string") return { type: "text" as const, text: part.text };
                if (part.type === "image_url") {
                    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
                    if (url) return { type: "image_url" as const, image_url: { url } };
                }
                return null;
            })
            .filter((part): part is { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } } => part !== null);
        return {
            role: message.role,
            ...(blocks.length > 0 ? { content: blocks } : {}),
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        };
    });
}

export interface CohereChatOptions {
    temperature?: number;
    maxTokens?: number;
    /** Cohere uses `p` instead of `top_p`. */
    p?: number;
    k?: number;
    stopSequences?: string[];
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: unknown;
    customParams?: Record<string, unknown>;
    wireModelId?: string;
}

export interface CohereChatResult {
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
    const reason = clean(value).toUpperCase();
    if (hasTools || reason === "TOOL_CALL" || reason === "TOOL_CALLS") return "tool-calls";
    if (reason === "MAX_TOKENS" || reason === "LENGTH") return "length";
    if (!reason || reason === "COMPLETE" || reason === "STOP_SEQUENCE" || reason === "STOP") return "stop";
    return clean(value).toLowerCase();
}

function parseCohereToolCalls(message: Record<string, unknown>): Call[] | undefined {
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const out: Call[] = [];
    for (const rawCall of rawCalls) {
        const record = asRecord(rawCall);
        const fn = asRecord(record?.function);
        const name = clean(fn?.name) || clean(record?.name);
        if (!record || !name) continue;
        const rawArgs = fn ? fn.arguments : record.parameters;
        out.push({
            id: clean(record.id) || `call_${out.length}`,
            name,
            arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}),
        });
    }
    return out.length > 0 ? out : undefined;
}

export function buildChatBody(
    modelId: string,
    messages: Message[],
    options: CohereChatOptions = {},
    streaming = false,
): Record<string, unknown> {
    const params = stripResponsesParams(options.customParams);
    return {
        model: options.wireModelId || modelId,
        messages: mapMessagesForCohere(messages),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(typeof options.p === "number" ? { p: options.p } : {}),
        ...(typeof options.k === "number" ? { k: options.k } : {}),
        ...(options.stopSequences && options.stopSequences.length > 0 ? { stop_sequences: options.stopSequences } : {}),
        ...(options.tools ? { tools: toolsToWire(options.tools) } : {}),
        ...(options.toolChoice ? { tool_choice: toolChoiceToWire(options.toolChoice) } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(streaming ? { stream: true } : {}),
        ...params,
    };
}

export function parseChatResponse(raw: unknown): CohereChatResult {
    const root = asRecord(raw) || {};
    const message = asRecord(root.message) || {};
    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    for (const part of contentBlocks) {
        const r = asRecord(part);
        if (!r) continue;
        if (r.type === "text" && typeof r.text === "string") textParts.push(r.text);
        if (r.type === "thinking" && typeof r.thinking === "string") thinkingParts.push(r.thinking);
    }
    const text = textParts.join("") || (typeof message.content === "string" ? message.content : "");
    const reasoningContent = thinkingParts.join("");
    const toolCalls = parseCohereToolCalls(message);
    return {
        text,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        finishReason: mapFinishReason(root.finish_reason, Boolean(toolCalls?.length)),
        usage: usageFromCohere(root.usage ?? root.meta),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Streaming — Cohere v2 SSE parser
// ---------------------------------------------------------------------------

export type CohereStreamEvent =
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
    | { type: "finish"; finishReason?: string; usage?: Usage };

export function createStreamParser() {
    let lastUsage: Usage | undefined;
    let lastFinishReason = "";
    let sawTools = false;

    function feed(payload: unknown): CohereStreamEvent[] {
        const chunk = asRecord(payload);
        if (!chunk) return [];
        const events: CohereStreamEvent[] = [];
        const type = clean(chunk.type);
        const delta = asRecord(chunk.delta);
        const message = asRecord(delta?.message);

        if (type === "content-delta") {
            const content = asRecord(message?.content);
            if (typeof content?.thinking === "string" && content.thinking) {
                events.push({ type: "reasoning-delta", text: content.thinking });
            }
            if (typeof content?.text === "string" && content.text) {
                events.push({ type: "text-delta", text: content.text });
            }
            return events;
        }

        if (type === "tool-call-start" || type === "tool-call-delta") {
            const index = typeof chunk.index === "number" ? chunk.index : 0;
            const call = asRecord(message?.tool_calls);
            const fn = asRecord(call?.function);
            const id = clean(call?.id);
            const name = clean(fn?.name);
            const argsDelta = typeof fn?.arguments === "string" ? fn.arguments : "";
            if (id || name || argsDelta) {
                events.push({
                    type: "tool-call-delta",
                    index,
                    ...(id ? { id } : {}),
                    ...(name ? { name } : {}),
                    ...(argsDelta ? { argumentsDelta: argsDelta } : {}),
                });
                sawTools = true;
            }
            return events;
        }

        if (type === "message-end") {
            if (delta?.finish_reason != null) {
                lastFinishReason = clean(delta.finish_reason);
            }
            const parsedUsage = usageFromCohere(delta?.usage ?? chunk.usage ?? chunk.meta);
            if (parsedUsage) lastUsage = parsedUsage;
            return events;
        }

        return events;
    }

    function finalize(): Extract<CohereStreamEvent, { type: "finish" }> {
        return {
            type: "finish",
            finishReason: mapFinishReason(lastFinishReason, sawTools),
            ...(lastUsage ? { usage: lastUsage } : {}),
        };
    }

    return { feed, finalize };
}

// ---------------------------------------------------------------------------
// Embed v2
// ---------------------------------------------------------------------------

export type CohereInputType = "search_query" | "search_document" | "classification" | "clustering" | "image";
export type CohereEmbeddingType = "float" | "int8" | "uint8" | "binary" | "ubinary";

export interface CohereEmbedOptions {
    inputType?: CohereInputType;
    embeddingTypes?: CohereEmbeddingType[];
    truncate?: "NONE" | "START" | "END";
    customParams?: Record<string, unknown>;
}

export interface CohereEmbedResult {
    embeddings: number[][];
    /** When `embeddingTypes` requests multiple flavors, all are kept. */
    embeddingsByType?: Record<CohereEmbeddingType, number[][]>;
    usage?: Usage;
    raw: unknown;
}

export function buildEmbedBody(
    modelId: string,
    texts: string[],
    options: CohereEmbedOptions = {},
): Record<string, unknown> {
    return {
        model: modelId,
        texts,
        input_type: options.inputType ?? "search_document",
        ...(options.embeddingTypes ? { embedding_types: options.embeddingTypes } : {}),
        ...(options.truncate ? { truncate: options.truncate } : {}),
        ...(options.customParams ?? {}),
    };
}

export function parseEmbedResponse(raw: unknown): CohereEmbedResult {
    const root = asRecord(raw) || {};
    const embeddings = asRecord(root.embeddings);
    const floats: number[][] = Array.isArray(embeddings?.float) ? embeddings.float
        : Array.isArray(root.embeddings) ? root.embeddings as number[][]
            : [];
    const byType: Record<string, number[][]> = {};
    if (embeddings) {
        for (const [k, v] of Object.entries(embeddings)) {
            if (Array.isArray(v) && v.every((row) => Array.isArray(row))) {
                byType[k] = v as number[][];
            }
        }
    }
    return {
        embeddings: floats,
        ...(Object.keys(byType).length > 0 ? { embeddingsByType: byType as Record<CohereEmbeddingType, number[][]> } : {}),
        usage: usageFromCohere(root.meta),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Rerank v2
// ---------------------------------------------------------------------------

export type CohereRerankBodyRequest = Omit<RerankRequest, "documents"> & {
    documents: Array<string | Record<string, unknown>>;
    max_chunks_per_doc?: number;
};

export function buildRerankBody(modelId: string, request: CohereRerankBodyRequest): Record<string, unknown> {
    return {
        model: modelId,
        query: request.query,
        documents: request.documents,
        ...(typeof request.top_n === "number" ? { top_n: request.top_n } : {}),
        ...(typeof request.max_tokens_per_doc === "number" ? { max_tokens_per_doc: request.max_tokens_per_doc } : {}),
        ...(typeof request.max_chunks_per_doc === "number" ? { max_chunks_per_doc: request.max_chunks_per_doc } : {}),
        ...(request.customParams ?? {}),
    };
}

export function parseRerankResponse(raw: unknown, request: RerankRequest): RerankResult {
    const root = asRecord(raw) || {};
    const items = Array.isArray(root.results) ? root.results : [];
    const results: RerankResultItem[] = items
        .map((entry) => {
            const r = asRecord(entry);
            if (!r) return null;
            const idx = typeof r.index === "number" ? r.index : -1;
            const score = typeof r.relevance_score === "number" ? r.relevance_score : 0;
            if (idx < 0) return null;
            return {
                index: idx,
                relevanceScore: score,
                ...(request.return_documents ? { document: request.documents[idx] } : {}),
            };
        })
        .filter((item): item is RerankResultItem => item !== null);
    return {
        results,
        usage: usageFromCohere(root.meta) || {
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            billingMetrics: rerankBillingMetrics(request.documents.length),
        },
        raw,
    };
}

// ---------------------------------------------------------------------------
// Classify v1
// ---------------------------------------------------------------------------

export function buildClassifyBody(modelId: string, request: ClassificationRequest): { body: Record<string, unknown>; inputCount: number } {
    const rawInputs = Array.isArray(request.inputs) ? request.inputs : [request.inputs];
    const inputs: string[] = [];
    for (const input of rawInputs) {
        if (typeof input === "string") {
            inputs.push(input);
        } else if (input && typeof input === "object" && "type" in input && input.type === "text" && typeof (input as { text?: unknown }).text === "string") {
            inputs.push((input as { text: string }).text);
        } else {
            throw new Error(`Cohere classify only accepts text inputs`);
        }
    }
    const native = request.native?.cohere;
    const custom = request.customParams || {};
    const examples = Array.isArray(native?.examples)
        ? native.examples
        : Array.isArray(custom.examples)
            ? custom.examples
            : undefined;
    const truncate = native?.truncate || clean(custom.truncate);
    return {
        inputCount: inputs.length,
        body: {
            model: modelId,
            inputs,
            ...(examples ? { examples } : {}),
            ...(truncate ? { truncate } : {}),
            ...(request.customParams ?? {}),
        },
    };
}

export function parseClassifyResponse(raw: unknown, inputCount: number): ClassificationResult {
    const root = asRecord(raw) || {};
    const classifications = Array.isArray(root.classifications) ? root.classifications : [];
    const items: ClassificationResultEntry[] = classifications.map((entry, index) => {
        const record = asRecord(entry) || {};
        const labels = asRecord(record.labels) || {};
        const out: ClassificationLabel[] = [];
        for (const [label, value] of Object.entries(labels)) {
            const r = asRecord(value);
            if (r && typeof r.confidence === "number") {
                out.push({ label, score: r.confidence });
            }
        }
        out.sort((a, b) => b.score - a.score);
        return {
            index,
            labels: out,
        };
    });
    return {
        results: items,
        usage: usageFromCohere(root.meta) || {
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            billingMetrics: classifyBillingMetrics(inputCount),
        },
        raw,
    };
}
