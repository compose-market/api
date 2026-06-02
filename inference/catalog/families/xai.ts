/**
 * xAI family wire (Grok).
 *
 * Pure protocol module: builds xAI request bodies and parses xAI
 * responses + SSE stream chunks. NO endpoints, NO API keys, NO
 * network calls. Vendors that route Grok models own the transport.
 *
 * Surfaces covered:
 *
 *   - `POST /v1/chat/completions`  — OpenAI-shape chat (with deferred mode)
 *   - `POST /v1/responses`         — OpenAI Responses-shape
 *   - `GET  /v1/chat/deferred-completion/{request_id}`  — poll a deferred chat
 *   - `POST /v1/images/generations`  — grok-2-image text→image
 *
 * xAI quirks Compose round-trips:
 *   - `reasoning_effort` (low | high) on chat (NOT supported by `grok-4`)
 *   - `reasoning.effort` (low | medium | high) on responses
 *   - `search_parameters` for live web/X search (mode/sources/from_date/
 *     to_date/return_citations/max_search_results)
 *   - `web_search_options` (OpenAI-shape compat)
 *   - Per-modality usage breakdown:
 *       prompt_tokens_details.{text|audio|image|cached}_tokens
 *       completion_tokens_details.{reasoning|audio|accepted_prediction|rejected_prediction}_tokens
 *   - `citations` array on the response when `return_citations: true`
 *   - `parallel_tool_calls` is honored
 *
 * Spec: https://docs.x.ai/docs/api-reference
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

export const XAI_PATH_CHAT = "/v1/chat/completions";
export const XAI_PATH_RESPONSES = "/v1/responses";
export const XAI_PATH_DEFERRED = "/v1/chat/deferred-completion";
export const XAI_PATH_IMAGES = "/v1/images/generations";

/** Build the deferred-completion poll path for a given request id. */
export function deferredPollPath(requestId: string): string {
    return `${XAI_PATH_DEFERRED}/${encodeURIComponent(requestId)}`;
}

// ---------------------------------------------------------------------------
// Usage normalizer (xAI per-modality breakdown)
// ---------------------------------------------------------------------------

export function usageFromXai(rawUsage: unknown): Usage | undefined {
    const usage = asRecord(rawUsage);
    if (!usage) return undefined;
    const promptTokens = readNonNeg(usage, ["prompt_tokens", "input_tokens"]) ?? 0;
    const completionTokens = readNonNeg(usage, ["completion_tokens", "output_tokens"]) ?? 0;
    const totalTokens = readNonNeg(usage, ["total_tokens"]) ?? promptTokens + completionTokens;

    const promptDetails = asRecord(usage.prompt_tokens_details) || asRecord(usage.input_tokens_details) || {};
    const completionDetails = asRecord(usage.completion_tokens_details) || asRecord(usage.output_tokens_details) || {};

    const reasoningTokens = readNonNeg(completionDetails, ["reasoning_tokens"]);
    const cachedInputTokens = readNonNeg(promptDetails, ["cached_tokens"]);
    const inputAudioTokens = readNonNeg(promptDetails, ["audio_tokens"]);
    const inputImageTokens = readNonNeg(promptDetails, ["image_tokens"]);
    const inputTextTokens = readNonNeg(promptDetails, ["text_tokens"]);
    const outputAudioTokens = readNonNeg(completionDetails, ["audio_tokens"]);
    const acceptedPredictionTokens = readNonNeg(completionDetails, ["accepted_prediction_tokens"]);
    const rejectedPredictionTokens = readNonNeg(completionDetails, ["rejected_prediction_tokens"]);
    const numSourcesUsed = readNonNeg(usage, ["num_sources_used"]);
    const numServerSideToolsUsed = readNonNeg(usage, ["num_server_side_tools_used"]);

    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", promptTokens);
    assignMetric(billingMetrics, "output_tokens", completionTokens);
    assignMetric(billingMetrics, "total_tokens", totalTokens);
    assignMetric(billingMetrics, "reasoning_tokens", reasoningTokens);
    assignMetric(billingMetrics, "cached_input_tokens", cachedInputTokens);
    assignMetric(billingMetrics, "input_audio_tokens", inputAudioTokens);
    assignMetric(billingMetrics, "input_image_tokens", inputImageTokens);
    assignMetric(billingMetrics, "input_text_tokens", inputTextTokens);
    assignMetric(billingMetrics, "output_audio_tokens", outputAudioTokens);
    assignMetric(billingMetrics, "accepted_prediction_tokens", acceptedPredictionTokens);
    assignMetric(billingMetrics, "rejected_prediction_tokens", rejectedPredictionTokens);
    assignMetric(billingMetrics, "num_sources_used", numSourcesUsed);
    assignMetric(billingMetrics, "num_server_side_tools_used", numServerSideToolsUsed);

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
        billingMetrics,
        raw: usage,
    };
}

// ---------------------------------------------------------------------------
// search_parameters (xAI live search)
// ---------------------------------------------------------------------------

export interface XaiSearchParameters {
    /** "off" | "on" (default) | "auto". */
    mode?: "off" | "on" | "auto";
    /** Emit citations in `response.citations`. */
    returnCitations?: boolean;
    /** Cap on number of sources to consult. */
    maxSearchResults?: number;
    /** ISO-8601 YYYY-MM-DD lower bound. */
    fromDate?: string;
    /** ISO-8601 YYYY-MM-DD upper bound. */
    toDate?: string;
    /** Source whitelist; if omitted xAI uses web + X. */
    sources?: Array<Record<string, unknown>>;
}

function searchParametersToWire(params: XaiSearchParameters | undefined): Record<string, unknown> | undefined {
    if (!params) return undefined;
    const out: Record<string, unknown> = {};
    if (params.mode) out.mode = params.mode;
    if (typeof params.returnCitations === "boolean") out.return_citations = params.returnCitations;
    if (typeof params.maxSearchResults === "number") out.max_search_results = params.maxSearchResults;
    if (params.fromDate) out.from_date = params.fromDate;
    if (params.toDate) out.to_date = params.toDate;
    if (params.sources && params.sources.length > 0) out.sources = params.sources;
    return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Tools (OpenAI tool shape, identical wire)
// ---------------------------------------------------------------------------

export function toolsToWire(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.function.name,
            ...(tool.function.description ? { description: tool.function.description } : {}),
            parameters: lower.object(tool.function.parameters),
        },
    }));
}

export function toolChoiceToWire(choice: Choice | undefined): unknown {
    if (!choice) return undefined;
    if (typeof choice === "string") return choice;
    return choice;
}

function toolCallsFromAssistant(message: Record<string, unknown> | null | undefined): Call[] | undefined {
    if (!message) return undefined;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) return undefined;
    return calls
        .map((call): Call | null => {
            const r = asRecord(call);
            if (!r) return null;
            const fn = asRecord(r.function);
            if (!fn) return null;
            return {
                id: clean(r.id) || `call_${Math.random().toString(36).slice(2, 10)}`,
                name: clean(fn.name),
                arguments: clean(fn.arguments),
            };
        })
        .filter((call): call is Call => call !== null);
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

export interface XaiChatOptions {
    temperature?: number;
    maxCompletionTokens?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    stop?: string | string[];
    seed?: number;
    n?: number;
    parallelToolCalls?: boolean;
    /** "low" | "high" — NOT supported by grok-4. */
    reasoningEffort?: "low" | "high";
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: unknown;
    /** xAI live search. */
    searchParameters?: XaiSearchParameters;
    /** OpenAI-shape compat web_search_options. */
    webSearchOptions?: Record<string, unknown>;
    logprobs?: boolean;
    topLogprobs?: number;
    user?: string;
    /** Returns `request_id` instead of result; vendor polls via deferredPollPath. */
    deferred?: boolean;
    customParams?: Record<string, unknown>;
    wireModelId?: string;
}

export interface XaiChatResult {
    text: string;
    reasoningContent?: string;
    toolCalls?: Call[];
    finishReason?: string;
    usage?: Usage;
    citations?: string[];
    raw: unknown;
}

export interface XaiDeferredHandle {
    requestId: string;
    raw: unknown;
}

/**
 * Build a `POST /v1/chat/completions` body. Vendor POSTs this and
 * either feeds the response into `parseChatResponse` (when `deferred`
 * is false) or `parseDeferredResponse` (when `deferred: true`).
 *
 * For streaming, set `streaming: true` here AND consume the SSE
 * response with `parseStreamFrame`.
 */
export function buildChatBody(
    modelId: string,
    messages: Message[],
    options: XaiChatOptions = {},
    streaming = false,
): Record<string, unknown> {
    const tools = toolsToWire(options.tools);
    const toolChoice = toolChoiceToWire(options.toolChoice);
    const searchParameters = searchParametersToWire(options.searchParameters);
    return {
        model: options.wireModelId || modelId,
        messages,
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxCompletionTokens === "number" ? { max_completion_tokens: options.maxCompletionTokens } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.presencePenalty === "number" ? { presence_penalty: options.presencePenalty } : {}),
        ...(typeof options.frequencyPenalty === "number" ? { frequency_penalty: options.frequencyPenalty } : {}),
        ...(options.stop ? { stop: options.stop } : {}),
        ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(typeof options.parallelToolCalls === "boolean" ? { parallel_tool_calls: options.parallelToolCalls } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(searchParameters ? { search_parameters: searchParameters } : {}),
        ...(options.webSearchOptions ? { web_search_options: options.webSearchOptions } : {}),
        ...(typeof options.logprobs === "boolean" ? { logprobs: options.logprobs } : {}),
        ...(typeof options.topLogprobs === "number" ? { top_logprobs: options.topLogprobs } : {}),
        ...(options.user ? { user: options.user } : {}),
        ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(options.deferred ? { deferred: true } : {}),
        ...(options.customParams ?? {}),
    };
}

export function parseChatResponse(raw: unknown): XaiChatResult {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};
    const citations = Array.isArray(root.citations)
        ? root.citations.map((c) => clean(c)).filter(Boolean)
        : undefined;
    const toolCalls = toolCallsFromAssistant(message);
    return {
        text: clean(message.content),
        ...(typeof message.reasoning_content === "string" && message.reasoning_content
            ? { reasoningContent: message.reasoning_content }
            : {}),
        ...(toolCalls ? { toolCalls } : {}),
        finishReason: clean(first.finish_reason) || undefined,
        usage: usageFromXai(root.usage),
        ...(citations && citations.length > 0 ? { citations } : {}),
        raw,
    };
}

/**
 * Parse a deferred-submit response. Vendors call this after POSTing
 * with `deferred: true`.
 */
export function parseDeferredResponse(raw: unknown): XaiDeferredHandle {
    const root = asRecord(raw) || {};
    const id = clean(root.request_id) || clean(root.id);
    if (!id) throw new Error("xAI deferred completion returned no request_id");
    return { requestId: id, raw };
}

// ---------------------------------------------------------------------------
// Streaming chat (SSE; OpenAI-shape chunks)
// ---------------------------------------------------------------------------

export type XaiStreamEvent =
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
    | { type: "finish"; finishReason?: string; usage?: Usage; citations?: string[] };

/**
 * Stateful parser for xAI chat-completion SSE streams. The vendor
 * holds an instance per stream, feeds in each `data:` JSON payload,
 * and yields normalized `XaiStreamEvent`s.
 *
 * After the upstream stream ends, the vendor MUST call `finalize()`
 * to receive the terminal `finish` event carrying usage + citations
 * accumulated across the stream.
 */
export function createStreamParser() {
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    let citations: string[] | undefined;

    function feed(payload: unknown): XaiStreamEvent[] {
        const chunk = asRecord(payload);
        if (!chunk) return [];
        const events: XaiStreamEvent[] = [];

        const cits = Array.isArray(chunk.citations)
            ? chunk.citations.map((c) => clean(c)).filter(Boolean)
            : undefined;
        if (cits && cits.length > 0) citations = cits;

        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const first = asRecord(choices[0]);
        if (first) {
            const delta = asRecord(first.delta) || {};
            if (typeof delta.content === "string" && delta.content) {
                events.push({ type: "text-delta", text: delta.content });
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                events.push({ type: "reasoning-delta", text: delta.reasoning_content });
            }
            const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const call of toolCalls) {
                const r = asRecord(call);
                if (!r) continue;
                const idx = typeof r.index === "number" ? r.index : 0;
                const fn = asRecord(r.function);
                events.push({
                    type: "tool-call-delta",
                    index: idx,
                    ...(typeof r.id === "string" ? { id: r.id } : {}),
                    ...(fn && typeof fn.name === "string" ? { name: fn.name } : {}),
                    ...(fn && typeof fn.arguments === "string" ? { argumentsDelta: fn.arguments } : {}),
                });
            }
            const fr = clean(first.finish_reason);
            if (fr) finishReason = fr;
        }

        const newUsage = usageFromXai(chunk.usage);
        if (newUsage) usage = newUsage;

        return events;
    }

    function finalize(): XaiStreamEvent {
        return {
            type: "finish",
            ...(finishReason ? { finishReason } : {}),
            ...(usage ? { usage } : {}),
            ...(citations && citations.length > 0 ? { citations } : {}),
        };
    }

    return { feed, finalize };
}

// ---------------------------------------------------------------------------
// Image generation (grok-2-image)
// ---------------------------------------------------------------------------

export interface XaiImageOptions {
    n?: number;
    /** xAI accepts `b64_json` or `url`. */
    responseFormat?: "b64_json" | "url";
    user?: string;
    customParams?: Record<string, unknown>;
}

export interface XaiImageResult {
    /** Always set when the response carried a base64 payload. */
    b64Json?: string;
    /** Always set when the response carried a URL. */
    url?: string;
    revisedPrompt?: string;
    raw: unknown;
}

export function buildImageBody(
    modelId: string,
    prompt: string,
    options: XaiImageOptions = {},
): Record<string, unknown> {
    return {
        model: modelId,
        prompt,
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        response_format: options.responseFormat ?? "b64_json",
        ...(options.user ? { user: options.user } : {}),
        ...(options.customParams ?? {}),
    };
}

export function parseImageResponse(raw: unknown): XaiImageResult {
    const root = asRecord(raw) || {};
    const data = Array.isArray(root.data) ? root.data : [];
    const first = asRecord(data[0]) ?? root;
    const b64 = clean(first.b64_json) || clean(first.image);
    const url = clean(first.url);
    if (!b64 && !url) throw new Error("xAI image generation returned no payload");
    return {
        ...(b64 ? { b64Json: b64 } : {}),
        ...(url ? { url } : {}),
        ...(typeof first.revised_prompt === "string" ? { revisedPrompt: first.revised_prompt } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Responses API
// ---------------------------------------------------------------------------

export interface XaiResponsesOptions {
    instructions?: string;
    previousResponseId?: string;
    promptCacheKey?: string;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    parallelToolCalls?: boolean;
    /** "low" | "medium" | "high". */
    reasoningEffort?: "low" | "medium" | "high";
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: unknown;
    searchParameters?: XaiSearchParameters;
    store?: boolean;
    user?: string;
    customParams?: Record<string, unknown>;
    wireModelId?: string;
}

export function buildResponsesBody(
    modelId: string,
    input: unknown,
    options: XaiResponsesOptions = {},
): Record<string, unknown> {
    const tools = toolsToWire(options.tools);
    const toolChoice = toolChoiceToWire(options.toolChoice);
    const searchParameters = searchParametersToWire(options.searchParameters);
    return {
        model: options.wireModelId || modelId,
        input,
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
        ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.maxOutputTokens === "number" ? { max_output_tokens: options.maxOutputTokens } : {}),
        ...(typeof options.parallelToolCalls === "boolean" ? { parallel_tool_calls: options.parallelToolCalls } : {}),
        ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        ...(options.responseFormat ? { text: { format: options.responseFormat } } : {}),
        ...(searchParameters ? { search_parameters: searchParameters } : {}),
        ...(typeof options.store === "boolean" ? { store: options.store } : {}),
        ...(options.user ? { user: options.user } : {}),
        ...(options.customParams ?? {}),
    };
}

/**
 * Build the GET path for retrieving a stored Responses-API result.
 * Vendor prepends host + sends Authorization headers.
 */
export function responsesGetPath(responseId: string): string {
    return `${XAI_PATH_RESPONSES}/${encodeURIComponent(responseId)}`;
}
