/**
 * OpenAI Models Provider
 * 
 * Fetches models dynamically from OpenAI API.
 * 
 * API Reference: https://platform.openai.com/docs/api-reference/models/list
 * Task types are inferred from model ID patterns as the API only returns model metadata.
 */

import { generateImage } from "ai";
import { openai } from "@ai-sdk/openai";

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

    // Video generation (Sora)
    if (id.includes("sora")) {
        return "text-to-video";
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

        // Extract metadata from API - task inferred from model ID
        const models: OpenAIModelInfo[] = data.data.map((model) => ({
            id: model.id,
            name: model.id, // OpenAI API doesn't provide display names
            ownedBy: model.owned_by,
            created: model.created,
            object: model.object,
            task: detectOpenAITask(model.id),
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

// =============================================================================
// Inference Functions - OpenAI-specific API calls
// =============================================================================

/**
 * Generate image using OpenAI DALL-E models
 * 
 * @param modelId - The model ID (dall-e-2, dall-e-3, gpt-image-1, etc.)
 * @param prompt - Text prompt for image generation
 * @param options - Optional parameters (size, quality, etc.)
 * @returns Buffer containing the generated image
 */
export async function openaiGenerateImage(
    modelId: string,
    prompt: string,
    options?: {
        size?: "1024x1024" | "1792x1024" | "1024x1792" | "256x256" | "512x512";
        quality?: "standard" | "hd";
        n?: number;
    }
): Promise<Buffer> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Generating image with ${modelId}: "${prompt.slice(0, 50)}..."`);

    try {
        const result = await generateImage({
            model: openai.image(modelId),
            prompt,
            n: options?.n || 1,
            size: options?.size,
            providerOptions: options?.quality ? {
                openai: { quality: options.quality }
            } : undefined,
        });

        if (!result.images || result.images.length === 0) {
            throw new Error("No image generated");
        }

        const image = result.images[0];

        // Return base64 as buffer
        if (image.base64) {
            return Buffer.from(image.base64, "base64");
        }

        throw new Error("No image data returned");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[openai] Image generation failed:`, message);
        throw new Error(`OpenAI image generation failed: ${message}`);
    }
}

/**
 * Generate video using OpenAI Sora models
 * 
 * API: POST https://api.openai.com/v1/videos
 * Models: sora-2, sora-2-pro
 * 
 * @param modelId - The model ID (sora-2, sora-2-pro)
 * @param prompt - Text prompt for video generation
 * @param options - Optional parameters (duration, resolution, etc.)
 * @returns Object with video buffer and metadata
 */
export async function openaiGenerateVideo(
    modelId: string,
    prompt: string,
    options?: {
        duration?: number; // seconds (5-20)
        resolution?: "720p" | "1080p" | "1792p";
        aspectRatio?: "16:9" | "9:16" | "1:1";
    }
): Promise<{ videoBuffer: Buffer; mimeType: string }> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Generating video with ${modelId}: "${prompt.slice(0, 50)}..."`);

    try {
        // Step 1: Create video generation job
        const createResponse = await fetch("https://api.openai.com/v1/videos", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: modelId,
                prompt,
                duration: options?.duration || 5,
                resolution: options?.resolution || "1080p",
                aspect_ratio: options?.aspectRatio || "16:9",
            }),
        });

        if (!createResponse.ok) {
            const error = await createResponse.json().catch(() => ({ error: { message: createResponse.statusText } }));
            throw new Error((error as { error?: { message?: string } }).error?.message || `API error: ${createResponse.status}`);
        }

        const job = await createResponse.json() as { id: string; status: string };
        console.log(`[openai] Video job created: ${job.id}`);

        // Step 2: Poll for completion
        const maxWaitTime = 5 * 60 * 1000; // 5 minutes max
        const pollInterval = 5000; // 5 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const statusResponse = await fetch(`https://api.openai.com/v1/videos/${job.id}`, {
                headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
            });

            if (!statusResponse.ok) {
                throw new Error(`Failed to check job status: ${statusResponse.status}`);
            }

            const status = await statusResponse.json() as {
                status: string;
                output_url?: string;
                error?: { message: string };
            };

            if (status.status === "completed" && status.output_url) {
                // Step 3: Download the video
                const videoResponse = await fetch(status.output_url);
                if (!videoResponse.ok) {
                    throw new Error(`Failed to download video: ${videoResponse.status}`);
                }
                const arrayBuffer = await videoResponse.arrayBuffer();
                return {
                    videoBuffer: Buffer.from(arrayBuffer),
                    mimeType: "video/mp4",
                };
            }

            if (status.status === "failed") {
                throw new Error(status.error?.message || "Video generation failed");
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        throw new Error("Video generation timed out");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[openai] Video generation failed:`, message);
        throw new Error(`OpenAI video generation failed: ${message}`);
    }
}

/**
 * Generate speech using OpenAI TTS models
 * 
 * @param modelId - The model ID (tts-1, tts-1-hd)
 * @param text - Text to convert to speech
 * @param options - Optional parameters (voice, speed, format)
 * @returns Buffer containing the audio
 */
export async function openaiGenerateSpeech(
    modelId: string,
    text: string,
    options?: {
        voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
        speed?: number; // 0.25 to 4.0
        responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
    }
): Promise<Buffer> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Generating speech with ${modelId}: "${text.slice(0, 50)}..."`);

    try {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: modelId,
                input: text,
                voice: options?.voice || "alloy",
                speed: options?.speed || 1.0,
                response_format: options?.responseFormat || "mp3",
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
            throw new Error((error as { error?: { message?: string } }).error?.message || `API error: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[openai] Speech generation failed:`, message);
        throw new Error(`OpenAI speech generation failed: ${message}`);
    }
}

/**
 * Transcribe audio using OpenAI Whisper models
 * 
 * @param modelId - The model ID (whisper-1)
 * @param audioBuffer - Audio data as Buffer
 * @param options - Optional parameters
 * @returns Transcription result
 */
export async function openaiTranscribeAudio(
    modelId: string,
    audioBuffer: Buffer,
    options?: {
        language?: string;
        responseFormat?: "json" | "text" | "srt" | "verbose_json" | "vtt";
    }
): Promise<{ text: string }> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Transcribing audio with ${modelId}`);

    try {
        const formData = new FormData();
        // Convert Buffer to Uint8Array for Blob compatibility
        formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" }), "audio.wav");
        formData.append("model", modelId);
        if (options?.language) formData.append("language", options.language);
        if (options?.responseFormat) formData.append("response_format", options.responseFormat);

        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
            },
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
            throw new Error((error as { error?: { message?: string } }).error?.message || `API error: ${response.status}`);
        }

        const result = await response.json() as { text: string };
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[openai] Transcription failed:`, message);
        throw new Error(`OpenAI transcription failed: ${message}`);
    }
}

