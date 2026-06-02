/**
 * Model Registry
 * 
 * Loads models from compiled models.json (built by sync-models.ts).
 * All metadata comes from pre-compiled provider JSONs - no runtime API fetching.
 * 
 * Uses ModelCard from types.ts as the SINGLE source of truth.
 */

import { PROVIDER_PRIORITY, isProvider, type ModelCard, type ModelProvider, type CompiledModelsData, type ModelPricing } from "../types.js";
import { normalizeCompiledPricing } from "../telemetry.js";
import {
    modelMatchesModalityOperation,
    type CanonicalModality,
    type CanonicalOperation,
} from "./modalities/index.js";

// Re-export types for external use
export type { ModelCard, ModelProvider, CompiledModelsData, ModelPricing };

import * as fs from "fs";
import * as path from "path";

export interface ResolvedModel {
    modelId: string;
    provider: ModelProvider;
    card: ModelCard | null;
    known: boolean;
}

// =============================================================================
// Compiled Models Loading
// =============================================================================

function getModelsBasePath(): string {
    const candidatePaths: string[] = [];
    const runtimeDir = typeof __dirname !== "undefined" && __dirname ? __dirname : process.cwd();

    // 1. Try __dirname first (points to dist/)
    if (typeof __dirname !== "undefined" && __dirname !== "") {
        candidatePaths.push(path.join(__dirname, "data"));
    }

    // 2. Api-specific paths
    candidatePaths.push(
        "/var/task/dist/data",
        "/var/task/data",
    );

    // 3. process.cwd() based paths (reliable in Api)
    candidatePaths.push(
        path.join(process.cwd(), "inference", "data"),
        path.join(process.cwd(), "dist", "data"),
        path.join(process.cwd(), "data"),
    );

    // 4. Relative to source (for local development with tsx)
    candidatePaths.push(
        path.join(runtimeDir, "..", "data"),
        path.join(runtimeDir, "data"),
    );

    // Try each candidate path
    for (const p of candidatePaths) {
        const modelPath = path.join(p, "models.json");
        try {
            if (fs.existsSync(modelPath)) {
                const stats = fs.statSync(modelPath);
                console.log(`[models] Found models.json at: ${p} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
                return p;
            }
        } catch {
            // Skip paths that can't be accessed
        }
    }

    // Diagnostic logging for debugging
    console.error("[models] ❌ Could not locate models.json!");
    console.error(`[models] __dirname: ${typeof __dirname !== "undefined" ? __dirname : "undefined"}`);
    console.error(`[models] process.cwd(): ${process.cwd()}`);
    console.error(`[models] Checked paths:`, candidatePaths);

    // List what actually exists in potential directories
    try {
        const cwdContents = fs.readdirSync(process.cwd());
        console.error(`[models] Contents of cwd:`, cwdContents.slice(0, 10));
        if (cwdContents.includes("dist")) {
            const distContents = fs.readdirSync(path.join(process.cwd(), "dist"));
            console.error(`[models] Contents of dist/:`, distContents);
        }
    } catch (e) {
        console.error(`[models] Could not list directory contents:`, e);
    }

    return path.join(process.cwd(), "data");
}

let compiledModelsCache: CompiledModelsData | null = null;
let compiledModelsCacheTime = 0;
const MODELS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
let compiledModelIndex: Map<string, ModelCard> | null = null;
let compiledModelProviderIndex: Map<string, Map<ModelProvider, ModelCard>> | null = null;

function loadCompiledModels(): CompiledModelsData {
    const now = Date.now();
    if (compiledModelsCache && (now - compiledModelsCacheTime) < MODELS_CACHE_TTL) {
        return compiledModelsCache;
    }

    const basePath = getModelsBasePath();
    const modelsPath = path.join(basePath, "models.json");

    try {
        if (fs.existsSync(modelsPath)) {
            const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as CompiledModelsData;
            compiledModelsCache = {
                ...parsed,
                models: Array.isArray(parsed.models) ? parsed.models.map(normalizeCompiledModel) : [],
            };
            compiledModelsCacheTime = now;
            compiledModelIndex = null;
            compiledModelProviderIndex = null;
            console.log(`[models] Loaded ${compiledModelsCache?.totalModels || 0} models from ${modelsPath}`);
        } else {
            console.warn(`[models] models.json not found at ${modelsPath}`);
            compiledModelsCache = { lastUpdated: "", totalModels: 0, byProvider: {} as any, byType: {}, models: [] };
            compiledModelIndex = null;
            compiledModelProviderIndex = null;
        }
    } catch (e) {
        console.error("[models] Failed to load models.json:", e);
        compiledModelsCache = { lastUpdated: "", totalModels: 0, byProvider: {} as any, byType: {}, models: [] };
        compiledModelIndex = null;
        compiledModelProviderIndex = null;
    }

    return compiledModelsCache!;
}

// Extended models (full 43k+ catalog) - loaded lazily only when needed
let extendedModelsCache: CompiledModelsData | null = null;
let extendedModelIndex: Map<string, ModelCard> | null = null;
let extendedModelProviderIndex: Map<string, Map<ModelProvider, ModelCard>> | null = null;

function loadExtendedModels(): CompiledModelsData {
    if (extendedModelsCache) {
        return extendedModelsCache;
    }

    const basePath = getModelsBasePath();
    const extendedPath = path.join(basePath, "models_extended.json");

    try {
        if (fs.existsSync(extendedPath)) {
            const parsed = JSON.parse(fs.readFileSync(extendedPath, "utf-8")) as CompiledModelsData;
            extendedModelsCache = {
                ...parsed,
                models: Array.isArray(parsed.models) ? parsed.models.map(normalizeCompiledModel) : [],
            };
            extendedModelIndex = null;
            extendedModelProviderIndex = null;
            console.log(`[models] Loaded ${extendedModelsCache?.totalModels || 0} extended models from ${extendedPath}`);
        } else {
            console.warn(`[models] models_extended.json not found, falling back to models.json`);
            return loadCompiledModels();
        }
    } catch (e) {
        console.error("[models] Failed to load models_extended.json:", e);
        return loadCompiledModels();
    }

    return extendedModelsCache!;
}

function buildIndexes(models: ModelCard[]): {
    byId: Map<string, ModelCard>;
    byIdProvider: Map<string, Map<ModelProvider, ModelCard>>;
} {
    const byId = new Map<string, ModelCard>();
    const byIdProvider = new Map<string, Map<ModelProvider, ModelCard>>();

    const indexProvider = (modelId: string, model: ModelCard) => {
        const providerMap = byIdProvider.get(modelId) || new Map<ModelProvider, ModelCard>();
        if (!providerMap.has(model.provider)) {
            providerMap.set(model.provider, model);
        }
        byIdProvider.set(modelId, providerMap);
    };

    for (const model of models) {
        const existingPrimary = byId.get(model.modelId);
        if (!existingPrimary) {
            byId.set(model.modelId, model);
        } else {
            const existingPriority = PROVIDER_PRIORITY[existingPrimary.provider] ?? 99;
            const incomingPriority = PROVIDER_PRIORITY[model.provider] ?? 99;
            if (incomingPriority < existingPriority) {
                byId.set(model.modelId, model);
            }
        }

        indexProvider(model.modelId, model);
        if (typeof model.upstreamModelId === "string" && model.upstreamModelId.length > 0) {
            indexProvider(model.upstreamModelId, model);
        }
    }

    return { byId, byIdProvider };
}

function normalizeCompiledModel(model: ModelCard): ModelCard {
    if (!model.pricing) {
        return model;
    }

    return {
        ...model,
        pricing: normalizeCompiledPricing(model.pricing) as ModelPricing,
    };
}

function ensureCompiledIndexes(): void {
    if (compiledModelIndex && compiledModelProviderIndex) {
        return;
    }
    const indexes = buildIndexes(loadCompiledModels().models);
    compiledModelIndex = indexes.byId;
    compiledModelProviderIndex = indexes.byIdProvider;
}

function ensureExtendedIndexes(): void {
    if (extendedModelIndex && extendedModelProviderIndex) {
        return;
    }
    const indexes = buildIndexes(loadExtendedModels().models);
    extendedModelIndex = indexes.byId;
    extendedModelProviderIndex = indexes.byIdProvider;
}

// =============================================================================
// OpenAI-Compatible API Exports
// =============================================================================

/**
 * Get compiled models data (optimized, ~810 models)
 * Used for fast app loading
 */
export function getCompiledModels(): CompiledModelsData {
    return loadCompiledModels();
}

/**
 * Get extended models data (full catalog, 43k+ models)
 * Used for /v1/models/all endpoint
 */
export function getExtendedModels(): CompiledModelsData {
    return loadExtendedModels();
}

/**
 * Get model by ID from optimized set
 * Falls back to extended set if not found
 */
export function getModelById(modelId: string, provider?: ModelProvider): ModelCard | null {
    ensureCompiledIndexes();

    if (provider) {
        const compiledByProvider = compiledModelProviderIndex?.get(modelId)?.get(provider);
        if (compiledByProvider) {
            return compiledByProvider;
        }
    } else {
        const compiledMatch = compiledModelIndex?.get(modelId);
        if (compiledMatch) {
            return compiledMatch;
        }
    }

    ensureExtendedIndexes();

    if (provider) {
        return extendedModelProviderIndex?.get(modelId)?.get(provider) || null;
    }

    return extendedModelIndex?.get(modelId) || null;
}

/**
 * Resolve a model from catalog identity only.
 *
 * Callers do not get a request-time provider override. Vendor/provider
 * ownership is catalog metadata used after resolution by the adapter layer.
 */
export function resolveModel(modelId: string): ResolvedModel {
    const card = getModelById(modelId);

    if (card) {
        return {
            modelId: card.modelId,
            provider: card.provider,
            card,
            known: true,
        };
    }

    throw new Error(`Model not found: ${modelId}`);
}

// =============================================================================
// Registry API - All functions return ModelCard
// =============================================================================

/**
 * Get model provider from registry
 */
export function getModelSource(modelId: string): ModelProvider | null {
    const model = getModelById(modelId);
    return model?.provider || null;
}

/**
 * Get model by ID
 */
export function getModelCard(modelId: string): ModelCard | null {
    return getModelById(modelId);
}

/**
 * Get all models
 */
export function getAllModelCards(): ModelCard[] {
    return loadCompiledModels().models;
}

/**
 * Get model registry metadata
 */
export async function getModelRegistry(): Promise<{
    models: ModelCard[];
    lastUpdated: number;
    sources: ModelProvider[];
}> {
    const compiled = loadCompiledModels();
    return {
        models: compiled.models,
        lastUpdated: compiled.lastUpdated ? new Date(compiled.lastUpdated).getTime() : Date.now(),
        sources: Object.keys(compiled.byProvider).filter(k => (compiled.byProvider as any)[k] > 0) as ModelProvider[],
    };
}

/**
 * Get a specific model by ID (async for compatibility)
 */
export async function getModelInfo(modelId: string): Promise<ModelCard | null> {
    return getModelCard(modelId);
}

/**
 * Get models by provider
 */
export async function getModelsBySource(provider: ModelProvider): Promise<ModelCard[]> {
    const compiled = loadCompiledModels();
    return compiled.models.filter(m => m.provider === provider);
}

/**
 * Get available models
 */
export async function getAvailableModels(): Promise<ModelCard[]> {
    const compiled = loadCompiledModels();
    return compiled.models.filter(m => m.available !== false);
}

/**
 * Force refresh - reloads from disk
 */
export async function refreshRegistry(): Promise<{
    models: ModelCard[];
    lastUpdated: number;
    sources: ModelProvider[];
}> {
    compiledModelsCache = null;
    compiledModelsCacheTime = 0;
    compiledModelIndex = null;
    compiledModelProviderIndex = null;
    extendedModelIndex = null;
    extendedModelProviderIndex = null;
    extendedModelsCache = null;
    return getModelRegistry();
}

// =============================================================================
// Search + OpenAI-shape Exports
// =============================================================================

export interface ModelSearchInput {
    q?: string;
    modality?: CanonicalModality;
    operation?: CanonicalOperation;
    provider?: ModelProvider;
    /** Max price in USD per 1M input tokens, inclusive. Only applies to token-priced models. */
    priceMaxPerMTok?: number;
    /** Minimum context window in tokens, inclusive. */
    contextWindowMin?: number;
    /** Only include models that support streaming. */
    streaming?: boolean;
    cursor?: string;
    limit?: number;
}

export interface ModelSearchResult {
    data: ModelCard[];
    next_cursor: string | null;
    total: number;
}

/**
 * Pure in-process catalog search over the curated ~900-model compiled set.
 *
 * `searchModels` is the public-facing browse/filter surface; it returns
 * only models we have explicitly curated in `models.json` (where pricing,
 * capabilities, and modality classification are accurate). The
 * `getExtendedModels()` superset is reserved for direct lookup by id.
 */
export function searchModels(input: ModelSearchInput): ModelSearchResult {
    const registry = getCompiledModels();
    const q = (input.q || "").trim().toLowerCase();
    const modality = input.modality;
    const operation = input.operation;
    const provider = input.provider;
    const contextMin = Number.isFinite(input.contextWindowMin) && input.contextWindowMin! >= 0
        ? input.contextWindowMin!
        : 0;
    const priceMax = Number.isFinite(input.priceMaxPerMTok) && input.priceMaxPerMTok! > 0
        ? input.priceMaxPerMTok!
        : Number.POSITIVE_INFINITY;
    const streaming = input.streaming === true ? true : null;
    const limit = Math.min(Math.max(Number.isInteger(input.limit) ? input.limit! : 50, 1), 200);
    const cursor = typeof input.cursor === "string" && /^\d+$/.test(input.cursor)
        ? parseInt(input.cursor, 10)
        : 0;

    const filtered: ModelCard[] = [];
    for (const model of registry.models) {
        if (provider && model.provider !== provider) continue;

        if (contextMin > 0) {
            const ctx = typeof model.contextWindow === "number" ? model.contextWindow : 0;
            if (ctx < contextMin) continue;
        }

        if (priceMax !== Number.POSITIVE_INFINITY) {
            const inputPrice = extractInputPricePerMTok(model.pricing);
            if (inputPrice === null || inputPrice > priceMax) continue;
        }

        if (q) {
            const haystack = `${model.modelId} ${model.name || ""} ${model.description || ""} ${model.provider}`.toLowerCase();
            if (!haystack.includes(q)) continue;
        }

        if (modality || operation || streaming === true) {
            if (!modelMatchesModalityOperation(model, {
                modality,
                operation,
                streamable: streaming === true,
            })) {
                continue;
            }
        }

        filtered.push(model);
    }

    const slice = filtered.slice(cursor, cursor + limit);
    const next = cursor + slice.length < filtered.length ? String(cursor + slice.length) : null;

    return {
        data: slice,
        next_cursor: next,
        total: filtered.length,
    };
}

function extractInputPricePerMTok(pricing: unknown): number | null {
    if (!pricing || typeof pricing !== "object") return null;
    const p = pricing as Record<string, unknown>;

    // Shape 1: { unit, values: { input } }
    const values = p.values as Record<string, unknown> | undefined;
    if (values && typeof values === "object") {
        const input = values.input;
        if (typeof input === "number" && input > 0) return input;
    }

    // Shape 2: { sections: [{ unit, entries: { input } }] }
    const sections = p.sections;
    if (Array.isArray(sections)) {
        for (const section of sections) {
            if (!section || typeof section !== "object") continue;
            const entries = (section as Record<string, unknown>).entries as Record<string, unknown> | undefined;
            if (entries && typeof entries === "object") {
                const input = entries.input;
                if (typeof input === "number" && input > 0) return input;
            }
        }
    }

    return null;
}
