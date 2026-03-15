import type { UnifiedModality, UnifiedUsage } from "./core.js";
import type { ModelPricing } from "./types.js";
import type { MeterLineItem, MeterPriceUnit } from "../x402/metering.js";

export interface BillingPrice {
  unit: MeterPriceUnit;
  values: Record<string, number>;
}

interface BillingPriceSection extends BillingPrice {
  header?: string;
  default?: boolean;
}

export interface BillingMediaEvidence {
  generatedUnits?: number;
  generatedSeconds?: number;
  generatedMinutes?: number;
  requests?: number;
}

export interface AuthoritativeUsage extends UnifiedUsage {
  reasoningTokens?: number;
  source:
    | "usage_metadata"
    | "response_metadata"
    | "llmOutput"
    | "usage"
    | "google_usage_metadata"
    | "direct_fields";
}

export interface AuthoritativeBillingRecord {
  subject: string;
  lineItems: Array<MeterLineItem & { source: "provider_response" | "request" }>;
}

const PRICE_UNIT_ALIASES: Record<string, MeterPriceUnit> = {
  usd_per_1m_tokens: "usd_per_1m_tokens",
  per_1m_tokens_usd: "usd_per_1m_tokens",
  "per 1m tokens": "usd_per_1m_tokens",
  "usd per million tokens": "usd_per_1m_tokens",
  usd_per_image: "usd_per_image",
  per_image_usd: "usd_per_image",
  "per image": "usd_per_image",
  usd_per_second: "usd_per_second",
  per_second_usd: "usd_per_second",
  "per second": "usd_per_second",
  usd_per_minute: "usd_per_minute",
  per_minute_usd: "usd_per_minute",
  "per minute": "usd_per_minute",
  usd_per_request: "usd_per_request",
  "per inference request": "usd_per_request",
  "per request": "usd_per_request",
};

function normalizeUnit(unit: string): MeterPriceUnit {
  const normalizedKey = unit.trim().toLowerCase();
  const normalized = PRICE_UNIT_ALIASES[normalizedKey];
  if (!normalized) {
    throw new Error(`unsupported pricing unit: ${unit}`);
  }

  return normalized;
}

function isStructuredPricing(pricing: ModelPricing | BillingPrice): pricing is BillingPrice {
  return typeof pricing.unit === "string"
    && pricing.unit.length > 0
    && typeof pricing.values === "object"
    && pricing.values !== null
    && Object.keys(pricing.values).length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readNonNegativeInteger(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  return undefined;
}

function readPositiveNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

function readReasoningTokens(record: Record<string, unknown>): number | undefined {
  const direct = readNonNegativeInteger(record, ["reasoning_tokens", "reasoningTokens"]);
  if (direct !== undefined) {
    return direct;
  }

  const detailKeys = ["output_token_details", "output_tokens_details", "completion_tokens_details"];
  for (const detailKey of detailKeys) {
    const details = asRecord(record[detailKey]);
    if (!details) {
      continue;
    }

    const nested = readNonNegativeInteger(details, ["reasoning", "reasoning_tokens"]);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function requirePositiveQuantity(value: number | undefined, fieldName: string): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    throw new Error(`authoritative billable quantity is required: ${fieldName}`);
  }

  return value;
}

function withOptionalReasoning(reasoningTokens: number | undefined): { reasoningTokens?: number } {
  return typeof reasoningTokens === "number" ? { reasoningTokens } : {};
}

function copyNumericValue(
  source: Record<string, unknown>,
  target: Record<string, number>,
  targetKey: string,
  sourceKeys: string[],
): void {
  for (const key of sourceKeys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      target[targetKey] = value;
      return;
    }
  }
}

function normalizeBillingValues(unit: MeterPriceUnit, source: Record<string, unknown>): Record<string, number> {
  const values: Record<string, number> = {};

  copyNumericValue(source, values, "input", ["input", "input_per_1m_usd", "input_per_1m"]);
  copyNumericValue(source, values, "output", ["output", "output_per_1m_usd", "output_per_1m"]);
  copyNumericValue(source, values, "cached_input", ["cached_input"]);
  copyNumericValue(source, values, "reasoning", ["reasoning"]);
  copyNumericValue(source, values, "generation", ["generation", "image", "perImage", "cost"]);
  copyNumericValue(source, values, "image", ["image"]);
  copyNumericValue(source, values, "second", ["second", "perSecond", "cost"]);
  copyNumericValue(source, values, "minute", ["minute", "perMinute", "cost"]);
  copyNumericValue(source, values, "request", ["request", "perInference", "perRequest", "call", "cost"]);

  if (unit === "usd_per_1m_tokens" && typeof values.input !== "number" && typeof values.output !== "number") {
    copyNumericValue(source, values, "input", ["cost", "price_usd", "price_value_usd"]);
  }

  if (unit === "usd_per_image" && typeof values.generation !== "number") {
    copyNumericValue(source, values, "generation", ["cost", "price_usd", "price_value_usd"]);
  }

  if (unit === "usd_per_second" && typeof values.second !== "number") {
    copyNumericValue(source, values, "second", ["cost", "price_usd", "price_value_usd"]);
  }

  if (unit === "usd_per_minute" && typeof values.minute !== "number") {
    copyNumericValue(source, values, "minute", ["cost", "price_usd", "price_value_usd"]);
  }

  if (unit === "usd_per_request" && typeof values.request !== "number") {
    copyNumericValue(source, values, "request", ["cost", "price_usd", "price_value_usd"]);
  }

  if (Object.keys(values).length === 0) {
    throw new Error("pricing values are required");
  }

  return values;
}

function buildBillingSection(
  unitValue: string,
  source: Record<string, unknown>,
  header?: string,
  isDefault?: boolean,
): BillingPriceSection {
  const unit = normalizeUnit(unitValue);
  return {
    ...(header ? { header } : {}),
    ...(isDefault === true ? { default: true } : {}),
    unit,
    values: normalizeBillingValues(unit, source),
  };
}

function isBatchPricingSection(section: Record<string, unknown>): boolean {
  const header = typeof section.header === "string" ? section.header.toLowerCase() : "";
  const unit = typeof section.unit === "string" ? section.unit.toLowerCase() : "";
  return header.includes("batch") || unit.includes("batch");
}

function readSectionUnitPrice(section: BillingPriceSection): number | undefined {
  const candidates = [
    section.values.generation,
    section.values.image,
    section.values.second,
    section.values.minute,
    section.values.request,
    section.values.call,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  return undefined;
}

export function normalizeCompiledPricing(pricing: ModelPricing | BillingPrice): ModelPricing | BillingPrice {
  if (isStructuredPricing(pricing)) {
    return pricing;
  }

  const record = asRecord(pricing);
  if (!record) {
    return pricing;
  }

  const sections = Array.isArray(record.sections) ? record.sections : null;
  if (!sections || sections.length === 0) {
    return pricing;
  }

  const normalizedSections = sections
    .map((section) => asRecord(section))
    .filter((section): section is Record<string, unknown> => Boolean(section))
    .filter((section) => !isBatchPricingSection(section))
    .map((section) => ({ ...section }));

  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const section of normalizedSections) {
    const header = typeof section.header === "string" ? section.header : "";
    const unit = typeof section.unitKey === "string" ? section.unitKey : typeof section.unit === "string" ? section.unit : "";
    const key = `${header}\u0000${unit}`;
    const group = grouped.get(key) || [];
    group.push(section);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    if (group.length === 0) {
      continue;
    }

    const explicitDefaults = group.filter((section) => section.default === true);
    if (explicitDefaults.length > 1) {
      throw new Error("multiple default pricing sections are not allowed");
    }
    if (explicitDefaults.length === 1) {
      continue;
    }

    const ranked = group
      .map((section, index) => {
        const entries = asRecord(section.entries);
        if (!entries) {
          return null;
        }
        const unitKey = typeof section.unitKey === "string" ? section.unitKey : typeof section.unit === "string" ? section.unit : "";
        const unit = normalizeUnit(unitKey);
        const values = normalizeBillingValues(unit, entries);
        const price = readSectionUnitPrice({
          header: typeof section.header === "string" ? section.header : undefined,
          unit,
          values,
        });
        if (price === undefined) {
          return null;
        }
        return { index, price, section };
      })
      .filter((entry): entry is { index: number; price: number; section: Record<string, unknown> } => Boolean(entry))
      .sort((left, right) => left.price - right.price || left.index - right.index);

    if (ranked.length === 0) {
      group[0].default = true;
      continue;
    }

    ranked[0].section.default = true;
    for (const entry of ranked.slice(1)) {
      entry.section.default = false;
    }
  }

  return {
    ...record,
    sections: normalizedSections,
  };
}

function extractBillingSections(pricing: ModelPricing | BillingPrice): BillingPriceSection[] {
  if (isStructuredPricing(pricing)) {
    return [{
      unit: normalizeUnit(pricing.unit),
      values: pricing.values,
    }];
  }

  const record = asRecord(pricing);
  if (!record) {
    throw new Error("pricing is required");
  }

  const normalizedPricing = normalizeCompiledPricing(pricing);
  const normalizedRecord = asRecord(normalizedPricing);
  const sections = normalizedRecord && Array.isArray(normalizedRecord.sections) ? normalizedRecord.sections : null;
  if (sections && sections.length > 0) {
    const normalizedSections = sections
      .map((section) => asRecord(section))
      .filter((section): section is Record<string, unknown> => Boolean(section))
      .map((section) => {
        const entries = asRecord(section.entries);
        const unit = typeof section.unitKey === "string" ? section.unitKey : typeof section.unit === "string" ? section.unit : null;
        if (!entries || !unit) {
          return null;
        }
        return buildBillingSection(
          unit,
          entries,
          typeof section.header === "string" ? section.header : undefined,
          section.default === true,
        );
      })
      .filter((section): section is BillingPriceSection => Boolean(section));

    if (normalizedSections.length > 0) {
      return normalizedSections;
    }
  }

  if (typeof record.unit === "string") {
    return [buildBillingSection(record.unit, record)];
  }

  const token = asRecord(record.token);
  if (token) {
    return [buildBillingSection("per_1m_tokens_usd", token)];
  }

  if (typeof record.input_per_1m_usd === "number" || typeof record.output_per_1m_usd === "number") {
    return [buildBillingSection("per_1m_tokens_usd", record)];
  }

  if (typeof record.perImage === "number") {
    return [buildBillingSection("per_image_usd", record)];
  }
  if (typeof record.perSecond === "number") {
    return [buildBillingSection("per_second_usd", record)];
  }
  if (typeof record.perMinute === "number") {
    return [buildBillingSection("per_minute_usd", record)];
  }
  if (typeof record.perInference === "number" || typeof record.perRequest === "number") {
    return [buildBillingSection("per request", record)];
  }

  if ((typeof record.price_usd === "number" || typeof record.price_value_usd === "number") && typeof record.price_unit === "string") {
    return [buildBillingSection(record.price_unit, record)];
  }

  throw new Error("pricing values are required");
}

function selectSectionByHeader(sections: BillingPriceSection[], patterns: RegExp[]): BillingPriceSection[] {
  return sections.filter((section) => {
    const header = (section.header || "").toLowerCase();
    return patterns.some((pattern) => pattern.test(header));
  });
}

export function resolveBillingPrice(
  pricing: ModelPricing | BillingPrice | null | undefined,
  modality?: UnifiedModality,
): BillingPrice {
  if (!pricing) {
    throw new Error("pricing is required");
  }

  const sections = extractBillingSections(pricing);
  if (sections.length === 1) {
    const [section] = sections;
    return { unit: section.unit, values: section.values };
  }

  if (!modality) {
    throw new Error("pricing is ambiguous without modality");
  }

  const tokenSections = sections.filter((section) => section.unit === "usd_per_1m_tokens");
  const nonTokenSections = sections.filter((section) => section.unit !== "usd_per_1m_tokens");

  let candidates: BillingPriceSection[] = [];

  if (modality === "text") {
    candidates = selectSectionByHeader(tokenSections, [/text/, /^pricing$/]);
    if (candidates.length === 0 && tokenSections.length === 1) {
      candidates = tokenSections;
    }
  } else if (modality === "embedding") {
    candidates = selectSectionByHeader(tokenSections, [/embed/, /^pricing$/]);
    if (candidates.length === 0 && tokenSections.length === 1) {
      candidates = tokenSections;
    }
  } else if (modality === "audio") {
    candidates = nonTokenSections.filter((section) => section.unit === "usd_per_minute" || section.unit === "usd_per_request");
    if (candidates.length === 0) {
      candidates = selectSectionByHeader(tokenSections, [/audio/, /speech/, /transcrib/, /^pricing$/]);
    }
    if (candidates.length === 0 && tokenSections.length === 1) {
      candidates = tokenSections;
    }
  } else if (modality === "video") {
    candidates = nonTokenSections.filter((section) => section.unit === "usd_per_second" || section.unit === "usd_per_minute" || section.unit === "usd_per_request");
    if (candidates.length === 0) {
      candidates = selectSectionByHeader(tokenSections, [/video/, /^pricing$/]);
    }
  } else if (modality === "image") {
    candidates = nonTokenSections.filter((section) => section.unit === "usd_per_image" || section.unit === "usd_per_request");
    if (candidates.length === 0) {
      candidates = selectSectionByHeader(tokenSections, [/image/, /^pricing$/]);
    }
  }

  if (candidates.length !== 1) {
    const defaults = candidates.filter((section) => section.default === true);
    if (defaults.length === 1) {
      const [selectedDefault] = defaults;
      return {
        unit: selectedDefault.unit,
        values: selectedDefault.values,
      };
    }
    if (defaults.length > 1) {
      throw new Error(`multiple default pricing sections are not allowed for ${modality}`);
    }
    throw new Error(`pricing is ambiguous for ${modality}`);
  }

  const [selected] = candidates;
  return {
    unit: selected.unit,
    values: selected.values,
  };
}

export function normalizeBillingPrice(pricing: ModelPricing | BillingPrice | null | undefined): BillingPrice {
  return resolveBillingPrice(pricing);
}

export function extractAuthoritativeUsage(value: unknown): AuthoritativeUsage {
  const record = asRecord(value);
  if (!record) {
    throw new Error("authoritative usage is required");
  }

  const outputs = asRecord(record.outputs);
  if (outputs) {
    try {
      return extractAuthoritativeUsage(outputs);
    } catch {
      // Fall through to other normalized payload shapes.
    }
  }

  const extra = asRecord(record.extra);
  const metadata = extra ? asRecord(extra.metadata) : null;
  const metadataUsage = metadata ? asRecord(metadata.usage_metadata) : null;
  if (metadataUsage) {
    const promptTokens = readNonNegativeInteger(metadataUsage, ["input_tokens", "prompt_tokens"]);
    const completionTokens = readNonNegativeInteger(metadataUsage, ["output_tokens", "completion_tokens"]);
    const reasoningTokens = readReasoningTokens(metadataUsage);
    const totalTokens = readNonNegativeInteger(metadataUsage, ["total_tokens"]);
    if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        source: "usage_metadata",
      };
    }
  }

  const usageMetadata = asRecord(record.usage_metadata);
  if (usageMetadata) {
    const promptTokens = readNonNegativeInteger(usageMetadata, ["input_tokens", "prompt_tokens"]);
    const completionTokens = readNonNegativeInteger(usageMetadata, ["output_tokens", "completion_tokens"]);
    const reasoningTokens = readReasoningTokens(usageMetadata);
    const totalTokens = readNonNegativeInteger(usageMetadata, ["total_tokens"]);
    if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        source: "usage_metadata",
      };
    }
  }

  const responseMetadata = asRecord(record.response_metadata) ?? asRecord(record.responseMetadata);
  const tokenUsage = responseMetadata
    ? (asRecord(responseMetadata.token_usage) ?? asRecord(responseMetadata.tokenUsage))
    : null;
  if (tokenUsage) {
    const promptTokens = readNonNegativeInteger(tokenUsage, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]);
    const completionTokens = readNonNegativeInteger(tokenUsage, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]);
    const reasoningTokens = readReasoningTokens(tokenUsage);
    const totalTokens = readNonNegativeInteger(tokenUsage, ["total_tokens", "totalTokens"]);
    if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        source: "response_metadata",
      };
    }
  }

  const llmOutput = asRecord(record.llmOutput);
  const llmTokenUsage = llmOutput ? asRecord(llmOutput.tokenUsage) : null;
  if (llmTokenUsage) {
    const promptTokens = readNonNegativeInteger(llmTokenUsage, ["promptTokens", "prompt_tokens", "input_tokens"]);
    const completionTokens = readNonNegativeInteger(llmTokenUsage, ["completionTokens", "completion_tokens", "output_tokens"]);
    const reasoningTokens = readReasoningTokens(llmTokenUsage);
    const totalTokens = readNonNegativeInteger(llmTokenUsage, ["totalTokens", "total_tokens"]);
    if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        source: "llmOutput",
      };
    }
  }

  const usage = asRecord(record.usage);
  if (usage) {
    const promptTokens = readNonNegativeInteger(usage, [
      "prompt_tokens",
      "promptTokens",
      "input_tokens",
      "inputTokens",
    ]);
    const completionTokens = readNonNegativeInteger(usage, [
      "completion_tokens",
      "completionTokens",
      "output_tokens",
      "outputTokens",
    ]);
    const reasoningTokens = readReasoningTokens(usage);
    const totalTokens = readNonNegativeInteger(usage, ["total_tokens", "totalTokens"]);
    if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        source: "usage",
      };
    }
  }

  const googleUsageMetadata = asRecord(record.usageMetadata);
  if (googleUsageMetadata) {
    const promptTokens = readNonNegativeInteger(googleUsageMetadata, ["promptTokenCount"]);
    const candidateTokens = readNonNegativeInteger(googleUsageMetadata, ["candidatesTokenCount"]);
    const reasoningTokens = readNonNegativeInteger(googleUsageMetadata, ["thoughtsTokenCount"]);
    const totalTokens = readNonNegativeInteger(googleUsageMetadata, ["totalTokenCount"]);
    if (promptTokens !== undefined && candidateTokens !== undefined) {
      const completionTokens = candidateTokens + (reasoningTokens ?? 0);
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        source: "google_usage_metadata",
      };
    }
  }

  const promptTokens = readNonNegativeInteger(record, [
    "promptTokens",
    "prompt_tokens",
    "inputTokens",
    "input_tokens",
  ]);
  const completionTokens = readNonNegativeInteger(record, [
    "completionTokens",
    "completion_tokens",
    "outputTokens",
    "output_tokens",
  ]);
  const reasoningTokens = readReasoningTokens(record);
  const totalTokens = readNonNegativeInteger(record, ["totalTokens", "total_tokens"]);
  if (promptTokens !== undefined && completionTokens !== undefined) {
    return {
      promptTokens,
      completionTokens,
      ...withOptionalReasoning(reasoningTokens),
      totalTokens: totalTokens ?? promptTokens + completionTokens,
      source: "direct_fields",
    };
  }

  throw new Error("authoritative usage is required");
}

export function extractAuthoritativeMediaEvidence(
  modality: UnifiedModality,
  value: unknown,
): BillingMediaEvidence {
  const record = asRecord(value);
  if (!record) {
    throw new Error("authoritative media evidence is required");
  }

  const media = asRecord(record.media);
  const primary = media ?? record;
  const generatedUnits = readPositiveNumber(primary, ["generatedUnits", "generated_units"]);
  const generatedSeconds = readPositiveNumber(primary, ["generatedSeconds", "generated_seconds", "duration", "durationSeconds", "duration_seconds"]);
  const requests = readPositiveNumber(primary, ["requests"]);

  if (modality === "image") {
    const data = Array.isArray(record.data) ? record.data : Array.isArray(primary.data) ? primary.data : null;
    return {
      generatedUnits: generatedUnits ?? (data && data.length > 0 ? data.length : undefined),
      requests,
    };
  }

  if (modality === "video" || modality === "audio") {
    return {
      generatedUnits,
      generatedSeconds,
      generatedMinutes: typeof generatedSeconds === "number" ? generatedSeconds / 60 : undefined,
      requests,
    };
  }

  return {
    generatedUnits,
    generatedSeconds,
    generatedMinutes: typeof generatedSeconds === "number" ? generatedSeconds / 60 : undefined,
    requests,
  };
}

export function buildAuthoritativeBilling(args: {
  subject: string;
  modality: UnifiedModality;
  pricing: ModelPricing | BillingPrice;
  usage?: unknown;
  media?: unknown;
}): AuthoritativeBillingRecord {
  if (!args.subject) {
    throw new Error("subject is required");
  }

  const pricing = resolveBillingPrice(args.pricing, args.modality);

  if (pricing.unit === "usd_per_1m_tokens") {
    const usage = extractAuthoritativeUsage(args.usage);
    const lineItems: Array<MeterLineItem & { source: "provider_response" | "request" }> = [];
    const reasoningTokens = typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : 0;
    const hasReasoningPrice = typeof pricing.values.reasoning === "number" && reasoningTokens > 0;
    const outputTokens = hasReasoningPrice ? usage.completionTokens - reasoningTokens : usage.completionTokens;
    if (hasReasoningPrice && outputTokens < 0) {
      throw new Error("authoritative usage is invalid: reasoningTokens exceed completionTokens");
    }

    if (typeof pricing.values.input === "number" && usage.promptTokens > 0) {
      lineItems.push({
        key: "input_tokens",
        unit: pricing.unit,
        quantity: usage.promptTokens,
        unitPriceUsd: pricing.values.input,
        source: "provider_response",
      });
    }
    if (typeof pricing.values.output === "number" && outputTokens > 0) {
      lineItems.push({
        key: "output_tokens",
        unit: pricing.unit,
        quantity: outputTokens,
        unitPriceUsd: pricing.values.output,
        source: "provider_response",
      });
    }
    if (hasReasoningPrice) {
      lineItems.push({
        key: "reasoning_tokens",
        unit: pricing.unit,
        quantity: reasoningTokens,
        unitPriceUsd: pricing.values.reasoning!,
        source: "provider_response",
      });
    }

    if (lineItems.length === 0) {
      throw new Error("authoritative billable quantity is required: usage");
    }

    return {
      subject: args.subject,
      lineItems,
    };
  }

  const media = extractAuthoritativeMediaEvidence(args.modality, args.media);

  if (pricing.unit === "usd_per_image") {
    const quantity = requirePositiveQuantity(media.generatedUnits, "generatedUnits");
    const unitPriceUsd = pricing.values.generation ?? pricing.values.image;
    if (typeof unitPriceUsd !== "number") {
      throw new Error("pricing.values.generation or pricing.values.image is required");
    }

    return {
      subject: args.subject,
      lineItems: [
        {
          key: "generation",
          unit: pricing.unit,
          quantity,
          unitPriceUsd,
          source: "provider_response",
        },
      ],
    };
  }

  if (pricing.unit === "usd_per_second") {
    const quantity = requirePositiveQuantity(media.generatedSeconds, "generatedSeconds");
    const unitPriceUsd = pricing.values.second;
    if (typeof unitPriceUsd !== "number") {
      throw new Error("pricing.values.second is required");
    }

    return {
      subject: args.subject,
      lineItems: [
        {
          key: "duration",
          unit: pricing.unit,
          quantity,
          unitPriceUsd,
          source: "provider_response",
        },
      ],
    };
  }

  if (pricing.unit === "usd_per_minute") {
    const quantity = requirePositiveQuantity(media.generatedMinutes, "generatedMinutes");
    const unitPriceUsd = pricing.values.minute;
    if (typeof unitPriceUsd !== "number") {
      throw new Error("pricing.values.minute is required");
    }

    return {
      subject: args.subject,
      lineItems: [
        {
          key: "duration",
          unit: pricing.unit,
          quantity,
          unitPriceUsd,
          source: "provider_response",
        },
      ],
    };
  }

  const quantity = requirePositiveQuantity(media.requests ?? 1, "requests");
  const unitPriceUsd = pricing.values.request ?? pricing.values.generation ?? pricing.values.call;
  if (typeof unitPriceUsd !== "number") {
    throw new Error("pricing.values.request is required");
  }

  return {
    subject: args.subject,
    lineItems: [
      {
        key: "request",
        unit: "usd_per_request",
        quantity,
        unitPriceUsd,
        source: media.requests ? "provider_response" : "request",
      },
    ],
  };
}
