import assert from "node:assert/strict";
import test from "node:test";

import {
  ResponseStateStore,
  ResponseStateUnavailableError,
  type StoredResponseRecord,
} from "../inference/state.js";

const record: StoredResponseRecord = {
  id: "resp_exact",
  model: "gemini-3",
  provider: "gemini",
  createdAt: 123,
  status: "completed",
  store: true,
  inputItems: [{
    type: "function_call_output",
    call_id: "call_weather",
    output: "sunny",
  }],
  inputMessages: [{ role: "tool", tool_call_id: "call_weather", content: "sunny" }],
  output: {
    modality: "text",
    finishReason: "tool-calls",
    outputItems: [{
      id: "fc_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "weather",
      arguments: "{\"city\":\"Rome\"}",
    }],
    toolCalls: [{
      id: "call_weather",
      itemId: "fc_weather",
      callId: "call_weather",
      outputIndex: 0,
      name: "weather",
      arguments: "{\"city\":\"Rome\"}",
      providerMetadata: { google: { thoughtSignature: "opaque-signature" } },
    }],
  },
};

test("response state round-trips exact public items and private provider call state", async () => {
  const values = new Map<string, string>();
  const store = new ResponseStateStore({
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
  });

  await store.save(record);

  assert.deepEqual(await store.get("resp_exact"), record);
});

test("response state has no process-memory fallback when the durable backend fails", async () => {
  const store = new ResponseStateStore({
    get: async () => {
      throw new Error("ValKey unavailable");
    },
    set: async () => {
      throw new Error("ValKey unavailable");
    },
  });

  await assert.rejects(
    store.save(record),
    (error: unknown) => error instanceof ResponseStateUnavailableError
      && error.statusCode === 503
      && error.code === "response_state_unavailable",
  );
  await assert.rejects(
    store.get("resp_exact"),
    (error: unknown) => error instanceof ResponseStateUnavailableError
      && error.statusCode === 503
      && error.code === "response_state_unavailable",
  );
});

test("response state skips persistence only for explicit store false", async () => {
  let writes = 0;
  const store = new ResponseStateStore({
    get: async () => null,
    set: async () => {
      writes += 1;
    },
  });

  await store.save({ ...record, id: "resp_stateless", store: false });

  assert.equal(writes, 0);
});
