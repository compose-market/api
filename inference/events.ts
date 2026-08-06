import { randomUUID } from "node:crypto";
import type { InferenceSettlementReceipt } from "../x402/index.js";
import type { Request } from "./core.js";
import type { ResolvedModel } from "./catalog/registry.js";
import type { MeteredModelQuote } from "../x402/metering.js";
import type { NetworkId } from "../x402/configs/chains.js";

export type InferenceRequestStatus = "succeeded" | "failed" | "aborted";

export interface InferenceBillingTotals {
  inferenceAmountAtomic: string;
  platformFeeAtomic: string;
  finalAmountAtomic: string;
  currency: "USDC";
  decimals: 6;
}

export interface InferencePricedUnit {
  key: string;
  unit: string;
  quantity: number;
  unitPriceUsd: number;
  amountAtomic: string;
}

export interface InferenceSettlementTelemetry {
  id: string;
  requestId: string;
  network: NetworkId;
  family: string;
  model: string;
  types: string[];
  operation: string;
  status: "queued" | "submitted" | "claimed" | "settled" | "failed";
  transactionHash?: string;
  claimTransactionHash?: string;
  settleTransactionHash?: string;
  paymentIntentId?: string;
  pricedUnits: InferencePricedUnit[];
  billing: InferenceBillingTotals;
  settledAt?: string;
  createdAt: string;
}

export interface InferenceRequestTelemetry {
  id: string;
  userAddress: string;
  responseId: string;
  network: NetworkId;
  family: string;
  model: string;
  types: string[];
  operation: string;
  streamed: boolean;
  status: InferenceRequestStatus;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  usage: { metrics: Record<string, number>; units: Array<Omit<InferencePricedUnit, "unitPriceUsd" | "amountAtomic">> };
  billing: InferenceBillingTotals;
  settlementIds: string[];
  error?: { code: string; message: string };
}

export interface InferenceTelemetryLifecycle {
  id: string;
  userAddress: string;
  network: NetworkId;
  startedAt: number;
  firstOutputAt?: number;
  request: Request;
  resolved: ResolvedModel;
  settlements: InferenceSettlementTelemetry[];
  metrics: Record<string, number>;
}

export interface InferenceTelemetryRecord {
  request: InferenceRequestTelemetry;
  settlements: InferenceSettlementTelemetry[];
}

type Sink = (record: InferenceTelemetryRecord) => Promise<void>;
let sink: Sink | undefined;

export function setInferenceTelemetrySink(next: Sink): void {
  if (sink) throw new Error("Inference telemetry sink is already registered");
  sink = next;
}

export function startInferenceTelemetry(args: {
  userAddress?: string;
  network?: NetworkId;
  request: Request;
  resolved: ResolvedModel;
}): InferenceTelemetryLifecycle | null {
  const userAddress = args.userAddress?.trim();
  if (!userAddress || !args.network) return null;
  const family = args.resolved.card?.family;
  const type = args.resolved.card?.type;
  const operation = args.request.operation;
  if (!family || !type || (Array.isArray(type) && type.length === 0) || !operation) return null;
  return { id: args.request.responseId, userAddress, network: args.network, startedAt: Date.now(),
    request: args.request, resolved: args.resolved, settlements: [], metrics: {} };
}

export function markInferenceFirstOutput(lifecycle: InferenceTelemetryLifecycle | null): void {
  if (lifecycle && lifecycle.firstOutputAt === undefined) lifecycle.firstOutputAt = Date.now();
}

export function addInferenceSettlement(
  lifecycle: InferenceTelemetryLifecycle | null,
  quote: MeteredModelQuote,
  settlement: InferenceSettlementReceipt | null,
): void {
  if (!lifecycle || !settlement || !quote.telemetry) return;
  if (!settlement.lineItems || settlement.lineItems.length !== quote.telemetry.lineItems.length) return;
  const family = lifecycle.resolved.card?.family;
  const types = lifecycle.resolved.card?.type;
  const operation = lifecycle.request.operation;
  if (!family || !types || (Array.isArray(types) && types.length === 0) || !operation) return;
  for (const [key, value] of Object.entries(quote.telemetry.metrics)) {
    lifecycle.metrics[key] = (lifecycle.metrics[key] || 0) + value;
  }
  lifecycle.settlements.push({
    id: `stl_${randomUUID().replace(/-/gu, "")}`,
    requestId: lifecycle.id,
    network: lifecycle.network,
    family,
    model: lifecycle.request.model,
    types: Array.isArray(types) ? types : [types],
    operation,
    status: settlement.settlementStatus ?? "queued",
    transactionHash: settlement.txHash,
    claimTransactionHash: settlement.claimTxHash,
    settleTransactionHash: settlement.settleTxHash,
    paymentIntentId: settlement.paymentIntentId,
    pricedUnits: quote.telemetry.lineItems.map((item, index) => ({
      key: item.key,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceUsd: item.unitPriceUsd,
      amountAtomic: settlement.lineItems![index].amountWei,
    })),
    billing: billing(settlement),
    ...(settlement.settledAt !== undefined
      ? { settledAt: new Date(settlement.settledAt).toISOString() }
      : {}),
    createdAt: new Date().toISOString(),
  });
}

export async function finishInferenceTelemetry(
  lifecycle: InferenceTelemetryLifecycle | null,
  status: InferenceRequestStatus,
  error?: unknown,
): Promise<void> {
  if (!lifecycle || !sink) return;
  const family = lifecycle.resolved.card?.family;
  const type = lifecycle.resolved.card?.type;
  const operation = lifecycle.request.operation;
  if (!family || !type || (Array.isArray(type) && type.length === 0) || !operation) return;
  const completedAt = Date.now();
  const usage: InferenceRequestTelemetry["usage"] = {
    metrics: lifecycle.metrics,
    units: lifecycle.settlements.flatMap((settlement) => settlement.pricedUnits.map(({ unitPriceUsd: _, amountAtomic: __, ...unit }) => unit)),
  };
  const request: InferenceRequestTelemetry = {
    id: lifecycle.id,
    userAddress: lifecycle.userAddress,
    responseId: lifecycle.request.responseId,
    network: lifecycle.network,
    family,
    model: lifecycle.request.model,
    types: Array.isArray(type) ? type : [type],
    operation,
    streamed: lifecycle.request.stream,
    status,
    startedAt: new Date(lifecycle.startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    latencyMs: completedAt - lifecycle.startedAt,
    timeToFirstTokenMs: lifecycle.firstOutputAt === undefined ? undefined : lifecycle.firstOutputAt - lifecycle.startedAt,
    usage,
    billing: lifecycle.settlements.reduce<InferenceBillingTotals>((total, settlement) => ({ ...total,
      inferenceAmountAtomic: add(total.inferenceAmountAtomic, settlement.billing.inferenceAmountAtomic),
      platformFeeAtomic: add(total.platformFeeAtomic, settlement.billing.platformFeeAtomic),
      finalAmountAtomic: add(total.finalAmountAtomic, settlement.billing.finalAmountAtomic),
    }), emptyBilling()),
    settlementIds: lifecycle.settlements.map((settlement) => settlement.id),
    error: error ? { code: errorCode(error), message: error instanceof Error ? error.message : String(error) } : undefined,
  };
  await sink({ request, settlements: lifecycle.settlements });
}

function billing(settlement: InferenceSettlementReceipt): InferenceBillingTotals {
  return { inferenceAmountAtomic: settlement.providerAmountWei || "0", platformFeeAtomic: settlement.platformFeeWei || "0",
    finalAmountAtomic: settlement.finalAmountWei, currency: "USDC", decimals: 6 };
}

function emptyBilling(): InferenceBillingTotals {
  return { inferenceAmountAtomic: "0", platformFeeAtomic: "0", finalAmountAtomic: "0", currency: "USDC", decimals: 6 };
}

function add(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "inference_failed";
}
