import type {
  UnifiedModality,
  UnifiedOutput,
  UnifiedRequest,
} from "../inference/core.js";
import { resolveModel } from "../inference/models-registry.js";
import {
  buildAuthoritativeBilling,
  buildRequestBilling,
  resolveBillingPrice,
} from "../inference/telemetry.js";
import type { ModelCard, ModelProvider } from "../inference/types.js";

const MICRO_SCALE = 1_000_000n;
const PLATFORM_FEE_BASIS_POINTS = 100n; // 1%

export type MeterPriceUnit = string;

export interface MeterLineItem {
  key: string;
  unit: MeterPriceUnit;
  quantity: number;
  unitPriceUsd: number;
}

export interface MeteredAuthorizationInput {
  subject: string;
  lineItems: MeterLineItem[];
}

export type ResolvedAuthorizationInput =
  | { meter: MeteredAuthorizationInput }
  | { useBudgetCap: true };

export interface MeteredSettlementInput {
  subject: string;
  lineItems: MeterLineItem[];
}

export interface MeteredQuotedLineItem extends MeterLineItem {
  amountWei: string;
}

export interface MeteredAmountBreakdown {
  subject: string;
  lineItems: MeteredQuotedLineItem[];
  providerAmountWei: string;
  platformFeeWei: string;
  finalAmountWei: string;
}

export interface ResolvedBillingModel {
  modelId: string;
  provider: ModelProvider;
  known: boolean;
  card: ModelCard | null;
}

export interface SettlementMeterArgs {
  resolved: ResolvedBillingModel;
  modality: UnifiedModality;
  usage?: unknown;
  media?: unknown;
}

export interface MeteredModelQuote extends MeteredAmountBreakdown {
  modelId: string;
  provider: ModelProvider;
  known: boolean;
  meter: MeteredAuthorizationInput | MeteredSettlementInput;
}

export interface UsageRecord {
  agentId: string;
  model: string;
  provider?: ModelProvider | string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  timestamp: number;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be greater than zero");
  }

  if (numerator === 0n) {
    return 0n;
  }

  return ((numerator - 1n) / denominator) + 1n;
}

function decimalToMicros(value: number, fieldName: string): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }

  const micros = Math.round(value * Number(MICRO_SCALE));
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new Error(`${fieldName} cannot be represented safely`);
  }

  return BigInt(micros);
}

function unitScale(unit: MeterPriceUnit): bigint {
  const normalized = unit.trim().toLowerCase();

  if (/_per_1m_/.test(normalized)) {
    return 1_000_000n;
  }

  const scaledMetric = normalized.match(/_per_(\d+)(k|m)_/);
  if (scaledMetric) {
    const value = BigInt(scaledMetric[1]);
    return scaledMetric[2] === "m" ? value * 1_000_000n : value * 1_000n;
  }

  const scaledSeconds = normalized.match(/_per_(\d+)_seconds$/);
  if (scaledSeconds) {
    return BigInt(scaledSeconds[1]);
  }

  return 1n;
}

function validateLineItem(item: MeterLineItem, index: number): void {
  if (!item.key) {
    throw new Error(`lineItems[${index}].key is required`);
  }
  if (!item.unit) {
    throw new Error(`lineItems[${index}].unit is required`);
  }
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
    throw new Error(`lineItems[${index}].quantity must be a positive finite number`);
  }
  if (!Number.isFinite(item.unitPriceUsd) || item.unitPriceUsd <= 0) {
    throw new Error(`lineItems[${index}].unitPriceUsd must be a positive finite number`);
  }
}

function quoteLineItem(item: MeterLineItem, index: number): MeteredQuotedLineItem {
  validateLineItem(item, index);

  const quantityMicros = decimalToMicros(item.quantity, `lineItems[${index}].quantity`);
  const unitPriceWei = decimalToMicros(item.unitPriceUsd, `lineItems[${index}].unitPriceUsd`);
  const amountWei = ceilDiv(quantityMicros * unitPriceWei, MICRO_SCALE * unitScale(item.unit));

  if (amountWei <= 0n) {
    throw new Error(`lineItems[${index}] resolves to zero amount`);
  }

  return {
    ...item,
    amountWei: amountWei.toString(),
  };
}

function quoteMeteredAmount(subject: string, lineItems: MeterLineItem[]): MeteredAmountBreakdown {
  if (!subject) {
    throw new Error("meter.subject is required");
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("lineItems must contain at least one priced quantity");
  }

  const quotedLineItems = lineItems.map((item, index) => quoteLineItem(item, index));
  const providerAmountWei = quotedLineItems.reduce((total, item) => total + BigInt(item.amountWei), 0n);

  if (providerAmountWei <= 0n) {
    throw new Error(`Metered amount resolved to zero for ${subject}`);
  }

  const platformFeeWei = ceilDiv(providerAmountWei, PLATFORM_FEE_BASIS_POINTS);
  const finalAmountWei = providerAmountWei + platformFeeWei;

  return {
    subject,
    lineItems: quotedLineItems,
    providerAmountWei: providerAmountWei.toString(),
    platformFeeWei: platformFeeWei.toString(),
    finalAmountWei: finalAmountWei.toString(),
  };
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

export function quoteMeteredAuthorization(input: MeteredAuthorizationInput): MeteredAmountBreakdown {
  return quoteMeteredAmount(input.subject, input.lineItems);
}

export function quoteMeteredSettlement(input: MeteredSettlementInput): MeteredAmountBreakdown {
  return quoteMeteredAmount(input.subject, input.lineItems);
}

export function resolveBillingModel(modelId: string, provider?: ModelProvider | string): ResolvedBillingModel {
  return resolveModel(modelId, provider);
}

export function meterSubject(provider: ModelProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function buildResolvedAuthorizationMeter(args: {
  request: UnifiedRequest;
  resolved: ResolvedBillingModel;
}): MeteredModelQuote {
  const card = requireResolvedCard(args.resolved, "authorization");
  const subject = meterSubject(args.resolved.provider, args.request.model);

  const billing = buildRequestBilling({
    subject,
    modality: args.request.modality,
    pricing: card.pricing!,
    metrics: args.request.billingMetrics,
  });
  const meter: MeteredAuthorizationInput = {
    subject: billing.subject,
    lineItems: billing.lineItems.map(({ source: _source, ...lineItem }) => lineItem),
  };

  return {
    modelId: args.resolved.modelId,
    provider: args.resolved.provider,
    known: args.resolved.known,
    meter,
    ...quoteMeteredAuthorization(meter),
  };
}

export function buildResolvedAuthorizationInput(args: {
  request: UnifiedRequest;
  resolved: ResolvedBillingModel;
}): ResolvedAuthorizationInput {
  requireResolvedCard(args.resolved, "authorization");
  if (args.request.modality === "audio") {
    return {
      meter: buildResolvedAuthorizationMeter(args).meter,
    };
  }

  return { useBudgetCap: true };
}

export function buildResolvedSettlementMeter(args: SettlementMeterArgs): MeteredModelQuote {
  const card = requireResolvedCard(args.resolved, "settlement");

  const billing = buildAuthoritativeBilling({
    subject: meterSubject(args.resolved.provider, args.resolved.modelId),
    modality: args.modality,
    pricing: card.pricing!,
    usage: args.usage,
    media: args.media,
  });

  const meter: MeteredSettlementInput = {
    subject: billing.subject,
    lineItems: billing.lineItems.map(({ source: _source, ...lineItem }) => lineItem),
  };

  return {
    modelId: args.resolved.modelId,
    provider: args.resolved.provider,
    known: args.resolved.known,
    meter,
    ...quoteMeteredSettlement(meter),
  };
}

export function buildSettlementMeterFromOutput(args: {
  request: UnifiedRequest;
  output: UnifiedOutput;
  resolved: ResolvedBillingModel;
}): MeteredModelQuote {
  return buildResolvedSettlementMeter({
    resolved: args.resolved,
    modality: args.request.modality,
    usage: args.output.usage,
    media: {
      generatedUnits: args.output.media?.generatedUnits,
      generatedSeconds: args.output.media?.duration,
      generatedMinutes: typeof args.output.media?.duration === "number" ? args.output.media.duration / 60 : undefined,
      requests: 1,
      billingMetrics: {
        ...(args.request.billingMetrics || {}),
        ...(args.output.media?.billingMetrics || {}),
        request: 1,
      },
    },
  });
}

export function buildUsageRecordSettlementMeter(args: {
  subject: string;
  usageRecords: UsageRecord[];
}): MeteredModelQuote {
  const usageRecords = requireUsageRecords(args.usageRecords);
  const lineItems: MeterLineItem[] = [];
  let resolvedModelId = "";
  let resolvedProvider: ModelProvider = "openai";

  for (const usageRecord of usageRecords) {
    const resolved = resolveBillingModel(usageRecord.model, usageRecord.provider);
    const card = requireResolvedCard(resolved, "settlement");
    const pricing = resolveBillingPrice(card.pricing, "text");

    if (!pricing.unit.endsWith("_per_1m_tokens")) {
      throw new Error(`workflow usage record pricing must be token-based: ${usageRecord.model}`);
    }

    if (typeof pricing.values.input === "number" && usageRecord.inputTokens > 0) {
      lineItems.push({
        key: `${resolved.provider}:${resolved.modelId}:input_tokens`,
        unit: pricing.unit,
        quantity: usageRecord.inputTokens,
        unitPriceUsd: pricing.values.input,
      });
    }

    if (typeof pricing.values.output === "number" && usageRecord.outputTokens > 0) {
      lineItems.push({
        key: `${resolved.provider}:${resolved.modelId}:output_tokens`,
        unit: pricing.unit,
        quantity: usageRecord.outputTokens,
        unitPriceUsd: pricing.values.output,
      });
    }

    if (typeof pricing.values.reasoning === "number" && typeof usageRecord.reasoningTokens === "number" && usageRecord.reasoningTokens > 0) {
      lineItems.push({
        key: `${resolved.provider}:${resolved.modelId}:reasoning_tokens`,
        unit: pricing.unit,
        quantity: usageRecord.reasoningTokens,
        unitPriceUsd: pricing.values.reasoning,
      });
    }

    resolvedModelId = resolved.modelId;
    resolvedProvider = resolved.provider;
  }

  if (lineItems.length === 0) {
    throw new Error("usageRecords must contain at least one authoritative usage record");
  }

  const meter: MeteredSettlementInput = {
    subject: args.subject,
    lineItems,
  };

  return {
    modelId: resolvedModelId || args.subject,
    provider: resolvedProvider,
    known: true,
    meter,
    ...quoteMeteredSettlement(meter),
  };
}
