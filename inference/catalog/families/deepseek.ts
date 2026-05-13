/**
 * DeepSeek family wire (deepseek-v4-flash, deepseek-v4-pro, R-series).
 *
 * Pure protocol module: builds DeepSeek request bodies and parses
 * responses + SSE frames into family-native types. NO endpoints,
 * NO API keys, NO network calls — vendors own the transport.
 *
 * Surfaces covered (per https://api-docs.deepseek.com):
 *   - `POST /chat/completions`         OpenAI-shape chat with native extensions
 *   - `POST /completions`              FIM (Fill-in-the-Middle) — beta
 *   - `GET  /models`                   list models
 *   - `GET  /user/balance`             account balance
 *
 * DeepSeek native lexicon Compose round-trips (in addition to standard
 * OpenAI Chat Completions params):
 *
 *   Request extensions:
 *     - `thinking: { type: "enabled" | "disabled" }`
 *         Default: "enabled". Toggles the chain-of-thought reasoning
 *         channel. When `disabled`, the model behaves as a regular
 *         non-reasoning model.
 *     - `reasoning_effort: "high" | "max"`
 *         Default: "high". `low`/`medium` are mapped to `high`;
 *         `xhigh` is mapped to `max`. Set to `max` for complex
 *         agentic workflows (Claude Code / OpenCode).
 *     - `logprobs: boolean`
 *         Whether to return log probabilities of output tokens.
 *     - `top_logprobs: integer (0-20)`
 *         Top-K most-likely-tokens at each token position.
 *     - `user_id: string`
 *         Caller-supplied user id for content safety review and
 *         per-user KVCache isolation. Charset `[a-zA-Z0-9\-_]`,
 *         max length 512.
 *     - `prefix: boolean` (assistant message — beta)
 *         When set on the LAST `assistant` message, forces the model
 *         to start its answer from the supplied prefix. Requires
 *         `base_url=".../beta"`.
 *     - `reasoning_content: string` (assistant message — beta)
 *         Used for thinking-mode CoT continuation in chat-prefix
 *         completion. Requires `prefix: true`.
 *     - `response_format: { type: "json_object" }`
 *         JSON Output mode (beta).
 *     - `stop: string | string[]` (up to 16)
 *
 *   Deprecated (no-ops; preserved here for catalog):
 *     - `frequency_penalty`, `presence_penalty`
 *
 *   Response extensions:
 *     - `choices[].message.reasoning_content`
 *         Server-emitted chain-of-thought (thinking-mode only).
 *     - `usage.prompt_cache_hit_tokens`
 *     - `usage.prompt_cache_miss_tokens`
 *         KVCache hit / miss accounting; `prompt_tokens === hit + miss`.
 *     - `usage.completion_tokens_details.reasoning_tokens`
 *         Tokens emitted into `reasoning_content`.
 *     - finish_reason: `"stop" | "length" | "content_filter" |
 *                       "tool_calls" | "insufficient_system_resource"`
 *     - logprobs.content / logprobs.reasoning_content (token-level)
 *
 *   FIM (`/completions` — beta):
 *     - `prompt: string`
 *     - `suffix: string`
 *         Text after the cursor — model fills the gap.
 *     - `max_tokens`, `temperature`, `top_p`, `frequency_penalty`,
 *       `presence_penalty`, `stop`, `logprobs`, `echo`, `stream`.
 */

import type {
    UnifiedMessage,
    UnifiedTool,
    UnifiedToolCall,
    UnifiedToolChoice,
    UnifiedUsage,
} from "../../core.js";
import { asRecord, assignMetric, clean, readNonNeg } from "../shared/index.js";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_BASE_URL_BETA = "https://api.deepseek.com/beta";
export const DEEPSEEK_PATH_CHAT = "/chat/completions";
export const DEEPSEEK_PATH_FIM = "/completions";
export const DEEPSEEK_PATH_MODELS = "/models";
export const DEEPSEEK_PATH_BALANCE = "/user/balance";

// ---------------------------------------------------------------------------
// Native types
// ---------------------------------------------------------------------------

export interface DeepSeekThinking {
    type: "enabled" | "disabled";
}

export type DeepSeekReasoningEffort = "high" | "max";

export type DeepSeekFinishReason =
    | "stop"
    | "length"
    | "content_filter"
    | "tool_calls"
    | "insufficient_system_resource";

export interface DeepSeekLogprob {
    token: string;
    logprob: number;
    bytes: number[] | null;
    top_logprobs: Array<{ token: string; logprob: number; bytes: number[] | null }>;
}

export interface DeepSeekResponseFormat {
    type: "text" | "json_object";
}

// ---------------------------------------------------------------------------
// Tool wire (OpenAI shape with `strict` option)
// ---------------------------------------------------------------------------

export interface DeepSeekFunctionTool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        /** Beta: enforce strict JSON-schema compliance. */
        strict?: boolean;
    };
}

export type DeepSeekToolChoice =
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };

export function toolsToWire(tools: UnifiedTool[] | undefined): DeepSeekFunctionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.function.name,
            ...(tool.function.description ? { description: tool.function.description } : {}),
            ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
        },
    }));
}

export function toolChoiceToWire(choice: UnifiedToolChoice | undefined): DeepSeekToolChoice | undefined {
    if (!choice) return undefined;
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    if (typeof choice === "object" && choice.type === "function") {
        return { type: "function", function: { name: choice.function.name } };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

/**
 * DeepSeek messages are pure OpenAI Chat Completions shape — no
 * vision input. `content` is always a string; multimodal parts are
 * ignored on the wire.
 */
export interface DeepSeekMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    /** Beta: prefix mode. Only valid on the LAST assistant message. */
    prefix?: boolean;
    /** Beta: continue thinking-mode CoT. Requires `prefix: true`. */
    reasoning_content?: string;
}

export function mapMessagesForDeepSeek(messages: UnifiedMessage[]): DeepSeekMessage[] {
    return messages.map((message) => {
        const text = textOf(message.content);
        if (message.role === "tool") {
            return { role: "tool", content: text, tool_call_id: clean(message.tool_call_id) };
        }
        if (message.role === "assistant") {
            const out: DeepSeekMessage = { role: "assistant", content: text };
            if (message.tool_calls && message.tool_calls.length > 0) {
                out.tool_calls = message.tool_calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.function.name, arguments: call.function.arguments },
                }));
            }
            if (message.name) out.name = message.name;
            return out;
        }
        return {
            role: message.role,
            content: text,
            ...(message.name ? { name: message.name } : {}),
        };
    });
}

function textOf(content: UnifiedMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
}

// ---------------------------------------------------------------------------
// Usage extraction (with KVCache + reasoning breakdown)
// ---------------------------------------------------------------------------

export function usageFromDeepSeek(rawUsage: unknown): UnifiedUsage | undefined {
    const usage = asRecord(rawUsage);
    if (!usage) return undefined;
    const promptTokens = readNonNeg(usage, ["prompt_tokens", "input_tokens"]) ?? 0;
    const completionTokens = readNonNeg(usage, ["completion_tokens", "output_tokens"]) ?? 0;
    const totalTokens = readNonNeg(usage, ["total_tokens"]) ?? promptTokens + completionTokens;

    const cacheHit = readNonNeg(usage, ["prompt_cache_hit_tokens"]);
    const cacheMiss = readNonNeg(usage, ["prompt_cache_miss_tokens"]);
    const completionDetails = asRecord(usage.completion_tokens_details);
    const reasoningTokens = readNonNeg(completionDetails, ["reasoning_tokens"]);

    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", promptTokens);
    assignMetric(billingMetrics, "output_tokens", completionTokens);
    assignMetric(billingMetrics, "total_tokens", totalTokens);
    assignMetric(billingMetrics, "cached_input_tokens", cacheHit);
    assignMetric(billingMetrics, "uncached_input_tokens", cacheMiss);
    assignMetric(billingMetrics, "reasoning_tokens", reasoningTokens);

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        ...(typeof cacheHit === "number" ? { cachedInputTokens: cacheHit } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        raw: usage,
    };
}

// ---------------------------------------------------------------------------
// Finish reason
// ---------------------------------------------------------------------------

export function mapFinishReason(value: unknown): string {
    const reason = clean(value) as DeepSeekFinishReason;
    if (!reason) return "stop";
    if (reason === "insufficient_system_resource") return "error";
    return reason;
}

// ---------------------------------------------------------------------------
// Chat — body builder + response parser
// ---------------------------------------------------------------------------

export interface DeepSeekChatOptions {
    temperature?: number;       // 0-2, default 1
    topP?: number;              // 0-1, default 1
    maxTokens?: number;
    stop?: string | string[];   // up to 16
    /** Native: thinking mode. */
    thinking?: DeepSeekThinking;
    /** Native: reasoning effort. */
    reasoningEffort?: DeepSeekReasoningEffort;
    /** OpenAI-shape. */
    responseFormat?: DeepSeekResponseFormat;
    tools?: UnifiedTool[];
    toolChoice?: UnifiedToolChoice;
    /** Native: per-token logprobs. */
    logprobs?: boolean;
    /** Native: top-K most-likely tokens. */
    topLogprobs?: number;       // 0-20
    /** Native: user id for content safety + KVCache isolation. */
    userId?: string;
    /** Stream options (pass-through). */
    streamOptions?: { include_usage?: boolean };
    /** Wire-model override (deployments / aliases). */
    wireModelId?: string;
    /** Free-form passthrough for any future native param. */
    customParams?: Record<string, unknown>;
}

export function buildChatBody(
    modelId: string,
    messages: UnifiedMessage[],
    options: DeepSeekChatOptions = {},
    streaming = false,
): Record<string, unknown> {
    const tools = toolsToWire(options.tools);
    const toolChoice = toolChoiceToWire(options.toolChoice);
    return {
        model: options.wireModelId || modelId,
        messages: mapMessagesForDeepSeek(messages),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(options.stop !== undefined ? { stop: options.stop } : {}),
        ...(options.thinking ? { thinking: options.thinking } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        ...(typeof options.logprobs === "boolean" ? { logprobs: options.logprobs } : {}),
        ...(typeof options.topLogprobs === "number" ? { top_logprobs: options.topLogprobs } : {}),
        ...(options.userId ? { user_id: options.userId } : {}),
        ...(streaming ? { stream: true } : {}),
        ...(options.streamOptions ? { stream_options: options.streamOptions } : {}),
        ...(options.customParams ?? {}),
    };
}

export interface DeepSeekChatResult {
    text: string;
    reasoningContent?: string;
    toolCalls?: UnifiedToolCall[];
    finishReason?: string;
    usage?: UnifiedUsage;
    logprobs?: { content?: DeepSeekLogprob[]; reasoning_content?: DeepSeekLogprob[] };
    systemFingerprint?: string;
    raw: unknown;
}

export function parseChatResponse(raw: unknown): DeepSeekChatResult {
    const root = asRecord(raw) || {};
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]) || {};
    const message = asRecord(first.message) || {};

    const text = clean(message.content);
    const reasoningContent = clean(message.reasoning_content);
    const toolCalls: UnifiedToolCall[] = [];
    const callsRaw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of callsRaw) {
        const record = asRecord(call);
        const fn = asRecord(record?.function);
        if (!record || !fn) continue;
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        toolCalls.push({ id: clean(record.id) || `call_${toolCalls.length}`, name: clean(fn.name), arguments: args });
    }

    const logprobsRecord = asRecord(first.logprobs);
    return {
        text,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: mapFinishReason(first.finish_reason),
        usage: usageFromDeepSeek(root.usage),
        ...(logprobsRecord ? { logprobs: logprobsRecord as DeepSeekChatResult["logprobs"] } : {}),
        ...(typeof root.system_fingerprint === "string" ? { systemFingerprint: root.system_fingerprint } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Streaming — SSE parser
// ---------------------------------------------------------------------------

export type DeepSeekStreamEvent =
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
    | { type: "finish"; finishReason?: string; usage?: UnifiedUsage };

export function createStreamParser() {
    let lastUsage: UnifiedUsage | undefined;
    function feed(payload: unknown): DeepSeekStreamEvent[] {
        const data = asRecord(payload);
        if (!data) return [];
        const events: DeepSeekStreamEvent[] = [];
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const first = asRecord(choices[0]);
        const delta = asRecord(first?.delta);
        if (delta) {
            const text = typeof delta.content === "string" ? delta.content : "";
            const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
            if (text) events.push({ type: "text-delta", text });
            if (reasoning) events.push({ type: "reasoning-delta", text: reasoning });
            const tc = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const call of tc) {
                const r = asRecord(call);
                if (!r) continue;
                const idx = typeof r.index === "number" ? r.index : 0;
                const fn = asRecord(r.function);
                events.push({
                    type: "tool-call-delta",
                    index: idx,
                    ...(r.id ? { id: clean(r.id) } : {}),
                    ...(fn?.name ? { name: clean(fn.name) } : {}),
                    ...(fn?.arguments ? { argumentsDelta: clean(fn.arguments) } : {}),
                });
            }
        }
        const usage = usageFromDeepSeek(data.usage);
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
// FIM (Fill-in-the-Middle) completions — beta
// ---------------------------------------------------------------------------

export interface DeepSeekFIMOptions {
    prompt: string;
    suffix?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string | string[];
    logprobs?: number;
    echo?: boolean;
    /** Beta: must call against `DEEPSEEK_BASE_URL_BETA`. */
    frequencyPenalty?: number;
    presencePenalty?: number;
    customParams?: Record<string, unknown>;
}

export function buildFIMBody(modelId: string, options: DeepSeekFIMOptions, streaming = false): Record<string, unknown> {
    return {
        model: modelId,
        prompt: options.prompt,
        ...(options.suffix !== undefined ? { suffix: options.suffix } : {}),
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(options.stop !== undefined ? { stop: options.stop } : {}),
        ...(typeof options.logprobs === "number" ? { logprobs: options.logprobs } : {}),
        ...(typeof options.echo === "boolean" ? { echo: options.echo } : {}),
        ...(typeof options.frequencyPenalty === "number" ? { frequency_penalty: options.frequencyPenalty } : {}),
        ...(typeof options.presencePenalty === "number" ? { presence_penalty: options.presencePenalty } : {}),
        ...(streaming ? { stream: true } : {}),
        ...(options.customParams ?? {}),
    };
}

// ---------------------------------------------------------------------------
// Account balance (`GET /user/balance`) — response parser
// ---------------------------------------------------------------------------

export interface DeepSeekBalance {
    isAvailable: boolean;
    /** Per-currency balance (typically just USD or CNY). */
    balanceInfos: Array<{ currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }>;
    raw: unknown;
}

export function parseBalanceResponse(raw: unknown): DeepSeekBalance {
    const root = asRecord(raw) || {};
    const infos = Array.isArray(root.balance_infos) ? root.balance_infos : [];
    return {
        isAvailable: Boolean(root.is_available),
        balanceInfos: infos.map((item) => {
            const r = asRecord(item) || {};
            return {
                currency: clean(r.currency),
                totalBalance: clean(r.total_balance),
                grantedBalance: clean(r.granted_balance),
                toppedUpBalance: clean(r.topped_up_balance),
            };
        }),
        raw,
    };
}
