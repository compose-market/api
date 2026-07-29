import assert from "node:assert/strict";
import test from "node:test";

import { contextLimits, manageContext } from "../inference/context.js";
import type { Message, Request } from "../inference/core.js";
import type { ModelCard } from "../inference/types.js";

function model(inputTokens = 5_000, outputTokens = 500): ModelCard {
  return {
    modelId: "fixture-context-model",
    name: "Fixture",
    provider: "openai",
    family: "openai",
    type: "text generation",
    description: "fixture",
    input: ["text"],
    output: ["text"],
    contextWindow: { inputTokens, outputTokens },
    pricing: null,
  };
}

function request(messages: Message[], truncation: "auto" | "disabled" = "auto"): Request {
  return {
    mode: "responses",
    model: "fixture-context-model",
    stream: false,
    modality: "text",
    operation: "chat",
    messages,
    responseId: "resp_context_fixture",
    truncation,
  };
}

function long(value: string): string {
  return `${value}:${"x".repeat(3_500)}`;
}

test("context limits use exact existing catalog fields", () => {
  assert.deepEqual(contextLimits(model(1_048_576, 131_072)), {
    context: 1_048_576,
    input: 1_048_576,
    output: 131_072,
  });
});

test("native context management drops complete oldest turns and retains tool pairs", () => {
  const messages: Message[] = [
    { role: "system", content: "Never drop this instruction." },
    { role: "user", content: long("u1") },
    { role: "assistant", content: "a1" },
    { role: "user", content: long("u2") },
    { role: "assistant", content: "a2" },
    { role: "user", content: long("u3") },
    {
      role: "assistant",
      content: null,
      reasoning_content: "tool reasoning",
      tool_calls: [{ id: "call_3", type: "function", function: { name: "inspect", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_3", content: long("result3") },
    { role: "user", content: long("u4") },
    { role: "assistant", content: "a4" },
    { role: "user", content: long("u5") },
  ];

  const result = manageContext({ request: request(messages), model: model(), defaultEnabled: true });
  assert.equal(result.compacted, true);
  assert.equal(result.request.messages[0]?.content, "Never drop this instruction.");
  assert.equal(result.request.messages.some((message) => typeof message.content === "string" && message.content.startsWith("u1:")), false);
  assert.equal(result.request.messages.some((message) => typeof message.content === "string" && message.content.startsWith("u2:")), false);
  const call = result.request.messages.find((message) => message.tool_calls?.[0]?.id === "call_3");
  const tool = result.request.messages.find((message) => message.tool_call_id === "call_3");
  assert.equal(Boolean(call), Boolean(tool));
  assert.equal(result.request.messages.at(-1)?.content, messages.at(-1)?.content);
});

test("context management preserves non-leading system messages in relative order", () => {
  const messages: Message[] = [
    { role: "system", content: "leading" },
    { role: "user", content: long("old") },
    { role: "assistant", content: "old answer" },
    { role: "user", content: long("older") },
    { role: "assistant", content: "older answer" },
    { role: "system", content: "later instruction" },
    { role: "user", content: long("recent") },
    { role: "assistant", content: "recent answer" },
    { role: "user", content: long("latest") },
  ];
  const result = manageContext({ request: request(messages), model: model(), defaultEnabled: true });
  const later = result.request.messages.findIndex((message) => message.content === "later instruction");
  const recent = result.request.messages.findIndex((message) => typeof message.content === "string" && message.content.startsWith("recent:"));
  assert.ok(later >= 0);
  assert.ok(recent > later);
});

test("disabled context management leaves provider input unchanged", () => {
  const messages: Message[] = [
    { role: "user", content: long("u1") },
    { role: "user", content: long("u2") },
  ];
  const result = manageContext({ request: request(messages, "disabled"), model: model(), defaultEnabled: true });
  assert.equal(result.compacted, false);
  assert.deepEqual(result.request.messages, messages);
});
