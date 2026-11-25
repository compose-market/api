import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";

import type { Request } from "../inference/core.js";
import { getCompiledModels, resolveModel } from "../inference/adapters/registry.js";
import { getModelCapabilities } from "../inference/adapters/modalities/index.js";
import { open, target } from "../inference/adapters/vendors/wss.js";

function request(model: string, operation: string): Request {
  return {
    mode: "responses",
    model,
    stream: true,
    modality: "realtime",
    operation,
    responseId: "resp_realtime_test",
    messages: [],
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test port");
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("catalog realtime resolver reaches every implemented services route without model substrings", () => {
  const routes = new Map<string, string[]>();
  for (const card of getCompiledModels().models) {
    const capability = getModelCapabilities(card)
      .find((entry) => entry.modality === "realtime");
    if (!capability) continue;

    const resolved = resolveModel(card.modelId);
    const input = request(card.modelId, capability.operation);
    const params = {
      sample_rate: ["16000", "24000"],
      token: "secret-token",
    };
    const realtime = target(resolved, input, params);
    if (!realtime) continue;

    assert.equal(realtime.operation, capability.operation);
    assert.equal(realtime.query.has("token"), false);
    assert.equal(realtime.query.get("response_id"), "resp_realtime_test");

    if (realtime.path === "/flux") {
      assert.deepEqual(realtime.query.getAll("sample_rate"), ["16000", "24000"]);
    }

    const models = routes.get(realtime.path) ?? [];
    models.push(card.modelId);
    routes.set(realtime.path, models);
  }

  assert.deepEqual([...routes.keys()].sort(), [
    "/flux",
    "/lyria",
    "/qwen-omni",
    "/realtime-2",
    "/realtime-translate",
    "/scribe",
    "/whisper",
  ]);
  for (const [route, models] of routes) {
    assert.ok(models.length > 0, `${route} should have at least one catalog model`);
  }

  const source = readFileSync(new URL("../inference/catalog/vendors/wss.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:modelId|upstream|rawModel|model)\.includes\(/u);
  assert.doesNotMatch(source, /\b(?:modelId|upstream|rawModel|model)\.startsWith\(/u);
  assert.equal(source.includes("preparePaidInference"), false);
  assert.equal(source.includes("settlePaidInference"), false);
  assert.doesNotMatch(source, /payment|x402|compose-?key/iu);
  assert.equal(source.includes("customParams"), false);
  assert.equal(source.includes("audioOptions"), false);
  assert.equal(source.includes("WebSocketServer"), false);
  assert.equal(source.includes("handleUpgrade"), false);
  assert.equal(source.includes("../../gateway"), false);
});

test("catalog realtime vendor executes services terminal evidence as normal output", async () => {
  const previous = process.env.REALTIME_URL;
  const server = http.createServer();
  const socket = new WebSocketServer({ server });
  const port = await listen(server);
  process.env.REALTIME_URL = `ws://127.0.0.1:${port}`;

  let route = "";
  const done = new Promise<void>((resolve) => {
    socket.once("connection", (ws, req) => {
      route = req.url || "";
      ws.on("message", (raw) => {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === "response.create") {
          ws.send(JSON.stringify({
            type: "response.done",
            response: {
              usage: {
                input_tokens: 5,
                output_tokens: 3,
                total_tokens: 8,
              },
            },
          }));
          return;
        }
        if (data.type === "close") {
          ws.send(JSON.stringify({
            type: "done",
            response_id: "resp_realtime_test",
            responseId: "resp_realtime_test",
            status: "completed",
            usage: {
              input_tokens: 5,
              output_tokens: 3,
              total_tokens: 8,
            },
          }));
          resolve();
        }
      });
    });
  });

  try {
    const result = await open(request("gpt-realtime-2", "realtime-omni"), {
      modelId: "gpt-realtime-2",
      provider: "openai",
    });
    await done;

    assert.match(route, /^\/realtime-2\?/u);
    assert.equal(result.modality, "realtime");
    assert.equal(result.usage?.promptTokens, 5);
    assert.equal(result.usage?.completionTokens, 3);
    assert.equal(result.usage?.totalTokens, 8);
  } finally {
    process.env.REALTIME_URL = previous;
    socket.close();
    await close(server);
  }
});
