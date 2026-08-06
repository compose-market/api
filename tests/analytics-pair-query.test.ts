import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { build } from "../data/analytics/inference/aggregate.js";
import {
  query,
  type AnalyticsReadExecutor,
  type AnalyticsReadStatement,
} from "../data/analytics/inference/db.js";
import { parseFilters } from "../data/analytics/inference/routes.js";
import type { WalletScope } from "../data/user/types.js";

const EVM = `0x${"11".repeat(20)}`;
const SVM = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq";
const EVM_NETWORK = "eip155:5042002" as const;
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const FROM = "2026-07-01T00:00:00.000Z";
const TO = "2026-08-01T00:00:00.000Z";

const SCOPES: WalletScope[] = [
  { network: EVM_NETWORK, address: EVM },
  { network: SVM_NETWORK, address: SVM },
];

test("Analytics network filters are sorted, deduplicated, and default dynamically", () => {
  assert.deepEqual(parseFilters({
    networks: `${SVM_NETWORK},${EVM_NETWORK},${SVM_NETWORK}`,
  }).networks, [EVM_NETWORK, SVM_NETWORK]);
  assert.equal(parseFilters({}).networks, undefined);
  assert.equal(parseFilters({ networks: "" }).networks, undefined);
  assert.throws(() => parseFilters({ network: EVM_NETWORK }), /use networks/);
});

test("Analytics reads use one read-only repeatable-read transaction with zipped scopes", async () => {
  let captured: {
    statements: readonly AnalyticsReadStatement[];
    options: { isolationLevel: "RepeatableRead"; readOnly: true };
  } | undefined;
  const executor: AnalyticsReadExecutor = {
    async transaction(statements, options) {
      captured = { statements, options };
      return [[], [], [], []];
    },
  };

  await query({
    scopes: SCOPES,
    from: FROM,
    to: TO,
    interval: "day",
    limit: 50,
    family: "openai",
    settlementStatus: "settled",
  }, executor);

  assert.ok(captured);
  assert.deepEqual(captured.options, { isolationLevel: "RepeatableRead", readOnly: true });
  assert.equal(captured.statements.length, 4);
  for (const statement of captured.statements) {
    assert.deepEqual(statement.params.slice(0, 2), [
      [EVM_NETWORK, SVM_NETWORK],
      [EVM, SVM],
    ]);
    assert.match(statement.text, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
    assert.match(statement.text, /scope\.network = [rs]\.network/);
    assert.match(statement.text, /scope\.address = [rs]\.user_address/);
    assert.doesNotMatch(statement.text, /lower\s*\(/i);
    assert.doesNotMatch(statement.text, /SELECT\s+\*/i);
    assert.doesNotMatch(statement.text, /\b(?:CREATE|ALTER|DROP)\b/i);
  }

  assert.match(captured.statements[0]!.text, /percentile_disc/i);
  assert.match(captured.statements[0]!.text, /jsonb_each_text/i);
  assert.match(captured.statements[1]!.text, /SUM\(final_amount_atomic\)/i);
  assert.match(captured.statements[1]!.text, /request_in_range/);
  assert.match(captured.statements[1]!.text, /WHERE s\.request_in_range/);
  assert.match(captured.statements[2]!.text, /LIMIT \$/i);
  assert.match(captured.statements[3]!.text, /LIMIT \$/i);
  assert.match(captured.statements[0]!.text, /r\.started_at <= \$/);
  assert.match(captured.statements[1]!.text, /s\.created_at <= \$/);
});

test("compact Analytics rows map to the existing response without raw fact aggregation", async () => {
  let resolvedAddress: string | undefined;
  let resolvedNetworks: readonly string[] | undefined;
  const response = await build(EVM.toUpperCase().replace("0X", "0x"), {
    networks: [SVM_NETWORK, EVM_NETWORK],
    from: FROM,
    to: TO,
    interval: "day",
    limit: 1,
  }, {
    resolveScopes: async (address, networks) => {
      resolvedAddress = address;
      resolvedNetworks = networks;
      return SCOPES;
    },
    queryRows: async (input) => {
      assert.deepEqual(input.scopes, SCOPES);
      return {
        requestAggregates: [
          {
            kind: "total", key: "", total_requests: 2, succeeded_requests: 1,
            failed_requests: 1, aborted_requests: 0, streamed_requests: 1,
            metrics: { output_tokens: 5 },
            units: [{ key: "tokens.output", unit: "token", quantity: 5 }],
            latency_count: 2, average_ms: 15, p50_ms: 10, p95_ms: 20, p99_ms: 20,
            last_at: TO, order_at: TO,
          },
          {
            kind: "family", key: "openai", total_requests: 2, succeeded_requests: 1,
            failed_requests: 1, aborted_requests: 0, streamed_requests: 1,
            metrics: { output_tokens: 5 },
            units: [{ key: "tokens.output", unit: "token", quantity: 5 }],
            latency_count: 2, average_ms: 15, p50_ms: 10, p95_ms: 20, p99_ms: 20,
            last_at: TO, order_at: TO,
          },
          {
            kind: "timeline", key: "2026-07-31T00:00:00.000Z", total_requests: 2,
            succeeded_requests: 1, failed_requests: 1, aborted_requests: 0,
            streamed_requests: 1, metrics: { output_tokens: 5 },
            units: [{ key: "tokens.output", unit: "token", quantity: 5 }],
            latency_count: 2, average_ms: 15, p50_ms: 10, p95_ms: 20, p99_ms: 20,
            last_at: TO, order_at: TO,
          },
        ],
        settlementAggregates: [
          { kind: "total", key: "", inference_amount_atomic: "20", platform_fee_atomic: "2", final_amount_atomic: "22", last_at: TO },
          { kind: "family", key: "openai", inference_amount_atomic: "20", platform_fee_atomic: "2", final_amount_atomic: "22", last_at: TO },
          { kind: "settlement", key: "settled", inference_amount_atomic: "20", platform_fee_atomic: "2", final_amount_atomic: "22", last_at: TO },
          { kind: "timeline", key: "2026-07-31T00:00:00.000Z", inference_amount_atomic: "20", platform_fee_atomic: "2", final_amount_atomic: "22", last_at: TO },
        ],
        requests: [
          {
            id: "req_2", user_address: EVM, response_id: "resp_2", network: EVM_NETWORK,
            family: "openai", model: "gpt-5", types: ["text"], operation: "responses.create",
            streamed: true, status: "succeeded", started_at: TO, completed_at: TO,
            latency_ms: 10, time_to_first_token_ms: 2,
            usage: { metrics: { output_tokens: 5 }, units: [{ key: "tokens.output", unit: "token", quantity: 5 }] },
            inference_amount_atomic: "20", platform_fee_atomic: "2", final_amount_atomic: "22",
            settlement_ids: ["stl_2"], error: null,
          },
          {
            id: "req_1", user_address: SVM, response_id: "resp_1", network: SVM_NETWORK,
            family: "openai", model: "gpt-5", types: ["text"], operation: "responses.create",
            streamed: false, status: "failed", started_at: FROM, completed_at: FROM,
            latency_ms: 20, time_to_first_token_ms: null,
            usage: { metrics: {}, units: [] }, inference_amount_atomic: "0",
            platform_fee_atomic: "0", final_amount_atomic: "0", settlement_ids: [],
            error: { code: "failed", message: "failed" },
          },
        ],
        settlements: [
          {
            id: "stl_2", request_id: "req_2", network: EVM_NETWORK, family: "openai",
            model: "gpt-5", types: ["text"], operation: "responses.create", status: "settled",
            payment_intent_id: "pi_2", transaction_hash: "0xabc", claim_transaction_hash: null,
            settle_transaction_hash: null,
            priced_units: [{ key: "tokens.output", unit: "token", quantity: 5, unitPriceUsd: 1, amountAtomic: "20" }],
            inference_amount_atomic: "20", platform_fee_atomic: "2", final_amount_atomic: "22",
            settled_at: TO, created_at: TO,
          },
          {
            id: "stl_1", request_id: "req_1", network: SVM_NETWORK, family: "openai",
            model: "gpt-5", types: ["text"], operation: "responses.create", status: "failed",
            payment_intent_id: null, transaction_hash: null, claim_transaction_hash: null,
            settle_transaction_hash: null, priced_units: [], inference_amount_atomic: "0",
            platform_fee_atomic: "0", final_amount_atomic: "0", settled_at: null, created_at: FROM,
          },
        ],
      };
    },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });

  assert.equal(resolvedAddress, EVM);
  assert.deepEqual(resolvedNetworks, [EVM_NETWORK, SVM_NETWORK]);
  assert.equal(response.kind, "inference");
  assert.equal(response.totals.requests.total, 2);
  assert.deepEqual(response.totals.usage.metrics, { output_tokens: 5 });
  assert.equal(response.totals.billing.finalAmountAtomic, "22");
  assert.equal(response.breakdowns.families[0]?.key, "openai");
  assert.equal(response.breakdowns.families[0]?.totals.billing.finalAmountAtomic, "22");
  assert.equal(response.breakdowns.settlements[0]?.key, "settled");
  assert.equal(response.timeline[0]?.totals.requests.total, 2);
  assert.equal(response.timeline[0]?.totals.billing.finalAmountAtomic, "22");
  assert.equal(response.requests.data.length, 1);
  assert.ok(response.requests.nextCursor);
  assert.equal(response.settlements.data.length, 1);
  assert.ok(response.settlements.nextCursor);
  assert.equal(response.updatedAt, "2026-08-02T12:00:00.000Z");
});

test("Analytics database source contains no request-time DDL or unbounded raw selects", async () => {
  const source = await readFile(join(process.cwd(), "data/analytics/inference/db.ts"), "utf8");
  assert.doesNotMatch(source, /\b(?:CREATE|ALTER|DROP)\s+(?:SCHEMA|TABLE|INDEX|COLUMN)/i);
  assert.doesNotMatch(source, /\b(?:ensure|migrate)\s*\(/);
  assert.doesNotMatch(source, /SELECT\s+\*/i);
  assert.doesNotMatch(source, /allRequests|allSettlements/);
});

test("telemetry invalidation is published only after durable Analytics insertion", async () => {
  const { record } = await import("../data/analytics/inference/store.js");
  const order: string[] = [];
  const request = { userAddress: EVM } as Parameters<typeof record>[0];
  const settlements = [] as Parameters<typeof record>[1];

  await record(request, settlements, {
    insert: async () => { order.push("insert"); },
    publish: async (domain, address, reason) => {
      order.push("publish");
      assert.equal(domain, "inference-analytics");
      assert.equal(address, EVM);
      assert.equal(reason, "telemetry");
    },
  });
  assert.deepEqual(order, ["insert", "publish"]);

  await assert.doesNotReject(record(request, settlements, {
    insert: async () => undefined,
    publish: async () => { throw new Error("broker unavailable"); },
    logError: () => undefined,
  }));
});

test("Analytics request logging records compact counts and bytes, never the full body", async () => {
  const source = await readFile(join(process.cwd(), "index.ts"), "utf8");
  assert.match(source, /analyticsResponseStats/);
  assert.match(source, /aggregateRows/);
  assert.match(source, /requestRows/);
  assert.match(source, /settlementRows/);
  assert.match(source, /responseBytes/);
  assert.match(source, /Buffer\.byteLength/);
  assert.match(source, /path === "\/api\/analytics\/inference"/);
});
