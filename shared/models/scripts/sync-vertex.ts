/**
 * Vertex AI Model Garden Sync Script
 * 
 * Fetches models from Vertex AI Model Garden and writes to vertex.json
 * Uses google-auth-library for ADC authentication (required by Vertex AI)
 * 
 * Setup: Run `gcloud auth application-default login` first
 * Run: npx tsx shared/models/scripts/sync-vertex.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { GoogleAuth } from "google-auth-library";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from lambda root
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

// =============================================================================
// Configuration
// =============================================================================

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID || "gen-lang-client-0035632562";
const LOCATION = "us-central1";

// Output file
const OUTPUT_FILE = path.join(__dirname, "..", "data", "providers", "vertex.json");

// Known publishers in Model Garden
const PUBLISHERS = ["google", "meta", "mistralai", "nvidia", "anthropic", "ai21", "cohere"];

// =============================================================================
// Types matching API response
// =============================================================================

interface VertexPublisherModel {
    name: string;  // e.g., "publishers/google/models/gemma3"
    versionId?: string;  // e.g., "gemma-3-1b-it"
    displayName?: string;
    description?: string;
    openSourceCategory?: string;
    launchStage?: string;
    frameworks?: string[];
    supportedActions?: {
        deploy?: {
            modelDisplayName?: string;
            containerSpec?: {
                imageUri?: string;
                predictRoute?: string;
            };
            dedicatedResources?: {
                machineSpec?: {
                    machineType?: string;
                    acceleratorType?: string;
                    acceleratorCount?: number;
                };
            };
        };
        openNotebook?: any;
        openFineTuningPipeline?: any;
        openGenerationAiStudio?: any;
    };
}

// Output matches ModelCard schema
interface VertexModelCard {
    modelId: string;
    name: string;
    provider: string;
    taskType: string;
    capabilities: string[];
    pricing: { input: number; output: number } | null;
    description?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    ownedBy: string;
    available: boolean;
    // Vertex-specific metadata
    vertexMeta?: {
        publisherModelName: string;
        launchStage?: string;
        openSource: boolean;
        deployable: boolean;
        acceleratorType?: string;
    };
}

// =============================================================================
// Authentication - Application Default Credentials (ADC)
// =============================================================================

let authClient: GoogleAuth | null = null;
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

async function getAccessToken(): Promise<string> {
    const now = Date.now();

    if (cachedToken && tokenExpiry > now + 300000) {
        return cachedToken;
    }

    if (!authClient) {
        authClient = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"]
        });
    }

    try {
        const client = await authClient.getClient();
        const tokenResponse = await client.getAccessToken();

        if (!tokenResponse.token) {
            throw new Error("Empty token returned");
        }

        cachedToken = tokenResponse.token;
        tokenExpiry = now + 3600000;

        return cachedToken;
    } catch (error: any) {
        console.error(`[sync-vertex] Authentication failed: ${error.message}`);
        console.error("[sync-vertex] Run: gcloud auth application-default login");
        throw error;
    }
}

// =============================================================================
// Model Fetching
// =============================================================================

async function fetchPublisherModels(accessToken: string): Promise<VertexPublisherModel[]> {
    const allModels: VertexPublisherModel[] = [];

    // Fetch from both locations:
    // - global: text/chat/MaaS serverless models
    // - us-central1: media models (image/video)
    const endpoints = [
        {
            location: "global",
            url: `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/global/publishers/-/models`
        },
        {
            location: "us-central1",
            url: `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/us-central1/publishers/-/models`
        }
    ];

    for (const endpoint of endpoints) {
        let pageToken: string | undefined;

        do {
            const params = new URLSearchParams({ pageSize: "1000" });
            if (pageToken) {
                params.set("pageToken", pageToken);
            }

            const url = `${endpoint.url}?${params.toString()}`;

            console.log(`[sync-vertex] Fetching from ${endpoint.location}...`);

            const response = await fetch(url, {
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "x-goog-user-project": PROJECT_ID
                }
            });

            if (!response.ok) {
                const text = await response.text();
                console.error(`[sync-vertex] API error for ${endpoint.location}: ${response.status} - ${text.substring(0, 200)}`);
                break;
            }

            const data = await response.json() as { publisherModels?: VertexPublisherModel[]; nextPageToken?: string };

            if (data.publisherModels && data.publisherModels.length > 0) {
                allModels.push(...data.publisherModels);
                console.log(`[sync-vertex] Found ${data.publisherModels.length} models from ${endpoint.location} (total: ${allModels.length})`);
            } else {
                console.log(`[sync-vertex] No models from ${endpoint.location}`);
            }

            pageToken = data.nextPageToken;

        } while (pageToken);
    }

    // Also fetch from individual publishers in us-central1 for Model Garden models
    for (const publisher of PUBLISHERS) {
        const baseUrl = `https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models`;
        let pageToken: string | undefined;

        do {
            const params = new URLSearchParams({ pageSize: "100", listAllVersions: "True" });
            if (pageToken) {
                params.set("pageToken", pageToken);
            }

            const url = `${baseUrl}?${params.toString()}`;

            console.log(`[sync-vertex] Fetching from publisher: ${publisher}...`);

            const response = await fetch(url, {
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "x-goog-user-project": PROJECT_ID
                }
            });

            if (!response.ok) {
                if (response.status === 404) {
                    console.log(`[sync-vertex] Publisher ${publisher} not found, skipping`);
                }
                break;
            }

            const data = await response.json() as { publisherModels?: VertexPublisherModel[]; nextPageToken?: string };

            if (data.publisherModels && data.publisherModels.length > 0) {
                allModels.push(...data.publisherModels);
                console.log(`[sync-vertex] Found ${data.publisherModels.length} models from ${publisher} (total: ${allModels.length})`);
            }

            pageToken = data.nextPageToken;

        } while (pageToken);
    }

    // Deduplicate by model name
    const seen = new Set<string>();
    const uniqueModels = allModels.filter(m => {
        if (seen.has(m.name)) return false;
        seen.add(m.name);
        return true;
    });

    console.log(`[sync-vertex] After dedup: ${uniqueModels.length} unique models`);
    return uniqueModels;
}

// =============================================================================
// Model Transformation
// =============================================================================

function extractFromPath(modelName: string): { publisher: string; baseModel: string } {
    // e.g., "publishers/google/models/gemma3" -> { publisher: "google", baseModel: "gemma3" }
    const publisherMatch = modelName.match(/publishers\/([^/]+)\/models\//);
    const modelMatch = modelName.match(/models\/(.+)$/);

    return {
        publisher: publisherMatch ? publisherMatch[1] : "unknown",
        baseModel: modelMatch ? modelMatch[1] : modelName
    };
}

function detectTaskType(baseModel: string, versionId: string): string {
    const combined = `${baseModel} ${versionId}`.toLowerCase();

    // Image generation
    if (combined.includes("imagen") || combined.includes("flux") ||
        combined.includes("stable-diffusion") || combined.includes("sdxl")) {
        return "text-to-image";
    }

    // Video generation
    if (combined.includes("veo")) {
        return "text-to-video";
    }

    // Speech-to-text
    if (combined.includes("chirp") || combined.includes("whisper") || combined.includes("usm")) {
        return "speech-to-text";
    }

    // Embeddings
    if (combined.includes("embedding") || combined.includes("textembedding") ||
        combined.includes("multimodalembedding")) {
        return "feature-extraction";
    }

    // Image classification/detection
    if (combined.includes("imageclassification") || combined.includes("object") ||
        combined.includes("segmentation")) {
        return "image-classification";
    }

    // Default: text generation (LLMs)
    return "text-generation";
}

function detectCapabilities(baseModel: string, versionId: string, actions: VertexPublisherModel["supportedActions"]): string[] {
    const caps: string[] = [];
    const combined = `${baseModel} ${versionId}`.toLowerCase();

    // Most LLMs support tools
    if (combined.includes("gemma") || combined.includes("llama") ||
        combined.includes("mistral") || combined.includes("claude") ||
        combined.includes("gemini") || combined.includes("codellama")) {
        caps.push("tools");
    }

    // Vision models
    if (combined.includes("paligemma") || combined.includes("molmo") ||
        combined.includes("llava") || combined.includes("vision")) {
        caps.push("vision");
    }

    // Code models
    if (combined.includes("code") || combined.includes("starcoder") ||
        combined.includes("codellama") || combined.includes("codestral")) {
        caps.push("tools");
    }

    // Image generation
    if (combined.includes("imagen") || combined.includes("flux") || combined.includes("stable")) {
        caps.push("image-generation");
    }

    // Streaming (most modern models)
    if (combined.includes("gemma") || combined.includes("llama") ||
        combined.includes("mistral") || combined.includes("gemini")) {
        caps.push("streaming");
    }

    return [...new Set(caps)]; // Dedupe
}

function transformModel(model: VertexPublisherModel): VertexModelCard {
    const { publisher, baseModel } = extractFromPath(model.name);
    const versionId = model.versionId || "default";
    const actions = model.supportedActions || {};
    const deploy = actions.deploy;

    // Build modelId: publisher/baseModel@version
    const modelId = versionId !== "default" && versionId !== baseModel
        ? `${publisher}/${baseModel}@${versionId}`
        : `${publisher}/${baseModel}`;

    // Human-readable name - prefer deploy displayName, then check if versionId is meaningful
    const isGenericVersion = /^(\d{8}|\d{3}|v\d+|default)$/.test(versionId);
    const displayName = deploy?.modelDisplayName ||
        (isGenericVersion ? `${baseModel} (${versionId})` : versionId) ||
        baseModel;

    // Task type
    const taskType = detectTaskType(baseModel, versionId);

    // Capabilities
    const capabilities = detectCapabilities(baseModel, versionId, actions);

    // Is open source?
    const isOpenSource = model.openSourceCategory !== "PROPRIETARY" &&
        model.openSourceCategory !== undefined;

    return {
        modelId,
        name: displayName,
        provider: "vertex", // All Vertex models route through vertex provider
        taskType,
        capabilities,
        pricing: null, // Vertex pricing is complex (per-deployment)
        description: model.description || undefined,
        ownedBy: publisher,
        available: true,
        vertexMeta: {
            publisherModelName: model.name,
            launchStage: model.launchStage,
            openSource: isOpenSource,
            deployable: !!deploy,
            acceleratorType: deploy?.dedicatedResources?.machineSpec?.acceleratorType
        }
    };
}

// =============================================================================
// Main Sync Function
// =============================================================================

async function syncVertexModels(): Promise<void> {
    console.log("=".repeat(70));
    console.log("[sync-vertex] Fetching models from Vertex AI Model Garden");
    console.log(`[sync-vertex] Project: ${PROJECT_ID}`);
    console.log(`[sync-vertex] Location: ${LOCATION}`);
    console.log(`[sync-vertex] Publishers: ${PUBLISHERS.join(", ")}`);
    console.log("=".repeat(70) + "\n");

    try {
        console.log("[sync-vertex] Authenticating via Application Default Credentials...");
        const accessToken = await getAccessToken();
        console.log("[sync-vertex] ✅ Authenticated\n");

        const publisherModels = await fetchPublisherModels(accessToken);
        console.log(`\n[sync-vertex] Total raw models fetched: ${publisherModels.length}\n`);

        if (publisherModels.length === 0) {
            console.log("[sync-vertex] No models found. Check permissions.");
            return;
        }

        // Transform to ModelCard format
        const modelCards = publisherModels.map(transformModel);

        // Count by publisher
        const publisherCounts = new Map<string, number>();
        for (const mc of modelCards) {
            publisherCounts.set(mc.ownedBy, (publisherCounts.get(mc.ownedBy) || 0) + 1);
        }

        console.log("[sync-vertex] Models by publisher:");
        for (const [pub, count] of Array.from(publisherCounts.entries()).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${pub}: ${count}`);
        }
        console.log("");

        // Count by task type
        const taskCounts = new Map<string, number>();
        for (const mc of modelCards) {
            taskCounts.set(mc.taskType, (taskCounts.get(mc.taskType) || 0) + 1);
        }

        console.log("[sync-vertex] Models by task type:");
        for (const [task, count] of Array.from(taskCounts.entries()).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${task}: ${count}`);
        }
        console.log("");

        // Build output matching models.json structure
        const output = {
            lastUpdated: new Date().toISOString(),
            totalModels: modelCards.length,
            byPublisher: Object.fromEntries(publisherCounts),
            byTaskType: Object.fromEntries(taskCounts),
            source: {
                api: `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/publishers/{publisher}/models`,
                projectId: PROJECT_ID,
                location: LOCATION,
                notes: [
                    "Models from Vertex AI Model Garden",
                    "Provider 'google' for routing through Vertex AI",
                    "Use vertexMeta.publisherModelName for deployment"
                ]
            },
            models: modelCards
        };

        // Ensure directory exists
        const dir = path.dirname(OUTPUT_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write to file
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        console.log(`[sync-vertex] ✅ Written ${modelCards.length} models to ${path.basename(OUTPUT_FILE)}`);

        // Show sample models
        console.log("\n[sync-vertex] Sample models:");
        const samples = modelCards.filter(m =>
            m.modelId.includes("gemma") || m.modelId.includes("llama") ||
            m.modelId.includes("imagen") || m.modelId.includes("claude")
        ).slice(0, 5);

        for (const s of samples) {
            console.log(`  ${s.modelId} (${s.taskType}) - ${s.name}`);
        }
        console.log("");

    } catch (error) {
        console.error("[sync-vertex] ❌ Error:", error);
        process.exit(1);
    }
}

// Run
syncVertexModels();
