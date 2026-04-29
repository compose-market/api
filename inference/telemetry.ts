import type { UnifiedModality, UnifiedUsage } from "./core.js";
import { rankOptionValue, resolveModelParams } from "./params-handler.js";
import type { ModelPricing } from "./types.js";
import type { MeterLineItem } from "../x402/metering.js";

export interface BillingPrice {
  unit: string;
  values: Record<string, number>;
}

interface BillingPriceSection extends BillingPrice {
  header?: string;
  default?: boolean;
}

interface RawPriceValue {
  amount: number;
  unitLabel: string;
}

export interface BillingMediaEvidence {
  generatedUnits?: number;
  generatedSeconds?: number;
  generatedMinutes?: number;
  requests?: number;
  billingMetrics?: Record<string, unknown>;
}

export interface AuthoritativeUsage extends UnifiedUsage {
  reasoningTokens?: number;
  cachedInputTokens?: number;
  billingMetrics?: Record<string, unknown>;
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

const NBSP = /\u00a0/g;

function normalizeText(value: string): string {
  return value
    .trim()
    .replace(NBSP, " ")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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

function metricKeyCandidates(key: string): string[] {
  const normalized = normalizeValueKey(key);
  const singular = normalized.replace(/s$/, "");
  const plural = singular.endsWith("s") ? singular : `${singular}s`;
  const fragments = normalized
    .split("_")
    .filter((fragment) => /[a-z]/.test(fragment));
  const tail = fragments.length > 0 ? fragments[fragments.length - 1] : "";
  return [...new Set([
    key,
    normalized,
    singular,
    plural,
    tail,
    `num_${singular}`,
    `num_${plural}`,
    `number_of_${singular}`,
    `number_of_${plural}`,
    `total_${singular}`,
    `total_${plural}`,
  ])];
}

function normalizedMetricEntries(metrics: Record<string, unknown>): Array<{ key: string; normalized: string; value: unknown }> {
  return Object.entries(metrics).map(([key, value]) => ({
    key,
    normalized: normalizeValueKey(key),
    value,
  }));
}

function metricNameMatches(normalizedMetricKey: string, normalizedCandidate: string): boolean {
  if (normalizedMetricKey === normalizedCandidate) {
    return true;
  }

  const singular = normalizedCandidate.replace(/s$/, "");
  const plural = singular.endsWith("s") ? singular : `${singular}s`;
  return normalizedMetricKey.endsWith(`_${singular}`)
    || normalizedMetricKey.endsWith(`_${plural}`);
}

function readMetricByNormalizedName(
  metrics: Record<string, unknown>,
  keys: string[],
  predicate: (value: unknown) => value is number,
): number | undefined {
  const candidates = keys.flatMap((key) => metricKeyCandidates(key).map(normalizeValueKey));
  const matches = normalizedMetricEntries(metrics)
    .filter((entry) => candidates.some((candidate) => metricNameMatches(entry.normalized, candidate)))
    .map((entry) => entry.value)
    .filter(predicate);

  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}

function readPositiveMetric(metrics: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    for (const candidate of metricKeyCandidates(key)) {
      const value = metrics[candidate];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }

  return readMetricByNormalizedName(
    metrics,
    keys,
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

function readNonNegativeMetric(metrics: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    for (const candidate of metricKeyCandidates(key)) {
      const value = metrics[candidate];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }

  return readMetricByNormalizedName(
    metrics,
    keys,
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
}

function readMetricString(metrics: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    for (const candidate of metricKeyCandidates(key)) {
      const value = metrics[candidate];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
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

function assignMetric(metrics: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    metrics[key] = value;
  }
}

function collectTokenBillingMetrics(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const metrics: Record<string, unknown> = {};
  const directMetrics = asRecord(record.billingMetrics);
  const raw = asRecord(record.raw);
  const inputDetails = asRecord(
    record.prompt_tokens_details
    ?? record.promptTokenDetails
    ?? record.input_tokens_details
    ?? record.inputTokenDetails
    ?? raw?.prompt_tokens_details
    ?? raw?.promptTokenDetails
    ?? raw?.input_tokens_details
    ?? raw?.inputTokenDetails,
  );
  const cachedInputDetails = asRecord(inputDetails?.cached_tokens_details ?? inputDetails?.cachedTokensDetails);
  const outputDetails = asRecord(
    record.completion_tokens_details
    ?? record.completionTokenDetails
    ?? record.output_tokens_details
    ?? record.outputTokenDetails
    ?? raw?.completion_tokens_details
    ?? raw?.completionTokenDetails
    ?? raw?.output_tokens_details
    ?? raw?.outputTokenDetails,
  );

  if (directMetrics) {
    for (const [key, value] of Object.entries(directMetrics)) {
      assignMetric(metrics, key, value);
    }
  }

  assignMetric(metrics, "cached_input_tokens", record.cachedInputTokens);
  assignMetric(metrics, "cached_input_tokens", inputDetails?.cached_tokens ?? inputDetails?.cachedTokens);
  assignMetric(metrics, "input_text_tokens", inputDetails?.text_tokens ?? inputDetails?.textTokens);
  assignMetric(metrics, "input_audio_tokens", inputDetails?.audio_tokens ?? inputDetails?.audioTokens);
  assignMetric(metrics, "input_image_tokens", inputDetails?.image_tokens ?? inputDetails?.imageTokens);
  assignMetric(metrics, "cached_input_text_tokens", cachedInputDetails?.text_tokens ?? cachedInputDetails?.textTokens);
  assignMetric(metrics, "cached_input_audio_tokens", cachedInputDetails?.audio_tokens ?? cachedInputDetails?.audioTokens);
  assignMetric(metrics, "cached_input_image_tokens", cachedInputDetails?.image_tokens ?? cachedInputDetails?.imageTokens);
  assignMetric(metrics, "output_text_tokens", outputDetails?.text_tokens ?? outputDetails?.textTokens);
  assignMetric(metrics, "output_audio_tokens", outputDetails?.audio_tokens ?? outputDetails?.audioTokens);
  assignMetric(metrics, "output_image_tokens", outputDetails?.image_tokens ?? outputDetails?.imageTokens);
  assignMetric(metrics, "reasoning_tokens", outputDetails?.reasoning_tokens ?? outputDetails?.reasoningTokens);
  assignMetric(metrics, "reasoning_tokens", record.reasoningTokens);

  return Object.keys(metrics).length > 0 ? metrics : undefined;
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

function withTokenBillingDetails(source: Record<string, unknown>): {
  cachedInputTokens?: number;
  billingMetrics?: Record<string, unknown>;
} {
  const billingMetrics = collectTokenBillingMetrics(source);
  const cachedInputTokens = billingMetrics ? readNonNegativeMetric(billingMetrics, ["cached_input_tokens"]) : undefined;

  return {
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

function isStructuredPricing(pricing: ModelPricing | BillingPrice): pricing is BillingPrice {
  return typeof pricing.unit === "string"
    && pricing.unit.length > 0
    && typeof pricing.values === "object"
    && pricing.values !== null
    && Object.keys(pricing.values).length > 0;
}

function normalizeValueKey(rawKey: string): string {
  return rawKey
    .trim()
    .replace(NBSP, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function primaryValueKeyForUnit(unit: string): string | null {
  if (unit.endsWith("_per_1m_tokens")) {
    return null;
  }
  if (unit.endsWith("_per_image") || unit.endsWith("_per_video")) {
    return "generation";
  }
  if (unit.endsWith("_per_run_resolution_duration")) {
    return null;
  }
  const match = unit.match(/^[a-z]{3}_per_(.+)$/);
  if (!match) {
    return null;
  }

  const fragment = match[1];
  if (/^\d+_seconds$/.test(fragment) || fragment === "second") {
    return "second";
  }

  return fragment
    .replace(/^\d+[km]_/, "")
    .replace(/s$/, "");
}

function normalizeBillingValues(unit: string, source: Record<string, unknown>): Record<string, number> {
  const values: Record<string, number> = {};

  if (unit.endsWith("_per_run_resolution_duration")) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        values[key] = value;
      }
    }
    if (Object.keys(values).length === 0) {
      throw new Error("pricing values are required");
    }
    return values;
  }

  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }

    const normalizedKey = normalizePricingValueKey(unit, key);
    if (!normalizedKey) {
      continue;
    }

    values[normalizedKey] = value;
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

function buildNormalizedBillingSection(
  unit: string,
  values: Record<string, number>,
  header?: string,
  isDefault?: boolean,
): Record<string, unknown> {
  return {
    ...(header ? { header } : {}),
    unit: displayUnit(unit),
    unitKey: unit,
    entries: values,
    ...(isDefault === true ? { default: true } : {}),
  };
}

function normalizeUnitWords(unit: string): string[] {
  return normalizeText(unit).split(" ").filter(Boolean);
}

function normalizeUnitWord(value: string): string {
  switch (value) {
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return "second";
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return "minute";
    case "img":
    case "image":
    case "images":
      return "image";
    case "gen":
    case "gens":
    case "generation":
    case "generations":
      return "generation";
    case "call":
    case "calls":
      return "call";
    case "request":
    case "requests":
      return "request";
    case "run":
    case "runs":
      return "run";
    case "video":
    case "videos":
      return "video";
    case "page":
    case "pages":
      return "page";
    case "megapixel":
    case "megapixels":
    case "mp":
      return "megapixel";
    default:
      return value;
  }
}

function normalizeUnitFragment(words: string[]): string {
  if (words.length === 0) {
    throw new Error("pricing unit is required");
  }

  const normalized = words
    .map((word) => normalizeUnitWord(word))
    .filter((word) => word !== "per" && word !== "usd" && word !== "usdc")
    .filter((word) => word !== "token" && word !== "tokens");
  const deduped = normalized.filter((word, index) => index === 0 || word !== normalized[index - 1]);

  if (deduped.length === 0) {
    return "token";
  }

  const directions = new Set(["input", "output", "prompt", "completion", "cached", "reasoning"]);
  const scaleIndex = deduped.findIndex((word) => /^\d+[km]$/.test(word));
  const stemWords = [...deduped];

  if (scaleIndex >= 0) {
    const scale = stemWords.splice(scaleIndex, 1)[0];
    const unitWords = stemWords.filter((word) => !directions.has(word));
    const suffix = unitWords.length > 0 ? `${unitWords.join("_")}_tokens` : "tokens";
    return `${scale}_${suffix}`;
  }

  if (stemWords.length === 1 && stemWords[0] === "token") {
    return "token";
  }

  return stemWords.join("_");
}

function normalizeCanonicalFragment(fragment: string): string {
  const words = fragment
    .split("_")
    .filter(Boolean)
    .map((word) => normalizeUnitWord(word));
  return words
    .filter((word, index) => index === 0 || word !== words[index - 1])
    .join("_");
}

function displayUnit(unit: string): string {
  const match = unit.match(/^[a-z]{3}_per_(.+)$/);
  if (!match) {
    return unit;
  }

  const fragment = match[1];
  if (fragment === "1m_tokens") {
    return "Per 1M tokens";
  }

  if (/^\d+[km]_(.+)$/.test(fragment)) {
    return `Per ${fragment.replace(/^(\d+)([km])_/, (_, value: string, scale: string) => `${value}${scale.toUpperCase()} `).replace(/_/g, " ")}`;
  }

  if (/^\d+_seconds$/.test(fragment)) {
    return `Per ${fragment.replace(/_/g, " ")}`;
  }

  return `Per ${fragment.replace(/_/g, " ")}`;
}

function normalizeRawUnit(unit: string): string {
  const raw = unit.trim().replace(NBSP, " ").toLowerCase();
  if (!raw) {
    throw new Error("pricing unit is required");
  }

  if (/^[a-z]{3}_per_[a-z0-9_]+$/.test(raw)) {
    const prefixMatch = raw.match(/^([a-z]{3}_per_)(.+)$/);
    if (!prefixMatch) {
      return raw;
    }
    return `${prefixMatch[1]}${normalizeCanonicalFragment(prefixMatch[2])}`;
  }

  const suffixCurrency = raw.match(/^per_([a-z0-9_]+)_([a-z]{3})$/);
  if (suffixCurrency) {
    return `${suffixCurrency[2]}_per_${normalizeCanonicalFragment(suffixCurrency[1])}`;
  }

  const compact = normalizeValueKey(raw.replace(/^\//, ""));
  if (/^[a-z]{3}_per_[a-z0-9_]+$/.test(compact)) {
    const prefixMatch = compact.match(/^([a-z]{3}_per_)(.+)$/);
    if (!prefixMatch) {
      return compact;
    }
    return `${prefixMatch[1]}${normalizeCanonicalFragment(prefixMatch[2])}`;
  }

  const compactSuffix = compact.match(/^per_(.+)_([a-z]{3})$/);
  if (compactSuffix) {
    return `${compactSuffix[2]}_per_${normalizeCanonicalFragment(compactSuffix[1])}`;
  }

  if (compact.startsWith("per_")) {
    return `usd_per_${normalizeCanonicalFragment(compact.slice("per_".length))}`;
  }

  const words = normalizeUnitWords(raw);
  if (words.length === 0) {
    throw new Error(`pricing unit must be canonical: ${unit}`);
  }

  return `usd_per_${normalizeUnitFragment(words)}`;
}

function normalizeUnit(unit: string): string {
  const normalized = normalizeRawUnit(unit);
  if (!normalized.startsWith("usd_per_")) {
    return normalized;
  }

  const fragment = normalized.slice("usd_per_".length);
  if (fragment === "token") {
    return "usd_per_1m_tokens";
  }

  return normalized;
}

function inferValueKeyFromUnit(unitLabel: string, unit: string): string {
  const words = new Set(normalizeUnitWords(unitLabel).map((word) => normalizeUnitWord(word)));

  if (words.has("cached") && (words.has("input") || words.has("prompt"))) {
    return "cached_input";
  }
  if (words.has("reasoning")) {
    return "reasoning";
  }
  if (words.has("output") || words.has("completion")) {
    return "output";
  }
  if (words.has("input") || words.has("prompt")) {
    return "input";
  }

  return primaryValueKeyForUnit(unit) || "cost";
}

function normalizePricingValueKey(unit: string, rawKey: string): string | null {
  const normalizedKey = normalizeValueKey(rawKey);
  if (!normalizedKey || normalizedKey === "unit" || normalizedKey === "unit_key" || normalizedKey === "default" || normalizedKey === "notes") {
    return null;
  }

  if (normalizedKey.startsWith("price_") || normalizedKey.startsWith("context_") || normalizedKey === "slug" || normalizedKey === "tab" || normalizedKey === "category" || normalizedKey === "label" || normalizedKey === "href" || normalizedKey === "kind" || normalizedKey === "inferred" || normalizedKey === "inferred_confidence" || normalizedKey === "inferred_method") {
    return null;
  }

  if (normalizedKey === "input" || normalizedKey === "output" || normalizedKey === "cached_input" || normalizedKey === "reasoning") {
    return normalizedKey;
  }

  const primary = primaryValueKeyForUnit(unit);
  if (!primary) {
    return normalizedKey === "cost" || normalizedKey === "price" ? "cost" : normalizedKey;
  }

  if (normalizedKey === "cost" || normalizedKey === "price") {
    return primary;
  }

  if (normalizedKey === `per_${primary}` || normalizedKey === primary) {
    return primary;
  }

  if (primary === "generation" && (normalizedKey === "image" || normalizedKey === "video" || normalizedKey === "per_image" || normalizedKey === "per_video" || normalizedKey === "per_generation")) {
    return "generation";
  }

  if (normalizedKey === `per_${normalizeValueKey(primary)}`) {
    return primary;
  }

  return normalizedKey;
}

function readRawPriceValues(record: Record<string, unknown>): RawPriceValue[] {
  const values: RawPriceValue[] = [];
  const explicitUnit = typeof record.price_unit === "string" && record.price_unit.trim().length > 0 ? record.price_unit.trim() : null;
  const priceRaw = typeof record.price_raw === "string" && record.price_raw.trim().length > 0 ? record.price_raw.trim() : null;
  const additionalUnit = typeof record.additional_unit === "string" && record.additional_unit.trim().length > 0 ? record.additional_unit.trim() : null;
  const additionalRaw = typeof record.additional_price_raw === "string" && record.additional_price_raw.trim().length > 0 ? record.additional_price_raw.trim() : null;

  const extractUnit = (raw: string | null): string | null => {
    if (!raw) {
      return null;
    }
    const derived = raw.replace(/^\$\s*[\d.,]+\s*/i, "").trim();
    return derived.length > 0 ? derived : null;
  };

  const baseAmount = typeof record.price_usd === "number" && Number.isFinite(record.price_usd) && record.price_usd > 0
    ? record.price_usd
    : typeof record.price_value_usd === "number" && Number.isFinite(record.price_value_usd) && record.price_value_usd > 0
      ? record.price_value_usd
      : null;
  if (baseAmount !== null) {
    const unitLabel = explicitUnit || extractUnit(priceRaw);
    if (unitLabel) {
      values.push({ amount: baseAmount, unitLabel });
    }
  }

  if (typeof record.additional_price_usd === "number" && Number.isFinite(record.additional_price_usd) && record.additional_price_usd > 0) {
    const unitLabel = additionalUnit || extractUnit(additionalRaw);
    if (unitLabel) {
      values.push({ amount: record.additional_price_usd, unitLabel });
    }
  }

  return values;
}

function buildDynamicBillingSections(record: Record<string, unknown>): BillingPriceSection[] {
  const explicitUnit = typeof record.unit === "string" && record.unit.trim().length > 0 ? record.unit : null;
  if (explicitUnit) {
    try {
      return [buildBillingSection(explicitUnit, record, typeof record.header === "string" ? record.header : "Pricing", true)];
    } catch {
      // Continue to other explicit pricing shapes.
    }
  }

  const groupedSections = new Map<string, BillingPriceSection>();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }

    const match = key.match(/^(input|output|cached_input|reasoning)_per_(.+)_usd$/);
    if (!match) {
      continue;
    }

    const rawFragment = match[2];
    const normalizedFragment = record.kind === "tokens" && !/token/.test(rawFragment)
      ? `${rawFragment}_tokens`
      : rawFragment;
    const unit = normalizeUnit(`per_${normalizedFragment}_usd`);
    const section = groupedSections.get(unit) || {
      header: displayUnit(unit).replace(/^Per /, "").replace(/\b\w/g, (char) => char.toUpperCase()),
      unit,
      values: {},
      default: true,
    };
    section.values[match[1]] = value;
    groupedSections.set(unit, section);
  }

  if (groupedSections.size > 0) {
    return [...groupedSections.values()];
  }

  const rawPrices = readRawPriceValues(record);
  if (rawPrices.length > 0) {
    const grouped = new Map<string, BillingPriceSection>();
    for (const entry of rawPrices) {
      const unit = normalizeUnit(entry.unitLabel);
      const valueKey = inferValueKeyFromUnit(entry.unitLabel, unit);
      const current = grouped.get(unit) || {
        header: "Pricing",
        unit,
        values: {},
        default: true,
      };
      current.values[valueKey] = entry.amount;
      grouped.set(unit, current);
    }
    return [...grouped.values()];
  }

  return [];
}

function isBatchPricingSection(section: Record<string, unknown>): boolean {
  const header = typeof section.header === "string" ? section.header.toLowerCase() : "";
  const unit = typeof section.unit === "string" ? section.unit.toLowerCase() : "";
  return header.includes("batch") || unit.includes("batch");
}

export function normalizeCompiledPricing(pricing: ModelPricing | BillingPrice): ModelPricing | BillingPrice {
  if (isStructuredPricing(pricing)) {
    return {
      unit: normalizeUnit(pricing.unit),
      values: normalizeBillingValues(normalizeUnit(pricing.unit), pricing.values),
    };
  }

  const record = asRecord(pricing);
  if (!record) {
    return pricing;
  }

  const sections = Array.isArray(record.sections) ? record.sections : null;
  if (!sections || sections.length === 0) {
    const normalizedDynamicSections = buildDynamicBillingSections(record);
    if (normalizedDynamicSections.length === 0) {
      return pricing;
    }

    return {
      ...record,
      sections: normalizedDynamicSections.map((section) => buildNormalizedBillingSection(
        section.unit,
        section.values,
        section.header,
        section.default,
      )),
    };
  }

  const normalizedSections = sections
    .map((section) => asRecord(section))
    .filter((section): section is Record<string, unknown> => Boolean(section))
    .filter((section) => !isBatchPricingSection(section))
    .flatMap((section) => {
      const entries = asRecord(section.entries);
      const unit = typeof section.unitKey === "string"
        ? section.unitKey
        : typeof section.unit === "string"
          ? section.unit
          : null;
      if (!entries || !unit) {
        return [];
      }

      return [{
        ...(typeof section.header === "string" ? { header: section.header } : {}),
        ...(section.default === true ? { default: true } : {}),
        unit: typeof section.unit === "string" ? section.unit : displayUnit(normalizeUnit(unit)),
        unitKey: normalizeUnit(unit),
        entries,
      }];
    });

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
        const unit = typeof section.unitKey === "string"
          ? section.unitKey
          : typeof section.unit === "string"
            ? section.unit
            : null;
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

  if (isStructuredPricing(record)) {
    return [{
      unit: normalizeUnit(record.unit),
      values: normalizeBillingValues(normalizeUnit(record.unit), record.values),
    }];
  }

  const dynamicSections = buildDynamicBillingSections(record);
  if (dynamicSections.length > 0) {
    return dynamicSections;
  }

  throw new Error("pricing sections are required");
}

export function resolveBillingPrice(
  pricing: ModelPricing | BillingPrice | null | undefined,
  _modality?: UnifiedModality,
): BillingPrice {
  if (!pricing) {
    throw new Error("pricing is required");
  }

  const sections = extractBillingSections(pricing);
  const section = resolveBillingSection(sections);
  return {
    unit: section.unit,
    values: section.values,
  };
}

function resolveBillingSection(sections: BillingPriceSection[]): BillingPriceSection {
  if (sections.length === 1) {
    return sections[0];
  }

  const defaults = sections.filter((section) => section.default === true);
  if (defaults.length === 1) {
    return defaults[0];
  }
  if (defaults.length > 1) {
    throw new Error("multiple default pricing sections are not allowed");
  }

  throw new Error("pricing is ambiguous without an explicit default");
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
      // Continue to other shapes.
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
        ...withTokenBillingDetails(metadataUsage),
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
        ...withTokenBillingDetails(usageMetadata),
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
        ...withTokenBillingDetails(tokenUsage),
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
        ...withTokenBillingDetails(llmTokenUsage),
        source: "llmOutput",
      };
    }
  }

  const usage = asRecord(record.usage);
  if (usage) {
    const promptTokens = readNonNegativeInteger(usage, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]);
    const completionTokens = readNonNegativeInteger(usage, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]);
    const reasoningTokens = readReasoningTokens(usage);
    const totalTokens = readNonNegativeInteger(usage, ["total_tokens", "totalTokens"]);
    if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        ...withTokenBillingDetails(usage),
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

  const promptTokens = readNonNegativeInteger(record, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"]);
  const completionTokens = readNonNegativeInteger(record, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens"]);
  const reasoningTokens = readReasoningTokens(record);
  const totalTokens = readNonNegativeInteger(record, ["totalTokens", "total_tokens"]);
  if (promptTokens !== undefined && completionTokens !== undefined) {
      return {
        promptTokens,
        completionTokens,
        ...withOptionalReasoning(reasoningTokens),
        totalTokens: totalTokens ?? promptTokens + completionTokens,
        ...withTokenBillingDetails(record),
        source: "direct_fields",
      };
  }

  throw new Error("authoritative usage is required");
}

function cloneMetrics(...sources: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  return Object.assign({}, ...sources.filter((source): source is Record<string, unknown> => Boolean(source)));
}

export function extractAuthoritativeMediaEvidence(
  _modality: UnifiedModality,
  value: unknown,
): BillingMediaEvidence {
  const record = asRecord(value);
  if (!record) {
    throw new Error("authoritative media evidence is required");
  }

  const media = asRecord(record.media);
  const primary = media ?? record;
  const billingMetrics = cloneMetrics(
    asRecord(record.billingMetrics),
    asRecord(primary.billingMetrics),
  );

  const generatedUnits = readPositiveNumber(primary, ["generatedUnits", "generated_units"])
    ?? readPositiveMetric(billingMetrics, ["generation", "image", "video"]);
  const generatedSeconds = readPositiveNumber(primary, ["generatedSeconds", "generated_seconds", "duration", "durationSeconds", "duration_seconds"])
    ?? readPositiveMetric(billingMetrics, ["second", "duration"]);
  const requests = readPositiveNumber(primary, ["requests"])
    ?? readPositiveMetric(billingMetrics, ["request"]);

  return {
    generatedUnits,
    generatedSeconds,
    generatedMinutes: typeof generatedSeconds === "number" ? generatedSeconds / 60 : readPositiveMetric(billingMetrics, ["minute"]),
    requests,
    billingMetrics,
  };
}

function buildMetricMap(media: BillingMediaEvidence): Record<string, unknown> {
  const metrics = cloneMetrics(media.billingMetrics);

  if (typeof media.generatedUnits === "number" && media.generatedUnits > 0) {
    if (metrics.generation === undefined) metrics.generation = media.generatedUnits;
    if (metrics.image === undefined) metrics.image = media.generatedUnits;
    if (metrics.video === undefined) metrics.video = media.generatedUnits;
  }
  if (typeof media.generatedSeconds === "number" && media.generatedSeconds > 0) {
    if (metrics.second === undefined) metrics.second = media.generatedSeconds;
    if (metrics.duration === undefined) metrics.duration = media.generatedSeconds;
  }
  if (typeof media.generatedMinutes === "number" && media.generatedMinutes > 0 && metrics.minute === undefined) {
    metrics.minute = media.generatedMinutes;
  }
  if (typeof media.requests === "number" && media.requests > 0 && metrics.request === undefined) {
    metrics.request = media.requests;
  }

  return metrics;
}

function primaryKeyIncludes(primaryKey: string, fragment: string): boolean {
  return primaryKey.split("_").includes(fragment);
}

function resolveTileQuantity(primaryKey: string, metrics: Record<string, unknown>): number | undefined {
  const direct = readPositiveMetric(metrics, [primaryKey, "tile"]);
  if (direct !== undefined) {
    return direct;
  }

  const dimensionMatch = primaryKey.match(/(\d+)(?:x|_by_)(\d+)_tile/);
  if (!dimensionMatch) {
    return undefined;
  }

  const width = Number.parseInt(dimensionMatch[1], 10);
  const height = Number.parseInt(dimensionMatch[2], 10);
  const pixels = readPositiveMetric(metrics, ["pixel"]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || pixels === undefined) {
    return undefined;
  }

  return pixels / (width * height);
}

function resolveDerivedMediaQuantity(primaryKey: string, metrics: Record<string, unknown>): number | undefined {
  const factors: number[] = [];

  if (primaryKeyIncludes(primaryKey, "tile")) {
    const tileQuantity = resolveTileQuantity(primaryKey, metrics);
    if (tileQuantity !== undefined) {
      factors.push(tileQuantity);
    }
  } else if (primaryKeyIncludes(primaryKey, "megapixel")) {
    const megapixels = readPositiveMetric(metrics, [primaryKey, "megapixel"]);
    if (megapixels !== undefined) {
      factors.push(megapixels);
    }
  } else if (primaryKeyIncludes(primaryKey, "pixel")) {
    const pixels = readPositiveMetric(metrics, [primaryKey, "pixel"]);
    if (pixels !== undefined) {
      factors.push(pixels);
    }
  }

  if (primaryKeyIncludes(primaryKey, "step")) {
    const steps = readPositiveMetric(metrics, ["step"]);
    if (steps !== undefined) {
      factors.push(steps);
    }
  }

  if (primaryKeyIncludes(primaryKey, "second")) {
    const seconds = readPositiveMetric(metrics, [primaryKey, "second", "duration"]);
    if (seconds !== undefined) {
      factors.push(seconds);
    }
  }

  if (primaryKeyIncludes(primaryKey, "minute")) {
    const minutes = readPositiveMetric(metrics, [primaryKey, "minute"]);
    if (minutes !== undefined) {
      factors.push(minutes);
    }
  }

  if (factors.length > 0) {
    return factors.reduce((product, factor) => product * factor, 1);
  }

  if (primaryKeyIncludes(primaryKey, "image") || primaryKeyIncludes(primaryKey, "generation")) {
    return readPositiveMetric(metrics, [primaryKey, "generation", "image", "request"]);
  }

  if (primaryKeyIncludes(primaryKey, "video")) {
    return readPositiveMetric(metrics, [primaryKey, "generation", "video", "request"]);
  }

  if (primaryKeyIncludes(primaryKey, "request") || primaryKeyIncludes(primaryKey, "run")) {
    return readPositiveMetric(metrics, [primaryKey, "request"]);
  }

  return undefined;
}

function unitPriceAliasesForMediaPrimaryKey(primaryKey: string): string[] {
  const aliases = ["output", "cost", "price"];

  if (primaryKey === "generation") {
    aliases.push("image", "video");
  }
  if (primaryKey === "image") {
    aliases.push("generation");
  }
  if (primaryKey === "video") {
    aliases.push("generation");
  }
  if (primaryKeyIncludes(primaryKey, "step")) {
    aliases.push("step");
  }
  if (primaryKeyIncludes(primaryKey, "tile")) {
    aliases.push("tile");
  }
  if (primaryKeyIncludes(primaryKey, "megapixel")) {
    aliases.push("megapixel");
  }
  if (primaryKeyIncludes(primaryKey, "pixel")) {
    aliases.push("pixel");
  }
  if (primaryKeyIncludes(primaryKey, "second")) {
    aliases.push("second", "duration");
  }
  if (primaryKeyIncludes(primaryKey, "minute")) {
    aliases.push("minute");
  }
  if (primaryKeyIncludes(primaryKey, "image")) {
    aliases.push("image", "generation");
  }
  if (primaryKeyIncludes(primaryKey, "video")) {
    aliases.push("video", "generation");
  }

  return [...new Set(aliases.flatMap((alias) => [alias, `per_${alias}`]))];
}

function resolveValuePrice(values: Record<string, number>, key: string, aliases: string[] = []): number {
  for (const alias of [key, ...aliases]) {
    const value = values[alias];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  const numericValues = Object.values(values).filter((value): value is number => (
    typeof value === "number" && Number.isFinite(value) && value > 0
  ));
  if (numericValues.length === 1) {
    return numericValues[0];
  }

  throw new Error(`pricing.values.${key} is required`);
}

function resolveCompositeUnitPrice(values: Record<string, number>, metrics: Record<string, unknown>): { key: string; unitPriceUsd: number } {
  const resolution = readMetricString(metrics, ["resolution", "size"]);
  const duration = readPositiveMetric(metrics, ["duration", "second"]);
  if (!resolution || !duration) {
    throw new Error("authoritative billable quantity is required: run_resolution_duration");
  }

  const resolutionDigits = (resolution.match(/\d+/g) || []).join("");
  const durationDigits = String(Math.round(duration));
  const matches = Object.entries(values).filter(([key, value]) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return false;
    }
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return normalized.includes(resolutionDigits)
      && (normalized.includes(`${durationDigits}seconds`) || normalized.includes(`${resolutionDigits}${durationDigits}`));
  });

  if (matches.length !== 1) {
    throw new Error(`pricing is ambiguous for run_resolution_duration (${resolution}, ${durationDigits}s)`);
  }

  const [[key, unitPriceUsd]] = matches;
  return { key, unitPriceUsd };
}

function tokenUnitCategory(unit: string): string | null {
  const match = unit.match(/^[a-z]{3}_per_(.+)_tokens$/);
  if (!match) {
    return null;
  }

  const fragment = match[1];
  if (/^\d+[km]?$/.test(fragment)) {
    return null;
  }

  return normalizeValueKey(fragment.replace(/^\d+[km]?_/, ""));
}

function isTokenUnit(unit: string): boolean {
  return /^[a-z]{3}_per_.+_tokens$/.test(unit);
}

export function pricingHasTokenSections(pricing: ModelPricing | BillingPrice | null | undefined): boolean {
  if (!pricing) {
    return false;
  }

  return extractBillingSections(pricing).some((section) => isTokenUnit(section.unit));
}

function tokenSectionCategory(section: BillingPriceSection, totalTokenSections: number): string | null {
  const unitCategory = tokenUnitCategory(section.unit);
  if (unitCategory) {
    return unitCategory;
  }

  if (totalTokenSections === 1) {
    return "generic";
  }

  const header = normalizeText(section.header || "");
  const headerMatch = header.match(/^(.+)\s+tokens?$/);
  if (headerMatch) {
    return normalizeValueKey(headerMatch[1]);
  }

  return null;
}

function hasSpecificTokenBreakdown(metrics: Record<string, unknown> | undefined): boolean {
  if (!metrics) {
    return false;
  }

  return Object.keys(metrics).some((key) =>
    /^(cached_)?input_.+_tokens$/.test(key) || /^output_.+_tokens$/.test(key),
  );
}

function buildTokenLineItems(args: {
  subject: string;
  sections: BillingPriceSection[];
  usage: AuthoritativeUsage;
}): Array<MeterLineItem & { source: "provider_response" | "request" }> {
  const lineItems: Array<MeterLineItem & { source: "provider_response" | "request" }> = [];
  const billingMetrics = args.usage.billingMetrics;
  const multipleSections = args.sections.length > 1;

  if (multipleSections && !hasSpecificTokenBreakdown(billingMetrics)) {
    throw new Error("authoritative token usage breakdown is required");
  }

  for (const section of args.sections) {
    const category = tokenSectionCategory(section, args.sections.length);
    if (!category) {
      throw new Error(`pricing token section category is ambiguous: ${section.header || section.unit}`);
    }

    const inputTotal = category === "generic"
      ? args.usage.promptTokens
      : readNonNegativeMetric(billingMetrics || {}, [`input_${category}_tokens`]);
    const cachedInput = category === "generic"
      ? (args.usage.cachedInputTokens ?? readNonNegativeMetric(billingMetrics || {}, ["cached_input_tokens"]))
      : readNonNegativeMetric(billingMetrics || {}, [`cached_input_${category}_tokens`]);
    const outputTotal = category === "generic"
      ? args.usage.completionTokens
      : readNonNegativeMetric(billingMetrics || {}, [`output_${category}_tokens`]);
    const reasoningTokens = category === "generic" || category === "text"
      ? (args.usage.reasoningTokens ?? readNonNegativeMetric(billingMetrics || {}, ["reasoning_tokens"]))
      : undefined;

    if (typeof inputTotal === "number" && inputTotal > 0 && typeof cachedInput === "number" && cachedInput > inputTotal) {
      throw new Error("authoritative usage is invalid: cached input tokens exceed total input tokens");
    }

    if (typeof section.values.cached_input === "number" && typeof cachedInput === "number" && cachedInput > 0) {
      lineItems.push({
        key: category === "generic" ? "cached_input_tokens" : `${category}_cached_input_tokens`,
        unit: section.unit,
        quantity: cachedInput,
        unitPriceUsd: section.values.cached_input,
        source: "provider_response",
      });
    }

    const billableInput = typeof inputTotal === "number"
      ? (typeof section.values.cached_input === "number" && typeof cachedInput === "number"
        ? inputTotal - cachedInput
        : inputTotal)
      : undefined;
    if (typeof section.values.input === "number" && typeof billableInput === "number" && billableInput > 0) {
      lineItems.push({
        key: category === "generic" ? "input_tokens" : `${category}_input_tokens`,
        unit: section.unit,
        quantity: billableInput,
        unitPriceUsd: section.values.input,
        source: "provider_response",
      });
    }

    const pricedReasoningTokens = typeof section.values.reasoning === "number" && typeof reasoningTokens === "number" && reasoningTokens > 0
      ? reasoningTokens
      : 0;
    const billableOutput = typeof outputTotal === "number"
      ? (pricedReasoningTokens > 0 ? outputTotal - pricedReasoningTokens : outputTotal)
      : undefined;
    if (typeof billableOutput === "number" && billableOutput < 0) {
      throw new Error("authoritative usage is invalid: reasoningTokens exceed completionTokens");
    }

    if (typeof section.values.output === "number" && typeof billableOutput === "number" && billableOutput > 0) {
      lineItems.push({
        key: category === "generic" ? "output_tokens" : `${category}_output_tokens`,
        unit: section.unit,
        quantity: billableOutput,
        unitPriceUsd: section.values.output,
        source: "provider_response",
      });
    }

    if (pricedReasoningTokens > 0) {
      lineItems.push({
        key: category === "generic" ? "reasoning_tokens" : `${category}_reasoning_tokens`,
        unit: section.unit,
        quantity: pricedReasoningTokens,
        unitPriceUsd: section.values.reasoning!,
        source: "provider_response",
      });
    }

    const hasDirectionalPrices = typeof section.values.input === "number"
      || typeof section.values.output === "number"
      || typeof section.values.cached_input === "number"
      || typeof section.values.reasoning === "number";

    if (!hasDirectionalPrices && typeof section.values.cost === "number") {
      const totalTokens = (typeof inputTotal === "number" ? inputTotal : 0) + (typeof outputTotal === "number" ? outputTotal : 0);
      if (totalTokens > 0) {
        lineItems.push({
          key: category === "generic" ? "tokens" : `${category}_tokens`,
          unit: section.unit,
          quantity: totalTokens,
          unitPriceUsd: section.values.cost,
          source: "provider_response",
        });
      }
    }
  }

  if (lineItems.length === 0) {
    throw new Error("authoritative billable quantity is required: usage");
  }

  return lineItems;
}

function optionTierIndex(options: Array<string | number>, value: unknown): number {
  const rankedOptions = options.map((option, index) => ({
    option,
    index,
    rank: rankOptionValue(option),
  }));

  if (rankedOptions.some((entry) => entry.rank === null)) {
    return -1;
  }

  const ordered = [...rankedOptions]
    .sort((left, right) => ((left.rank as number) - (right.rank as number)) || (left.index - right.index));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].rank === ordered[index - 1].rank) {
      return -1;
    }
  }

  return ordered.findIndex((entry) => String(entry.option) === String(value));
}

function resolveParamDrivenMediaSection(args: {
  subject: string;
  modality: UnifiedModality;
  sections: BillingPriceSection[];
  metrics: Record<string, unknown>;
}): BillingPriceSection | null {
  if (args.sections.length <= 1 || (args.modality !== "image" && args.modality !== "video")) {
    return null;
  }

  const modelId = args.subject.includes(":")
    ? args.subject.slice(args.subject.indexOf(":") + 1)
    : args.subject;
  const params = resolveModelParams(modelId, args.modality === "video" ? "video" : "image");
  if (!params) {
    return null;
  }

  const candidates = Object.entries(params.params)
    .flatMap(([key, definition]) => {
      if (!Array.isArray(definition.options) || definition.options.length !== args.sections.length) {
        return [];
      }

      const selectedValue = args.metrics[key];
      if (selectedValue === undefined) {
        return [];
      }

      const selectedIndex = optionTierIndex(definition.options, selectedValue);
      if (selectedIndex < 0) {
        return [];
      }

      const defaultValue = params.defaults[key];
      const defaultIndex = defaultValue === undefined ? -1 : optionTierIndex(definition.options, defaultValue);
      return [{
        key,
        selectedIndex,
        changed: defaultIndex >= 0 ? selectedIndex !== defaultIndex : false,
      }];
    });

  if (candidates.length === 0) {
    return null;
  }

  const selectedIndices = [...new Set(candidates.map((candidate) => candidate.selectedIndex))];
  if (selectedIndices.length === 1) {
    return args.sections[selectedIndices[0]] || null;
  }

  const changed = candidates.filter((candidate) => candidate.changed);
  const changedIndices = [...new Set(changed.map((candidate) => candidate.selectedIndex))];
  if (changedIndices.length === 1) {
    return args.sections[changedIndices[0]] || null;
  }

  throw new Error("pricing is ambiguous for selected parameters");
}

function resolveMediaBillingSection(args: {
  subject: string;
  modality: UnifiedModality;
  sections: BillingPriceSection[];
  metrics: Record<string, unknown>;
}): BillingPriceSection {
  const paramDriven = resolveParamDrivenMediaSection(args);
  if (paramDriven) {
    return paramDriven;
  }

  return resolveBillingSection(args.sections);
}

function buildMeteredMediaBilling(args: {
  subject: string;
  pricing: BillingPrice;
  media: BillingMediaEvidence;
  source: "provider_response" | "request";
}): AuthoritativeBillingRecord {
  const metrics = buildMetricMap(args.media);
  const unit = args.pricing.unit;

  if (unit.endsWith("_per_run_resolution_duration")) {
    const resolved = resolveCompositeUnitPrice(args.pricing.values, metrics);
    return {
      subject: args.subject,
      lineItems: [
        {
          key: resolved.key,
          unit,
          quantity: 1,
          unitPriceUsd: resolved.unitPriceUsd,
          source: args.source,
        },
      ],
    };
  }

  const primaryKey = primaryValueKeyForUnit(unit);
  if (!primaryKey) {
    throw new Error(`unsupported pricing unit: ${unit}`);
  }

  const quantityAliases = primaryKey === "generation"
    ? ["generation", "image", "video", "request"]
    : primaryKey === "image"
      ? ["image", "generation", "request"]
      : primaryKey === "video"
        ? ["video", "generation", "request"]
        : primaryKey === "second"
          ? ["second", "duration"]
          : primaryKey === "minute"
            ? ["minute"]
            : primaryKey.endsWith("_megapixel")
              ? [primaryKey, "megapixel"]
              : primaryKey.endsWith("_pixel")
                ? [primaryKey, "pixel"]
                : primaryKey.endsWith("_second")
                  ? [primaryKey, "second", "duration"]
                  : primaryKey.endsWith("_minute")
                    ? [primaryKey, "minute"]
                    : [primaryKey];

  const unitPriceAliases = unitPriceAliasesForMediaPrimaryKey(primaryKey);

  const quantity = requirePositiveQuantity(
    readPositiveMetric(metrics, quantityAliases) ?? resolveDerivedMediaQuantity(primaryKey, metrics),
    primaryKey,
  );
  const unitPriceUsd = resolveValuePrice(args.pricing.values, primaryKey, unitPriceAliases);

  return {
    subject: args.subject,
    lineItems: [
      {
        key: primaryKey,
        unit,
        quantity,
        unitPriceUsd,
        source: args.source,
      },
    ],
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

  const sections = extractBillingSections(args.pricing);
  const tokenSections = sections.filter((section) => isTokenUnit(section.unit));
  const mediaSections = sections.filter((section) => !isTokenUnit(section.unit));
  const lineItems: Array<MeterLineItem & { source: "provider_response" | "request" }> = [];
  const usage = tokenSections.length > 0 && args.usage !== undefined && args.usage !== null
    ? extractAuthoritativeUsage(args.usage)
    : null;
  const mediaEvidence = mediaSections.length > 0 ? extractAuthoritativeMediaEvidence(args.modality, args.media) : null;
  const mediaMetrics = mediaEvidence ? buildMetricMap(mediaEvidence) : {};

  if (usage && tokenSections.length > 0) {
    lineItems.push(
      ...buildTokenLineItems({
        subject: args.subject,
        sections: tokenSections,
        usage,
      }),
    );
  }

  const hasImageTokenBreakdown = usage
    && usage.billingMetrics
    && (
      readNonNegativeMetric(usage.billingMetrics, ["input_image_tokens"]) !== undefined
      || readNonNegativeMetric(usage.billingMetrics, ["output_image_tokens"]) !== undefined
    );
  const duplicateImageGenerationPricing = hasImageTokenBreakdown
    && mediaSections.length > 0
    && mediaSections.every((section) => normalizeText(section.header || "").includes("image generation"));

  if (mediaSections.length > 0 && !duplicateImageGenerationPricing) {
    const pricing = resolveMediaBillingSection({
      subject: args.subject,
      modality: args.modality,
      sections: mediaSections,
      metrics: mediaMetrics,
    });
    lineItems.push(
      ...buildMeteredMediaBilling({
        subject: args.subject,
        pricing: {
          unit: pricing.unit,
          values: pricing.values,
        },
        media: mediaEvidence!,
        source: "provider_response",
      }).lineItems,
    );
  }

  if (lineItems.length > 0) {
    return {
      subject: args.subject,
      lineItems,
    };
  }

  if (tokenSections.length > 0 && usage === null) {
    throw new Error("authoritative usage is required");
  }

  throw new Error("pricing values are required");
}

export function buildRequestBilling(args: {
  subject: string;
  modality: UnifiedModality;
  pricing: ModelPricing | BillingPrice;
  metrics?: Record<string, unknown>;
}): AuthoritativeBillingRecord {
  if (!args.metrics) {
    throw new Error("authoritative billable quantity is required: request");
  }

  const mediaSections = extractBillingSections(args.pricing).filter((section) => !isTokenUnit(section.unit));
  if (mediaSections.length === 0) {
    throw new Error("token pricing cannot be authorized from request metrics");
  }
  const pricing = resolveMediaBillingSection({
    subject: args.subject,
    modality: args.modality,
    sections: mediaSections,
    metrics: args.metrics,
  });

  return buildMeteredMediaBilling({
    subject: args.subject,
    pricing: {
      unit: pricing.unit,
      values: pricing.values,
    },
    media: {
      billingMetrics: args.metrics,
      requests: readPositiveMetric(args.metrics, ["request"]),
    },
    source: "request",
  });
}
