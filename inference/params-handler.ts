/**
 * Universal parameter aggregator.
 *
 * Single responsibility: every inference call must succeed. When a third-
 * party request omits a required-by-the-vendor parameter (count, duration,
 * quality, resolution, …), this module fills the lowest-cost default
 * taken from the modality/family catalog already used by the router. No
 * network calls happen here.
 */
import type { Request, Response } from "express";

import { getModelById } from "./catalog/registry.js";
import { getEmbeddingParameterCatalog } from "./catalog/modalities/embeddings.js";
import { getImageParameterCatalog } from "./catalog/modalities/image.js";
import { getModelCapabilities, type CanonicalModality } from "./catalog/modalities/index.js";
import { getRealtimeParameterCatalog } from "./catalog/modalities/realtime.js";
import { getSpeechParameterCatalog } from "./catalog/modalities/speech.js";
import { getVideoParameterCatalog } from "./catalog/modalities/video.js";
import type { ModelCard } from "./types.js";

// ---------------------------------------------------------------------------
// Schema types — unchanged public surface.
// ---------------------------------------------------------------------------

export interface ParamDefinition {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  required: boolean;
  default?: string | number | boolean;
  options?: (string | number)[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

export interface ModelParams {
  modelId: string;
  provider: string;
  params: Record<string, ParamDefinition>;
}

export interface ResolvedModelParams {
  modelId: string;
  type: CanonicalModality;
  provider: string;
  params: Record<string, ParamDefinition>;
  defaults: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Rank a single option value for cost-ordering. Numeric → as-is; tier
 * names → ordinal; "1280x720" → pixels; "720p" → 720. Used by
 * `telemetry.ts` to detect monotonic option ladders for tier selection.
 */
export function rankOptionValue(value: string | number): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim().toLowerCase();
  switch (trimmed) {
    case "low": case "standard": case "draft": return 1;
    case "medium": case "auto": return 2;
    case "high": case "hd": return 3;
    case "max": case "ultra": return 4;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;

  const dim = trimmed.match(/^(\d+)\s*x\s*(\d+)$/);
  if (dim) return Number(dim[1]) * Number(dim[2]);

  const res = trimmed.match(/^(\d+)\s*p$/);
  if (res) return Number(res[1]);

  const sec = trimmed.match(/^(\d+(?:\.\d+)?)\s*s$/);
  if (sec) return Number(sec[1]);

  return null;
}

const PARAM_ALIASES: Record<string, string[]> = {
  duration: ["seconds", "duration_seconds", "durationSeconds"],
  n: ["num_images", "sample_count", "sampleCount"],
  aspect_ratio: ["aspectRatio", "size_ratio", "sizeRatio", "ratio"],
  output_format: ["format", "response_format", "responseFormat"],
};

const LOWEST_DEFAULT_KEYS = new Set([
  "duration",
  "aspect_ratio",
  "output_format",
  "n",
  "music_length_ms",
  "prompt_extend",
]);

const ALIAS_TO_CANONICAL = Object.fromEntries(
  Object.entries(PARAM_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])),
) as Record<string, string>;

function isAllowedOption(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function isDefaultValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function inferParamType(value: unknown): ParamDefinition["type"] {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  return "string";
}

function normalizeParamDefinition(raw: unknown): ParamDefinition | null {
  const record = asRecord(raw);
  if (!record) return null;

  const rawType = typeof record.type === "string" ? record.type : "";
  const options = Array.isArray(record.options) ? record.options.filter(isAllowedOption) : undefined;
  const defaultValue = isDefaultValue(record.default) ? record.default : undefined;
  const sample = options?.[0] ?? defaultValue;
  const type = ["string", "integer", "number", "boolean", "array", "object"].includes(rawType)
    ? rawType as ParamDefinition["type"]
    : inferParamType(sample);

  return {
    type,
    required: record.required === true,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof record.minimum === "number" ? { minimum: record.minimum } : {}),
    ...(typeof record.maximum === "number" ? { maximum: record.maximum } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  };
}

function normalizeDefinitions(raw: unknown): Record<string, ParamDefinition> {
  const record = asRecord(raw);
  if (!record) return {};

  const out: Record<string, ParamDefinition> = {};
  for (const [key, value] of Object.entries(record)) {
    const definition = normalizeParamDefinition(value);
    if (definition) out[key] = definition;
  }
  return out;
}

function modalityParamCatalog(modality: CanonicalModality, card?: ModelCard | null): Record<string, ParamDefinition> {
  switch (modality) {
    case "image":
      return normalizeDefinitions(getImageParameterCatalog());
    case "video":
      return normalizeDefinitions(getVideoParameterCatalog(card?.provider));
    case "audio":
      return normalizeDefinitions(getSpeechParameterCatalog(card));
    case "embedding":
      return normalizeDefinitions(getEmbeddingParameterCatalog());
    case "realtime":
      return normalizeDefinitions(getRealtimeParameterCatalog());
    case "text":
      return {};
  }
}

function canonicalDefinition(definition: ParamDefinition, canonicalKey: string): ParamDefinition {
  if (canonicalKey === "duration" || canonicalKey === "n") {
    const options = definition.options
      ?.map((value) => typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN)
      .filter((value) => Number.isFinite(value));
    const defaultValue = typeof definition.default === "number"
      ? definition.default
      : typeof definition.default === "string"
        ? Number(definition.default)
        : undefined;
    return {
      ...definition,
      type: Number.isInteger(options?.[0] ?? defaultValue) ? "integer" : "number",
      ...(options && options.length > 0 ? { options } : {}),
      ...(typeof defaultValue === "number" && Number.isFinite(defaultValue) ? { default: defaultValue } : {}),
    };
  }

  return { ...definition };
}

function addCanonicalAliases(params: Record<string, ParamDefinition>): Record<string, ParamDefinition> {
  const out = { ...params };
  for (const [canonicalKey, aliases] of Object.entries(PARAM_ALIASES)) {
    if (canonicalKey === "duration") continue;
    if (out[canonicalKey]) continue;
    const alias = aliases.find((candidate) => out[candidate]);
    if (alias) {
      out[canonicalKey] = canonicalDefinition(out[alias], canonicalKey);
    }
  }
  return out;
}

function mergeDefinitions(...sources: Array<Record<string, ParamDefinition>>): Record<string, ParamDefinition> {
  const out: Record<string, ParamDefinition> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(addCanonicalAliases(source))) {
      if (!out[key]) out[key] = { ...value, ...(value.options ? { options: [...value.options] } : {}) };
    }
  }
  return addCanonicalAliases(out);
}

function definitionsForModel(card: ModelCard | null, modality: CanonicalModality): Record<string, ParamDefinition> {
  return mergeDefinitions(modalityParamCatalog(modality, card));
}

function optionRankForParam(key: string, value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const normalizedKey = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`).toLowerCase();
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return null;

  if (normalizedKey === "size") {
    const dim = trimmed.toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
    return dim ? Number(dim[1]) * Number(dim[2]) : null;
  }

  if (normalizedKey === "resolution") {
    const res = trimmed.toLowerCase().match(/^(\d+)\s*p$/);
    return res ? Number(res[1]) : null;
  }

  return rankOptionValue(trimmed);
}

function lowestOptionForParam(key: string, options: Array<string | number>): string | number | undefined {
  const ranked = options
    .map((option, index) => ({ option, index, rank: optionRankForParam(key, option) }))
    .filter((entry): entry is { option: string | number; index: number; rank: number } => entry.rank !== null);
  if (ranked.length === 0) return options[0];
  ranked.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  return ranked[0].option;
}

function lowestDefaultForParam(key: string, def: ParamDefinition): unknown {
  if (LOWEST_DEFAULT_KEYS.has(key) && Array.isArray(def.options) && def.options.length > 0) {
    return lowestOptionForParam(key, def.options);
  }
  if ((LOWEST_DEFAULT_KEYS.has(key) || key === "resolution" || key === "size") && def.default !== undefined) {
    if (typeof def.default === "string" && def.default.trim().toLowerCase() === "auto") {
      return undefined;
    }
    return def.default;
  }
  return undefined;
}

export function buildModelParamDefaults(params: Record<string, ParamDefinition>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(params)) {
    const canonical = ALIAS_TO_CANONICAL[key];
    if (canonical && params[canonical]) continue;
    const value = lowestDefaultForParam(key, def);
    if (value !== undefined) defaults[key] = value;
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Modality detection & extraction
// ---------------------------------------------------------------------------

function pickModalityFromCard(modelId: string, preferred?: CanonicalModality): {
  modality: CanonicalModality | null;
  provider: string;
} {
  const card = getModelById(modelId);
  // When the caller declares the modality at the route level
  // (`POST /v1/images/...`, `POST /v1/videos/...`), trust it. The card's
  // classified capabilities are advisory; route intent is authoritative.
  if (preferred) return { modality: preferred, provider: card?.provider ?? "" };
  if (!card) return { modality: null, provider: "" };
  const caps = getModelCapabilities(card);
  const order: CanonicalModality[] = ["video", "image", "audio", "text", "embedding", "realtime"];
  for (const m of order) {
    if (caps.some((c) => c.modality === m)) {
      return { modality: m, provider: card.provider };
    }
  }
  return { modality: null, provider: card.provider };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function coerce(def: ParamDefinition, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (def.type === "integer") {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  }
  if (def.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  if (def.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const t = value.trim().toLowerCase();
      if (t === "true") return true;
      if (t === "false") return false;
    }
  }
  return value;
}

function extractProvided(
  params: Record<string, ParamDefinition>,
  body?: Record<string, unknown>,
): Record<string, unknown> {
  if (!body) return {};
  const custom = asRecord(body.custom_params);
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(params)) {
    const aliases = PARAM_ALIASES[key] ?? [];
    const raw = [key, ...aliases]
      .map((candidate) => custom?.[candidate] ?? body[candidate])
      .find((value) => value !== undefined);
    const coerced = coerce(def, raw);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API — same shape callers already consume.
// ---------------------------------------------------------------------------

/**
 * Resolve the optional-param schema for a model.
 *
 * Given a model id (and optionally a preferred modality hint), returns the
 * universal ladder-derived schema for that modality, with lowest-cost
 * defaults pre-computed.
 */
export function resolveModelParams(
  modelId: string,
  preferredType?: CanonicalModality | "video" | "image",
  _requestBody?: Record<string, unknown>,
): ResolvedModelParams | null {
  void _requestBody;
  const decoded = decodeURIComponent(modelId);
  const card = getModelById(decoded);
  const { modality, provider } = pickModalityFromCard(
    decoded,
    preferredType as CanonicalModality | undefined,
  );
  if (!modality) return null;

  const params = definitionsForModel(card, modality);
  return {
    modelId: decoded,
    type: modality,
    provider,
    params,
    defaults: buildModelParamDefaults(params),
  };
}

/**
 * Resolve schema + values, where every key in the schema is filled.
 * - Provided keys (in `body` or `body.custom_params`) override defaults.
 * - Missing keys fall back to the lowest-cost default.
 */
export function resolveOptionalModelParamValues(
  modelId: string,
  preferredType?: CanonicalModality | "video" | "image",
  requestBody?: Record<string, unknown>,
): ResolvedModelParams & { values: Record<string, unknown> } | null {
  const resolved = resolveModelParams(modelId, preferredType, requestBody);
  if (!resolved) return null;
  return {
    ...resolved,
    values: { ...resolved.defaults, ...extractProvided(resolved.params, requestBody) },
  };
}

/**
 * Resolve schema + values, but return only the keys the caller actually
 * provided (no defaults). Kept for callers that need inspection without
 * router/metering defaults.
 */
export function resolveProvidedOptionalModelParamValues(
  modelId: string,
  preferredType?: CanonicalModality | "video" | "image",
  requestBody?: Record<string, unknown>,
): ResolvedModelParams & { values: Record<string, unknown> } | null {
  const resolved = resolveModelParams(modelId, preferredType, requestBody);
  if (!resolved) return null;
  return {
    ...resolved,
    values: extractProvided(resolved.params, requestBody),
  };
}

// ---------------------------------------------------------------------------
// HTTP — `GET /v1/models/:model/params`
// ---------------------------------------------------------------------------

export async function handleGetModelParams(req: Request, res: Response): Promise<void> {
  const param = req.params.model;
  const modelId = Array.isArray(param) ? param[0] : param;
  if (!modelId) {
    res.status(400).json({ error: "Model ID is required" });
    return;
  }

  const resolved = resolveModelParams(modelId);
  if (resolved) {
    res.json(resolved);
    return;
  }

  res.json({
    modelId: decodeURIComponent(modelId),
    type: null,
    params: {},
    defaults: {},
    provider: null,
  });
}
