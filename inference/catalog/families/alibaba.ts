/**
 * Alibaba family wire (Qwen, Wan, CosyVoice, Paraformer, GTE, etc.).
 *
 * Pure protocol module: builds DashScope native + DashScope OpenAI-
 * compatible request bodies, translates `UnifiedMessage[]` into
 * DashScope multimodal content arrays, and parses responses back into
 * family-native types.
 *
 * NO endpoints, NO API keys, NO network calls. Vendor adapters that
 * route Alibaba models (alibaba/dashscope vendor, openai-compat
 * mirrors, HF Router, etc.) own the transport — they pick a path,
 * POST the body, and feed the JSON response (or async-job task id +
 * polled tasks/{id} body) into the parsers here.
 *
 * Two surfaces:
 *
 *   1. **OpenAI-compatible mode** — paths under `/compatible-mode/v1/...`
 *      (chat / embeddings / images / reranks). Vendor passes the body
 *      from `buildChatBody` into the standard OpenAI wire and feeds the
 *      response into `parseChatResponse`.
 *
 *   2. **DashScope native mode** — paths under `/api/v1/services/...`.
 *      Required for `qwen-omni`, `qwen3-vl-*`, `qwen-audio`, `wan-*`,
 *      `cosyvoice-*`, `paraformer-*`, `qwen-image-*`, async video LRO.
 *
 * Spec: https://help.aliyun.com/zh/model-studio/
 */

import type { UnifiedMessage, UnifiedTool, UnifiedToolChoice, UnifiedUsage } from "../../core.js";
import {
    asRecord,
    assignMetric,
    bufferFromPayload,
    clean,
    findAttachmentUrl,
    normalizeOpenAIUsage,
    primaryText,
    readNonNeg,
} from "../shared/index.js";
import type { RerankRequest, RerankResult, RerankResultItem } from "../modalities/rerank.js";
import { rerankBillingMetrics } from "../modalities/rerank.js";

// ---------------------------------------------------------------------------
// Path constants — vendors prefix these with their chosen origin
// (e.g. `https://dashscope-intl.aliyuncs.com`).
// ---------------------------------------------------------------------------

export const DASHSCOPE_PATH_COMPAT = "/compatible-mode/v1";
export const DASHSCOPE_PATH_COMPAT_API = "/compatible-api/v1";
export const DASHSCOPE_PATH_API = "/api/v1";

// ---------------------------------------------------------------------------
// Usage normalizer (DashScope native: `usage.input_tokens` + per-modality)
// ---------------------------------------------------------------------------

export function usageFromDashScope(raw: unknown): UnifiedUsage | undefined {
    const root = asRecord(raw) || {};
    const usage = asRecord(root.usage) ?? asRecord(asRecord(root.output)?.usage);
    if (!usage) return undefined;
    const inputTokens = readNonNeg(usage, ["input_tokens", "prompt_tokens"]) ?? 0;
    const outputTokens = readNonNeg(usage, ["output_tokens", "completion_tokens"]) ?? 0;
    const totalTokens = readNonNeg(usage, ["total_tokens"]) ?? inputTokens + outputTokens;
    const reasoning = readNonNeg(usage, ["reasoning_tokens"]);
    const cached = readNonNeg(usage, ["cached_tokens", "prefix_tokens"]);
    const audioIn = readNonNeg(usage, ["audio_tokens"]);
    const imageIn = readNonNeg(usage, ["image_tokens"]);
    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", inputTokens);
    assignMetric(billingMetrics, "output_tokens", outputTokens);
    assignMetric(billingMetrics, "total_tokens", totalTokens);
    assignMetric(billingMetrics, "reasoning_tokens", reasoning);
    assignMetric(billingMetrics, "cached_input_tokens", cached);
    assignMetric(billingMetrics, "audio_input_tokens", audioIn);
    assignMetric(billingMetrics, "image_input_tokens", imageIn);
    return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
        ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
        billingMetrics,
        raw: usage,
    };
}

// ---------------------------------------------------------------------------
// Translation: UnifiedMessage → DashScope multimodal content
// ---------------------------------------------------------------------------

function urlFromPart(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const record = asRecord(value);
    return clean(record?.url) || undefined;
}

function dashscopeContent(message: UnifiedMessage): Array<Record<string, unknown>> {
    if (typeof message.content === "string") {
        return message.content ? [{ text: message.content }] : [];
    }
    if (!Array.isArray(message.content)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const part of message.content) {
        if (part.type === "text" && part.text) out.push({ text: part.text });
        else if (part.type === "image_url") {
            const url = urlFromPart(part.image_url);
            if (url) out.push({ image: url });
        } else if (part.type === "input_audio") {
            const url = urlFromPart(part.input_audio);
            if (url) out.push({ audio: url });
        } else if (part.type === "video_url") {
            const url = urlFromPart(part.video_url);
            if (url) out.push({ video: url });
        }
    }
    return out;
}

export function dashscopeMessages(messages: UnifiedMessage[]): Array<Record<string, unknown>> {
    return messages
        .map((message) => ({
            role: message.role === "tool" ? "assistant" : message.role,
            content: dashscopeContent(message),
        }))
        .filter((message) => Array.isArray(message.content) && message.content.length > 0);
}

// ---------------------------------------------------------------------------
// Chat — OpenAI-compat (default) + DashScope multimodal (auto-detected)
// ---------------------------------------------------------------------------

export type AlibabaChatWire = "openai_chat" | "multimodal";

export interface AlibabaChatOptions {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    seed?: number;
    stop?: string | string[];
    tools?: UnifiedTool[];
    toolChoice?: UnifiedToolChoice;
    responseFormat?: unknown;
    /** Qwen3+ thinking-mode toggle. */
    enableThinking?: boolean;
    /** Qwen3+ reasoning effort budget. */
    thinkingBudget?: number;
    customParams?: Record<string, unknown>;
    /** Force the wire surface. Default: auto (multimodal if any non-text part is present). */
    wire?: AlibabaChatWire;
    wireModelId?: string;
}

export interface AlibabaChatResult {
    text: string;
    finishReason?: string;
    usage?: UnifiedUsage;
    raw: unknown;
}

export interface AlibabaChatBody {
    /** Path under the chosen DashScope origin (no leading scheme/host). */
    path: string;
    /** Whether to send the `X-DashScope-Async` header (always false for chat). */
    async: false;
    /** JSON body to POST. */
    body: Record<string, unknown>;
    /** Wire surface used to build this body — informs response parsing. */
    wire: AlibabaChatWire;
}

function hasNonTextContent(messages: UnifiedMessage[]): boolean {
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type !== "text") return true;
        }
    }
    return false;
}

/**
 * Build a DashScope chat request. Returns the path + JSON body the
 * vendor must POST. Use `parseChatResponse(raw, body.wire)` on the
 * response.
 */
export function buildChatBody(
    modelId: string,
    messages: UnifiedMessage[],
    options: AlibabaChatOptions = {},
): AlibabaChatBody {
    const wire = options.wire ?? (hasNonTextContent(messages) ? "multimodal" : "openai_chat");
    if (wire === "openai_chat") {
        return {
            path: `${DASHSCOPE_PATH_COMPAT}/chat/completions`,
            async: false,
            wire,
            body: {
                model: options.wireModelId || modelId,
                messages,
                ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
                ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
                ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
                ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
                ...(options.stop ? { stop: options.stop } : {}),
                ...(options.tools ? { tools: options.tools } : {}),
                ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
                ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
                ...(typeof options.enableThinking === "boolean" ? { enable_thinking: options.enableThinking } : {}),
                ...(typeof options.thinkingBudget === "number" ? { thinking_budget: options.thinkingBudget } : {}),
                ...(options.customParams ?? {}),
            },
        };
    }
    return {
        path: `${DASHSCOPE_PATH_API}/services/aigc/multimodal-generation/generation`,
        async: false,
        wire,
        body: {
            model: options.wireModelId || modelId,
            input: { messages: dashscopeMessages(messages) },
            parameters: {
                ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
                ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
                ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
                ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
                ...(options.customParams ?? {}),
            },
        },
    };
}

function textFromOpenAI(raw: unknown): { text: string; finishReason?: string; usage?: UnifiedUsage } {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};
    return {
        text: clean(message.content),
        finishReason: clean(first.finish_reason) || undefined,
        usage: normalizeOpenAIUsage(root.usage),
    };
}

function textFromDashScope(raw: unknown): string {
    const root = asRecord(raw) || {};
    const output = asRecord(root.output) ?? root;
    const text = clean(output.text) || clean(output.output_text);
    if (text) return text;
    const choices = Array.isArray(output.choices) ? output.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .map((part) => {
                const r = asRecord(part);
                return clean(r?.text) || clean(r?.content);
            })
            .filter(Boolean)
            .join("\n");
    }
    return "";
}

/**
 * Parse a chat response body. Pass the wire identifier returned in
 * the `AlibabaChatBody` so OpenAI-compat vs. multimodal responses are
 * decoded with the right rules.
 */
export function parseChatResponse(raw: unknown, wire: AlibabaChatWire): AlibabaChatResult {
    if (wire === "openai_chat") return { ...textFromOpenAI(raw), raw };
    return {
        text: textFromDashScope(raw),
        finishReason: "stop",
        usage: usageFromDashScope(raw),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Embeddings (text + multimodal)
// ---------------------------------------------------------------------------

export interface AlibabaEmbeddingsBody {
    path: string;
    body: Record<string, unknown>;
    multimodal: boolean;
}

export interface AlibabaEmbeddingResult {
    embeddings: number[][];
    usage?: UnifiedUsage;
    raw: unknown;
}

export function buildEmbeddingsBody(
    modelId: string,
    input: string[],
    options: { multimodal?: boolean } = {},
): AlibabaEmbeddingsBody {
    if (options.multimodal) {
        return {
            path: `${DASHSCOPE_PATH_API}/services/embeddings/multimodal-embedding/multimodal-embedding`,
            multimodal: true,
            body: { model: modelId, input: { contents: input.map((text) => ({ text })) } },
        };
    }
    return {
        path: `${DASHSCOPE_PATH_COMPAT}/embeddings`,
        multimodal: false,
        body: { model: modelId, input },
    };
}

export function parseEmbeddingsResponse(raw: unknown, multimodal: boolean): AlibabaEmbeddingResult {
    if (multimodal) {
        const output = asRecord(asRecord(raw)?.output) || {};
        const items = Array.isArray(output.embeddings) ? output.embeddings : [];
        const out = items
            .map((item) => asRecord(item)?.embedding)
            .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((v) => typeof v === "number"));
        return { embeddings: out, usage: usageFromDashScope(raw), raw };
    }
    const root = asRecord(raw) || {};
    const data = Array.isArray(root.data) ? root.data : [];
    const out = data
        .map((item) => asRecord(item)?.embedding)
        .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((v) => typeof v === "number"));
    return { embeddings: out, usage: normalizeOpenAIUsage(root.usage), raw };
}

// ---------------------------------------------------------------------------
// Rerank (gte-rerank, etc.)
// ---------------------------------------------------------------------------

export interface AlibabaRerankBody {
    path: string;
    body: Record<string, unknown>;
}

export function buildRerankBody(modelId: string, request: RerankRequest): AlibabaRerankBody {
    return {
        path: `${DASHSCOPE_PATH_COMPAT_API}/reranks`,
        body: {
            model: modelId,
            query: request.query,
            documents: request.documents,
            ...(typeof request.top_n === "number" ? { top_n: request.top_n } : {}),
            ...(typeof request.return_documents === "boolean" ? { return_documents: request.return_documents } : {}),
            ...(request.customParams ?? {}),
        },
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
            return { index: idx, relevanceScore: score, ...(request.return_documents ? { document: request.documents[idx] } : {}) };
        })
        .filter((item): item is RerankResultItem => item !== null);
    return {
        results,
        usage: normalizeOpenAIUsage(root.usage) || {
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            billingMetrics: rerankBillingMetrics(request.documents.length),
        },
        raw,
    };
}

// ---------------------------------------------------------------------------
// Image generation
//   - Qwen-Image* via OpenAI-compat /compatible-mode/v1/images/generations
//   - Wan / Wanx text-to-image via DashScope native multimodal-generation
// ---------------------------------------------------------------------------

export interface AlibabaImageBody {
    path: string;
    body: Record<string, unknown>;
    wire: "openai_image" | "wan_multimodal";
}

export interface AlibabaImageResult {
    buffer: Buffer;
    mimeType: string;
    usage?: UnifiedUsage;
    raw: unknown;
}

export function buildImageBody(
    modelId: string,
    prompt: string,
    options: { n?: number; size?: string; quality?: string; imageUrl?: string; customParams?: Record<string, unknown> } = {},
): AlibabaImageBody {
    return {
        path: `${DASHSCOPE_PATH_COMPAT}/images/generations`,
        wire: "openai_image",
        body: {
            model: modelId,
            prompt,
            response_format: "b64_json",
            ...(typeof options.n === "number" ? { n: options.n } : {}),
            ...(options.size ? { size: options.size } : {}),
            ...(options.quality ? { quality: options.quality } : {}),
            ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
            ...(options.customParams ?? {}),
        },
    };
}

export interface WanImageOptions {
    n?: number;
    size?: string;
    aspectRatio?: string;
    seed?: number;
    promptExtend?: boolean;
    imageUrl?: string;
    customParams?: Record<string, unknown>;
}

function dashscopeImageSize(size: string | undefined): string | undefined {
    const value = clean(size);
    if (!value) return undefined;
    return value.replace(/^(\d+)x(\d+)$/i, "$1*$2");
}

export function buildWanImageBody(
    modelId: string,
    prompt: string,
    options: WanImageOptions = {},
): AlibabaImageBody {
    return {
        path: `${DASHSCOPE_PATH_API}/services/aigc/multimodal-generation/generation`,
        wire: "wan_multimodal",
        body: {
            model: modelId,
            input: {
                messages: [{
                    role: "user",
                    content: [
                        { text: prompt },
                        ...(options.imageUrl ? [{ image: options.imageUrl }] : []),
                    ],
                }],
            },
            parameters: {
                ...(dashscopeImageSize(options.size) ? { size: dashscopeImageSize(options.size) } : {}),
                ...(typeof options.n === "number" ? { n: options.n } : {}),
                ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
                ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
                ...(typeof options.promptExtend === "boolean" ? { prompt_extend: options.promptExtend } : {}),
                ...(options.customParams ?? {}),
            },
        },
    };
}

export async function parseImageResponse(
    raw: unknown,
    options: { n?: number } = {},
): Promise<AlibabaImageResult> {
    const payload = findMediaPayload(raw, ["b64_json", "image", "image_url", "url"]);
    if (!payload) throw new Error("Alibaba returned no image data");
    const image = await bufferFromPayload(payload, "image/png");
    return {
        ...image,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: { request: 1, image: options.n || 1 } },
        raw,
    };
}

// ---------------------------------------------------------------------------
// Speech (CosyVoice/SAMBert/Sensevoice TTS + Paraformer ASR via DashScope)
// ---------------------------------------------------------------------------

export interface AlibabaSpeechBody {
    path: string;
    body: Record<string, unknown>;
    characterCount: number;
}

export interface AlibabaSpeechResult {
    buffer: Buffer;
    mimeType: string;
    usage?: UnifiedUsage;
    raw: unknown;
}

export function buildSpeechBody(
    modelId: string,
    text: string,
    options: { voice?: string; responseFormat?: string; speed?: number; customParams?: Record<string, unknown> } = {},
): AlibabaSpeechBody {
    return {
        path: `${DASHSCOPE_PATH_API}/services/aigc/multimodal-generation/generation`,
        characterCount: Array.from(text).length,
        body: {
            model: modelId,
            input: { text, ...(options.voice ? { voice: options.voice } : {}) },
            parameters: {
                ...(options.responseFormat ? { format: options.responseFormat } : {}),
                ...(typeof options.speed === "number" ? { speed: options.speed } : {}),
                ...(options.customParams ?? {}),
            },
        },
    };
}

export async function parseSpeechResponse(
    raw: unknown,
    characterCount: number,
): Promise<AlibabaSpeechResult> {
    const payload = findMediaPayload(raw, ["audio", "audio_url", "url"]);
    if (!payload) throw new Error("Alibaba returned no audio data");
    const audio = await bufferFromPayload(payload, "audio/mpeg");
    return {
        ...audio,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: { character: characterCount } },
        raw,
    };
}

// ---------------------------------------------------------------------------
// Transcribe (Paraformer / Sensevoice ASR via DashScope multimodal)
// ---------------------------------------------------------------------------

export interface AlibabaTranscribeBody {
    path: string;
    body: Record<string, unknown>;
}

export interface AlibabaTranscriptionResult {
    text: string;
    usage?: UnifiedUsage;
    raw: unknown;
}

export function buildTranscribeBody(
    modelId: string,
    options: {
        audioUrl?: string;
        audioBuffer?: Buffer;
        messages?: UnifiedMessage[];
        language?: string;
        responseFormat?: string;
        customParams?: Record<string, unknown>;
    } = {},
): AlibabaTranscribeBody {
    const audio = options.audioUrl
        || (options.audioBuffer ? `data:audio/mpeg;base64,${options.audioBuffer.toString("base64")}` : undefined)
        || (options.messages ? findAttachmentUrl(options.messages, "input_audio") : undefined);
    if (!audio) throw new Error("Alibaba transcribe requires audio input");
    return {
        path: `${DASHSCOPE_PATH_API}/services/aigc/multimodal-generation/generation`,
        body: {
            model: modelId,
            input: {
                messages: [{
                    role: "user",
                    content: [
                        { audio },
                        ...(options.messages ? [{ text: primaryText(options.messages) }] : []),
                    ].filter((part) => Object.values(part).some(Boolean)),
                }],
            },
            parameters: {
                ...(options.language ? { language: options.language } : {}),
                ...(options.responseFormat ? { format: options.responseFormat } : {}),
                ...(options.customParams ?? {}),
            },
        },
    };
}

export function parseTranscribeResponse(raw: unknown): AlibabaTranscriptionResult {
    return {
        text: textFromDashScope(raw),
        usage: usageFromDashScope(raw) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: { request: 1 } },
        raw,
    };
}

// ---------------------------------------------------------------------------
// findMediaPayload — walks nested DashScope responses
// ---------------------------------------------------------------------------

export function findMediaPayload(raw: unknown, keys: string[]): string {
    const root = asRecord(raw) || {};
    const output = asRecord(root.output) ?? root;
    for (const key of keys) {
        const value = clean(output[key]) || clean(root[key]);
        if (value) return value;
    }
    const data = Array.isArray(root.data) ? root.data : [];
    for (const item of data) {
        const record = asRecord(item);
        if (!record) continue;
        for (const key of keys) {
            const value = clean(record[key]);
            if (value) return value;
        }
    }
    for (const container of [asRecord(output.audio), asRecord(output.image), asRecord(output.video), asRecord(output.results)]) {
        if (!container) continue;
        for (const key of keys) {
            const value = clean(container[key]);
            if (value) return value;
        }
    }
    const choices = Array.isArray(output.choices) ? output.choices : [];
    for (const choice of choices) {
        const message = asRecord(asRecord(choice)?.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const part of content) {
            const record = asRecord(part);
            if (!record) continue;
            for (const key of keys) {
                const value = clean(record[key]);
                if (value) return value;
            }
        }
    }
    return "";
}

// ---------------------------------------------------------------------------
// Async LRO (Wan video, async embeddings, async OCR, etc.)
// ---------------------------------------------------------------------------

export interface DashScopeAsyncSubmission {
    /** Path to POST under the chosen DashScope origin. */
    path: string;
    /** JSON body. */
    body: Record<string, unknown>;
    /** Vendor must add `X-DashScope-Async: enable` to the request. */
    requiresAsyncHeader: true;
}

export interface DashScopeJobStatus {
    status: "queued" | "processing" | "completed" | "failed";
    url?: string;
    error?: string;
    progress?: number;
    raw: unknown;
}

/** Build a poll path for `GET /tasks/{taskId}`. */
export function asyncJobPath(taskId: string): string {
    return `${DASHSCOPE_PATH_API}/tasks/${encodeURIComponent(taskId)}`;
}

/** Read the `task_id` from an async-submit response. */
export function readAsyncTaskId(raw: unknown): string {
    const output = asRecord(asRecord(raw)?.output) || {};
    return clean(output.task_id) || clean(output.taskId) || clean(asRecord(raw)?.task_id);
}

/** Decode a DashScope async-job poll response into normalized status. */
export function parseAsyncJobStatus(raw: unknown): DashScopeJobStatus {
    const root = asRecord(raw) || {};
    const output = asRecord(root.output) ?? root;
    const taskStatus = clean(output.task_status || root.task_status).toUpperCase();
    const error = clean(output.message) || clean(root.message);
    const url = clean(output.video_url)
        || clean(output.output_video_url)
        || clean(output.url)
        || clean(asRecord(output.results)?.video_url);

    if (taskStatus === "SUCCEEDED" || taskStatus === "SUCCESS" || taskStatus === "COMPLETED") {
        return { status: "completed", url, raw };
    }
    if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "CANCELLED") {
        return { status: "failed", error: error || "DashScope job failed", raw };
    }
    if (taskStatus === "PENDING" || taskStatus === "QUEUED") return { status: "queued", progress: 0, raw };
    return { status: "processing", raw };
}

// ---------------------------------------------------------------------------
// Wan video (text-to-video, image-to-video, video-edit — async LRO)
// ---------------------------------------------------------------------------

export interface WanVideoOptions {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    imageUrl?: string;
    videoUrl?: string;
    seed?: number;
    promptExtend?: boolean;
    customParams?: Record<string, unknown>;
}

export function buildWanVideoSubmission(
    modelId: string,
    prompt: string,
    options: WanVideoOptions = {},
): DashScopeAsyncSubmission {
    return {
        path: `${DASHSCOPE_PATH_API}/services/aigc/video-generation/video-synthesis`,
        requiresAsyncHeader: true,
        body: {
            model: modelId,
            input: {
                prompt,
                ...(options.imageUrl ? { img_url: options.imageUrl, image_url: options.imageUrl } : {}),
                ...(options.videoUrl ? { video_url: options.videoUrl } : {}),
            },
            parameters: {
                ...(typeof options.duration === "number" ? { duration: options.duration } : {}),
                ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
                ...(options.resolution ? { resolution: options.resolution } : {}),
                ...(options.size ? { size: options.size } : {}),
                ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
                ...(typeof options.promptExtend === "boolean" ? { prompt_extend: options.promptExtend } : {}),
                ...(options.customParams ?? {}),
            },
        },
    };
}
