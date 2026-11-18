/**
 * Anthropic Claude family wire.
 *
 * Pure protocol module: builds Anthropic Messages-API request bodies,
 * translates Message[] into Anthropic content-block messages,
 * and parses Anthropic responses + streaming frames back into family-
 * native types.
 *
 * NO endpoints, NO API keys, NO network calls. Vendors that route
 * Anthropic models (vertex, bedrock, etc.) own the transport — they
 * call `buildChatBody`, POST it, then feed the response/SSE frames
 * back into `parseChatResponse` / `parseStreamFrame`.
 *
 * Spec: https://docs.anthropic.com/en/api/messages
 */

import type {
    Message,
    Tool,
    Call,
    Choice,
    Usage,
} from "../../core.js";
import { asRecord, assignMetric, clean, readNonNeg, stripResponsesParams } from "../shared/index.js";
import * as lower from "../shared/schema.js";

// ---------------------------------------------------------------------------
// Content-block model (subset — the parts we round-trip)
// ---------------------------------------------------------------------------

export type AnthropicContentBlock =
    | { type: "text"; text: string; cache_control?: AnthropicCacheControl; citations?: AnthropicCitation[] }
    | { type: "image"; source: AnthropicImageSource; cache_control?: AnthropicCacheControl }
    | {
        type: "document";
        source: AnthropicDocumentSource;
        cache_control?: AnthropicCacheControl;
        citations?: { enabled?: boolean };
        context?: string;
        title?: string;
    }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; cache_control?: AnthropicCacheControl }
    | { type: "tool_result"; tool_use_id: string; content?: string | AnthropicContentBlock[]; is_error?: boolean; cache_control?: AnthropicCacheControl }
    | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "web_search_tool_result"; tool_use_id: string; content: unknown }
    | { type: "search_result"; content: AnthropicContentBlock[]; source: string; title: string; cache_control?: AnthropicCacheControl };

export type AnthropicCacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

function cacheControl(value: unknown): AnthropicCacheControl | undefined {
    const record = asRecord(value);
    if (record?.type !== "ephemeral") return undefined;
    const ttl = record.ttl === "5m" || record.ttl === "1h" ? record.ttl : undefined;
    return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

export type AnthropicImageSource =
    | { type: "base64"; data: string; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
    | { type: "url"; url: string };

export type AnthropicDocumentSource =
    | { type: "base64"; data: string; media_type: "application/pdf" }
    | { type: "text"; data: string; media_type: "text/plain" }
    | { type: "url"; url: string }
    | { type: "content"; content: string | AnthropicContentBlock[] };

export interface AnthropicCitation {
    type: string;
    cited_text: string;
    [key: string]: unknown;
}

export interface AnthropicMessage {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
}

// ---------------------------------------------------------------------------
// Translation: Message ⇔ AnthropicMessage
// ---------------------------------------------------------------------------

export type AnthropicSystemBlock = {
    type: "text";
    text: string;
    cache_control?: AnthropicCacheControl;
};

/**
 * Translate Compose `Message[]` into Anthropic `messages` plus
 * an extracted top-level `system` string or content-block array
 * (when any system block carries `cache_control`). Anthropic does NOT
 * have a `system` role inside `messages`; system-prompt parts must be
 * lifted to the top-level `system` parameter.
 */
export function mapMessagesForAnthropic(
    messages: Message[],
): { system: string | AnthropicSystemBlock[] | undefined; messages: AnthropicMessage[] } {
    const systemBlocks: AnthropicSystemBlock[] = [];
    const out: AnthropicMessage[] = [];

    for (const message of messages) {
        if (message.role === "system") {
            const msgCache = cacheControl(message.cache_control);
            if (typeof message.content === "string") {
                if (message.content) {
                    systemBlocks.push({
                        type: "text",
                        text: message.content,
                        ...(msgCache ? { cache_control: msgCache } : {}),
                    });
                }
            } else if (Array.isArray(message.content)) {
                const startIdx = systemBlocks.length;
                for (const part of message.content) {
                    if (part.type === "text" && typeof part.text === "string" && part.text) {
                        const partCache = cacheControl(part.cache_control);
                        systemBlocks.push({
                            type: "text",
                            text: part.text,
                            ...(partCache ? { cache_control: partCache } : {}),
                        });
                    }
                }
                if (msgCache && systemBlocks.length > startIdx && !systemBlocks[systemBlocks.length - 1].cache_control) {
                    systemBlocks[systemBlocks.length - 1].cache_control = msgCache;
                }
            }
            continue;
        }

        // Tool-result message → user-role content with `tool_result` blocks.
        // Coalesce consecutive tool results into one user turn (Anthropic rejects consecutive user turns).
        if (message.role === "tool") {
            const id = clean(message.tool_call_id);
            if (!id) continue;
            const text = textOf(message.content);
            const msgCache = cacheControl(message.cache_control);
            const block: AnthropicContentBlock = {
                type: "tool_result",
                tool_use_id: id,
                content: text,
                ...(msgCache ? { cache_control: msgCache } : {}),
            };
            const prev = out[out.length - 1];
            if (
                prev
                && prev.role === "user"
                && Array.isArray(prev.content)
                && prev.content.length > 0
                && prev.content.every((item) => item.type === "tool_result")
            ) {
                prev.content.push(block);
            } else {
                out.push({
                    role: "user",
                    content: [block],
                });
            }
            continue;
        }

        // Assistant message — preserves thinking / redacted_thinking blocks, text, tool_calls, and cache_control.
        if (message.role === "assistant") {
            const blocks: AnthropicContentBlock[] = [];
            const msgCache = cacheControl(message.cache_control);
            if (typeof message.content === "string") {
                if (message.content) {
                    blocks.push({ type: "text", text: message.content });
                }
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === "thinking" && typeof part.thinking === "string") {
                        blocks.push({
                            type: "thinking",
                            thinking: part.thinking,
                            signature: typeof part.signature === "string" ? part.signature : "",
                        });
                    } else if (part.type === "redacted_thinking" && typeof part.data === "string") {
                        blocks.push({
                            type: "redacted_thinking",
                            data: part.data,
                        });
                    } else if (part.type === "text" && typeof part.text === "string" && part.text) {
                        const partCache = cacheControl(part.cache_control);
                        blocks.push({
                            type: "text",
                            text: part.text,
                            ...(partCache ? { cache_control: partCache } : {}),
                        });
                    }
                }
            }
            for (const call of message.tool_calls ?? []) {
                let input: Record<string, unknown> = {};
                try { input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
                catch { input = {}; }
                blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
            }
            if (msgCache) {
                for (let i = blocks.length - 1; i >= 0; i -= 1) {
                    const block = blocks[i];
                    if ((block.type === "text" || block.type === "tool_use") && !block.cache_control) {
                        block.cache_control = msgCache;
                        break;
                    }
                }
            }
            out.push({
                role: "assistant",
                content: blocks.length === 1 && blocks[0].type === "text" && !blocks[0].cache_control
                    ? blocks[0].text
                    : blocks,
            });
            continue;
        }

        // User message — text + optional image_url parts, preserving cache_control breakpoints.
        const content: AnthropicContentBlock[] = [];
        const msgCache = cacheControl(message.cache_control);
        if (typeof message.content === "string") {
            if (message.content) {
                content.push({
                    type: "text",
                    text: message.content,
                    ...(msgCache ? { cache_control: msgCache } : {}),
                });
            }
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text" && part.text) {
                    const partCache = cacheControl(part.cache_control);
                    content.push({
                        type: "text",
                        text: part.text,
                        ...(partCache ? { cache_control: partCache } : {}),
                    });
                } else if (part.type === "image_url") {
                    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
                    if (!url) continue;
                    const partCache = cacheControl(part.cache_control);
                    content.push({
                        type: "image",
                        source: url.startsWith("data:")
                            ? parseDataUrlToAnthropicImage(url)
                            : { type: "url", url },
                        ...(partCache ? { cache_control: partCache } : {}),
                    });
                }
                // video_url / input_audio not supported by Anthropic Messages API — silently dropped.
            }
            if (msgCache && content.length > 0) {
                const last = content[content.length - 1];
                if ((last.type === "text" || last.type === "image") && !last.cache_control) {
                    last.cache_control = msgCache;
                }
            }
        }
        out.push({
            role: "user",
            content: content.length === 1 && content[0].type === "text" && !content[0].cache_control
                ? content[0].text
                : content,
        });
    }

    const hasSystemCacheControl = systemBlocks.some((block) => Boolean(block.cache_control));
    const system = systemBlocks.length === 0
        ? undefined
        : hasSystemCacheControl
            ? systemBlocks
            : systemBlocks.map((block) => block.text).join("\n\n");
    return { system, messages: out };
}

function textOf(content: Message["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
}

function parseDataUrlToAnthropicImage(url: string): AnthropicImageSource {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
    if (!match) return { type: "url", url };
    const mime = match[1];
    const data = match[2];
    if (mime === "image/jpeg" || mime === "image/png" || mime === "image/gif" || mime === "image/webp") {
        return { type: "base64", data, media_type: mime };
    }
    return { type: "url", url };
}

// ---------------------------------------------------------------------------
// Tools + tool_choice
// ---------------------------------------------------------------------------

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
    cache_control?: AnthropicCacheControl;
}

export type AnthropicToolChoice =
    | { type: "auto"; disable_parallel_tool_use?: boolean }
    | { type: "any"; disable_parallel_tool_use?: boolean }
    | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
    | { type: "none" };

export function toolsToWire(tools: Tool[] | undefined): AnthropicTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: lower.object(tool.parameters),
        ...(cacheControl(tool.cache_control) ? { cache_control: cacheControl(tool.cache_control) } : {}),
    }));
}

export function toolChoiceToWire(choice: Choice | undefined): AnthropicToolChoice | undefined {
    if (!choice) return undefined;
    if (choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "none" };
    if (choice === "required") return { type: "any" };
    if (typeof choice === "object" && choice.type === "function") {
        return { type: "tool", name: choice.name };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function usageFromAnthropic(rawUsage: unknown): Usage | undefined {
    const usage = asRecord(rawUsage);
    if (!usage) return undefined;
    const inputTokens = readNonNeg(usage, ["input_tokens"]) ?? 0;
    const outputTokens = readNonNeg(usage, ["output_tokens"]) ?? 0;
    const cacheCreate = readNonNeg(usage, ["cache_creation_input_tokens"]);
    const cacheRead = readNonNeg(usage, ["cache_read_input_tokens"]);
    const promptTokens = inputTokens + (cacheCreate || 0) + (cacheRead || 0);
    const total = promptTokens + outputTokens;

    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", promptTokens);
    assignMetric(billingMetrics, "uncached_input_tokens", inputTokens);
    assignMetric(billingMetrics, "output_tokens", outputTokens);
    assignMetric(billingMetrics, "total_tokens", total);
    assignMetric(billingMetrics, "cache_creation_input_tokens", cacheCreate);
    assignMetric(billingMetrics, "cache_write_input_tokens", cacheCreate);
    assignMetric(billingMetrics, "cache_read_input_tokens", cacheRead);

    return {
        promptTokens,
        completionTokens: outputTokens,
        totalTokens: total,
        ...(typeof cacheRead === "number" ? { cachedInputTokens: cacheRead } : {}),
        ...(typeof cacheCreate === "number" ? { cacheWriteTokens: cacheCreate } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        raw: usage,
    };
}

// ---------------------------------------------------------------------------
// Chat / messages — body builder + response parser
// ---------------------------------------------------------------------------

export interface AnthropicChatOptions {
    /** Required by Anthropic — the API rejects calls without `max_tokens`. */
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    tools?: Tool[];
    toolChoice?: Choice;
    /** Free-form passthrough (extended thinking, beta headers, etc). */
    customParams?: Record<string, unknown>;
    /** Override the wire model id (vendor-specific deployment names). */
    wireModelId?: string;
}

export type AnthropicThinkingBlock =
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string };

export interface AnthropicChatResult {
    text: string;
    reasoningContent?: string;
    thinkingBlocks?: AnthropicThinkingBlock[];
    toolCalls?: Call[];
    finishReason?: string;
    usage?: Usage;
    raw: unknown;
}

const NON_ANTHROPIC_PARAM_KEYS = [
    "fail_fast",
    "n",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repetition_penalty",
    "prompt_cache_key",
    "prompt_cache_options",
    "seed",
    "logprobs",
    "top_logprobs",
    "stop",
    "models",
    "response_format",
    "chat_template_kwargs",
    "continue_final_message",
    "ignore_eos",
    "stop_token_ids",
    "cache_salt",
    "media_io_kwargs",
    "reasoning",
    "reasoning_effort",
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "top_k",
] as const;

function sanitizeAnthropicParams(customParams: Record<string, unknown> | undefined): Record<string, unknown> {
    const params = stripResponsesParams(customParams);
    for (const key of NON_ANTHROPIC_PARAM_KEYS) {
        delete params[key];
    }
    return params;
}

/**
 * Build a `POST /v1/messages` request body. Vendors POST this to their
 * configured Anthropic-compatible endpoint and feed the response into
 * `parseChatResponse`.
 */
export function buildChatBody(
    modelId: string,
    messages: Message[],
    options: AnthropicChatOptions = {},
    streaming = false,
): Record<string, unknown> {
    const { system, messages: anthMessages } = mapMessagesForAnthropic(messages);
    const tools = toolsToWire(options.tools);
    const toolChoice = toolChoiceToWire(options.toolChoice);
    const params = sanitizeAnthropicParams(options.customParams);
    const hasTemp = typeof options.temperature === "number";
    const validTopK = typeof options.topK === "number" && options.topK > 0 ? options.topK : undefined;
    return {
        ...params,
        model: options.wireModelId || modelId,
        messages: anthMessages,
        ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
        ...(system ? { system } : {}),
        ...(hasTemp ? { temperature: options.temperature } : {}),
        ...(!hasTemp && typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(validTopK !== undefined ? { top_k: validTopK } : {}),
        ...(options.stopSequences && options.stopSequences.length > 0 ? { stop_sequences: options.stopSequences } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(streaming ? { stream: true } : {}),
    };
}

/**
 * Parse an Anthropic Messages-API response body into family-native
 * `AnthropicChatResult`.
 */
export function parseChatResponse(raw: unknown): AnthropicChatResult {
    const root = asRecord(raw) || {};
    const blocks = Array.isArray(root.content) ? root.content : [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const thinkingBlocks: AnthropicThinkingBlock[] = [];
    const toolCalls: Call[] = [];
    for (const block of blocks) {
        const record = asRecord(block);
        if (!record) continue;
        const type = clean(record.type);
        if (type === "text" && typeof record.text === "string") {
            textParts.push(record.text);
        } else if (type === "thinking" && typeof record.thinking === "string") {
            reasoningParts.push(record.thinking);
            thinkingBlocks.push({
                type: "thinking",
                thinking: record.thinking,
                signature: typeof record.signature === "string" ? record.signature : "",
            });
        } else if (type === "redacted_thinking" && typeof record.data === "string") {
            thinkingBlocks.push({
                type: "redacted_thinking",
                data: record.data,
            });
        } else if (type === "tool_use") {
            toolCalls.push({
                id: clean(record.id) || `call_${toolCalls.length}`,
                name: clean(record.name),
                arguments: JSON.stringify(record.input ?? {}),
            });
        }
    }
    const reasoningContent = reasoningParts.join("");
    return {
        text: textParts.join(""),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: mapFinishReason(clean(root.stop_reason)),
        usage: usageFromAnthropic(root.usage),
        raw,
    };
}

/**
 * Map Anthropic `stop_reason` strings onto Compose finish-reason values.
 */
export function mapFinishReason(reason: string): string {
    switch (reason) {
        case "end_turn": return "stop";
        case "max_tokens": return "length";
        case "tool_use": return "tool-calls";
        case "stop_sequence": return "stop";
        default: return reason || "stop";
    }
}

// ---------------------------------------------------------------------------
// Streaming — SSE frame parser
// ---------------------------------------------------------------------------

export type AnthropicStreamEvent =
    | { type: "text-delta"; text: string }
    | { type: "thinking-delta"; text: string }
    | { type: "thinking-signature-delta"; index: number; signature: string }
    | { type: "redacted-thinking"; index: number; data: string }
    | { type: "tool-call-start"; id: string; name: string; index: number }
    | { type: "tool-call-delta"; index: number; argumentsDelta: string }
    | { type: "error"; code?: string; message: string }
    | { type: "message-stop"; finishReason?: string; usage?: Usage; complete?: boolean };

/**
 * Stateful parser for Anthropic Messages-API SSE frames.
 *
 * Vendors hold an instance per stream, feed it the JSON-decoded payload
 * of each `data:` frame via `feed(...)`, and yield from the returned
 * iterator until the upstream stream ends. Call `finalize()` if the
 * upstream closes before emitting `message_stop`.
 */
export function createStreamParser() {
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let rawUsageAccum: Record<string, unknown> = {};
    let stopped = false;

    function feed(payload: unknown): AnthropicStreamEvent[] {
        const data = asRecord(payload);
        if (!data || stopped) return [];
        const eventType = clean(data.type);

        if (eventType === "error") {
            stopped = true;
            const err = asRecord(data.error);
            const code = clean(err?.type) || clean(err?.code) || "upstream_error";
            const message = clean(err?.message) || clean(data.message) || "Anthropic upstream stream error";
            return [{ type: "error", code, message }];
        }

        if (eventType === "message_start") {
            const message = asRecord(data.message);
            const startUsage = asRecord(message?.usage);
            if (startUsage) {
                rawUsageAccum = { ...rawUsageAccum, ...startUsage };
                usage = usageFromAnthropic(rawUsageAccum);
            }
            return [];
        }

        if (eventType === "content_block_start") {
            const idx = typeof data.index === "number" ? data.index : 0;
            const block = asRecord(data.content_block);
            const blockType = clean(block?.type);
            if (block && blockType === "tool_use") {
                return [{ type: "tool-call-start", id: clean(block.id), name: clean(block.name), index: idx }];
            }
            if (block && blockType === "redacted_thinking" && typeof block.data === "string") {
                return [{ type: "redacted-thinking", index: idx, data: block.data }];
            }
            if (block && blockType === "thinking" && typeof block.thinking === "string" && block.thinking) {
                return [{ type: "thinking-delta", text: block.thinking }];
            }
            return [];
        }

        if (eventType === "content_block_delta") {
            const idx = typeof data.index === "number" ? data.index : 0;
            const delta = asRecord(data.delta);
            if (!delta) return [];
            const dt = clean(delta.type);
            if (dt === "text_delta" && typeof delta.text === "string") {
                return [{ type: "text-delta", text: delta.text }];
            }
            if (dt === "thinking_delta" && typeof delta.thinking === "string") {
                return [{ type: "thinking-delta", text: delta.thinking }];
            }
            if (dt === "signature_delta" && typeof delta.signature === "string") {
                return [{ type: "thinking-signature-delta", index: idx, signature: delta.signature }];
            }
            if (dt === "input_json_delta" && typeof delta.partial_json === "string") {
                return [{ type: "tool-call-delta", index: idx, argumentsDelta: delta.partial_json }];
            }
            return [];
        }

        if (eventType === "message_delta") {
            const delta = asRecord(data.delta);
            if (delta && delta.stop_reason != null) finishReason = mapFinishReason(clean(delta.stop_reason));
            const deltaUsage = asRecord(data.usage);
            if (deltaUsage) {
                rawUsageAccum = { ...rawUsageAccum, ...deltaUsage };
                const mergedUsage = usageFromAnthropic(rawUsageAccum);
                if (mergedUsage) usage = mergedUsage;
            }
            return [];
        }

        if (eventType === "message_stop") {
            stopped = true;
            return [{
                type: "message-stop",
                complete: true,
                ...(finishReason ? { finishReason } : {}),
                ...(usage ? { usage } : {}),
            }];
        }

        return [];
    }

    function finalize(): Extract<AnthropicStreamEvent, { type: "message-stop" }> | null {
        if (stopped) return null;
        stopped = true;
        return {
            type: "message-stop",
            complete: false,
            ...(finishReason ? { finishReason } : {}),
            ...(usage ? { usage } : {}),
        };
    }

    return { feed, finalize };
}
