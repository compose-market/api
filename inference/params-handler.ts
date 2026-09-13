/**
 * Universal parameter aggregator.
 *
 * Resolves and validates model-specific request parameters from models.json.
 * No network calls happen here.
 */
import type { Request, Response } from "express";

import { getModelById } from "./catalog/registry.js";
import { familyOf, normalizeFamily } from "./catalog/families/index.js";
import { getModelCapabilities, type CanonicalModality } from "./catalog/modalities/index.js";
import type { ModelCard } from "./types.js";

// ---------------------------------------------------------------------------
// Schema types — unchanged public surface.
// ---------------------------------------------------------------------------

export interface ParamDefinition {
  type: ParamType | ParamType[];
  required: boolean;
  default?: unknown;
  options?: (string | number)[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

type ParamType = "string" | "integer" | "number" | "boolean" | "array" | "object";

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

export interface FamilyModalityDefaultContext {
  family: string;
  modality: CanonicalModality;
  provider: string;
  params: Readonly<Record<string, ParamDefinition>>;
}

export type FamilyModalityDefaultResolver = (
  context: FamilyModalityDefaultContext,
) => Record<string, unknown>;

const familyModalityDefaultResolvers = new Map<string, FamilyModalityDefaultResolver>();

function familyModalityKey(family: string, modality: CanonicalModality): string {
  return `${family}\u0000${modality}`;
}

/** Register defaults owned by a provider family and modality, never a model id. */
export function registerFamilyModalityDefaultResolver(
  family: string,
  modality: CanonicalModality,
  resolver: FamilyModalityDefaultResolver,
): () => void {
  const normalizedFamily = normalizeFamily(family);
  if (!normalizedFamily) throw new Error("family is required");
  const key = familyModalityKey(normalizedFamily, modality);
  const previous = familyModalityDefaultResolvers.get(key);
  familyModalityDefaultResolvers.set(key, resolver);
  return () => {
    if (familyModalityDefaultResolvers.get(key) === resolver) {
      if (previous) familyModalityDefaultResolvers.set(key, previous);
      else familyModalityDefaultResolvers.delete(key);
    }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isAllowedOption(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
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
  const types = Array.isArray(record.type) ? record.type : [record.type];
  return types.length > 0 && types.every((type) => typeof type === "string"
    && ["string", "integer", "number", "boolean", "array", "object"].includes(type));
}

function normalizeParamDefinition(raw: unknown): ParamDefinition | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (!isParamDefinition(record)) return null;

  const rawTypes = Array.isArray(record.type) ? record.type : [record.type];
  const options = Array.isArray(record.options) ? record.options.filter(isAllowedOption) : undefined;
  const types = rawTypes as ParamType[];
  const type: ParamDefinition["type"] = types.length === 1 ? types[0]! : types;
  const definition: ParamDefinition = {
    type,
    required: record.required === true,
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof record.minimum === "number" && Number.isFinite(record.minimum) ? { minimum: record.minimum } : {}),
    ...(typeof record.maximum === "number" && Number.isFinite(record.maximum) ? { maximum: record.maximum } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  };

  if (record.default !== undefined) {
    try {
      definition.default = coerceAndValidate(definition, record.default);
    } catch {
      // Invalid catalog defaults are not applied to requests.
    }
  }
  return definition;
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

export function buildModelParamDefaults(params: Record<string, ParamDefinition>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(params)) {
    if (def.default !== undefined) defaults[key] = def.default;
  }
  return defaults;
}

function resolveFamilyModalityDefaults(
  card: ModelCard,
  modality: CanonicalModality,
  params: Record<string, ParamDefinition>,
): Record<string, unknown> {
  const family = familyOf(card);
  if (!family) return {};
  const resolver = familyModalityDefaultResolvers.get(familyModalityKey(family, modality));
  if (!resolver) return {};

  const resolved = resolver({ family, modality, provider: card.provider, params });
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolved)) {
    const definition = params[key];
    if (!definition || definition.default !== undefined) continue;
    const validated = coerceAndValidate(definition, value);
    if (validated !== undefined) defaults[key] = validated;
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
  if (!card) return { modality: null, provider: "" };
  const caps = getModelCapabilities(card);
  if (preferred) {
    return {
      modality: caps.some((capability) => capability.modality === preferred) ? preferred : null,
      provider: card.provider,
    };
  }
  return { modality: caps[0]?.modality ?? null, provider: card.provider };
}

function invalidParam(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: "invalid_model_parameter",
  });
}

function coerceSingleType(type: ParamType, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (type === "string") {
    if (typeof value === "string") return value;
    throw invalidParam("string parameters must be strings");
  }
  if (type === "integer") {
    if (typeof value === "number") {
      if (Number.isSafeInteger(value)) return value;
      throw invalidParam("integer parameters must be safe integers");
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = BigInt(value.trim());
      if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidParam("integer parameters must be safe integers");
      }
      return Number(parsed);
    }
    throw invalidParam("integer parameters must be integers");
  }
  if (type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const n = Number(value.trim());
      if (Number.isFinite(n)) return n;
    }
    throw invalidParam("number parameters must be finite numbers");
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const t = value.trim().toLowerCase();
      if (t === "true") return true;
      if (t === "false") return false;
    }
    throw invalidParam("boolean parameters must be booleans");
  }
  if (type === "array") {
    if (Array.isArray(value)) return value;
    throw invalidParam("array parameters must be arrays");
  }
  if (type === "object") {
    if (asRecord(value)) return value;
    throw invalidParam("object parameters must be objects");
  }
  throw invalidParam("unsupported parameter type");
}

function coerceType(def: ParamDefinition, value: unknown): unknown {
  const types = Array.isArray(def.type) ? def.type : [def.type];
  let lastError: unknown;
  for (const type of types) {
    try {
      return coerceSingleType(type, value);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : invalidParam("parameter does not match any allowed type");
}

function coerceAndValidate(def: ParamDefinition, value: unknown): unknown {
  const coerced = coerceType(def, value);
  if (coerced === undefined) return undefined;

  if (def.options?.length) {
    const allowed = def.options.some((option) => {
      try {
        return Object.is(coerceType({ ...def, options: undefined }, option), coerced);
      } catch {
        return false;
      }
    });
    if (!allowed) throw invalidParam("parameter value is not in the allowed options");
  }

  if (typeof coerced === "number") {
    if (def.minimum !== undefined && coerced < def.minimum) {
      throw invalidParam(`parameter value must be at least ${def.minimum}`);
    }
    if (def.maximum !== undefined && coerced > def.maximum) {
      throw invalidParam(`parameter value must be at most ${def.maximum}`);
    }
  }
  return coerced;
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
    const coerced = coerceAndValidate(def, raw);
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
 * the schema and explicit defaults from that model's own params field.
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
  if (!card || !modality) return null;

  const params = normalizeDefinitions(card?.params);
  const defaults = {
    ...resolveFamilyModalityDefaults(card, modality, params),
    ...buildModelParamDefaults(params),
  };
  return {
    modelId: decoded,
    type: modality,
    provider,
    params,
    defaults,
  };
}

/**
 * Resolve schema + values, where every key in the schema is filled.
 * - Provided keys (in `body` or `body.custom_params`) override defaults.
 * - Missing keys fall back only to an explicit valid provider default.
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
