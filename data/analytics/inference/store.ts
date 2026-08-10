import {
  insertSettlementCheckpoint,
  insertRequest,
  projectCanonicalPaymentIntentSettlement as projectSettlement,
  type AnalyticsQueryExecutor,
  type CanonicalPaymentIntentSettlementProjection,
} from "./db.js";
import type { Settlement, StoredRequest } from "./types.js";
import type {
  InferenceSettlementTelemetry,
  InferenceTelemetryLifecycle,
  InferenceTelemetryRecord,
} from "../../../inference/events.js";
import { aggregateCanonicalFamily } from "../../../inference/catalog/families/index.js";
import { getModelCapabilities } from "../../../inference/catalog/modalities/index.js";
import { resolveBillingModel } from "../../../x402/metering.js";
import type { PaymentIntentRecord } from "../../../x402/intents.js";
import {
  publishInvalidation,
  type EventName,
  type InvalidationReason,
} from "../../shared/updates.js";

export interface AnalyticsRecordDependencies {
  insert?: typeof insertRequest;
  publish?: (
    domain: EventName,
    address: string,
    reason: InvalidationReason,
  ) => Promise<void>;
  logError?: (message: string, error: unknown) => void;
}

export async function recordSettlement(
  lifecycle: InferenceTelemetryLifecycle,
  settlement: InferenceSettlementTelemetry,
): Promise<void> {
  await insertSettlementCheckpoint(lifecycle, settlement);
  try {
    await publishInvalidation("inference-analytics", lifecycle.userAddress, "telemetry");
  } catch (error) {
    console.error("[analytics] Failed to publish settlement invalidation", error);
  }
}

export async function record(
  request: InferenceTelemetryRecord["request"],
  settlements: InferenceTelemetryRecord["settlements"],
  dependencies: AnalyticsRecordDependencies = {},
): Promise<void> {
  const insert = dependencies.insert ?? insertRequest;
  const publish = dependencies.publish ?? publishInvalidation;
  const logError = dependencies.logError ?? ((message, error) => console.error(message, error));
  await insert(request as StoredRequest, settlements as Settlement[]);
  try {
    await publish("inference-analytics", request.userAddress, "telemetry");
  } catch (error) {
    logError("[analytics] Failed to publish telemetry invalidation", error);
  }
}

export async function projectCanonicalPaymentIntentSettlement(
  input: CanonicalPaymentIntentSettlementProjection,
  executor?: AnalyticsQueryExecutor,
  intent?: PaymentIntentRecord,
  insertCheckpoint: typeof insertSettlementCheckpoint = insertSettlementCheckpoint,
): Promise<boolean> {
  const projected = await projectSettlement(input, executor);
  if (projected || !intent?.meterSubject || !intent.finalAmountWei) return projected;

  const separator = intent.meterSubject.indexOf(":");
  const modelId = separator >= 0 ? intent.meterSubject.slice(separator + 1) : intent.meterSubject;
  const resolved = resolveBillingModel(modelId);
  const card = resolved.card;
  const capability = card ? getModelCapabilities(card)[0] : undefined;
  const family = card?.family
    || aggregateCanonicalFamily(card?.modelId || modelId, card?.name)
    || resolved.provider;
  const types = card?.type
    ? Array.isArray(card.type) ? card.type : [card.type]
    : [capability?.modality || "text"];
  const operation = capability?.operation || intent.action || "inference";
  const requestId = intent.rootRunId || intent.executionRunId || `intent:${intent.paymentIntentId}`;
  const lifecycle = {
    id: requestId,
    userAddress: intent.userAddress,
    network: intent.network,
    startedAt: intent.createdAt,
    request: {
      mode: "responses",
      model: resolved.modelId,
      stream: false,
      modality: capability?.modality || "text",
      operation,
      messages: [],
      responseId: requestId,
    },
    resolved,
    settlements: [],
    metrics: {},
  } as InferenceTelemetryLifecycle;
  const settlement: InferenceSettlementTelemetry = {
    id: `stl_pi_${intent.paymentIntentId.replace(/[^A-Za-z0-9_.:-]/gu, "_")}`,
    requestId,
    network: intent.network,
    family,
    model: resolved.modelId,
    types,
    operation,
    status: input.status === "confirmed" ? "settled" : "failed",
    ...(input.transactionHash ? { transactionHash: input.transactionHash } : {}),
    paymentIntentId: intent.paymentIntentId,
    pricedUnits: (intent.meterLineItems || []).map((item) => ({
      key: item.key,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceUsd: item.unitPriceUsd,
      amountAtomic: item.amountWei,
    })),
    usage: {
      metrics: {},
      units: (intent.meterLineItems || []).map(({ amountWei: _, unitPriceUsd: __, ...unit }) => unit),
    },
    billing: {
      inferenceAmountAtomic: intent.providerAmountWei || "0",
      platformFeeAtomic: intent.platformFeeWei || "0",
      finalAmountAtomic: intent.finalAmountWei,
      currency: "USDC",
      decimals: 6,
    },
    ...(input.status === "confirmed" ? { settledAt: new Date(input.confirmedAt).toISOString() } : {}),
    createdAt: new Date(intent.createdAt).toISOString(),
  };
  await insertCheckpoint(lifecycle, settlement);
  return true;
}
