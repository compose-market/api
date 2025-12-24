/**
 * OpenRouter Models Provider
 * 
 * Fetches models dynamically from OpenRouter API.
 * Rich metadata including pricing, architecture, context length.
 */

const OPENROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
    console.warn("[openrouter] OPEN_ROUTER_API_KEY not set - OpenRouter model discovery disabled");
}

export interface OpenRouterModel {
    id: string;
    name: string;
    created?: number;
    description?: string;
    context_length: number;
    architecture: {
        modality: string;
        input_modalities: string[];
        output_modalities: string[];
    };
    pricing: {
        prompt: string;
        completion: string;
        request?: string;
        image?: string;
    };
    top_provider?: {
        is_moderated: boolean;
        context_length?: number;
        max_completion_tokens?: number;
    };
}

export interface OpenRouterModelInfo {
    id: string;
    name: string;
    description: string;
    contextLength: number;
    modality: string;
    inputModalities: string[];
    outputModalities: string[];
    pricing: {
        prompt: number;
        completion: number;
        request: number;
        image: number;
    };
    isModerated: boolean;
    maxCompletionTokens?: number;
}

let modelsCache: OpenRouterModelInfo[] | null = null;
let modelsCacheTimestamp = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function fetchOpenRouterModels(forceRefresh = false): Promise<OpenRouterModelInfo[]> {
    if (!OPENROUTER_API_KEY) {
        console.warn("[openrouter] API key not set, skipping model fetch");
        return [];
    }

    if (!forceRefresh && modelsCache && Date.now() - modelsCacheTimestamp < CACHE_TTL) {
        return modelsCache;
    }

    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
        });

        if (!response.ok) {
            const error = await response.text();
            console.error("[openrouter] Failed to fetch models:", response.status, error);
            return modelsCache || [];
        }

        const data = await response.json() as { data: OpenRouterModel[] };

        // Use name from API directly - NO hardcoded formatting
        const models: OpenRouterModelInfo[] = data.data.map((model) => ({
            id: model.id,
            name: model.name, // Use API name directly
            description: model.description || "",
            contextLength: model.context_length,
            modality: model.architecture?.modality || "text->text",
            inputModalities: model.architecture?.input_modalities || ["text"],
            outputModalities: model.architecture?.output_modalities || ["text"],
            pricing: {
                prompt: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
                completion: parseFloat(model.pricing?.completion || "0") * 1_000_000,
                request: parseFloat(model.pricing?.request || "0"),
                image: parseFloat(model.pricing?.image || "0"),
            },
            isModerated: model.top_provider?.is_moderated || false,
            maxCompletionTokens: model.top_provider?.max_completion_tokens,
        }));

        modelsCache = models;
        modelsCacheTimestamp = Date.now();

        console.log(`[openrouter] Fetched ${models.length} models`);
        return models;
    } catch (error) {
        console.error("[openrouter] Error fetching models:", error);
        return modelsCache || [];
    }
}

export function clearOpenRouterCache(): void {
    modelsCache = null;
    modelsCacheTimestamp = 0;
}

export function modalityToTask(modality: string): string {
    switch (modality) {
        case "text->text": return "text-generation";
        case "text->image": return "text-to-image";
        case "image->text": return "image-to-text";
        case "text->audio": return "text-to-speech";
        case "audio->text": return "automatic-speech-recognition";
        case "text->video": return "text-to-video";
        default: return "text-generation";
    }
}
