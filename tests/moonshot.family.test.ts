import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatBody,
  createStreamParser,
  mapMessages,
  parseChatResponse,
  protocolCapabilities,
} from "../inference/adapters/families/moonshot.js";
import { normalizeResponsesRequest } from "../inference/core.js";
import { getModelProtocolProfile, resolveModel } from "../inference/adapters/registry.js";
import { streamWithTools } from "../inference/adapters/adapter.js";

test("Moonshot family preserves reasoning and tool history", () => {
  const messages = mapMessages([{
    role: "assistant",
    content: "I will inspect it.",
    reasoning_content: "Need repository context.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "inspect", arguments: "{}" },
    }],
  }]);

  assert.deepEqual(messages, [{
    role: "assistant",
    content: "I will inspect it.",
    reasoning_content: "Need repository context.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "inspect", arguments: "{}" },
    }],
  }]);
});

test("Moonshot body maps Responses reasoning effort without leaking Responses shape", () => {
  const body = buildChatBody("wire-kimi", [{ role: "user", content: "Hello" }], {
    customParams: { reasoning: { effort: "high" }, prompt_cache_key: "session-1" },
  }, true);

  assert.equal(body.model, "wire-kimi");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.reasoning, undefined);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("Kimi K3 body removes unsupported sampling and completes tool reasoning history", () => {
  const body = buildChatBody("accounts/fireworks/models/kimi-k3", [{
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }],
  }], {
    temperature: 0.2,
    topP: 0.5,
    toolChoice: "required",
    customParams: { reasoning_effort: "high", thinking: { type: "enabled" }, presence_penalty: 1 },
  }, true);
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(body.presence_penalty, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.tool_choice, "required");
  assert.equal((body.messages as Array<Record<string, unknown>>)[0]?.reasoning_content, "");
});

test("Kimi K2.7 removes unsupported reasoning and normalizes required tools", () => {
  const body = buildChatBody("accounts/fireworks/models/kimi-k2p7-code", [{ role: "user", content: "Inspect" }], {
    toolChoice: "required",
    customParams: { reasoning_effort: "high", thinking: { type: "enabled" } },
  });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.tool_choice, "auto");
});

test("Moonshot parser streams reasoning, text, tools, and authoritative usage", () => {
  const parser = createStreamParser();
  assert.deepEqual(parser.feed({ choices: [{ delta: { reasoning_content: "Think " } }] }), [
    { type: "reasoning-delta", text: "Think " },
  ]);
  assert.deepEqual(parser.feed({ choices: [{ delta: { content: "Answer" } }] }), [
    { type: "text-delta", text: "Answer" },
  ]);
  assert.deepEqual(parser.feed({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "inspect", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, cached_tokens: 2 },
  }), [{
    type: "tool-call-delta",
    index: 0,
    id: "call_1",
    name: "inspect",
    argumentsDelta: "{}",
  }]);
  const done = parser.finalize();
  assert.equal(done.finishReason, "tool-calls");
  assert.equal(done.usage?.totalTokens, 12);
  assert.equal(done.usage?.cachedInputTokens, 2);
});

test("Moonshot non-stream response retains reasoning", () => {
  const result = parseChatResponse({
    choices: [{ message: { content: "Answer", reasoning_content: "Think" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
  assert.equal(result.text, "Answer");
  assert.equal(result.reasoningContent, "Think");
  assert.equal(result.usage?.totalTokens, 5);
});

test("Responses reasoning item is attached to the following Moonshot assistant turn", () => {
  const request = normalizeResponsesRequest({
    model: "kimi-k3",
    input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Need a tool." }] },
      { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
  });
  assert.equal(request.messages[0]?.role, "assistant");
  assert.equal(request.messages[0]?.reasoning_content, "Need a tool.");
});

test("compiled Moonshot profile advertises Kimi reasoning", () => {
  const card = resolveModel("kimi-k3").card;
  assert.ok(card);
  assert.equal(protocolCapabilities(card.upstreamModelId || card.modelId).reasoning, true);
  assert.equal(getModelProtocolProfile(card).reasoning, true);
});

test("Moonshot family streams Fireworks chat reasoning and text incrementally", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body || "{}"));
    return new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"Think "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const request = normalizeResponsesRequest({
      model: "kimi-k3",
      input: "Hello",
      stream: true,
      reasoning: { effort: "high" },
    });
    const events = [];
    for await (const event of streamWithTools(request, {
      provider: "fireworks",
      family: "moonshot",
      modelId: "accounts/fireworks/models/kimi-k3",
    })) {
      events.push(event);
    }

    assert.equal(requestUrl, "https://api.fireworks.ai/inference/v1/chat/completions");
    assert.equal(requestBody.model, "accounts/fireworks/models/kimi-k3");
    assert.equal(requestBody.reasoning_effort, "high");
    assert.deepEqual(events.map((event) => event.type), ["reasoning-delta", "text-delta", "done"]);
    assert.equal(events[0]?.text, "Think ");
    assert.equal(events[1]?.text, "Answer");
    assert.equal(events[2]?.usage?.totalTokens, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
