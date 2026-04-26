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
): Promise<{
    buffer: Buffer;
    mimeType: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        billingMetrics?: Record<string, unknown>;
    };
}> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Generating image with ${modelId}: "${prompt.slice(0, 50)}..."`);

    try {
        const result = await generateImage({
            model: openai.image(modelId),
            prompt,
            ...(options?.n !== undefined ? { n: options.n } : {}),
            size: options?.size,
            providerOptions: options?.quality ? {
                openai: { quality: options.quality }
            } : undefined,
        });

        if (!result.images || result.images.length === 0) {
            throw new Error("No image generated");
        }

        const image = result.images[0];
        const providerImages = Array.isArray((result as { providerMetadata?: { openai?: { images?: Array<Record<string, unknown>> } } }).providerMetadata?.openai?.images)
            ? ((result as { providerMetadata?: { openai?: { images?: Array<Record<string, unknown>> } } }).providerMetadata?.openai?.images ?? [])
            : [];
        const firstProviderImage = providerImages[0];
        const inputTextTokens = providerImages.reduce((total, item) => total + (typeof item.textTokens === "number" ? item.textTokens : 0), 0);
        const inputImageTokens = providerImages.reduce((total, item) => total + (typeof item.imageTokens === "number" ? item.imageTokens : 0), 0);
        const billingMetrics: Record<string, unknown> = {};
        if (inputTextTokens > 0) {
            billingMetrics.input_text_tokens = inputTextTokens;
        }
        if (inputImageTokens > 0) {
            billingMetrics.input_image_tokens = inputImageTokens;
        }
        if (typeof result.usage?.outputTokens === "number" && result.usage.outputTokens > 0) {
            billingMetrics.output_image_tokens = result.usage.outputTokens;
        }
        if (typeof firstProviderImage?.quality === "string" && firstProviderImage.quality.length > 0) {
            billingMetrics.quality = firstProviderImage.quality;
        }
        if (typeof firstProviderImage?.size === "string" && firstProviderImage.size.length > 0) {
            billingMetrics.size = firstProviderImage.size;
        }
        const promptTokens = result.usage?.inputTokens ?? (inputTextTokens + inputImageTokens);
        const completionTokens = result.usage?.outputTokens ?? (typeof billingMetrics.output_image_tokens === "number" ? billingMetrics.output_image_tokens as number : 0);
        const totalTokens = result.usage?.totalTokens ?? (promptTokens + completionTokens);
        const usage = (result.usage || Object.keys(billingMetrics).length > 0)
            ? {
                promptTokens,
                completionTokens,
                totalTokens,
                ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
            }
            : undefined;

        // Return base64 as buffer
        if (image.base64) {
            return {
                buffer: Buffer.from(image.base64, "base64"),
                mimeType: "image/png",
                ...(usage ? { usage } : {}),
            };
        }

        throw new Error("No image data returned");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[openai] Image generation failed:`, message);
        throw new Error(`OpenAI image generation failed: ${message}`);
    }
}

/**
 * Stream partial images from OpenAI's native image-generation SSE surface.
 * Uses `partial_images` so the UI can progressively refine the image behind a
 * blur while generation is in flight.
 */
export async function* openaiStreamImage(
    modelId: string,
    prompt: string,
    options?: {
        size?: "1024x1024" | "1792x1024" | "1024x1792" | "256x256" | "512x512";
        quality?: "standard" | "hd" | "low" | "medium" | "high" | "auto";
        n?: number;
        partialImages?: number;
    }
): AsyncGenerator<
    | { type: "image-partial"; index: number; b64: string }
    | { type: "image-complete"; b64: string; revisedPrompt?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics?: Record<string, unknown> } }
> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: modelId,
            prompt,
            ...(options?.n !== undefined ? { n: options.n } : {}),
            ...(options?.size ? { size: options.size } : {}),
            ...(options?.quality ? { quality: options.quality } : {}),
            stream: true,
            partial_images: options?.partialImages ?? 2,
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`OpenAI image streaming failed: ${response.status} - ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("OpenAI image streaming returned no body");
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
            const sep = buffer.indexOf("\n\n");
            if (sep === -1) break;
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const lines = raw.split("\n");
            const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n").trim();
            if (!data || data === "[DONE]") continue;

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(data) as Record<string, unknown>;
            } catch {
                continue;
            }

            if (parsed.type === "image_generation.partial_image") {
                const b64 = typeof parsed.b64_json === "string" ? parsed.b64_json : "";
                if (b64) {
                    yield {
                        type: "image-partial",
                        index: typeof parsed.partial_image_index === "number" ? parsed.partial_image_index : 0,
                        b64,
                    };
                }
                continue;
            }

            if (parsed.type === "image_generation.completed") {
                const b64 = typeof parsed.b64_json === "string" ? parsed.b64_json : "";
                if (!b64) continue;
                const usage = parsed.usage && typeof parsed.usage === "object"
                    ? {
                        promptTokens: typeof (parsed.usage as { input_tokens?: unknown }).input_tokens === "number" ? (parsed.usage as { input_tokens: number }).input_tokens : 0,
                        completionTokens: typeof (parsed.usage as { output_tokens?: unknown }).output_tokens === "number" ? (parsed.usage as { output_tokens: number }).output_tokens : 0,
                        totalTokens: typeof (parsed.usage as { total_tokens?: unknown }).total_tokens === "number" ? (parsed.usage as { total_tokens: number }).total_tokens : 0,
                    }
                    : undefined;
                yield {
                    type: "image-complete",
                    b64,
                    revisedPrompt: typeof parsed.revised_prompt === "string" ? parsed.revised_prompt : undefined,
                    ...(usage ? { usage } : {}),
                };
            }
        }
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
        duration?: number;
        size?: string;
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
                ...(options?.duration ? { seconds: String(options.duration) } : {}),
                ...(options?.size ? { size: options.size } : {}),
            }),
        });

        if (!createResponse.ok) {
            const error = await createResponse.json().catch(() => ({ error: { message: createResponse.statusText } }));
            throw new Error((error as { error?: { message?: string } }).error?.message || `API error: ${createResponse.status}`);
        }

        const job = await createResponse.json() as { id: string; status: string };
        console.log(`[openai] Video job created: ${job.id}`);

        // Step 2: Poll for completion
        // Sora videos can take 10-30 minutes to generate depending on complexity
        const maxWaitTime = 30 * 60 * 1000; // 30 minutes max
        const pollInterval = 10000; // 10 seconds (less frequent to reduce API load)
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
