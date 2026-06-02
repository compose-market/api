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
import { asRecord, assignMetric, clean, readNonNeg } from "../shared/index.js";
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

/**
 * Translate Compose `Message[]` into Anthropic `messages` plus
 * an extracted top-level `system` string. Anthropic does NOT have a
 * `system` role inside `messages`; system-prompt parts must be lifted
 * to the top-level `system` parameter.
 */
export function mapMessagesForAnthropic(
    messages: Message[],
): { system: string | undefined; messages: AnthropicMessage[] } {
    const systemTexts: string[] = [];
    const out: AnthropicMessage[] = [];

    for (const message of messages) {
        if (message.role === "system") {
            const text = textOf(message.content);
            if (text) systemTexts.push(text);
            continue;
        }

        // Tool-result message → user-role content with `tool_result` blocks.
        if (message.role === "tool") {
            const id = clean(message.tool_call_id);
            if (!id) continue;
            const text = textOf(message.content);
            out.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: id, content: text }],
            });
            continue;
        }

        // Assistant message — carries text plus optional tool_calls.
        if (message.role === "assistant") {
            const blocks: AnthropicContentBlock[] = [];
            const text = textOf(message.content);
            if (text) blocks.push({ type: "text", text });
            for (const call of message.tool_calls ?? []) {
                let input: Record<string, unknown> = {};
                try { input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
                catch { input = {}; }
                blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
            }
            out.push({ role: "assistant", content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks });
            continue;
        }

        // User message — text + optional image_url / video_url / input_audio parts.
        const content: AnthropicContentBlock[] = [];
        if (typeof message.content === "string") {
            if (message.content) content.push({ type: "text", text: message.content });
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text" && part.text) {
                    content.push({ type: "text", text: part.text });
                } else if (part.type === "image_url") {
                    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
                    if (!url) continue;
                    content.push({
                        type: "image",
                        source: url.startsWith("data:")
                            ? parseDataUrlToAnthropicImage(url)
                            : { type: "url", url },
                    });
                }
                // video_url / input_audio not supported by Anthropic Messages API — silently dropped.
            }
        }
        out.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content });
    }

    const system = systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined;
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
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        input_schema: lower.object(tool.function.parameters),
    }));
}

export function toolChoiceToWire(choice: Choice | undefined): AnthropicToolChoice | undefined {
    if (!choice) return undefined;
    if (choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "none" };
    if (choice === "required") return { type: "any" };
    if (typeof choice === "object" && choice.type === "function") {
        return { type: "tool", name: choice.function.name };
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
    const total = inputTokens + outputTokens;

    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", inputTokens);
    assignMetric(billingMetrics, "output_tokens", outputTokens);
    assignMetric(billingMetrics, "total_tokens", total);
    assignMetric(billingMetrics, "cache_creation_input_tokens", cacheCreate);
    assignMetric(billingMetrics, "cache_read_input_tokens", cacheRead);

    return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: total,
        ...(typeof cacheRead === "number" ? { cachedInputTokens: cacheRead } : {}),
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

export interface AnthropicChatResult {
    text: string;
    toolCalls?: Call[];
    finishReason?: string;
    usage?: Usage;
    raw: unknown;
}

const DEFAULT_MAX_TOKENS = 4096;

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
    return {
        model: options.wireModelId || modelId,
        messages: anthMessages,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.topP === "number" ? { top_p: options.topP } : {}),
        ...(typeof options.topK === "number" ? { top_k: options.topK } : {}),
        ...(options.stopSequences && options.stopSequences.length > 0 ? { stop_sequences: options.stopSequences } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(streaming ? { stream: true } : {}),
        ...(options.customParams ?? {}),
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
    const toolCalls: Call[] = [];
    for (const block of blocks) {
        const record = asRecord(block);
        if (!record) continue;
        const type = clean(record.type);
        if (type === "text" && typeof record.text === "string") {
            textParts.push(record.text);
        } else if (type === "tool_use") {
            toolCalls.push({
                id: clean(record.id) || `call_${toolCalls.length}`,
                name: clean(record.name),
                arguments: JSON.stringify(record.input ?? {}),
            });
        }
    }
    return {
        text: textParts.join(""),
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
        case "tool_use": return "tool_calls";
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
    | { type: "tool-call-start"; id: string; name: string; index: number }
    | { type: "tool-call-delta"; index: number; argumentsDelta: string }
    | { type: "message-stop"; finishReason?: string; usage?: Usage };

/**
 * Stateful parser for Anthropic Messages-API SSE frames.
 *
 * Vendors hold an instance per stream, feed it the JSON-decoded payload
 * of each `data:` frame via `feed(...)`, and yield from the returned
 * iterator until the upstream stream ends.
 */
export function createStreamParser() {
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let stopped = false;

    function feed(payload: unknown): AnthropicStreamEvent[] {
        const data = asRecord(payload);
        if (!data || stopped) return [];
        const eventType = clean(data.type);

        if (eventType === "content_block_start") {
            const idx = typeof data.index === "number" ? data.index : 0;
            const block = asRecord(data.content_block);
            if (block && clean(block.type) === "tool_use") {
                return [{ type: "tool-call-start", id: clean(block.id), name: clean(block.name), index: idx }];
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
            if (dt === "input_json_delta" && typeof delta.partial_json === "string") {
                return [{ type: "tool-call-delta", index: idx, argumentsDelta: delta.partial_json }];
            }
            return [];
        }

        if (eventType === "message_delta") {
            const delta = asRecord(data.delta);
            if (delta) finishReason = mapFinishReason(clean(delta.stop_reason));
            const newUsage = usageFromAnthropic(data.usage);
            if (newUsage) usage = newUsage;
            return [];
        }

        if (eventType === "message_stop") {
            stopped = true;
            return [{
                type: "message-stop",
                ...(finishReason ? { finishReason } : {}),
                ...(usage ? { usage } : {}),
            }];
        }

        return [];
    }

    return { feed };
}
