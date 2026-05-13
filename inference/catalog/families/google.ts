/**
 * Google GenAI Inference Handler
 * 
 * Comprehensive handler for Google Generative AI models using the @google/genai SDK.
 * 
 * Supported Features:
 * - Gemini text/chat models (generateContent)
 * - Nano Banana / Nano Banana Pro image generation (generateContent + responseModalities: IMAGE)
 * - Veo video generation (generateVideos with LRO polling + file download)
 * - TTS models (generateContent + responseModalities: AUDIO + speechConfig)
 * - Embeddings (embedContent)
 * - Deep Research Agent (Interactions API)
 * - Built-in Tools: Google Search, Code Execution, File Search, URL Context
 * 
 * NOT supported in this module (requires WebSocket):
 * - Lyria RealTime music generation (requires persistent WebSocket - see services/socket)
 * - Live API real-time streaming
 * 
 * API References:
 * - https://ai.google.dev/gemini-api/docs/image-generation
 * - https://ai.google.dev/gemini-api/docs/video
 * - https://ai.google.dev/gemini-api/docs/deep-research
 * - https://ai.google.dev/gemini-api/docs/google-search
 * - https://ai.google.dev/gemini-api/docs/code-execution
 * - https://ai.google.dev/gemini-api/docs/file-search
 * - https://ai.google.dev/gemini-api/docs/url-context
 */
import type { Request, Response } from "express";
import { GoogleGenAI, type GenerateContentResponse, type Content, type Part } from "@google/genai";

const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const BASE_URL = "https://generativelanguage.googleapis.com";

if (!GOOGLE_API_KEY) {
    console.warn("[genai] GOOGLE_GENERATIVE_AI_API_KEY not set - Google model inference disabled");
}

// Initialize Google GenAI client
let genaiClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
    if (!GOOGLE_API_KEY) {
        throw new Error("Google API key not configured");
    }
    if (!genaiClient) {
        genaiClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
    }
    return genaiClient;
}

function normalizeUsageMetadata(value: unknown): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    billingMetrics?: Record<string, unknown>;
} | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const record = value as {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        responseTokenCount?: number;
        totalTokenCount?: number;
        promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
        responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
        candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
        cacheTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
        thoughtsTokenCount?: number;
    };
    const promptTokens = typeof record.promptTokenCount === "number" ? record.promptTokenCount : undefined;
    const completionTokens = typeof record.candidatesTokenCount === "number"
        ? record.candidatesTokenCount
        : typeof record.responseTokenCount === "number"
            ? record.responseTokenCount
            : undefined;
    if (promptTokens === undefined || completionTokens === undefined) {
        return undefined;
    }

    const billingMetrics: Record<string, unknown> = {};
    const assignModalityMetrics = (
        details: Array<{ modality?: string; tokenCount?: number }> | undefined,
        prefix: "input" | "output" | "cached_input",
    ) => {
        for (const entry of details || []) {
            if (typeof entry?.tokenCount !== "number" || entry.tokenCount <= 0) {
                continue;
            }

            const modality = typeof entry.modality === "string" ? entry.modality.trim().toLowerCase() : "";
            if (!modality) {
                continue;
            }

            billingMetrics[`${prefix}_${modality}_tokens`] = entry.tokenCount;
        }
    };

    assignModalityMetrics(record.promptTokensDetails, "input");
    assignModalityMetrics(record.responseTokensDetails ?? record.candidatesTokensDetails, "output");
    assignModalityMetrics(record.cacheTokensDetails, "cached_input");

    if (typeof record.thoughtsTokenCount === "number" && record.thoughtsTokenCount > 0) {
        billingMetrics.reasoning_tokens = record.thoughtsTokenCount;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens: typeof record.totalTokenCount === "number" ? record.totalTokenCount : promptTokens + completionTokens,
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
    };
}

// =============================================================================
// Types
// =============================================================================

export interface GoogleModelInfo {
    id: string;
    name: string;
    displayName: string;
    description?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedMethods: string[];
    task: string;
    capabilities: {
        audioGeneration: boolean;
        imageGeneration: boolean;
        videoGeneration: boolean;
        liveApi: boolean;
        batchApi: boolean;
        caching: boolean;
        codeExecution: boolean;
        fileSearch: boolean;
        functionCalling: boolean;
        mapsGrounding: boolean;
        searchGrounding: boolean;
        structuredOutputs: boolean;
        thinking: boolean;
        urlContext: boolean;
    };
}

export interface GoogleToolConfig {
    googleSearch?: boolean;
    mapsGrounding?: { dynamicRetrievalConfig?: { dynamicThreshold?: number } };
    codeExecution?: boolean;
    fileSearch?: { store?: string };
    urlContext?: { urls?: string[] };
}

// =============================================================================
// Model Discovery
// =============================================================================

/**
 * Fetch all models from Google Generative AI API
 * Dynamically discovers available models with pagination and extracts capabilities
 * Fetches from both v1beta (stable) and v1alpha (experimental, includes Lyria) endpoints
 */
export async function fetchGoogleModels(forceRefresh = false): Promise<GoogleModelInfo[]> {
    if (!GOOGLE_API_KEY) {
        console.warn("[genai] API key not set, skipping model fetch");
        return [];
    }

    try {
        const allModels: GoogleModelInfo[] = [];
        const seenModelIds = new Set<string>();

        // Fetch from both v1beta (stable) and v1alpha (experimental - includes Lyria)
        const apiVersions = ["v1beta", "v1alpha"];

        for (const apiVersion of apiVersions) {
            let pageToken: string | undefined;

            do {
                const url = new URL(`${BASE_URL}/${apiVersion}/models`);
                url.searchParams.set("key", GOOGLE_API_KEY);
                url.searchParams.set("pageSize", "1000");

                if (pageToken) {
                    url.searchParams.set("pageToken", pageToken);
                }

                const response = await fetch(url.toString());

                if (!response.ok) {
                    const error = await response.text();
                    console.warn(`[genai] Failed to fetch ${apiVersion} models:`, error);
                    break;
                }

                const data = await response.json() as {
                    models: Array<{
                        name: string;
                        displayName: string;
                        description?: string;
                        inputTokenLimit?: number;
                        outputTokenLimit?: number;
                        supportedGenerationMethods?: string[];
                    }>;
                    nextPageToken?: string;
                };

                const models: GoogleModelInfo[] = data.models
                    .filter((model) => {
                        const modelId = model.name.replace("models/", "");
                        // Skip if already seen from v1beta
                        if (seenModelIds.has(modelId)) return false;
                        seenModelIds.add(modelId);
                        return true;
                    })
                    .map((model) => {
                        const modelId = model.name.replace("models/", "");
                        const methods = model.supportedGenerationMethods || [];
                        const description = (model.description || "").toLowerCase();
                        const displayName = model.displayName || modelId;

                        // Extract capabilities from methods and description
                        const capabilities = extractCapabilities(modelId, displayName, description, methods);

                        // Detect Lyria as text-to-music
                        let task = detectTaskFromCapabilities(modelId, displayName, methods, capabilities);
                        if (modelId.includes("lyria")) {
                            task = "text-to-music";
                        }

                        return {
                            id: modelId,
                            name: modelId,
                            displayName,
                            description: model.description,
                            inputTokenLimit: model.inputTokenLimit,
                            outputTokenLimit: model.outputTokenLimit,
                            supportedMethods: methods,
                            task,
                            capabilities,
                        };
                    });

                allModels.push(...models);
                pageToken = data.nextPageToken;
            } while (pageToken);
        }

        console.log(`[genai] Fetched ${allModels.length} models with capabilities (including v1alpha experimental)`);
        return allModels;
    } catch (error) {
        console.error("[genai] Error fetching models:", error);
        return [];
    }
}

/**
 * Extract model capabilities from ID, description, and methods
 */
function extractCapabilities(
    modelId: string,
    displayName: string,
    description: string,
    methods: string[]
): GoogleModelInfo["capabilities"] {
    const id = modelId.toLowerCase();
    const name = displayName.toLowerCase();

    return {
        audioGeneration: id.includes("-tts") || id.includes("tts-") ||
            description.includes("text-to-speech") || description.includes("audio output"),
        imageGeneration: id.includes("-image") || id.endsWith("-image") ||
            name.includes("nano banana") || description.includes("image generation"),
        videoGeneration: id.includes("veo") || id.startsWith("veo-"),
        liveApi: methods.includes("bidiGenerateContent") || id.includes("-live") ||
            id.includes("-native-audio"),
        batchApi: description.includes("batch") || !id.includes("preview"),
        caching: description.includes("caching") || description.includes("context caching"),
        codeExecution: description.includes("code execution") ||
            (methods.includes("generateContent") && !id.includes("-image")),
        fileSearch: description.includes("file search") || description.includes("rag"),
        functionCalling: methods.includes("generateContent") && !id.includes("-image") &&
            !id.includes("-tts") && !id.includes("veo"),
        mapsGrounding: description.includes("maps") || description.includes("grounding"),
        searchGrounding: description.includes("search") || description.includes("grounding"),
        structuredOutputs: methods.includes("generateContent") && !id.includes("-image"),
        thinking: description.includes("thinking") || id.includes("thinking") ||
            (id.includes("gemini-3") || id.includes("gemini-2.5")),
        urlContext: description.includes("url") || methods.includes("generateContent"),
    };
}

/**
 * Detect task type from model capabilities
 */
function detectTaskFromCapabilities(
    modelId: string,
    displayName: string,
    methods: string[],
    capabilities: GoogleModelInfo["capabilities"]
): string {
    const id = modelId.toLowerCase();
    const name = displayName.toLowerCase();

    // Embedding models
    if (methods.includes("embedContent") || methods.includes("embedText") ||
        id.includes("embedding") || id.includes("embed")) {
        return "feature-extraction";
    }

    // Video generation (Veo)
    if (capabilities.videoGeneration) {
        return "text-to-video";
    }

    // Audio/Music generation (Lyria)
    if (id.includes("lyria") || name.includes("lyria") || name.includes("music")) {
        return "text-to-audio";
    }

    // Image generation (Nano Banana)
    if (capabilities.imageGeneration) {
        return "text-to-image";
    }

    // TTS
    if (capabilities.audioGeneration) {
        return "text-to-speech";
    }

    // Live/Realtime
    if (capabilities.liveApi) {
        return "conversational";
    }

    return "text-generation";
}

// =============================================================================
// Image Generation (Nano Banana / Nano Banana Pro)
// =============================================================================

/**
 * Generate image using Gemini image models (Nano Banana)
 * 
 * Uses generateContent() with responseModalities: ["IMAGE", "TEXT"]
 * Response contains inlineData with base64 PNG
 * 
 * Models:
 * - gemini-2.5-flash-image (Nano Banana - stable)
 * - gemini-3-pro-image-preview (Nano Banana Pro - preview)
 * 
 * @see https://ai.google.dev/gemini-api/docs/image-generation
 */
export async function generateImage(
    modelId: string,
    prompt: string,
    options?: {
        referenceImages?: Buffer[];
        aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
        numberOfImages?: number;
        outputMimeType?: "image/png" | "image/jpeg" | "image/webp";
    }
): Promise<{
    buffer: Buffer;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        billingMetrics?: Record<string, unknown>;
    };
}> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating image with model: ${cleanModelId}`);

    try {
        // Build content parts
        const parts: Part[] = [{ text: prompt }];

        // Add reference images if provided (for image editing / multi-image reference)
        if (options?.referenceImages) {
            for (const imageBuffer of options.referenceImages) {
                parts.push({
                    inlineData: {
                        data: imageBuffer.toString("base64"),
                        mimeType: "image/png",
                    },
                });
            }
        }

        const response = await client.models.generateContent({
            model: cleanModelId,
            contents: [{ role: "user", parts }],
            config: {
                // CRITICAL: Must specify IMAGE in responseModalities
                responseModalities: ["IMAGE", "TEXT"],
                ...(options?.aspectRatio && { aspectRatio: options.aspectRatio }),
                ...(options?.numberOfImages && { numberOfImages: options.numberOfImages }),
                ...(options?.outputMimeType && { outputMimeType: options.outputMimeType }),
            },
        }) as GenerateContentResponse;

        const usage = normalizeUsageMetadata(response.usageMetadata);

        // Extract image from response
        const candidates = response.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error("No candidates in response");
        }

        const parts2 = candidates[0]?.content?.parts;
        if (!parts2 || parts2.length === 0) {
            throw new Error("No content parts in response");
        }

        // Find the inline data part (base64 image)
        for (const part of parts2) {
            if ("inlineData" in part && part.inlineData?.data) {
                return {
                    buffer: Buffer.from(part.inlineData.data, "base64"),
                    ...(usage ? { usage } : {}),
                };
            }
        }

        // Check for text response (model may return text describing why it couldn't generate)
        const textPart = parts2.find(p => "text" in p);
        if (textPart && "text" in textPart) {
            throw new Error(`Model returned text instead of image: ${textPart.text?.substring(0, 200)}`);
        }

        throw new Error("No image data in response");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
            throw new Error(`Access denied for model "${cleanModelId}". Verify API key permissions.`);
        }
        if (message.includes("not found") || message.includes("404")) {
            throw new Error(`Model "${cleanModelId}" not found. Check model availability.`);
        }
        if (message.includes("SAFETY") || message.includes("blocked")) {
            throw new Error(`Content blocked by safety filters. Try a different prompt.`);
        }

        throw new Error(`Image generation failed: ${message}`);
    }
}

/**
 * Stream Gemini image generation through `generateContentStream()`.
 *
 * Gemini's native image-generation docs do not advertise a dedicated
 * `partial_image` event taxonomy like OpenAI. Instead, `streamGenerateContent`
 * yields ordinary `GenerateContentResponse` chunks whose `candidates[0].content.parts`
 * may contain:
 *   - `text` parts flagged with `thought: true` (reasoning / thought summaries)
 *   - one or more `inlineData` image parts
 *
 * We surface these as the universal stream contract:
 *   - every `thought` text part delta => `{ type: "thinking", ... }`
 *   - every inlineData image prior to the terminal one => `image-partial`
 *   - the last inlineData observed when the stream ends => `image-complete`
 *
 * This is intentionally provider-native and zero-heuristic on model names.
 * It simply reflects the sequence of parts Google emits for the chosen model.
 */
export async function* streamImage(
    modelId: string,
    prompt: string,
    options?: {
        referenceImages?: Buffer[];
        aspectRatio?: string;
        numberOfImages?: number;
        outputMimeType?: string;
        includeThoughts?: boolean;
    }
): AsyncGenerator<
    | { type: "thinking"; text: string }
    | { type: "image-partial"; base64: string; mimeType?: string; index: number }
    | { type: "image-complete"; base64: string; mimeType?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics?: Record<string, unknown> } }
> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    const parts: Part[] = [{ text: prompt }];
    if (options?.referenceImages) {
        for (const imageBuffer of options.referenceImages) {
            parts.push({
                inlineData: {
                    data: imageBuffer.toString("base64"),
                    mimeType: "image/png",
                },
            });
        }
    }

    const stream = await client.models.generateContentStream({
        model: cleanModelId,
        contents: [{ role: "user", parts }],
        config: {
            responseModalities: ["IMAGE", "TEXT"],
            ...(options?.aspectRatio && { aspectRatio: options.aspectRatio as any }),
            ...(options?.numberOfImages && { numberOfImages: options.numberOfImages }),
            ...(options?.outputMimeType && { outputMimeType: options.outputMimeType as any }),
            ...(typeof options?.includeThoughts === "boolean" ? { includeThoughts: options.includeThoughts } : {}),
        },
    });

    let imageIndex = 0;
    let lastImage: { base64: string; mimeType?: string } | null = null;
    let usage = undefined as ReturnType<typeof normalizeUsageMetadata>;

    for await (const chunk of stream) {
        usage = normalizeUsageMetadata((chunk as GenerateContentResponse).usageMetadata) ?? usage;
        const candidate = chunk.candidates?.[0];
        const parts2 = candidate?.content?.parts;
        if (!parts2 || parts2.length === 0) continue;

        for (const part of parts2) {
            if ((part as { text?: unknown }).text && (part as { thought?: boolean }).thought) {
                const text = (part as { text: string }).text;
                if (text) {
                    yield { type: "thinking", text };
                }
            }

            if ("inlineData" in part && part.inlineData?.data) {
                const current = {
                    base64: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                };
                if (lastImage) {
                    yield {
                        type: "image-partial",
                        base64: lastImage.base64,
                        mimeType: lastImage.mimeType,
                        index: imageIndex,
                    };
                    imageIndex += 1;
                }
                lastImage = current;
            }
        }
    }

    if (!lastImage) {
        throw new Error(`Gemini image stream returned no inline image parts for model ${cleanModelId}`);
    }

    yield {
        type: "image-complete",
        base64: lastImage.base64,
        mimeType: lastImage.mimeType,
        ...(usage ? { usage } : {}),
    };
}

// =============================================================================
// Video Generation (Veo)
// =============================================================================

/**
 * Generate video using Google Veo models
 * 
 * Uses generateVideos() which returns a long-running operation.
 * We poll for completion and download the video file.
 * 
 * Models:
 * - veo-3.1-generate-preview (latest, with native audio)
 * - veo-3.1-fast-generate-preview (faster, with audio)
 * - veo-3.0-generate-001 (stable)
 * - veo-2.0-generate-001 (legacy)
 * 
 * @see https://ai.google.dev/gemini-api/docs/video
 */
export async function generateVideo(
    modelId: string,
    prompt: string,
    options?: {
        duration?: number;
        aspectRatio?: "16:9" | "9:16";
        resolution?: "720p" | "1080p";
        referenceImage?: Buffer;
        firstFrame?: Buffer;
        lastFrame?: Buffer;
        negativePrompt?: string;
    }
): Promise<{ videoBuffer: Buffer; mimeType: string }> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating video with model: ${cleanModelId}`);

    try {
        // Start the video generation operation using the SDK
        // The SDK accepts model and prompt as primary parameters
        let operation = await client.models.generateVideos({
            model: cleanModelId,
            prompt,
            config: {
                ...(options?.aspectRatio && { aspectRatio: options.aspectRatio }),
                ...(options?.duration && { durationSeconds: options.duration }),
                ...(options?.resolution && { resolution: options.resolution }),
                ...(options?.negativePrompt && { negativePrompt: options.negativePrompt }),
            },
            ...(options?.referenceImage && {
                image: {
                    imageBytes: options.referenceImage.toString("base64"),
                    mimeType: "image/png" as const,
                },
            }),
        });

        // Poll for completion (max 10 minutes for video)
        const maxWaitMs = 10 * 60 * 1000;
        const pollIntervalMs = 10000;
        const startTime = Date.now();

        while (!operation.done && (Date.now() - startTime) < maxWaitMs) {
            console.log(`[genai] Waiting for video generation... (${Math.round((Date.now() - startTime) / 1000)}s)`);
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            operation = await client.operations.getVideosOperation({ operation });
        }

        if (!operation.done) {
            throw new Error("Video generation timed out after 10 minutes");
        }

        // Check for errors
        if (operation.error) {
            throw new Error(`Video generation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
        }

        // Extract video from response
        const generatedVideo = operation.response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
            throw new Error("No video generated in response");
        }

        // Download the video file using the SDK
        console.log(`[genai] Downloading generated video...`);
        await client.files.download({
            file: generatedVideo.video,
            downloadPath: ""
        });

        // The video object should now have the data - read from temp file or buffer
        // The SDK saves to a temp location, we need to read it
        if (generatedVideo.video.uri) {
            // URI is a Google Cloud Storage path, download via HTTP
            const videoResponse = await fetch(generatedVideo.video.uri);
            if (!videoResponse.ok) {
                throw new Error(`Failed to download video from URI: ${videoResponse.status}`);
            }
            const arrayBuffer = await videoResponse.arrayBuffer();
            return {
                videoBuffer: Buffer.from(arrayBuffer),
                mimeType: generatedVideo.video.mimeType || "video/mp4",
            };
        }

        throw new Error("Video response format not recognized - no URI available");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
            throw new Error(`Access denied for video model "${cleanModelId}". Verify API permissions.`);
        }
        if (message.includes("not found") || message.includes("404")) {
            throw new Error(`Video model "${cleanModelId}" not found.`);
        }
        if (message.includes("not supported")) {
            throw new Error(`Model "${cleanModelId}" does not support video generation.`);
        }
        if (message.includes("SAFETY") || message.includes("blocked")) {
            throw new Error(`Video content blocked by safety filters. Try a different prompt.`);
        }

        throw new Error(`Video generation failed: ${message}`);
    }
}

// =============================================================================
// Text-to-Speech (TTS Models)
// =============================================================================

/**
 * Generate speech using Google TTS models
 * 
 * Uses generateContent() with responseModalities: ["AUDIO"] and speechConfig
 * 
 * Models:
 * - gemini-2.5-flash-preview-tts
 * - gemini-2.5-pro-preview-tts
 * 
 * @see https://ai.google.dev/gemini-api/docs/speech-generation
 */
export async function generateSpeech(
    modelId: string,
    text: string,
    options?: {
        voice?: string;
        languageCode?: string;
    }
): Promise<{
    buffer: Buffer;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        billingMetrics?: Record<string, unknown>;
    };
}> {
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating speech with model: ${cleanModelId}`);

    const endpoint = `${BASE_URL}/v1beta/models/${cleanModelId}:generateContent?key=${GOOGLE_API_KEY}`;

    const requestBody = {
        contents: [{
            parts: [{ text }]
        }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
                ...(options?.voice && { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } }),
                ...(options?.languageCode && { languageCode: options.languageCode }),
            },
        },
    };

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`TTS failed (${response.status}): ${errorText}`);
        }

        interface TTSResponsePart {
            inlineData?: { data: string; mimeType: string };
        }

        const data = await response.json() as {
            candidates?: Array<{
                content?: {
                    parts?: TTSResponsePart[];
                };
            }>;
        };

        const usage = normalizeUsageMetadata((data as { usageMetadata?: unknown }).usageMetadata);

        const audioPart = data.candidates?.[0]?.content?.parts?.find(
            (p: TTSResponsePart) => p.inlineData
        );

        if (audioPart?.inlineData?.data) {
            return {
                buffer: Buffer.from(audioPart.inlineData.data, "base64"),
                ...(usage ? { usage } : {}),
            };
        }

        throw new Error("No audio in TTS response");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`TTS generation failed: ${message}`);
    }
}

// =============================================================================
// Built-in Tools: Google Search Grounding
// =============================================================================

/**
 * Generate content with Google Search grounding
 * 
 * Enables real-time information from Google Search
 * 
 * @see https://ai.google.dev/gemini-api/docs/google-search
 */
export async function generateWithSearchGrounding(
    modelId: string,
    prompt: string,
    options?: {
        systemInstruction?: string;
        dynamicThreshold?: number;
    }
): Promise<{
    text: string;
    groundingMetadata?: {
        searchEntryPoint?: { renderedContent: string };
        groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
        groundingSupports?: Array<{ segment: { text: string }; groundingChunkIndices: number[] }>;
    };
}> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating with search grounding: ${cleanModelId}`);

    try {
        const response = await client.models.generateContent({
            model: cleanModelId,
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
                ...(options?.systemInstruction && { systemInstruction: options.systemInstruction }),
            },
        }) as GenerateContentResponse & {
            candidates?: Array<{
                groundingMetadata?: {
                    searchEntryPoint?: { renderedContent: string };
                    groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
                    groundingSupports?: Array<{ segment: { text: string }; groundingChunkIndices: number[] }>;
                };
            }>;
        };

        const text = response.candidates?.[0]?.content?.parts
            ?.filter((p): p is { text: string } => "text" in p)
            .map(p => p.text)
            .join("") || "";

        return {
            text,
            groundingMetadata: response.candidates?.[0]?.groundingMetadata,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Search grounding failed: ${message}`);
    }
}

// =============================================================================
// Built-in Tools: Code Execution
// =============================================================================

/**
 * Generate content with code execution enabled
 * 
 * The model can write and execute Python code to solve problems
 * 
 * @see https://ai.google.dev/gemini-api/docs/code-execution
 */
export async function generateWithCodeExecution(
    modelId: string,
    prompt: string,
    options?: {
        systemInstruction?: string;
    }
): Promise<{
    text: string;
    codeExecutionResult?: {
        code: string;
        output: string;
    };
}> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating with code execution: ${cleanModelId}`);

    try {
        const response = await client.models.generateContent({
            model: cleanModelId,
            contents: prompt,
            config: {
                tools: [{ codeExecution: {} }],
                ...(options?.systemInstruction && { systemInstruction: options.systemInstruction }),
            },
        }) as GenerateContentResponse;

        let text = "";
        let codeExecutionResult: { code: string; output: string } | undefined;

        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            if ("text" in part && part.text) {
                text += part.text;
            }
            if ("executableCode" in part) {
                const execCode = part as { executableCode?: { code: string } };
                if (execCode.executableCode?.code) {
                    codeExecutionResult = {
                        code: execCode.executableCode.code,
                        output: "",
                    };
                }
            }
            if ("codeExecutionResult" in part) {
                const execResult = part as { codeExecutionResult?: { output: string } };
                if (execResult.codeExecutionResult?.output) {
                    if (codeExecutionResult) {
                        codeExecutionResult.output = execResult.codeExecutionResult.output;
                    } else {
                        codeExecutionResult = {
                            code: "",
                            output: execResult.codeExecutionResult.output,
                        };
                    }
                }
            }
        }

        return { text, codeExecutionResult };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Code execution failed: ${message}`);
    }
}

// =============================================================================
// Built-in Tools: URL Context
// =============================================================================

/**
 * Generate content with URL context
 * 
 * The model can access and analyze content from provided URLs
 * 
 * @see https://ai.google.dev/gemini-api/docs/url-context
 */
export async function generateWithUrlContext(
    modelId: string,
    prompt: string,
    urls: string[],
    options?: {
        systemInstruction?: string;
    }
): Promise<{
    text: string;
    urlMetadata?: Array<{ url: string; status: string }>;
}> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating with URL context: ${cleanModelId}, URLs: ${urls.length}`);

    try {
        const response = await client.models.generateContent({
            model: cleanModelId,
            contents: prompt,
            config: {
                tools: [{ urlContext: { urls } }],
                ...(options?.systemInstruction && { systemInstruction: options.systemInstruction }),
            },
        }) as GenerateContentResponse & {
            candidates?: Array<{
                urlContextMetadata?: {
                    urlMetadata?: Array<{ url: string; status: string }>;
                };
            }>;
        };

        const text = response.candidates?.[0]?.content?.parts
            ?.filter((p): p is { text: string } => "text" in p)
            .map(p => p.text)
            .join("") || "";

        return {
            text,
            urlMetadata: response.candidates?.[0]?.urlContextMetadata?.urlMetadata,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`URL context generation failed: ${message}`);
    }
}

// =============================================================================
// Built-in Tools: Google Maps Grounding
// =============================================================================

/**
 * Generate content with Google Maps grounding
 * 
 * Ground responses in rich, real-world data from Google Maps
 * Provides factually accurate, location-aware answers with place data
 * 
 * @see https://ai.google.dev/gemini-api/docs/maps-grounding
 */
export async function generateWithMapsGrounding(
    modelId: string,
    prompt: string,
    options?: {
        systemInstruction?: string;
    }
): Promise<{
    text: string;
    groundingMetadata?: {
        groundingChunks?: Array<{
            maps?: {
                uri: string;
                title: string;
                placeId?: string;
            };
        }>;
        groundingSupports?: Array<{
            segment: { text: string };
            groundingChunkIndices: number[];
        }>;
        contextToken?: string;
    };
}> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating with Maps grounding: ${cleanModelId}`);

    try {
        const response = await client.models.generateContent({
            model: cleanModelId,
            contents: prompt,
            config: {
                tools: [{ googleMaps: {} }],
                ...(options?.systemInstruction && { systemInstruction: options.systemInstruction }),
            },
        }) as GenerateContentResponse & {
            candidates?: Array<{
                groundingMetadata?: {
                    groundingChunks?: Array<{
                        maps?: {
                            uri: string;
                            title: string;
                            placeId?: string;
                        };
                    }>;
                    groundingSupports?: Array<{
                        segment: { text: string };
                        groundingChunkIndices: number[];
                    }>;
                    contextToken?: string;
                };
            }>;
        };

        const text = response.candidates?.[0]?.content?.parts
            ?.filter((p): p is { text: string } => "text" in p)
            .map(p => p.text)
            .join("") || "";

        return {
            text,
            groundingMetadata: response.candidates?.[0]?.groundingMetadata,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Maps grounding failed: ${message}`);
    }
}

// =============================================================================
// Deep Research Agent (Interactions API)
// =============================================================================

/**
 * Start a deep research task using the Interactions API
 * 
 * The Deep Research agent autonomously plans, executes, and synthesizes research
 * 
 * @see https://ai.google.dev/gemini-api/docs/deep-research
 */
export async function startDeepResearch(
    prompt: string,
    options?: {
        background?: boolean;
        files?: string[];
        steerability?: {
            tone?: string;
            format?: string;
            length?: string;
        };
    }
): Promise<{
    interactionId: string;
    status: string;
    result?: string;
}> {
    console.log(`[genai] Starting deep research...`);

    const endpoint = `${BASE_URL}/v1beta/interactions?key=${GOOGLE_API_KEY}`;

    const requestBody: Record<string, unknown> = {
        input: prompt,
        agent: "deep-research-pro-preview-12-2025",
        background: options?.background ?? true, // Always run in background
    };

    if (options?.files) {
        requestBody.grounding_sources = options.files.map(uri => ({ file: { uri } }));
    }

    if (options?.steerability) {
        requestBody.steerability = options.steerability;
    }

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Deep research failed (${response.status}): ${errorText}`);
        }

        const data = await response.json() as {
            name: string;
            status: string;
            outputs?: Array<{ text?: string }>;
            error?: { message: string };
        };

        return {
            interactionId: data.name,
            status: data.status,
            result: data.outputs?.[data.outputs.length - 1]?.text,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Deep research failed: ${message}`);
    }
}

/**
 * Poll for deep research completion
 */
export async function pollDeepResearch(interactionId: string): Promise<{
    status: string;
    result?: string;
    error?: string;
}> {
    const endpoint = `${BASE_URL}/v1beta/${interactionId}?key=${GOOGLE_API_KEY}`;

    try {
        const response = await fetch(endpoint);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to poll research (${response.status}): ${errorText}`);
        }

        const data = await response.json() as {
            status: string;
            outputs?: Array<{ text?: string }>;
            error?: { message: string };
        };

        return {
            status: data.status,
            result: data.outputs?.[data.outputs.length - 1]?.text,
            error: data.error?.message,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Research poll failed: ${message}`);
    }
}

// =============================================================================
// Ephemeral Tokens (for client-side Live API)
// =============================================================================

/**
 * Create an ephemeral token for client-side Live API access
 * 
 * Ephemeral tokens allow secure, time-limited access from browser clients
 * 
 * @see https://ai.google.dev/gemini-api/docs/ephemeral-tokens
 */
export async function createEphemeralToken(
    options?: {
        model?: string;
        expireTimeMinutes?: number;
        newSessionExpireTimeMinutes?: number;
    }
): Promise<{
    token: string;
    expireTime: string;
    newSessionExpireTime: string;
}> {
    const endpoint = `${BASE_URL}/v1beta/ephemeralTokens?key=${GOOGLE_API_KEY}`;

    const requestBody: Record<string, unknown> = {
        config: {
            model: options?.model || "gemini-2.5-flash-preview-native-audio-dialog",
        },
    };

    if (options?.expireTimeMinutes) {
        // Convert to timestamp
        const expireTime = new Date(Date.now() + options.expireTimeMinutes * 60 * 1000);
        requestBody.expireTime = expireTime.toISOString();
    }

    if (options?.newSessionExpireTimeMinutes) {
        const newSessionExpireTime = new Date(Date.now() + options.newSessionExpireTimeMinutes * 60 * 1000);
        requestBody.newSessionExpireTime = newSessionExpireTime.toISOString();
    }

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create ephemeral token (${response.status}): ${errorText}`);
        }

        const data = await response.json() as {
            token: string;
            expireTime: string;
            newSessionExpireTime: string;
        };

        return data;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Ephemeral token creation failed: ${message}`);
    }
}

// =============================================================================
// API Route Handlers
// =============================================================================

/**
 * GET /api/genai/models
 * Returns available Google GenAI models with capabilities
 */
export async function handleGetGoogleModels(_req: Request, res: Response) {
    try {
        const models = await fetchGoogleModels();

        res.json({
            models,
            total: models.length,
            source: "google",
        });
    } catch (error) {
        console.error("[genai] Error fetching models:", error);
        res.status(500).json({
            error: "Failed to fetch Google models",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }
}

/**
 * POST /api/genai/generate
 * Universal generation endpoint for Google models
 */
export async function handleGoogleGenerate(req: Request, res: Response) {
    if (!GOOGLE_API_KEY) {
        return res.status(503).json({
            error: "Google GenAI not configured",
            message: "GOOGLE_GENERATIVE_AI_API_KEY not set",
        });
    }

    const { modelId, prompt, task, options, tools } = req.body;

    if (!modelId) {
        return res.status(400).json({ error: "modelId is required" });
    }
    if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
    }

    try {
        const detectedTask = task || detectTaskFromCapabilities(modelId, "", [], {
            audioGeneration: false,
            imageGeneration: modelId.includes("-image"),
            videoGeneration: modelId.includes("veo"),
            liveApi: false,
            batchApi: false,
            caching: false,
            codeExecution: false,
            fileSearch: false,
            functionCalling: false,
            mapsGrounding: false,
            searchGrounding: false,
            structuredOutputs: false,
            thinking: false,
            urlContext: false,
        });

        // Handle tools
        if (tools?.googleSearch) {
            const result = await generateWithSearchGrounding(modelId, prompt, options);
            return res.json(result);
        }

        if (tools?.codeExecution) {
            const result = await generateWithCodeExecution(modelId, prompt, options);
            return res.json(result);
        }

        if (tools?.urlContext?.urls) {
            const result = await generateWithUrlContext(modelId, prompt, tools.urlContext.urls, options);
            return res.json(result);
        }

        if (tools?.mapsGrounding) {
            const result = await generateWithMapsGrounding(modelId, prompt, options);
            return res.json(result);
        }

        switch (detectedTask) {
            case "text-to-image": {
                const imageBuffer = await generateImage(modelId, prompt, options);
                res.setHeader("Content-Type", "image/png");
                return res.send(imageBuffer);
            }

            case "text-to-video": {
                const result = await generateVideo(modelId, prompt, options);
                res.setHeader("Content-Type", result.mimeType);
                return res.send(result.videoBuffer);
            }

            case "text-to-speech": {
                const speechBuffer = await generateSpeech(modelId, prompt, options);
                res.setHeader("Content-Type", "audio/wav");
                return res.send(speechBuffer);
            }

            default:
                return res.status(400).json({
                    error: "Unsupported task",
                    message: `Task "${detectedTask}" not supported. Use text-to-image, text-to-video, or text-to-speech.`,
                    hint: "For text generation, use the /api/inference endpoint instead.",
                });
        }
    } catch (error) {
        console.error("[genai] Generation error:", error);
        res.status(500).json({
            error: "Generation failed",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }
}

/**
 * POST /api/genai/research
 * Start a deep research task
 */
export async function handleDeepResearch(req: Request, res: Response) {
    if (!GOOGLE_API_KEY) {
        return res.status(503).json({
            error: "Google GenAI not configured",
            message: "GOOGLE_GENERATIVE_AI_API_KEY not set",
        });
    }

    const { prompt, files, steerability } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
    }

    try {
        const result = await startDeepResearch(prompt, {
            background: true,
            files,
            steerability,
        });

        res.json(result);
    } catch (error) {
        console.error("[genai] Deep research error:", error);
        res.status(500).json({
            error: "Deep research failed",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }
}

/**
 * GET /api/genai/research/:id
 * Poll for deep research status
 */
export async function handlePollResearch(req: Request, res: Response) {
    if (!GOOGLE_API_KEY) {
        return res.status(503).json({
            error: "Google GenAI not configured",
        });
    }

    const interactionIdParam = req.params.id;
    const interactionId = Array.isArray(interactionIdParam) ? interactionIdParam[0] : interactionIdParam;
    if (!interactionId) {
        return res.status(400).json({ error: "interaction ID required" });
    }

    try {
        const result = await pollDeepResearch(interactionId);
        res.json(result);
    } catch (error) {
        console.error("[genai] Research poll error:", error);
        res.status(500).json({
            error: "Research poll failed",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }
}

/**
 * POST /api/genai/ephemeral-token
 * Create ephemeral token for Live API
 */
export async function handleCreateEphemeralToken(req: Request, res: Response) {
    if (!GOOGLE_API_KEY) {
        return res.status(503).json({
            error: "Google GenAI not configured",
        });
    }

    try {
        const result = await createEphemeralToken(req.body);
        res.json(result);
    } catch (error) {
        console.error("[genai] Ephemeral token error:", error);
        res.status(500).json({
            error: "Ephemeral token creation failed",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }
}

// =============================================================================
// Exports for use in inference.ts
// =============================================================================

export {
    getClient as getGoogleGenAIClient,
    detectTaskFromCapabilities as detectGoogleModelTask,
};

// =============================================================================
// Google Generative Language wire family
// =============================================================================
//
// Direct-fetch chat / streamChat / embeddings that target the Google REST API
// shape:
//
//   POST {baseURL}/models/{modelId}:generateContent
//   POST {baseURL}/models/{modelId}:streamGenerateContent?alt=sse
//   POST {baseURL}/models/{modelId}:embedContent
//   POST {baseURL}/models/{modelId}:batchEmbedContents
//
// Used by both Gemini (API key auth, baseURL = https://generativelanguage.googleapis.com/v1beta)
// and Vertex AI (Bearer access token auth, baseURL = https://{loc}-aiplatform.googleapis.com/v1/projects/{p}/locations/{loc}/publishers/google).
//
// Owns: contents/parts shape, functionDeclarations tool serialization,
// parts[i].functionCall.thoughtSignature WIRE round-trip (Gemini 3+ requirement),
// usageMetadata → UnifiedUsage with per-modality billing metrics.

import type {
    UnifiedMessage as _UnifiedMessageGoogleWire,
    UnifiedOutput as _UnifiedOutputGoogleWire,
    UnifiedRequest as _UnifiedRequestGoogleWire,
    UnifiedStreamEvent as _UnifiedStreamEventGoogleWire,
    UnifiedTool as _UnifiedToolGoogleWire,
    UnifiedToolCall as _UnifiedToolCallGoogleWire,
    UnifiedToolChoice as _UnifiedToolChoiceGoogleWire,
    UnifiedUsage as _UnifiedUsageGoogleWire,
} from "../../core.js";

export interface GoogleWireEndpoint {
    /** Base URL up to but not including `/models/{modelId}:...`. */
    baseURL: string;
    /** Bearer access token (Vertex) OR API key (Gemini). */
    apiKey: string;
    /** "key" sends ?key=… (Gemini). "bearer" sends Authorization: Bearer (Vertex). */
    authStyle: "key" | "bearer";
    extraHeaders?: Record<string, string>;
}

export interface GoogleWireChatOptions {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    tools?: _UnifiedToolGoogleWire[];
    toolChoice?: _UnifiedToolChoiceGoogleWire;
    responseFormat?: _UnifiedRequestGoogleWire["responseFormat"];
    /** systemInstruction (Google's first-class field). */
    systemInstruction?: string;
    /** Cached signature lookup keyed by toolCallId. Caller owns the cache. */
    thoughtSignatureLookup?: (toolCallId: string) => string | undefined;
    /** Sink for thoughtSignatures observed on the wire. Caller owns the cache. */
    onThoughtSignature?: (toolCallId: string, signature: string) => void;
    customParams?: Record<string, unknown>;
    signal?: AbortSignal;
}

export interface GoogleWireEmbeddingsOptions {
    taskType?: string;
    title?: string;
    outputDimensionality?: number;
    signal?: AbortSignal;
}

function asGoogleRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanGoogle(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function googleEndpointHeaders(endpoint: GoogleWireEndpoint): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.authStyle === "bearer" && endpoint.apiKey) {
        headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
    }
    if (endpoint.extraHeaders) {
        for (const [key, value] of Object.entries(endpoint.extraHeaders)) {
            headers[key] = value;
        }
    }
    return headers;
}

function googleEndpointUrl(endpoint: GoogleWireEndpoint, modelId: string, action: string): string {
    const base = endpoint.baseURL.replace(/\/+$/, "");
    const cleanModel = modelId.replace(/^models\//, "");
    let url = `${base}/models/${cleanModel}:${action}`;
    if (endpoint.authStyle === "key" && endpoint.apiKey) {
        url += (url.includes("?") ? "&" : "?") + `key=${encodeURIComponent(endpoint.apiKey)}`;
    }
    return url;
}

async function readGoogleErrorBody(response: globalThis.Response): Promise<string> {
    try {
        return (await response.text()).slice(0, 1000);
    } catch {
        return response.statusText;
    }
}

// ---------------------------------------------------------------------------
// Message → contents/parts
// ---------------------------------------------------------------------------

function partsFromGoogleContent(content: unknown): Array<Record<string, unknown>> {
    if (typeof content === "string") {
        return content.length > 0 ? [{ text: content }] : [];
    }
    if (!Array.isArray(content)) return [];
    const parts: Array<Record<string, unknown>> = [];
    for (const raw of content) {
        const part = asGoogleRecord(raw);
        if (!part) continue;
        const type = cleanGoogle(part.type);
        if (type === "text" && typeof part.text === "string" && part.text.length > 0) {
            parts.push({ text: part.text });
            continue;
        }
        if (type === "image_url") {
            const value = part.image_url;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) {
                if (/^data:/i.test(url)) {
                    const match = url.match(/^data:([^;,]+)?;base64,(.+)$/i);
                    if (match) {
                        parts.push({ inlineData: { mimeType: match[1] || "image/png", data: match[2] } });
                        continue;
                    }
                }
                parts.push({ fileData: { fileUri: url, mimeType: "image/*" } });
            }
            continue;
        }
        if (type === "input_audio") {
            const value = part.input_audio;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) parts.push({ fileData: { fileUri: url, mimeType: "audio/*" } });
            continue;
        }
        if (type === "video_url") {
            const value = part.video_url;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) parts.push({ fileData: { fileUri: url, mimeType: "video/*" } });
            continue;
        }
    }
    return parts;
}

function mapMessagesForGoogleWire(
    messages: _UnifiedMessageGoogleWire[],
    options: { thoughtSignatureLookup?: (toolCallId: string) => string | undefined } = {},
): { systemInstruction: string | null; contents: Array<Record<string, unknown>> } {
    let systemInstruction: string | null = null;
    const contents: Array<Record<string, unknown>> = [];

    for (const message of messages) {
        if (message.role === "system") {
            const text = typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                    ? message.content
                        .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
                        .map((part) => (part as { text?: string }).text)
                        .filter((t): t is string => typeof t === "string")
                        .join("\n")
                    : "";
            systemInstruction = systemInstruction ? `${systemInstruction}\n${text}` : text;
            continue;
        }

        if (message.role === "tool") {
            const text = typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                    ? message.content
                        .map((part) => {
                            const record = asGoogleRecord(part);
                            return record?.type === "text" && typeof record.text === "string" ? record.text : "";
                        })
                        .filter(Boolean)
                        .join("\n")
                    : "";
            const callIdent = cleanGoogle(message.name) || cleanGoogle(message.tool_call_id) || "tool";
            let response: unknown;
            try {
                response = JSON.parse(text);
            } catch {
                response = { result: text };
            }
            contents.push({
                role: "user",
                parts: [{
                    functionResponse: {
                        name: callIdent,
                        response: typeof response === "object" && response !== null ? response : { result: response },
                    },
                }],
            });
            continue;
        }

        if (message.role === "assistant") {
            const parts: Array<Record<string, unknown>> = [];
            if (typeof message.content === "string" && message.content.length > 0) {
                parts.push({ text: message.content });
            } else if (Array.isArray(message.content)) {
                for (const p of partsFromGoogleContent(message.content)) parts.push(p);
            }
            if (Array.isArray(message.tool_calls)) {
                for (const call of message.tool_calls) {
                    let args: unknown = {};
                    try {
                        args = JSON.parse(call.function.arguments || "{}");
                    } catch {
                        args = {};
                    }
                    const fn: Record<string, unknown> = { name: call.function.name, args };
                    const sig = options.thoughtSignatureLookup?.(call.id);
                    if (sig) fn.thoughtSignature = sig;
                    parts.push({ functionCall: fn });
                }
            }
            if (parts.length > 0) contents.push({ role: "model", parts });
            continue;
        }

        const parts = partsFromGoogleContent(message.content);
        if (parts.length > 0) contents.push({ role: "user", parts });
    }

    return { systemInstruction, contents };
}

function googleToolsToWire(tools: _UnifiedToolGoogleWire[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    const declarations: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
        if (tool.type !== "function" || !tool.function?.name) continue;
        declarations.push({
            name: tool.function.name,
            ...(tool.function.description ? { description: tool.function.description } : {}),
            ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
        });
    }
    if (declarations.length === 0) return undefined;
    return [{ functionDeclarations: declarations }];
}

function googleToolConfigToWire(toolChoice: _UnifiedToolChoiceGoogleWire | undefined): Record<string, unknown> | undefined {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") {
        if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
        if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
        return { functionCallingConfig: { mode: "AUTO" } };
    }
    if (toolChoice.type === "function" && toolChoice.function?.name) {
        return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.function.name] } };
    }
    return undefined;
}

function generationConfigFromGoogleOptions(opts: GoogleWireChatOptions | undefined): Record<string, unknown> | undefined {
    if (!opts) return undefined;
    const cfg: Record<string, unknown> = {};
    if (typeof opts.temperature === "number") cfg.temperature = opts.temperature;
    if (typeof opts.maxTokens === "number") cfg.maxOutputTokens = opts.maxTokens;
    if (typeof opts.topP === "number") cfg.topP = opts.topP;
    if (typeof opts.topK === "number") cfg.topK = opts.topK;
    if (opts.responseFormat) {
        if (opts.responseFormat.type === "json_object") {
            cfg.responseMimeType = "application/json";
        } else if (opts.responseFormat.type === "json_schema" && opts.responseFormat.json_schema?.schema) {
            cfg.responseMimeType = "application/json";
            cfg.responseSchema = opts.responseFormat.json_schema.schema;
        }
    }
    if (opts.customParams) {
        for (const [key, value] of Object.entries(opts.customParams)) {
            if (value !== undefined && cfg[key] === undefined) cfg[key] = value;
        }
    }
    return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function readNonNegGoogle(record: Record<string, unknown> | null | undefined, keys: readonly string[]): number | undefined {
    if (!record) return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
}

export function usageFromGoogleWire(rawUsage: unknown): _UnifiedUsageGoogleWire | undefined {
    const usage = asGoogleRecord(rawUsage);
    if (!usage) return undefined;
    const promptTokens = readNonNegGoogle(usage, ["promptTokenCount"]) ?? 0;
    const candidateTokens = readNonNegGoogle(usage, ["candidatesTokenCount", "responseTokenCount"]) ?? 0;
    const reasoningTokens = readNonNegGoogle(usage, ["thoughtsTokenCount"]);
    const totalTokens = readNonNegGoogle(usage, ["totalTokenCount"]) ?? promptTokens + candidateTokens + (reasoningTokens ?? 0);
    const completionTokens = candidateTokens + (reasoningTokens ?? 0);

    const billingMetrics: Record<string, unknown> = {};
    const assignModalityMetrics = (details: unknown, prefix: "input" | "output" | "cached_input") => {
        if (!Array.isArray(details)) return;
        for (const entry of details) {
            const record = asGoogleRecord(entry);
            const tokenCount = readNonNegGoogle(record ?? undefined, ["tokenCount"]);
            if (typeof tokenCount !== "number" || tokenCount <= 0) continue;
            const modality = cleanGoogle(record?.modality).toLowerCase();
            if (!modality) continue;
            billingMetrics[`${prefix}_${modality}_tokens`] = tokenCount;
        }
    };
    assignModalityMetrics(usage.promptTokensDetails, "input");
    assignModalityMetrics(usage.responseTokensDetails ?? usage.candidatesTokensDetails, "output");
    assignModalityMetrics(usage.cacheTokensDetails, "cached_input");
    if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
        billingMetrics.reasoning_tokens = reasoningTokens;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        raw: usage,
    };
}

function finishReasonFromGoogleWire(value: unknown, hadToolCalls: boolean): string {
    const raw = cleanGoogle(value).toUpperCase();
    if (raw === "MAX_TOKENS") return "length";
    if (raw === "SAFETY" || raw === "RECITATION") return "content-filter";
    if (raw === "STOP" && hadToolCalls) return "tool-calls";
    if (raw === "STOP") return "stop";
    if (!raw && hadToolCalls) return "tool-calls";
    return "stop";
}

function buildGoogleBody(
    messages: _UnifiedMessageGoogleWire[],
    opts?: GoogleWireChatOptions,
): Record<string, unknown> {
    const { systemInstruction, contents } = mapMessagesForGoogleWire(messages, {
        thoughtSignatureLookup: opts?.thoughtSignatureLookup,
    });
    const tools = googleToolsToWire(opts?.tools);
    const toolConfig = googleToolConfigToWire(opts?.toolChoice);
    const generationConfig = generationConfigFromGoogleOptions(opts);

    const body: Record<string, unknown> = { contents };
    const sysText = (opts?.systemInstruction || "")
        + (opts?.systemInstruction && systemInstruction ? "\n" : "")
        + (systemInstruction || "");
    if (sysText) body.systemInstruction = { role: "system", parts: [{ text: sysText }] };
    if (tools) body.tools = tools;
    if (toolConfig) body.toolConfig = toolConfig;
    if (generationConfig) body.generationConfig = generationConfig;
    return body;
}

function extractToolCallsAndCaptureSignatures(
    candidate: Record<string, unknown> | null,
    onSignature?: (toolCallId: string, signature: string) => void,
): { text: string; toolCalls: _UnifiedToolCallGoogleWire[] } {
    let text = "";
    const toolCalls: _UnifiedToolCallGoogleWire[] = [];
    const content = asGoogleRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content!.parts : [];
    let toolCallIndex = 0;
    for (const part of parts) {
        const record = asGoogleRecord(part);
        if (!record) continue;
        if (typeof record.text === "string") {
            text += record.text;
            continue;
        }
        const fc = asGoogleRecord(record.functionCall);
        if (fc) {
            const id = `gemini_call_${toolCallIndex}_${Date.now().toString(36)}`;
            const name = cleanGoogle(fc.name);
            const args = fc.args !== undefined ? fc.args : {};
            const sig = cleanGoogle(fc.thoughtSignature);
            if (sig && onSignature) onSignature(id, sig);
            toolCalls.push({
                id,
                name,
                arguments: typeof args === "string" ? args : JSON.stringify(args),
            });
            toolCallIndex += 1;
        }
    }
    return { text, toolCalls };
}

// ---------------------------------------------------------------------------
// chat (non-streaming)
// ---------------------------------------------------------------------------

export async function chat(
    endpoint: GoogleWireEndpoint,
    modelId: string,
    messages: _UnifiedMessageGoogleWire[],
    opts?: GoogleWireChatOptions,
): Promise<_UnifiedOutputGoogleWire> {
    const url = googleEndpointUrl(endpoint, modelId, "generateContent");
    const headers = googleEndpointHeaders(endpoint);
    const body = buildGoogleBody(messages, opts);

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok) {
        throw new Error(`Google-genai chat HTTP ${response.status}: ${await readGoogleErrorBody(response)}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const first = asGoogleRecord(candidates[0]);
    const { text, toolCalls } = extractToolCallsAndCaptureSignatures(first, opts?.onThoughtSignature);
    const usage = usageFromGoogleWire(data.usageMetadata);
    return {
        modality: "text",
        content: text,
        usage,
        finishReason: finishReasonFromGoogleWire(first?.finishReason, toolCalls.length > 0),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
}

// ---------------------------------------------------------------------------
// streamChat (SSE)
// ---------------------------------------------------------------------------

export async function* streamChat(
    endpoint: GoogleWireEndpoint,
    modelId: string,
    messages: _UnifiedMessageGoogleWire[],
    opts?: GoogleWireChatOptions,
): AsyncGenerator<_UnifiedStreamEventGoogleWire> {
    const baseUrl = googleEndpointUrl(endpoint, modelId, "streamGenerateContent");
    const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "alt=sse";
    const headers = googleEndpointHeaders(endpoint);
    const body = buildGoogleBody(messages, opts);

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok || !response.body) {
        throw new Error(`Google-genai stream HTTP ${response.status}: ${await readGoogleErrorBody(response)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage: _UnifiedUsageGoogleWire | undefined;
    let lastFinishReason: string | undefined;
    let toolCallIndex = 0;
    let sawToolCall = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            while (true) {
                const sep = buffer.indexOf("\n\n");
                if (sep === -1) break;
                const raw = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const dataLines = raw
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart());
                if (dataLines.length === 0) continue;
                const data = dataLines.join("\n").trim();
                if (!data) continue;

                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(data) as Record<string, unknown>;
                } catch {
                    continue;
                }

                if (parsed.usageMetadata) {
                    const u = usageFromGoogleWire(parsed.usageMetadata);
                    if (u) lastUsage = u;
                }

                const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
                const candidate = asGoogleRecord(candidates[0]);
                if (!candidate) continue;
                const content = asGoogleRecord(candidate.content);
                const parts = Array.isArray(content?.parts) ? content!.parts : [];
                for (const part of parts) {
                    const record = asGoogleRecord(part);
                    if (!record) continue;
                    if (record.thought === true && typeof record.text === "string" && record.text.length > 0) {
                        yield { type: "thinking", thinking: record.text };
                        continue;
                    }
                    if (typeof record.text === "string" && record.text.length > 0) {
                        yield { type: "text-delta", text: record.text };
                        continue;
                    }
                    const fc = asGoogleRecord(record.functionCall);
                    if (fc) {
                        const id = `gemini_call_${toolCallIndex}_${Date.now().toString(36)}`;
                        const name = cleanGoogle(fc.name);
                        const args = fc.args !== undefined ? fc.args : {};
                        const sig = cleanGoogle(fc.thoughtSignature);
                        if (sig && opts?.onThoughtSignature) opts.onThoughtSignature(id, sig);
                        const argString = typeof args === "string" ? args : JSON.stringify(args);
                        sawToolCall = true;
                        yield {
                            type: "tool-call",
                            toolCall: { id, name, arguments: argString },
                        };
                        toolCallIndex += 1;
                    }
                }
                const fr = cleanGoogle(candidate.finishReason);
                if (fr) lastFinishReason = fr;
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* best-effort */ }
    }

    yield {
        type: "done",
        finishReason: finishReasonFromGoogleWire(lastFinishReason, sawToolCall),
        usage: lastUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
}

// ---------------------------------------------------------------------------
// embeddings
// ---------------------------------------------------------------------------

export interface GoogleWireEmbeddingsResult {
    embeddings: number[][];
    usage?: _UnifiedUsageGoogleWire;
    raw: unknown;
}

export async function embeddings(
    endpoint: GoogleWireEndpoint,
    modelId: string,
    input: string[] | string,
    opts?: GoogleWireEmbeddingsOptions,
): Promise<GoogleWireEmbeddingsResult> {
    const inputs = Array.isArray(input) ? input : [input];
    const useBatch = inputs.length > 1;
    const url = googleEndpointUrl(endpoint, modelId, useBatch ? "batchEmbedContents" : "embedContent");
    const headers = googleEndpointHeaders(endpoint);

    const requestPart = (text: string): Record<string, unknown> => ({
        model: `models/${modelId.replace(/^models\//, "")}`,
        content: { parts: [{ text }] },
        ...(opts?.taskType ? { taskType: opts.taskType } : {}),
        ...(opts?.title ? { title: opts.title } : {}),
        ...(typeof opts?.outputDimensionality === "number" ? { outputDimensionality: opts.outputDimensionality } : {}),
    });

    const body: Record<string, unknown> = useBatch
        ? { requests: inputs.map(requestPart) }
        : requestPart(inputs[0] || "");

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok) {
        throw new Error(`Google-genai embeddings HTTP ${response.status}: ${await readGoogleErrorBody(response)}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const out: number[][] = [];
    if (useBatch) {
        const arr = Array.isArray(data.embeddings) ? data.embeddings : [];
        for (const item of arr) {
            const record = asGoogleRecord(item);
            const values = record?.values;
            if (Array.isArray(values) && values.every((v) => typeof v === "number")) {
                out.push(values as number[]);
            }
        }
    } else {
        const record = asGoogleRecord(data.embedding);
        const values = record?.values;
        if (Array.isArray(values) && values.every((v) => typeof v === "number")) {
            out.push(values as number[]);
        }
    }
    return {
        embeddings: out,
        usage: usageFromGoogleWire(data.usageMetadata),
        raw: data,
    };
}

// ---------------------------------------------------------------------------
// Endpoint constructors
// ---------------------------------------------------------------------------

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export function geminiEndpoint(): GoogleWireEndpoint {
    return {
        baseURL: GEMINI_BASE_URL,
        apiKey: GOOGLE_API_KEY || "",
        authStyle: "key",
    };
}

export function vertexEndpoint(args: { projectId: string; location?: string; accessToken: string }): GoogleWireEndpoint {
    const loc = args.location || "us-central1";
    return {
        baseURL: `https://${loc}-aiplatform.googleapis.com/v1/projects/${args.projectId}/locations/${loc}/publishers/google`,
        apiKey: args.accessToken,
        authStyle: "bearer",
    };
}
