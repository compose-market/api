/**
 * Model Compiler Script
 * 
 * Compiles all models from provider JSONs into a unified models.json.
 * 
 * Key Features:
 * 1. Reads from pre-compiled provider JSONs (no API calls)
 * 2. Transforms each format to standardized ModelCard schema
 * 3. Priority-based routing with data merging from all sources
 * 4. Array-based capabilities (positive only, no false values)
 * 
 * Priority Matrix (lower number = higher priority):
 * 1. Google | OpenAI | Anthropic (tie)
 * 2. ASI:Cloud | ASI:One
 * 3. OpenRouter
 * 4. HuggingFace
 * 5. AI/ML (lowest)
 * 
 * Run: npx tsx scripts/sync-models.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type {
    ModelCard,
    ModelCapability,
    ModelProvider,
    ModelPricing,
    RawModel,
    CompiledModelsData,
} from "../types.js";
import { PROVIDER_PRIORITY } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROVIDERS_DIR = path.join(__dirname, "..", "data", "providers");

// =============================================================================
// Provider Transformers
// =============================================================================

/**
 * Transform OpenAI provider JSON to RawModel[]
 */
function transformOpenAI(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const [modelId, entry] of Object.entries(raw.models || {})) {
        const model = (entry as any).model;
        if (!model) continue;

        const capabilities: ModelCapability[] = [];
        const caps = model.capabilities || {};

        if (caps.can_use_tools) capabilities.push("tools");
        if (caps.reasoning === true) capabilities.push("reasoning");
        if (caps.image_understanding) capabilities.push("vision");
        if (caps.image_generation) capabilities.push("image-generation");
        if (caps.audio_generation || caps.tts) capabilities.push("audio-generation");
        if (caps.audio_understanding || caps.transcription) capabilities.push("audio-understanding");
        if (caps.video_understanding) capabilities.push("video-understanding");
        if (caps.computer_use) capabilities.push("computer-use");
        if (caps.embeddings) capabilities.push("embeddings");
        if (caps.agentic) capabilities.push("agentic");

        // Pass through task type directly from source data - with fallback
        let taskType = model.task_type_pipeline?.task_types?.[0];

        // Fallback: derive task type from capabilities if not explicitly set
        if (!taskType) {
            if (caps.image_generation) {
                taskType = "text-to-image";
            } else if (caps.audio_generation || caps.tts) {
                taskType = "text-to-audio";
            } else if (caps.embeddings) {
                taskType = "feature-extraction";
            } else if (caps.image_understanding && !caps.can_use_tools) {
                taskType = "image-to-text";
            } else {
                taskType = "text-generation";
            }
        }

        // Extract pricing
        let pricing: ModelPricing | null = null;
        const prices = model.prices;
        if (prices?.text_tokens?.standard) {
            pricing = {
                input: prices.text_tokens.standard.input || 0,
                output: prices.text_tokens.standard.output || 0,
            };
        } else if (prices?.legacy_text_tokens?.standard) {
            pricing = {
                input: prices.legacy_text_tokens.standard.input || 0,
                output: prices.legacy_text_tokens.standard.output || 0,
            };
        }

        models.push({
            modelId: model.modelId || modelId,
            name: model.name || modelId,
            provider: "openai",
            taskType,
            capabilities,
            pricing,
            contextWindow: model.context_window?.tokens || undefined,
            maxOutputTokens: model.context_window?.max_output_tokens || undefined,
            ownedBy: "openai",
        });
    }

    console.log(`[sync] OpenAI: ${models.length} models`);
    return models;
}

/**
 * Transform Anthropic/Claude provider JSON to RawModel[]
 */
function transformClaude(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        const capabilities: ModelCapability[] = [];
        const caps = model.capabilities || {};

        if (caps.tool_use === true) capabilities.push("tools");
        if (caps.reasoning === true) capabilities.push("reasoning");
        if (caps.vision_image_input === true) capabilities.push("vision");
        if (caps.extended_thinking === true || caps.interleaved_thinking === true) {
            capabilities.push("thinking");
        }
        capabilities.push("streaming"); // All Claude models support streaming

        // Determine task type from task_types array
        let taskType = "text-generation";
        if ((model.task_types || []).includes("image-to-text")) {
            // Keep as text-generation but note vision capability
        }

        // Extract pricing
        let pricing: ModelPricing | null = null;
        const prices = model.prices?.tokens_per_million;
        if (prices?.base_input != null && prices?.output != null) {
            pricing = {
                input: prices.base_input,
                output: prices.output,
            };
        }

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "anthropic",
            taskType,
            capabilities,
            pricing,
            description: model.context_window?.notes,
            contextWindow: model.context_window?.standard_tokens || undefined,
            ownedBy: "anthropic",
            createdAt: model.status === "active" ? undefined : undefined,
        });
    }

    console.log(`[sync] Anthropic: ${models.length} models`);
    return models;
}

/**
 * Transform Gemini/Google provider JSON to RawModel[]
 */
function transformGemini(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        const capabilities: ModelCapability[] = [];
        const caps = model.capabilities || {};

        if (caps.functionCalling) capabilities.push("tools");
        if (caps.thinking) capabilities.push("thinking");
        if (caps.codeExecution) capabilities.push("code-execution");
        if (caps.searchGrounding) capabilities.push("search-grounding");
        if (caps.structuredOutputs) capabilities.push("structured-outputs");
        if (caps.imageGeneration) capabilities.push("image-generation");
        if (caps.audioGeneration || caps.musicGeneration) capabilities.push("audio-generation");
        if (caps.liveApi) capabilities.push("live-api");
        if (caps.embeddings) capabilities.push("embeddings");
        capabilities.push("streaming"); // All Gemini models support streaming

        // Check input modalities for vision
        const inputs = model.supportedDataTypes?.inputs || [];
        if (inputs.includes("image") || inputs.includes("video")) {
            capabilities.push("vision");
        }
        if (inputs.includes("audio")) {
            capabilities.push("audio-understanding");
        }
        if (inputs.includes("video")) {
            capabilities.push("video-understanding");
        }

        // Derive task type from capabilities and output modalities (source JSON has no explicit taskType)
        let taskType = "text-generation";
        const outputs = model.supportedDataTypes?.outputs || [];

        if (caps.imageGeneration || outputs.includes("image")) {
            taskType = "text-to-image";
        } else if (outputs.includes("video")) {
            taskType = "text-to-video";
        } else if (caps.audioGeneration || caps.musicGeneration || outputs.includes("audio") || outputs.includes("audio (music)")) {
            taskType = "text-to-audio";
        } else if (caps.embeddings) {
            taskType = "feature-extraction";
        }

        // Extract pricing
        let pricing: ModelPricing | null = null;
        if (model.prices?.input != null && model.prices?.output != null) {
            pricing = {
                input: model.prices.input,
                output: model.prices.output,
            };
        } else if (model.prices?.tiers?.[0]) {
            pricing = {
                input: model.prices.tiers[0].input || 0,
                output: model.prices.tiers[0].output || 0,
            };
        }

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "google",
            taskType,
            capabilities,
            pricing,
            description: model.description,
            contextWindow: model.contextWindow?.inputTokens || undefined,
            maxOutputTokens: model.contextWindow?.outputTokens || undefined,
            ownedBy: "google",
            inputModalities: model.supportedDataTypes?.inputs,
            outputModalities: model.supportedDataTypes?.outputs,
        });
    }

    console.log(`[sync] Google: ${models.length} models`);
    return models;
}

/**
 * Transform ASI:Cloud provider JSON to RawModel[]
 */
function transformASICloud(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        const capabilities: ModelCapability[] = [];
        const caps = model.capabilities || {};

        if (caps.streaming) capabilities.push("streaming");
        if (caps.structured_json_output) capabilities.push("structured-outputs");
        if (caps.agentic_tool_use) capabilities.push("tools");
        if (caps.embeddings) capabilities.push("embeddings");
        if (caps.reasoning) capabilities.push("reasoning");

        // Determine task type
        let taskType = "text-generation";
        if (caps.embeddings || (model.task_types || []).includes("embeddings")) {
            taskType = "feature-extraction";
        }

        // Extract pricing
        let pricing: ModelPricing | null = null;
        const tokenPrices = model.prices?.token;
        if (tokenPrices?.input_per_1m != null && tokenPrices?.output_per_1m != null) {
            pricing = {
                input: tokenPrices.input_per_1m,
                output: tokenPrices.output_per_1m,
            };
        }

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "asi-cloud",
            taskType,
            capabilities,
            pricing,
            contextWindow: model.context_window_tokens || undefined,
            ownedBy: model.organization || "asi-cloud",
        });
    }

    console.log(`[sync] ASI:Cloud: ${models.length} models`);
    return models;
}

/**
 * Transform OpenRouter provider JSON to RawModel[]
 */
function transformOpenRouter(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        const capabilities: ModelCapability[] = [];
        const caps = model.capabilities || {};

        if (caps.tools) capabilities.push("tools");
        if (caps.reasoning) capabilities.push("reasoning");
        if (caps.structuredOutputs) capabilities.push("structured-outputs");
        if (caps.visionInput) capabilities.push("vision");
        if (caps.audioInput) capabilities.push("audio-understanding");
        if (caps.videoInput) capabilities.push("video-understanding");
        if (caps.imageOutput) capabilities.push("image-generation");
        if (caps.audioOutput) capabilities.push("audio-generation");
        capabilities.push("streaming"); // OpenRouter typically supports streaming

        // Determine task type
        let taskType = "text-generation";
        const arch = model.architecture || {};
        if (arch.modality?.includes("image")) {
            taskType = caps.imageOutput ? "text-to-image" : "image-to-text";
        }
        if ((model.taskTypes || []).length > 0) {
            // Use first task type if available
            taskType = model.taskTypes[0].replace("text-to-text", "text-generation");
        }

        // Extract pricing
        let pricing: ModelPricing | null = null;
        const priceData = model.prices?.perMillionTokensUSD;
        if (priceData?.prompt != null && priceData?.completion != null) {
            pricing = {
                input: priceData.prompt,
                output: priceData.completion,
            };
        }

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "openrouter",
            taskType,
            capabilities,
            pricing,
            description: model.description,
            contextWindow: model.contextWindowTokens || model.topProvider?.context_length,
            maxOutputTokens: model.topProvider?.max_completion_tokens || undefined,
            ownedBy: model.modelId.split("/")[0] || "openrouter",
            inputModalities: arch.inputModalities,
            outputModalities: arch.outputModalities,
        });
    }

    console.log(`[sync] OpenRouter: ${models.length} models`);
    return models;
}

/**
 * Transform HuggingFace provider JSON to RawModel[]
 * Note: Provider field in hf.json is the internal provider (novita, nebius, etc.)
 * but for routing we always use "huggingface" as the provider
 * 
 * SIMPLIFIED: No hardcoded capability inference from task types.
 * All models can handle any input/output - the model decides what it can do.
 */
function transformHuggingFace(jsonPath: string): RawModel[] {
    if (!fs.existsSync(jsonPath)) {
        console.log(`[sync] HuggingFace: file not found, skipping`);
        return [];
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // SIMPLIFIED: Use capabilities from source data only
        // No inference from task types - all models are multimodal-capable
        const capabilities: ModelCapability[] = [];
        
        // Only normalize known capability names from source
        const rawCapabilities: string[] = model.capabilities || [];
        for (const cap of rawCapabilities) {
            const capLower = cap.toLowerCase();
            const validCaps: ModelCapability[] = [
                "tools", "reasoning", "structured-outputs", "vision", "code-execution",
                "search-grounding", "thinking", "streaming", "live-api", "embeddings",
                "image-generation", "audio-generation", "audio-understanding", 
                "video-understanding", "computer-use", "agentic"
            ];
            const matched = validCaps.find(vc => vc.toLowerCase() === capLower);
            if (matched && !capabilities.includes(matched)) {
                capabilities.push(matched);
            }
        }

        // Extract pricing
        let pricing: ModelPricing | null = null;
        if (model.pricing?.inputPer1M != null) {
            pricing = {
                input: model.pricing.inputPer1M,
                output: model.pricing.outputPer1M || 0,
            };
        }

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "huggingface",
            taskType: model.taskType || "text-generation",
            capabilities,
            pricing,
            ownedBy: model.modelId.split("/")[0] || "huggingface",
            hfInferenceProvider: model.provider,
            hfProviderId: model.providerId,
        });
    }

    console.log(`[sync] HuggingFace: ${models.length} models`);
    return models;
}

/**
 * Transform AI/ML API provider JSON to RawModel[]
 */
function transformAIML(jsonPath: string): RawModel[] {
    if (!fs.existsSync(jsonPath)) {
        console.log(`[sync] AI/ML: file not found, skipping`);
        return [];
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    // AI/ML JSON format may vary - adapt as needed
    for (const model of raw.models || []) {
        const capabilities: ModelCapability[] = [];
        capabilities.push("streaming");

        // Basic capability detection from model info
        if (model.capabilities?.tools) capabilities.push("tools");
        if (model.capabilities?.vision) capabilities.push("vision");

        let pricing: ModelPricing | null = null;
        if (model.pricing) {
            pricing = {
                input: model.pricing.input || 0,
                output: model.pricing.output || 0,
            };
        }

        // Use task_types array directly from source data (preserves exact types like image-to-image)
        // Fallback to type field, then default to text-generation
        let taskType = "text-generation";
        if (model.task_types && model.task_types.length > 0) {
            // Use first task type as-is (e.g., "text-to-image", "image-to-image")
            taskType = model.task_types[0];
        } else if (model.type) {
            // Map type field directly (e.g., "chat-completion" -> "text-generation")
            const typeMap: Record<string, string> = {
                "chat-completion": "text-generation",
                "text-completion": "text-generation",
                "image-generation": "text-to-image",
                "video-generation": "text-to-video",
                "audio-generation": "text-to-audio",
                "embedding": "feature-extraction",
            };
            taskType = typeMap[model.type] || model.type;
        }

        models.push({
            modelId: model.id || model.modelId,
            name: model.name || model.id,
            provider: "aiml",
            taskType,
            capabilities,
            pricing,
            description: model.description,
            contextWindow: model.contextLength || model.context_window_tokens,
            ownedBy: model.developer || "aiml",
        });
    }

    console.log(`[sync] AI/ML: ${models.length} models`);
    return models;
}

/**
 * Transform Vertex AI provider JSON to RawModel[]
 * SIMPLIFIED: Pass through task types and capabilities as-is from source data
 * No hardcoded "smart" detection - trust the source data
 */
function transformVertex(jsonPath: string): RawModel[] {
    if (!fs.existsSync(jsonPath)) {
        console.log(`[sync] Vertex: file not found, skipping`);
        return [];
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // Detect CORRECT task type from model ID patterns
        // Source data often has wrong task types (e.g., lyria marked as text-generation)
        const modelId = model.modelId || "";
        const modelIdLower = modelId.toLowerCase();
        const name = (model.name || "").toLowerCase();
        
        // Start with source task type, but override for known mis-categorized models
        let taskType = model.taskType || "text-generation";
        const normalizedCapabilities: ModelCapability[] = [];
        
        // Image generation models
        if (modelIdLower.includes("-image") || 
            modelIdLower.includes("imagen") ||
            modelIdLower.includes("imagegeneration")) {
            taskType = "text-to-image";
            if (!normalizedCapabilities.includes("image-generation")) {
                normalizedCapabilities.push("image-generation");
            }
        }
        // Video generation models
        else if (modelIdLower.includes("veo") ||
                 name.includes("video generation")) {
            taskType = "text-to-video";
        }
        // Audio/Music generation (Lyria and similar)
        else if (modelIdLower.includes("lyria") || 
                 modelIdLower.includes("-tts") ||
                 modelIdLower.includes("music") && modelIdLower.includes("generation")) {
            taskType = "text-to-audio";
            if (!normalizedCapabilities.includes("audio-generation")) {
                normalizedCapabilities.push("audio-generation");
            }
        }
        // Speech-to-text
        else if (modelIdLower.includes("chirp") ||
                 modelIdLower.includes("speech-to-text")) {
            taskType = "speech-to-text";
            if (!normalizedCapabilities.includes("audio-understanding")) {
                normalizedCapabilities.push("audio-understanding");
            }
        }
        // Embeddings
        else if (modelIdLower.includes("embedding") ||
                 modelIdLower.includes("embed") ||
                 modelIdLower.includes("multimodalembedding")) {
            taskType = "feature-extraction";
            if (!normalizedCapabilities.includes("embeddings")) {
                normalizedCapabilities.push("embeddings");
            }
        }
        
        // Normalize capabilities from source data
        const rawCapabilities: string[] = model.capabilities || [];
        for (const cap of rawCapabilities) {
            const capLower = cap.toLowerCase();
            if (capLower === "function_calling" || capLower === "function_call") {
                if (!normalizedCapabilities.includes("tools")) normalizedCapabilities.push("tools");
            } else if (capLower === "image-generation" && !normalizedCapabilities.includes("image-generation")) {
                normalizedCapabilities.push("image-generation");
            } else if (capLower === "audio-generation" && !normalizedCapabilities.includes("audio-generation")) {
                normalizedCapabilities.push("audio-generation");
            } else if (capLower === "vision" && !normalizedCapabilities.includes("vision")) {
                normalizedCapabilities.push("vision");
            } else if (capLower === "streaming" && !normalizedCapabilities.includes("streaming")) {
                normalizedCapabilities.push("streaming");
            } else if (capLower === "embeddings" && !normalizedCapabilities.includes("embeddings")) {
                normalizedCapabilities.push("embeddings");
            } else if (capLower === "audio-understanding" && !normalizedCapabilities.includes("audio-understanding")) {
                normalizedCapabilities.push("audio-understanding");
            } else if (capLower === "video-understanding" && !normalizedCapabilities.includes("video-understanding")) {
                normalizedCapabilities.push("video-understanding");
            }
        }

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "vertex",
            taskType,
            capabilities: normalizedCapabilities,
            pricing: model.pricing || null,
            description: model.description || undefined,
            contextWindow: model.contextWindow || undefined,
            ownedBy: model.ownedBy || "google",
        });
    }

    console.log(`[sync] Vertex: ${models.length} models`);
    return models;
}

// =============================================================================
// Convert RawModel to ModelCard
// =============================================================================

function toModelCard(raw: RawModel): ModelCard {
    return {
        modelId: raw.modelId,
        name: raw.name,
        provider: raw.provider,
        taskType: raw.taskType,
        capabilities: raw.capabilities,
        pricing: raw.pricing,
        description: raw.description,
        contextWindow: raw.contextWindow,
        maxOutputTokens: raw.maxOutputTokens,
        ownedBy: raw.ownedBy,
        createdAt: raw.createdAt,
        inputModalities: raw.inputModalities,
        outputModalities: raw.outputModalities,
        available: true,
        hfInferenceProvider: raw.hfInferenceProvider,
        hfProviderId: raw.hfProviderId,
    };
}

// =============================================================================
// Popular Models Selection for HuggingFace
// =============================================================================

const HF_TOP_N_PER_TASK = 100;

/**
 * Select top N most popular HuggingFace models per task type
 * Models are already sorted by trendingScore from sync-hf.ts
 * We just prioritize those with pricing and take top N
 */
function selectPopularHFModels(models: ModelCard[]): ModelCard[] {
    const hfModels = models.filter(m => m.provider === "huggingface");
    const otherModels = models.filter(m => m.provider !== "huggingface");

    // Group HF models by task type
    const hfByTask = new Map<string, ModelCard[]>();
    for (const m of hfModels) {
        const task = m.taskType || "unknown";
        if (!hfByTask.has(task)) hfByTask.set(task, []);
        hfByTask.get(task)!.push(m);
    }

    // Select top N per task type
    const popularHF: ModelCard[] = [];
    for (const [task, taskModels] of hfByTask) {
        // Sort by: 1) has pricing (more popular), 2) keep original trending order
        const sorted = taskModels.sort((a, b) => {
            // Prefer models with pricing (indicates they're actively used)
            const aHasPricing = a.pricing !== null ? 1 : 0;
            const bHasPricing = b.pricing !== null ? 1 : 0;
            return bHasPricing - aHasPricing;
            // NOTE: Removed broken name-length sort - models already sorted by trendingScore
        });

        popularHF.push(...sorted.slice(0, HF_TOP_N_PER_TASK));
        console.log(`[sync-models] HF ${task}: selected ${Math.min(sorted.length, HF_TOP_N_PER_TASK)}/${taskModels.length} models`);
    }

    console.log(`[sync-models] Selected ${popularHF.length} popular HF models across ${hfByTask.size} task types`);
    return [...otherModels, ...popularHF];
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log("[sync-models] Starting model compilation from provider JSONs...\n");

    const allModels: RawModel[] = [];

    // Transform each provider
    const openaiPath = path.join(PROVIDERS_DIR, "openai.json");
    if (fs.existsSync(openaiPath)) {
        allModels.push(...transformOpenAI(openaiPath));
    }

    const claudePath = path.join(PROVIDERS_DIR, "claude.json");
    if (fs.existsSync(claudePath)) {
        allModels.push(...transformClaude(claudePath));
    }

    const geminiPath = path.join(PROVIDERS_DIR, "gemini.json");
    if (fs.existsSync(geminiPath)) {
        allModels.push(...transformGemini(geminiPath));
    }

    const asicloudPath = path.join(PROVIDERS_DIR, "asicloud.json");
    if (fs.existsSync(asicloudPath)) {
        allModels.push(...transformASICloud(asicloudPath));
    }

    const openrouterPath = path.join(PROVIDERS_DIR, "openrouter.json");
    if (fs.existsSync(openrouterPath)) {
        allModels.push(...transformOpenRouter(openrouterPath));
    }

    const hfPath = path.join(PROVIDERS_DIR, "hf.json");
    if (fs.existsSync(hfPath)) {
        allModels.push(...transformHuggingFace(hfPath));
    }

    const aimlPath = path.join(PROVIDERS_DIR, "aimlapi.json");
    if (fs.existsSync(aimlPath)) {
        allModels.push(...transformAIML(aimlPath));
    }

    const vertexPath = path.join(PROVIDERS_DIR, "vertex.json");
    if (fs.existsSync(vertexPath)) {
        allModels.push(...transformVertex(vertexPath));
    }

    console.log(`\n[sync-models] Total models fetched: ${allModels.length}`);

    // NO deduplication - keep all models from all providers as-is
    const dedupedModels = allModels;
    console.log(`[sync-models] Total models (no deduplication): ${dedupedModels.length}`);

    // Convert to ModelCard format
    const allModelCards = dedupedModels.map(toModelCard);

    // Sort by provider priority ONLY - preserve original order within each provider
    // This keeps HuggingFace models in their trending order from sync-hf.ts
    allModelCards.sort((a, b) => {
        const priorityA = PROVIDER_PRIORITY[a.provider] || 99;
        const priorityB = PROVIDER_PRIORITY[b.provider] || 99;
        return priorityA - priorityB;
        // NOTE: Removed alphabetical sort - HF models should stay in trending order
    });

    // Compute global stats (for extended output)
    const byProvider: Record<ModelProvider, number> = {
        google: 0, openai: 0, anthropic: 0, vertex: 0,
        "asi-cloud": 0, "asi-one": 0,
        openrouter: 0, huggingface: 0, aiml: 0
    };
    const byTaskType: Record<string, number> = {};

    for (const model of allModelCards) {
        byProvider[model.provider] = (byProvider[model.provider] || 0) + 1;
        byTaskType[model.taskType] = (byTaskType[model.taskType] || 0) + 1;
    }

    // =========================================================================
    // Output 1: models_extended.json (FULL catalog - all 43k+ models)
    // =========================================================================
    const extendedOutputPath = path.join(__dirname, "..", "data", "models_extended.json");
    const extendedOutput: CompiledModelsData = {
        lastUpdated: new Date().toISOString(),
        totalModels: allModelCards.length,
        byProvider,
        byTaskType,
        models: allModelCards,
    };

    fs.writeFileSync(extendedOutputPath, JSON.stringify(extendedOutput, null, 2));
    const extendedSize = (fs.statSync(extendedOutputPath).size / 1024 / 1024).toFixed(2);
    console.log(`\n[sync-models] Wrote ${allModelCards.length} models to models_extended.json (${extendedSize}MB)`);

    // =========================================================================
    // Output 2: models.json (OPTIMIZED - top 30 HF per task + all other providers)
    // =========================================================================
    const optimizedCards = selectPopularHFModels(allModelCards);

    // Recompute stats for optimized set
    const optByProvider: Record<ModelProvider, number> = {
        google: 0, openai: 0, anthropic: 0, vertex: 0,
        "asi-cloud": 0, "asi-one": 0,
        openrouter: 0, huggingface: 0, aiml: 0
    };
    const optByTaskType: Record<string, number> = {};

    for (const model of optimizedCards) {
        optByProvider[model.provider] = (optByProvider[model.provider] || 0) + 1;
        optByTaskType[model.taskType] = (optByTaskType[model.taskType] || 0) + 1;
    }

    const outputPath = path.join(__dirname, "..", "data", "models.json");
    const output: CompiledModelsData = {
        lastUpdated: new Date().toISOString(),
        totalModels: optimizedCards.length,
        byProvider: optByProvider,
        byTaskType: optByTaskType,
        models: optimizedCards,
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    const optimizedSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
    console.log(`[sync-models] Wrote ${optimizedCards.length} models to models.json (${optimizedSize}MB)`);

    // Summary by provider (optimized)
    console.log("\n[sync-models] Models by provider (optimized):");
    for (const [provider, count] of Object.entries(optByProvider).sort((a, b) => b[1] - a[1])) {
        if (count > 0) console.log(`  ${provider}: ${count}`);
    }

    // Summary by task type (optimized)
    console.log("\n[sync-models] Models by task type (optimized):");
    for (const [task, count] of Object.entries(optByTaskType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${task}: ${count}`);
    }

    // Count models with/without pricing
    const withPricing = optimizedCards.filter(m => m.pricing !== null).length;
    console.log(`\n[sync-models] Pricing coverage: ${withPricing}/${optimizedCards.length} (${((withPricing / optimizedCards.length) * 100).toFixed(1)}%)`);

    // Final summary
    console.log("\n[sync-models] ✅ Compilation complete!");
    console.log(`  models.json:          ${optimizedCards.length} models (${optimizedSize}MB) - for app fast loading`);
    console.log(`  models_extended.json: ${allModelCards.length} models (${extendedSize}MB) - full catalog for API`);
}

main().catch(console.error);
