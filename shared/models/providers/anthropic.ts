/**
 * Anthropic Models Provider
 * 
 * Fetches models dynamically from Anthropic API.
 * ALL DATA FROM API - NO HARDCODING.
 * 
 * API Reference: https://docs.anthropic.com/en/api/models-list
 * 
 * Note: Anthropic API does not provide pricing - pricing comes from OpenRouter or must be null.
 * All Claude models are text-generation task.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
    console.warn("[anthropic] ANTHROPIC_API_KEY not set - Anthropic model discovery disabled");
}

export interface AnthropicModel {
    id: string;
    display_name: string;
    created_at: string;
    type: string;
}

export interface AnthropicModelsResponse {
    data: AnthropicModel[];
    has_more: boolean;
    first_id: string;
    last_id: string;
}

export interface AnthropicModelInfo {
    id: string;
    name: string;
    displayName: string;
    createdAt: string;
    type: string;
    task: string;
}

// =============================================================================
// Cache
// =============================================================================

let modelsCache: AnthropicModelInfo[] | null = null;
let modelsCacheTimestamp = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function fetchAnthropicModels(forceRefresh = false): Promise<AnthropicModelInfo[]> {
    if (!ANTHROPIC_API_KEY) {
        console.warn("[anthropic] API key not set, skipping model fetch");
        return [];
    }

    if (!forceRefresh && modelsCache && Date.now() - modelsCacheTimestamp < CACHE_TTL) {
        return modelsCache;
    }

    try {
        const allModels: AnthropicModelInfo[] = [];
        let afterId: string | null = null;
        let hasMore = true;

        // Paginate through all models
        while (hasMore) {
            const url = new URL("https://api.anthropic.com/v1/models");
            url.searchParams.set("limit", "1000");
            if (afterId) {
                url.searchParams.set("after_id", afterId);
            }

            const response = await fetch(url.toString(), {
                headers: {
                    "anthropic-version": "2023-06-01",
                    "X-Api-Key": ANTHROPIC_API_KEY,
                },
            });

            if (!response.ok) {
                const error = await response.text();
                console.error("[anthropic] Failed to fetch models:", response.status, error);
                return modelsCache || [];
            }

            const data = await response.json() as AnthropicModelsResponse;

            // Extract ALL metadata from API - NO HARDCODING
            const models: AnthropicModelInfo[] = data.data.map((model) => ({
                id: model.id,
                name: model.display_name || model.id,
                displayName: model.display_name,
                createdAt: model.created_at,
                type: model.type,
                task: "text-generation", // All Claude models are text generation
                // Note: pricing NOT included - Anthropic API doesn't provide it
            }));

            allModels.push(...models);
            hasMore = data.has_more;
            afterId = data.last_id;
        }

        modelsCache = allModels;
        modelsCacheTimestamp = Date.now();

        console.log(`[anthropic] Fetched ${allModels.length} models`);
        return allModels;
    } catch (error) {
        console.error("[anthropic] Error fetching models:", error);
        return modelsCache || [];
    }
}

export function clearAnthropicCache(): void {
    modelsCache = null;
    modelsCacheTimestamp = 0;
}
