/**
 * Model Registry
 * 
 * Loads models from compiled models.json (built by sync-models.ts).
 * All metadata comes from pre-compiled provider JSONs - no runtime API fetching.
 * 
 * Uses ModelCard from types.ts as the SINGLE source of truth.
 */

import type { ModelCard, ModelProvider, CompiledModelsData, ModelPricing } from "./types.js";

// Re-export types for external use
export type { ModelCard, ModelProvider, CompiledModelsData, ModelPricing };

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Provider Instances (for runtime model creation)
// =============================================================================

const asiOneProvider = createOpenAICompatible({
    name: "asi-one",
    apiKey: process.env.ASI_ONE_API_KEY || "",
    baseURL: "https://api.asi1.ai/v1",
});

const asiCloudProvider = createOpenAICompatible({
    name: "asi-cloud",
    apiKey: process.env.ASI_INFERENCE_API_KEY || "",
    baseURL: "https://inference.asicloud.cudos.org/v1",
});

const hfProvider = createOpenAICompatible({
    name: "huggingface",
    apiKey: process.env.HUGGING_FACE_INFERENCE_TOKEN || "",
    baseURL: "https://router.huggingface.co/v1",
});

const openRouterProvider = createOpenAICompatible({
    name: "openrouter",
    apiKey: process.env.OPEN_ROUTER_API_KEY || "",
    baseURL: "https://openrouter.ai/api/v1",
});

const aimlProvider = createOpenAICompatible({
    name: "aiml",
    apiKey: process.env.AI_ML_API_KEY || "",
    baseURL: "https://api.aimlapi.com/v1",
});

// =============================================================================
// Compiled Models Loading
// =============================================================================

function getModelsBasePath(): string {
    const candidatePaths: string[] = [];

    // 1. Try __dirname first (points to dist/)
    if (typeof __dirname !== "undefined" && __dirname !== "") {
        candidatePaths.push(path.join(__dirname, "data"));
    }

    // 2. Lambda-specific paths
    candidatePaths.push(
        "/var/task/dist/data",                    // Lambda deployment structure
        "/var/task/data",                         // Alternative Lambda structure
    );

    // 3. process.cwd() based paths (reliable in Lambda)
    candidatePaths.push(
        path.join(process.cwd(), "dist", "data"), // Lambda with dist folder
        path.join(process.cwd(), "data"),         // Direct data folder
    );

    // 4. Relative to source (for local development with tsx)
    candidatePaths.push(
        path.join(__dirname || process.cwd(), "..", "data"),
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

function loadCompiledModels(): CompiledModelsData {
    const now = Date.now();
    if (compiledModelsCache && (now - compiledModelsCacheTime) < MODELS_CACHE_TTL) {
        return compiledModelsCache;
    }

    const basePath = getModelsBasePath();
    const modelsPath = path.join(basePath, "models.json");

    try {
        if (fs.existsSync(modelsPath)) {
            compiledModelsCache = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
            compiledModelsCacheTime = now;
            console.log(`[models] Loaded ${compiledModelsCache?.totalModels || 0} models from ${modelsPath}`);
        } else {
            console.warn(`[models] models.json not found at ${modelsPath}`);
            compiledModelsCache = { lastUpdated: "", totalModels: 0, byProvider: {} as any, byTaskType: {}, models: [] };
        }
    } catch (e) {
        console.error("[models] Failed to load models.json:", e);
        compiledModelsCache = { lastUpdated: "", totalModels: 0, byProvider: {} as any, byTaskType: {}, models: [] };
    }

    return compiledModelsCache!;
}

// Extended models (full 43k+ catalog) - loaded lazily only when needed
let extendedModelsCache: CompiledModelsData | null = null;

function loadExtendedModels(): CompiledModelsData {
    if (extendedModelsCache) {
        return extendedModelsCache;
    }

    const basePath = getModelsBasePath();
    const extendedPath = path.join(basePath, "models_extended.json");

    try {
        if (fs.existsSync(extendedPath)) {
            extendedModelsCache = JSON.parse(fs.readFileSync(extendedPath, "utf-8"));
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
export function getModelById(modelId: string): ModelCard | null {
    // First try optimized set
    const optimized = loadCompiledModels();
    const model = optimized.models.find(m => m.modelId === modelId);
    if (model) return model;

    // Fall back to extended set
    const extended = loadExtendedModels();
    return extended.models.find(m => m.modelId === modelId) || null;
}

// =============================================================================
// Registry API - All functions return ModelCard
// =============================================================================

/**
 * Get model provider from registry
 */
export function getModelSource(modelId: string): ModelProvider | null {
    const model = getModelCard(modelId);
    return model?.provider || null;
}

/**
 * Get model by ID
 */
export function getModelCard(modelId: string): ModelCard | null {
    const data = loadCompiledModels();
    return data.models.find(m => m.modelId === modelId) || null;
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
    return getModelRegistry();
}

// =============================================================================
// Model Instance Creation
// =============================================================================

/**
 * Get language model instance - routes to correct provider
 */
export function getLanguageModel(modelId: string, provider?: ModelProvider): LanguageModel {
    const modelProvider = provider || getModelSource(modelId);
    console.log(`[getLanguageModel] modelId: "${modelId}", resolved provider: "${modelProvider}"`);

    if (!modelProvider) {
        console.error(`[registry] Model not found in registry: ${modelId}`);
        throw new Error(`Model not found: ${modelId}. Ensure model is in the compiled registry.`);
    }

    console.log(`[getLanguageModel] Creating model instance for provider: ${modelProvider}`);
    switch (modelProvider) {
        case "openai":
            return openai(modelId);
        case "anthropic":
            return anthropic(modelId);
        case "google":
            return google(modelId);
        case "asi-one":
            return asiOneProvider(modelId);
        case "asi-cloud":
            return asiCloudProvider(modelId);
        case "openrouter":
            console.log(`[getLanguageModel] Using openRouterProvider for: ${modelId}`);
            return openRouterProvider(modelId);
        case "aiml":
            return aimlProvider(modelId);
        case "huggingface":
            return hfProvider(modelId);
        default:
            throw new Error(`Unknown provider: ${modelProvider} for model: ${modelId}`);
    }
}

// =============================================================================
// Pricing Calculations (x402)
// =============================================================================

const PLATFORM_FEE_PER_MILLION = 0.01; // $0.01 per million tokens

/**
 * Calculate inference cost for x402 payment
 */
export async function calculateInferenceCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): Promise<{ providerCost: number; platformFee: number; totalCost: number; costUsdcWei: bigint; provider?: string }> {
    const model = await getModelInfo(modelId);
    const totalTokens = inputTokens + outputTokens;

    if (!model?.pricing) {
        const platformFee = (totalTokens / 1_000_000) * PLATFORM_FEE_PER_MILLION;
        return {
            providerCost: 0,
            platformFee,
            totalCost: platformFee,
            costUsdcWei: BigInt(Math.ceil(platformFee * 1_000_000)),
        };
    }

    const inputCost = (inputTokens / 1_000_000) * model.pricing.input;
    const outputCost = (outputTokens / 1_000_000) * model.pricing.output;
    const providerCost = inputCost + outputCost;
    const platformFee = (totalTokens / 1_000_000) * PLATFORM_FEE_PER_MILLION;
    const totalCost = providerCost + platformFee;

    return {
        providerCost,
        platformFee,
        totalCost,
        costUsdcWei: BigInt(Math.ceil(totalCost * 1_000_000)),
        provider: model.provider,
    };
}

/**
 * Calculate action cost: 1% platform fee
 */
export function calculateActionCost(actionCost: number): { providerCost: number; platformFee: number; totalCost: number; costUsdcWei: bigint } {
    const platformFee = actionCost * 0.01;
    const totalCost = actionCost + platformFee;
    return {
        providerCost: actionCost,
        platformFee,
        totalCost,
        costUsdcWei: BigInt(Math.ceil(totalCost * 1_000_000)),
    };
}

/**
 * Calculate cost (legacy wrapper)
 */
export async function calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): Promise<{ costUsd: number; costUsdcWei: bigint; provider?: string }> {
    const result = await calculateInferenceCost(modelId, inputTokens, outputTokens);
    return {
        costUsd: result.totalCost,
        costUsdcWei: result.costUsdcWei,
        provider: result.provider,
    };
}

// Legacy type alias - use ModelCard instead
export type ModelInfo = ModelCard;
