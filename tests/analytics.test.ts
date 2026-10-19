import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import express from "express";

interface RouteLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

function routes(app: express.Application): Array<{ path: string; methods: string[] }> {
  return (app.router.stack as RouteLayer[])
    .filter((layer): layer is { route: NonNullable<RouteLayer["route"]> } => Boolean(layer.route))
    .map((layer) => ({ path: String(layer.route.path), methods: Object.keys(layer.route.methods || {}) }));
}

test("analytics exposes only the canonical inference endpoint", async () => {
  const { registerAnalyticsRoutes } = await import("../data/analytics/index.js");
  const app = express();
  registerAnalyticsRoutes(app);
  const mounted = routes(app);
  assert.equal(mounted.some((route) => route.path === "/api/analytics/inference" && route.methods.includes("get")), true);
  assert.equal(mounted.some((route) => route.path === "/api/analytics"), false);
});

test("analytics requires the validated wallet session header before storage", async () => {
  const { registerAnalyticsRoutes } = await import("../data/analytics/index.js");
  const app = express();
  registerAnalyticsRoutes(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/analytics/inference`);
    assert.equal(missing.status, 401);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/analytics/inference`, {
      headers: { "x-session-user-address": "not-a-wallet", "x-network-id": "eip155:5042002" },
    });
    assert.equal(malformed.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inference emits neutral telemetry without importing analytics", async () => {
  const gateway = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const events = await readFile(join(process.cwd(), "inference/events.ts"), "utf8");
  assert.doesNotMatch(gateway, /analytics\//);
  assert.doesNotMatch(events, /analytics\//);
  assert.match(gateway, /addInferenceSettlement/);
  assert.match(events, /quote\.telemetry\.metrics/);
  assert.match(events, /quote\.telemetry\.lineItems/);
});

test("analytics has no response capture, receipt seed, or Valkey derivation", async () => {
  for (const file of ["capture.ts", "seed.ts", "valkey.ts"]) {
    await assert.rejects(access(join(process.cwd(), "data/analytics/inference", file)));
  }
  const index = await readFile(join(process.cwd(), "data/analytics/index.ts"), "utf8");
  assert.doesNotMatch(index, /decodeReceiptHeader|listReceipts|capture/);
});

test("analytics storage is request based and excludes provider dimensions", async () => {
  const db = await readFile(join(process.cwd(), "data/analytics/inference/db.ts"), "utf8");
  assert.match(db, /ANALYTICS_DATABASE_URL/);
  assert.doesNotMatch(db, /METRICS_DATABASE_URL/);
  assert.match(db, /inference\.requests/);
  assert.match(db, /inference\.settlements/);
  assert.doesNotMatch(db, /provider TEXT|provider,/);
  assert.doesNotMatch(db, /inference\.events|inference\.attempts/);
});

test("analytics summaries are independent from request and settlement pagination", async () => {
  const aggregate = await readFile(join(process.cwd(), "data/analytics/inference/aggregate.ts"), "utf8");
  const db = await readFile(join(process.cwd(), "data/analytics/inference/db.ts"), "utf8");
  assert.match(aggregate, /rows\.requestAggregates/);
  assert.match(aggregate, /rows\.settlementAggregates/);
  assert.match(db, /requestCursor/);
  assert.match(db, /settlementCursor/);
  assert.match(db, /requestAggregateStatement/);
  assert.match(db, /settlementAggregateStatement/);
  assert.doesNotMatch(db, /allRequests|allSettlements/);
});

test("each settlement projects to one request call while retaining response correlation", async () => {
  const { requestForSettlement } = await import("../data/analytics/inference/db.js");
  const parent = {
    id: "resp_realtime",
    userAddress: `0x${"31".repeat(20)}`,
    responseId: "resp_realtime",
    network: "eip155:5042002",
    family: "google",
    model: "lyria-realtime-exp",
    types: ["realtime"],
    operation: "realtime-music",
    streamed: true,
    status: "succeeded",
    startedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:01:00.000Z",
    latencyMs: 60_000,
    timeToFirstTokenMs: 320,
    usage: { metrics: {}, units: [] },
    billing: { inferenceAmountAtomic: "30", platformFeeAtomic: "2", finalAmountAtomic: "32", currency: "USDC", decimals: 6 },
    settlementIds: ["stl_1", "stl_2"],
  } as const;
  const settlement = (id: string, amount: string) => ({
    id,
    requestId: parent.id,
    network: parent.network,
    family: parent.family,
    model: parent.model,
    types: [...parent.types],
    operation: parent.operation,
    status: "settled" as const,
    pricedUnits: [{ key: "audio_second", unit: "second", quantity: 1, unitPriceUsd: 0.001, amountAtomic: amount }],
    usage: { metrics: { audio_seconds: 1 }, units: [{ key: "audio_second", unit: "second", quantity: 1 }] },
    billing: { inferenceAmountAtomic: amount, platformFeeAtomic: "1", finalAmountAtomic: String(Number(amount) + 1), currency: "USDC" as const, decimals: 6 as const },
    settledAt: "2026-08-08T00:00:01.000Z",
    createdAt: "2026-08-08T00:00:01.000Z",
  });
  const first = requestForSettlement(parent as never, settlement("stl_1", "10"));
  const second = requestForSettlement(parent as never, settlement("stl_2", "20"));
  assert.equal(first.id, "stl_1");
  assert.equal(second.id, "stl_2");
  assert.equal(first.responseId, "resp_realtime");
  assert.equal(second.responseId, "resp_realtime");
  assert.deepEqual(first.settlementIds, ["stl_1"]);
  assert.deepEqual(second.settlementIds, ["stl_2"]);
  assert.equal(first.billing.inferenceAmountAtomic, "10");
  assert.equal(second.billing.inferenceAmountAtomic, "20");
  assert.equal(first.timeToFirstTokenMs, 320);
  assert.equal(second.timeToFirstTokenMs, 320);
});

test("settlement checkpoints retain lifecycle TTFT", async () => {
  const { requestForSettlementCheckpoint } = await import("../data/analytics/inference/db.js");
  const request = requestForSettlementCheckpoint({
    userAddress: `0x${"31".repeat(20)}`,
    startedAt: 1_000,
    firstOutputAt: 1_275,
    request: { responseId: "resp_ttft", stream: true },
  } as never, {
    id: "stl_ttft",
    createdAt: "2026-08-08T00:00:01.000Z",
    network: "eip155:5042002",
    family: "openai",
    model: "gpt-5",
    types: ["text"],
    operation: "responses.create",
    status: "settled",
    usage: { metrics: {}, units: [] },
    billing: { inferenceAmountAtomic: "1", platformFeeAtomic: "0", finalAmountAtomic: "1", currency: "USDC", decimals: 6 },
  } as never);

  assert.equal(request.timeToFirstTokenMs, 275);
});

test("authoritative inference telemetry owns analytics metrics and units", async () => {
  const telemetry = await readFile(join(process.cwd(), "inference/telemetry.ts"), "utf8");
  const events = await readFile(join(process.cwd(), "inference/events.ts"), "utf8");
  assert.match(telemetry, /metrics: Record<string, number>/);
  assert.match(telemetry, /lineItems: Array<MeterLineItem & \{ source:/);
  assert.doesNotMatch(events, /unitFor|originFor|inputText|cachedInputText/);
});

test("inference telemetry preserves submitted payment-intent correlation", async () => {
  const { addInferenceSettlement } = await import("../inference/events.js");
  const lifecycle = {
    id: "resp_analytics_projection",
    userAddress: `0x${"11".repeat(20)}`,
    network: "eip155:5042002",
    startedAt: Date.now(),
    request: {
      model: "openai/gpt-5",
      operation: "responses.create",
    },
    resolved: {
      card: {
        family: "openai",
        type: "text",
      },
    },
    settlements: [],
    metrics: {},
  } as unknown as NonNullable<Parameters<typeof addInferenceSettlement>[0]>;
  const quote = {
    telemetry: {
      metrics: { output_tokens: 1 },
      lineItems: [{ key: "tokens.output", unit: "token", quantity: 1, unitPriceUsd: 0.000001 }],
    },
  } as unknown as Parameters<typeof addInferenceSettlement>[1];

  const recorded = addInferenceSettlement(lifecycle, quote, {
    finalAmountWei: "2",
    providerAmountWei: "1",
    platformFeeWei: "1",
    lineItems: [{ key: "tokens.output", unit: "token", quantity: 1, unitPriceUsd: 0.000001, amountWei: "2" }],
    settlementStatus: "submitted",
    txHash: `0x${"22".repeat(32)}`,
    paymentIntentId: "pi_analytics_projection",
    network: "eip155:5042002",
  }, "receipt_analytics_projection");

  assert.equal(lifecycle.settlements.length, 1);
  assert.equal(recorded?.id, "stl_pi_pi_analytics_projection");
  assert.equal(lifecycle.settlements[0]?.status, "submitted");
  assert.equal(
    (lifecycle.settlements[0] as unknown as { paymentIntentId?: string }).paymentIntentId,
    "pi_analytics_projection",
  );
});

test("inference telemetry falls back to provider family and request shape", async () => {
  const { addInferenceSettlement, startInferenceTelemetry } = await import("../inference/events.js");
  const lifecycle = startInferenceTelemetry({
    userAddress: `0x${"21".repeat(20)}`,
    network: "eip155:5042002",
    request: {
      model: "Ling-3.0-flash",
      modality: "text",
      operation: "chat",
      responseId: "resp_ling_fallback",
      mode: "responses",
      stream: true,
      messages: [],
    },
    resolved: {
      modelId: "Ling-3.0-flash",
      provider: "deepinfra",
      known: true,
      card: {
        modelId: "Ling-3.0-flash",
        name: "Ling 3.0 Flash",
        provider: "deepinfra",
        type: "text generation",
        description: null,
        input: ["text"],
        output: ["text"],
        contextWindow: null,
        pricing: null,
      },
    },
  });
  assert.ok(lifecycle);
  const recorded = addInferenceSettlement(lifecycle, {
    telemetry: {
      metrics: { output_tokens: 1 },
      lineItems: [{ key: "tokens.output", unit: "token", quantity: 1, unitPriceUsd: 0.000001 }],
    },
  } as never, {
    finalAmountWei: "2",
    providerAmountWei: "1",
    platformFeeWei: "1",
    lineItems: [{ key: "tokens.output", unit: "token", quantity: 1, unitPriceUsd: 0.000001, amountWei: "2" }],
    settlementStatus: "submitted",
    paymentIntentId: "pi_ling_fallback",
    network: "eip155:5042002",
  }, "receipt_ling_fallback");
  assert.equal(recorded?.family, "deepinfra");
  assert.deepEqual(recorded?.types, ["text generation"]);
  assert.equal(recorded?.operation, "chat");
});

test("analytics storage persists payment-intent correlation", async () => {
  const db = await readFile(join(process.cwd(), "data/analytics/inference/db.ts"), "utf8");
  const aggregate = await readFile(join(process.cwd(), "data/analytics/inference/aggregate.ts"), "utf8");

  assert.match(db, /payment_intent_id[^]*settlement\.paymentIntentId/);
  assert.match(db, /s\.payment_intent_id/);
  assert.match(aggregate, /paymentIntentId: text\(row\.payment_intent_id\)/);
  assert.match(db, /insertSettlementCheckpoint/);
  assert.match(db, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(db, /id: settlement\.id/);
  assert.match(db, /responseId: lifecycle\.request\.responseId/);
  assert.doesNotMatch(db, /ADD COLUMN|CREATE TABLE/);
});

test("analytics uses one plural multi-network filter contract", async () => {
  const routes = await import("../data/analytics/inference/routes.js") as unknown as {
    parseFilters(query: Record<string, unknown>): { networks?: string[]; settlementStatus?: string };
  };

  assert.deepEqual(
    routes.parseFilters({ networks: "eip155:84532,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }).networks,
    ["eip155:84532", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  );
  assert.equal(routes.parseFilters({}).networks, undefined);
  assert.equal(routes.parseFilters({ settlementStatus: "submitted" }).settlementStatus, "submitted");
  assert.equal(routes.parseFilters({ settlementStatus: "claimed" }).settlementStatus, "claimed");
  assert.throws(() => routes.parseFilters({ network: "eip155:84532" }), /Invalid network filter/);
  assert.throws(() => routes.parseFilters({ networks: "eip155:84532,invalid" }), /Invalid networks/);

  const db = await readFile(join(process.cwd(), "data/analytics/inference/db.ts"), "utf8");
  assert.match(db, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
  assert.match(db, /scope\.network = r\.network/);
  assert.match(db, /scope\.address = r\.user_address/);
  assert.doesNotMatch(db, /input\.network\b/);
});

test("canonical confirmed payment projects to a settled analytics row", async () => {
  const db = await import("../data/analytics/inference/db.js") as unknown as {
    projectCanonicalPaymentIntentSettlement(
      input: {
        paymentIntentId: string;
        status: "confirmed";
        transactionHash: string;
        confirmedAt: number;
      },
      executor: { query(statement: string, params?: unknown[]): Promise<unknown[]> },
    ): Promise<boolean>;
  };
  const calls: Array<{ statement: string; params?: unknown[] }> = [];
  const transactionHash = `0x${"33".repeat(32)}`;
  const confirmedAt = 1_754_044_567_890;

  const projected = await db.projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_confirmed_projection",
    status: "confirmed",
    transactionHash,
    confirmedAt,
  }, {
    async query(statement, params) {
      calls.push({ statement, params });
      return [{ id: "stl_confirmed_projection" }];
    },
  });

  assert.equal(projected, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.statement, /UPDATE inference\.settlements/);
  assert.match(calls[0]!.statement, /status = 'settled'/);
  assert.match(calls[0]!.statement, /transaction_hash = \$2/);
  assert.match(calls[0]!.statement, /settled_at = \$3::timestamptz/);
  assert.deepEqual(calls[0]!.params, [
    "pi_confirmed_projection",
    transactionHash,
    new Date(confirmedAt).toISOString(),
  ]);
});

test("canonical payment projection is not ready before analytics insertion", async () => {
  const { projectCanonicalPaymentIntentSettlement } = await import("../data/analytics/inference/db.js");
  const projected = await projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_projection_not_ready",
    status: "confirmed",
    transactionHash: `0x${"44".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
  }, {
    async query() {
      return [];
    },
  });

  assert.equal(projected, false);
});

test("canonical terminal analytics projection replays idempotently", async () => {
  const { projectCanonicalPaymentIntentSettlement } = await import("../data/analytics/inference/db.js");
  let updates = 0;
  const executor = {
    async query() {
      updates += 1;
      return [{ id: "stl_projection_replay" }];
    },
  };
  const projection = {
    paymentIntentId: "pi_projection_replay",
    status: "confirmed" as const,
    transactionHash: `0x${"55".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
  };

  assert.equal(await projectCanonicalPaymentIntentSettlement(projection, executor), true);
  assert.equal(await projectCanonicalPaymentIntentSettlement(projection, executor), true);
  assert.equal(updates, 2);
});

test("canonical failed payment projects to a failed analytics row", async () => {
  const db = await import("../data/analytics/inference/db.js") as unknown as {
    projectCanonicalPaymentIntentSettlement(
      input: { paymentIntentId: string; status: "failed"; transactionHash?: string },
      executor: { query(statement: string, params?: unknown[]): Promise<unknown[]> },
    ): Promise<boolean>;
  };
  const calls: Array<{ statement: string; params?: unknown[] }> = [];

  const projected = await db.projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_failed_projection",
    status: "failed",
  }, {
    async query(statement, params) {
      calls.push({ statement, params });
      return [{ id: "stl_failed_projection" }];
    },
  });

  assert.equal(projected, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.statement, /status = 'failed'/);
  assert.match(calls[0]!.statement, /transaction_hash = COALESCE\(\$2, transaction_hash\)/);
  assert.match(calls[0]!.statement, /settled_at = NULL/);
  assert.deepEqual(calls[0]!.params, ["pi_failed_projection", null]);
});

test("analytics store exposes the canonical terminal projection", async () => {
  const store = await import("../data/analytics/inference/store.js") as unknown as {
    projectCanonicalPaymentIntentSettlement(
      input: {
        paymentIntentId: string;
        status: "confirmed";
        transactionHash: string;
        confirmedAt: number;
      },
      executor: { query(statement: string, params?: unknown[]): Promise<unknown[]> },
    ): Promise<boolean>;
  };

  const ready = await store.projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_store_projection",
    status: "confirmed",
    transactionHash: `0x${"66".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
  }, {
    async query() {
      return [];
    },
  });

  assert.equal(ready, false);
});

test("canonical projection inserts one missing analytics settlement from x402 intent data", async () => {
  const store = await import("../data/analytics/inference/store.js");
  const inserted: Array<{ lifecycle: Record<string, unknown>; settlement: Record<string, unknown> }> = [];
  const projected = await store.projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_ling_backfill",
    status: "confirmed",
    transactionHash: `0x${"23".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
  }, {
    async query() { return []; },
  }, {
    paymentIntentId: "pi_ling_backfill",
    keyId: "key_ling",
    purpose: "api",
    userAddress: `0x${"24".repeat(20)}`,
    network: "eip155:5042002",
    asset: `0x${"25".repeat(20)}`,
    service: "api",
    action: "inference",
    resource: "https://api.compose.market/v1/responses",
    method: "POST",
    maxAmountWei: "130",
    finalAmountWei: "130",
    status: "confirmed",
    rootRunId: "inference-ling-backfill",
    executionRunId: "inference-ling-backfill",
    sequence: 0,
    meterSubject: "deepinfra:Ling-3.0-flash",
    meterLineItems: [{ key: "tokens.output", unit: "usd_per_1m_tokens", quantity: 100, unitPriceUsd: 0.22, amountWei: "22" }],
    providerAmountWei: "129",
    platformFeeWei: "1",
    txHash: `0x${"23".repeat(32)}`,
    attemptCount: 1,
    createdAt: 1_754_044_500_000,
    updatedAt: 1_754_044_567_890,
    confirmedAt: 1_754_044_567_890,
    credentialExpiresAt: 1_754_144_500_000,
    requestFingerprint: "fingerprint",
  }, async (lifecycle, settlement) => {
    inserted.push({ lifecycle: lifecycle as unknown as Record<string, unknown>, settlement: settlement as unknown as Record<string, unknown> });
  });
  assert.equal(projected, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.settlement.id, "stl_pi_pi_ling_backfill");
  assert.equal(inserted[0]?.settlement.model, "Ling-3.0-flash");
  assert.equal(inserted[0]?.settlement.family, "inclusionai");
});

test("canonical projection projects universal non-catalog metered intents (agent, connector, vibe, banner, workflow) into existing analytics schema", async () => {
  const store = await import("../data/analytics/inference/store.js");
  const agentWallet = `0x${"0a".repeat(20)}`;
  const inserted: Array<{ lifecycle: Record<string, unknown>; settlement: Record<string, unknown> }> = [];
  const projected = await store.projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_agent_backfill",
    status: "confirmed",
    transactionHash: `0x${"44".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
  }, {
    async query() { return []; },
  }, {
    paymentIntentId: "pi_agent_backfill",
    keyId: "key_agent",
    purpose: "session",
    userAddress: `0x${"26".repeat(20)}`,
    network: "eip155:5042002",
    asset: `0x${"25".repeat(20)}`,
    service: "agent",
    action: "stream",
    resource: `https://api.compose.market/agents/${agentWallet}/stream`,
    method: "POST",
    maxAmountWei: "130",
    finalAmountWei: "130",
    status: "confirmed",
    rootRunId: "agent-turn-backfill",
    executionRunId: "agent-turn-backfill",
    sequence: 0,
    meterSubject: `agent:${agentWallet}`,
    meterLineItems: [{ key: "turn", unit: "request", quantity: 1, unitPriceUsd: 0.00013, amountWei: "130" }],
    providerAmountWei: "128",
    platformFeeWei: "2",
    txHash: `0x${"44".repeat(32)}`,
    attemptCount: 1,
    createdAt: 1_754_044_500_000,
    updatedAt: 1_754_044_567_890,
    confirmedAt: 1_754_044_567_890,
    credentialExpiresAt: 1_754_144_500_000,
    requestFingerprint: "fingerprint",
  }, async (lifecycle, settlement) => {
    inserted.push({
      lifecycle: lifecycle as unknown as Record<string, unknown>,
      settlement: settlement as unknown as Record<string, unknown>,
    });
  });
  assert.equal(projected, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.settlement.family, "agent");
  assert.equal(inserted[0]?.settlement.model, agentWallet);
  assert.deepEqual(inserted[0]?.settlement.types, ["agent"]);
  assert.equal(inserted[0]?.settlement.operation, "stream");
  assert.deepEqual(inserted[0]?.settlement.billing, {
    inferenceAmountAtomic: "128",
    platformFeeAtomic: "2",
    finalAmountAtomic: "130",
    currency: "USDC",
    decimals: 6,
  });

  const connectorInserted: Array<{ settlement: Record<string, unknown> }> = [];
  await store.projectCanonicalPaymentIntentSettlement({
    paymentIntentId: "pi_connector_notion",
    status: "confirmed",
    transactionHash: "NearTxHash123",
    confirmedAt: 1_754_044_567_890,
  }, {
    async query() { return []; },
  }, {
    paymentIntentId: "pi_connector_notion",
    keyId: "key_conn",
    purpose: "session",
    userAddress: "0ugdgan4z3s63ndg69mrjs6xqs6xp145z0efgbm7rsxmr5a8q9k1pg",
    network: "near:testnet",
    asset: "usdc.tidepool-sandbox.testnet",
    service: "connector",
    action: "createpage",
    resource: "https://runtime.compose.market/connectors/accounts/execute",
    method: "POST",
    maxAmountWei: "5000",
    finalAmountWei: "5000",
    status: "confirmed",
    rootRunId: "run_1",
    executionRunId: "run_1",
    sequence: 0,
    meterSubject: "account:notion",
    meterLineItems: [{ key: "action", unit: "action", quantity: 1, unitPriceUsd: 0.005, amountWei: "5000" }],
    providerAmountWei: "5000",
    platformFeeWei: "0",
    txHash: "NearTxHash123",
    attemptCount: 1,
    createdAt: 1_754_044_500_000,
    updatedAt: 1_754_044_567_890,
    confirmedAt: 1_754_044_567_890,
    credentialExpiresAt: 1_754_144_500_000,
    requestFingerprint: "fingerprint",
  }, async (_lifecycle, settlement) => {
    connectorInserted.push({ settlement: settlement as unknown as Record<string, unknown> });
  });
  assert.equal(connectorInserted.length, 1);
  assert.equal(connectorInserted[0]?.settlement.family, "connector");
  assert.equal(connectorInserted[0]?.settlement.model, "account:notion");
  assert.deepEqual(connectorInserted[0]?.settlement.types, ["connector"]);
});

test("zero-amount or un-billed payment intents complete their projection without publication", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        complete(input: Record<string, unknown>): Promise<boolean>;
      },
    ): Promise<boolean>;
  };
  const completions: Record<string, unknown>[] = [];

  const completed = await intents.projectCanonicalPaymentIntentAnalytics({
    paymentIntentId: "pi_memory_projection_skip",
    keyId: "key_memory",
    purpose: "session",
    userAddress: `0x${"27".repeat(20)}`,
    network: "eip155:5042002",
    service: "memory",
    action: "remember",
    status: "confirmed",
    txHash: `0x${"45".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
    meterSubject: "memory:remember",
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 0,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  }, {
    async complete(input) {
      completions.push(input);
      return true;
    },
  });

  assert.equal(completed, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.intentId, "pi_memory_projection_skip");
});

test("confirmed canonical Analytics projection updates, invalidates, then clears its obligation", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        project(input: Record<string, unknown>): Promise<boolean>;
        publish(domain: string, address: string, reason: string): Promise<void>;
        complete(input: Record<string, unknown>): Promise<boolean>;
        now(): number;
      },
    ): Promise<boolean>;
  };
  const order: string[] = [];
  const projections: Record<string, unknown>[] = [];
  const completions: Record<string, unknown>[] = [];

  const completed = await intents.projectCanonicalPaymentIntentAnalytics({
    paymentIntentId: "pi_coordinated_projection",
    keyId: "key_projection",
    purpose: "session",
    userAddress: `0x${"77".repeat(20)}`,
    network: "eip155:5042002",
    status: "confirmed",
    txHash: `0x${"88".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 0,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  }, {
    async project(input) {
      order.push("project");
      projections.push(input);
      return true;
    },
    async publish(domain, address, reason) {
      order.push("publish");
      assert.equal(domain, "inference-analytics");
      assert.equal(address, `0x${"77".repeat(20)}`);
      assert.equal(reason, "telemetry");
    },
    async complete(input) {
      order.push("complete");
      completions.push(input);
      return true;
    },
    now: () => 1_754_044_600_000,
  });

  assert.equal(completed, true);
  assert.deepEqual(order, ["project", "publish", "complete"]);
  assert.deepEqual(projections, [{
    paymentIntentId: "pi_coordinated_projection",
    status: "confirmed",
    transactionHash: `0x${"88".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
  }]);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.projectionKey, "payment-intents:projections");
  assert.equal(completions[0]?.intentKey, "payment-intent:pi_coordinated_projection");
  assert.equal(completions[0]?.intentId, "pi_coordinated_projection");
});

test("failed canonical Analytics projection preserves its terminal transaction identity", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        project(input: Record<string, unknown>): Promise<boolean>;
        publish(domain: string, address: string, reason: string): Promise<void>;
        complete(input: Record<string, unknown>): Promise<boolean>;
      },
    ): Promise<boolean>;
  };
  const projections: Record<string, unknown>[] = [];

  const completed = await intents.projectCanonicalPaymentIntentAnalytics({
    paymentIntentId: "pi_failed_coordinated_projection",
    keyId: "key_projection",
    purpose: "session",
    userAddress: `0x${"99".repeat(20)}`,
    network: "eip155:5042002",
    status: "failed",
    txHash: `0x${"aa".repeat(32)}`,
    failedAt: 1_754_044_567_890,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 1,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  }, {
    async project(input) {
      projections.push(input);
      return true;
    },
    async publish() {},
    async complete() {
      return true;
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(projections, [{
    paymentIntentId: "pi_failed_coordinated_projection",
    status: "failed",
    transactionHash: `0x${"aa".repeat(32)}`,
  }]);
});

test("terminal-before-telemetry projection retains its obligation until Analytics is ready", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        project(input: Record<string, unknown>): Promise<boolean>;
        publish(domain: string, address: string, reason: string): Promise<void>;
        complete(input: Record<string, unknown>): Promise<boolean>;
      },
    ): Promise<boolean>;
  };
  const intent = {
    paymentIntentId: "pi_terminal_before_telemetry",
    keyId: "key_projection",
    purpose: "session",
    userAddress: `0x${"bb".repeat(20)}`,
    network: "eip155:5042002",
    status: "confirmed",
    txHash: `0x${"cc".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 2,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  };
  const order: string[] = [];
  let analyticsReady = false;
  const dependencies = {
    async project() {
      order.push("project");
      return analyticsReady;
    },
    async publish() {
      order.push("publish");
    },
    async complete() {
      order.push("complete");
      return true;
    },
  };

  assert.equal(await intents.projectCanonicalPaymentIntentAnalytics(intent, dependencies), false);
  assert.deepEqual(order, ["project"]);

  analyticsReady = true;
  assert.equal(await intents.projectCanonicalPaymentIntentAnalytics(intent, dependencies), true);
  assert.deepEqual(order, ["project", "project", "publish", "complete"]);
});

test("canonical x402 projection hands terminal state to Analytics before completing", async () => {
  const source = await readFile(join(process.cwd(), "x402/intents.ts"), "utf8");
  const start = source.indexOf("export async function reconcileCanonicalPaymentIntentProjections");
  const end = source.indexOf("async function buildBudgetHeaders", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const projection = source.slice(start, end);
  const evidence = projection.lastIndexOf("markIntentEvidence");
  const receipts = projection.lastIndexOf("markIntentReceipts");
  const analytics = projection.indexOf(
    "projectCanonicalPaymentIntentAnalytics(intent, analyticsDependencies)",
  );

  assert.ok(evidence >= 0);
  assert.ok(receipts >= 0);
  assert.ok(analytics > evidence);
  assert.ok(analytics > receipts);
  assert.doesNotMatch(projection, /return valkeyCompletePaymentIntentProjection/);
});

test("Analytics invalidation failure is reported but does not retain a completed projection", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        project(input: Record<string, unknown>): Promise<boolean>;
        publish(domain: string, address: string, reason: string): Promise<void>;
        complete(input: Record<string, unknown>): Promise<boolean>;
        logError(error: unknown): void;
      },
    ): Promise<boolean>;
  };
  const order: string[] = [];
  const errors: unknown[] = [];

  const completed = await intents.projectCanonicalPaymentIntentAnalytics({
    paymentIntentId: "pi_publish_failure",
    keyId: "key_projection",
    purpose: "session",
    userAddress: `0x${"dd".repeat(20)}`,
    network: "eip155:5042002",
    status: "confirmed",
    txHash: `0x${"ee".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 3,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  }, {
    async project() {
      order.push("project");
      return true;
    },
    async publish() {
      order.push("publish");
      throw new Error("broker unavailable");
    },
    async complete() {
      order.push("complete");
      return true;
    },
    logError(error) {
      errors.push(error);
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(order, ["project", "publish", "complete"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /broker unavailable/);
});

test("Analytics storage failure leaves publication and projection completion untouched", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        project(input: Record<string, unknown>): Promise<boolean>;
        publish(domain: string, address: string, reason: string): Promise<void>;
        complete(input: Record<string, unknown>): Promise<boolean>;
      },
    ): Promise<boolean>;
  };
  let published = false;
  let completed = false;
  const intent = {
    paymentIntentId: "pi_analytics_failure",
    keyId: "key_projection",
    purpose: "session",
    userAddress: `0x${"12".repeat(20)}`,
    network: "eip155:5042002",
    status: "confirmed",
    txHash: `0x${"13".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 4,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  };

  await assert.rejects(
    intents.projectCanonicalPaymentIntentAnalytics(intent, {
      async project() {
        throw new Error("Analytics unavailable");
      },
      async publish() {
        published = true;
      },
      async complete() {
        completed = true;
        return true;
      },
    }),
    /Analytics unavailable/,
  );
  assert.equal(published, false);
  assert.equal(completed, false);
});

test("canonical Analytics projection replay remains idempotently complete", async () => {
  const intents = await import("../x402/intents.js") as unknown as {
    projectCanonicalPaymentIntentAnalytics(
      intent: Record<string, unknown>,
      dependencies: {
        project(input: Record<string, unknown>): Promise<boolean>;
        publish(domain: string, address: string, reason: string): Promise<void>;
        complete(input: Record<string, unknown>): Promise<boolean>;
      },
    ): Promise<boolean>;
  };
  let updates = 0;
  let completions = 0;
  const intent = {
    paymentIntentId: "pi_coordinator_replay",
    keyId: "key_projection",
    purpose: "session",
    userAddress: `0x${"14".repeat(20)}`,
    network: "eip155:5042002",
    status: "confirmed",
    txHash: `0x${"15".repeat(32)}`,
    confirmedAt: 1_754_044_567_890,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 5,
    createdAt: 1_754_044_500_000,
    credentialExpiresAt: 1_754_144_500_000,
  };
  const dependencies = {
    async project() {
      updates += 1;
      return true;
    },
    async publish() {},
    async complete() {
      completions += 1;
      return completions === 1;
    },
  };

  assert.equal(await intents.projectCanonicalPaymentIntentAnalytics(intent, dependencies), true);
  assert.equal(await intents.projectCanonicalPaymentIntentAnalytics(intent, dependencies), true);
  assert.equal(updates, 2);
  assert.equal(completions, 2);
});
