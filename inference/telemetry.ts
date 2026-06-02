import type { Modality, Usage } from "./core.js";
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

export interface AuthoritativeUsage extends Usage {
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
  const strict = isStrictMetricKey(normalized);
  const fragments = normalized
    .split("_")
    .filter((fragment) => /[a-z]/.test(fragment));
  const tail = fragments.length > 0 ? fragments[fragments.length - 1] : "";
  return [...new Set([
    key,
    normalized,
    singular,
    plural,
    ...(strict ? [] : [tail]),
    `num_${singular}`,
    `num_${plural}`,
    `number_of_${singular}`,
    `number_of_${plural}`,
    `total_${singular}`,
    `total_${plural}`,
  ])];
}

function isStrictMetricKey(normalized: string): boolean {
  return /^(cached_)?input_.+_tokens?$/.test(normalized)
    || /^output_.+_tokens?$/.test(normalized)
    || normalized === "cached_input_tokens"
    || normalized === "cached_input_token"
    || normalized === "reasoning_tokens"
    || normalized === "reasoning_token";
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
  const candidates = keys.flatMap((key) => {
    const strict = isStrictMetricKey(normalizeValueKey(key));
    return metricKeyCandidates(key).map((candidate) => ({
      strict,
      value: normalizeValueKey(candidate),
    }));
  });
  const matches = normalizedMetricEntries(metrics)
    .filter((entry) =>
      candidates.some((candidate) =>
        candidate.strict
          ? entry.normalized === candidate.value
          : metricNameMatches(entry.normalized, candidate.value),
      ),
    )
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
  if (/^usd_per_\d+[km](?:_.+)?_tokens$/.test(unit) || unit.endsWith("_per_1m_tokens")) {
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

  return singularize(fragment.replace(/^\d+[km]_/, ""));
}

/**
 * Map a unit-fragment plural to its singular canonical form.
 *
 * Pluralization is deliberately conservative: only known suffixes are
 * stripped, so already-singular fragments (`compute_second`,
 * `audio_minute`, `audio_hour`, `infill_character`) pass through
 * unchanged.
 */
function singularize(fragment: string): string {
  // "1k_searches" → "searches" → "search"; "voices" → "voice"
  // "tokens" → "token"; "pages" → "page"; "minutes" → "minute".
  // "audio_seconds" → "audio_second"; "compute_seconds" → "compute_second".
  // Already singular: "compute_second" / "audio_minute" / "infill_character".
  if (fragment.endsWith("ches") || fragment.endsWith("shes") || fragment.endsWith("xes") || fragment.endsWith("zes") || fragment.endsWith("sses")) {
    return fragment.slice(0, -2);                     // "searches"→"search"
  }
  if (fragment.endsWith("ies") && fragment.length > 3) {
    return fragment.slice(0, -3) + "y";               // "queries"→"query"
  }
  if (fragment.endsWith("s") && !fragment.endsWith("ss")) {
    return fragment.slice(0, -1);                     // "voices"→"voice"
  }
  return fragment;
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
    values: normalizeBillingValuesForUnit(unitValue, source),
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

function normalizeBillingValuesForUnit(unitValue: string, source: Record<string, unknown>): Record<string, number> {
  const unit = normalizeUnit(unitValue);
  return normalizeBillingValues(unit, source);
}

function isPrivatePricingValueKey(normalizedKey: string): boolean {
  return normalizedKey === "growth"
    || normalizedKey === "enterprise"
    || normalizedKey === "prepaid"
    || normalizedKey === "pre_paid"
    || normalizedKey.includes("batch")
    || normalizedKey.includes("cached")
    || normalizedKey.includes("cache");
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

  if (isPrivatePricingValueKey(normalizedKey)) {
    return null;
  }

  if (normalizedKey.startsWith("price_") || normalizedKey.startsWith("context_") || normalizedKey === "slug" || normalizedKey === "tab" || normalizedKey === "category" || normalizedKey === "label" || normalizedKey === "href" || normalizedKey === "kind" || normalizedKey === "inferred" || normalizedKey === "inferred_confidence" || normalizedKey === "inferred_method") {
    return null;
  }

  const primary = primaryValueKeyForUnit(unit);
  if (normalizedKey === "input" || normalizedKey === "output" || normalizedKey === "cached_input" || normalizedKey === "reasoning") {
    return primary && !isTokenUnit(unit) ? primary : normalizedKey;
  }

  if (!primary) {
    return normalizedKey === "cost" || normalizedKey === "price" ? "cost" : normalizedKey;
  }

  if (normalizedKey === "cost" || normalizedKey === "price" || normalizedKey === "pay_as_you_go") {
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

function buildMixedBillingSections(record: Record<string, unknown>): BillingPriceSection[] {
  if (typeof record.unit !== "string" || normalizeValueKey(record.unit) !== "mixed") {
    return [];
  }

  const mappings = [
    ["perImage", "per_image_usd"],
    ["per_image", "per_image_usd"],
    ["perSecond", "per_second_usd"],
    ["per_second", "per_second_usd"],
    ["perMinute", "per_minute_usd"],
    ["per_minute", "per_minute_usd"],
  ] as const;

  const sections: BillingPriceSection[] = [];
  for (const [field, unitLabel] of mappings) {
    const amount = record[field];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const unit = normalizeUnit(unitLabel);
    sections.push({
      header: displayUnit(unit).replace(/^Per /, "").replace(/\b\w/g, (char) => char.toUpperCase()),
      unit,
      values: normalizeBillingValuesForUnit(unit, { cost: amount }),
      default: true,
    });
  }

  return sections;
}

function buildDynamicBillingSections(record: Record<string, unknown>): BillingPriceSection[] {
  const mixedSections = buildMixedBillingSections(record);
  if (mixedSections.length > 0) {
    return mixedSections;
  }

  const explicitUnit = typeof record.unit === "string" && record.unit.trim().length > 0 ? record.unit : null;
  if (explicitUnit) {
    try {
      return [buildBillingSection(explicitUnit, record, typeof record.header === "string" ? record.header : "Pricing", true)];
    } catch {
      // Continue to other explicit pricing shapes.
    }
  }

  const tokenRecord = asRecord(record.token);
  if (tokenRecord) {
    const tokenSections = buildDynamicBillingSections({
      ...tokenRecord,
      kind: "tokens",
    });
    if (tokenSections.length > 0) {
      return tokenSections;
    }
  }

  const groupedSections = new Map<string, BillingPriceSection>();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }

    const match = key.match(/^(input|output|cached_input|reasoning)_per_(.+?)(?:_usd)?$/);
    if (!match) {
      continue;
    }

    const rawFragment = match[2];
    const normalizedFragment = record.kind === "tokens" && !/token/.test(rawFragment)
      ? `${rawFragment}_tokens`
      : rawFragment;
    const unit = normalizeUnit(`per_${normalizedFragment}_usd`);
    const valueKey = normalizePricingValueKey(unit, match[1]);
    if (!valueKey) {
      continue;
    }
    const section = groupedSections.get(unit) || {
      header: displayUnit(unit).replace(/^Per /, "").replace(/\b\w/g, (char) => char.toUpperCase()),
      unit,
      values: {},
      default: true,
    };
    section.values[valueKey] = value;
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

function pricingSectionText(section: Record<string, unknown>, includeRaw: boolean): string {
  const source = asRecord(section.source);
  return [
    section.header,
    section.unit,
    section.unitKey,
    source?.section,
    source?.row,
    includeRaw ? source?.raw : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isPrivatePricingSection(section: Record<string, unknown>): boolean {
  const sectionText = pricingSectionText(section, false);
  const rawText = pricingSectionText(section, true);

  return /\bbatch(?:ed)?\b/.test(rawText)
    || /pre[\s_-]?paid/.test(rawText)
    || /\bcach(?:e|ed|ing)\b/.test(sectionText);
}

function inferredTokenHeaderFromSource(section: Record<string, unknown>, unit: string): string | undefined {
  if (!isTokenUnit(normalizeUnit(unit))) {
    return undefined;
  }

  const header = typeof section.header === "string" ? section.header.trim() : "";
  if (header && normalizeValueKey(header) !== "default") {
    return header;
  }

  const source = asRecord(section.source);
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const rowText = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => [row.type, row.priceName, row.rawUnit].filter((value): value is string => typeof value === "string").join(" "))
    .join(" ")
    .toLowerCase();

  const categories = [
    ["audio", /\baudio\b/],
    ["vision", /\b(?:vision|image|video)\b/],
    ["text", /\btext\b/],
  ] as const;
  const matches = categories
    .filter(([, pattern]) => pattern.test(rowText))
    .map(([category]) => category);

  return matches.length === 1 ? `${matches[0]} tokens` : undefined;
}

function parsePositivePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseFloat(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function tokenEntriesFromSourceRows(section: Record<string, unknown>, unit: string): Record<string, number> | null {
  if (!isTokenUnit(normalizeUnit(unit))) {
    return null;
  }

  const source = asRecord(section.source);
  const raw = typeof source?.raw === "string" ? source.raw : "";
  const cells = raw.split("|").map((cell) => cell.trim()).slice(1);
  const parsedRaw: Record<string, number> = {};
  if (cells.length >= 3) {
    const input = parsePositivePrice(cells[0]);
    const cachedInput = parsePositivePrice(cells[1]);
    const output = parsePositivePrice(cells[2]);
    if (input !== null) parsedRaw.input = input;
    if (cachedInput !== null) parsedRaw.cached_input = cachedInput;
    if (output !== null) parsedRaw.output = output;
  }

  const entries = asRecord(section.entries);
  if (entries) {
    const hasDirectionalPrices = ["input", "output", "cached_input", "reasoning"].some((key) => {
      const value = entries[key];
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    });
    if (hasDirectionalPrices) {
      const hasInput = typeof entries.input === "number" && Number.isFinite(entries.input) && entries.input > 0;
      const hasOutput = typeof entries.output === "number" && Number.isFinite(entries.output) && entries.output > 0;
      if ((!hasInput || !hasOutput) && typeof parsedRaw.input === "number" && typeof parsedRaw.output === "number") {
        return parsedRaw;
      }
      return null;
    }
  }

  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const values: Record<string, number> = {};
  for (const rowValue of rows) {
    const row = asRecord(rowValue);
    if (!row) {
      continue;
    }

    const text = [row.type, row.priceName, row.rawUnit]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const normalizedText = normalizeValueKey(text);
    if (isPrivatePricingValueKey(normalizedText)) {
      continue;
    }

    const price = parsePositivePrice(row.rawPrice ?? row.price);
    if (price === null) {
      continue;
    }

    const key = /\b(output|completion)\b/.test(normalizeText(text)) || normalizedText.includes("output_token")
      ? "output"
      : /\b(input|prompt)\b/.test(normalizeText(text)) || normalizedText.includes("input_token")
        ? "input"
        : null;
    if (!key) {
      continue;
    }

    values[key] = Math.max(values[key] ?? 0, price);
  }

  if (Object.keys(values).length > 0) {
    return values;
  }

  return Object.keys(parsedRaw).length > 0 ? parsedRaw : null;
}

function buildSectionFromCompiled(section: Record<string, unknown>): BillingPriceSection | null {
  const entries = asRecord(section.entries);
  const unit = typeof section.unitKey === "string"
    ? section.unitKey
    : typeof section.unit === "string"
      ? section.unit
      : null;
  if (!entries || !unit) {
    return null;
  }

  try {
    const effectiveEntries = tokenEntriesFromSourceRows(section, unit) ?? entries;
    return buildBillingSection(
      unit,
      effectiveEntries,
      inferredTokenHeaderFromSource(section, unit) ?? (typeof section.header === "string" ? section.header : undefined),
      section.default === true,
    );
  } catch {
    return null;
  }
}

function splitCategorizedTokenEntries(section: Record<string, unknown>): BillingPriceSection[] | null {
  const entries = asRecord(section.entries);
  const unitValue = typeof section.unitKey === "string"
    ? section.unitKey
    : typeof section.unit === "string"
      ? section.unit
      : null;
  if (!entries || !unitValue) {
    return null;
  }

  const unit = normalizeUnit(unitValue);
  if (!isTokenUnit(unit)) {
    return null;
  }

  const grouped = new Map<string, Record<string, number>>();
  for (const [rawKey, value] of Object.entries(entries)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }

    const normalizedKey = normalizeValueKey(rawKey);
    if (isPrivatePricingValueKey(normalizedKey)) {
      continue;
    }

    const match = normalizedKey.match(/^(input|output|reasoning)_(text|audio|image|video|vision)$/);
    if (!match) {
      continue;
    }

    const [, direction, category] = match;
    const values = grouped.get(category) || {};
    values[direction] = value;
    grouped.set(category, values);
  }

  if (grouped.size === 0) {
    return null;
  }

  return [...grouped.entries()].map(([category, values]) => ({
    header: `${category} tokens`,
    unit,
    values,
    default: section.default === true,
  }));
}

function isGenericTokenPricingSection(section: Record<string, unknown>): boolean {
  const unit = typeof section.unitKey === "string"
    ? section.unitKey
    : typeof section.unit === "string"
      ? section.unit
      : "";
  try {
    if (!isTokenUnit(normalizeUnit(unit))) {
      return false;
    }
  } catch {
    return false;
  }

  const header = typeof section.header === "string" ? normalizeValueKey(section.header) : "";
  return header === "" || header === "pricing" || header === "tokens" || header === "input_output_tokens";
}

function normalizeSectionDefaults(sections: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return sections.map((section) => {
    if (section.default !== true || !isGenericTokenPricingSection(section)) {
      return section;
    }

    const key = `${String(section.unitKey || section.unit || "")}\u0000${String(section.header || "")}`;
    if (!seen.has(key)) {
      seen.add(key);
      return section;
    }

    const { default: _default, ...rest } = section;
    return rest;
  });
}

export function normalizeCompiledPricing(pricing: ModelPricing | BillingPrice): ModelPricing | BillingPrice {
  if (isStructuredPricing(pricing)) {
    return {
      unit: normalizeUnit(pricing.unit),
      values: normalizeBillingValuesForUnit(pricing.unit, pricing.values),
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
    .filter((section) => !isPrivatePricingSection(section))
    .flatMap((section) => {
      const splitTokenSections = splitCategorizedTokenEntries(section);
      if (splitTokenSections) {
        return splitTokenSections.map((built) => ({
          ...(built.header ? { header: built.header } : {}),
          ...(section.default === true ? { default: true } : {}),
          unit: displayUnit(built.unit),
          unitKey: built.unit,
          entries: built.values,
        }));
      }

      const built = buildSectionFromCompiled(section);
      if (!built) {
        return [];
      }

      return [{
        ...(built.header ? { header: built.header } : {}),
        ...(section.default === true ? { default: true } : {}),
        unit: typeof section.unit === "string" ? section.unit : displayUnit(built.unit),
        unitKey: built.unit,
        entries: built.values,
      }];
    });

  return {
    ...record,
    sections: normalizeSectionDefaults(normalizedSections),
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
      .map((section) => buildSectionFromCompiled(section))
      .filter((section): section is BillingPriceSection => Boolean(section));

    if (normalizedSections.length > 0) {
      return normalizedSections;
    }
  }

  if (isStructuredPricing(record)) {
    return [{
      unit: normalizeUnit(record.unit),
      values: normalizeBillingValuesForUnit(record.unit, record.values),
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
  _modality?: Modality,
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

  // Embeddings-only models report only input/prompt token counts; treat
  // a missing completion as zero rather than rejecting the usage envelope.
  if (promptTokens !== undefined) {
    return {
      promptTokens,
      completionTokens: 0,
      ...withOptionalReasoning(reasoningTokens),
      totalTokens: totalTokens ?? promptTokens,
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
  _modality: Modality,
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

  // Cross-derive time-aliases so callers don't need to know whether
  // the unit is `audio_second` / `compute_second` / `audio_minute` /
  // `audio_hour`. One canonical second ⇄ minute ⇄ hour ladder.
  const seconds = readPositiveMetric(metrics, ["second", "duration", "audio_second", "compute_second"]);
  if (seconds !== undefined) {
    if (metrics.second === undefined) metrics.second = seconds;
    if (metrics.duration === undefined) metrics.duration = seconds;
    if (metrics.audio_second === undefined) metrics.audio_second = seconds;
    if (metrics.compute_second === undefined) metrics.compute_second = seconds;
    if (metrics.minute === undefined) metrics.minute = seconds / 60;
    if (metrics.audio_minute === undefined) metrics.audio_minute = seconds / 60;
    if (metrics.hour === undefined) metrics.hour = seconds / 3600;
    if (metrics.audio_hour === undefined) metrics.audio_hour = seconds / 3600;
  }

  // Cross-derive megapixel ⇄ pixel.
  const pixels = readPositiveMetric(metrics, ["pixel", "processed_pixel"]);
  if (pixels !== undefined) {
    if (metrics.megapixel === undefined) metrics.megapixel = pixels / 1_000_000;
    if (metrics.processed_megapixel === undefined) metrics.processed_megapixel = pixels / 1_000_000;
  }
  const megapixels = readPositiveMetric(metrics, ["megapixel", "processed_megapixel"]);
  if (megapixels !== undefined && metrics.pixel === undefined) {
    metrics.pixel = megapixels * 1_000_000;
  }

  // Search aliases (Cohere rerank, knowledge tools).
  const requests = readPositiveMetric(metrics, ["request", "search"]);
  if (requests !== undefined) {
    if (metrics.search === undefined) metrics.search = requests;
    if (metrics.page === undefined) metrics.page = requests;
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

  // Single-tier sections labelled with a provider-specific key
  // (e.g. "transcription", "voice_changer", "generation",
  // "entity_detection", "infill_character"): when only one positive
  // value exists, take it. We never silently pick "the cheapest" of
  // multiple values — that would invent a price tier the caller did
  // not select.
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

function hasNonTextOutputTokenBreakdown(metrics: Record<string, unknown> | undefined): boolean {
  if (!metrics) {
    return false;
  }

  return Object.keys(metrics).some((key) => /^output_(?!text_).+_tokens$/.test(normalizeValueKey(key)));
}

function parseScaledTokenCount(value: string, suffix?: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return Number.NaN;
  }

  const scale = (suffix || "").toLowerCase();
  if (scale === "m") {
    return parsed * 1_000_000;
  }
  if (scale === "k") {
    return parsed * 1_000;
  }
  return parsed;
}

function tokenRangeForSection(section: BillingPriceSection): { minExclusive?: number; maxInclusive?: number } | null {
  const header = section.header || "";
  const text = header
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[()]/g, " ")
    .toLowerCase();

  const between = text.match(/(\d+(?:\.\d+)?)\s*([km])?\s*<[^<=>]*<=\s*(\d+(?:\.\d+)?)\s*([km])?/i);
  if (between) {
    return {
      minExclusive: parseScaledTokenCount(between[1], between[2]),
      maxInclusive: parseScaledTokenCount(between[3], between[4]),
    };
  }

  const max = text.match(/(?:<=|<)\s*(\d+(?:\.\d+)?)\s*([km])?/i);
  if (max) {
    return { maxInclusive: parseScaledTokenCount(max[1], max[2]) };
  }

  const min = text.match(/>\s*(\d+(?:\.\d+)?)\s*([km])?/i);
  if (min) {
    return { minExclusive: parseScaledTokenCount(min[1], min[2]) };
  }

  return null;
}

function sectionMatchesTokenRange(section: BillingPriceSection, usage: AuthoritativeUsage): boolean {
  const range = tokenRangeForSection(section);
  if (!range) {
    return false;
  }

  const tokenCount = usage.totalTokens > 0 ? usage.totalTokens : usage.promptTokens;
  if (range.minExclusive !== undefined && tokenCount <= range.minExclusive) {
    return false;
  }
  if (range.maxInclusive !== undefined && tokenCount > range.maxInclusive) {
    return false;
  }
  return true;
}

function isPriorityProcessingSection(section: BillingPriceSection): boolean {
  return normalizeText(section.header || "").includes("priority processing");
}

function tokenSectionPriceSignature(section: BillingPriceSection): string {
  const values = Object.entries(section.values)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({ unit: section.unit, values });
}

function resolveTokenSectionsForUsage(
  sections: BillingPriceSection[],
  usage: AuthoritativeUsage,
): BillingPriceSection[] {
  if (sections.length <= 1) {
    return sections;
  }

  const sectionCategories = sections.map((section) => tokenSectionCategory(section, sections.length));
  const defaults = sections.filter((section) => section.default === true);
  if (defaults.length === 1 && sectionCategories.every((category) => category === null)) {
    return [defaults[0]];
  }

  const priceSignatures = new Set(sections.map((section) => tokenSectionPriceSignature(section)));
  if (priceSignatures.size === 1) {
    return [sections[0]];
  }

  const rangedSections = sections.filter((section) => tokenRangeForSection(section));
  if (rangedSections.length === 0) {
    return sections;
  }

  const matches = rangedSections.filter((section) => sectionMatchesTokenRange(section, usage));
  if (matches.length === 1) {
    return [matches[0]];
  }

  const regularMatches = matches.filter((section) => !isPriorityProcessingSection(section));
  if (regularMatches.length === 1) {
    return [regularMatches[0]];
  }

  return sections;
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
    const outputMetric = category === "generic"
      ? args.usage.completionTokens
      : readNonNegativeMetric(billingMetrics || {}, [`output_${category}_tokens`]);
    const outputTotal = outputMetric ?? (
      category === "text" && !hasNonTextOutputTokenBreakdown(billingMetrics)
        ? args.usage.completionTokens
        : undefined
    );
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

    const inputOnlyTotal = typeof section.values.input === "number"
      && typeof section.values.output !== "number"
      && typeof section.values.cached_input !== "number"
      && typeof section.values.reasoning !== "number"
      && inputTotal === 0
      && outputTotal === 0
      && args.usage.totalTokens > 0
        ? args.usage.totalTokens
        : inputTotal;

    const billableInput = typeof inputOnlyTotal === "number"
      ? (typeof section.values.cached_input === "number" && typeof cachedInput === "number"
        ? inputOnlyTotal - cachedInput
        : inputOnlyTotal)
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

function optionPricingTierIndex(options: Array<string | number>, value: unknown, sectionCount: number): number {
  const selectedRank = typeof value === "string" || typeof value === "number" ? rankOptionValue(value) : null;
  if (selectedRank === null) {
    return -1;
  }

  const ranked = options
    .map((option, index) => ({ index, rank: rankOptionValue(option) }))
    .filter((entry): entry is { index: number; rank: number } => entry.rank !== null)
    .sort((left, right) => (left.rank - right.rank) || (left.index - right.index));
  if (ranked.length === 0) {
    return -1;
  }

  const uniqueRanks = [...new Set(ranked.map((entry) => entry.rank))];
  let selectedRankIndex = uniqueRanks.findIndex((rank) => rank === selectedRank);
  if (selectedRankIndex < 0) {
    if (selectedRank <= uniqueRanks[0]) {
      selectedRankIndex = 0;
    } else if (selectedRank >= uniqueRanks[uniqueRanks.length - 1]) {
      selectedRankIndex = uniqueRanks.length - 1;
    } else {
      selectedRankIndex = uniqueRanks.findIndex((rank) => rank > selectedRank);
    }
  }

  return selectedRankIndex < 0 ? -1 : Math.min(sectionCount - 1, selectedRankIndex);
}

function resolveParamDrivenMediaSection(args: {
  subject: string;
  modality: Modality;
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
  const primaryKeys = new Set(
    args.sections
      .map((section) => primaryValueKeyForUnit(section.unit))
      .filter((key): key is string => Boolean(key)),
  );
  const quantityKeys = new Set(["n", "num_images", "sample_count", "sampleCount"]);
  const geometryKeys = new Set(["size", "resolution", "aspect_ratio", "width", "height"]);
  const sizeIsQuantity = [...primaryKeys].some((key) =>
    key === "pixel"
    || key === "megapixel"
    || key.endsWith("_pixel")
    || key.endsWith("_megapixel"),
  );

  const candidates = Object.entries(params.params)
    .flatMap(([key, definition]) => {
      if (quantityKeys.has(key)) {
        return [];
      }
      if (primaryKeys.has("generation") && geometryKeys.has(key)) {
        return [];
      }
      if (sizeIsQuantity && (key === "size" || key === "resolution" || key === "aspect_ratio")) {
        return [];
      }
      if (!Array.isArray(definition.options) || definition.options.length < args.sections.length) {
        return [];
      }

      const selectedValue = args.metrics[key];
      if (selectedValue === undefined) {
        return [];
      }

      const selectedIndex = optionPricingTierIndex(definition.options, selectedValue, args.sections.length);
      if (selectedIndex < 0) {
        return [];
      }

      const defaultValue = params.defaults[key];
      const defaultIndex = defaultValue === undefined ? -1 : optionPricingTierIndex(definition.options, defaultValue, args.sections.length);
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
  modality: Modality;
  sections: BillingPriceSection[];
  metrics: Record<string, unknown>;
}): BillingPriceSection[] {
  if (args.sections.length === 1) {
    return [args.sections[0]];
  }

  // Tier-based pricing (image quality, video resolution, etc.) — when
  // sections share a unit/header but differ by tier, params-handler
  // ladders pick the right one.
  const paramDriven = resolveParamDrivenMediaSection(args);
  if (paramDriven) {
    return [paramDriven];
  }

  const defaults = args.sections.filter((section) => section.default === true);

  if (defaults.length > 1) {
    const defaultParamDriven = resolveParamDrivenMediaSection({
      ...args,
      sections: defaults,
    });
    if (defaultParamDriven) {
      return [defaultParamDriven];
    }
  }

  // When multiple defaults exist with distinct unit+header pairs,
  // each represents an *additive* billing dimension (e.g. Cartesia
  // Sonic charges TTS-per-character + voice-changer-per-second +
  // infill-fee-plus-per-character simultaneously). Emit a line item
  // for each that has a positive billable quantity in the metrics.
  if (defaults.length > 1) {
    return resolveAdditiveDefaults(defaults, args.metrics);
  }

  if (defaults.length === 1) {
    return [defaults[0]];
  }

  // No defaults declared and multiple sections — strict: this is a
  // data integrity issue. Refuse to silently choose a tier.
  throw new Error("pricing is ambiguous without an explicit default");
}

/**
 * For multi-default media sections (e.g. Cartesia Sonic charging TTS
 * + voice-changer + infill simultaneously, scribe with add-ons), each
 * section is an *additive* billable dimension — emit only the ones
 * whose primary billable quantity is present in `metrics`. A section
 * without any matching metric is silently dropped (the call did not
 * use that dimension).
 *
 * If no section produces a usable metric, raise. Tier disambiguation
 * is the job of `params-handler.ts` + `resolveParamDrivenMediaSection`,
 * not this fallback.
 */
function resolveAdditiveDefaults(
  defaults: BillingPriceSection[],
  metrics: Record<string, unknown>,
): BillingPriceSection[] {
  const applicable = defaults.filter((section) => sectionHasUsableMetric(section, metrics));
  if (applicable.length === 0) {
    throw new Error("pricing is ambiguous without an explicit default");
  }
  return applicable;
}

function sectionHasUsableMetric(section: BillingPriceSection, metrics: Record<string, unknown>): boolean {
  const primary = primaryValueKeyForUnit(section.unit);
  if (!primary) {
    return false;
  }

  const genericPriceKeys = new Set([
    primary,
    `per_${primary}`,
    ...unitPriceAliasesForMediaPrimaryKey(primary),
  ]);
  const sectionSpecificKeys = Object.keys(section.values).filter((key) => !genericPriceKeys.has(key));
  if (sectionSpecificKeys.length > 0) {
    return sectionSpecificKeys.some((key) => readPositiveMetric(metrics, [key]) !== undefined);
  }

  const candidateAliases = quantityAliasesForPrimaryKey(primary);
  for (const alias of candidateAliases) {
    const value = metrics[alias];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return true;
    }
  }
  // Composite "one-time + per-X" sections always apply when at least
  // one of their value-keys has a fee in the section. Force-include.
  if (section.values.one_time_fee !== undefined) {
    return true;
  }
  return false;
}

function quantityAliasesForPrimaryKey(primaryKey: string): string[] {
  if (primaryKey === "generation") return ["generation", "image", "video", "request"];
  if (primaryKey === "image") return ["image", "generation", "request"];
  if (primaryKey === "video") return ["video", "generation", "request"];
  if (primaryKey === "second") return ["second", "duration", "compute_second"];
  if (primaryKey === "minute") return ["minute", "audio_minute"];
  if (primaryKey === "hour") return ["hour", "audio_hour"];
  if (primaryKey === "page") return ["page"];
  if (primaryKey === "search") return ["search", "request"];
  if (primaryKey === "voice") return ["voice", "generation", "request"];
  if (primaryKey === "request") return ["request", "generation"];
  if (primaryKey === "step") return ["step"];
  if (primaryKey === "tile") return ["tile"];
  if (primaryKey === "compute_second") return ["compute_second", "second", "duration"];
  if (primaryKey === "audio_second") return ["audio_second", "second", "duration"];
  if (primaryKey === "audio_minute") return ["audio_minute", "minute", "duration"];
  if (primaryKey === "audio_hour") return ["audio_hour", "hour"];
  if (primaryKey === "generated_audio_minute") return ["generated_audio_minute"];
  if (primaryKey === "infill_character") return ["infill_character", "character"];
  if (primaryKey.endsWith("_megapixel")) return [primaryKey, "megapixel"];
  if (primaryKey.endsWith("_pixel")) return [primaryKey, "pixel"];
  if (primaryKey.endsWith("_second")) return [primaryKey, "second", "duration"];
  if (primaryKey.endsWith("_minute")) return [primaryKey, "minute"];
  if (primaryKey.endsWith("_hour")) return [primaryKey, "hour"];
  if (primaryKey.endsWith("_character")) return [primaryKey, "character"];
  if (primaryKey === "character") return ["character"];
  if (primaryKey === "megapixel") return ["megapixel", "processed_megapixel"];
  if (primaryKey === "pixel") return ["pixel", "processed_pixel"];
  if (primaryKey === "duration") return ["duration", "second"];
  return [primaryKey];
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

  const quantityAliases = quantityAliasesForPrimaryKey(primaryKey);

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
  modality: Modality;
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
  const resolvedTokenSections = usage ? resolveTokenSectionsForUsage(tokenSections, usage) : tokenSections;
  const mediaEvidence = mediaSections.length > 0 ? extractAuthoritativeMediaEvidence(args.modality, args.media) : null;
  const mediaMetrics = mediaEvidence ? buildMetricMap(mediaEvidence) : {};

  if (usage && resolvedTokenSections.length > 0) {
    lineItems.push(
      ...buildTokenLineItems({
        subject: args.subject,
        sections: resolvedTokenSections,
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
    const pricingSections = resolveMediaBillingSection({
      subject: args.subject,
      modality: args.modality,
      sections: mediaSections,
      metrics: mediaMetrics,
    });
    for (const pricing of pricingSections) {
      try {
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
      } catch (error) {
        // Additive sections that don't apply this call are silently
        // skipped — Sonic infill add-on, scribe entity-detection, etc.
        if (pricingSections.length === 1) throw error;
      }
    }
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
  modality: Modality;
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
  const pricingSections = resolveMediaBillingSection({
    subject: args.subject,
    modality: args.modality,
    sections: mediaSections,
    metrics: args.metrics,
  });

  const lineItems: Array<MeterLineItem & { source: "provider_response" | "request" }> = [];
  for (const pricing of pricingSections) {
    try {
      lineItems.push(
        ...buildMeteredMediaBilling({
          subject: args.subject,
          pricing: { unit: pricing.unit, values: pricing.values },
          media: {
            billingMetrics: args.metrics,
            requests: readPositiveMetric(args.metrics, ["request"]),
          },
          source: "request",
        }).lineItems,
      );
    } catch (error) {
      if (pricingSections.length === 1) throw error;
    }
  }
  if (lineItems.length === 0) {
    throw new Error("authoritative billable quantity is required: request");
  }
  return { subject: args.subject, lineItems };
}
