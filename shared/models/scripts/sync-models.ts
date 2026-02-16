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
// Standardized Capability Normalization
// =============================================================================

/**
 * Universal capability mapping across all providers
 * Maps provider-specific capability names to standard ModelCapability names
 */
const CAPABILITY_MAP: Record<string, ModelCapability> = {
    // Tools / Function calling
    "can_use_tools": "tools",
    "tool_use": "tools",
    "functioncalling": "tools",
    "function_calling": "tools",
    "function_call": "tools",
    "agentic_tool_use": "tools",
    "tools": "tools",
    
    // Reasoning / Thinking
    "reasoning": "reasoning",
    "thinking": "thinking",
    "extended_thinking": "thinking",
    "interleaved_thinking": "thinking",
    
    // Vision / Image understanding
    "image_understanding": "vision",
    "vision_image_input": "vision",
    "vision": "vision",
    "visionInput": "vision",
    "vision_input": "vision",
    
    // Image generation
    "image_generation": "image-generation",
    "imagegeneration": "image-generation",
    "can_generate_images": "image-generation",
    
    // Audio generation / TTS
    "audio_generation": "audio-generation",
    "audio_output": "audio-generation",
    "tts": "audio-generation",
    "music_generation": "audio-generation",
    "musicGeneration": "audio-generation",
    
    // Audio understanding / ASR
    "audio_understanding": "audio-understanding",
    "audio_input": "audio-understanding",
    "transcription": "audio-understanding",
    "speech_to_text": "audio-understanding",
    
    // Video understanding
    "video_understanding": "video-understanding",
    "video_input": "video-understanding",
    "videoInput": "video-understanding",
    
    // Embeddings
    "embeddings": "embeddings",
    "can_embed": "embeddings",
    "embedding": "embeddings",
    
    // Structured outputs
    "structured_outputs": "structured-outputs",
    "structured_json_output": "structured-outputs",
    
    // Streaming
    "streaming": "streaming",
    
    // Code execution
    "code_execution": "code-execution",
    "codeExecution": "code-execution",
    
    // Search grounding
    "search_grounding": "search-grounding",
    "searchGrounding": "search-grounding",
    
    // Live API
    "live_api": "live-api",
    "liveApi": "live-api",
    
    // Computer use
    "computer_use": "computer-use",
    "computerUse": "computer-use",
    
    // Agentic
    "agentic": "agentic",
};

/**
 * Normalize capabilities from any provider to standard ModelCapability[]
 * Only includes capabilities explicitly stated in source data
 */
function normalizeCapabilities(rawCapabilities: string[]): ModelCapability[] {
    const normalized: ModelCapability[] = [];
    
    for (const cap of rawCapabilities) {
        const capLower = cap.toLowerCase().replace(/[_\s-]/g, "");
        const mapped = CAPABILITY_MAP[capLower] || CAPABILITY_MAP[cap];
        
        if (mapped && !normalized.includes(mapped)) {
            normalized.push(mapped);
        }
    }
    
    return normalized;
}

/**
 * Extract capability keys from provider payloads.
 * - Arrays: pass through string values
 * - Objects: include only keys explicitly set to true
 */
function extractRawCapabilities(input: unknown): string[] {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.filter((cap): cap is string => typeof cap === "string");
    }
    if (typeof input === "object") {
        return Object.entries(input as Record<string, unknown>)
            .filter(([, value]) => value === true)
            .map(([key]) => key);
    }
    return [];
}

/**
 * Standardized task type validation
 * Uses source data directly with simple validation
 */
function normalizeTaskType(rawTask: string | undefined): string {
    if (!rawTask) return "text-generation";

    const canonical = rawTask
        .toLowerCase()
        .trim()
        .replace(/[_\\s]+/g, "-");

    const aliases: Record<string, string> = {
        chat: "conversational",
        "chat-completion": "conversational",
        "chat-completions": "conversational",
        text2textgeneration: "text2text-generation",
        "text2text-generation": "text2text-generation",
        embeddings: "feature-extraction",
        embedding: "feature-extraction",
        "speech-to-text": "automatic-speech-recognition",
        asr: "automatic-speech-recognition",
        stt: "automatic-speech-recognition",
        tts: "text-to-speech",
        "image-generation": "text-to-image",
        "video-generation": "text-to-video",
    };

    return aliases[canonical] || aliases[canonical.replace(/-/g, "")] || canonical;
}

/**
 * Standardized pricing extraction
 * Tries common pricing field patterns across providers
 */
function extractPricing(model: any): ModelPricing | null {
    // Try various pricing field patterns
    const input = 
        model.prices?.input ??
        model.prices?.text_tokens?.standard?.input ??
        model.prices?.perMillionTokensUSD?.prompt ??
        model.prices?.token?.input_per_1m ??
        model.prices?.tokens_per_million?.base_input ??
        model.pricing?.input ??
        model.pricing?.inputPer1M;
        
    const output =
        model.prices?.output ??
        model.prices?.text_tokens?.standard?.output ??
        model.prices?.perMillionTokensUSD?.completion ??
        model.prices?.token?.output_per_1m ??
        model.prices?.tokens_per_million?.output ??
        model.pricing?.output ??
        model.pricing?.outputPer1M;
    
    if (input == null || output == null) return null;
    
    return { input, output };
}

// =============================================================================
// Provider Transformers
// =============================================================================

/**
 * Transform OpenAI provider JSON to RawModel[]
 * SIMPLIFIED: Uses standardized normalization functions
 */
function transformOpenAI(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const [modelId, entry] of Object.entries(raw.models || {})) {
        const model = (entry as any).model;
        if (!model) continue;

        // Use standardized capability normalization
        const rawCaps = extractRawCapabilities(model.capabilities);
        const capabilities = normalizeCapabilities(rawCaps);

        // Use source task type directly, or first from pipeline
        const taskType = normalizeTaskType(
            model.task_type_pipeline?.task_types?.[0]
        );

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

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
 * SIMPLIFIED: Uses standardized normalization functions
 */
function transformClaude(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // Normalize capabilities from source data
        const rawCaps = extractRawCapabilities(model.capabilities);
        let capabilities = normalizeCapabilities(rawCaps);
        
        // Add streaming if not already present (Claude models all support it)
        if (!capabilities.includes("streaming")) {
            capabilities.push("streaming");
        }

        // Use source task type
        const taskType = normalizeTaskType(model.task_types?.[0]);

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

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
        });
    }

    console.log(`[sync] Anthropic: ${models.length} models`);
    return models;
}

/**
 * Transform Gemini/Google provider JSON to RawModel[]
 * SIMPLIFIED: Uses standardized normalization functions
 */
function transformGemini(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // Normalize capabilities from source data
        const rawCaps = extractRawCapabilities(model.capabilities);
        let capabilities = normalizeCapabilities(rawCaps);
        
        // Add streaming if not already present
        if (!capabilities.includes("streaming")) {
            capabilities.push("streaming");
        }

        // Use source data directly for task type and modalities
        const taskType = normalizeTaskType(model.taskType);

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

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
 * SIMPLIFIED: Uses standardized normalization functions
 */
function transformASICloud(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // Normalize capabilities from source data
        const rawCaps = extractRawCapabilities(model.capabilities);
        const capabilities = normalizeCapabilities(rawCaps);

        // Use source task type
        const taskType = normalizeTaskType(model.task_types?.[0]);

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

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
 * SIMPLIFIED: Uses standardized normalization functions
 */
function transformOpenRouter(jsonPath: string): RawModel[] {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // Normalize capabilities from source data
        const rawCaps = extractRawCapabilities(model.capabilities);
        let capabilities = normalizeCapabilities(rawCaps);
        
        // Add streaming if not already present (OpenRouter models typically support it)
        if (!capabilities.includes("streaming")) {
            capabilities.push("streaming");
        }

        // Use source task type
        const taskType = normalizeTaskType(model.taskTypes?.[0]);

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

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
            inputModalities: model.architecture?.inputModalities,
            outputModalities: model.architecture?.outputModalities,
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
        // Use standardized capability normalization
        const capabilities = normalizeCapabilities(extractRawCapabilities(model.capabilities));

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "huggingface",
            taskType: normalizeTaskType(model.taskType),
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
        // Use standardized capability normalization
        let capabilities = normalizeCapabilities(extractRawCapabilities(model.capabilities));
        
        // Add streaming if not already present (AIML models typically support it)
        if (!capabilities.includes("streaming")) {
            capabilities.push("streaming");
        }

        // Use standardized pricing extraction
        const pricing = extractPricing(model);

        // Use source task type directly
        const taskType = normalizeTaskType(model.task_types?.[0]);

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
 * SIMPLIFIED: Uses standardized normalization functions
 * Trusts source data - no hardcoded model ID pattern matching
 */
function transformVertex(jsonPath: string): RawModel[] {
    if (!fs.existsSync(jsonPath)) {
        console.log(`[sync] Vertex: file not found, skipping`);
        return [];
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const models: RawModel[] = [];

    for (const model of raw.models || []) {
        // Use standardized normalization - trust source data
        const capabilities = normalizeCapabilities(extractRawCapabilities(model.capabilities));
        const taskType = normalizeTaskType(model.taskType);

        models.push({
            modelId: model.modelId,
            name: model.name,
            provider: "vertex",
            taskType,
            capabilities,
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

function mergeStringArrays(a?: string[], b?: string[]): string[] | undefined {
    const merged = new Set<string>([...(a || []), ...(b || [])]);
    return merged.size > 0 ? Array.from(merged) : undefined;
}

function mergeModelCards(primary: ModelCard, secondary: ModelCard): ModelCard {
    const availableFrom = new Set<ModelProvider>([
        ...(primary.availableFrom || [primary.provider]),
        ...(secondary.availableFrom || [secondary.provider]),
    ]);

    const chooseTask =
        primary.taskType && primary.taskType !== "text-generation"
            ? primary.taskType
            : secondary.taskType || primary.taskType;

    return {
        ...primary,
        taskType: chooseTask,
        capabilities: Array.from(new Set([...(primary.capabilities || []), ...(secondary.capabilities || [])])),
        pricing: primary.pricing ?? secondary.pricing ?? null,
        description: primary.description || secondary.description,
        contextWindow: primary.contextWindow ?? secondary.contextWindow,
        maxOutputTokens: primary.maxOutputTokens ?? secondary.maxOutputTokens,
        ownedBy: primary.ownedBy || secondary.ownedBy,
        createdAt: primary.createdAt || secondary.createdAt,
        inputModalities: mergeStringArrays(primary.inputModalities, secondary.inputModalities),
        outputModalities: mergeStringArrays(primary.outputModalities, secondary.outputModalities),
        hfInferenceProvider: primary.hfInferenceProvider || secondary.hfInferenceProvider,
        hfProviderId: primary.hfProviderId || secondary.hfProviderId,
        availableFrom: Array.from(availableFrom),
    };
}

function dedupeModelCards(cards: ModelCard[]): ModelCard[] {
    const byId = new Map<string, ModelCard>();

    for (const card of cards) {
        const candidate: ModelCard = {
            ...card,
            availableFrom: card.availableFrom || [card.provider],
        };
        const existing = byId.get(card.modelId);
        if (!existing) {
            byId.set(card.modelId, candidate);
            continue;
        }

        const existingPriority = PROVIDER_PRIORITY[existing.provider] ?? 99;
        const incomingPriority = PROVIDER_PRIORITY[candidate.provider] ?? 99;

        if (incomingPriority < existingPriority) {
            byId.set(card.modelId, mergeModelCards(candidate, existing));
        } else {
            byId.set(card.modelId, mergeModelCards(existing, candidate));
        }
    }

    return Array.from(byId.values());
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

    // Convert to ModelCard then dedupe by modelId with provider-priority merge.
    const allModelCards = dedupeModelCards(allModels.map(toModelCard));
    console.log(`[sync-models] Total models after dedupe: ${allModelCards.length}`);

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
    // Output 2: models.json (OPTIMIZED - top N HF per task + all other providers)
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
