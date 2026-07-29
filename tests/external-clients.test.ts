import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";

test("pinned AI SDK clients accept Responses EOF and Chat usage", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url || "", body: raw ? JSON.parse(raw) : null });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    if (req.url?.endsWith("/responses")) {
      const response = (status: string, output: unknown[] = [], usage?: Record<string, unknown>) => ({
        id: "resp_fixture", object: "response", created_at: 123, status, model: "fixture-model", output,
        ...(usage ? { usage } : {}),
      });
      const item = {
        id: "msg_fixture", type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      };
      const events = [
        { type: "response.created", sequence_number: 0, response: response("in_progress") },
        { type: "response.output_item.added", sequence_number: 1, response_id: "resp_fixture", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", sequence_number: 2, response_id: "resp_fixture", item_id: "msg_fixture", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", sequence_number: 3, response_id: "resp_fixture", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "hello" },
        { type: "response.output_text.done", sequence_number: 4, response_id: "resp_fixture", item_id: "msg_fixture", output_index: 0, content_index: 0, text: "hello" },
        { type: "response.content_part.done", sequence_number: 5, response_id: "resp_fixture", item_id: "msg_fixture", output_index: 0, content_index: 0, part: item.content[0] },
        { type: "response.output_item.done", sequence_number: 6, response_id: "resp_fixture", output_index: 0, item },
        { type: "response.completed", sequence_number: 7, response: response("completed", [item], {
          input_tokens: 100, output_tokens: 5, total_tokens: 105,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 2 },
        }) },
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }

    const chunks = [
      { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 123, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] },
      { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 123, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 123, model: "fixture-model", choices: [], usage: {
        prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      } },
    ];
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${port}/v1`;
  try {
    const responsesProvider = createOpenAI({ apiKey: "test", baseURL });
    const responses = streamText({
      model: responsesProvider("fixture-model"),
      prompt: "hello",
      providerOptions: { openai: { promptCacheKey: "session-1", store: false } },
    });
    assert.equal(await responses.text, "hello");
    const responsesUsage = await responses.usage as any;
    assert.equal(responsesUsage.inputTokenDetails.cacheReadTokens, 80);

    const chatProvider = createOpenAICompatible({ name: "compose-market", apiKey: "test", baseURL });
    const chat = streamText({ model: chatProvider("fixture-model"), prompt: "hello" });
    assert.equal(await chat.text, "hello");
    const chatUsage = await chat.usage as any;
    assert.equal(chatUsage.inputTokenDetails.cacheReadTokens, 80);
    assert.equal(requests[0]?.url, "/v1/responses");
    assert.equal((requests[0]?.body as Record<string, unknown>).prompt_cache_key, "session-1");
    assert.equal(requests[1]?.url, "/v1/chat/completions");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
