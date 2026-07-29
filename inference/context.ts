import type { Message, Request } from "./core.js";
import type { ResponsesInputItem } from "./responses.js";
import type { ModelCard } from "./types.js";

const DEFAULT_OUTPUT_RESERVE = 32_000;
const STRUCTURAL_RESERVE = 4_096;

interface ContextLimits {
  context: number;
  input: number;
  output?: number;
}

interface Group<T> {
  values: T[];
  openToolCycle: boolean;
}

export interface ContextManagementResult {
  request: Request;
  enabled: boolean;
  compacted: boolean;
  originalEstimatedTokens: number;
  effectiveEstimatedTokens: number;
  droppedMessageGroups: number;
  droppedItemGroups: number;
  targetTokens?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function contextLimits(model: ModelCard | null | undefined): ContextLimits | null {
  if (!model) return null;
  const raw = record(model.contextWindow);
  const input = positive(raw?.inputTokens)
    ?? positive(raw?.input_tokens)
    ?? positive(raw?.maxInputTokens)
    ?? positive(raw?.max_input_tokens);
  const context = positive(model.contextWindow)
    ?? positive(raw?.tokens)
    ?? positive(raw?.contextTokens)
    ?? positive(raw?.context_tokens)
    ?? positive(raw?.contextLength)
    ?? positive(raw?.context_length)
    ?? input;
  if (!context) return null;
  const output = positive(raw?.outputTokens)
    ?? positive(raw?.output_tokens)
    ?? positive(raw?.maxOutputTokens)
    ?? positive(raw?.max_output_tokens)
    ?? positive(model.maxOutputTokens);
  return { context, input: input ?? context, ...(output ? { output } : {}) };
}

function estimate(value: unknown): number {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) || "";
  } catch {
    serialized = String(value ?? "");
  }
  return Math.ceil(serialized.length / 3.5);
}

function openMessageToolCycle(messages: Message[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls || []) if (call.id) calls.add(call.id);
    if (message.role === "tool" && message.tool_call_id) results.add(message.tool_call_id);
  }
  return [...calls].some((id) => !results.has(id));
}

function messageGroups(messages: Message[]): { fixed: Message[]; groups: Array<Group<Message>> } {
  const fixed: Message[] = [];
  const groups: Array<Group<Message>> = [];
  let current: Message[] = [];
  let leading = true;
  const flush = () => {
    if (current.length === 0) return;
    groups.push({
      values: current,
      openToolCycle: openMessageToolCycle(current) || current.some((message) => message.role === "system"),
    });
    current = [];
  };

  for (const message of messages) {
    if (leading && message.role === "system") {
      fixed.push(message);
      continue;
    }
    leading = false;
    if (message.role === "user" && current.length > 0) flush();
    current.push(message);
  }
  flush();
  return { fixed, groups };
}

function itemRole(item: ResponsesInputItem): string | undefined {
  return typeof item.role === "string" ? item.role : undefined;
}

function itemType(item: ResponsesInputItem): string {
  return typeof item.type === "string" ? item.type : "";
}

function openItemToolCycle(items: ResponsesInputItem[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of items) {
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    if (itemType(item) === "function_call" && callId) calls.add(callId);
    if (itemType(item) === "function_call_output" && callId) results.add(callId);
  }
  return [...calls].some((id) => !results.has(id));
}

function itemGroups(items: ResponsesInputItem[]): { fixed: ResponsesInputItem[]; groups: Array<Group<ResponsesInputItem>> } {
  const fixed: ResponsesInputItem[] = [];
  const groups: Array<Group<ResponsesInputItem>> = [];
  let current: ResponsesInputItem[] = [];
  let leading = true;
  const flush = () => {
    if (current.length === 0) return;
    groups.push({
      values: current,
      openToolCycle: openItemToolCycle(current) || current.some((item) => {
        const role = itemRole(item);
        return role === "system" || role === "developer";
      }),
    });
    current = [];
  };

  for (const item of items) {
    const role = itemRole(item);
    if (leading && (role === "system" || role === "developer")) {
      fixed.push(item);
      continue;
    }
    leading = false;
    if (role === "user" && current.length > 0) flush();
    current.push(item);
  }
  flush();
  return { fixed, groups };
}

function compactGroups<T>(
  fixed: T[],
  source: Array<Group<T>>,
  target: number,
  commonTokens: number,
  minimumRecent: number,
): { values: T[]; dropped: number } {
  const groups = source.map((group) => ({ ...group, values: [...group.values] }));
  let dropped = 0;
  const size = () => commonTokens + estimate([...fixed, ...groups.flatMap((group) => group.values)]);

  while (groups.length > minimumRecent && size() > target) {
    const removableLimit = groups.length - minimumRecent;
    const index = groups.findIndex((group, position) => position < removableLimit && !group.openToolCycle);
    if (index < 0) break;
    groups.splice(index, 1);
    dropped += 1;
  }

  return { values: [...fixed, ...groups.flatMap((group) => group.values)], dropped };
}

export function manageContext(input: {
  request: Request;
  model: ModelCard | null | undefined;
  defaultEnabled: boolean;
  aggressive?: boolean;
}): ContextManagementResult {
  const enabled = input.request.truncation !== "disabled"
    && (input.defaultEnabled || input.request.truncation === "auto" || input.request.contextManagement !== undefined);
  const limits = contextLimits(input.model);
  const common = {
    instructions: input.request.instructions,
    tools: input.request.tools,
    toolChoice: input.request.toolChoice,
    responseFormat: input.request.responseFormat,
  };
  const commonTokens = estimate(common);
  const originalMessages = input.request.messages;
  const originalItems = input.request.inputItems || [];
  const originalEstimatedTokens = commonTokens + Math.max(estimate(originalMessages), estimate(originalItems));

  if (!enabled || !limits) {
    return {
      request: input.request,
      enabled,
      compacted: false,
      originalEstimatedTokens,
      effectiveEstimatedTokens: originalEstimatedTokens,
      droppedMessageGroups: 0,
      droppedItemGroups: 0,
    };
  }

  const requestedOutput = positive(input.request.maxTokens);
  const outputReserve = requestedOutput ?? Math.min(limits.output ?? DEFAULT_OUTPUT_RESERVE, DEFAULT_OUTPUT_RESERVE);
  const hardTarget = Math.max(1, limits.input - outputReserve - STRUCTURAL_RESERVE);
  const targetTokens = input.aggressive ? Math.max(1, Math.floor(hardTarget * 0.75)) : hardTarget;
  if (originalEstimatedTokens <= targetTokens) {
    return {
      request: input.request,
      enabled,
      compacted: false,
      originalEstimatedTokens,
      effectiveEstimatedTokens: originalEstimatedTokens,
      droppedMessageGroups: 0,
      droppedItemGroups: 0,
      targetTokens,
    };
  }

  const minimumRecent = input.aggressive ? 1 : 2;
  const messages = messageGroups(originalMessages);
  const items = itemGroups(originalItems);
  const compactedMessages = compactGroups(messages.fixed, messages.groups, targetTokens, commonTokens, minimumRecent);
  const compactedItems = compactGroups(items.fixed, items.groups, targetTokens, commonTokens, minimumRecent);
  const request: Request = {
    ...input.request,
    messages: compactedMessages.values,
    ...(input.request.inputItems ? { inputItems: compactedItems.values } : {}),
  };
  const effectiveEstimatedTokens = commonTokens + Math.max(estimate(request.messages), estimate(request.inputItems || []));
  return {
    request,
    enabled,
    compacted: compactedMessages.dropped > 0 || compactedItems.dropped > 0,
    originalEstimatedTokens,
    effectiveEstimatedTokens,
    droppedMessageGroups: compactedMessages.dropped,
    droppedItemGroups: compactedItems.dropped,
    targetTokens,
  };
}

export function isContextOverflowError(error: unknown): boolean {
  const source = record(error);
  const code = typeof source?.code === "string" ? source.code.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  return code === "context_length_exceeded"
    || code === "model_context_window_exceeded"
    || message.includes("context_length_exceeded")
    || message.includes("exceeds the context window")
    || message.includes("maximum context length")
    || message.includes("prompt is too long")
    || message.includes("too many tokens")
    || message.includes("token limit exceeded");
}
