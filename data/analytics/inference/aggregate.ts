import { createHash } from "node:crypto";
import { cached, cacheVersion } from "../../../cache.js";
import { query, type Cursor, type QueryInput, type QueryResult } from "./db.js";
import type {
  AnalyticsResponse, BillingTotals, Breakdown, Filters, LatencyStats, Settlement,
  StoredRequest, TimelineBucket, Totals, UsageUnit,
} from "./types.js";
import { resolveWalletScopes } from "../../user/scopes.js";
import type { NetworkId } from "../../../x402/configs/chains.js";
import type { WalletScope } from "../../user/types.js";

const DAY = 86_400_000;

type Row = Record<string, unknown>;

export interface AnalyticsBuildDependencies {
  resolveScopes?: (address: string, networks?: readonly NetworkId[]) => Promise<WalletScope[]>;
  queryRows?: (input: QueryInput) => Promise<QueryResult>;
  now?: () => Date;
}

export function normalizeFilters(input: Filters): Required<Pick<Filters, "from" | "to" | "interval" | "limit">> & Filters {
  const quantizedNow = Math.ceil(Date.now() / 60_000) * 60_000;
  const to = input.to ? new Date(input.to) : new Date(quantizedNow);
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * DAY);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw Object.assign(new Error("Invalid analytics time range"), { statusCode: 400 });
  }
  const networks = input.networks?.length
    ? [...new Set(input.networks)].sort() as NetworkId[]
    : undefined;
  return {
    ...input,
    networks,
    from: from.toISOString(),
    to: to.toISOString(),
    interval: input.interval ?? (to.getTime() - from.getTime() <= 2 * DAY ? "hour" : "day"),
    limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
  };
}

function analyticsOwnerKey(address: string): string {
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : address;
}

export async function build(
  userAddress: string,
  input: Filters,
  dependencies: AnalyticsBuildDependencies = {},
): Promise<AnalyticsResponse> {
  const filters = normalizeFilters(input);
  const compute = async (): Promise<AnalyticsResponse> => {
    const resolveScopes = dependencies.resolveScopes ?? resolveWalletScopes;
    const queryRows = dependencies.queryRows ?? query;
    const scopes = await resolveScopes(userAddress, filters.networks);
    const { networks: _networks, requestCursor, settlementCursor, ...queryFilters } = filters;
    const rows = await queryRows({
      ...queryFilters,
      scopes,
      requestCursor: parseCursor(requestCursor),
      settlementCursor: parseCursor(settlementCursor),
    });
    return assemble(filters, rows, dependencies.now?.() ?? new Date());
  };

  if (dependencies.resolveScopes || dependencies.queryRows || dependencies.now) {
    return compute();
  }

  const owner = analyticsOwnerKey(userAddress);
  const version = await cacheVersion(`inference-analytics:${owner}`);
  const fingerprint = createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 24);
  return cached(`analytics:${owner}:v${version}:${fingerprint}`, 60, 15_000, compute);
}

function emptyBilling(): BillingTotals {
  return { inferenceAmountAtomic: "0", platformFeeAtomic: "0", finalAmountAtomic: "0", currency: "USDC", decimals: 6 };
}

function emptyLatency(): LatencyStats {
  return { count: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
}

function emptyTotals(): Totals {
  return {
    requests: { total: 0, succeeded: 0, failed: 0, aborted: 0, streamed: 0 },
    usage: { metrics: {}, units: [] },
    billing: emptyBilling(),
    latency: emptyLatency(),
  };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, quantity]) => [key, number(quantity)]),
  );
}

function units(value: unknown): UsageUnit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.key !== "string" || typeof row.unit !== "string") return [];
    return [{ key: row.key, unit: row.unit, quantity: number(row.quantity) }];
  }).sort((left, right) => left.key.localeCompare(right.key) || left.unit.localeCompare(right.unit));
}

function requestTotals(row?: Row): Totals {
  if (!row) return emptyTotals();
  return {
    requests: {
      total: number(row.total_requests),
      succeeded: number(row.succeeded_requests),
      failed: number(row.failed_requests),
      aborted: number(row.aborted_requests),
      streamed: number(row.streamed_requests),
    },
    usage: { metrics: metrics(row.metrics), units: units(row.units) },
    billing: emptyBilling(),
    latency: {
      count: number(row.latency_count),
      averageMs: number(row.average_ms),
      p50Ms: number(row.p50_ms),
      p95Ms: number(row.p95_ms),
      p99Ms: number(row.p99_ms),
    },
  };
}

function settlementBilling(row?: Row): BillingTotals {
  if (!row) return emptyBilling();
  return {
    inferenceAmountAtomic: String(row.inference_amount_atomic ?? "0"),
    platformFeeAtomic: String(row.platform_fee_atomic ?? "0"),
    finalAmountAtomic: String(row.final_amount_atomic ?? "0"),
    currency: "USDC",
    decimals: 6,
  };
}

function aggregateKey(kind: unknown, key: unknown): string {
  return `${String(kind)}\u0000${String(key)}`;
}

function billingMap(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [aggregateKey(row.kind, row.key), row]));
}

function withBilling(totals: Totals, billing?: Row): Totals {
  return { ...totals, billing: settlementBilling(billing) };
}

function compareBilling(left: Breakdown & { orderAt?: string }, right: Breakdown & { orderAt?: string }): number {
  const leftAmount = BigInt(left.totals.billing.finalAmountAtomic);
  const rightAmount = BigInt(right.totals.billing.finalAmountAtomic);
  if (leftAmount !== rightAmount) return leftAmount > rightAmount ? -1 : 1;
  const byRecency = (right.orderAt ?? "").localeCompare(left.orderAt ?? "");
  return byRecency || left.key.localeCompare(right.key);
}

function requestBreakdowns(
  kind: "family" | "model" | "type" | "operation" | "status",
  requestRows: Row[],
  settlements: Map<string, Row>,
): Breakdown[] {
  return requestRows
    .filter((row) => row.kind === kind)
    .map((row) => {
      const key = String(row.key);
      const entry: Breakdown & { orderAt?: string } = {
        key,
        totals: withBilling(requestTotals(row), settlements.get(aggregateKey(kind, key))),
        lastAt: text(row.last_at),
        orderAt: text(row.order_at),
      };
      if (kind === "model") {
        entry.label = text(row.label);
        entry.types = Array.isArray(row.types) ? row.types.map(String) : [];
      }
      return entry;
    })
    .sort(compareBilling)
    .map(({ orderAt: _orderAt, ...entry }) => entry);
}

function settlementBreakdowns(rows: Row[]): Breakdown[] {
  return rows
    .filter((row) => row.kind === "settlement")
    .map((row) => ({
      key: String(row.key),
      totals: withBilling(emptyTotals(), row),
      lastAt: text(row.last_at),
    }))
    .sort((left, right) => (right.lastAt ?? "").localeCompare(left.lastAt ?? "") || left.key.localeCompare(right.key));
}

function timeline(
  requestRows: Row[],
  settlementRows: Row[],
  interval: NonNullable<Filters["interval"]>,
): TimelineBucket[] {
  const requests = new Map(
    requestRows.filter((row) => row.kind === "timeline").map((row) => [String(row.key), row]),
  );
  const settlements = new Map(
    settlementRows.filter((row) => row.kind === "timeline").map((row) => [String(row.key), row]),
  );
  const duration = interval === "minute" ? 60_000 : interval === "hour" ? 3_600_000 : DAY;
  return [...new Set([...requests.keys(), ...settlements.keys()])]
    .sort()
    .map((start) => ({
      start,
      end: new Date(new Date(start).getTime() + duration).toISOString(),
      totals: withBilling(requestTotals(requests.get(start)), settlements.get(start)),
    }));
}

function mapRequest(row: Row): StoredRequest {
  return {
    id: String(row.id),
    userAddress: String(row.user_address),
    responseId: String(row.response_id),
    network: String(row.network) as StoredRequest["network"],
    family: String(row.family),
    model: String(row.model),
    types: Array.isArray(row.types) ? row.types.map(String) : [],
    operation: String(row.operation),
    streamed: Boolean(row.streamed),
    status: String(row.status) as StoredRequest["status"],
    startedAt: text(row.started_at)!,
    completedAt: text(row.completed_at)!,
    latencyMs: number(row.latency_ms),
    timeToFirstTokenMs: row.time_to_first_token_ms == null ? undefined : number(row.time_to_first_token_ms),
    usage: row.usage as StoredRequest["usage"],
    billing: {
      inferenceAmountAtomic: String(row.inference_amount_atomic),
      platformFeeAtomic: String(row.platform_fee_atomic),
      finalAmountAtomic: String(row.final_amount_atomic),
      currency: "USDC",
      decimals: 6,
    },
    settlementIds: Array.isArray(row.settlement_ids) ? row.settlement_ids.map(String) : [],
    error: row.error && typeof row.error === "object" ? row.error as StoredRequest["error"] : undefined,
  };
}

function mapSettlement(row: Row): Settlement {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    network: String(row.network) as Settlement["network"],
    family: String(row.family),
    model: String(row.model),
    types: Array.isArray(row.types) ? row.types.map(String) : [],
    operation: String(row.operation),
    status: String(row.status) as Settlement["status"],
    transactionHash: text(row.transaction_hash),
    claimTransactionHash: text(row.claim_transaction_hash),
    settleTransactionHash: text(row.settle_transaction_hash),
    paymentIntentId: text(row.payment_intent_id),
    pricedUnits: Array.isArray(row.priced_units) ? row.priced_units as Settlement["pricedUnits"] : [],
    billing: {
      inferenceAmountAtomic: String(row.inference_amount_atomic),
      platformFeeAtomic: String(row.platform_fee_atomic),
      finalAmountAtomic: String(row.final_amount_atomic),
      currency: "USDC",
      decimals: 6,
    },
    settledAt: text(row.settled_at),
    createdAt: text(row.created_at)!,
  };
}

function page<T extends { id: string }>(rows: T[], limit: number, at: (row: T) => string) {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    nextCursor: rows.length > limit && last ? formatCursor({ at: at(last), id: last.id }) : null,
  };
}

function assemble(
  filters: ReturnType<typeof normalizeFilters>,
  rows: QueryResult,
  updatedAt: Date,
): AnalyticsResponse {
  const settlements = billingMap(rows.settlementAggregates);
  const requestTotal = rows.requestAggregates.find((row) => row.kind === "total");
  const settlementTotal = settlements.get(aggregateKey("total", ""));
  const requests = rows.requests.map(mapRequest);
  const settlementPage = rows.settlements.map(mapSettlement);

  return {
    kind: "inference",
    filters,
    totals: withBilling(requestTotals(requestTotal), settlementTotal),
    breakdowns: {
      families: requestBreakdowns("family", rows.requestAggregates, settlements),
      models: requestBreakdowns("model", rows.requestAggregates, settlements),
      types: requestBreakdowns("type", rows.requestAggregates, settlements),
      operations: requestBreakdowns("operation", rows.requestAggregates, settlements),
      statuses: requestBreakdowns("status", rows.requestAggregates, settlements),
      settlements: settlementBreakdowns(rows.settlementAggregates),
    },
    timeline: timeline(rows.requestAggregates, rows.settlementAggregates, filters.interval),
    requests: page(requests, filters.limit, (row) => row.startedAt),
    settlements: page(settlementPage, filters.limit, (row) => row.createdAt),
    updatedAt: updatedAt.toISOString(),
  };
}

function formatCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (parsed.id && Number.isFinite(new Date(parsed.at).getTime())) return parsed;
  } catch { /* invalid cursor */ }
  throw Object.assign(new Error("Invalid analytics cursor"), { statusCode: 400 });
}
