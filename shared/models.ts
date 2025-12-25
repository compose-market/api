/**
 * Dynamic Model Registry
 * 
 * Fetches models and pricing dynamically from provider APIs:
 * - OpenAI, Anthropic, Google, ASI Cloud, OpenRouter, AI/ML
 * - HuggingFace Router API for HF models
 * 
 * All metadata fetched dynamically from APIs - no hardcoding.
 * Priority: ASI Cloud > Google | OpenAI | Anthropic > HuggingFace > OpenRouter > AI/ML
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { fetchAllInferenceModels, type HFModel } from "../providers/huggingface.js";
import { fetchOpenAIModels, clearOpenAICache } from "../providers/openai.js";
import { fetchAnthropicModels, clearAnthropicCache } from "../providers/anthropic.js";
import { fetchASICloudModels, clearASICloudCache } from "../providers/asicloud.js";
import { fetchOpenRouterModels, clearOpenRouterCache, modalityToTask } from "../providers/openrouter.js";
import { fetchAIMLModels, clearAIMLCache } from "../providers/aiml.js";
import { fetchGoogleModels as fetchGoogleGenAIModels } from "../providers/genai.js";
import { fetchASIOneModels, clearASIOneCache } from "../providers/asione.js";

// =============================================================================
// Types
// =============================================================================

export interface ProviderPricing {
    provider: string;
    status: "live" | "staging" | "offline";
    contextLength?: number;
    pricing?: {
        input: number;  // USD per million tokens
        output: number; // USD per million tokens
    };
    supportsTools?: boolean;
    supportsStructuredOutput?: boolean;
}

export interface ModelInfo {
    id: string;
    name: string;
    ownedBy: string;
    source: "huggingface" | "asi-one" | "asi-cloud" | "openai" | "anthropic" | "google" | "openrouter" | "aiml";
    task?: string;
    description?: string;
    architecture?: {
        inputModalities: string[];
        outputModalities: string[];
    };
    providers: ProviderPricing[];
    contextLength?: number;
    available: boolean;
    pricing?: {
        provider: string;
        input: number;  // USD per million tokens
        output: number;
    };
}

export interface ModelRegistry {
    models: ModelInfo[];
    lastUpdated: number;
    sources: string[];
}

// =============================================================================
// Provider Instances
// =============================================================================

// ASI:One Provider - uses ASI_ONE_API_KEY
const asiOneProvider = createOpenAICompatible({
    name: "asi-one",
    apiKey: process.env.ASI_ONE_API_KEY || "",
    baseURL: "https://api.asi1.ai/v1",
});

// ASI Cloud Provider - uses ASI_INFERENCE_API_KEY
const asiCloudProvider = createOpenAICompatible({
    name: "asi-cloud",
    apiKey: process.env.ASI_INFERENCE_API_KEY || "",
    baseURL: "https://inference.asicloud.cudos.org/v1",
});

// HuggingFace Router Provider - uses HUGGING_FACE_INFERENCE_TOKEN
// The router automatically picks cheapest inference provider
const hfProvider = createOpenAICompatible({
    name: "huggingface",
    apiKey: process.env.HUGGING_FACE_INFERENCE_TOKEN || "",
    baseURL: "https://router.huggingface.co/v1",
});

// OpenRouter Provider - uses OPEN_ROUTER_API_KEY
// Aggregates 300+ models from multiple providers
const openRouterProvider = createOpenAICompatible({
    name: "openrouter",
    apiKey: process.env.OPEN_ROUTER_API_KEY || "",
    baseURL: "https://openrouter.ai/api/v1",
});

// AI/ML API Provider - uses AI_ML_API_KEY
// Access to 200+ models including latest releases
const aimlProvider = createOpenAICompatible({
    name: "aiml",
    apiKey: process.env.AI_ML_API_KEY || "",
    baseURL: "https://api.aimlapi.com/v1",
});

// =============================================================================
// Dynamic Pricing Loader
// Loads pricing from data/pricing.json (synced every 6 hours)
// =============================================================================

interface PricingEntry {
    input: number;
    output: number;
    mode?: string;
}

interface PricingData {
    lastUpdated: string;
    providers: Record<string, Record<string, PricingEntry>>;
}

let pricingCache: PricingData | null = null;
let pricingCacheTimestamp = 0;

function loadPricingData(): PricingData | null {
    // Cache pricing for 6 hours
    if (pricingCache && Date.now() - pricingCacheTimestamp < 6 * 60 * 60 * 1000) {
        return pricingCache;
    }

    try {
        // Dynamic import for pricing.json
        const pricingPath = new URL("../data/pricing.json", import.meta.url);
        const data = JSON.parse(
            require("fs").readFileSync(pricingPath, "utf-8")
        ) as PricingData;

        pricingCache = data;
        pricingCacheTimestamp = Date.now();
        console.log(`[models] Loaded pricing data from ${data.lastUpdated}`);
        return data;
    } catch (error) {
        console.warn("[models] Failed to load pricing.json:", error);
        return null;
    }
}

/**
 * Apply pricing to deduplicated models based on their source provider
 * Called AFTER deduplication so each model shows price from winning provider
 */
function applyPricing(models: ModelInfo[]): ModelInfo[] {
    const pricing = loadPricingData();
    if (!pricing) return models;

    // Map source to pricing provider key
    const sourceToProvider: Record<string, string> = {
        "openai": "openai",
        "anthropic": "anthropic",
        "google": "google",
        "aiml": "aiml",
        "asi-cloud": "asi-cloud",
    };

    return models.map((model) => {
        const providerKey = sourceToProvider[model.source];
        if (!providerKey) return model;

        const providerPricing = pricing.providers[providerKey];
        if (!providerPricing) return model;

        // Try exact match first, then try normalized ID
        let priceEntry = providerPricing[model.id];

        // Fallback: try without version suffixes
        if (!priceEntry) {
            const baseId = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
            priceEntry = providerPricing[baseId];
        }

        if (priceEntry) {
            return {
                ...model,
                pricing: {
                    provider: model.source,
                    input: priceEntry.input,
                    output: priceEntry.output,
                },
            };
        }

        return model;
    });
}

// =============================================================================
// Cache
// =============================================================================

let registryCache: ModelRegistry | null = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// =============================================================================
// API Fetchers - Each provider fetches their own models
// =============================================================================

/**
 * Infer task type from model architecture or ID
 */
function inferTaskFromArchitecture(
    id: string,
    architecture?: { input_modalities: string[]; output_modalities: string[] }
): string {
    // Check architecture first
    if (architecture) {
        const outputs = architecture.output_modalities || [];
        const inputs = architecture.input_modalities || [];

        if (outputs.includes("image")) return "text-to-image";
        if (outputs.includes("video")) return "text-to-video";
        if (outputs.includes("audio")) return "text-to-speech";
        if (inputs.includes("audio") && outputs.includes("text")) return "automatic-speech-recognition";
        if (inputs.includes("image") && outputs.includes("text")) return "image-to-text";
    }

    // Fallback: infer from model ID
    const lowerId = id.toLowerCase();
    if (lowerId.includes("flux") || lowerId.includes("stable-diffusion") || lowerId.includes("sdxl") || lowerId.includes("dall")) {
        return "text-to-image";
    }
    if (lowerId.includes("whisper") || lowerId.includes("speech-to-text")) {
        return "automatic-speech-recognition";
    }
    if (lowerId.includes("tts") || lowerId.includes("text-to-speech") || lowerId.includes("bark")) {
        return "text-to-speech";
    }
    if (lowerId.includes("embed") || lowerId.includes("e5") || lowerId.includes("bge")) {
        return "feature-extraction";
    }

    return "text-generation";
}

/**
 * Fetch all models from HuggingFace Hub with inference providers available
 * Uses the new huggingface.ts module which ONLY returns models with inference providers
 * (inference_provider=all filter)
 */
async function fetchHuggingFaceModels(): Promise<ModelInfo[]> {
    const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;
    if (!HF_TOKEN) {
        console.warn("[models] HuggingFace token not set");
        return [];
    }

    try {
        // Use the new module to fetch ONLY models with inference providers
        const hfModels = await fetchAllInferenceModels();

        console.log(`[models] Fetched ${hfModels.length} HuggingFace models with inference providers`);

        // Convert to ModelInfo format
        const models: ModelInfo[] = hfModels.map((model: HFModel) => ({
            id: model.id,
            name: model.name,
            ownedBy: model.id.split("/")[0] || "unknown",
            source: "huggingface" as const,
            task: model.task,
            providers: [{
                provider: "hf-inference",
                status: "live" as const,
                pricing: getDefaultPricingForTask(model.task),
            }],
            available: true,
            pricing: {
                provider: "hf-inference",
                ...getDefaultPricingForTask(model.task),
            },
        }));

        // Also fetch from Router API for pricing info on supported models
        try {
            const routerResponse = await fetch("https://router.huggingface.co/v1/models", {
                headers: { Authorization: `Bearer ${HF_TOKEN}` },
            });

            if (routerResponse.ok) {
                const routerData = await routerResponse.json() as {
                    data: Array<{
                        id: string;
                        owned_by: string;
                        architecture?: { input_modalities: string[]; output_modalities: string[] };
                        providers: Array<{
                            provider: string;
                            status: string;
                            context_length?: number;
                            pricing?: { input: number; output: number };
                            supports_tools?: boolean;
                            supports_structured_output?: boolean;
                        }>;
                    }>;
                };

                // Update pricing for models that have router data
                const routerModelMap = new Map(routerData.data.map(m => [m.id, m]));

                for (const model of models) {
                    const routerModel = routerModelMap.get(model.id);
                    if (routerModel) {
                        const providers: ProviderPricing[] = routerModel.providers.map((p) => ({
                            provider: p.provider,
                            status: p.status as "live" | "staging" | "offline",
                            contextLength: p.context_length,
                            pricing: p.pricing,
                            supportsTools: p.supports_tools,
                            supportsStructuredOutput: p.supports_structured_output,
                        }));

                        const liveWithPricing = providers.filter((p) => p.status === "live" && p.pricing);
                        liveWithPricing.sort((a, b) => (a.pricing!.input - b.pricing!.input));
                        const cheapest = liveWithPricing[0];

                        model.providers = providers;
                        model.contextLength = cheapest?.contextLength;
                        if (cheapest?.pricing) {
                            model.pricing = {
                                provider: cheapest.provider,
                                input: cheapest.pricing.input,
                                output: cheapest.pricing.output,
                            };
                        }
                        if (routerModel.architecture) {
                            model.architecture = {
                                inputModalities: routerModel.architecture.input_modalities,
                                outputModalities: routerModel.architecture.output_modalities,
                            };
                        }
                    }
                }
            }
        } catch (routerErr) {
            console.warn("[models] Router API unavailable, using default pricing");
        }

        return models;
    } catch (error) {
        console.error("[models] Failed to fetch HuggingFace models:", error);
        return [];
    }
}

/**
 * Get default pricing for a task type (per million tokens/requests)
 * Based on typical HuggingFace inference pricing
 */
function getDefaultPricingForTask(task: string): { input: number; output: number } {
    switch (task) {
        case "text-generation":
        case "text2text-generation":
            return { input: 0.20, output: 0.20 };
        case "text-to-image":
        case "image-to-image":
            return { input: 0.05, output: 0.0 }; // Per image
        case "text-to-speech":
        case "text-to-audio":
            return { input: 0.03, output: 0.0 }; // Per second
        case "automatic-speech-recognition":
        case "audio-to-audio":
            return { input: 0.006, output: 0.0 }; // Per second
        case "feature-extraction":
        case "sentence-similarity":
            return { input: 0.10, output: 0.0 };
        case "image-classification":
        case "object-detection":
        case "image-segmentation":
        case "depth-estimation":
            return { input: 0.02, output: 0.0 }; // Per image
        case "text-classification":
        case "token-classification":
        case "fill-mask":
        case "question-answering":
        case "summarization":
        case "translation":
        case "zero-shot-classification":
            return { input: 0.10, output: 0.10 };
        default:
            return { input: 0.15, output: 0.15 };
    }
}

/**
 * Fetch models from ASI:One API (via provider module)
 */
async function fetchASIOneModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchASIOneModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: model.ownedBy,
        source: "asi-one" as const,
        task: model.task,
        providers: [{ provider: "asi-one", status: "live" as const }],
        available: true,
    }));
}

/**
 * Fetch models from ASI Cloud API (via provider module)
 */
async function fetchASICloudModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchASICloudModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: model.ownedBy,
        source: "asi-cloud" as const,
        providers: [{ provider: "asi-cloud", status: "live" as const }],
        available: true,
    }));
}

/**
 * Fetch models from OpenAI API (via provider module)
 */
async function fetchOpenAIModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchOpenAIModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: model.ownedBy,
        source: "openai" as const,
        task: model.task,
        providers: [{ provider: "openai", status: "live" as const }],
        available: true,
    }));
}

/**
 * Fetch models from Anthropic API (via provider module)
 */
async function fetchAnthropicModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchAnthropicModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: "anthropic",
        source: "anthropic" as const,
        task: model.task,
        providers: [{ provider: "anthropic", status: "live" as const }],
        available: true,
    }));
}

/**
 * Fetch models from OpenRouter API (via provider module)
 */
async function fetchOpenRouterModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchOpenRouterModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: model.id.split("/")[0] || "openrouter",
        source: "openrouter" as const,
        task: modalityToTask(model.modality),
        description: model.description,
        contextLength: model.contextLength,
        architecture: {
            inputModalities: model.inputModalities,
            outputModalities: model.outputModalities,
        },
        providers: [{ provider: "openrouter", status: "live" as const, contextLength: model.contextLength, pricing: { input: model.pricing.prompt, output: model.pricing.completion } }],
        pricing: { provider: "openrouter", input: model.pricing.prompt, output: model.pricing.completion },
        available: true,
    }));
}

/**
 * Fetch models from AI/ML API (via provider module)
 */
async function fetchAIMLModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchAIMLModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: model.ownedBy,
        source: "aiml" as const,
        task: model.task, // Now comes directly from aiml.ts with full task detection
        description: model.description,
        contextLength: model.contextLength,
        providers: [{ provider: "aiml", status: "live" as const }],
        available: true,
    }));
}

/**
 * Detect task type for a Google model based on name and capabilities
 * 
 * Google Model Names (December 2025):
 * - gemini-2.5-flash-image / gemini-3-pro-image-preview = "Nano Banana" / "Nano Banana Pro" (image generation)
 * - imagen-4.0-generate-001 / imagen-4.0 = Imagen 4 (text-to-image)
 * - veo-3.0-generate-preview / veo-3.0 = Veo 3 (text-to-video with audio)
 * - lyria-2.0-generate / lyria-002 = Lyria 2 (music generation)
 */
function detectGoogleModelTask(modelId: string, displayName: string, methods: string[]): string {
    const id = modelId.toLowerCase();
    const name = (displayName || "").toLowerCase();

    // Embedding models - check methods first as most reliable
    if (methods.includes("embedContent") || methods.includes("embedText") ||
        id.includes("embedding") || id.includes("embed") ||
        id.includes("text-embedding")) {
        return "feature-extraction";
    }

    // Video generation models (Veo series)
    // Check BEFORE image since "video" check might overlap
    if (id.includes("veo") || id.startsWith("veo-") ||
        name.includes("veo") || id.includes("-video")) {
        return "text-to-video";
    }

    // Audio/Music generation models (Lyria series)
    if (id.includes("lyria") || id.startsWith("lyria-") ||
        name.includes("lyria") || name.includes("music generation") ||
        id.includes("-music") || id.includes("-audio-generate")) {
        return "text-to-audio";
    }

    // Image generation models:
    // - Imagen series: imagen-4.0, imagen-3.0, etc.
    // - Gemini image models: gemini-*-image, gemini-*-image-preview
    // - "Nano Banana" models have "image" in the ID
    if (id.includes("imagen") || id.startsWith("imagen-") ||
        id.includes("-image") || id.endsWith("-image") ||
        id.includes("-image-") || id.includes("image-generation") ||
        name.includes("imagen") || name.includes("image generation") ||
        name.includes("nano banana")) {
        return "text-to-image";
    }

    // TTS (Text-to-Speech) models
    if (id.includes("tts") || id.includes("text-to-speech") ||
        name.includes("text-to-speech") || name.includes("speech synthesis")) {
        return "text-to-speech";
    }

    // Live/Realtime bidirectional streaming models
    if (methods.includes("bidiGenerateContent") ||
        id.includes("-live") || id.includes("realtime") ||
        name.includes("live") || name.includes("real-time")) {
        return "conversational";
    }

    // Default to text generation for all other generateContent models
    return "text-generation";
}

/**
 * Fetch models from Google AI API (via provider module)
 */
async function fetchGoogleModelsInternal(forceRefresh = false): Promise<ModelInfo[]> {
    const models = await fetchGoogleGenAIModels(forceRefresh);
    return models.map((model) => ({
        id: model.id,
        name: model.displayName || model.name,
        ownedBy: "google",
        source: "google" as const,
        task: model.task,
        description: model.description,
        contextLength: model.inputTokenLimit,
        providers: [{ provider: "google", status: "live" as const, contextLength: model.inputTokenLimit }],
        available: true,
    }));
}

// =============================================================================
// Registry Management
// =============================================================================

/**
 * Priority for deduplication (lower = higher priority)
 * Priority order per user spec:
 * 1. ASI Cloud (highest priority)
 * 2. ASI:One
 * 3. Google | OpenAI | Anthropic (same tier)
 * 4. HuggingFace
 * 5. OpenRouter
 * 6. AI/ML (lowest priority)
 */
const SOURCE_PRIORITY: Record<ModelInfo["source"], number> = {
    "asi-cloud": 1,
    "asi-one": 2,
    "google": 3,
    "openai": 3,
    "anthropic": 3,
    "huggingface": 4,
    "openrouter": 5,
    "aiml": 6,
};

/**
 * Normalize model ID for deduplication
 * Strips org prefix and normalizes common variations
 */
function normalizeModelId(modelId: string): string {
    // Remove known prefixes to find the "base" model name
    let name = modelId.toLowerCase();

    const prefixesToRemove = [
        "models/", // Google
        "meta-llama/", "mistralai/", "google/", "qwen/", "openai/", "anthropic/", // Org prefixes
        "black-forest-labs/", "stabilityai/", "nousresearch/"
    ];

    for (const prefix of prefixesToRemove) {
        if (name.startsWith(prefix)) {
            name = name.substring(prefix.length);
        }
    }

    // Special case normalization for common models that appear across providers
    // e.g. "llama-3.3-70b-instruct" vs "llama-3-3-70b-instruct"
    name = name
        .replace(/[^a-z0-9]/g, "") // Remove non-alphanumeric
        .replace(/instruct$/, "")
        .replace(/chat$/, "")
        .replace(/it$/, "") // Remove "-it" suffix
        .replace(/latest$/, "")
        .replace(/preview$/, "")
        .replace(/experimental$/, "");

    return name;
}

/**
 * Deduplicate models by normalized ID, keeping highest priority source
 */
function deduplicateModels(models: ModelInfo[]): ModelInfo[] {
    const seen = new Map<string, ModelInfo>();

    // Group models by normalized ID to see what we are comparing (debug purpose)
    // const groups = new Map<string, ModelInfo[]>();

    // Sort by priority first (lowest priority number = highest priority)
    const sorted = [...models].sort((a, b) => {
        const aPriority = SOURCE_PRIORITY[a.source] || 99;
        const bPriority = SOURCE_PRIORITY[b.source] || 99;

        // If priority is same (e.g. both from same source?), fallback to ID length or something stable
        if (aPriority === bPriority) {
            return a.id.localeCompare(b.id);
        }
        return aPriority - bPriority;
    });

    for (const model of sorted) {
        const normalizedId = normalizeModelId(model.id);

        // Only add if not already seen (first one wins due to sort order)
        if (!seen.has(normalizedId)) {
            seen.set(normalizedId, model);
        } else {
            // Optional: Log duplicates being dropped for debugging
            // const existing = seen.get(normalizedId);
            // console.log(`[models] Dropping duplicate ${model.id} (${model.source}) in favor of ${existing?.id} (${existing?.source})`);
        }
    }

    return Array.from(seen.values());
}

/**
 * Fetch all models from all providers
 */
export async function fetchAllModels(forceRefresh = false): Promise<ModelRegistry> {
    console.log("[models] Fetching from all providers...");

    // Clear all provider caches if force refresh
    if (forceRefresh) {
        clearOpenAICache();
        clearAnthropicCache();
        clearASICloudCache();
        clearASIOneCache();
        clearOpenRouterCache();
        clearAIMLCache();
    }

    const [hf, asiOne, asiCloud, oai, anth, goog, openrouter, aiml] = await Promise.all([
        fetchHuggingFaceModels(),
        fetchASIOneModelsInternal(forceRefresh),
        fetchASICloudModelsInternal(forceRefresh),
        fetchOpenAIModelsInternal(forceRefresh),
        fetchAnthropicModelsInternal(forceRefresh),
        fetchGoogleModelsInternal(forceRefresh),
        fetchOpenRouterModelsInternal(forceRefresh),
        fetchAIMLModelsInternal(forceRefresh),
    ]);

    const allModels = [...hf, ...asiOne, ...asiCloud, ...oai, ...anth, ...goog, ...openrouter, ...aiml];
    const sources: string[] = [];
    if (hf.length > 0) sources.push("huggingface");
    if (asiOne.length > 0) sources.push("asi-one");
    if (asiCloud.length > 0) sources.push("asi-cloud");
    if (oai.length > 0) sources.push("openai");
    if (anth.length > 0) sources.push("anthropic");
    if (goog.length > 0) sources.push("google");
    if (openrouter.length > 0) sources.push("openrouter");
    if (aiml.length > 0) sources.push("aiml");

    // Deduplicate models - priority: ASI Cloud > Google|OpenAI|Anthropic > HuggingFace > OpenRouter > AI/ML
    const dedupedModels = deduplicateModels(allModels);

    // Apply pricing from data/pricing.json AFTER deduplication
    // Each model gets pricing from its winning (highest priority) provider
    const pricedModels = applyPricing(dedupedModels);

    console.log(`[models] Loaded ${allModels.length} models, ${pricedModels.length} after deduplication from: ${sources.join(", ")}`);

    return { models: pricedModels, lastUpdated: Date.now(), sources };
}

/**
 * Get model registry (with caching)
 */
export async function getModelRegistry(): Promise<ModelRegistry> {
    if (registryCache && (Date.now() - registryCache.lastUpdated) < CACHE_TTL) {
        return registryCache;
    }
    registryCache = await fetchAllModels();
    return registryCache;
}

/**
 * Get a specific model by ID
 */
export async function getModelInfo(modelId: string): Promise<ModelInfo | null> {
    const registry = await getModelRegistry();
    return registry.models.find((m) => m.id === modelId) || null;
}

/**
 * Get models by source
 */
export async function getModelsBySource(source: ModelInfo["source"]): Promise<ModelInfo[]> {
    const registry = await getModelRegistry();
    return registry.models.filter((m) => m.source === source);
}

/**
 * Get available models
 */
export async function getAvailableModels(): Promise<ModelInfo[]> {
    const registry = await getModelRegistry();
    return registry.models.filter((m) => m.available);
}

/**
 * Force refresh - clears all caches and fetches fresh data
 */
export async function refreshRegistry(): Promise<ModelRegistry> {
    registryCache = null;
    registryCache = await fetchAllModels(true);
    return registryCache;
}

// =============================================================================
// Model Instance Creation - Routes to correct provider based on model
// =============================================================================

/**
 * Get language model instance
 * Routes to the CORRECT provider based on the model's source
 */
export function getLanguageModel(modelId: string, source?: ModelInfo["source"]): LanguageModel {
    const modelSource = source || inferModelSource(modelId);

    switch (modelSource) {
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
            return openRouterProvider(modelId);
        case "aiml":
            return aimlProvider(modelId);
        case "huggingface":
        default:
            // HuggingFace Router automatically picks cheapest inference provider
            return hfProvider(modelId);
    }
}

/**
 * Infer model source from model ID
 */
function inferModelSource(modelId: string): ModelInfo["source"] {
    // OpenAI models
    if (modelId.startsWith("gpt")) {
        return "openai";
    }
    // Anthropic models
    if (modelId.startsWith("claude")) {
        return "anthropic";
    }
    // Google models
    if (modelId.startsWith("gemini") || modelId.startsWith("models/gemini")) {
        return "google";
    }
    // ASI:One models (excluding asi1-mini which is on ASI Cloud)
    if (modelId.startsWith("asi1-") && modelId !== "asi1-mini") {
        return "asi-one";
    }
    // ASI Cloud models
    if (modelId === "asi1-mini") {
        return "asi-cloud";
    }
    // Check for known ASI Cloud OSS models
    const asiCloudPrefixes = ["google/gemma", "meta-llama/", "mistralai/", "qwen/"];
    if (asiCloudPrefixes.some((prefix) => modelId.startsWith(prefix))) {
        return "asi-cloud";
    }
    // OpenRouter models typically have org/model format with known providers
    if (modelId.includes("/") && (
        modelId.includes("openrouter") ||
        modelId.startsWith("nousresearch/") ||
        modelId.startsWith("phind/") ||
        modelId.startsWith("perplexity/")
    )) {
        return "openrouter";
    }
    // Default to HuggingFace for org/model format
    return "huggingface";
}

// =============================================================================
// Pricing - From provider APIs + platform fees
// =============================================================================

// Platform fee: $0.10 per million tokens (added on top of provider price)
const PLATFORM_FEE_PER_MILLION = 0.10;

/**
 * Calculate inference cost: provider price/M + $0.10/M platform fee
 */
export async function calculateInferenceCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): Promise<{ providerCost: number; platformFee: number; totalCost: number; costUsdcWei: bigint; provider?: string }> {
    const model = await getModelInfo(modelId);
    const totalTokens = inputTokens + outputTokens;

    if (!model?.pricing) {
        // No provider pricing available - charge platform fee only
        const platformFee = (totalTokens / 1_000_000) * PLATFORM_FEE_PER_MILLION;
        return {
            providerCost: 0,
            platformFee,
            totalCost: platformFee,
            costUsdcWei: BigInt(Math.ceil(platformFee * 1_000_000)),
        };
    }

    // Provider cost per million tokens
    const inputCost = (inputTokens / 1_000_000) * model.pricing.input;
    const outputCost = (outputTokens / 1_000_000) * model.pricing.output;
    const providerCost = inputCost + outputCost;

    // Platform fee: $0.10 per million tokens
    const platformFee = (totalTokens / 1_000_000) * PLATFORM_FEE_PER_MILLION;

    const totalCost = providerCost + platformFee;

    return {
        providerCost,
        platformFee,
        totalCost,
        costUsdcWei: BigInt(Math.ceil(totalCost * 1_000_000)),
        provider: model.pricing.provider,
    };
}

/**
 * Calculate action cost: 1% platform fee on the charged amount
 */
export function calculateActionCost(actionCost: number): { providerCost: number; platformFee: number; totalCost: number; costUsdcWei: bigint } {
    const platformFee = actionCost * 0.01; // 1% of action cost
    const totalCost = actionCost + platformFee;

    return {
        providerCost: actionCost,
        platformFee,
        totalCost,
        costUsdcWei: BigInt(Math.ceil(totalCost * 1_000_000)),
    };
}

/**
 * Calculate cost using pricing from registry (legacy - use calculateInferenceCost instead)
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

// =============================================================================
// Legacy Exports (for backwards compatibility)
// =============================================================================

export type ModelID = string;
export type ModelProviderType = ModelInfo["source"];
export const DEFAULT_MODEL: ModelID = "asi1-mini";

export function isValidModelId(modelId: string): boolean {
    return modelId.length > 0;
}

export function getModel(modelId: string): LanguageModel {
    return getLanguageModel(modelId);
}

// =============================================================================
// Helpers
// =============================================================================

function formatModelName(modelId: string): string {
    const parts = modelId.split("/");
    const name = parts[parts.length - 1];

    return name
        .split("-")
        .map((word) => {
            const abbrevs: Record<string, string> = {
                llm: "LLM", ai: "AI", gpt: "GPT", llama: "Llama",
                qwen: "Qwen", mistral: "Mistral", gemma: "Gemma",
                phi: "Phi", yi: "Yi", instruct: "Instruct", chat: "Chat",
                claude: "Claude", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku",
                gemini: "Gemini", flash: "Flash", pro: "Pro", mini: "Mini",
            };
            const lower = word.toLowerCase();
            return abbrevs[lower] || (word.charAt(0).toUpperCase() + word.slice(1));
        })
        .join(" ");
}
