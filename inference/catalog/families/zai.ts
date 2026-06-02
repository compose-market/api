/**
 * Z.AI (formerly Zhipu / BigModel) GLM family wire.
 *
 * Pure protocol module: builds Z.AI request bodies, translates
 * Message[] into Z.AI shape, and parses Z.AI responses + SSE
 * frames back into family-native types.
 *
 * NO endpoints, NO API keys, NO network calls. Vendors that route
 * Z.AI models own the transport. Compose's models.json carries Z.AI
 * models under modelIds prefixed `glm-*`, `autoglm-*`, `cogview*`,
 * `cogvideox*`, `z-image*`.
 *
 * Surfaces covered (per https://docs.z.ai/llms.txt):
 *
 *   - `POST /paas/v4/chat/completions`            chat (text + vision)
 *                                                 with `thinking`,
 *                                                 `tool_stream`,
 *                                                 `web_search`,
 *                                                 `retrieval` tools
 *   - `POST /paas/v4/images/generations`          synchronous image
 *   - `POST /paas/v4/async/images/generations`    async image
 *   - `GET  /paas/v4/async-result/{id}`           image / video poll
 *   - `POST /paas/v4/videos/generations`          async video
 *     (CogVideoX-3, Vidu Q1, Vidu 2)
 *   - `POST /paas/v4/audio/transcriptions`        ASR (GLM-ASR-2512)
 *   - `POST /paas/v4/tools/web-search`            standalone web search
 *   - `POST /paas/v4/tools/web-reader`            URL → markdown
 *   - `POST /paas/v4/tools/layout-parsing`        OCR / document layout
 *   - `POST /paas/v4/tools/tokenizer`             token count
 *
 * Z.AI native lexicon Compose round-trips:
 *   - `thinking: { type: "enabled" | "disabled", clear_thinking? }`
 *     — chain-of-thought toggle for GLM-4.5+
 *   - `reasoning_content` — separate channel for thoughts in
 *     responses + stream deltas
 *   - `tool_stream: boolean` — incremental tool-call streaming
 *     (GLM-4.6+)
 *   - `tools[].type: "retrieval" | "web_search" | "function"`
 *     — built-in retrieval + first-party web search
 *   - `do_sample: boolean` — toggle sampling
 *   - `request_id: string` — caller-provided id (echoed back)
 *   - `web_search` response object on chat with grounding
 *   - finish_reason values: `stop | tool_calls | length | sensitive |
 *     model_context_window_exceeded | network_error`
 */

import type {
    Message,
    Tool,
    Call,
    Choice,
    Usage,
} from "../../core.js";
import { asRecord, assignMetric, clean, readNonNeg } from "../shared/index.js";
import * as lower from "../shared/schema.js";

// ---------------------------------------------------------------------------
// Path constants — vendors prefix these with their host
// ---------------------------------------------------------------------------

export const ZAI_PATH_CHAT = "/paas/v4/chat/completions";
export const ZAI_PATH_IMAGES = "/paas/v4/images/generations";
export const ZAI_PATH_IMAGES_ASYNC = "/paas/v4/async/images/generations";
export const ZAI_PATH_VIDEOS = "/paas/v4/videos/generations";
export const ZAI_PATH_TRANSCRIPTIONS = "/paas/v4/audio/transcriptions";
export const ZAI_PATH_WEB_SEARCH = "/paas/v4/tools/web-search";
export const ZAI_PATH_WEB_READER = "/paas/v4/tools/web-reader";
export const ZAI_PATH_LAYOUT = "/paas/v4/tools/layout-parsing";
export const ZAI_PATH_TOKENIZER = "/paas/v4/tools/tokenizer";

/** Build the async-result poll path for image / video jobs. */
export function asyncResultPath(taskId: string): string {
    return `/paas/v4/async-result/${encodeURIComponent(taskId)}`;
}

// ---------------------------------------------------------------------------
// Z.AI native types — message / content / tool
// ---------------------------------------------------------------------------

export type ZaiMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string | ZaiVisionContentItem[] }
    | { role: "assistant"; content?: string; reasoning_content?: string; tool_calls?: ZaiToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

export type ZaiVisionContentItem =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: "video_url"; video_url: { url: string } }
    | { type: "file_url"; file_url: { url: string } };

export interface ZaiToolCall {
    id: string;
    type: "function" | "retrieval" | "web_search";
    function?: { name: string; arguments: string };
}

export type ZaiToolDefinition =
    | { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
    | { type: "retrieval"; retrieval: { knowledge_id: string; prompt_template?: string } }
    | { type: "web_search"; web_search: ZaiWebSearchOptions };

export interface ZaiWebSearchOptions {
    enable?: boolean;
    search_engine?: "search_pro_jina";
    search_query?: string;
    count?: number;                    // 1-50, default 10
    search_domain_filter?: string;
    search_recency_filter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
    content_size?: "medium" | "high";
    result_sequence?: "before" | "after";
    search_result?: boolean;
    require_search?: boolean;
    search_prompt?: string;
}

export interface ZaiThinking {
    type?: "enabled" | "disabled";
    clear_thinking?: boolean;
}

// ---------------------------------------------------------------------------
// Translation: Message ⇔ ZaiMessage
// ---------------------------------------------------------------------------

export function mapMessagesForZai(messages: Message[]): ZaiMessage[] {
    return messages.map((message) => {
        if (message.role === "system") {
            return { role: "system", content: textOf(message.content) };
        }
        if (message.role === "tool") {
            return {
                role: "tool",
                content: textOf(message.content),
                tool_call_id: clean(message.tool_call_id),
            };
        }
        if (message.role === "assistant") {
            const out: Extract<ZaiMessage, { role: "assistant" }> = { role: "assistant" };
            const text = textOf(message.content);
            if (text) out.content = text;
            if (message.tool_calls && message.tool_calls.length > 0) {
                out.tool_calls = message.tool_calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.function.name, arguments: call.function.arguments },
                }));
            }
            return out;
        }

        // user
        if (typeof message.content === "string") {
            return { role: "user", content: message.content };
        }
        const items: ZaiVisionContentItem[] = [];
        if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text" && typeof part.text === "string") {
                    items.push({ type: "text", text: part.text });
                    continue;
                }
                if (part.type === "image_url") {
                    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
                    if (url) items.push({ type: "image_url", image_url: { url } });
                    continue;
                }
                if (part.type === "video_url") {
                    const url = typeof part.video_url === "string" ? part.video_url : part.video_url?.url;
                    if (url) items.push({ type: "video_url", video_url: { url } });
                }
                // file_url not present on Part — not round-trippable today.
            }
        }
        return { role: "user", content: items.length > 0 ? items : "" };
    });
}

function textOf(content: Message["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
}

// ---------------------------------------------------------------------------
// Tools / tool_choice
// ---------------------------------------------------------------------------

export function toolsToWire(tools: Tool[] | undefined): ZaiToolDefinition[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.function.name,
            description: tool.function.description ?? "",
            parameters: lower.object(tool.function.parameters),
        },
    }));
}

/** Z.AI only supports `tool_choice: "auto"`. */
export function toolChoiceToWire(choice: Choice | undefined): "auto" | undefined {
    if (!choice) return undefined;
    return "auto";
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function usageFromZai(rawUsage: unknown): Usage | undefined {
    const usage = asRecord(rawUsage);
    if (!usage) return undefined;
    const promptTokens = readNonNeg(usage, ["prompt_tokens"]) ?? 0;
    const completionTokens = readNonNeg(usage, ["completion_tokens"]) ?? 0;
    const totalTokens = readNonNeg(usage, ["total_tokens"]) ?? promptTokens + completionTokens;
    const cachedTokens = readNonNeg(asRecord(usage.prompt_tokens_details), ["cached_tokens"]);

    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", promptTokens);
    assignMetric(billingMetrics, "output_tokens", completionTokens);
    assignMetric(billingMetrics, "total_tokens", totalTokens);
    assignMetric(billingMetrics, "cached_input_tokens", cachedTokens);

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof cachedTokens === "number" ? { cachedInputTokens: cachedTokens } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        raw: usage,
    };
}

// ---------------------------------------------------------------------------
// Finish reason
// ---------------------------------------------------------------------------

export function mapFinishReason(value: unknown): string {
    const reason = clean(value);
    switch (reason) {
        case "stop": return "stop";
        case "tool_calls": return "tool_calls";
        case "length": return "length";
        case "sensitive": return "content_filter";
        case "model_context_window_exceeded": return "length";
        case "network_error": return "error";
        default: return reason || "stop";
    }
}

// ---------------------------------------------------------------------------
// Chat — body builder + response parser
// ---------------------------------------------------------------------------

export interface ZaiChatOptions {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    doSample?: boolean;
    requestId?: string;
    userId?: string;
    stop?: string[];
    thinking?: ZaiThinking;
    toolStream?: boolean;
    tools?: Tool[];
    /** Built-in tools added alongside function tools. */
    extraTools?: ZaiToolDefinition[];
    toolChoice?: Choice;
    responseFormat?: { type: "text" | "json_object" };
    customParams?: Record<string, unknown>;
    /** Override the wire model id. */
    wireModelId?: string;
}

export interface ZaiChatResult {
    text: string;
    reasoningContent?: string;
    toolCalls?: Call[];
    finishReason?: string;
    usage?: Usage;
    webSearch?: Array<Record<string, unknown>>;
    raw: unknown;
}

export function buildChatBody(
    modelId: string,
    messages: Message[],
    options: ZaiChatOptions = {},
    streaming = false,
): Record<string, unknown> {
    const fnTools = toolsToWire(options.tools);
    const tools: ZaiToolDefinition[] = [...(fnTools ?? []), ...(options.extraTools ?? [])];
    return {
        model: options.wireModelId || modelId,
        messages: mapMessagesForZai(messages),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(typeof options.doSample === "boolean" ? { do_sample: options.doSample } : {}),
        ...(options.requestId ? { request_id: options.requestId } : {}),
        ...(options.userId ? { user_id: options.userId } : {}),
        ...(options.stop && options.stop.length > 0 ? { stop: options.stop } : {}),
        ...(options.thinking ? { thinking: options.thinking } : {}),
        ...(typeof options.toolStream === "boolean" ? { tool_stream: options.toolStream } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(options.toolChoice ? { tool_choice: toolChoiceToWire(options.toolChoice) } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(streaming ? { stream: true } : {}),
        ...(options.customParams ?? {}),
    };
}

export function parseChatResponse(raw: unknown): ZaiChatResult {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};

    const text = clean(message.content);
    const reasoningContent = clean(message.reasoning_content);
    const toolCallsRaw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: Call[] = [];
    for (const call of toolCallsRaw) {
        const record = asRecord(call);
        const fn = asRecord(record?.function);
        if (!record || !fn) continue;
        const id = clean(record.id) || `call_${toolCalls.length}`;
        const name = clean(fn.name);
        const argsRaw = fn.arguments;
        const args = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});
        toolCalls.push({ id, name, arguments: args });
    }

    const webSearchRaw = Array.isArray(root.web_search) ? root.web_search : undefined;
    const webSearch = webSearchRaw?.map((item) => asRecord(item) ?? {}) as Array<Record<string, unknown>> | undefined;

    return {
        text,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: mapFinishReason(first.finish_reason),
        usage: usageFromZai(root.usage),
        ...(webSearch ? { webSearch } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Streaming — SSE frame parser
// ---------------------------------------------------------------------------

export type ZaiStreamEvent =
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
    | { type: "finish"; finishReason?: string; usage?: Usage };

/**
 * Stateful parser for Z.AI chat-completion SSE frames. Vendors hold an
 * instance per stream, feed the JSON-decoded payload of each `data:`
 * frame into `feed(...)`.
 */
export function createStreamParser() {
    let lastUsage: Usage | undefined;

    function feed(payload: unknown): ZaiStreamEvent[] {
        const data = asRecord(payload);
        if (!data) return [];
        const events: ZaiStreamEvent[] = [];

        const choices = Array.isArray(data.choices) ? data.choices : [];
        const first = asRecord(choices[0]);
        const delta = asRecord(first?.delta);
        if (delta) {
            const text = typeof delta.content === "string" ? delta.content : "";
            const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
            if (text) events.push({ type: "text-delta", text });
            if (reasoning) events.push({ type: "reasoning-delta", text: reasoning });

            const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const call of toolCalls) {
                const record = asRecord(call);
                if (!record) continue;
                const idx = typeof record.index === "number" ? record.index : 0;
                const fn = asRecord(record.function);
                events.push({
                    type: "tool-call-delta",
                    index: idx,
                    ...(record.id ? { id: clean(record.id) } : {}),
                    ...(fn?.name ? { name: clean(fn.name) } : {}),
                    ...(fn?.arguments ? { argumentsDelta: clean(fn.arguments) } : {}),
                });
            }
        }

        const usage = usageFromZai(data.usage);
        if (usage) lastUsage = usage;

        const finishReason = first?.finish_reason;
        if (finishReason) {
            events.push({
                type: "finish",
                finishReason: mapFinishReason(finishReason),
                ...(lastUsage ? { usage: lastUsage } : {}),
            });
        }
        return events;
    }

    return { feed };
}

// ---------------------------------------------------------------------------
// Async image / video — submit body + poll-status parser
// ---------------------------------------------------------------------------

export interface ZaiImageOptions {
    n?: number;
    size?: string;            // "1024x1024", "1792x1024", etc.
    quality?: string;
    style?: string;
    userId?: string;
    requestId?: string;
    customParams?: Record<string, unknown>;
}

export function buildImageBody(modelId: string, prompt: string, options: ZaiImageOptions = {}): Record<string, unknown> {
    return {
        model: modelId,
        prompt,
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
        ...(options.style ? { style: options.style } : {}),
        ...(options.userId ? { user_id: options.userId } : {}),
        ...(options.requestId ? { request_id: options.requestId } : {}),
        ...(options.customParams ?? {}),
    };
}

export interface ZaiVideoOptions {
    /** Source image URL or base64 for image-to-video. */
    imageUrl?: string;
    /** Duration in seconds — model-specific allowed values. */
    duration?: number;
    fps?: number;
    quality?: "speed" | "quality";
    sizeRatio?: string;       // "9:16", "16:9", "1:1"
    /** End-frame for video interpolation (Vidu). */
    lastFrameUrl?: string;
    audio?: boolean;          // include audio (Vidu)
    userId?: string;
    requestId?: string;
    customParams?: Record<string, unknown>;
}

export function buildVideoBody(modelId: string, prompt: string, options: ZaiVideoOptions = {}): Record<string, unknown> {
    return {
        model: modelId,
        prompt,
        ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
        ...(options.lastFrameUrl ? { last_frame_url: options.lastFrameUrl } : {}),
        ...(typeof options.duration === "number" ? { duration: options.duration } : {}),
        ...(typeof options.fps === "number" ? { fps: options.fps } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
        ...(options.sizeRatio ? { size_ratio: options.sizeRatio } : {}),
        ...(typeof options.audio === "boolean" ? { audio: options.audio } : {}),
        ...(options.userId ? { user_id: options.userId } : {}),
        ...(options.requestId ? { request_id: options.requestId } : {}),
        ...(options.customParams ?? {}),
    };
}

export type ZaiTaskStatus = "PROCESSING" | "SUCCESS" | "FAIL";

export interface ZaiTaskHandle {
    /** Z.AI task id — used to poll `/paas/v4/async-result/{id}`. */
    id: string;
}

export interface ZaiTaskResult {
    taskStatus: ZaiTaskStatus;
    /** Image generation results (sync-format mirror). */
    images?: Array<{ url: string }>;
    /** Video generation results. */
    videoResult?: Array<{ url: string; coverImageUrl?: string }>;
    error?: string;
}

export function parseSubmitResponse(raw: unknown): ZaiTaskHandle {
    const root = asRecord(raw) || {};
    const id = clean(root.id) || clean(root.task_id) || clean(root.request_id);
    if (!id) throw new Error("Z.AI submit returned no task id");
    return { id };
}

export function parseAsyncResultResponse(raw: unknown): ZaiTaskResult {
    const root = asRecord(raw) || {};
    const status = clean(root.task_status).toUpperCase() || "PROCESSING";
    return {
        taskStatus: (status as ZaiTaskStatus) ?? "PROCESSING",
        ...(Array.isArray(root.image_result)
            ? { images: root.image_result.map((item) => ({ url: clean(asRecord(item)?.url) })) }
            : {}),
        ...(Array.isArray(root.video_result)
            ? { videoResult: root.video_result.map((item) => {
                const r = asRecord(item) ?? {};
                return {
                    url: clean(r.url),
                    ...(r.cover_image_url ? { coverImageUrl: clean(r.cover_image_url) } : {}),
                };
            }) }
            : {}),
        ...(typeof root.error === "string" ? { error: root.error } : {}),
    };
}

export function isTerminalStatus(status: ZaiTaskStatus): boolean {
    return status === "SUCCESS" || status === "FAIL";
}

// ---------------------------------------------------------------------------
// Audio transcriptions (GLM-ASR-2512) — body builder
// ---------------------------------------------------------------------------

export interface ZaiTranscriptionOptions {
    language?: string;
    /** Stream incremental segments. */
    stream?: boolean;
}

/**
 * Body fields for `POST /paas/v4/audio/transcriptions`. The actual
 * request is multipart/form-data — vendors assemble the multipart
 * (with the `file` part) and merge these fields in.
 */
export function buildTranscriptionFields(modelId: string, options: ZaiTranscriptionOptions = {}): Record<string, string> {
    const out: Record<string, string> = { model: modelId };
    if (options.language) out.language = options.language;
    if (typeof options.stream === "boolean") out.stream = String(options.stream);
    return out;
}

// ---------------------------------------------------------------------------
// First-party Web Search tool — body + result parser
// ---------------------------------------------------------------------------

export interface ZaiWebSearchRequest extends ZaiWebSearchOptions {
    query: string;
}

export interface ZaiWebSearchResult {
    title?: string;
    content?: string;
    link?: string;
    media?: string;
    icon?: string;
    refer?: string;
    publish_date?: string;
}

export function buildWebSearchBody(args: ZaiWebSearchRequest): Record<string, unknown> {
    const { query, ...rest } = args;
    return {
        search_query: query,
        ...rest,
    };
}

export function parseWebSearchResponse(raw: unknown): ZaiWebSearchResult[] {
    const root = asRecord(raw) || {};
    const results = Array.isArray(root.results) ? root.results
        : Array.isArray(root.web_search) ? root.web_search
            : [];
    return results.map((item) => {
        const r = asRecord(item) ?? {};
        return {
            title: clean(r.title) || undefined,
            content: clean(r.content) || undefined,
            link: clean(r.link) || undefined,
            media: clean(r.media) || undefined,
            icon: clean(r.icon) || undefined,
            refer: clean(r.refer) || undefined,
            publish_date: clean(r.publish_date) || undefined,
        };
    });
}
