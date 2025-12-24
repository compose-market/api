/**
 * OpenAI Models Provider
 * 
 * Fetches models dynamically from OpenAI API.
 * ALL DATA FROM API - NO HARDCODING.
 * 
 * API Reference: https://platform.openai.com/docs/api-reference/models/list
 * 
 * Note: OpenAI API does not provide pricing - pricing comes from OpenRouter or must be null.
 * Task types are inferred from model ID patterns as the API only returns model metadata.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
    console.warn("[openai] OPENAI_API_KEY not set - OpenAI model discovery disabled");
}

export interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

export interface OpenAIModelInfo {
    id: string;
    name: string;
    ownedBy: string;
    created: number;
    object: string;
    task: string;
}

// =============================================================================
// Task Detection - Infer from model ID patterns (API doesn't provide task)
// =============================================================================

function detectOpenAITask(modelId: string): string {
    const id = modelId.toLowerCase();

    // Image generation
    if (id.includes("dall-e") || id.includes("dalle") || id.includes("gpt-image")) {
        return "text-to-image";
    }

    // Speech recognition
    if (id.includes("whisper")) {
        return "automatic-speech-recognition";
    }

    // Text-to-speech
    if (id.startsWith("tts-") || id.includes("-tts")) {
        return "text-to-speech";
    }

    // Embeddings
    if (id.includes("embedding") || id.includes("embed")) {
        return "feature-extraction";
    }

    // Moderation
    if (id.includes("moderation")) {
        return "text-classification";
    }

    // Default to text generation for all chat/completion models
    return "text-generation";
}

// =============================================================================
// Cache
// =============================================================================

let modelsCache: OpenAIModelInfo[] | null = null;
let modelsCacheTimestamp = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function fetchOpenAIModels(forceRefresh = false): Promise<OpenAIModelInfo[]> {
    if (!OPENAI_API_KEY) {
        console.warn("[openai] API key not set, skipping model fetch");
        return [];
    }

    if (!forceRefresh && modelsCache && Date.now() - modelsCacheTimestamp < CACHE_TTL) {
        return modelsCache;
    }

    try {
        const response = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        });

        if (!response.ok) {
            const error = await response.text();
            console.error("[openai] Failed to fetch models:", response.status, error);
            return modelsCache || [];
        }

        const data = await response.json() as { data: OpenAIModel[] };

        // Extract ALL metadata from API - task inferred from model ID
        const models: OpenAIModelInfo[] = data.data.map((model) => ({
            id: model.id,
            name: model.id, // OpenAI API doesn't provide display names
            ownedBy: model.owned_by,
            created: model.created,
            object: model.object,
            task: detectOpenAITask(model.id),
            // Note: pricing NOT included - OpenAI API doesn't provide it
        }));

        modelsCache = models;
        modelsCacheTimestamp = Date.now();

        console.log(`[openai] Fetched ${models.length} models`);
        return models;
    } catch (error) {
        console.error("[openai] Error fetching models:", error);
        return modelsCache || [];
    }
}

export function clearOpenAICache(): void {
    modelsCache = null;
    modelsCacheTimestamp = 0;
}
