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

  addInferenceSettlement(lifecycle, quote, {
    finalAmountWei: "2",
    providerAmountWei: "1",
    platformFeeWei: "1",
    lineItems: [{ key: "tokens.output", unit: "token", quantity: 1, unitPriceUsd: 0.000001, amountWei: "2" }],
    settlementStatus: "submitted",
    txHash: `0x${"22".repeat(32)}`,
    paymentIntentId: "pi_analytics_projection",
    network: "eip155:5042002",
  });

  assert.equal(lifecycle.settlements.length, 1);
  assert.equal(lifecycle.settlements[0]?.status, "submitted");
  assert.equal(
    (lifecycle.settlements[0] as unknown as { paymentIntentId?: string }).paymentIntentId,
    "pi_analytics_projection",
  );
});

test("analytics storage persists payment-intent correlation", async () => {
  const db = await readFile(join(process.cwd(), "data/analytics/inference/db.ts"), "utf8");
  const aggregate = await readFile(join(process.cwd(), "data/analytics/inference/aggregate.ts"), "utf8");

  assert.match(db, /payment_intent_id[^]*settlement\.paymentIntentId/);
  assert.match(db, /s\.payment_intent_id/);
  assert.match(aggregate, /paymentIntentId: text\(row\.payment_intent_id\)/);
  assert.doesNotMatch(db, /ADD COLUMN|CREATE TABLE/);
});

test("analytics uses one plural multi-network filter contract", async () => {
  const routes = await import("../data/analytics/inference/routes.js") as unknown as {
    parseFilters(query: Record<string, unknown>): { networks?: string[]; settlementStatus?: string };
  };

  assert.deepEqual(
    routes.parseFilters({ networks: "eip155:5042002,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }).networks,
    ["eip155:5042002", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
  );
  assert.equal(routes.parseFilters({}).networks, undefined);
  assert.equal(routes.parseFilters({ settlementStatus: "submitted" }).settlementStatus, "submitted");
  assert.throws(() => routes.parseFilters({ network: "eip155:5042002" }), /Invalid network filter/);
  assert.throws(() => routes.parseFilters({ networks: "eip155:5042002,invalid" }), /Invalid networks/);
  assert.throws(() => routes.parseFilters({ settlementStatus: "claimed" }), /Invalid settlementStatus/);

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
