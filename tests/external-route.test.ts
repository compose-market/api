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
  valkeySMembers,
  valkeySRem,
  valkeyZRem,
} from "../x402/keys/valkey.js";
import { listExecutionEvidence } from "../x402/evidence.js";

const NETWORK = "eip155:84532" as const;

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function canonicalIntentIdempotencyKey(
  keyId: string,
  rootRunId: string,
  executionRunId = rootRunId,
  sequence = 0,
  idempotencyKey?: string,
): string {
  const base = `payment-intent-idem:${NETWORK}:${keyId}:${encodeURIComponent(rootRunId)}:${encodeURIComponent(executionRunId)}:${sequence}`;
  const explicit = idempotencyKey?.trim();
  return explicit ? `${base}:${encodeURIComponent(explicit)}` : base;
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

test("external Responses route accepts provider completion followed by EOF without DONE", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.AZURE_MOVZIHPN_ENDPOINT;
  const originalKey = process.env.AZURE_MOVZIHPN_API_KEY;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSettlementHash = process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
  const originalSettlementMode = process.env.COMPOSE_TEST_SETTLEMENT_MODE;
  const originalAllowanceOverride = process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
  const originalBalanceOverride = process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
  const userAddress = wallet();
  const idempotencyKey = `external-eof-${randomUUID()}`;
  const runIds = new Set<string>();
  const executionLanes = new Set<string>();
  const evidenceIds = new Set<string>();
  const receiptIds = new Set<string>();
  let keyId = "";
  const paymentIntentIds: string[] = [];
  let server: ReturnType<typeof createServer> | null = null;
  let providerBody: Record<string, unknown> = {};
  let providerInvocations = 0;
  let activeProviderInvocations = 0;
  let maxConcurrentProviderInvocations = 0;
  let providerDelayMs = 0;
  let providerMode: "success" | "overloaded" | "context" | "midstream" = "success";

  process.env.NODE_ENV = "test";
  delete process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
  process.env.COMPOSE_TEST_SETTLEMENT_MODE = "deterministic";
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

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://azure-eof-fixture.example")) {
        return originalFetch(input, init);
      }
      providerInvocations += 1;
      activeProviderInvocations += 1;
      maxConcurrentProviderInvocations = Math.max(maxConcurrentProviderInvocations, activeProviderInvocations);
      try {
        providerBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        if (providerDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
        }
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
      } finally {
        activeProviderInvocations -= 1;
      }
    }) as typeof fetch;

    const app = express();
    app.use(json());
    register(app);
    app.use(errors());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const waitForIntentStatus = async (paymentIntentId: string): Promise<string> => {
      let intentStatus = "";
      for (let attempt = 0; attempt < 50; attempt += 1) {
        intentStatus = (await valkeyHGetAll(`payment-intent:${paymentIntentId}`)).status || "";
        if (intentStatus === "confirmed" || intentStatus === "failed" || intentStatus === "released") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return intentStatus;
    };
    const assertEvidence = async (
      rootRunId: string,
      executionRunId: string,
      paymentIntentId: string,
      expectedTxHash: string,
    ) => {
      const evidence = await listExecutionEvidence(rootRunId, executionRunId);
      for (const item of evidence) {
        if (item.id) evidenceIds.add(item.id);
      }
      assert.equal(evidence.length, 1, "each external execution lane must record exactly one charge evidence item");
      assert.equal(evidence[0]?.paymentIntentId, paymentIntentId);
      assert.equal(evidence[0]?.txHash, expectedTxHash);
      assert.equal(evidence[0]?.settlementStatus, "settled");
      assert.equal(evidence[0]?.network, NETWORK);
      const indexedReceiptIds = await valkeySMembers(`x402:receipt:intent:${paymentIntentId}`);
      assert.equal(indexedReceiptIds.length, 1,
        "each external execution lane must persist exactly one canonical receipt");
      receiptIds.add(indexedReceiptIds[0]!);
      const receiptRaw = await valkeyGet(`x402:receipt:${indexedReceiptIds[0]}`);
      assert.ok(receiptRaw, "canonical external receipt must be durable");
      const receipt = JSON.parse(receiptRaw) as {
        paymentIntentId?: string;
        settlementStatus?: string;
        txHash?: string;
        network?: string;
      };
      assert.equal(receipt.paymentIntentId, paymentIntentId);
      assert.equal(receipt.settlementStatus, "settled");
      assert.equal(receipt.txHash, expectedTxHash);
      assert.equal(receipt.network, NETWORK);
      return evidence[0]!;
    };

    const responseRunId = `external-responses-${randomUUID()}`;
    runIds.add(responseRunId);
    executionLanes.add(`${responseRunId}\u0000${responseRunId}`);
    const response = await originalFetch(`http://127.0.0.1:${port}/external/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
        "x-run-id": responseRunId,
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
    assert.equal(occurrenceCount(body, "event: receipt"), 0,
      "external Responses framing must remain protocol-neutral");
    assert.equal(providerBody.previous_response_id, "resp_provider_owned");

    const paymentIntentId = await valkeyGet(canonicalIntentIdempotencyKey(
      created.keyId,
      responseRunId,
      responseRunId,
      0,
      idempotencyKey,
    ));
    assert.ok(paymentIntentId);
    paymentIntentIds.push(paymentIntentId);
    assert.equal(await waitForIntentStatus(paymentIntentId), "confirmed");
    const responseIntent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    assert.ok(BigInt(responseIntent.finalAmountWei || "0") > 0n, "external Responses should settle a nonzero final amount");
    assert.match(responseIntent.txHash || "", /^0x[0-9a-f]{64}$/u);
    await assertEvidence(responseRunId, responseRunId, paymentIntentId, responseIntent.txHash!);

    providerMode = "success";
    const chatIdempotencyKey = `external-chat-${randomUUID()}`;
    const chatRunId = `external-chat-${randomUUID()}`;
    runIds.add(chatRunId);
    executionLanes.add(`${chatRunId}\u0000${chatRunId}`);
    const chat = await originalFetch(`http://127.0.0.1:${port}/external/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": chatIdempotencyKey,
        "x-run-id": chatRunId,
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    assert.equal(chat.status, 200);
    const chatBody = await chat.text();
    assert.match(chatBody, /chat\.completion\.chunk/);
    assert.match(chatBody, /data: \[DONE\]/);
    assert.equal(occurrenceCount(chatBody, "event: receipt"), 0,
      "external Chat framing must remain protocol-neutral");
    const chatPaymentIntentId = await valkeyGet(canonicalIntentIdempotencyKey(
      created.keyId,
      chatRunId,
      chatRunId,
      0,
      chatIdempotencyKey,
    ));
    assert.ok(chatPaymentIntentId);
    paymentIntentIds.push(chatPaymentIntentId);
    assert.equal(await waitForIntentStatus(chatPaymentIntentId), "confirmed");
    const chatIntent = await valkeyHGetAll(`payment-intent:${chatPaymentIntentId}`);
    assert.ok(BigInt(chatIntent.finalAmountWei || "0") > 0n, "external Chat Completions should settle a nonzero final amount");
    assert.match(chatIntent.txHash || "", /^0x[0-9a-f]{64}$/u);
    assert.notEqual(chatIntent.txHash, responseIntent.txHash,
      "independent external calls must have distinct transaction identities");
    await assertEvidence(chatRunId, chatRunId, chatPaymentIntentId, chatIntent.txHash!);

    providerMode = "success";
    const fanoutRootRunId = `external-fanout-${randomUUID()}`;
    const fanoutIdempotencyKey = `external-fanout-${randomUUID()}`;
    const fanoutLanes = ["planner", "researcher", "reviewer"].map((role) => ({
      executionRunId: `${fanoutRootRunId}-${role}`,
      idempotencyKey: fanoutIdempotencyKey,
    }));
    assert.equal(new Set(fanoutLanes.map((lane) => lane.idempotencyKey)).size, 1,
      "sibling requests must propagate one common X-Idempotency-Key");
    assert.equal(new Set(fanoutLanes.map((lane) => lane.executionRunId)).size, fanoutLanes.length,
      "each sibling request must carry a distinct x-execution-run-id");
    runIds.add(fanoutRootRunId);
    for (const lane of fanoutLanes) {
      executionLanes.add(`${fanoutRootRunId}\u0000${lane.executionRunId}`);
    }
    providerDelayMs = 25;
    maxConcurrentProviderInvocations = 0;
    const fanoutResponses = await Promise.all(fanoutLanes.map((lane) => originalFetch(
      `http://127.0.0.1:${port}/external/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.token}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": lane.idempotencyKey,
          "x-run-id": fanoutRootRunId,
          "x-execution-run-id": lane.executionRunId,
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: `hello from ${lane.executionRunId}`,
          stream: true,
          store: false,
        }),
      },
    )));
    providerDelayMs = 0;
    assert.deepEqual(fanoutResponses.map((result) => result.status), [200, 200, 200]);
    assert.ok(maxConcurrentProviderInvocations > 1,
      "parallel external siblings must overlap at the provider boundary");
    const fanoutBodies = await Promise.all(fanoutResponses.map((result) => result.text()));
    for (const body of fanoutBodies) {
      assert.equal(occurrenceCount(body, "event: receipt"), 0,
        "external sibling framing must remain protocol-neutral");
      assert.match(body, /response\.completed/u);
      assert.match(body, /data: \[DONE\]/u);
    }

    const fanoutIntentIds = await Promise.all(fanoutLanes.map((lane) => (
      valkeyGet(canonicalIntentIdempotencyKey(
        created.keyId,
        fanoutRootRunId,
        lane.executionRunId,
        0,
        lane.idempotencyKey,
      ))
    )));
    assert.equal(fanoutIntentIds.every((paymentIntentId) => Boolean(paymentIntentId)), true);
    assert.equal(new Set(fanoutIntentIds).size, fanoutLanes.length,
      "parallel external execution lanes must create independent canonical intents");
    const fanoutTxHashes: string[] = [];
    for (const [index, paymentIntentId] of fanoutIntentIds.entries()) {
      assert.ok(paymentIntentId);
      paymentIntentIds.push(paymentIntentId);
      assert.equal(await waitForIntentStatus(paymentIntentId), "confirmed");
      const intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
      assert.equal(intent.rootRunId, fanoutRootRunId);
      assert.equal(intent.executionRunId, fanoutLanes[index]!.executionRunId);
      assert.equal(intent.sequence, "0");
      assert.equal(intent.idempotencyKey, fanoutIdempotencyKey,
        "each canonical sibling intent must retain the identical propagated X-Idempotency-Key");
      assert.ok(BigInt(intent.finalAmountWei || "0") > 0n);
      assert.match(intent.txHash || "", /^0x[0-9a-f]{64}$/u);
      fanoutTxHashes.push(intent.txHash!);
      await assertEvidence(
        fanoutRootRunId,
        fanoutLanes[index]!.executionRunId,
        paymentIntentId,
        intent.txHash!,
      );
    }
    assert.equal(new Set(fanoutTxHashes).size, fanoutLanes.length,
      "parallel external sibling intents must retain distinct transaction identities");

    const uniqueConfirmedIntentIds = new Set(paymentIntentIds);
    let uniqueConfirmedAmount = 0n;
    for (const paymentIntentId of uniqueConfirmedIntentIds) {
      const intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
      assert.equal(intent.status, "confirmed");
      uniqueConfirmedAmount += BigInt(intent.finalAmountWei || "0");
    }
    const keyAfterFanout = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(BigInt(keyAfterFanout.budgetUsed || "0"), uniqueConfirmedAmount,
      "budgetUsed must equal each unique confirmed intent amount exactly once");
    assert.equal(BigInt(keyAfterFanout.budgetReserved || "0"), 0n);

    const replayLane = fanoutLanes[0]!;
    const replayIntentId = fanoutIntentIds[0]!;
    const replayIdempotencyKey = fanoutIdempotencyKey;
    const indexedIntentsBeforeReplay = new Set(await valkeySMembers(`key-payment-intents:${created.keyId}`));
    const evidenceBeforeReplay = await listExecutionEvidence(fanoutRootRunId, replayLane.executionRunId);
    const budgetUsedBeforeReplay = keyAfterFanout.budgetUsed;
    const replayResponse = await originalFetch(`http://127.0.0.1:${port}/external/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": replayIdempotencyKey,
        "x-run-id": fanoutRootRunId,
        "x-execution-run-id": replayLane.executionRunId,
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: `hello from ${replayLane.executionRunId}`,
        stream: true,
        store: false,
      }),
    });
    assert.equal(replayResponse.status, 200);
    const replayBody = await replayResponse.text();
    assert.equal(occurrenceCount(replayBody, "event: receipt"), 0);
    assert.match(replayBody, /response\.completed/u);
    assert.match(replayBody, /data: \[DONE\]/u);
    assert.equal(await valkeyGet(canonicalIntentIdempotencyKey(
      created.keyId,
      fanoutRootRunId,
      replayLane.executionRunId,
      0,
      replayIdempotencyKey,
    )), replayIntentId, "canonical lane replay must resolve to the original intent");
    assert.deepEqual(
      new Set(await valkeySMembers(`key-payment-intents:${created.keyId}`)),
      indexedIntentsBeforeReplay,
      "canonical lane replay must not index a second payment intent",
    );
    const evidenceAfterReplay = await listExecutionEvidence(fanoutRootRunId, replayLane.executionRunId);
    assert.equal(evidenceAfterReplay.length, 1, "canonical lane replay must not record duplicate evidence");
    assert.equal(evidenceAfterReplay[0]?.id, evidenceBeforeReplay[0]?.id);
    assert.equal(evidenceAfterReplay[0]?.paymentIntentId, replayIntentId);
    const keyAfterReplay = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(keyAfterReplay.budgetUsed, budgetUsedBeforeReplay,
      "canonical lane replay must not apply a second budget delta");

    const externalRequest = async (mode: typeof providerMode) => {
      providerMode = mode;
      const idem = `external-${mode}-${randomUUID()}`;
      const rootRunId = `external-${mode}-${randomUUID()}`;
      const executionRunId = rootRunId;
      runIds.add(rootRunId);
      executionLanes.add(`${rootRunId}\u0000${executionRunId}`);
      const result = await originalFetch(`http://127.0.0.1:${port}/external/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.token}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idem,
          "x-run-id": rootRunId,
          "x-execution-run-id": executionRunId,
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true, store: false }),
      });
      const intent = await valkeyGet(canonicalIntentIdempotencyKey(
        created.keyId,
        rootRunId,
        executionRunId,
        0,
        idem,
      ));
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
    const indexedIntentIds = keyId
      ? await valkeySMembers(`key-payment-intents:${keyId}`)
      : [];
    for (const paymentIntentId of new Set([...paymentIntentIds, ...indexedIntentIds])) {
      const intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
      if (intent.rootRunId && intent.executionRunId) {
        await valkeyDel(canonicalIntentIdempotencyKey(
          keyId,
          intent.rootRunId,
          intent.executionRunId,
          Number.parseInt(intent.sequence || "0", 10),
          intent.idempotencyKey || undefined,
        ));
      }
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeySRem("payment-intents:projections", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeyDel(`x402:evidence:intent:${paymentIntentId}`);
      await valkeyDel(`x402:receipt:intent:${paymentIntentId}`);
    }
    if (keyId) {
      await valkeyDel(`key-payment-intents:${keyId}`);
      await valkeyDel(`key:${keyId}`);
      await valkeyDel(`key:revoked:${keyId}`);
      await valkeySRem(`user-keys:${NETWORK}:${userAddress.toLowerCase()}`, keyId);
    }
    for (const lane of executionLanes) {
      const [rootRunId, executionRunId] = lane.split("\u0000");
      await valkeyDel(`x402:evidence:root:${rootRunId}:execution:${executionRunId}`);
    }
    for (const runId of runIds) {
      await valkeyDel(`x402:evidence:root:${runId}:all`);
    }
    for (const evidenceId of evidenceIds) {
      await valkeyDel(`x402:evidence:charge:${evidenceId}`);
    }
    for (const receiptId of receiptIds) {
      await valkeyDel(`x402:receipt:${receiptId}`);
      await valkeyDel(`x402:receipt:aggregate-applied:${receiptId}`);
    }
    await valkeyDel(`x402:receipt:user:${NETWORK}:${userAddress.toLowerCase()}`);
    await valkeyDel(`x402:receipt:aggregate:${NETWORK}:${userAddress.toLowerCase()}`);
    await closeValkey();
    if (originalEndpoint === undefined) delete process.env.AZURE_MOVZIHPN_ENDPOINT;
    else process.env.AZURE_MOVZIHPN_ENDPOINT = originalEndpoint;
    if (originalKey === undefined) delete process.env.AZURE_MOVZIHPN_API_KEY;
    else process.env.AZURE_MOVZIHPN_API_KEY = originalKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSettlementHash === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
    else process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = originalSettlementHash;
    if (originalSettlementMode === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_MODE;
    else process.env.COMPOSE_TEST_SETTLEMENT_MODE = originalSettlementMode;
    if (originalAllowanceOverride === undefined) delete process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = originalAllowanceOverride;
    if (originalBalanceOverride === undefined) delete process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = originalBalanceOverride;
  }
});
