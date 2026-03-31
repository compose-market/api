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
