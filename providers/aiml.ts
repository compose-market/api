/**
 * AI/ML API Models Provider
 * 
 * Fetches models dynamically from AI/ML API.
 * ALL DATA FROM API - NO HARDCODING.
 * 
 * API Reference: https://docs.aimlapi.com/api-references/models-list
 * API returns: id, type, info (name, developer, description, contextLength, maxTokens), features, endpoints
 */

const AIML_API_KEY = process.env.AI_ML_API_KEY;

if (!AIML_API_KEY) {
    console.warn("[aiml] AI_ML_API_KEY not set - AI/ML API model discovery disabled");
}

// API response types matching actual API structure
export interface AIMLModelResponse {
    id: string;
    type: string; // "chat-completion", "image", "document", etc.
    info: {
        name: string;
        developer: string;
        description?: string;
        contextLength?: number;
        maxTokens?: number;
        url?: string;
        docs_url?: string;
    };
    features: string[];
    endpoints: string[];
}

export interface AIMLModelInfo {
    id: string;
    name: string;
    ownedBy: string;
    type: string;           // Raw type from API
    task: string;           // Normalized task type
    description: string;
    contextLength?: number;
    maxTokens?: number;
    features: string[];
    endpoints: string[];
}

// =============================================================================
// Task Detection - Convert API type to HuggingFace-style task
// =============================================================================

function apiTypeToTask(apiType: string, modelId: string): string {
    const type = apiType.toLowerCase();

    // Direct type mappings from API
    if (type === "chat-completion" || type === "responses") return "text-generation";
    if (type === "image") return "text-to-image";
    if (type === "document") return "document-question-answering";
    if (type === "embedding") return "feature-extraction";
    if (type === "audio") return "text-to-audio";
    if (type === "video") return "text-to-video";
    if (type === "speech") return "text-to-speech";
    if (type === "asr" || type === "transcription") return "automatic-speech-recognition";
    if (type === "3d" || type === "mesh") return "text-to-3d";
    if (type === "moderation") return "text-classification";

    // Fallback to model ID patterns if type is generic
    const id = modelId.toLowerCase();
    if (id.includes("whisper") || id.includes("asr")) return "automatic-speech-recognition";
    if (id.includes("tts") || id.includes("bark") || id.includes("voice")) return "text-to-speech";
    if (id.includes("embed") || id.includes("e5") || id.includes("bge")) return "feature-extraction";
    if (id.includes("flux") || id.includes("sdxl") || id.includes("stable-diffusion") || id.includes("dall")) return "text-to-image";
    if (id.includes("video") || id.includes("sora") || id.includes("veo")) return "text-to-video";
    if (id.includes("music") || id.includes("audio") || id.includes("lyria")) return "text-to-audio";
    if (id.includes("ocr")) return "document-question-answering";

    return "text-generation";
}

// =============================================================================
// Cache
// =============================================================================

let modelsCache: AIMLModelInfo[] | null = null;
let modelsCacheTimestamp = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function fetchAIMLModels(forceRefresh = false): Promise<AIMLModelInfo[]> {
    if (!AIML_API_KEY) {
        console.warn("[aiml] API key not set, skipping model fetch");
        return [];
    }

    if (!forceRefresh && modelsCache && Date.now() - modelsCacheTimestamp < CACHE_TTL) {
        return modelsCache;
    }

    try {
        const response = await fetch("https://api.aimlapi.com/models", {
            headers: { Authorization: `Bearer ${AIML_API_KEY}` },
        });

        if (!response.ok) {
            const error = await response.text();
            console.error("[aiml] Failed to fetch models:", response.status, error);
            return modelsCache || [];
        }

        const data = await response.json() as { object: string; data: AIMLModelResponse[] };
        const modelsList: AIMLModelResponse[] = data.data || [];

        // Extract ALL metadata from API - NO HARDCODING
        const models: AIMLModelInfo[] = modelsList.map((model) => ({
            id: model.id,
            name: model.info?.name || model.id,
            ownedBy: model.info?.developer || (model.id.includes("/") ? model.id.split("/")[0] : "aiml"),
            type: model.type,
            task: apiTypeToTask(model.type, model.id),
            description: model.info?.description || "",
            contextLength: model.info?.contextLength,
            maxTokens: model.info?.maxTokens,
            features: model.features || [],
            endpoints: model.endpoints || [],
        }));

        modelsCache = models;
        modelsCacheTimestamp = Date.now();

        console.log(`[aiml] Fetched ${models.length} models`);
        return models;
    } catch (error) {
        console.error("[aiml] Error fetching models:", error);
        return modelsCache || [];
    }
}

export function clearAIMLCache(): void {
    modelsCache = null;
    modelsCacheTimestamp = 0;
}
