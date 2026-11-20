import type { Output, Request, Usage } from "./core.js";
import { resolveModel } from "./adapters/registry.js";
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

export function buildResolvedAuthorizationMeter(args: {
  request: Request;
  resolved: ResolvedBillingModel;
}): MeteredModelQuote {
  const card = requireResolvedCard(args.resolved, "authorization");
  const subject = meterSubject(args.resolved.provider, args.resolved.modelId);

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
    telemetry: billing,
    ...quoteMeteredAuthorization(meter),
  };
}

export function buildResolvedAuthorizationInput(args: {
  request: Request;
  resolved: ResolvedBillingModel;
}): ResolvedAuthorizationInput {
  requireResolvedCard(args.resolved, "authorization");
  if (args.request.modality === "realtime") {
    return { useBudgetCap: true, scheme: "batch-settlement" };
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
    telemetry: billing,
    ...quoteMeteredSettlement(meter),
  };
}

type TokenModality = "text" | "image" | "audio" | "video";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasNonEmptyValue(item));
  return false;
}

function hasFiniteMetric(record: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  if (!record) return false;
  return keys.some((key) => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });
}

function collectRequestInputModalities(request: Request): Set<TokenModality> {
  const modalities = new Set<TokenModality>();

  if (typeof request.instructions === "string" && request.instructions.trim().length > 0) {
    modalities.add("text");
  }
  if (hasNonEmptyValue(request.embeddingInput)) {
    modalities.add("text");
  }
  if (typeof request.imageOptions?.imageUrl === "string" && request.imageOptions.imageUrl.trim().length > 0) {
    modalities.add("image");
  }
  if (typeof request.videoOptions?.imageUrl === "string" && request.videoOptions.imageUrl.trim().length > 0) {
    modalities.add("image");
  }
  if (typeof request.videoOptions?.videoUrl === "string" && request.videoOptions.videoUrl.trim().length > 0) {
    modalities.add("video");
  }

  for (const message of request.messages || []) {
    if (typeof message.content === "string") {
      if (message.content.trim().length > 0) modalities.add("text");
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "image_url") {
          modalities.add("image");
        } else if (part.type === "input_audio") {
          modalities.add("audio");
        } else if (part.type === "video_url") {
          modalities.add("video");
        } else if (
          (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
          || part.type === "tool-call"
          || part.type === "tool-result"
          || part.type === "thinking"
          || part.type === "redacted_thinking"
        ) {
          modalities.add("text");
        }
      }
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      modalities.add("text");
    }
  }

  const custom = request.customParams;
  if (custom) {
    for (const key of [
      "image", "image_url", "image_urls", "imageUrls", "mask",
      "input_image", "input_image_2", "input_image_3", "input_image_4",
      "input_image_5", "input_image_6", "input_image_7", "input_image_8",
    ]) {
      if (hasNonEmptyValue(custom[key])) modalities.add("image");
    }
    for (const key of ["audio", "audio_url", "file", "input_audio"]) {
      if (hasNonEmptyValue(custom[key])) modalities.add("audio");
    }
    for (const key of ["video", "video_url", "input_video"]) {
      if (hasNonEmptyValue(custom[key])) modalities.add("video");
    }
  }

  return modalities;
}

export function buildSettlementMeterFromOutput(args: {
  request: Request;
  output: Output;
  resolved: ResolvedBillingModel;
  checkpointSequence?: number;
}): MeteredModelQuote {
  const checkpointSequence = args.checkpointSequence ?? 0;
  const requestMetrics = requestBillingMetricsForCheckpoint(
    args.request.billingMetrics,
    checkpointSequence,
  );
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
        ...(requestMetrics || {}),
        ...(args.output.usage?.billingMetrics || {}),
        ...(args.output.media?.billingMetrics || {}),
        ...(checkpointSequence > 0 || args.request.modality === "realtime" ? {} : { request: 1 }),
      },
    },
  });
}

export function requestBillingMetricsForCheckpoint(
  metrics: Record<string, unknown> | undefined,
  checkpointSequence: number,
): Record<string, unknown> | undefined {
  if (!metrics) return undefined;
  if (checkpointSequence === 0) return { ...metrics };

  const selectors: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "string" || typeof value === "boolean") {
      selectors[key] = value;
    }
  }
  return Object.keys(selectors).length > 0 ? selectors : undefined;
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
    const resolved = resolveBillingModel(usageRecord.model);
    const card = requireResolvedCard(resolved, "settlement");
    const billing = buildAuthoritativeBilling({
      subject: meterSubject(resolved.provider, resolved.modelId),
      modality: "text",
      pricing: card.pricing!,
      usage: {
        promptTokens: usageRecord.inputTokens,
        completionTokens: usageRecord.outputTokens,
        totalTokens: usageRecord.totalTokens,
        reasoningTokens: usageRecord.reasoningTokens,
        billingMetrics: {
          input_text_tokens: usageRecord.inputTokens,
          output_text_tokens: usageRecord.outputTokens,
          ...(typeof usageRecord.reasoningTokens === "number" ? { reasoning_tokens: usageRecord.reasoningTokens } : {}),
        },
      },
    });

    const tokenLineItems = billing.lineItems
      .filter((item) => /^usd_per_\d+[km]_tokens$/.test(item.unit))
      .map(({ source: _source, ...lineItem }) => ({
        ...lineItem,
        key: `${resolved.provider}:${resolved.modelId}:${lineItem.key.replace(/^text_/, "")}`,
      }));

    if (tokenLineItems.length === 0) {
      throw new Error(`workflow usage record pricing must be token-based: ${usageRecord.model}`);
    }

    lineItems.push(...tokenLineItems);

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
