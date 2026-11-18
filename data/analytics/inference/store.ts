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
import { aggregateCanonicalFamily } from "../../../inference/adapters/families/index.js";
import { getModelCapabilities } from "../../../inference/adapters/modalities/index.js";
import { getModelById } from "../../../inference/adapters/registry.js";
import { resolveBillingModel } from "../../../x402/metering.js";
import type { PaymentIntentRecord } from "../../../x402/intents.js";
import {
  publishInvalidation,
  type EventName,
  type InvalidationReason,
} from "../../shared/updates.js";
import { bumpCacheVersion } from "../../../cache.js";
import { getWalletPair } from "../../user/store.js";

async function bumpAnalyticsCacheForOwner(userAddress: string | undefined): Promise<void> {
  if (!userAddress) return;
  const normalized = /^0x[a-fA-F0-9]{40}$/.test(userAddress)
    ? userAddress.toLowerCase()
    : userAddress;
  const owners = new Set<string>([normalized]);
  const pair = await getWalletPair(normalized).catch(() => null);
  if (pair) {
    owners.add(pair.evmAddress.toLowerCase());
    owners.add(pair.svmAddress);
  }
  await Promise.all(
    [...owners].map((owner) => bumpCacheVersion(`inference-analytics:${owner}`).catch(() => undefined)),
  );
}

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
  if (projected || !intent?.finalAmountWei || !/^\d+$/.test(intent.finalAmountWei)) return projected;
  const finalWei = BigInt(intent.finalAmountWei);
  if (finalWei <= 0n) return true;

  const service = (intent.service || "settlement").trim().toLowerCase();
  const rawSubject = intent.meterSubject?.trim() || service;
  const separator = rawSubject.indexOf(":");
  const candidateModelId = separator >= 0 ? rawSubject.slice(separator + 1) : rawSubject;
  const catalogCard = intent.meterSubject ? getModelById(candidateModelId) : undefined;

  let resolved: InferenceTelemetryLifecycle["resolved"] | undefined;
  let family: string;
  let modelName: string;
  let types: string[];
  let modality: InferenceTelemetryLifecycle["request"]["modality"];
  let operation: string;
  let requestId: string;

  if (catalogCard) {
    resolved = resolveBillingModel(candidateModelId);
    const card = resolved.card;
    const capability = card ? getModelCapabilities(card)[0] : undefined;
    family = card?.family
      || aggregateCanonicalFamily(card?.modelId || candidateModelId, card?.name)
      || resolved.provider;
    modelName = resolved.modelId;
    types = card?.type
      ? Array.isArray(card.type) ? card.type : [card.type]
      : [capability?.modality || "text"];
    modality = capability?.modality || "text";
    operation = capability?.operation || intent.action || "inference";
    requestId = intent.rootRunId || intent.executionRunId || `intent:${intent.paymentIntentId}`;
  } else {
    family = service;
    modelName = rawSubject.startsWith(`${service}:`)
      ? rawSubject.slice(service.length + 1) || service
      : rawSubject;
    types = [service];
    modality = service === "banner" ? "image" : "text";
    operation = (intent.action || service).trim();
    requestId = `intent:${intent.paymentIntentId}`;
  }

  const effectiveLineItems = intent.meterLineItems && intent.meterLineItems.length > 0
    ? intent.meterLineItems
    : [{
      key: operation,
      unit: "request",
      quantity: 1,
      unitPriceUsd: Number(finalWei) / 1_000_000,
      amountWei: finalWei.toString(),
    }];
  const platformWei = intent.platformFeeWei && /^\d+$/.test(intent.platformFeeWei)
    ? BigInt(intent.platformFeeWei)
    : 0n;
  const providerWei = intent.providerAmountWei && /^\d+$/.test(intent.providerAmountWei)
    ? BigInt(intent.providerAmountWei)
    : (finalWei > platformWei ? finalWei - platformWei : 0n);

  const lifecycle = {
    id: requestId,
    userAddress: intent.userAddress,
    network: intent.network,
    startedAt: intent.createdAt,
    request: {
      mode: "responses",
      model: modelName,
      stream: false,
      modality,
      operation,
      messages: [],
      responseId: requestId,
    },
    ...(resolved ? { resolved } : {}),
    settlements: [],
    metrics: {},
  } as InferenceTelemetryLifecycle;
  const settlement: InferenceSettlementTelemetry = {
    id: `stl_pi_${intent.paymentIntentId.replace(/[^A-Za-z0-9_.:-]/gu, "_")}`,
    requestId,
    network: intent.network,
    family,
    model: modelName,
    types,
    operation,
    status: input.status === "confirmed" ? "settled" : "failed",
    ...(input.transactionHash ? { transactionHash: input.transactionHash } : {}),
    paymentIntentId: intent.paymentIntentId,
    pricedUnits: effectiveLineItems.map((item) => ({
      key: item.key,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceUsd: item.unitPriceUsd,
      amountAtomic: item.amountWei,
    })),
    usage: {
      metrics: {},
      units: effectiveLineItems.map(({ amountWei: _, unitPriceUsd: __, ...unit }) => unit),
    },
    billing: {
      inferenceAmountAtomic: providerWei.toString(),
      platformFeeAtomic: platformWei.toString(),
      finalAmountAtomic: finalWei.toString(),
      currency: "USDC",
      decimals: 6,
    },
    ...(input.status === "confirmed" ? { settledAt: new Date(input.confirmedAt).toISOString() } : {}),
    createdAt: new Date(intent.createdAt).toISOString(),
  };
  await insertCheckpoint(lifecycle, settlement);
  return true;
}
