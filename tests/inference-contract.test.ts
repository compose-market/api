import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  toChatStreamEvent,
  toChatUsageStreamEvent,
  toResponsesStreamEvent,
  type Event,
  type Usage,
} from "../inference/core.js";
import {
  buildBodyChat,
  buildBodyResponses,
  mapMessagesForResponsesWire,
} from "../inference/catalog/families/openai.js";

test("chat normalization accepts the runtime model bridge wire shape", () => {
  const body = {
    model: "gpt-5.2-pro",
    stream: false,
    messages: [
      { role: "user", content: "Get ETH price" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "price.lookup",
            arguments: "{\"symbol\":\"ETH\"}",
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "price.lookup",
        content: "{\"usd\":3200}",
      },
    ],
    tools: [{
      type: "function",
      function: {
        name: "price.lookup",
        description: "Lookup a price",
        parameters: {
          type: "object",
          properties: { symbol: { type: "string" } },
          required: ["symbol"],
        },
      },
    }],
  };

  const request = normalizeChatRequest(body);

  assert.equal(request.model, "gpt-5.2-pro");
  assert.equal(request.stream, false);
  assert.equal(request.modality, "text");
  assert.equal(request.messages[1]?.tool_calls?.[0]?.function.name, "price.lookup");
  assert.equal(request.messages[2]?.tool_call_id, "call_1");
  assert.equal(request.tools?.[0]?.parameters?.type, "object");
});

test("chat normalization keeps the existing conservative passthrough shape", () => {
  const request = normalizeChatRequest({
    model: "test-model",
    stream: true,
    max_tokens: 32000,
    promptCacheKey: "ses_test",
    reasoning_effort: "medium",
    verbosity: "low",
    stream_options: { include_usage: true },
    messages: [
      { role: "user", content: "Inspect the repository." },
    ],
  });

  assert.equal(request.stream, true);
  assert.equal(request.customParams?.prompt_cache_key, "ses_test");
  assert.equal(request.customParams?.reasoning_effort, "medium");
  assert.deepEqual(request.customParams?.text, { verbosity: "low" });
  assert.equal("verbosity" in (request.customParams || {}), false);
  assert.deepEqual(request.customParams?.stream_options, { include_usage: true });
});

test("responses normalization maps verbosity into Responses text config", () => {
  const request = normalizeResponsesRequest({
    model: "test-model",
    input: "Inspect the repository.",
    verbosity: "low",
  });

  assert.deepEqual(request.customParams?.text, { verbosity: "low" });
  assert.equal("verbosity" in (request.customParams || {}), false);
});

test("OpenAI chat wire lowering keeps Responses-only text config out of chat bodies", () => {
  const body = buildBodyChat("gpt-5.5", [{ role: "user", content: "Say ok." }], {
    maxTokens: 8,
    maxTokensField: "max_completion_tokens",
    customParams: {
      text: { verbosity: "low" },
      verbosity: "low",
      max_tokens: 9,
      reasoning_effort: "low",
    },
  });

  assert.equal(body.max_completion_tokens, 8);
  assert.equal("max_tokens" in body, false);
  assert.equal("text" in body, false);
  assert.equal("verbosity" in body, false);
  assert.equal(body.reasoning_effort, "low");
});

test("unsafe seed values never reach OpenAI-compatible provider bodies", () => {
  assert.throws(() => normalizeResponsesRequest({
    model: "deepinfra/google/gemma-3-27b-it",
    input: "Hello",
    seed: "-9223372036854775808",
  }), /seed must be a safe integer/);

  assert.throws(() => normalizeResponsesRequest({
    model: "deepinfra/google/gemma-3-27b-it",
    input: "Hello",
    custom_params: { seed: -9223372036854776000 },
  }), /seed must be a safe integer/);

  assert.throws(() => buildBodyChat("google/gemma-3-27b-it", [{ role: "user", content: "Hello" }], {
    customParams: { seed: -9223372036854776000 },
  }), /seed must be a safe integer/);

  const safe = normalizeResponsesRequest({
    model: "deepinfra/google/gemma-3-27b-it",
    input: "Hello",
    seed: "42",
  });
  assert.equal(safe.customParams?.seed, 42);
});

test("OpenAI Responses wire lowering maps chat tools and reasoning", () => {
  const input = mapMessagesForResponsesWire([
    { role: "user", content: "Deploy." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "deploy",
          arguments: "{\"target\":\"staging\"}",
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      name: "deploy",
      content: "{\"ok\":true}",
    },
  ]);
  const body = buildBodyResponses("gpt-5.5", input, {
    maxOutputTokens: 8,
    tools: [{
      type: "function",
      name: "deploy",
      description: "Deploy a target",
      parameters: { type: "object", properties: { target: { type: "string" } } },
    }],
    toolChoice: { type: "function", name: "deploy" },
    customParams: {
      reasoning_effort: "low",
      stream_options: { include_usage: true, include_obfuscation: false },
      text: { verbosity: "low" },
      max_tokens: 9,
    },
    stream: true,
  });

  assert.equal(body.model, "gpt-5.5");
  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "deploy",
    arguments: "{\"target\":\"staging\"}",
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: "{\"ok\":true}",
  });
  assert.equal((body.tools as any[])[0].name, "deploy");
  assert.deepEqual(body.tool_choice, { type: "function", name: "deploy" });
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.deepEqual(body.text, { verbosity: "low" });
  assert.deepEqual(body.stream_options, { include_obfuscation: false });
  assert.equal("reasoning_effort" in body, false);
  assert.equal("max_tokens" in body, false);
  assert.equal("include_usage" in ((body.stream_options as Record<string, unknown>) || {}), false);
});

test("OpenAI adapter routes chat tools with reasoning through Responses", async () => {
  const original = globalThis.fetch;
  let url = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "deploy",
        arguments: "{\"target\":\"prod\"}",
      }],
      usage: {
        input_tokens: 11,
        output_tokens: 5,
        total_tokens: 16,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const { generateWithTools } = await import("../inference/catalog/adapter.js");
    const request = normalizeChatRequest({
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "Deploy." }],
      reasoning_effort: "low",
      tools: [{
        type: "function",
        function: {
          name: "deploy",
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    const result = await generateWithTools(request, { provider: "openai", modelId: "gpt-5.5" });

    assert.ok(url.endsWith("/responses"));
    assert.equal(body.model, "gpt-5.5");
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal("reasoning_effort" in body, false);
    assert.equal((body.tools as any[])[0].name, "deploy");
    assert.equal(result.output.toolCalls?.[0]?.name, "deploy");
    assert.equal(result.output.toolCalls?.[0]?.itemId, "fc_1");
    assert.equal(result.output.toolCalls?.[0]?.callId, "call_1");
    assert.equal(result.output.toolCalls?.[0]?.outputIndex, 0);
    assert.deepEqual(result.output.outputItems, [{
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "deploy",
      arguments: "{\"target\":\"prod\"}",
    }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI adapter accepts response.completed followed by EOF without DONE", async () => {
  const original = globalThis.fetch;
  let url = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    const stream = [
      "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"deploy\",\"arguments\":\"\"}}\n\n",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"item_id\":\"fc_1\",\"delta\":\"{\\\"target\\\"\"}\n\n",
      "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"item_id\":\"fc_1\",\"name\":\"deploy\",\"arguments\":\"{\\\"target\\\":\\\"prod\\\"}\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"deploy\",\"arguments\":\"{\\\"target\\\":\\\"prod\\\"}\"}],\"usage\":{\"input_tokens\":11,\"output_tokens\":5,\"total_tokens\":16}}}\n\n",
    ].join("");
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const { streamWithTools } = await import("../inference/catalog/adapter.js");
    const request = normalizeChatRequest({
      model: "openai/gpt-5.5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Deploy." }],
      reasoning_effort: "low",
      tools: [{
        type: "function",
        function: {
          name: "deploy",
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    const events: Event[] = [];
    for await (const event of streamWithTools(request, { provider: "openai", modelId: "gpt-5.5" })) {
      events.push(event);
    }

    assert.ok(url.endsWith("/responses"));
    assert.equal(body.stream, true);
    assert.equal("include_usage" in (((body.stream_options as Record<string, unknown>) || {})), false);
    const delta = events.find((event) => event.type === "tool-call-delta")?.toolCallDelta;
    assert.equal(delta?.itemId, "fc_1");
    assert.equal(delta?.callId, "call_1");
    const call = events.find((event) => event.type === "tool-call")?.toolCall;
    assert.equal(call?.name, "deploy");
    assert.equal(call?.itemId, "fc_1");
    assert.equal(call?.callId, "call_1");
    assert.equal(call?.index, 0);
    assert.deepEqual(events.find((event) => event.type === "output-item")?.item, {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "deploy",
      arguments: "{\"target\":\"prod\"}",
    });
    assert.equal(events.at(-1)?.finishReason, "tool-calls");
    assert.equal(events.at(-1)?.usage?.totalTokens, 16);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI Responses adapter sends exact native continuation items", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return Response.json({ status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;

  try {
    const { generateWithTools } = await import("../inference/catalog/adapter.js");
    const input = [
      {
        id: "rs_1",
        type: "reasoning",
        summary: [],
        encrypted_content: "opaque-reasoning",
      },
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{\"query\":\"alpha\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "alpha result",
      },
    ];
    const request = normalizeResponsesRequest({
      model: "openai/gpt-4.1",
      input,
    });

    await generateWithTools(request, { provider: "openai", modelId: "gpt-4.1" });

    assert.deepEqual(body.input, input);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI Responses adapter canonicalizes OpenCode text aliases before upstream fetch", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return Response.json({ status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;

  try {
    const { generateWithTools } = await import("../inference/catalog/adapter.js");
    const request = normalizeResponsesRequest({
      model: "openai/gpt-4.1",
      input: [
        { role: "user", content: [{ type: "text", text: "Inspect this repository." }] },
        { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
      ],
    });

    await generateWithTools(request, { provider: "openai", modelId: "gpt-4.1" });

    assert.deepEqual(body.input, [
      { role: "user", content: [{ type: "input_text", text: "Inspect this repository." }] },
      { role: "assistant", content: [{ type: "output_text", text: "I will inspect it." }] },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("chat stream conversion emits the chunks runtime normalizes", () => {
  const toolDelta: Event = {
    type: "tool-call-delta",
    toolCallDelta: {
      id: "call_1",
      name: "price.lookup",
      arguments: "{\"symbol\"",
      index: 0,
    },
  };
  const usage: Usage = {
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
  };

  const textChunk = toChatStreamEvent("resp_1", "gpt-5.2-pro", { type: "text-delta", text: "hel" }, true);
  const toolChunk = toChatStreamEvent("resp_1", "gpt-5.2-pro", toolDelta);
  const usageChunk = toChatUsageStreamEvent("resp_1", "gpt-5.2-pro", usage);

  assert.deepEqual((textChunk.choices as any[])[0].delta, { role: "assistant", content: "hel" });
  assert.deepEqual((toolChunk.choices as any[])[0].delta.tool_calls[0], {
    index: 0,
    id: "call_1",
    type: "function",
    function: {
      name: "price.lookup",
      arguments: "{\"symbol\"",
    },
  });
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
});

test("responses stream conversion preserves rich modality events", () => {
  assert.deepEqual(toResponsesStreamEvent("resp_2", "gemini-3", {
    type: "reasoning-delta",
    itemId: "rs_1",
    outputIndex: 0,
    text: "thought",
  }), {
    type: "response.reasoning_summary_text.delta",
    response_id: "resp_2",
    item_id: "rs_1",
    output_index: 0,
    summary_index: 0,
    delta: "thought",
  });

  assert.deepEqual(toResponsesStreamEvent("resp_2", "rerank-2.5", {
    type: "citation",
    citation: { title: "Doc", url: "https://example.test" },
  }), {
    type: "response.citation",
    response_id: "resp_2",
    model: "rerank-2.5",
    citation: { title: "Doc", url: "https://example.test" },
  });

  assert.deepEqual(toResponsesStreamEvent("resp_2", "speech", {
    type: "audio-chunk",
    audio: { base64: "AAA", sequenceIndex: 2, mimeType: "audio/mpeg" },
  }), {
    type: "response.output_audio.delta",
    response_id: "resp_2",
    model: "speech",
    delta: "AAA",
    sequence_index: 2,
    mime_type: "audio/mpeg",
  });

  assert.deepEqual(toResponsesStreamEvent("resp_2", "veo", {
    type: "video-complete",
    video: { jobId: "job_1", url: "https://example.test/video.mp4", status: "completed", progress: 100, mimeType: "video/mp4" },
  }), {
    type: "response.output_item.done",
    response_id: "resp_2",
    output_index: 0,
    item: {
      type: "output_video",
      role: "assistant",
      video_url: "https://example.test/video.mp4",
      job_id: "job_1",
      status: "completed",
      progress: 100,
      mime_type: "video/mp4",
    },
  });
});

test("image preview sequence is separate from stable output identity", () => {
  const partial = toResponsesStreamEvent("resp_image", "gpt-image-2", {
    type: "image-partial",
    outputIndex: 0,
    image: { base64: "AAA", index: 2 },
  });
  assert.equal(partial.output_index, 0);
  assert.equal(partial.partial_image_index, 2);

  const completed = toResponsesStreamEvent("resp_image", "gpt-image-2", {
    type: "image-complete",
    outputIndex: 0,
    image: { base64: "BBB" },
  });
  assert.equal(completed.output_index, 0);
});
