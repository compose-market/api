/**
 * Moonshot/Kimi chat protocol.
 *
 * Pure protocol module: no endpoints, credentials, or network calls. Vendors
 * provide transport and feed response bodies or decoded SSE payloads here.
 */

import type { Call, Choice, Message, Tool, Usage } from "../../core.js";
import { asRecord, assignMetric, clean, readNonNeg } from "../shared/index.js";
import * as lower from "../shared/schema.js";

export interface MoonshotChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  tools?: Tool[];
  toolChoice?: Choice;
  responseFormat?: unknown;
  customParams?: Record<string, unknown>;
  wireModelId?: string;
}

export interface MoonshotChatResult {
  text: string;
  reasoningContent?: string;
  toolCalls?: Call[];
  finishReason: string;
  usage?: Usage;
  raw: unknown;
}

/** Protocol capabilities that vary within the Moonshot family. */
export function protocolCapabilities(modelId: string): { reasoning: boolean } {
  const id = modelId.toLowerCase();
  return {
    reasoning: id.includes("kimi-k3")
      || id.includes("kimi-k2.5")
      || id.includes("kimi-k2p5")
      || id.includes("kimi-k2.6")
      || id.includes("kimi-k2p6")
      || id.includes("kimi-k2.7")
      || id.includes("kimi-k2p7")
      || id.includes("thinking"),
  };
}

function content(message: Message): string | unknown[] {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => {
    if (part.type === "text") return {
      type: "text",
      text: part.text || "",
      ...(part.cache_control ? { cache_control: part.cache_control } : {}),
      ...(part.prompt_cache_breakpoint !== undefined ? { prompt_cache_breakpoint: part.prompt_cache_breakpoint } : {}),
    };
    if (part.type === "image_url") return { type: "image_url", image_url: part.image_url };
    if (part.type === "video_url") return { type: "video_url", video_url: part.video_url };
    return { type: "text", text: JSON.stringify(part) };
  });
}

export function mapMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: content(message),
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length ? {
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      })),
    } : {}),
    ...(message.role === "assistant" && message.reasoning_content !== undefined
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.role === "assistant" && message.partial === true ? { partial: true } : {}),
    ...(message.cache_control ? { cache_control: message.cache_control } : {}),
  }));
}

function tools(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: lower.object(tool.parameters),
    },
    ...(tool.cache_control ? { cache_control: tool.cache_control } : {}),
    ...(tool.prompt_cache_breakpoint !== undefined ? { prompt_cache_breakpoint: tool.prompt_cache_breakpoint } : {}),
  }));
}

function toolChoice(choice: Choice | undefined): unknown {
  if (!choice || typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

export function buildChatBody(
  modelId: string,
  messages: Message[],
  options: MoonshotChatOptions = {},
  streaming = false,
): Record<string, unknown> {
  const functionTools = tools(options.tools);
  const params = { ...(options.customParams || {}) };
  const normalizedModelId = (options.wireModelId || modelId).toLowerCase();
  const kimiK3 = normalizedModelId.includes("kimi-k3");
  const kimiK27 = normalizedModelId.includes("kimi-k2.7") || normalizedModelId.includes("kimi-k2p7");
  const reasoning = asRecord(params.reasoning);
  if (params.reasoning_effort === undefined && typeof reasoning?.effort === "string") {
    params.reasoning_effort = reasoning.effort;
  }
  delete params.reasoning;
  delete params.reasoningEffort;
  if (kimiK3 || kimiK27) {
    delete params.thinking;
    for (const key of ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty"]) {
      delete params[key];
    }
  }
  if (kimiK3) {
    const effort = typeof params.reasoning_effort === "string" ? params.reasoning_effort.toLowerCase() : undefined;
    if (effort && !["low", "high", "max"].includes(effort)) delete params.reasoning_effort;
  }
  if (kimiK27) delete params.reasoning_effort;
  for (const key of [
    "context_management",
    "include",
    "instructions",
    "max_tool_calls",
    "previous_response_id",
    "prompt_cache_retention",
    "store",
    "stream",
    "stream_options",
    "text",
    "truncation",
  ]) {
    delete params[key];
  }
  const wireMessages = mapMessages(messages);
  if (kimiK3 || kimiK27) {
    for (const message of wireMessages) {
      if (message.role === "assistant" && Array.isArray(message.tool_calls) && !('reasoning_content' in message)) {
        message.reasoning_content = "";
      }
    }
  }
  if (params.partial === true) {
    const lastAssistant = [...wireMessages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) lastAssistant.partial = true;
  }
  delete params.partial;
  const selectedToolChoice = kimiK27
    && options.toolChoice !== undefined
    && options.toolChoice !== "auto"
    && options.toolChoice !== "none"
    ? "auto"
    : options.toolChoice;
  return {
    model: options.wireModelId || modelId,
    messages: wireMessages,
    ...(!kimiK3 && !kimiK27 && typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(!kimiK3 && !kimiK27 && typeof options.topP === "number" ? { top_p: options.topP } : {}),
    ...(typeof options.maxTokens === "number" ? { max_completion_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    ...(functionTools ? { tools: functionTools } : {}),
    ...(selectedToolChoice ? { tool_choice: toolChoice(selectedToolChoice) } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...params,
  };
}

export function usage(raw: unknown): Usage | undefined {
  const value = asRecord(raw);
  if (!value) return undefined;
  const promptTokens = readNonNeg(value, ["prompt_tokens", "input_tokens"]) ?? 0;
  const completionTokens = readNonNeg(value, ["completion_tokens", "output_tokens"]) ?? 0;
  const totalTokens = readNonNeg(value, ["total_tokens"]) ?? promptTokens + completionTokens;
  const cachedInputTokens = readNonNeg(value, ["cached_tokens"])
    ?? readNonNeg(value, ["cached_input_tokens", "cached_prompt_tokens", "prompt_cache_hit_tokens"])
    ?? readNonNeg(asRecord(value.prompt_tokens_details), ["cached_tokens"])
    ?? readNonNeg(asRecord(value.input_tokens_details), ["cached_tokens"]);
  const inputDetails = asRecord(value.prompt_tokens_details) || asRecord(value.input_tokens_details);
  const perfMetrics = asRecord(value.perf_metrics);
  const cacheWriteTokens = readNonNeg(value, ["cache_write_tokens"])
    ?? readNonNeg(inputDetails, ["cache_write_tokens"]);
  const resolvedCachedInputTokens = cachedInputTokens
    ?? readNonNeg(perfMetrics, ["cached-prompt-tokens", "cached_prompt_tokens"]);
  const reasoningTokens = readNonNeg(asRecord(value.completion_tokens_details), ["reasoning_tokens"]);
  const billingMetrics: Record<string, unknown> = {};
  assignMetric(billingMetrics, "input_tokens", promptTokens);
  assignMetric(billingMetrics, "output_tokens", completionTokens);
  assignMetric(billingMetrics, "total_tokens", totalTokens);
  assignMetric(billingMetrics, "cached_input_tokens", resolvedCachedInputTokens);
  assignMetric(billingMetrics, "cache_write_input_tokens", cacheWriteTokens);
  assignMetric(billingMetrics, "reasoning_tokens", reasoningTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(resolvedCachedInputTokens !== undefined ? { cachedInputTokens: resolvedCachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    billingMetrics,
    raw: value,
  };
}

function calls(value: unknown): Call[] | undefined {
  const message = asRecord(value);
  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const result = rawCalls.flatMap((raw, index): Call[] => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    const name = clean(fn?.name);
    if (!name) return [];
    return [{
      id: clean(call?.id) || `call_${index}`,
      name,
      arguments: typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
    }];
  });
  return result.length ? result : undefined;
}

export function finishReason(value: unknown, hasTools = false): string {
  if (hasTools || clean(value) === "tool_calls") return "tool-calls";
  return clean(value) || "stop";
}

export function parseChatResponse(raw: unknown): MoonshotChatResult {
  const root = asRecord(raw) || {};
  const first = asRecord(Array.isArray(root.choices) ? root.choices[0] : undefined) || {};
  const message = asRecord(first.message) || {};
  const toolCalls = calls(message);
  const reasoningContent = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
  return {
    text: typeof message.content === "string" ? message.content : "",
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    finishReason: finishReason(first.finish_reason, Boolean(toolCalls?.length)),
    usage: usage(root.usage),
    raw,
  };
}

export type MoonshotStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "finish"; finishReason?: string; usage?: Usage };

export function createStreamParser() {
  let lastUsage: Usage | undefined;
  let lastFinishReason = "";
  let sawTools = false;

  function feed(payload: unknown): MoonshotStreamEvent[] {
    const root = asRecord(payload);
    if (!root) return [];
    const events: MoonshotStreamEvent[] = [];
    const first = asRecord(Array.isArray(root.choices) ? root.choices[0] : undefined);
    const delta = asRecord(first?.delta);
    if (delta) {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        events.push({ type: "reasoning-delta", text: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content) {
        events.push({ type: "text-delta", text: delta.content });
      }
      for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.function);
        const index = typeof call?.index === "number" ? call.index : 0;
        events.push({
          type: "tool-call-delta",
          index,
          ...(clean(call?.id) ? { id: clean(call?.id) } : {}),
          ...(clean(fn?.name) ? { name: clean(fn?.name) } : {}),
          ...(typeof fn?.arguments === "string" && fn.arguments ? { argumentsDelta: fn.arguments } : {}),
        });
        sawTools = true;
      }
    }
    const parsedUsage = usage(root.usage);
    if (parsedUsage) lastUsage = parsedUsage;
    if (first?.finish_reason != null) lastFinishReason = clean(first.finish_reason);
    return events;
  }

  function finalize(): Extract<MoonshotStreamEvent, { type: "finish" }> {
    return {
      type: "finish",
      finishReason: finishReason(lastFinishReason, sawTools),
      ...(lastUsage ? { usage: lastUsage } : {}),
    };
  }

  return { feed, finalize };
}
