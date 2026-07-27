import { query, type Cursor } from "./db.js";
import type {
  AnalyticsResponse, BillingTotals, Breakdown, Filters, LatencyStats, Settlement,
  StoredRequest, TimelineBucket, Totals, UsageUnit,
} from "./types.js";

const DAY = 86_400_000;

export function normalizeFilters(input: Filters): Required<Pick<Filters, "from" | "to" | "interval" | "limit">> & Filters {
  const now = Date.now();
  const to = input.to ? new Date(input.to) : new Date(now);
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * DAY);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw Object.assign(new Error("Invalid analytics time range"), { statusCode: 400 });
  }
  return {
    ...input,
    from: from.toISOString(),
    to: to.toISOString(),
    interval: input.interval ?? (to.getTime() - from.getTime() <= 2 * DAY ? "hour" : "day"),
    limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
  };
}

export async function build(userAddress: string, input: Filters): Promise<AnalyticsResponse> {
  const filters = normalizeFilters(input);
  const rows = await query({
    ...filters,
    userAddress,
    requestCursor: parseCursor(filters.requestCursor),
    settlementCursor: parseCursor(filters.settlementCursor),
  });
  const settlementsByRequest = new Map<string, Settlement[]>();
  for (const settlement of rows.allSettlements) {
    const list = settlementsByRequest.get(settlement.requestId) ?? [];
    list.push(settlement);
    settlementsByRequest.set(settlement.requestId, list);
  }
  return {
    kind: "inference",
    filters,
    totals: totals(rows.allRequests, rows.allSettlements),
    breakdowns: {
      families: group(rows.allRequests, rows.allSettlements, (request) => request.family),
      models: group(rows.allRequests, rows.allSettlements, (request) => request.model).map((entry) => {
        const request = rows.allRequests.find((candidate) => candidate.model === entry.key);
        if (!request) throw new Error(`Missing model dimensions: ${entry.key}`);
        return { ...entry, label: request.family, types: request.types };
      }),
      types: groupMany(rows.allRequests, rows.allSettlements, (request) => request.types),
      operations: group(rows.allRequests, rows.allSettlements, (request) => request.operation),
      statuses: group(rows.allRequests, rows.allSettlements, (request) => request.status),
      settlements: groupSettlements(rows.allSettlements),
    },
    timeline: timeline(rows.allRequests, rows.allSettlements, filters.interval),
    requests: page(rows.requests, filters.limit, (row) => row.startedAt),
    settlements: page(rows.settlements, filters.limit, (row) => row.createdAt),
    updatedAt: new Date().toISOString(),
  };
}

function emptyBilling(): BillingTotals {
  return { inferenceAmountAtomic: "0", platformFeeAtomic: "0", finalAmountAtomic: "0", currency: "USDC", decimals: 6 };
}

function emptyLatency(): LatencyStats {
  return { count: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
}

function emptyTotals(): Totals {
  return { requests: { total: 0, succeeded: 0, failed: 0, aborted: 0, streamed: 0 },
    usage: { metrics: {}, units: [] }, billing: emptyBilling(), latency: emptyLatency() };
}

function totals(requests: StoredRequest[], settlements: Settlement[]): Totals {
  const result = emptyTotals();
  const latencies: number[] = [];
  const units = new Map<string, UsageUnit>();
  for (const request of requests) {
    result.requests.total += 1;
    result.requests[request.status] += 1;
    if (request.streamed) result.requests.streamed += 1;
    latencies.push(request.latencyMs);
    for (const [key, value] of Object.entries(request.usage.metrics)) {
      result.usage.metrics[key] = (result.usage.metrics[key] || 0) + value;
    }
    for (const unit of request.usage.units) {
      const id = `${unit.key}\u0000${unit.unit}`;
      const current = units.get(id);
      units.set(id, current ? { ...current, quantity: current.quantity + unit.quantity } : { ...unit });
    }
  }
  result.usage.units = [...units.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const settlement of settlements) {
    result.billing.inferenceAmountAtomic = add(result.billing.inferenceAmountAtomic, settlement.billing.inferenceAmountAtomic);
    result.billing.platformFeeAtomic = add(result.billing.platformFeeAtomic, settlement.billing.platformFeeAtomic);
    result.billing.finalAmountAtomic = add(result.billing.finalAmountAtomic, settlement.billing.finalAmountAtomic);
  }
  result.latency = latency(latencies);
  return result;
}

function add(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

function latency(values: number[]): LatencyStats {
  if (!values.length) return emptyLatency();
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (percent: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)];
  return { count: sorted.length, averageMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: pick(0.5), p95Ms: pick(0.95), p99Ms: pick(0.99) };
}

function group(requests: StoredRequest[], settlements: Settlement[], keyOf: (request: StoredRequest) => string): Breakdown[] {
  const map = new Map<string, StoredRequest[]>();
  for (const request of requests) map.set(keyOf(request), [...(map.get(keyOf(request)) ?? []), request]);
  return [...map.entries()].map(([key, grouped]) => {
    const ids = new Set(grouped.map((request) => request.id));
    return { key, totals: totals(grouped, settlements.filter((settlement) => ids.has(settlement.requestId))),
      lastAt: grouped.reduce((latest, request) => request.completedAt > latest ? request.completedAt : latest, "") };
  }).sort((a, b) => Number(BigInt(b.totals.billing.finalAmountAtomic) - BigInt(a.totals.billing.finalAmountAtomic)));
}

function groupMany(requests: StoredRequest[], settlements: Settlement[], keysOf: (request: StoredRequest) => string[]): Breakdown[] {
  const map = new Map<string, StoredRequest[]>();
  for (const request of requests) {
    for (const key of keysOf(request)) map.set(key, [...(map.get(key) ?? []), request]);
  }
  return [...map.entries()].map(([key, grouped]) => {
    const ids = new Set(grouped.map((request) => request.id));
    return { key, totals: totals(grouped, settlements.filter((settlement) => ids.has(settlement.requestId))),
      lastAt: grouped.reduce((latest, request) => request.completedAt > latest ? request.completedAt : latest, "") };
  }).sort((a, b) => Number(BigInt(b.totals.billing.finalAmountAtomic) - BigInt(a.totals.billing.finalAmountAtomic)));
}

function groupSettlements(settlements: Settlement[]): Breakdown[] {
  const statuses = new Map<string, Settlement[]>();
  for (const settlement of settlements) statuses.set(settlement.status, [...(statuses.get(settlement.status) ?? []), settlement]);
  return [...statuses.entries()].map(([key, rows]) => ({ key, totals: totals([], rows),
    lastAt: rows.reduce((latest, row) => row.createdAt > latest ? row.createdAt : latest, "") }));
}

function timeline(requests: StoredRequest[], settlements: Settlement[], interval: NonNullable<Filters["interval"]>): TimelineBucket[] {
  const buckets = new Map<string, { requests: StoredRequest[]; settlements: Settlement[] }>();
  const key = (value: string) => {
    const date = new Date(value);
    if (interval === "minute") date.setUTCSeconds(0, 0);
    else if (interval === "hour") date.setUTCMinutes(0, 0, 0);
    else date.setUTCHours(0, 0, 0, 0);
    return date.toISOString();
  };
  for (const request of requests) {
    const start = key(request.startedAt);
    const bucket = buckets.get(start) ?? { requests: [], settlements: [] };
    bucket.requests.push(request); buckets.set(start, bucket);
  }
  for (const settlement of settlements) {
    const start = key(settlement.createdAt);
    const bucket = buckets.get(start) ?? { requests: [], settlements: [] };
    bucket.settlements.push(settlement); buckets.set(start, bucket);
  }
  const duration = interval === "minute" ? 60_000 : interval === "hour" ? 3_600_000 : DAY;
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, bucket]) => ({
    start, end: new Date(new Date(start).getTime() + duration).toISOString(), totals: totals(bucket.requests, bucket.settlements),
  }));
}

function page<T extends { id: string }>(rows: T[], limit: number, at: (row: T) => string) {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return { data, nextCursor: rows.length > limit && last ? formatCursor({ at: at(last), id: last.id }) : null };
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
