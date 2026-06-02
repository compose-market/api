import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  toChatStreamEvent,
  toChatUsageStreamEvent,
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
  assert.equal(request.tools?.[0]?.function.parameters?.type, "object");
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
      function: {
        name: "deploy",
        description: "Deploy a target",
        parameters: { type: "object", properties: { target: { type: "string" } } },
      },
    }],
    toolChoice: { type: "function", function: { name: "deploy" } },
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
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI adapter streams chat tools with reasoning through Responses", async () => {
  const original = globalThis.fetch;
  let url = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    const stream = [
      "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"deploy\",\"arguments\":\"\"}}\n\n",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"item_id\":\"call_1\",\"delta\":\"{\\\"target\\\"\"}\n\n",
      "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"item_id\":\"call_1\",\"name\":\"deploy\",\"arguments\":\"{\\\"target\\\":\\\"prod\\\"}\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"deploy\",\"arguments\":\"{\\\"target\\\":\\\"prod\\\"}\"}],\"usage\":{\"input_tokens\":11,\"output_tokens\":5,\"total_tokens\":16}}}\n\n",
      "data: [DONE]\n\n",
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
    assert.equal(events.find((event) => event.type === "tool-call")?.toolCall?.name, "deploy");
    assert.equal(events.at(-1)?.finishReason, "tool-calls");
    assert.equal(events.at(-1)?.usage?.totalTokens, 16);
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
  });
});
