/**
 * OpenRouter Models Dynamic Sync Script
 * 
 * Fetches latest models from OpenRouter API and writes to openrouter.json
 * matching the exact existing structure for compatibility with sync-models.ts
 * 
 * Run: npx tsx scripts/sync-openrouter.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from lambda root
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

// =============================================================================
// Configuration
// =============================================================================

const OPEN_ROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY;
if (!OPEN_ROUTER_API_KEY) {
    console.error("[sync-openrouter] ERROR: OPEN_ROUTER_API_KEY not found in .env");
    process.exit(1);
}

const API_URL = "https://openrouter.ai/api/v1/models";
const OUTPUT_FILE = path.join(__dirname, "..", "data", "providers", "openrouter.json");

// =============================================================================
// Types (matching API response)
// =============================================================================

interface OpenRouterAPIModel {
    id: string;
    name: string;
    description?: string;
    context_length: number;
    architecture?: {
        modality?: string;
        tokenizer?: string;
        instruct_type?: string;
        input_modalities?: string[];
        output_modalities?: string[];
    };
    top_provider?: {
        context_length?: number;
        max_completion_tokens?: number;
        is_moderated?: boolean;
    };
    pricing: {
        prompt: string;
        completion: string;
        request?: string;
        image?: string;
        web_search?: string;
        internal_reasoning?: string;
    };
    supported_parameters?: string[];
    created?: number;
}

interface OutputModel {
    name: string;
    modelId: string;
    canonicalSlug: string;
    huggingFaceId: string | null;
    createdUnix: number | null;
    description: string;
    contextWindowTokens: number;
    topProvider: {
        context_length: number;
        max_completion_tokens: number | null;
        is_moderated: boolean;
    };
    architecture: {
        modality: string;
        tokenizer: string;
        instructType: string | null;
        inputModalities: string[];
        outputModalities: string[];
    };
    prices: {
        raw: Record<string, string>;
        numeric: Record<string, number>;
        perMillionTokensUSD: {
            prompt: number;
            completion: number;
            internal_reasoning: number;
        };
        perUnitUSD: {
            request: number;
            image: number;
            web_search: number;
        };
    };
    capabilities: {
        supportedParameters: string[];
        reasoning: boolean;
        tools: boolean;
        structuredOutputs: boolean;
        responseFormat: boolean;
        visionInput: boolean;
        fileInput: boolean;
        audioInput: boolean;
        videoInput: boolean;
        imageOutput: boolean;
        audioOutput: boolean;
        textOutput: boolean;
        textInput: boolean;
        isModeratedByTopProvider: boolean;
    };
    taskTypes: string[];
    defaultParameters: Record<string, any>;
    perRequestLimits: any;
}

// =============================================================================
// Helper Functions
// =============================================================================

function deriveTaskTypes(
    inputModalities: string[],
    outputModalities: string[]
): string[] {
    const tasks: string[] = [];

    // Map input -> output modalities to task types
    const inputs = inputModalities || ["text"];
    const outputs = outputModalities || ["text"];

    for (const input of inputs) {
        for (const output of outputs) {
            if (input === output && input === "text") {
                tasks.push("text-to-text");
            } else if (input !== output) {
                tasks.push(`${input}-to-${output}`);
            }
        }
    }

    // Dedupe and return
    return [...new Set(tasks)];
}

function deriveCapabilities(
    supportedParams: string[],
    inputModalities: string[],
    outputModalities: string[]
): OutputModel["capabilities"] {
    const params = supportedParams || [];
    const inputs = inputModalities || [];
    const outputs = outputModalities || [];

    return {
        supportedParameters: params,
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
        tools: params.includes("tools") || params.includes("tool_choice"),
        structuredOutputs: params.includes("structured_outputs"),
        responseFormat: params.includes("response_format"),
        visionInput: inputs.includes("image"),
        fileInput: inputs.includes("file"),
        audioInput: inputs.includes("audio"),
        videoInput: inputs.includes("video"),
        imageOutput: outputs.includes("image"),
        audioOutput: outputs.includes("audio"),
        textOutput: outputs.includes("text"),
        textInput: inputs.includes("text"),
        isModeratedByTopProvider: false
    };
}

function transformModel(apiModel: OpenRouterAPIModel): OutputModel {
    const inputModalities = apiModel.architecture?.input_modalities || ["text"];
    const outputModalities = apiModel.architecture?.output_modalities || ["text"];

    // Parse prices
    const promptPrice = parseFloat(apiModel.pricing.prompt) || 0;
    const completionPrice = parseFloat(apiModel.pricing.completion) || 0;
    const requestPrice = parseFloat(apiModel.pricing.request || "0");
    const imagePrice = parseFloat(apiModel.pricing.image || "0");
    const webSearchPrice = parseFloat(apiModel.pricing.web_search || "0");
    const reasoningPrice = parseFloat(apiModel.pricing.internal_reasoning || "0");

    return {
        name: apiModel.name,
        modelId: apiModel.id,
        canonicalSlug: apiModel.id,
        huggingFaceId: null, // Not available from API
        createdUnix: apiModel.created || null,
        description: apiModel.description || "",
        contextWindowTokens: apiModel.context_length,
        topProvider: {
            context_length: apiModel.top_provider?.context_length || apiModel.context_length,
            max_completion_tokens: apiModel.top_provider?.max_completion_tokens || null,
            is_moderated: apiModel.top_provider?.is_moderated || false
        },
        architecture: {
            modality: apiModel.architecture?.modality || `${inputModalities.join(",")}→${outputModalities.join(",")}`,
            tokenizer: apiModel.architecture?.tokenizer || "Other",
            instructType: apiModel.architecture?.instruct_type || null,
            inputModalities,
            outputModalities
        },
        prices: {
            raw: {
                prompt: apiModel.pricing.prompt,
                completion: apiModel.pricing.completion,
                request: apiModel.pricing.request || "0",
                image: apiModel.pricing.image || "0",
                web_search: apiModel.pricing.web_search || "0",
                internal_reasoning: apiModel.pricing.internal_reasoning || "0"
            },
            numeric: {
                prompt: promptPrice,
                completion: completionPrice,
                request: requestPrice,
                image: imagePrice,
                web_search: webSearchPrice,
                internal_reasoning: reasoningPrice
            },
            perMillionTokensUSD: {
                prompt: promptPrice * 1_000_000,
                completion: completionPrice * 1_000_000,
                internal_reasoning: reasoningPrice * 1_000_000
            },
            perUnitUSD: {
                request: requestPrice,
                image: imagePrice,
                web_search: webSearchPrice
            }
        },
        capabilities: deriveCapabilities(
            apiModel.supported_parameters || [],
            inputModalities,
            outputModalities
        ),
        taskTypes: deriveTaskTypes(inputModalities, outputModalities),
        defaultParameters: {},
        perRequestLimits: null
    };
}

// =============================================================================
// Main Sync Function
// =============================================================================

async function syncOpenRouter(): Promise<void> {
    console.log("=".repeat(70));
    console.log("[sync-openrouter] Fetching models from OpenRouter API");
    console.log("=".repeat(70) + "\n");

    try {
        const response = await fetch(API_URL, {
            headers: {
                "Authorization": `Bearer ${OPEN_ROUTER_API_KEY}`,
                "HTTP-Referer": "https://compose.market",
                "X-Title": "Compose Market Model Sync"
            }
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { data: OpenRouterAPIModel[] };
        const apiModels = data.data || [];

        console.log(`[sync-openrouter] Fetched ${apiModels.length} models from API\n`);

        // Transform models
        const transformedModels = apiModels.map(transformModel);

        // Count by task type
        const taskCounts = new Map<string, number>();
        for (const model of transformedModels) {
            for (const task of model.taskTypes) {
                taskCounts.set(task, (taskCounts.get(task) || 0) + 1);
            }
        }

        console.log("[sync-openrouter] Task type distribution:");
        for (const [task, count] of Array.from(taskCounts.entries()).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${task}: ${count}`);
        }
        console.log("");

        // Count capabilities
        const capCounts = {
            vision: 0,
            audio: 0,
            tools: 0,
            imageOutput: 0,
            audioOutput: 0
        };
        for (const model of transformedModels) {
            if (model.capabilities.visionInput) capCounts.vision++;
            if (model.capabilities.audioInput) capCounts.audio++;
            if (model.capabilities.tools) capCounts.tools++;
            if (model.capabilities.imageOutput) capCounts.imageOutput++;
            if (model.capabilities.audioOutput) capCounts.audioOutput++;
        }

        console.log("[sync-openrouter] Capability counts:");
        console.log(`  Vision: ${capCounts.vision}`);
        console.log(`  Audio Input: ${capCounts.audio}`);
        console.log(`  Tools: ${capCounts.tools}`);
        console.log(`  Image Output: ${capCounts.imageOutput}`);
        console.log(`  Audio Output: ${capCounts.audioOutput}`);
        console.log("");

        // Build output
        const output = {
            source: {
                page: "https://openrouter.ai/models",
                api: API_URL,
                retrievedAtUTC: new Date().toISOString(),
                count: transformedModels.length,
                notes: [
                    "Prices are transcribed from OpenRouter's /api/v1/models response. Token prices are also converted to USD per 1,000,000 tokens where applicable.",
                    "Capabilities are derived directly from supported_parameters plus declared input/output modalities."
                ]
            },
            models: transformedModels
        };

        // Write to file
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        console.log(`[sync-openrouter] ✅ Written ${transformedModels.length} models to ${path.basename(OUTPUT_FILE)}`);
        console.log("");

    } catch (error) {
        console.error("[sync-openrouter] ❌ Error:", error);
        process.exit(1);
    }
}

// Run
syncOpenRouter();
