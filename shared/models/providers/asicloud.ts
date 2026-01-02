/**
 * ASI Cloud Models Provider
 * 
 * Fetches models dynamically from ASI Cloud API (OpenAI-compatible).
 */

const ASI_INFERENCE_API_KEY = process.env.ASI_INFERENCE_API_KEY;

if (!ASI_INFERENCE_API_KEY) {
    console.warn("[asicloud] ASI_INFERENCE_API_KEY not set - ASI Cloud model discovery disabled");
}

export interface ASICloudModel {
    id: string;
    object: string;
    created?: number;
    owned_by?: string;
}

export interface ASICloudModelInfo {
    id: string;
    name: string;
    ownedBy: string;
    created?: number;
    object: string;
}

let modelsCache: ASICloudModelInfo[] | null = null;
let modelsCacheTimestamp = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function fetchASICloudModels(forceRefresh = false): Promise<ASICloudModelInfo[]> {
    if (!ASI_INFERENCE_API_KEY) {
        console.warn("[asicloud] API key not set, skipping model fetch");
        return [];
    }

    if (!forceRefresh && modelsCache && Date.now() - modelsCacheTimestamp < CACHE_TTL) {
        return modelsCache;
    }

    try {
        const response = await fetch("https://inference.asicloud.cudos.org/v1/models", {
            headers: { Authorization: `Bearer ${ASI_INFERENCE_API_KEY}` },
        });

        if (!response.ok) {
            const error = await response.text();
            console.error("[asicloud] Failed to fetch models:", response.status, error);
            return modelsCache || [];
        }

        const data = await response.json() as { data: ASICloudModel[] };

        // Use model ID as name directly
        const models: ASICloudModelInfo[] = data.data.map((model) => ({
            id: model.id,
            name: model.id,
            ownedBy: model.owned_by || "asi-cloud",
            created: model.created,
            object: model.object,
        }));

        modelsCache = models;
        modelsCacheTimestamp = Date.now();

        console.log(`[asicloud] Fetched ${models.length} models`);
        return models;
    } catch (error) {
        console.error("[asicloud] Error fetching models:", error);
        return modelsCache || [];
    }
}

export function clearASICloudCache(): void {
    modelsCache = null;
    modelsCacheTimestamp = 0;
}
