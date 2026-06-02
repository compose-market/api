import assert from "node:assert/strict";
import test from "node:test";

import { chat, streamChat } from "../inference/catalog/families/google.js";

test("Google chat round-trips tool-call thought signatures on the wire", async () => {
  const originalFetch = globalThis.fetch;
  let body: any;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              {
                thoughtSignature: "sig-output",
                functionCall: {
                  name: "connectors_find",
                  args: { query: "transcription" },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const output = await chat(
      { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", authStyle: "key" },
      "gemini-test",
      [
        { role: "user", content: "find a transcription tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "connectors_find", arguments: "{\"query\":\"transcription\"}" },
              providerMetadata: { google: { thoughtSignature: "sig-input" } },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "connectors_find", content: "{\"selected\":{\"name\":\"deepgram\"}}" },
      ],
    );

    const functionCallPart = body.contents[1].parts[0];
    assert.equal(functionCallPart.thoughtSignature, "sig-input");
    assert.deepEqual(output.toolCalls?.[0]?.providerMetadata, { google: { thoughtSignature: "sig-output" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google stream parses CRLF-framed text and usage metadata", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response([
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}],\"role\":\"model\"},\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":6,\"candidatesTokenCount\":1,\"totalTokenCount\":7}}",
    "",
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"\",\"thoughtSignature\":\"sig-empty\"}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":6,\"candidatesTokenCount\":1,\"totalTokenCount\":7}}",
    "",
    "",
  ].join("\r\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  try {
    const events = [];
    for await (const event of streamChat(
      { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", authStyle: "key" },
      "gemini-test",
      [{ role: "user", content: "Reply with exactly: hello" }],
    )) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "text-delta");
    assert.equal((events[0] as { text?: string }).text, "hello");
    assert.deepEqual((events.at(-1) as { usage?: unknown }).usage, {
      promptTokens: 6,
      completionTokens: 1,
      totalTokens: 7,
      raw: {
        promptTokenCount: 6,
        candidatesTokenCount: 1,
        totalTokenCount: 7,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google stream parses a final frame even when upstream omits the SSE terminator blank line", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"tail\"}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":2,\"totalTokenCount\":5}}",
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )) as typeof fetch;

  try {
    const events = [];
    for await (const event of streamChat(
      { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", authStyle: "key" },
      "gemini-test",
      [{ role: "user", content: "tail" }],
    )) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "text-delta");
    assert.equal((events[0] as { text?: string }).text, "tail");
    assert.equal((events.at(-1) as { usage?: { totalTokens?: number } }).usage?.totalTokens, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google stream does not fabricate usage when the provider sends none", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response([
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}]}",
    "",
    "",
  ].join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  try {
    const events = [];
    for await (const event of streamChat(
      { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", authStyle: "key" },
      "gemini-test",
      [{ role: "user", content: "ok" }],
    )) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "text-delta");
    assert.equal((events.at(-1) as { usage?: unknown }).usage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google stream lowers OpenAI-compatible options without leaking stream_options", async () => {
  const originalFetch = globalThis.fetch;
  let body: any;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response([
      "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":1,\"totalTokenCount\":4}}",
      "",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
    const events = [];
    for await (const event of streamChat(
      { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", authStyle: "key" },
      "gemini-test",
      [{ role: "user", content: "ok" }],
      {
        customParams: {
          top_p: 0.95,
          stream_options: { include_usage: true },
          prompt_cache_key: "ignored",
        },
      },
    )) {
      events.push(event);
    }

    assert.equal(body.generationConfig.topP, 0.95);
    assert.equal("top_p" in body.generationConfig, false);
    assert.equal("stream_options" in body.generationConfig, false);
    assert.equal("prompt_cache_key" in body.generationConfig, false);
    assert.equal(events[0]?.type, "text-delta");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google stream preserves function-call thought signatures", async () => {
  const originalFetch = globalThis.fetch;
  const seen = new Map<string, string>();

  globalThis.fetch = (async () => new Response([
    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"thoughtSignature\":\"sig-stream\",\"functionCall\":{\"name\":\"connectors_find\",\"args\":{\"query\":\"weather\"}}}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":9,\"candidatesTokenCount\":3,\"totalTokenCount\":12}}",
    "",
    "",
  ].join("\r\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  try {
    const events = [];
    for await (const event of streamChat(
      { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", authStyle: "key" },
      "gemini-test",
      [{ role: "user", content: "find weather connector" }],
      {
        onThoughtSignature: (id, signature) => seen.set(id, signature),
      },
    )) {
      events.push(event);
    }

    const call = events[0] as { toolCall?: { id: string; providerMetadata?: unknown } };
    assert.equal(events[0]?.type, "tool-call");
    assert.equal(seen.get(call.toolCall!.id), "sig-stream");
    assert.deepEqual(call.toolCall?.providerMetadata, { google: { thoughtSignature: "sig-stream" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
