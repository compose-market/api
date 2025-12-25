/**
 * Google GenAI Inference Handler
 * 
 * Comprehensive handler for Google Generative AI models:
 * - Gemini text/chat models (generateContent)
 * - Gemini image models - Nano Banana (generateContent with responseModalities: IMAGE)
 * - Veo video generation (generateVideos with long-running operation)
 * - Lyria music generation (Live Music API via WebSocket - BidiGenerateMusic)
 * - TTS models (generateContent with responseModalities: AUDIO)
 * - Embeddings (embedContent)
 * 
 * API References:
 * - https://ai.google.dev/api/generate-content
 * - https://ai.google.dev/api/live
 * - https://ai.google.dev/api/live_music
 * - https://ai.google.dev/api/interactions-api
 * - https://ai.google.dev/api/batch-api
 * - https://ai.google.dev/api/caching
 * 
 * Uses the @google/genai SDK for native API access.
 */
import type { Request, Response } from "express";
import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";

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

// =============================================================================
// Model Discovery
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
}

/**
 * Fetch all models from Google Generative AI API
 * Dynamically discovers available models with pagination
 * 
 * Per API docs: pageSize max is 1000, use pageToken for next pages
 */
export async function fetchGoogleModels(forceRefresh = false): Promise<GoogleModelInfo[]> {
    if (!GOOGLE_API_KEY) {
        console.warn("[genai] API key not set, skipping model fetch");
        return [];
    }

    try {
        const allModels: GoogleModelInfo[] = [];
        let pageToken: string | undefined;

        // Paginate through ALL models
        do {
            const url = new URL(`${BASE_URL}/v1beta/models`);
            url.searchParams.set("key", GOOGLE_API_KEY);
            url.searchParams.set("pageSize", "1000"); // Max per page

            if (pageToken) {
                url.searchParams.set("pageToken", pageToken);
            }

            const response = await fetch(url.toString());

            if (!response.ok) {
                const error = await response.text();
                console.error("[genai] Failed to fetch models:", error);
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

            // NO filtering by methods - fetch ALL models
            const models: GoogleModelInfo[] = data.models.map((model) => {
                const modelId = model.name.replace("models/", "");
                const methods = model.supportedGenerationMethods || [];

                return {
                    id: modelId,
                    name: modelId,
                    displayName: model.displayName || modelId,
                    description: model.description,
                    inputTokenLimit: model.inputTokenLimit,
                    outputTokenLimit: model.outputTokenLimit,
                    supportedMethods: methods,
                    task: detectTaskFromModel(modelId, model.displayName || "", methods),
                };
            });

            allModels.push(...models);
            pageToken = data.nextPageToken;
        } while (pageToken);

        console.log(`[genai] Fetched ${allModels.length} models`);
        return allModels;
    } catch (error) {
        console.error("[genai] Error fetching models:", error);
        return [];
    }
}


/**
 * Detect task type from model ID, display name, and supported methods
 * Per Google API documentation
 */
function detectTaskFromModel(modelId: string, displayName: string, methods: string[]): string {
    const id = modelId.toLowerCase();
    const name = displayName.toLowerCase();

    // Embedding models (embedContent method)
    if (methods.includes("embedContent") || methods.includes("embedText") ||
        id.includes("embedding") || id.includes("embed")) {
        return "feature-extraction";
    }

    // Video generation (Veo models)
    if (id.includes("veo") || id.startsWith("veo-") || name.includes("veo")) {
        return "text-to-video";
    }

    // Audio/Music generation (Lyria models - Live Music API)
    if (id.includes("lyria") || id.startsWith("lyria-") || name.includes("lyria") ||
        name.includes("music")) {
        return "text-to-audio";
    }

    // Image generation (Nano Banana models)
    // Models: gemini-2.5-flash-image-preview, gemini-2.5-flash-image, gemini-3-pro-image-preview
    if (id.includes("-image") || id.endsWith("-image") || id.includes("-image-") ||
        name.includes("imagen") || name.includes("nano banana")) {
        return "text-to-image";
    }

    // TTS models (gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts)
    if (id.includes("-tts") || id.includes("tts-") || name.includes("text-to-speech")) {
        return "text-to-speech";
    }

    // Native audio dialog models
    if (id.includes("-native-audio") || id.includes("audio-dialog")) {
        return "conversational";
    }

    // Live/Realtime (bidiGenerateContent method)
    if (methods.includes("bidiGenerateContent") || id.includes("-live")) {
        return "conversational";
    }

    return "text-generation";
}

// =============================================================================
// Image Generation (Nano Banana / Nano Banana Pro)
// =============================================================================

/**
 * Generate image using Google Gemini image models
 * 
 * Uses generateContent() with the model's native image generation capability
 * Response contains inlineData with base64 image
 * 
 * Models:
 * - gemini-2.5-flash-image-preview (Nano Banana)
 * - gemini-2.5-flash-image (Nano Banana)
 * - gemini-3-pro-image-preview (Nano Banana Pro)
 */
export async function generateImage(
    modelId: string,
    prompt: string
): Promise<Buffer> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating image with model: ${cleanModelId}`);

    try {
        const response = await client.models.generateContent({
            model: cleanModelId,
            contents: prompt,
        }) as GenerateContentResponse;

        // Extract image from response
        const parts = response.candidates?.[0]?.content?.parts;
        if (!parts || parts.length === 0) {
            throw new Error("No content in response");
        }

        // Find the inline data part (base64 image)
        for (const part of parts) {
            if ("inlineData" in part && part.inlineData?.data) {
                return Buffer.from(part.inlineData.data, "base64");
            }
        }

        // Check for text response (model may return text describing why it couldn't generate)
        const textPart = parts.find(p => "text" in p);
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
 * We poll for completion and return the video URL.
 * 
 * Models:
 * - veo-2.0-generate-001
 * - veo-3.0-generate-preview
 */
export async function generateVideo(
    modelId: string,
    prompt: string,
    options?: {
        duration?: number;
        aspectRatio?: string;
    }
): Promise<{ videoUrl: string; mimeType?: string }> {
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating video with model: ${cleanModelId}`);

    try {
        // Start the video generation operation
        let operation = await client.models.generateVideos({
            model: cleanModelId,
            prompt: prompt,
            config: {
                ...(options?.aspectRatio && { aspectRatio: options.aspectRatio }),
                ...(options?.duration && { durationSeconds: options.duration }),
            },
        });

        // Poll for completion (max 5 minutes)
        const maxWaitMs = 5 * 60 * 1000;
        const pollIntervalMs = 10000;
        const startTime = Date.now();

        while (!operation.done && (Date.now() - startTime) < maxWaitMs) {
            console.log(`[genai] Waiting for video generation... (${Math.round((Date.now() - startTime) / 1000)}s)`);
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            operation = await client.operations.getVideosOperation({ operation });
        }

        if (!operation.done) {
            throw new Error("Video generation timed out after 5 minutes");
        }

        // Extract video from response
        const generatedVideo = operation.response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
            throw new Error("No video generated in response");
        }

        if (generatedVideo.video.uri) {
            return {
                videoUrl: generatedVideo.video.uri,
                mimeType: generatedVideo.video.mimeType || "video/mp4"
            };
        }

        throw new Error("Video response format not recognized");
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

        throw new Error(`Video generation failed: ${message}`);
    }
}

// =============================================================================
// Audio/Music Generation (Lyria - Live Music API)
// =============================================================================

/**
 * Generate audio/music using Google Lyria models
 * 
 * Lyria uses the Live Music API (BidiGenerateMusic) via WebSocket.
 * This is a simplified implementation that uses the REST fallback.
 * 
 * For full real-time streaming, use the WebSocket endpoint:
 * wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic
 * 
 * Models:
 * - lyria-realtime-exp (Live Music model)
 * 
 * Config options per API docs:
 * - temperature: [0.0, 3.0], default 1.1
 * - topK: [1, 1000], default 40
 * - guidance: [0.0, 6.0], default 4.0
 * - bpm: [60, 200]
 * - density: [0.0, 1.0]
 * - brightness: [0.0, 1.0]
 * - scale: C_MAJOR_A_MINOR, D_MAJOR_B_MINOR, etc.
 * - musicGenerationMode: QUALITY, DIVERSITY, VOCALIZATION
 */
export async function generateAudio(
    modelId: string,
    prompt: string,
    options?: {
        duration?: number;
        negativePrompt?: string;
        bpm?: number;
        scale?: string;
        density?: number;
        brightness?: number;
    }
): Promise<Buffer> {
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating audio with model: ${cleanModelId}`);

    // Use REST API with generateContent for audio output
    const endpoint = `${BASE_URL}/v1beta/models/${cleanModelId}:generateContent?key=${GOOGLE_API_KEY}`;

    const requestBody = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            ...(options?.duration && { audioTimestamp: options.duration }),
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

            if (response.status === 404 || errorText.includes("not found")) {
                throw new Error(`Audio model "${cleanModelId}" not available.`);
            }
            if (response.status === 400 && errorText.includes("not supported")) {
                throw new Error(`Model "${cleanModelId}" does not support audio generation.`);
            }
            throw new Error(`Audio generation failed (${response.status}): ${errorText}`);
        }

        interface AudioResponsePart {
            inlineData?: { data: string; mimeType: string };
            fileData?: { fileUri: string; mimeType: string };
        }

        const data = await response.json() as {
            candidates?: Array<{
                content?: {
                    parts?: AudioResponsePart[];
                };
            }>;
            error?: { message: string };
        };

        if (data.error) {
            throw new Error(`Audio generation error: ${data.error.message}`);
        }

        // Extract audio from response
        const audioPart = data.candidates?.[0]?.content?.parts?.find(
            (p: AudioResponsePart) => p.inlineData || p.fileData
        );

        if (audioPart?.inlineData?.data) {
            return Buffer.from(audioPart.inlineData.data, "base64");
        }

        if (audioPart?.fileData?.fileUri) {
            // Download audio from URI
            const audioResponse = await fetch(audioPart.fileData.fileUri);
            if (!audioResponse.ok) {
                throw new Error("Failed to download generated audio");
            }
            const arrayBuffer = await audioResponse.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }

        throw new Error("No audio generated in response");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
            throw new Error(`Access denied for audio model "${cleanModelId}".`);
        }

        throw error;
    }
}

// =============================================================================
// Text-to-Speech (TTS Models)
// =============================================================================

/**
 * Generate speech using Google TTS models
 * 
 * Models:
 * - gemini-2.5-flash-preview-tts
 * - gemini-2.5-pro-preview-tts
 */
export async function generateSpeech(
    modelId: string,
    text: string,
    options?: {
        voice?: string;
        language?: string;
    }
): Promise<Buffer> {
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
                ...(options?.language && { languageCode: options.language }),
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

        const audioPart = data.candidates?.[0]?.content?.parts?.find(
            (p: TTSResponsePart) => p.inlineData
        );

        if (audioPart?.inlineData?.data) {
            return Buffer.from(audioPart.inlineData.data, "base64");
        }

        throw new Error("No audio in TTS response");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`TTS generation failed: ${message}`);
    }
}

// =============================================================================
// Interactions API (for async/background operations)
// =============================================================================

/**
 * Create an interaction using the Interactions API
 * Supports text, image, and audio output modalities
 * 
 * Endpoint: POST /v1beta/interactions
 */
export async function createInteraction(
    modelId: string,
    prompt: string,
    options?: {
        responseModalities?: ("text" | "image" | "audio")[];
        stream?: boolean;
        store?: boolean;
    }
): Promise<{
    id: string;
    status: string;
    outputs: Array<{ type: string; text?: string; data?: string }>;
}> {
    const cleanModelId = modelId.replace("models/", "");

    const endpoint = `${BASE_URL}/v1beta/interactions?key=${GOOGLE_API_KEY}`;

    const requestBody = {
        model: cleanModelId,
        inputs: [{ type: "text", text: prompt }],
        response_modalities: options?.responseModalities || ["text"],
        stream: options?.stream ?? false,
        store: options?.store ?? false,
    };

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Interaction creation failed: ${errorText}`);
    }

    return response.json();
}

// =============================================================================
// API Route Handlers
// =============================================================================

/**
 * GET /api/genai/models
 * Returns available Google GenAI models
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

    const { modelId, prompt, task, options } = req.body;

    if (!modelId) {
        return res.status(400).json({ error: "modelId is required" });
    }
    if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
    }

    try {
        const detectedTask = task || detectTaskFromModel(modelId, "", []);

        switch (detectedTask) {
            case "text-to-image": {
                const imageBuffer = await generateImage(modelId, prompt);
                res.setHeader("Content-Type", "image/png");
                return res.send(imageBuffer);
            }

            case "text-to-video": {
                const result = await generateVideo(modelId, prompt, options);
                return res.json(result);
            }

            case "text-to-audio": {
                const audioBuffer = await generateAudio(modelId, prompt, options);
                res.setHeader("Content-Type", "audio/wav");
                return res.send(audioBuffer);
            }

            case "text-to-speech": {
                const speechBuffer = await generateSpeech(modelId, prompt, options);
                res.setHeader("Content-Type", "audio/wav");
                return res.send(speechBuffer);
            }

            default:
                return res.status(400).json({
                    error: "Unsupported task",
                    message: `Task "${detectedTask}" not supported. Use text-to-image, text-to-video, text-to-audio, or text-to-speech.`,
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

// =============================================================================
// Exports for use in inference.ts
// =============================================================================

export {
    getClient as getGoogleGenAIClient,
    detectTaskFromModel as detectGoogleModelTask,
};
