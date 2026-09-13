/**
 * Alibaba family wire (Qwen, Wan, CosyVoice, Paraformer, GTE, etc.).
 *
 * Pure protocol module: builds DashScope native + DashScope OpenAI-
 * compatible request bodies, translates `Message[]` into
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

import type { Message, Tool, Choice, Usage } from "../../core.js";
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
import * as lower from "../shared/schema.js";
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

export function usageFromDashScope(raw: unknown): Usage | undefined {
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
// Translation: Message → DashScope multimodal content
// ---------------------------------------------------------------------------

function urlFromPart(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const record = asRecord(value);
    return clean(record?.url) || undefined;
}

function dashscopeContent(message: Message): Array<Record<string, unknown>> {
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

export function dashscopeMessages(messages: Message[]): Array<Record<string, unknown>> {
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
    tools?: Tool[];
    toolChoice?: Choice;
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
    usage?: Usage;
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

function hasNonTextContent(messages: Message[]): boolean {
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type !== "text") return true;
        }
    }
    return false;
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

/**
 * Build a DashScope chat request. Returns the path + JSON body the
 * vendor must POST. Use `parseChatResponse(raw, body.wire)` on the
 * response.
 */
export function buildChatBody(
    modelId: string,
    messages: Message[],
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
                ...(options.tools ? { tools: toolsToWire(options.tools) } : {}),
                ...(options.toolChoice ? { tool_choice: toolChoiceToWire(options.toolChoice) } : {}),
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

function textFromOpenAI(raw: unknown): { text: string; finishReason?: string; usage?: Usage } {
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
    usage?: Usage;
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
    usage?: Usage;
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
    usage?: Usage;
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
    usage?: Usage;
    raw: unknown;
}

export function buildTranscribeBody(
    modelId: string,
    options: {
        audioUrl?: string;
        audioBuffer?: Buffer;
        messages?: Message[];
        language?: string;
        responseFormat?: string;
        customParams?: Record<string, unknown>;
    } = {},
): AlibabaTranscribeBody {
    const candidate = options.audioUrl
        || (options.messages ? findAttachmentUrl(options.messages, "input_audio") : undefined);
    const audio = candidate && /^https?:\/\//i.test(candidate) ? candidate : undefined;
    if (!audio) {
        throw Object.assign(
            new Error("Alibaba transcribe requires a public http(s) audio URL"),
            { statusCode: 400 },
        );
    }
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
    if (taskStatus === "UNKNOWN") {
        return { status: "failed", error: error || "DashScope task is unknown or expired", raw };
    }
    if (taskStatus === "PENDING" || taskStatus === "QUEUED") return { status: "queued", progress: 0, raw };
    return { status: "processing", raw };
}

// ---------------------------------------------------------------------------
// Wan video (text-to-video, image-to-video, video-edit — async LRO)
// ---------------------------------------------------------------------------

export interface WanVideoOptions {
    operation?: string;
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    imageUrl?: string;
    imageUrls?: string[];
    videoUrl?: string;
    videoUrls?: string[];
    audioUrl?: string;
    audioUrls?: string[];
    media?: Array<Record<string, unknown>>;
    seed?: number;
    promptExtend?: boolean;
    customParams?: Record<string, unknown>;
    requestContract?: AlibabaVideoRequestContract;
}

export interface AlibabaVideoRequestContract {
    origin?: string;
    path: string;
    inputFields: string[];
    parameterFields: string[];
    mediaTypes: string[];
}

function unique(values: Array<string | undefined>): string[] {
    return values.map(clean).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

function mediaUrls(options: WanVideoOptions): string[] {
    return unique([...(options.imageUrls ?? []), options.imageUrl]);
}

function videoUrls(options: WanVideoOptions): string[] {
    return unique([...(options.videoUrls ?? []), options.videoUrl]);
}

function customMedia(params: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
    const nested = asRecord(params?.input);
    const value = params?.media ?? nested?.media;
    return (Array.isArray(value) ? value : [])
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item));
}

function contractMedia(options: WanVideoOptions, supported: Set<string>): Array<Record<string, unknown>> {
    const explicit = customMedia(options.customParams);
    if (explicit.length > 0) return explicit.filter((item) => supported.has(clean(item.type)));
    const images = mediaUrls(options);
    const videos = videoUrls(options);
    const audio = unique([...(options.audioUrls ?? []), options.audioUrl]);
    const media: Array<Record<string, unknown>> = [];
    if (options.operation === "video-edit" || options.operation === "reference-to-video") {
        if (supported.has("video")) {
            for (const url of images) media.push({ type: "reference_image", url });
            for (const url of videos) media.push({ type: "video", url });
        } else {
            for (const url of videos) media.push({ type: "reference_video", url });
            for (const url of images) media.push({ type: "reference_image", url });
        }
    } else if (options.operation === "image-to-video") {
        if (supported.has("reference_image") && !supported.has("first_frame")) {
            for (const url of images) media.push({ type: "reference_image", url });
        } else {
            if (images[0] && supported.has("first_frame")) media.push({ type: "first_frame", url: images[0] });
            if (images[1] && supported.has("last_frame")) media.push({ type: "last_frame", url: images[1] });
        }
        if (videos[0] && supported.has("first_clip")) media.push({ type: "first_clip", url: videos[0] });
    }
    if (audio[0] && supported.has("driving_audio")) media.push({ type: "driving_audio", url: audio[0] });
    if (audio[0] && supported.has("reference_audio")) media.push({ type: "reference_audio", url: audio[0] });
    return media.filter((item) => supported.has(clean(item.type)));
}

const WAN_VIDEO_EDIT_DEFAULT_PROMPT = "Edit the source media while preserving its main subject and natural motion.";

function wanVideoPrompt(
    prompt: string,
    operation: string | undefined,
    media: Array<Record<string, unknown>>,
): string | undefined {
    let value = clean(prompt);
    if (!value && operation === "video-edit") value = WAN_VIDEO_EDIT_DEFAULT_PROMPT;
    if (!value) return undefined;
    if (operation === "reference-to-video" && !value.startsWith("[Image")) {
        const referenceImages = media.filter((item) => clean(item.type) === "reference_image");
        if (referenceImages.length > 0) {
            const markers = referenceImages.map((_, index) => `[Image ${index + 1}]`).join(" ");
            value = `${markers} ${value}`;
        }
    }
    return value;
}

function wanVideoResolutionFromSize(value: unknown): string | undefined {
    const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(clean(value));
    return match ? `${match[2]}P` : undefined;
}

export function buildWanVideoSubmission(
    modelId: string,
    prompt: string,
    options: WanVideoOptions = {},
): DashScopeAsyncSubmission {
    const contract = options.requestContract;
    if (!contract) {
        throw Object.assign(new Error(`Alibaba video model ${modelId} has no authoritative request contract`), {
            statusCode: 400,
            retryable: false,
        });
    }
    const inputFields = new Set(contract.inputFields);
    const parameterFields = new Set(contract.parameterFields);
    const nestedInput = asRecord(options.customParams?.input) || {};
    const nestedParameters = asRecord(options.customParams?.parameters) || {};
    const input: Record<string, unknown> = {};
    const parameters: Record<string, unknown> = {};
    const images = mediaUrls(options);
    const videos = videoUrls(options);
    const audios = unique([...(options.audioUrls ?? []), options.audioUrl]);

    const media = inputFields.has("media") ? contractMedia(options, new Set(contract.mediaTypes)) : [];

    for (const field of inputFields) {
        const custom = options.customParams?.[field] ?? nestedInput[field];
        if (custom !== undefined) input[field] = custom;
    }
    if (inputFields.has("prompt") && input.prompt === undefined) {
        const finalPrompt = wanVideoPrompt(prompt, options.operation, media);
        if (finalPrompt) input.prompt = finalPrompt;
    }
    if (inputFields.has("image_url") && input.image_url === undefined && images[0]) input.image_url = images[0];
    if (inputFields.has("img_url") && input.img_url === undefined && images[0]) input.img_url = images[0];
    if (inputFields.has("video_url") && input.video_url === undefined && videos[0]) input.video_url = videos[0];
    if (inputFields.has("audio_url") && input.audio_url === undefined && audios[0]) input.audio_url = audios[0];
    if (inputFields.has("first_frame_url") && input.first_frame_url === undefined && images[0]) input.first_frame_url = images[0];
    if (inputFields.has("last_frame_url") && input.last_frame_url === undefined && images[1]) input.last_frame_url = images[1];
    if (inputFields.has("reference_urls") && input.reference_urls === undefined) input.reference_urls = [...videos, ...images];
    if (inputFields.has("reference_video_urls") && input.reference_video_urls === undefined && videos.length > 0) {
        input.reference_video_urls = videos;
    }
    if (inputFields.has("media") && input.media === undefined && media.length > 0) {
        input.media = media;
    }
    if (inputFields.has("function") && input.function === undefined) {
        if (videos[0]) input.function = "video_repainting";
        else if (images.length > 0) input.function = "image_reference";
    }
    if (input.function === "image_reference" && input.ref_images_url === undefined && images.length > 0) {
        input.ref_images_url = [...images];
    }

    for (const field of parameterFields) {
        const custom = options.customParams?.[field] ?? nestedParameters[field];
        if (custom !== undefined) parameters[field] = custom;
    }
    if (parameterFields.has("duration") && parameters.duration === undefined && options.duration !== undefined) parameters.duration = options.duration;
    if (parameterFields.has("seed") && parameters.seed === undefined && options.seed !== undefined) parameters.seed = options.seed;
    if (parameterFields.has("prompt_extend") && parameters.prompt_extend === undefined && options.promptExtend !== undefined) parameters.prompt_extend = options.promptExtend;
    if (parameterFields.has("ratio") && parameters.ratio === undefined && options.aspectRatio) parameters.ratio = options.aspectRatio;
    if (parameterFields.has("aspect_ratio") && parameters.aspect_ratio === undefined && options.aspectRatio) parameters.aspect_ratio = options.aspectRatio;
    if (parameterFields.has("resolution") && parameters.resolution === undefined && options.resolution) parameters.resolution = options.resolution;
    if (parameterFields.has("resolution") && parameters.resolution === undefined) {
        const resolutionFromSize = wanVideoResolutionFromSize(options.size ?? options.customParams?.size);
        if (resolutionFromSize) parameters.resolution = resolutionFromSize;
    }
    if (parameterFields.has("size") && parameters.size === undefined && options.size) parameters.size = options.size.replace(/x/gi, "*");
    if (parameterFields.has("prompt_extend") && parameters.prompt_extend === undefined) parameters.prompt_extend = false;
    if (input.function === "video_repainting"
        && parameterFields.has("control_condition")
        && parameters.control_condition === undefined) {
        parameters.control_condition = "depth";
    }
    if (input.function === "image_reference"
        && parameterFields.has("obj_or_bg")
        && parameters.obj_or_bg === undefined
        && images.length > 0) {
        parameters.obj_or_bg = images.map(() => "obj");
    }

    return {
        path: contract.path,
        requiresAsyncHeader: true,
        body: {
            model: modelId,
            input,
            ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        },
    };
}
