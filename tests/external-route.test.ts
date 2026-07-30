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
  valkeyHSet,
  valkeySRem,
} from "../x402/keys/valkey.js";
import { initializeSessionBudget } from "../x402/session/budget.js";

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
  const originalAllowanceOverride = process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
  const originalBalanceOverride = process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
  const userAddress = wallet();
  const idempotencyKey = `external-eof-${randomUUID()}`;
  const idempotencyKeys = [idempotencyKey];
  let keyId = "";
  const paymentIntentIds: string[] = [];
  let server: ReturnType<typeof createServer> | null = null;
  let providerBody: Record<string, unknown> = {};
  let providerInvocations = 0;
  let providerMode: "success" | "overloaded" | "context" | "midstream" = "success";

  process.env.NODE_ENV = "test";
  process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = SETTLEMENT_HASH;
  process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = "10000000";
  process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = "10000000";
  process.env.AZURE_MOVZIHPN_ENDPOINT = "https://azure-eof-fixture.example";
  process.env.AZURE_MOVZIHPN_API_KEY = "test-key";

  try {
    const created = await createKey(userAddress, {
      budgetLimit: 10_000_000,
      expiresAt: Date.now() + 10 * 60_000,
      purpose: "api",
      network: NETWORK,
      name: "external-eof",
    });
    keyId = created.keyId;
    await initializeSessionBudget(userAddress, NETWORK, "10000000", Date.now() + 10 * 60_000);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://azure-eof-fixture.example")) {
        return originalFetch(input, init);
      }
      providerInvocations += 1;
      providerBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      if (providerMode === "overloaded") {
        return new Response(JSON.stringify({ error: { code: "server_is_overloaded", message: "busy" } }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "7" },
        });
      }
      if (providerMode === "context") {
        return new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "prompt too long" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (providerMode === "midstream") {
        return new Response([
          'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"partial"}\n\n',
          'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"provider_failed","message":"provider failed"}}}\n\n',
        ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
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

    const paymentIntentId = await valkeyGet(`payment-intent-idem:${created.keyId}:${idempotencyKey}`);
    assert.ok(paymentIntentId);
    paymentIntentIds.push(paymentIntentId);
    let intentStatus = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      intentStatus = (await valkeyHGetAll(`payment-intent:${paymentIntentId}`)).status || "";
      if (intentStatus === "settled" || intentStatus === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(intentStatus, "settled");

    const externalRequest = async (mode: typeof providerMode) => {
      providerMode = mode;
      const idem = `external-${mode}-${randomUUID()}`;
      idempotencyKeys.push(idem);
      const result = await originalFetch(`http://127.0.0.1:${port}/external/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.token}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idem,
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true, store: false }),
      });
      const intent = await valkeyGet(`payment-intent-idem:${created.keyId}:${idem}`);
      if (intent) paymentIntentIds.push(intent);
      return result;
    };

    const overloaded = await externalRequest("overloaded");
    assert.equal(overloaded.status, 503);
    assert.equal(overloaded.headers.get("retry-after"), "7");
    assert.doesNotMatch(overloaded.headers.get("content-type") || "", /text\/event-stream/);
    assert.equal((await overloaded.json() as { error?: { code?: string } }).error?.code, "server_is_overloaded");

    const context = await externalRequest("context");
    assert.equal(context.status, 400);
    assert.equal((await context.json() as { error?: { code?: string } }).error?.code, "context_length_exceeded");

    const midstream = await externalRequest("midstream");
    assert.equal(midstream.status, 200);
    const midstreamBody = await midstream.text();
    assert.match(midstreamBody, /"type":"response.failed"/);
    assert.match(midstreamBody, /"sequence_number":\d+/);
    assert.match(midstreamBody, /provider failed/);
    assert.doesNotMatch(midstreamBody, /data: \[DONE\]/);

    await valkeyHSet(`key:${created.keyId}`, {
      budgetUsed: "10000000",
      budgetReserved: "0",
    });
    await valkeyHSet(`session:budget:${NETWORK}:${userAddress.toLowerCase()}`, {
      usedBudgetWei: "10000000",
      lockedBudgetWei: "0",
    });
    const callsBeforeExhaustedRequest = providerInvocations;
    const exhausted = await externalRequest("success");
    assert.equal(exhausted.status, 402);
    assert.equal(providerInvocations, callsBeforeExhaustedRequest);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } finally {
    globalThis.fetch = originalFetch;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    for (const paymentIntentId of paymentIntentIds) {
      const intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
      if (intent.sessionBudgetIntentId) {
        await valkeyDel(`intent:${intent.sessionBudgetIntentId}`);
        await valkeySRem("intents:pending", intent.sessionBudgetIntentId);
        await valkeySRem(`session:budget:${NETWORK}:${userAddress.toLowerCase()}:intents`, intent.sessionBudgetIntentId);
      }
      await valkeyDel(`payment-intent:${paymentIntentId}`);
    }
    if (keyId) {
      for (const idem of idempotencyKeys) await valkeyDel(`payment-intent-idem:${keyId}:${idem}`);
      await valkeyDel(`key:${keyId}`);
      await valkeyDel(`key:revoked:${keyId}`);
      await valkeySRem(`user-keys:${NETWORK}:${userAddress.toLowerCase()}`, keyId);
    }
    await valkeyDel(`session:budget:${NETWORK}:${userAddress.toLowerCase()}`);
    await valkeyDel(`session:budget:${NETWORK}:${userAddress.toLowerCase()}:intents`);
    await closeValkey();
    if (originalEndpoint === undefined) delete process.env.AZURE_MOVZIHPN_ENDPOINT;
    else process.env.AZURE_MOVZIHPN_ENDPOINT = originalEndpoint;
    if (originalKey === undefined) delete process.env.AZURE_MOVZIHPN_API_KEY;
    else process.env.AZURE_MOVZIHPN_API_KEY = originalKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSettlementHash === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
    else process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = originalSettlementHash;
    if (originalAllowanceOverride === undefined) delete process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = originalAllowanceOverride;
    if (originalBalanceOverride === undefined) delete process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = originalBalanceOverride;
  }
});
