import type { NetworkId } from "../../../x402/configs/chains.js";

export type RequestStatus = "succeeded" | "failed" | "aborted";
export type SettlementStatus = "queued" | "submitted" | "settled" | "failed";
export type Interval = "minute" | "hour" | "day";

export interface Filters {
  networks?: NetworkId[];
  family?: string;
  model?: string;
  type?: string;
  operation?: string;
  status?: RequestStatus;
  settlementStatus?: SettlementStatus;
  from?: string;
  to?: string;
  interval?: Interval;
  limit?: number;
  requestCursor?: string;
  settlementCursor?: string;
}

export interface UsageUnit {
  key: string;
  unit: string;
  quantity: number;
}

export interface UsageTotals {
  metrics: Record<string, number>;
  units: UsageUnit[];
}

export interface BillingTotals {
  inferenceAmountAtomic: string;
  platformFeeAtomic: string;
  finalAmountAtomic: string;
  currency: "USDC";
  decimals: 6;
}

export interface RequestTotals {
  total: number;
  succeeded: number;
  failed: number;
  aborted: number;
  streamed: number;
}

export interface LatencyStats {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface Totals {
  requests: RequestTotals;
  usage: UsageTotals;
  billing: BillingTotals;
  latency: LatencyStats;
}

export interface Breakdown {
  key: string;
  label?: string;
  types?: string[];
  totals: Totals;
  lastAt?: string;
}

export interface TimelineBucket {
  start: string;
  end: string;
  totals: Totals;
}

export interface PricedUnit extends UsageUnit {
  unitPriceUsd: number;
  amountAtomic: string;
}

export interface Settlement {
  id: string;
  requestId: string;
  network: NetworkId;
  family: string;
  model: string;
  types: string[];
  operation: string;
  status: SettlementStatus;
  transactionHash?: string;
  claimTransactionHash?: string;
  settleTransactionHash?: string;
  paymentIntentId?: string;
  pricedUnits: PricedUnit[];
  billing: BillingTotals;
  settledAt?: string;
  createdAt: string;
}

export interface RequestRecord {
  id: string;
  responseId: string;
  network: NetworkId;
  family: string;
  model: string;
  types: string[];
  operation: string;
  streamed: boolean;
  status: RequestStatus;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  usage: UsageTotals;
  billing: BillingTotals;
  settlementIds: string[];
  error?: { code: string; message: string };
}

export interface StoredRequest extends RequestRecord {
  userAddress: string;
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface AnalyticsResponse {
  kind: "inference";
  filters: Filters;
  totals: Totals;
  breakdowns: {
    families: Breakdown[];
    models: Breakdown[];
    types: Breakdown[];
    operations: Breakdown[];
    statuses: Breakdown[];
    settlements: Breakdown[];
  };
  timeline: TimelineBucket[];
  requests: CursorPage<RequestRecord>;
  settlements: CursorPage<Settlement>;
  updatedAt: string;
}
