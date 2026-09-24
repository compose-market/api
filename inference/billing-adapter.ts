import type { Output, Request } from "./core.js";
import { resolveModel } from "./catalog/registry.js";
import {
  buildAuthoritativeBilling,
  buildRequestBilling,
} from "./telemetry.js";
import type { ModelCard, ModelProvider } from "./types.js";
import {
  differenceMeteredAmount,
  quoteMeteredAuthorization,
  quoteMeteredSettlement,
  type MeteredAmountBreakdown,
  type MeteredAuthorizationInput,
  type MeteredSettlementInput,
  type MeterLineItem,
  type MeteredQuotedLineItem,
} from "../x402/metering.js";

export type ResolvedBillingModel = ReturnType<typeof resolveModel>;

export interface ResolvedAuthorizationInput {
  useBudgetCap: true;
  scheme?: "batch-settlement";
}

export interface MeteredModelQuote extends MeteredAmountBreakdown {
  modelId: string;
  provider: ModelProvider;
  known: boolean;
  meter: MeteredAuthorizationInput | MeteredSettlementInput;
  telemetry?: ReturnType<typeof buildRequestBilling> | ReturnType<typeof buildAuthoritativeBilling>;
}

export interface SettlementMeterArgs {
  resolved: ResolvedBillingModel;
  modality: Request["modality"];
  usage?: unknown;
  media?: unknown;
}

export interface UsageRecord {
  agentWallet?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  timestamp?: number;
}

function requireResolvedCard(resolved: ResolvedBillingModel, phase: "authorization" | "settlement"): ModelCard {
  if (!resolved.card) {
    throw new Error(`Model metadata is required for metered ${phase}: ${resolved.modelId}`);
  }
  if (!resolved.card.pricing) {
    throw new Error(`pricing is required for metered ${phase}: ${resolved.modelId}`);
  }

  return resolved.card;
}

function requireUsageRecords(usageRecords: UsageRecord[]): UsageRecord[] {
  if (!Array.isArray(usageRecords) || usageRecords.length === 0) {
    throw new Error("usageRecords must contain at least one authoritative usage record");
  }

  return usageRecords;
}

function quotedLineItemIdentity(item: Pick<MeterLineItem, "key" | "unit" | "unitPriceUsd">): string {
  return JSON.stringify([item.key, item.unit, item.unitPriceUsd]);
}

function positiveMetricDifference(
  current: Record<string, number>,
  previous: Record<string, number>,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(current)) {
    const prior = previous[key] || 0;
    if (value < prior) {
      throw new Error(`cumulative metered telemetry regressed: ${key}`);
    }
    if (value > prior) metrics[key] = value - prior;
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value > 0 && current[key] === undefined) {
      throw new Error(`cumulative metered telemetry regressed: ${key}`);
    }
  }
  return metrics;
}

export function differenceMeteredModelQuote(
  current: MeteredModelQuote,
  previous?: MeteredModelQuote,
): MeteredModelQuote {
  if (previous && (
    current.modelId !== previous.modelId
    || current.provider !== previous.provider
    || current.known !== previous.known
  )) {
    throw new Error("cumulative metered model identity changed");
  }

  const amount = differenceMeteredAmount(current, previous);
  const meter: MeteredSettlementInput = {
    subject: amount.subject,
    lineItems: amount.lineItems.map(({ amountWei: _amountWei, ...item }) => item),
  };
  const currentTelemetry = current.telemetry;
  const previousTelemetry = previous?.telemetry;
  const telemetryItems = new Map(
    (currentTelemetry?.lineItems || []).map((item) => [quotedLineItemIdentity(item), item]),
  );
  const telemetry = currentTelemetry
    ? {
      subject: currentTelemetry.subject,
      lineItems: amount.lineItems.map(({ amountWei: _amountWei, ...item }) => {
        const source = telemetryItems.get(quotedLineItemIdentity(item))?.source || "provider_response";
        return { ...item, source };
      }),
      metrics: positiveMetricDifference(
        currentTelemetry.metrics,
        previousTelemetry?.metrics || {},
      ),
    }
    : undefined;

  return {
    modelId: current.modelId,
    provider: current.provider,
    known: current.known,
    meter,
    ...(telemetry ? { telemetry } : {}),
    ...amount,
  };
}

export function resolveBillingModel(modelId: string): ResolvedBillingModel {
  return resolveModel(modelId);
}

export function meterSubject(provider: ModelProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}