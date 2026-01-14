/**
 * Vertex AI Model Garden Provider
 * 
 * Handles model fetching, deployment, and inference for Vertex AI Model Garden
 * Supports all modalities: text, image, video, audio, embeddings, speech
 */

import { GoogleAuth } from "google-auth-library";

// =============================================================================
// Configuration
// =============================================================================

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID || "gen-lang-client-0035632562";
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;

const BASE_URL = `https://${LOCATION}-aiplatform.googleapis.com`;

// =============================================================================
// Types
// =============================================================================

export interface VertexModelInfo {
    modelId: string;
    name: string;
    publisher: string;
    category: "serverless" | "self-deploy";
    taskTypes: string[];
    deploymentConfig?: {
        machineType?: string;
        acceleratorType?: string;
        acceleratorCount?: number;
        containerImage?: string;
    };
}

export interface VertexEndpoint {
    id: string;
    displayName: string;
    deployedModels: {
        id: string;
        model: string;
        displayName: string;
    }[];
}

export interface DeploymentOptions {
    machineType?: string;
    acceleratorType?: string;
    acceleratorCount?: number;
    minReplicaCount?: number;
    maxReplicaCount?: number;
    cohostToExistingEndpoint?: string; // Endpoint ID to cohost to
}

// =============================================================================
// Authentication
// =============================================================================

let authClient: GoogleAuth | null = null;
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

async function getAuthClient(): Promise<GoogleAuth> {
    if (!authClient) {
        authClient = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"]
        });
    }
    return authClient;
}

export async function getAccessToken(): Promise<string> {
    const now = Date.now();

    // Return cached token if still valid (with 5 min buffer)
    if (cachedToken && tokenExpiry > now + 300000) {
        return cachedToken;
    }

    const auth = await getAuthClient();
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();

    if (!tokenResponse.token) {
        throw new Error("Failed to get access token from Google Auth");
    }

    cachedToken = tokenResponse.token;
    // Tokens typically last 1 hour
    tokenExpiry = now + 3600000;

    return cachedToken;
}

// =============================================================================
// Model Fetching
// =============================================================================

const modelCache: VertexModelInfo[] = [];
let modelCacheTime = 0;
const MODEL_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

export async function fetchVertexModels(forceRefresh = false): Promise<VertexModelInfo[]> {
    const now = Date.now();

    if (!forceRefresh && modelCache.length > 0 && now - modelCacheTime < MODEL_CACHE_TTL) {
        return modelCache;
    }

    const accessToken = await getAccessToken();
    const allModels: VertexModelInfo[] = [];

    // Fetch from publishers
    const publishers = ["google", "*"];

    for (const publisher of publishers) {
        let pageToken: string | undefined;

        do {
            const url = `${BASE_URL}/v1beta1/publishers/${publisher}/models?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`;

            const response = await fetch(url, {
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                console.error(`[vertex] API error for ${publisher}: ${response.status}`);
                break;
            }

            const data = await response.json() as any;

            if (data.publisherModels) {
                for (const model of data.publisherModels) {
                    const modelId = model.name.split("/").pop() || "";
                    const pub = model.name.match(/publishers\/([^/]+)/)?.[1] || "unknown";

                    allModels.push({
                        modelId,
                        name: model.displayName || modelId,
                        publisher: pub,
                        category: isServerlessModel(pub, modelId) ? "serverless" : "self-deploy",
                        taskTypes: detectTaskTypes(model),
                        deploymentConfig: model.supportedActions?.deploy?.dedicatedResources?.machineSpec ? {
                            machineType: model.supportedActions.deploy.dedicatedResources.machineSpec.machineType,
                            acceleratorType: model.supportedActions.deploy.dedicatedResources.machineSpec.acceleratorType,
                            acceleratorCount: model.supportedActions.deploy.dedicatedResources.machineSpec.acceleratorCount,
                            containerImage: model.supportedActions.deploy.containerSpec?.imageUri
                        } : undefined
                    });
                }
            }

            pageToken = data.nextPageToken;
        } while (pageToken);
    }

    modelCache.length = 0;
    modelCache.push(...allModels);
    modelCacheTime = now;

    return allModels;
}

function isServerlessModel(publisher: string, modelId: string): boolean {
    if (publisher !== "google") return false;
    return modelId.includes("gemini") ||
        modelId.includes("imagen") ||
        modelId.includes("veo") ||
        modelId.includes("chirp") ||
        modelId.includes("embedding");
}

function detectTaskTypes(model: any): string[] {
    const tasks: string[] = [];
    const name = (model.displayName || model.name || "").toLowerCase();
    const desc = (model.description || "").toLowerCase();

    if (name.includes("gemini") || name.includes("llama") || name.includes("claude") ||
        name.includes("mistral") || name.includes("qwen") || desc.includes("language model")) {
        tasks.push("text-generation");
    }
    if (name.includes("imagen") || name.includes("flux") || desc.includes("image generation")) {
        tasks.push("image-generation");
    }
    if (name.includes("veo") || desc.includes("video")) {
        tasks.push("video-generation");
    }
    if (name.includes("chirp") || desc.includes("speech-to-text")) {
        tasks.push("speech-to-text");
    }
    if (name.includes("embedding")) {
        tasks.push("embeddings");
    }
    if (tasks.length === 0) tasks.push("text-generation");

    return tasks;
}

// =============================================================================
// Endpoint Management
// =============================================================================

export async function listEndpoints(): Promise<VertexEndpoint[]> {
    const accessToken = await getAccessToken();
    const url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints`;

    const response = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to list endpoints: ${response.status}`);
    }

    const data = await response.json() as any;

    return (data.endpoints || []).map((ep: any) => ({
        id: ep.name.split("/").pop(),
        displayName: ep.displayName,
        deployedModels: (ep.deployedModels || []).map((dm: any) => ({
            id: dm.id,
            model: dm.model,
            displayName: dm.displayName
        }))
    }));
}

export async function createEndpoint(displayName: string): Promise<string> {
    const accessToken = await getAccessToken();
    const url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ displayName })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to create endpoint: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;
    // Returns operation, need to poll for completion
    const operationName = data.name;

    // Wait for operation to complete
    const endpointName = await waitForOperation(operationName, accessToken);
    return endpointName.split("/").pop() || "";
}

async function waitForOperation(operationName: string, accessToken: string, maxWaitMs = 1800000): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        const url = `${BASE_URL}/v1/${operationName}`;

        const response = await fetch(url, {
            headers: { "Authorization": `Bearer ${accessToken}` }
        });

        if (!response.ok) {
            throw new Error(`Failed to check operation: ${response.status}`);
        }

        const data = await response.json() as any;

        if (data.done) {
            if (data.error) {
                throw new Error(`Operation failed: ${JSON.stringify(data.error)}`);
            }
            return data.response?.name || data.metadata?.genericMetadata?.outputInfo?.resourceName || "";
        }

        // Wait 10 seconds before polling again
        await new Promise(r => setTimeout(r, 10000));
    }

    throw new Error("Operation timed out");
}

// =============================================================================
// Model Deployment
// =============================================================================

export async function deployModel(
    modelId: string,
    options: DeploymentOptions = {}
): Promise<{ endpointId: string; deployedModelId: string }> {
    const accessToken = await getAccessToken();

    // Get or create endpoint
    let endpointId = options.cohostToExistingEndpoint;
    if (!endpointId) {
        console.log(`[vertex] Creating new endpoint for ${modelId}...`);
        endpointId = await createEndpoint(`${modelId}-endpoint`);
    }

    const endpointPath = `projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/${endpointId}`;
    const url = `${BASE_URL}/v1/${endpointPath}:deployModel`;

    // Build deployment request
    const deployedModel: any = {
        model: `publishers/google/models/${modelId}`, // Adjust publisher as needed
        displayName: modelId,
        dedicatedResources: {
            machineSpec: {
                machineType: options.machineType || "g2-standard-4",
                acceleratorType: options.acceleratorType || "NVIDIA_L4",
                acceleratorCount: options.acceleratorCount || 1
            },
            minReplicaCount: options.minReplicaCount || 1,
            maxReplicaCount: options.maxReplicaCount || 1
        }
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            deployedModel,
            trafficSplit: { "0": 100 } // 100% traffic to new model
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to deploy model: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    // Wait for deployment operation
    console.log(`[vertex] Deploying ${modelId}... (this may take 10-30 minutes)`);
    await waitForOperation(data.name, accessToken);

    return { endpointId, deployedModelId: "0" };
}

// =============================================================================
// Inference - Chat/Text Generation
// =============================================================================

export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface ChatOptions {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
}

export async function vertexGenerateChat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {}
): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> {
    const accessToken = await getAccessToken();

    // Determine if serverless or need endpoint
    const isServerless = isServerlessModel("google", modelId);

    let url: string;
    let body: any;

    if (isServerless) {
        // Use direct Gemini endpoint
        url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:generateContent`;

        body = {
            contents: messages.map(m => ({
                role: m.role === "assistant" ? "model" : m.role,
                parts: [{ text: m.content }]
            })),
            generationConfig: {
                temperature: options.temperature ?? 0.7,
                maxOutputTokens: options.maxOutputTokens ?? 2048,
                topP: options.topP,
                topK: options.topK
            }
        };
    } else {
        // Use deployed endpoint
        // First, find the endpoint for this model
        const endpoints = await listEndpoints();
        const endpoint = endpoints.find(ep =>
            ep.deployedModels.some(dm => dm.model.includes(modelId))
        );

        if (!endpoint) {
            throw new Error(`Model ${modelId} is not deployed. Call deployModel first.`);
        }

        url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/${endpoint.id}:predict`;

        body = {
            instances: [{ prompt: messages.map(m => `${m.role}: ${m.content}`).join("\n") }],
            parameters: {
                temperature: options.temperature ?? 0.7,
                maxOutputTokens: options.maxOutputTokens ?? 2048
            }
        };
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Chat generation failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    if (isServerless) {
        const candidate = data.candidates?.[0];
        return {
            text: candidate?.content?.parts?.[0]?.text || "",
            usage: {
                inputTokens: data.usageMetadata?.promptTokenCount || 0,
                outputTokens: data.usageMetadata?.candidatesTokenCount || 0
            }
        };
    } else {
        return {
            text: data.predictions?.[0] || "",
            usage: undefined
        };
    }
}

// =============================================================================
// Inference - Image Generation (Imagen)
// =============================================================================

export interface ImageOptions {
    numberOfImages?: number;
    aspectRatio?: string;
    negativePrompt?: string;
}

export async function vertexGenerateImage(
    prompt: string,
    options: ImageOptions = {}
): Promise<{ images: string[] }> {
    const accessToken = await getAccessToken();

    const url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagen-3.0-generate-001:predict`;

    const body = {
        instances: [{ prompt }],
        parameters: {
            sampleCount: options.numberOfImages || 1,
            aspectRatio: options.aspectRatio || "1:1",
            negativePrompt: options.negativePrompt
        }
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Image generation failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    return {
        images: (data.predictions || []).map((p: any) => p.bytesBase64Encoded)
    };
}

// =============================================================================
// Inference - Video Generation (Veo)
// =============================================================================

export interface VideoOptions {
    aspectRatio?: string;
    duration?: number;
}

export async function vertexGenerateVideo(
    prompt: string,
    options: VideoOptions = {}
): Promise<{ operationId: string }> {
    const accessToken = await getAccessToken();

    const url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/veo-2.0-generate-001:predict`;

    const body = {
        instances: [{ prompt }],
        parameters: {
            aspectRatio: options.aspectRatio || "16:9",
            durationSeconds: options.duration || 5
        }
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Video generation failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    // Veo returns an operation for async processing
    return { operationId: data.name?.split("/").pop() || "" };
}

// =============================================================================
// Inference - Embeddings
// =============================================================================

export async function vertexGenerateEmbeddings(
    texts: string[],
    modelId: string = "text-embedding-005"
): Promise<{ embeddings: number[][] }> {
    const accessToken = await getAccessToken();

    const url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

    const body = {
        instances: texts.map(text => ({ content: text }))
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Embeddings failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    return {
        embeddings: (data.predictions || []).map((p: any) => p.embeddings?.values || [])
    };
}

// =============================================================================
// Inference - Speech-to-Text (Chirp)
// =============================================================================

export async function vertexTranscribeAudio(
    audioBase64: string,
    languageCode: string = "en-US"
): Promise<{ transcript: string }> {
    const accessToken = await getAccessToken();

    // Chirp uses the Speech-to-Text V2 API
    const url = `https://speech.googleapis.com/v2/projects/${PROJECT_ID}/locations/${LOCATION}/recognizers/_:recognize`;

    const body = {
        config: {
            languageCodes: [languageCode],
            model: "chirp_2"
        },
        content: audioBase64
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Transcription failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    const results = data.results || [];
    const transcript = results.map((r: any) =>
        r.alternatives?.[0]?.transcript || ""
    ).join(" ");

    return { transcript };
}

// =============================================================================
// Inference - Text-to-Speech
// =============================================================================

export async function vertexGenerateSpeech(
    text: string,
    voiceName: string = "en-US-Studio-O"
): Promise<{ audioBase64: string }> {
    const accessToken = await getAccessToken();

    const url = `https://texttospeech.googleapis.com/v1/text:synthesize`;

    const body = {
        input: { text },
        voice: {
            languageCode: voiceName.substring(0, 5),
            name: voiceName
        },
        audioConfig: { audioEncoding: "MP3" }
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`TTS failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;

    return { audioBase64: data.audioContent };
}

// =============================================================================
// Inference - Grounded Generation (with Google Search)
// =============================================================================

export async function vertexGenerateWithGrounding(
    modelId: string,
    prompt: string,
    options: ChatOptions = {}
): Promise<{ text: string; groundingMetadata?: any }> {
    const accessToken = await getAccessToken();

    const url = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:generateContent`;

    const body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{
            googleSearchRetrieval: {
                dynamicRetrievalConfig: {
                    mode: "MODE_DYNAMIC",
                    dynamicThreshold: 0.3
                }
            }
        }],
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxOutputTokens ?? 2048
        }
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Grounded generation failed: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;
    const candidate = data.candidates?.[0];

    return {
        text: candidate?.content?.parts?.[0]?.text || "",
        groundingMetadata: candidate?.groundingMetadata
    };
}
