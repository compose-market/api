import test from "node:test";
import assert from "node:assert/strict";

import type { Message, Schema, Tool } from "../inference/core.js";
import { normalizeChatRequest } from "../inference/core.js";
import { google, object } from "../inference/catalog/shared/schema.js";
import * as alibaba from "../inference/catalog/families/alibaba.js";
import * as anthropic from "../inference/catalog/families/anthropic.js";
import * as cohere from "../inference/catalog/families/cohere.js";
import * as deepseek from "../inference/catalog/families/deepseek.js";
import * as mistral from "../inference/catalog/families/mistral.js";
import * as xai from "../inference/catalog/families/xai.js";
import * as zai from "../inference/catalog/families/zai.js";

const schema: Schema = {
  type: "object",
  description: "Rich canonical tool input.",
  additionalProperties: false,
  properties: {
    prompt: {
      type: "string",
      description: "Task prompt.",
      minLength: 1,
      pattern: "^[a-z]",
    },
    choice: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "number", exclusiveMinimum: 0 },
      ],
    },
    meta: {
      type: ["object", "null"],
      propertyNames: { type: "string" },
      additionalProperties: { type: "string" },
      properties: {
        tags: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
  required: ["prompt"],
};

const tool: Tool = {
  type: "function",
  function: {
    name: "delegate",
    description: "Delegate work.",
    parameters: schema,
  },
};

const messages: Message[] = [{ role: "user", content: "Use the tool." }];

function functionParams(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body.tools as Array<{ function: { parameters: Record<string, unknown> } }>;
  return tools[0].function.parameters;
}

test("canonical chat request preserves rich tool schema before provider lowering", () => {
  const request = normalizeChatRequest({
    model: "gpt-5.2",
    stream: false,
    messages,
    tools: [tool],
  });

  const params = request.tools?.[0]?.function.parameters as Record<string, unknown>;
  const properties = params.properties as Record<string, Record<string, unknown>>;

  assert.equal(params.additionalProperties, false);
  assert.equal(properties.prompt.minLength, 1);
  assert.equal(properties.prompt.pattern, "^[a-z]");
  assert.ok(Array.isArray(properties.choice.anyOf));
  assert.deepEqual(properties.meta.additionalProperties, { type: "string" });
});

test("Gemini schema lowering strips unsupported keywords only at the wire edge", () => {
  const params = google(object(schema));
  const properties = params.properties as Record<string, Record<string, unknown>>;
  const choice = properties.choice;
  const meta = properties.meta;
  const metaProperties = meta.properties as Record<string, Record<string, unknown>>;
  const tags = metaProperties.tags;
  const tagsItems = tags.items as Record<string, unknown>;

  assert.equal(params.type, "object");
  assert.equal(params.additionalProperties, undefined);
  assert.equal(properties.prompt.minLength, undefined);
  assert.equal(properties.prompt.pattern, undefined);
  assert.equal(choice.anyOf, undefined);
  assert.equal(choice.type, "string");
  assert.equal(meta.nullable, true);
  assert.equal(meta.propertyNames, undefined);
  assert.equal(meta.additionalProperties, undefined);
  assert.equal(tagsItems.minLength, undefined);
  assert.deepEqual(params.required, ["prompt"]);
});

test("OpenAI-compatible and Anthropic family wires keep rich schema through shared object lowering", () => {
  const bodies: Array<[string, Record<string, unknown>]> = [
    ["alibaba", functionParams(alibaba.buildChatBody("qwen-plus", messages, { tools: [tool] }).body)],
    ["anthropic", ((anthropic.buildChatBody("claude-sonnet-4-5", messages, { tools: [tool] }).tools as any[])[0].input_schema)],
    ["cohere", functionParams(cohere.buildChatBody("command-a-03-2025", messages, { tools: [tool] }))],
    ["deepseek", functionParams(deepseek.buildChatBody("deepseek-chat", messages, { tools: [tool] }))],
    ["mistral", functionParams(mistral.buildChatBody("mistral-large-latest", messages, { tools: [tool] }))],
    ["xai", functionParams(xai.buildChatBody("grok-4", messages, { tools: [tool] }))],
    ["zai", ((zai.buildChatBody("glm-4.6", messages, { tools: [tool] }).tools as any[])[0].function.parameters)],
  ];

  for (const [name, params] of bodies) {
    const properties = params.properties as Record<string, Record<string, unknown>>;
    assert.equal(params.type, "object", name);
    assert.equal(params.additionalProperties, false, name);
    assert.equal(properties.prompt.minLength, 1, name);
    assert.ok(Array.isArray(properties.choice.anyOf), name);
    assert.deepEqual(properties.meta.additionalProperties, { type: "string" }, name);
  }
});
