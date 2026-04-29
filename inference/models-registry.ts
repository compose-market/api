/**
 * Model Registry
 * 
 * Loads models from compiled models.json (built by sync-models.ts).
 * All metadata comes from pre-compiled provider JSONs - no runtime API fetching.
 * 
 * Uses ModelCard from types.ts as the SINGLE source of truth.
 */

import { PROVIDER_PRIORITY, type ModelCard, type ModelProvider, type CompiledModelsData, type ModelPricing } from "./types.js";
import { normalizeCompiledPricing } from "./telemetry.js";
import {
    modelMatchesModalityOperation,
    type CanonicalModality,
    type CanonicalOperation,
} from "./modality/index.js";

// Re-export types for external use
export type { ModelCard, ModelProvider, CompiledModelsData, ModelPricing };

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import * as fs from "fs";
import * as path from "path";

export interface ResolvedModel {
    modelId: string;
    provider: ModelProvider;
    card: ModelCard | null;
    known: boolean;
}

// =============================================================================
// Provider Instances (for runtime model creation)
// =============================================================================

const asiOneProvider = createOpenAICompatible({
    name: "asi-one",
    apiKey: process.env.ASI_ONE_API_KEY || "",
    baseURL: "https://api.asi1.ai/v1",
});

const asiCloudProvider = createOpenAICompatible({
    name: "asicloud",
    apiKey: process.env.ASI_INFERENCE_API_KEY || "",
    baseURL: "https://inference.asicloud.cudos.org/v1",
});

const hfProvider = createOpenAICompatible({
    name: "hugging-face",
    apiKey: process.env.HUGGING_FACE_INFERENCE_TOKEN || "",
    baseURL: "https://router.huggingface.co/v1",
});

const aimlProvider = createOpenAICompatible({
    name: "aiml",
    apiKey: process.env.AI_ML_API_KEY || "",
    baseURL: "https://api.aimlapi.com/v1",
});

const cloudflareProvider = createOpenAICompatible({
    name: "cloudflare",
    apiKey: process.env.CF_API_TOKEN!,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1`,
});

const fireworksProvider = createOpenAICompatible({
    name: "fireworks",
    apiKey: process.env.FIREWORKS_API_KEY,
    baseURL: "https://api.fireworks.ai/inference/v1",
});

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

        const providerMap = byIdProvider.get(model.modelId) || new Map<ModelProvider, ModelCard>();
        if (!providerMap.has(model.provider)) {
            providerMap.set(model.provider, model);
        }
        byIdProvider.set(model.modelId, providerMap);
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

function isModelProvider(value: unknown): value is ModelProvider {
    return value === "gemini"
        || value === "openai"
        || value === "fireworks"
        || value === "asicloud"
        || value === "hugging face"
        || value === "aiml"
        || value === "vertex"
        || value === "cloudflare"
        || value === "deepgram"
        || value === "elevenlabs"
        || value === "cartesia"
        || value === "roboflow";
}

/**
 * Resolve a model/provider pair.
 * - Known model: provider inferred from registry unless explicit provider is passed.
 * - Unknown model: explicit provider is required.
 */
export function resolveModel(modelId: string, provider?: ModelProvider | string): ResolvedModel {
    const explicitProvider = provider && isModelProvider(provider) ? provider : undefined;
    const card = explicitProvider ? getModelById(modelId, explicitProvider) : getModelById(modelId);

    if (card) {
        return {
            modelId,
            provider: explicitProvider || card.provider,
            card,
            known: true,
        };
    }

    if (!explicitProvider) {
        throw new Error(`Model not found: ${modelId}. Provide an explicit provider for unknown models.`);
    }

    const knownModel = getModelById(modelId);
    if (knownModel) {
        // Known modelId with explicit provider override (runtime routing can still try it).
        return {
            modelId,
            provider: explicitProvider,
            card: knownModel,
            known: true,
        };
    }

    return {
        modelId,
        provider: explicitProvider,
        card: null,
        known: false,
    };
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
// Model Instance Creation
// =============================================================================

/**
 * Get language model instance - routes to correct provider
 * 
 * NOTE: Vertex AI uses direct API routing in invoke.ts, not AI SDK.
 * This is because Vertex AI requires custom authentication and request formats.
 */
export function getLanguageModel(modelId: string, provider?: ModelProvider): LanguageModel {
    const card = provider ? getModelById(modelId, provider) : getModelById(modelId);
    const modelProvider = provider || card?.provider || null;
    console.log(`[getLanguageModel] modelId: "${modelId}", resolved provider: "${modelProvider}"`);

    if (!modelProvider) {
        console.error(`[registry] Model not found in registry: ${modelId}`);
        throw new Error(`Model not found: ${modelId}. Ensure model is in the compiled registry.`);
    }

    console.log(`[getLanguageModel] Creating model instance for provider: ${modelProvider}`);

    switch (modelProvider) {
        case "openai":
            return openai(modelId);

        case "gemini":
            return google(modelId);

        case "asicloud":
            return asiCloudProvider(modelId);

        case "aiml":
            return aimlProvider(modelId);

        case "hugging face":
            return hfProvider(modelId);

        case "cloudflare":
            console.log(`[getLanguageModel] Using cloudflareProvider for: ${modelId}`);
            return cloudflareProvider(modelId);

        case "fireworks":
            console.log(`[getLanguageModel] Using fireworksProvider for: ${modelId}`);
            return fireworksProvider(modelId);

        case "vertex":
        case "deepgram":
        case "elevenlabs":
        case "cartesia":
        case "roboflow":
            // It requires custom authentication (JWT tokens) that AI SDK doesn't support
            throw new Error(
                `${modelProvider} models (${modelId}) use direct API routing, not AI SDK. ` +
                `Use invokeChat with direct streaming or the Vertex provider-specific functions.`
            );

        default:
            throw new Error(`Unknown provider: ${modelProvider} for model: ${modelId}`);
    }
}

/**
 * Get embedding model instance - routes to provider embedding endpoint.
 */
export function getEmbeddingModel(modelId: string, provider?: ModelProvider): any {
    const card = provider ? getModelById(modelId, provider) : getModelById(modelId);
    const modelProvider = provider || card?.provider || null;
    console.log(`[getEmbeddingModel] modelId: "${modelId}", resolved provider: "${modelProvider}"`);

    if (!modelProvider) {
        console.error(`[registry] Model not found in registry: ${modelId}`);
        throw new Error(`Model not found: ${modelId}. Ensure model is in the compiled registry.`);
    }

    switch (modelProvider) {
        case "openai":
            return openai.embeddingModel(modelId);

        case "gemini":
            return google.embeddingModel(modelId);

        case "asicloud":
            return asiCloudProvider.embeddingModel(modelId);

        case "aiml":
            return aimlProvider.embeddingModel(modelId);

        case "hugging face":
            return hfProvider.embeddingModel(modelId);

        case "cloudflare":
            return cloudflareProvider.embeddingModel(modelId);

        case "fireworks":
            return fireworksProvider.embeddingModel(modelId);

        case "vertex":
        case "deepgram":
        case "elevenlabs":
        case "cartesia":
        case "roboflow":
            // Vertex embeddings are handled by provider-specific helper.
            throw new Error(
                `${modelProvider} embeddings (${modelId}) use direct API routing.`
            );

        default:
            throw new Error(`Unknown provider: ${modelProvider} for model: ${modelId}`);
    }
}

// Legacy type alias - use ModelCard instead
export type ModelInfo = ModelCard;

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
 * Pure in-process catalog search over the full ~45k-model extended set.
 *
 * We deliberately do not pull in Algolia / OpenSearch here — the registry is
 * less than 30 MB of JSON in-memory, and a linear scan with indexable filters
 * is fast enough for the expected call volume. The cursor is a stable offset
 * string so clients can round-trip it.
 */
export function searchModels(input: ModelSearchInput): ModelSearchResult {
    const registry = getExtendedModels();
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
