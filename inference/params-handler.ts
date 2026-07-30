/**
 * Universal parameter aggregator.
 *
 * Single responsibility: every inference call must succeed. When a third-
 * party request omits a required-by-the-vendor parameter (count, duration,
 * quality, resolution, …), this module fills the lowest-cost default
 * taken from the per-model parameter schema in models.json. No
 * network calls happen here.
 */
import type { Request, Response } from "express";

import { getModelById } from "./catalog/registry.js";
import { getModelCapabilities, type CanonicalModality } from "./catalog/modalities/index.js";
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
// Public helpers — kept for telemetry.ts compatibility.
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

  const dim = trimmed.match(/^(\d+)\s*[x*]\s*(\d+)$/);
  if (dim) return Number(dim[1]) * Number(dim[2]);

  const res = trimmed.match(/^(\d+)\s*p$/);
  if (res) return Number(res[1]);

  const sec = trimmed.match(/^(\d+(?:\.\d+)?)\s*s$/);
  if (sec) return Number(sec[1]);

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isAllowedOption(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function isDefaultValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Check if a raw value looks like a valid ParamDefinition (has a `type` field).
 * This rejects structured metadata containers like { endpoint: ..., query: ... }
 * that some providers store alongside real param definitions.
 */
function isParamDefinition(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) return false;
  const type = typeof record.type === "string" ? record.type : "";
  return ["string", "integer", "number", "boolean", "array", "object"].includes(type);
}

function normalizeParamDefinition(raw: unknown): ParamDefinition | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (!isParamDefinition(record)) return null;

  const rawType = typeof record.type === "string" ? record.type : "";
  const options = Array.isArray(record.options) ? record.options.filter(isAllowedOption) : undefined;
  const defaultValue = isDefaultValue(record.default) ? record.default : undefined;
  const type = rawType as ParamDefinition["type"];

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

/**
 * Extract the lowest value from a set of options.
 * For numeric options: return the minimum.
 * For string options: try to extract a numeric component for ranking
 * (e.g. "512x512" → 512*512, "720P" → 720, "5" → 5).
 * If no numeric component can be extracted, return the first option
 * (provider's declared order).
 */
function lowestOption(options: Array<string | number>): string | number | undefined {
  if (options.length === 0) return undefined;

  const numeric = options.filter((o): o is number => typeof o === "number" && Number.isFinite(o));
  if (numeric.length > 0) return Math.min(...numeric);

  const ranked = options
    .map((opt, index) => ({ opt, index, rank: rankOptionValue(opt) }))
    .filter((entry): entry is { opt: string | number; index: number; rank: number } => entry.rank !== null);
  if (ranked.length > 0) {
    ranked.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
    return ranked[0].opt;
  }

  return options[0];
}

/**
 * Compute the lowest-cost default for a single parameter.
 * Only generates a default for params that have options or min/max ranges
 * but no explicit provider default.
 */
function lowestDefaultForParam(def: ParamDefinition): unknown {
  if (def.default !== undefined) {
    if (typeof def.default === "string" && def.default.trim().toLowerCase() === "auto") {
      return undefined;
    }
    return def.default;
  }

  if (def.options && def.options.length > 0) {
    return lowestOption(def.options);
  }

  return undefined;
}

export function buildModelParamDefaults(params: Record<string, ParamDefinition>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(params)) {
    const value = lowestDefaultForParam(def);
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

function coerce(def: ParamDefinition, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (def.type === "integer") {
    if (typeof value === "number") {
      if (Number.isSafeInteger(value)) return value;
      throw Object.assign(new Error("integer parameters must be safe integers"), {
        statusCode: 400,
        code: "unsafe_integer_parameter",
      });
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = BigInt(value.trim());
      if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw Object.assign(new Error("integer parameters must be safe integers"), {
          statusCode: 400,
          code: "unsafe_integer_parameter",
        });
      }
      return Number(parsed);
    }
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
    const raw = [key]
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
 * Resolve the per-model parameter schema from card.params.
 *
 * Given a model id (and optionally a preferred modality hint), returns
 * the schema from that model's own params field in models.json, with
 * lowest-cost defaults pre-computed.
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

  const params = normalizeDefinitions(card?.params);
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
