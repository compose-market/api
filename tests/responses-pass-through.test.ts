import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import {
  getModelProtocolProfile,
  resolveModel,
} from "../inference/catalog/registry.js";
import {
  normalizeResponsesRequest,
  toResponsesOutputItems,
  validateParallelToolCalls,
  type Event,
} from "../inference/core.js";
import { shape } from "../inference/external.js";
import {
  normalizeResponsesTools,
  normalizeResponsesToolChoice,
  ResponsesStreamEncoder,
} from "../inference/responses.js";

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("catalog protocol profiles derive text, tools, and parallel calls from compiled semantics", () => {
  const toolModel = resolveModel("gpt-4.1").card;
  assert.ok(toolModel);

  const toolProfile = getModelProtocolProfile(toolModel);
  assert.equal(toolProfile.interactiveText, true);
  assert.equal(toolProfile.toolCalls, true);
  assert.equal(toolProfile.parallelToolCalls, true);
  assert.deepEqual(toolProfile.inputModalities, ["image", "text"]);
  assert.deepEqual(toolProfile.outputModalities, ["text"]);

  const embeddingModel = resolveModel("openai/text-embedding-3-large").card;
  assert.ok(embeddingModel);

  const embeddingProfile = getModelProtocolProfile(embeddingModel);
  assert.equal(embeddingProfile.interactiveText, false);
  assert.equal(embeddingProfile.toolCalls, false);
  assert.equal(embeddingProfile.parallelToolCalls, false);
});

test("external Responses shaping preserves official semantic SSE frames", async () => {
  const app = express();
  app.get("/stream", shape("responses"), (_req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"type":"response.created","response":{"id":"resp_1","output":[]}}\n\n');
    res.write('data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"hello"}\n\n');
    res.write('data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n');
    res.end();
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/stream`);
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /response\.created/);
    assert.match(stream, /response\.output_text\.delta/);
    assert.match(stream, /response\.completed/);
    const sequence = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { sequence_number?: number })
      .map((event) => event.sequence_number);
    assert.deepEqual(sequence, [0, 1, 2]);
  });
});

test("external Responses shaping emits protocol-native sequenced errors", async () => {
  const app = express();
  app.get("/stream", shape("responses"), (_req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.write('event: compose.error\ndata: {"code":"context_length_exceeded","message":"too long"}\n\n');
    res.end();
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/stream`);
    const stream = await response.text();
    const line = stream.split("\n").find((value) => value.startsWith("data: "));
    assert.ok(line);
    assert.deepEqual(JSON.parse(line.slice(6)), {
      type: "error",
      sequence_number: 0,
      code: "context_length_exceeded",
      message: "too long",
      param: null,
    });
  });
});

test("Responses normalization preserves native items, flat tools, and flat tool choice", () => {
  const input = [
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Need both sources." }],
      encrypted_content: "encrypted_1",
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: "{\"query\":\"alpha\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "alpha result",
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue." }],
    },
  ];
  const request = normalizeResponsesRequest({
    model: "gpt-4.1",
    input,
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up one value",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      strict: true,
    }],
    tool_choice: { type: "function", name: "lookup" },
    parallel_tool_calls: true,
  });

  assert.deepEqual(request.inputItems, input);
  assert.deepEqual(request.tools, [{
    type: "function",
    name: "lookup",
    description: "Look up one value",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    strict: true,
  }]);
  assert.deepEqual(request.toolChoice, { type: "function", name: "lookup" });
  assert.equal(request.customParams?.parallel_tool_calls, true);
  assert.equal(request.messages[0]?.role, "assistant");
  assert.equal(request.messages[0]?.tool_calls?.[0]?.id, "call_1");
  assert.equal(request.messages[1]?.role, "tool");
  assert.equal(request.messages[1]?.tool_call_id, "call_1");
  assert.equal(request.messages[2]?.role, "user");
});

test("OpenCode Responses text content parts are lowered to input_text before provider pass-through", () => {
  const request = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect this repository." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will inspect it." }],
      },
    ],
  });

  assert.deepEqual(request.inputItems, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Inspect this repository." }],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "I will inspect it." }],
    },
  ]);
});

test("parallel_tool_calls is rejected when compiled model semantics do not support it", () => {
  const unsupported = normalizeResponsesRequest({
    model: "gpt-5.4",
    input: "Use tools.",
    parallel_tool_calls: true,
  });
  assert.throws(
    () => validateParallelToolCalls(unsupported),
    (error: unknown) => {
      const value = error as { statusCode?: number; code?: string };
      return value.statusCode === 400 && value.code === "unsupported_parallel_tool_calls";
    },
  );

  const supported = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: "Use tools.",
    parallel_tool_calls: true,
  });
  assert.doesNotThrow(() => validateParallelToolCalls(supported));
});

test("Responses output uses official function_call items with separate stable IDs", () => {
  const output = toResponsesOutputItems({
    modality: "text",
    finishReason: "tool-calls",
    toolCalls: [
      {
        itemId: "fc_weather",
        callId: "call_weather",
        outputIndex: 0,
        name: "weather",
        arguments: "{\"city\":\"Rome\"}",
        providerMetadata: { google: { thoughtSignature: "private" } },
      },
      {
        itemId: "fc_time",
        callId: "call_time",
        outputIndex: 1,
        name: "time",
        arguments: "{\"city\":\"Tokyo\"}",
      },
    ],
  });

  assert.deepEqual(output, [
    {
      id: "fc_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "weather",
      arguments: "{\"city\":\"Rome\"}",
    },
    {
      id: "fc_time",
      type: "function_call",
      status: "completed",
      call_id: "call_time",
      name: "time",
      arguments: "{\"city\":\"Tokyo\"}",
    },
  ]);
});

test("Responses stream encoder preserves two interleaved calls and completes with full output", () => {
  const encoder = new ResponsesStreamEncoder("resp_parallel", "gpt-4.1");
  const source: Event[] = [
    { type: "created" },
    {
      type: "tool-call-delta",
      toolCallDelta: {
        itemId: "fc_weather",
        callId: "call_weather",
        id: "call_weather",
        index: 0,
        name: "weather",
        arguments: "{\"city\":",
      },
    },
    {
      type: "tool-call-delta",
      toolCallDelta: {
        itemId: "fc_time",
        callId: "call_time",
        id: "call_time",
        index: 1,
        name: "time",
        arguments: "{\"city\":",
      },
    },
    {
      type: "tool-call-delta",
      toolCallDelta: { index: 0, arguments: "\"Rome\"}" },
    },
    {
      type: "tool-call-delta",
      toolCallDelta: { index: 1, arguments: "\"Tokyo\"}" },
    },
    {
      type: "tool-call",
      toolCall: {
        itemId: "fc_weather",
        callId: "call_weather",
        id: "call_weather",
        index: 0,
        name: "weather",
        arguments: "{\"city\":\"Rome\"}",
        providerMetadata: { google: { thoughtSignature: "opaque-weather" } },
      },
    },
    {
      type: "tool-call",
      toolCall: {
        itemId: "fc_time",
        callId: "call_time",
        id: "call_time",
        index: 1,
        name: "time",
        arguments: "{\"city\":\"Tokyo\"}",
      },
    },
    {
      type: "output-item",
      outputIndex: 0,
      item: {
        id: "fc_weather",
        type: "function_call",
        status: "completed",
        call_id: "call_weather",
        name: "weather",
        arguments: "{\"city\":\"Rome\"}",
      },
    },
    {
      type: "output-item",
      outputIndex: 1,
      item: {
        id: "fc_time",
        type: "function_call",
        status: "completed",
        call_id: "call_time",
        name: "time",
        arguments: "{\"city\":\"Tokyo\"}",
      },
    },
    {
      type: "done",
      finishReason: "tool-calls",
      usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
    },
  ];
  const events = source.flatMap((event) => encoder.push(event));

  assert.deepEqual(events.slice(0, 2).map((event) => event.type), [
    "response.created",
    "response.in_progress",
  ]);
  const added = events.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(added.map((event) => event.output_index), [0, 1]);
  assert.deepEqual(added.map((event) => (event.item as Record<string, unknown>).id), ["fc_weather", "fc_time"]);
  assert.deepEqual(added.map((event) => (event.item as Record<string, unknown>).call_id), ["call_weather", "call_time"]);

  const deltas = events.filter((event) => event.type === "response.function_call_arguments.delta");
  assert.deepEqual(deltas.map((event) => event.output_index), [0, 1, 0, 1]);
  assert.deepEqual(deltas.map((event) => event.item_id), ["fc_weather", "fc_time", "fc_weather", "fc_time"]);

  const completed = events.at(-1);
  assert.equal(completed?.type, "response.completed");
  const response = completed?.response as Record<string, unknown>;
  assert.deepEqual(response.output, [
    {
      id: "fc_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "weather",
      arguments: "{\"city\":\"Rome\"}",
    },
    {
      id: "fc_time",
      type: "function_call",
      status: "completed",
      call_id: "call_time",
      name: "time",
      arguments: "{\"city\":\"Tokyo\"}",
    },
  ]);
  assert.deepEqual(encoder.calls(), [
    {
      id: "call_weather",
      itemId: "fc_weather",
      callId: "call_weather",
      outputIndex: 0,
      name: "weather",
      arguments: "{\"city\":\"Rome\"}",
      providerMetadata: { google: { thoughtSignature: "opaque-weather" } },
    },
    {
      id: "call_time",
      itemId: "fc_time",
      callId: "call_time",
      outputIndex: 1,
      name: "time",
      arguments: "{\"city\":\"Tokyo\"}",
    },
  ]);
});

test("Responses stream encoder emits official reasoning and text item lifecycles", () => {
  const encoder = new ResponsesStreamEncoder("resp_lifecycle", "gpt-4.1");
  const source: Event[] = [
    { type: "created" },
    { type: "reasoning-delta", itemId: "rs_plan", outputIndex: 0, text: "Need " },
    { type: "reasoning-delta", itemId: "rs_plan", outputIndex: 0, text: "tools." },
    { type: "text-delta", itemId: "msg_answer", outputIndex: 1, text: "Done." },
    {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9, reasoningTokens: 2 },
    },
  ];

  const events = source.flatMap((event) => encoder.push(event));

  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);

  const completed = events.at(-1)?.response as Record<string, unknown>;
  assert.deepEqual(completed.output, [
    {
      id: "rs_plan",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Need tools." }],
    },
    {
      id: "msg_answer",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    },
  ]);
  assert.deepEqual(completed.usage, {
    input_tokens: 5,
    output_tokens: 4,
    total_tokens: 9,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 2 },
  });
});

test("Responses stream encoder terminates failures with a full failed response", () => {
  const encoder = new ResponsesStreamEncoder("resp_failed", "gpt-4.1", 123);
  encoder.push({ type: "created" });

  const events = encoder.push({
    type: "error",
    error: { code: "upstream_error", message: "provider failed" },
  });

  assert.deepEqual(events, [{
    type: "response.failed",
    response: {
      id: "resp_failed",
      object: "response",
      created_at: 123,
      status: "failed",
      model: "gpt-4.1",
      output: [],
      error: { code: "upstream_error", message: "provider failed" },
    },
  }]);
  assert.deepEqual(encoder.push({ type: "done" }), []);
});

test("Responses stream encoder preserves completed native output items", () => {
  const encoder = new ResponsesStreamEncoder("resp_native", "gpt-4.1");
  encoder.push({ type: "created" });

  const events = encoder.push({
    type: "output-item",
    outputIndex: 3,
    item: {
      id: "rs_encrypted",
      type: "reasoning",
      status: "completed",
      summary: [],
      encrypted_content: "opaque-provider-state",
    },
  });
  const completed = encoder.push({ type: "done" }).at(-1)?.response as Record<string, unknown>;

  assert.deepEqual(events.map((event) => event.type), [
    "response.output_item.added",
    "response.output_item.done",
  ]);
  assert.deepEqual(completed.output, [{
    id: "rs_encrypted",
    type: "reasoning",
    status: "completed",
    summary: [],
    encrypted_content: "opaque-provider-state",
  }]);
});

test("normalizeResponsesTools accepts both flat Responses format and nested OpenAI tool format", () => {
  const flatTools = [
    {
      type: "function",
      name: "models_find",
      description: "Find models",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ];
  const nestedTools = [
    {
      type: "function",
      function: {
        name: "models_find",
        description: "Find models",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
  ];

  const normalizedFromFlat = normalizeResponsesTools(flatTools);
  const normalizedFromNested = normalizeResponsesTools(nestedTools);

  assert.deepEqual(normalizedFromFlat, [
    {
      type: "function",
      name: "models_find",
      description: "Find models",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ]);
  assert.deepEqual(normalizedFromNested, normalizedFromFlat);

  assert.deepEqual(normalizeResponsesToolChoice("required"), "required");
  assert.deepEqual(normalizeResponsesToolChoice({ type: "function", name: "models_find" }), {
    type: "function",
    name: "models_find",
  });
  assert.deepEqual(normalizeResponsesToolChoice({ type: "function", function: { name: "models_find" } }), {
    type: "function",
    name: "models_find",
  });
});

