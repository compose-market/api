import { randomUUID } from "node:crypto";

import type { Call, Event, Usage } from "./core.js";

export type JsonSchema = Record<string, unknown>;

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: JsonSchema;
  strict?: boolean;
}

export type ResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string };

export type ResponsesInputItem = Record<string, unknown>;

export interface ResponsesOutputItem extends Record<string, unknown> {
  id?: string;
  type: string;
  status?: string;
  role?: "assistant";
  call_id?: string;
  name?: string;
  arguments?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeResponsesTools(value: unknown): ResponsesFunctionTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: ResponsesFunctionTool[] = [];
  for (const raw of value) {
    const tool = object(raw);
    if (tool?.type !== "function") continue;
    const name = nonEmpty(tool.name);
    if (!name) continue;
    tools.push({
      type: "function",
      name,
      ...(nonEmpty(tool.description) ? { description: tool.description as string } : {}),
      ...(object(tool.parameters) ? { parameters: tool.parameters as JsonSchema } : {}),
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function normalizeChatTools(value: unknown): ResponsesFunctionTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: ResponsesFunctionTool[] = [];
  for (const raw of value) {
    const tool = object(raw);
    const fn = object(tool?.function);
    if (tool?.type !== "function" || !fn) continue;
    const name = nonEmpty(fn.name);
    if (!name) continue;
    tools.push({
      type: "function",
      name,
      ...(nonEmpty(fn.description) ? { description: fn.description as string } : {}),
      ...(object(fn.parameters) ? { parameters: fn.parameters as JsonSchema } : {}),
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function normalizeResponsesToolChoice(value: unknown): ResponsesToolChoice | undefined {
  if (value === "none" || value === "auto" || value === "required") return value;
  const choice = object(value);
  const name = nonEmpty(choice?.name);
  return choice?.type === "function" && name ? { type: "function", name } : undefined;
}

export function normalizeChatToolChoice(value: unknown): ResponsesToolChoice | undefined {
  if (value === "none" || value === "auto" || value === "required") return value;
  const choice = object(value);
  const fn = object(choice?.function);
  const name = nonEmpty(fn?.name);
  return choice?.type === "function" && name ? { type: "function", name } : undefined;
}

function generatedId(prefix: "msg" | "rs" | "fc" | "call"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

interface PendingCall {
  itemId: string;
  callId: string;
  outputIndex: number;
  name: string;
  arguments: string;
  providerMetadata?: Record<string, unknown>;
  added: boolean;
  completed: boolean;
}

interface PendingText {
  itemId: string;
  outputIndex: number;
  text: string;
  added: boolean;
  completed: boolean;
}

interface PendingReasoning {
  itemId: string;
  outputIndex: number;
  text: string;
  added: boolean;
  completed: boolean;
}

function responseUsage(usage: Usage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedInputTokens ?? 0,
    },
    output_tokens_details: {
      reasoning_tokens: usage.reasoningTokens ?? 0,
    },
  };
}

/** Stateful OpenAI Responses event renderer. One instance owns one response. */
export class ResponsesStreamEncoder {
  readonly responseId: string;
  readonly model: string;
  readonly createdAt: number;
  private started = false;
  private completed = false;
  private readonly pendingCalls = new Map<number, PendingCall>();
  private readonly texts = new Map<number, PendingText>();
  private readonly reasonings = new Map<number, PendingReasoning>();
  private readonly outputItems = new Map<number, ResponsesOutputItem>();

  constructor(responseId: string, model: string, createdAt = Math.floor(Date.now() / 1000)) {
    this.responseId = responseId;
    this.model = model;
    this.createdAt = createdAt;
  }

  private response(
    status: "in_progress" | "completed" | "incomplete" | "failed",
    usage?: Usage,
    error?: Event["error"],
  ): Record<string, unknown> {
    const output = [...this.outputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      ...(responseUsage(usage) ? { usage: responseUsage(usage) } : {}),
      ...(error ? { error } : {}),
    };
  }

  private start(): Array<Record<string, unknown>> {
    if (this.started) return [];
    this.started = true;
    const response = this.response("in_progress");
    return [
      { type: "response.created", response },
      { type: "response.in_progress", response },
    ];
  }

  private ensureCall(input: {
    index: number;
    itemId?: string;
    callId?: string;
    legacyId?: string;
    name?: string;
    providerMetadata?: Record<string, unknown>;
  }): PendingCall {
    const current = this.pendingCalls.get(input.index);
    if (current) {
      if (input.name) current.name = input.name;
      if (input.providerMetadata) current.providerMetadata = input.providerMetadata;
      return current;
    }
    const call: PendingCall = {
      itemId: input.itemId || generatedId("fc"),
      callId: input.callId || input.legacyId || generatedId("call"),
      outputIndex: this.claimOutputIndex(input.index),
      name: input.name || "",
      arguments: "",
      ...(input.providerMetadata ? { providerMetadata: input.providerMetadata } : {}),
      added: false,
      completed: false,
    };
    this.pendingCalls.set(input.index, call);
    return call;
  }

  private claimOutputIndex(preferred?: number): number {
    if (
      typeof preferred === "number"
      && preferred >= 0
      && !this.outputItems.has(preferred)
    ) {
      return preferred;
    }
    let index = 0;
    while (this.outputItems.has(index)) index += 1;
    return index;
  }

  private ensureText(event: Event): PendingText {
    const sourceIndex = event.outputIndex ?? -1;
    const current = this.texts.get(sourceIndex);
    if (current) return current;
    const text: PendingText = {
      itemId: event.itemId || generatedId("msg"),
      outputIndex: this.claimOutputIndex(event.outputIndex),
      text: "",
      added: false,
      completed: false,
    };
    this.texts.set(sourceIndex, text);
    return text;
  }

  private ensureReasoning(event: Event): PendingReasoning {
    const sourceIndex = event.outputIndex ?? -1;
    const current = this.reasonings.get(sourceIndex);
    if (current) return current;
    const reasoning: PendingReasoning = {
      itemId: event.itemId || generatedId("rs"),
      outputIndex: this.claimOutputIndex(event.outputIndex),
      text: "",
      added: false,
      completed: false,
    };
    this.reasonings.set(sourceIndex, reasoning);
    return reasoning;
  }

  private addText(text: PendingText): Array<Record<string, unknown>> {
    if (text.added) return [];
    text.added = true;
    const item: ResponsesOutputItem = {
      id: text.itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    this.outputItems.set(text.outputIndex, item);
    return [
      {
        type: "response.output_item.added",
        response_id: this.responseId,
        output_index: text.outputIndex,
        item,
      },
      {
        type: "response.content_part.added",
        response_id: this.responseId,
        item_id: text.itemId,
        output_index: text.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    ];
  }

  private finishText(text: PendingText): Array<Record<string, unknown>> {
    if (text.completed) return [];
    text.completed = true;
    const part = { type: "output_text", text: text.text, annotations: [] };
    const item: ResponsesOutputItem = {
      id: text.itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    this.outputItems.set(text.outputIndex, item);
    return [
      {
        type: "response.output_text.done",
        response_id: this.responseId,
        item_id: text.itemId,
        output_index: text.outputIndex,
        content_index: 0,
        text: text.text,
      },
      {
        type: "response.content_part.done",
        response_id: this.responseId,
        item_id: text.itemId,
        output_index: text.outputIndex,
        content_index: 0,
        part,
      },
      {
        type: "response.output_item.done",
        response_id: this.responseId,
        output_index: text.outputIndex,
        item,
      },
    ];
  }

  private addReasoning(reasoning: PendingReasoning): Array<Record<string, unknown>> {
    if (reasoning.added) return [];
    reasoning.added = true;
    const item: ResponsesOutputItem = {
      id: reasoning.itemId,
      type: "reasoning",
      status: "in_progress",
      summary: [],
    };
    this.outputItems.set(reasoning.outputIndex, item);
    return [
      {
        type: "response.output_item.added",
        response_id: this.responseId,
        output_index: reasoning.outputIndex,
        item,
      },
      {
        type: "response.reasoning_summary_part.added",
        response_id: this.responseId,
        item_id: reasoning.itemId,
        output_index: reasoning.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
    ];
  }

  private finishReasoning(reasoning: PendingReasoning): Array<Record<string, unknown>> {
    if (reasoning.completed) return [];
    reasoning.completed = true;
    const part = { type: "summary_text", text: reasoning.text };
    const item: ResponsesOutputItem = {
      id: reasoning.itemId,
      type: "reasoning",
      status: "completed",
      summary: [part],
    };
    this.outputItems.set(reasoning.outputIndex, item);
    return [
      {
        type: "response.reasoning_summary_text.done",
        response_id: this.responseId,
        item_id: reasoning.itemId,
        output_index: reasoning.outputIndex,
        summary_index: 0,
        text: reasoning.text,
      },
      {
        type: "response.reasoning_summary_part.done",
        response_id: this.responseId,
        item_id: reasoning.itemId,
        output_index: reasoning.outputIndex,
        summary_index: 0,
        part,
      },
      {
        type: "response.output_item.done",
        response_id: this.responseId,
        output_index: reasoning.outputIndex,
        item,
      },
    ];
  }

  private added(call: PendingCall): Array<Record<string, unknown>> {
    if (call.added) return [];
    call.added = true;
    const item: ResponsesOutputItem = {
      id: call.itemId,
      type: "function_call",
      status: "in_progress",
      call_id: call.callId,
      name: call.name,
      arguments: "",
    };
    this.outputItems.set(call.outputIndex, item);
    return [{
      type: "response.output_item.added",
      response_id: this.responseId,
      output_index: call.outputIndex,
      item,
    }];
  }

  private finishCall(call: PendingCall): Array<Record<string, unknown>> {
    if (call.completed) return [];
    call.completed = true;
    const item: ResponsesOutputItem = {
      id: call.itemId,
      type: "function_call",
      status: "completed",
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments || "{}",
    };
    this.outputItems.set(call.outputIndex, item);
    return [
      {
        type: "response.function_call_arguments.done",
        response_id: this.responseId,
        item_id: call.itemId,
        output_index: call.outputIndex,
        name: call.name,
        arguments: item.arguments,
      },
      {
        type: "response.output_item.done",
        response_id: this.responseId,
        output_index: call.outputIndex,
        item,
      },
    ];
  }

  push(event: Event): Array<Record<string, unknown>> {
    if (this.completed) return [];
    const events = this.start();
    if (event.type === "created") return events;

    if (event.type === "text-delta") {
      const text = this.ensureText(event);
      events.push(...this.addText(text));
      const delta = event.text || "";
      text.text += delta;
      if (delta) {
        events.push({
          type: "response.output_text.delta",
          response_id: this.responseId,
          item_id: text.itemId,
          output_index: text.outputIndex,
          content_index: 0,
          delta,
        });
      }
      return events;
    }

    if (event.type === "thinking" || event.type === "reasoning-delta") {
      const reasoning = this.ensureReasoning(event);
      events.push(...this.addReasoning(reasoning));
      const delta = event.thinking || event.text || "";
      reasoning.text += delta;
      if (delta) {
        events.push({
          type: "response.reasoning_summary_text.delta",
          response_id: this.responseId,
          item_id: reasoning.itemId,
          output_index: reasoning.outputIndex,
          summary_index: 0,
          delta,
        });
      }
      return events;
    }

    if (event.type === "tool-call-delta" && event.toolCallDelta) {
      const delta = event.toolCallDelta;
      const call = this.ensureCall({
        index: delta.index,
        itemId: delta.itemId,
        callId: delta.callId,
        legacyId: delta.id,
        name: delta.name,
      });
      events.push(...this.added(call));
      if (delta.arguments) call.arguments += delta.arguments;
      if (delta.arguments) {
        events.push({
          type: "response.function_call_arguments.delta",
          response_id: this.responseId,
          item_id: call.itemId,
          output_index: call.outputIndex,
          delta: delta.arguments,
        });
      }
      return events;
    }

    if (event.type === "tool-call" && event.toolCall) {
      const toolCall = event.toolCall;
      const index = toolCall.index ?? event.outputIndex ?? 0;
      const call = this.ensureCall({
        index,
        itemId: toolCall.itemId,
        callId: toolCall.callId,
        legacyId: toolCall.id,
        name: toolCall.name,
        providerMetadata: toolCall.providerMetadata,
      });
      events.push(...this.added(call));
      call.name = toolCall.name || call.name;
      call.arguments = toolCall.arguments || call.arguments || "{}";
      events.push(...this.finishCall(call));
      return events;
    }

    if (event.type === "output-item" && event.item) {
      if (
        typeof event.outputIndex === "number"
        && this.outputItems.has(event.outputIndex)
      ) {
        this.outputItems.set(event.outputIndex, { ...event.item });
        return events;
      }
      const outputIndex = this.claimOutputIndex(event.outputIndex);
      const completedItem: ResponsesOutputItem = {
        ...event.item,
        ...(event.item.status ? { status: "completed" } : {}),
      };
      const addedItem: ResponsesOutputItem = {
        ...event.item,
        ...(event.item.status ? { status: "in_progress" } : {}),
      };
      this.outputItems.set(outputIndex, completedItem);
      events.push(
        {
          type: "response.output_item.added",
          response_id: this.responseId,
          output_index: outputIndex,
          item: addedItem,
        },
        {
          type: "response.output_item.done",
          response_id: this.responseId,
          output_index: outputIndex,
          item: completedItem,
        },
      );
      return events;
    }

    if (event.type === "error") {
      this.completed = true;
      events.push({
        type: "response.failed",
        response: this.response(
          "failed",
          event.usage,
          event.error || { code: "upstream_error", message: "Inference failed" },
        ),
      });
      return events;
    }

    if (event.type === "done") {
      const pending = [
        ...[...this.pendingCalls.values()].map((value) => ({
          outputIndex: value.outputIndex,
          finish: () => this.finishCall(value),
        })),
        ...[...this.reasonings.values()].map((value) => ({
          outputIndex: value.outputIndex,
          finish: () => this.finishReasoning(value),
        })),
        ...[...this.texts.values()].map((value) => ({
          outputIndex: value.outputIndex,
          finish: () => this.finishText(value),
        })),
      ].sort((left, right) => left.outputIndex - right.outputIndex);
      for (const item of pending) {
        events.push(...item.finish());
      }
      this.completed = true;
      const incomplete = event.finishReason === "length";
      events.push({
        type: incomplete ? "response.incomplete" : "response.completed",
        response: this.response(incomplete ? "incomplete" : "completed", event.usage),
      });
      return events;
    }

    return events;
  }

  items(): ResponsesOutputItem[] {
    return [...this.outputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  }

  calls(): Call[] {
    return [...this.pendingCalls.values()]
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map((call) => ({
        id: call.callId,
        itemId: call.itemId,
        callId: call.callId,
        outputIndex: call.outputIndex,
        name: call.name,
        arguments: call.arguments || "{}",
        ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
      }));
  }
}
