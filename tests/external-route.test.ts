import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { errors, json } from "../http/body.js";
import { register } from "../inference/external.js";
import { createKey } from "../x402/keys/storage.js";
import {
  closeValkey,
  valkeyDel,
  valkeyGet,
  valkeyHGetAll,
  valkeySRem,
} from "../x402/keys/valkey.js";

const NETWORK = "eip155:5042002" as const;
const SETTLEMENT_HASH = `0x${"34".repeat(32)}`;

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

test("external Responses route accepts provider completion followed by EOF without DONE", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.AZURE_MOVZIHPN_ENDPOINT;
  const originalKey = process.env.AZURE_MOVZIHPN_API_KEY;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSettlementHash = process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
  const userAddress = wallet();
  const idempotencyKey = `external-eof-${randomUUID()}`;
  let keyId = "";
  let paymentIntentId: string | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  let providerBody: Record<string, unknown> = {};

  process.env.NODE_ENV = "test";
  process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = SETTLEMENT_HASH;
  process.env.AZURE_MOVZIHPN_ENDPOINT = "https://azure-eof-fixture.example";
  process.env.AZURE_MOVZIHPN_API_KEY = "test-key";

  try {
    const created = await createKey(userAddress, {
      budgetLimit: 1_000_000,
      expiresAt: Date.now() + 10 * 60_000,
      purpose: "api",
      network: NETWORK,
      name: "external-eof",
    });
    keyId = created.keyId;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://azure-eof-fixture.example")) {
        return originalFetch(input, init);
      }
      providerBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const stream = [
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"hello"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_upstream","status":"completed","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
      ].join("");
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const app = express();
    app.use(json());
    register(app);
    app.use(errors());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await originalFetch(`http://127.0.0.1:${port}/external/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "hello",
        previous_response_id: "resp_provider_owned",
        stream: true,
        store: false,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /response\.output_text\.delta/);
    assert.match(body, /response\.completed/);
    assert.match(body, /data: \[DONE\]/);
    assert.doesNotMatch(body, /upstream stream ended|upstream_error/);
    assert.equal(providerBody.previous_response_id, "resp_provider_owned");

    paymentIntentId = await valkeyGet(`payment-intent-idem:${created.keyId}:${idempotencyKey}`);
    assert.ok(paymentIntentId);
    let intentStatus = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      intentStatus = (await valkeyHGetAll(`payment-intent:${paymentIntentId}`)).status || "";
      if (intentStatus === "settled" || intentStatus === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(intentStatus, "settled");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } finally {
    globalThis.fetch = originalFetch;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    if (paymentIntentId) await valkeyDel(`payment-intent:${paymentIntentId}`);
    if (keyId) {
      await valkeyDel(`payment-intent-idem:${keyId}:${idempotencyKey}`);
      await valkeyDel(`key:${keyId}`);
      await valkeyDel(`key:revoked:${keyId}`);
      await valkeySRem(`user-keys:${NETWORK}:${userAddress.toLowerCase()}`, keyId);
    }
    await closeValkey();
    if (originalEndpoint === undefined) delete process.env.AZURE_MOVZIHPN_ENDPOINT;
    else process.env.AZURE_MOVZIHPN_ENDPOINT = originalEndpoint;
    if (originalKey === undefined) delete process.env.AZURE_MOVZIHPN_API_KEY;
    else process.env.AZURE_MOVZIHPN_API_KEY = originalKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSettlementHash === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
    else process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = originalSettlementHash;
  }
});
