/**
 * OpenAI Models Provider
 * 
 * Fetches models dynamically from OpenAI API.
 * 
 * API Reference: https://platform.openai.com/docs/api-reference/models/list
 * Task types are inferred from model ID patterns as the API only returns model metadata.
 */

import type {
    Message,
    Output,
    Request,
    Event,
    Tool,
    Call,
    Choice,
    Usage,
} from "../../core.js";
import * as lower from "../shared/schema.js";

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
        imageUrl?: string;
        signal?: AbortSignal;
    }
): Promise<{
    buffer: Buffer;
    mimeType: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        billingMetrics?: Record<string, unknown>;
        raw?: Record<string, unknown>;
    };
}> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Generating image with ${modelId}: "${prompt.slice(0, 50)}..."`);

    try {
        if (options?.imageUrl) {
            const sourceResponse = await fetch(options.imageUrl, { signal: options.signal });
            if (!sourceResponse.ok) {
                throw new Error(`Failed to fetch input image: ${sourceResponse.status}`);
            }

            const sourceContentType = sourceResponse.headers.get("content-type") || "image/png";
            const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
            const formData = new FormData();
            formData.append("model", modelId);
            formData.append("prompt", prompt);
            formData.append("image", new Blob([new Uint8Array(sourceBuffer)], { type: sourceContentType }), "input-image");
            if (options.n !== undefined) formData.append("n", String(options.n));
            if (options.size) formData.append("size", options.size);
            if (options.quality) formData.append("quality", options.quality);

            const response = await fetch("https://api.openai.com/v1/images/edits", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                },
                body: formData,
                signal: options.signal,
            });

            if (!response.ok) {
                const text = await response.text().catch(() => response.statusText);
                throw new Error(`OpenAI image edit failed: ${response.status} - ${text}`);
            }

            const data = await response.json() as {
                data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
                usage?: Record<string, unknown>;
            };
            const first = data.data?.[0];
            if (!first) {
                throw new Error("OpenAI image edit returned no image data");
            }

            let buffer: Buffer;
            if (first.b64_json) {
                buffer = Buffer.from(first.b64_json, "base64");
            } else if (first.url) {
                const editedImageResponse = await fetch(first.url, { signal: options.signal });
                if (!editedImageResponse.ok) {
                    throw new Error(`Failed to download edited image: ${editedImageResponse.status}`);
                }
                buffer = Buffer.from(await editedImageResponse.arrayBuffer());
            } else {
                throw new Error("OpenAI image edit returned no image payload");
            }

            const rawUsage = data.usage && typeof data.usage === "object" ? data.usage : null;
            const usage = rawUsage
                ? {
                    promptTokens: typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0,
                    completionTokens: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0,
                    totalTokens: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : 0,
                    raw: rawUsage,
                }
                : undefined;

            return {
                buffer,
                mimeType: "image/png",
                ...(usage ? { usage } : {}),
            };
        }

        const imageResponse = await fetch("https://api.openai.com/v1/images/generations", {
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
            }),
            signal: options?.signal,
        });

        if (!imageResponse.ok) {
            const text = await imageResponse.text().catch(() => imageResponse.statusText);
            throw new Error(`OpenAI image generation HTTP ${imageResponse.status}: ${text.slice(0, 500)}`);
        }

        const result = await imageResponse.json() as {
            data?: Array<{
                b64_json?: string;
                url?: string;
                revised_prompt?: string;
                input_tokens?: number;
                image_tokens?: number;
                output_tokens?: number;
                quality?: string;
                size?: string;
            }>;
            usage?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
                input_tokens_details?: { text_tokens?: number; image_tokens?: number };
            };
        };

        if (!result.data || result.data.length === 0) {
            throw new Error("No image generated");
        }

        const image = { base64: result.data[0].b64_json };
        const providerImages = result.data;
        const firstProviderImage = providerImages[0];
        const inputTextTokensFromDetails = result.usage?.input_tokens_details?.text_tokens ?? 0;
        const inputImageTokensFromDetails = result.usage?.input_tokens_details?.image_tokens ?? 0;
        const inputTextTokens = inputTextTokensFromDetails > 0
            ? inputTextTokensFromDetails
            : providerImages.reduce((total, item) => total + (typeof item.input_tokens === "number" ? item.input_tokens : 0), 0);
        const inputImageTokens = inputImageTokensFromDetails > 0
            ? inputImageTokensFromDetails
            : providerImages.reduce((total, item) => total + (typeof item.image_tokens === "number" ? item.image_tokens : 0), 0);
        const billingMetrics: Record<string, unknown> = {};
        if (inputTextTokens > 0) {
            billingMetrics.input_text_tokens = inputTextTokens;
        }
        if (inputImageTokens > 0) {
            billingMetrics.input_image_tokens = inputImageTokens;
        }
        if (typeof result.usage?.output_tokens === "number" && result.usage.output_tokens > 0) {
            billingMetrics.output_image_tokens = result.usage.output_tokens;
        }
        if (typeof firstProviderImage?.quality === "string" && firstProviderImage.quality.length > 0) {
            billingMetrics.quality = firstProviderImage.quality;
        }
        if (typeof firstProviderImage?.size === "string" && firstProviderImage.size.length > 0) {
            billingMetrics.size = firstProviderImage.size;
        }
        const promptTokens = result.usage?.input_tokens ?? (inputTextTokens + inputImageTokens);
        const completionTokens = result.usage?.output_tokens ?? (typeof billingMetrics.output_image_tokens === "number" ? billingMetrics.output_image_tokens as number : 0);
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
        const usage = (result.usage || Object.keys(billingMetrics).length > 0)
            ? {
                promptTokens,
                completionTokens,
                totalTokens,
                ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
            }
            : undefined;

        if (image.base64) {
            return {
                buffer: Buffer.from(image.base64, "base64"),
                mimeType: "image/png",
                ...(usage ? { usage } : {}),
            };
        }

        if (firstProviderImage?.url) {
            const generatedImageResponse = await fetch(firstProviderImage.url, { signal: options?.signal });
            if (!generatedImageResponse.ok) {
                throw new Error(`Failed to download generated image: ${generatedImageResponse.status}`);
            }
            return {
                buffer: Buffer.from(await generatedImageResponse.arrayBuffer()),
                mimeType: generatedImageResponse.headers.get("content-type")?.split(";")[0]?.trim() || "image/png",
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

export function isOpenAIImageStreamingUnsupportedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /stream/i.test(message)
        && /Unknown parameter|unknown_parameter|invalid_request_error/i.test(message)
        && /400|bad request/i.test(message);
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
        signal?: AbortSignal;
    }
): AsyncGenerator<
    | { type: "image-partial"; index: number; b64: string }
    | { type: "image-complete"; b64: string; revisedPrompt?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics?: Record<string, unknown>; raw?: Record<string, unknown> } }
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
        signal: options?.signal,
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
        if (options?.signal?.aborted) {
            throw (options.signal.reason instanceof Error ? options.signal.reason : new Error("request aborted"));
        }
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
                const rawUsage = parsed.usage && typeof parsed.usage === "object"
                    ? parsed.usage as Record<string, unknown>
                    : null;
                const usage = rawUsage
                    ? {
                        promptTokens: typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0,
                        completionTokens: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0,
                        totalTokens: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : 0,
                        raw: rawUsage,
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

export async function openaiGenerateVideo(
    modelId: string,
    prompt: string,
    options?: {
        duration?: number;
        size?: string;
        imageUrl?: string;
    }
): Promise<{ videoBuffer: Buffer; mimeType: string }> {
    if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(`[openai] Generating video with ${modelId}: "${prompt.slice(0, 50)}..."`);

    try {
        // Step 1: Create video generation job
        const response = await fetch("https://api.openai.com/v1/videos", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: modelId,
                prompt,
                ...(options?.size ? { size: options.size } : {}),
                ...(options?.duration ? { seconds: String(options.duration) } : {}),
                ...(options?.imageUrl ? { input_reference: { image_url: options.imageUrl } } : {}),
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI video submission failed: ${response.status} - ${await response.text()}`);
        }

        const job = await response.json() as { id?: string; status?: string };
        if (!job.id) {
            throw new Error("OpenAI returned no job id");
        }
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

            if (status.status === "completed") {
                const downloadUrl = status.output_url || `https://api.openai.com/v1/videos/${job.id}/content`;
                const videoResponse = await fetch(downloadUrl, status.output_url ? undefined : {
                    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
                });
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
        prompt?: string;
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
        if (options?.prompt) formData.append("prompt", options.prompt);

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

// =============================================================================
// OpenAI Chat Completions wire family
// =============================================================================
//
// Implements the OpenAI Chat Completions HTTP shape used by every OpenAI-
// compatible provider in the catalog (openai itself, plus aggregators routing
// through their compat surfaces: azure, alibaba compatible-mode, do openai-
// shaped routes, cloudflare /ai/v1, fireworks /inference/v1, asicloud, hf
// router, asi-one).
//
// Exports: chat, streamChat, embeddings, responses + a typed Endpoint object.
// Endpoint = { baseURL, apiKey, authStyle: "bearer"|"api-key", extraHeaders?, paths? }.
//
// No external SDK. Direct fetch only.

export interface OpenAIWireEndpoint {
    baseURL: string;
    apiKey: string;
    authStyle?: "bearer" | "api-key";
    extraHeaders?: Record<string, string>;
    paths?: {
        chat?: string;
        embeddings?: string;
        images?: string;
        responses?: string;
    };
}

export interface OpenAIWireChatOptions {
    temperature?: number;
    maxTokens?: number;
    /** "max_completion_tokens" key on the wire instead of "max_tokens". */
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: Request["responseFormat"];
    customParams?: Record<string, unknown>;
    /** Override the wire model id (e.g. azure deployment name). */
    wireModelId?: string;
    signal?: AbortSignal;
}

export interface OpenAIWireEmbeddingsOptions {
    dimensions?: number;
    customParams?: Record<string, unknown>;
    signal?: AbortSignal;
}

export interface OpenAIWireResponsesOptions {
    temperature?: number;
    maxOutputTokens?: number;
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: Request["responseFormat"];
    customParams?: Record<string, unknown>;
    wireModelId?: string;
    stream?: boolean;
    signal?: AbortSignal;
}

const DEFAULT_OPENAI_PATHS = {
    chat: "/chat/completions",
    embeddings: "/embeddings",
    images: "/images/generations",
    responses: "/responses",
} as const;

const CHAT_OMIT = new Set(["text", "verbosity"]);
const RESPONSES_OMIT = new Set([
    "max_completion_tokens",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "response_format",
    "stream",
    "stream_options",
    "text",
    "verbosity",
]);

function endpointUrl(endpoint: OpenAIWireEndpoint, slot: keyof typeof DEFAULT_OPENAI_PATHS): string {
    const base = endpoint.baseURL.replace(/\/+$/, "");
    const path = endpoint.paths?.[slot] || DEFAULT_OPENAI_PATHS[slot];
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function endpointHeaders(endpoint: OpenAIWireEndpoint, contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    const style = endpoint.authStyle ?? "bearer";
    if (endpoint.apiKey) {
        if (style === "bearer") headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
        else if (style === "api-key") headers["api-key"] = endpoint.apiKey;
    }
    if (endpoint.extraHeaders) {
        for (const [key, value] of Object.entries(endpoint.extraHeaders)) {
            headers[key] = value;
        }
    }
    return headers;
}

function asWireRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanWire(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

async function readErrorBodyWire(response: Response): Promise<string> {
    try {
        return (await response.text()).slice(0, 1000);
    } catch {
        return response.statusText;
    }
}

// ---------------------------------------------------------------------------
// Message → wire
// ---------------------------------------------------------------------------

function normalizeContentToStringWire(content: unknown): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content);
    return content
        .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => (part as { text?: string }).text)
        .filter((text): text is string => typeof text === "string")
        .join("\n");
}

function normalizeContentPartsWire(parts: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const raw of parts) {
        const part = asWireRecord(raw);
        if (!part) continue;
        const type = cleanWire(part.type);

        if (type === "text" && typeof part.text === "string") {
            out.push({ type: "text", text: part.text });
            continue;
        }
        if (type === "image_url") {
            const value = part.image_url;
            const url = typeof value === "string" ? value : cleanWire(asWireRecord(value)?.url);
            if (url) {
                const detail = cleanWire(asWireRecord(value)?.detail);
                out.push({ type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } });
            }
            continue;
        }
        if (type === "input_audio") {
            const value = part.input_audio;
            const record = asWireRecord(value);
            const data = cleanWire(record?.data);
            if (data) {
                const format = cleanWire(record?.format);
                out.push({ type: "input_audio", input_audio: { data, ...(format ? { format } : {}) } });
                continue;
            }
            const url = typeof value === "string" ? value : cleanWire(record?.url);
            if (url) out.push({ type: "input_audio", input_audio: { url } });
            continue;
        }
        if (type === "video_url") {
            const value = part.video_url;
            const url = typeof value === "string" ? value : cleanWire(asWireRecord(value)?.url);
            if (url) out.push({ type: "video_url", video_url: { url } });
            continue;
        }
        // tool-call / tool-result content parts are flattened: tool-calls are
        // surfaced via the assistant message's `tool_calls` field, tool-results
        // arrive as standalone tool-role messages.
        if (type === "tool-result" || type === "tool_result") {
            const output = part.output ?? part.result;
            if (typeof output === "string") out.push({ type: "text", text: output });
            else if (output != null) out.push({ type: "text", text: JSON.stringify(output) });
        }
    }
    return out;
}

export function mapMessagesForOpenAIWire(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map((message) => {
        if (message.role === "system") {
            return { role: "system", content: normalizeContentToStringWire(message.content) };
        }
        if (message.role === "tool") {
            return {
                role: "tool",
                tool_call_id: message.tool_call_id || "",
                content: normalizeContentToStringWire(message.content),
                ...(message.name ? { name: message.name } : {}),
            };
        }
        if (message.role === "assistant") {
            const out: Record<string, unknown> = { role: "assistant" };
            if (Array.isArray(message.content)) {
                const parts = normalizeContentPartsWire(message.content);
                out.content = parts.length > 0 ? parts : "";
            } else {
                out.content = normalizeContentToStringWire(message.content);
            }
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                out.tool_calls = message.tool_calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: {
                        name: call.function.name,
                        arguments: typeof call.function.arguments === "string"
                            ? call.function.arguments
                            : JSON.stringify(call.function.arguments),
                    },
                }));
            }
            return out;
        }
        if (Array.isArray(message.content)) {
            const parts = normalizeContentPartsWire(message.content);
            return { role: "user", content: parts.length > 0 ? parts : "" };
        }
        return { role: "user", content: normalizeContentToStringWire(message.content) };
    });
}

function toolsToWire(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    const wire: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
        if (tool.type !== "function" || !tool.function?.name) continue;
        wire.push({
            type: "function",
            function: {
                name: tool.function.name,
                ...(tool.function.description ? { description: tool.function.description } : {}),
                parameters: lower.object(tool.function.parameters),
            },
        });
    }
    return wire.length > 0 ? wire : undefined;
}

function toolsToResponsesWire(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    const wire: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
        const fn = asWireRecord((tool as unknown as Record<string, unknown>).function);
        const name = cleanWire(fn?.name);
        if (tool.type !== "function" || !name) continue;
        wire.push({
            type: "function",
            name,
            parameters: lower.object(fn?.parameters as Record<string, unknown> | undefined),
            ...(typeof fn?.description === "string" && fn.description.length > 0 ? { description: fn.description } : {}),
            ...(typeof fn?.strict === "boolean" ? { strict: fn.strict } : {}),
        });
    }
    return wire.length > 0 ? wire : undefined;
}

function toolChoiceToWire(
    toolChoice: Choice | undefined,
): "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") return toolChoice;
    if (toolChoice.type === "function" && toolChoice.function?.name) {
        return { type: "function", function: { name: toolChoice.function.name } };
    }
    return undefined;
}

function toolChoiceToResponsesWire(
    toolChoice: Choice | undefined,
): "auto" | "none" | "required" | { type: "function"; name: string } | undefined {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") return toolChoice;
    if (toolChoice.type === "function" && toolChoice.function?.name) {
        return { type: "function", name: toolChoice.function.name };
    }
    return undefined;
}

function responseFormatToWire(format: Request["responseFormat"]): Record<string, unknown> | undefined {
    if (!format) return undefined;
    if (format.type === "text") return undefined;
    if (format.type === "json_object") return { type: "json_object" };
    if (format.type === "json_schema") {
        const schema = format.json_schema?.schema;
        if (!schema) return { type: "json_object" };
        return {
            type: "json_schema",
            json_schema: {
                name: format.json_schema?.name || "compose_response",
                schema,
                ...(typeof format.json_schema?.strict === "boolean" ? { strict: format.json_schema.strict } : {}),
            },
        };
    }
    return undefined;
}

function responseFormatToResponsesWire(format: Request["responseFormat"]): Record<string, unknown> | undefined {
    if (!format) return undefined;
    if (format.type === "text") return { type: "text" };
    if (format.type === "json_object") return { type: "json_object" };
    if (format.type === "json_schema") {
        const schema = format.json_schema?.schema;
        if (!schema) return { type: "json_object" };
        return {
            type: "json_schema",
            name: format.json_schema?.name || "compose_response",
            schema,
            ...(typeof format.json_schema?.strict === "boolean" ? { strict: format.json_schema.strict } : {}),
        };
    }
    return undefined;
}

function contentPartsToResponsesWire(parts: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const raw of parts) {
        const part = asWireRecord(raw);
        if (!part) continue;
        const type = cleanWire(part.type);

        if (type === "text" && typeof part.text === "string") {
            out.push({ type: "input_text", text: part.text });
            continue;
        }
        if (type === "image_url") {
            const value = part.image_url;
            const url = typeof value === "string" ? value : cleanWire(asWireRecord(value)?.url);
            if (url) {
                const detail = cleanWire(asWireRecord(value)?.detail);
                out.push({
                    type: "input_image",
                    image_url: url,
                    detail: detail === "low" || detail === "high" || detail === "original" ? detail : "auto",
                });
            }
            continue;
        }
        if (type === "file_url") {
            const value = part.file_url;
            const url = typeof value === "string" ? value : cleanWire(asWireRecord(value)?.url);
            if (url) out.push({ type: "input_file", file_url: url });
            continue;
        }
        if (type === "tool-result" || type === "tool_result") {
            const output = part.output ?? part.result;
            if (typeof output === "string") out.push({ type: "input_text", text: output });
            else if (output != null) out.push({ type: "input_text", text: JSON.stringify(output) });
        }
    }
    return out;
}

function contentToResponsesWire(content: unknown): string | unknown[] {
    if (!Array.isArray(content)) return normalizeContentToStringWire(content);
    const parts = contentPartsToResponsesWire(content);
    return parts.length > 0 ? parts : normalizeContentToStringWire(content);
}

export type OpenAIWireResponsesInputItem = Record<string, unknown>;

export function mapMessagesForResponsesWire(messages: Message[]): OpenAIWireResponsesInputItem[] {
    const out: OpenAIWireResponsesInputItem[] = [];
    let fallbackCall = 0;

    for (const message of messages) {
        if (message.role === "tool") {
            out.push({
                type: "function_call_output",
                call_id: message.tool_call_id || `call_${fallbackCall++}`,
                output: normalizeContentToStringWire(message.content),
            });
            continue;
        }

        if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const text = normalizeContentToStringWire(message.content);
            if (text) {
                out.push({ role: "assistant", content: text });
            }
            for (const call of message.tool_calls) {
                const id = cleanWire(call.id) || `call_${fallbackCall++}`;
                const name = cleanWire(call.function?.name);
                if (!name) continue;
                out.push({
                    type: "function_call",
                    call_id: id,
                    name,
                    arguments: typeof call.function.arguments === "string"
                        ? call.function.arguments
                        : JSON.stringify(call.function.arguments ?? {}),
                });
            }
            continue;
        }

        out.push({
            role: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user",
            content: contentToResponsesWire(message.content),
        });
    }

    return out;
}

// ---------------------------------------------------------------------------
// Usage extraction (covers all OpenAI-compat dialects)
// ---------------------------------------------------------------------------

function readNonNegWire(record: Record<string, unknown> | null | undefined, keys: readonly string[]): number | undefined {
    if (!record) return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
}

function assignMetricWire(metrics: Record<string, unknown>, key: string, value: unknown): void {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) metrics[key] = value;
}

export function usageFromOpenAIWire(rawUsage: unknown): Usage | undefined {
    const usage = asWireRecord(rawUsage);
    if (!usage) return undefined;
    const promptTokens = readNonNegWire(usage, ["prompt_tokens", "input_tokens", "promptTokens", "inputTokens"]) ?? 0;
    const completionTokens = readNonNegWire(usage, [
        "completion_tokens",
        "output_tokens",
        "completionTokens",
        "outputTokens",
    ]) ?? 0;
    const totalTokens = readNonNegWire(usage, ["total_tokens", "totalTokens"]) ?? promptTokens + completionTokens;

    const metrics: Record<string, unknown> = {};
    const inputDetails =
        asWireRecord(usage.prompt_tokens_details)
        ?? asWireRecord(usage.promptTokenDetails)
        ?? asWireRecord(usage.input_tokens_details)
        ?? asWireRecord(usage.inputTokenDetails);
    const cachedDetails =
        asWireRecord(inputDetails?.cached_tokens_details)
        ?? asWireRecord(inputDetails?.cachedTokensDetails);
    const outputDetails =
        asWireRecord(usage.completion_tokens_details)
        ?? asWireRecord(usage.completionTokenDetails)
        ?? asWireRecord(usage.output_tokens_details)
        ?? asWireRecord(usage.outputTokenDetails);

    assignMetricWire(metrics, "cached_input_tokens", inputDetails?.cached_tokens ?? inputDetails?.cachedTokens ?? usage.cached_input_tokens);
    assignMetricWire(metrics, "input_text_tokens", inputDetails?.text_tokens ?? inputDetails?.textTokens ?? usage.input_text_tokens);
    assignMetricWire(metrics, "input_audio_tokens", inputDetails?.audio_tokens ?? inputDetails?.audioTokens ?? usage.input_audio_tokens);
    assignMetricWire(metrics, "input_image_tokens", inputDetails?.image_tokens ?? inputDetails?.imageTokens ?? usage.input_image_tokens);
    assignMetricWire(metrics, "cached_input_text_tokens", cachedDetails?.text_tokens ?? cachedDetails?.textTokens);
    assignMetricWire(metrics, "cached_input_audio_tokens", cachedDetails?.audio_tokens ?? cachedDetails?.audioTokens);
    assignMetricWire(metrics, "cached_input_image_tokens", cachedDetails?.image_tokens ?? cachedDetails?.imageTokens);
    assignMetricWire(metrics, "output_text_tokens", outputDetails?.text_tokens ?? outputDetails?.textTokens ?? usage.output_text_tokens);
    assignMetricWire(metrics, "output_audio_tokens", outputDetails?.audio_tokens ?? outputDetails?.audioTokens ?? usage.output_audio_tokens);
    assignMetricWire(metrics, "output_image_tokens", outputDetails?.image_tokens ?? outputDetails?.imageTokens ?? usage.output_image_tokens);
    assignMetricWire(metrics, "reasoning_tokens", outputDetails?.reasoning_tokens ?? outputDetails?.reasoningTokens ?? usage.reasoning_tokens);

    const reasoningTokens = readNonNegWire(usage, ["reasoning_tokens", "reasoningTokens"])
        ?? readNonNegWire(outputDetails ?? undefined, ["reasoning_tokens", "reasoningTokens"]);
    const cachedInputTokens = readNonNegWire(usage, ["cached_input_tokens", "cachedInputTokens"])
        ?? readNonNegWire(inputDetails ?? undefined, ["cached_tokens", "cachedTokens"]);

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
        ...(Object.keys(metrics).length > 0 ? { billingMetrics: metrics } : {}),
        raw: usage,
    };
}

function finishReasonFromWire(value: unknown, hadToolCalls: boolean): string {
    const raw = cleanWire(value).toLowerCase();
    if (raw === "tool_calls" || raw === "tool-calls") return "tool-calls";
    if (hadToolCalls && (!raw || raw === "stop")) return "tool-calls";
    if (raw === "length") return "length";
    if (raw === "content_filter" || raw === "content-filter") return "content-filter";
    if (raw === "stop") return "stop";
    return raw || "stop";
}

function toolCallsFromAssistant(message: Record<string, unknown> | null | undefined): Call[] | undefined {
    if (!message) return undefined;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const out: Call[] = [];
    for (let i = 0; i < calls.length; i += 1) {
        const record = asWireRecord(calls[i]);
        if (!record) continue;
        const fn = asWireRecord(record.function);
        out.push({
            id: cleanWire(record.id) || `call_${i}`,
            name: cleanWire(fn?.name),
            arguments: cleanWire(fn?.arguments) || "{}",
        });
    }
    return out.length > 0 ? out : undefined;
}

function toolCallsFromResponses(data: Record<string, unknown>): Call[] | undefined {
    const output = Array.isArray(data.output) ? data.output : [];
    const out: Call[] = [];
    for (let i = 0; i < output.length; i += 1) {
        const record = asWireRecord(output[i]);
        if (!record) continue;
        const type = cleanWire(record.type);
        if (type !== "function_call" && type !== "tool_call") continue;
        const name = cleanWire(record.name);
        if (!name) continue;
        out.push({
            id: cleanWire(record.call_id) || cleanWire(record.id) || `call_${i}`,
            name,
            arguments: typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {}),
        });
    }
    return out.length > 0 ? out : undefined;
}

function mergeTextForResponses(
    customParams: Record<string, unknown> | undefined,
    responseFormat: Request["responseFormat"],
): Record<string, unknown> | undefined {
    const text = {
        ...(asWireRecord(customParams?.text) || {}),
    };
    const verbosity = cleanWire(customParams?.verbosity);
    if (verbosity && text.verbosity === undefined) text.verbosity = verbosity;
    const format = responseFormatToResponsesWire(responseFormat);
    if (format) text.format = format;
    return Object.keys(text).length > 0 ? text : undefined;
}

function reasoningForResponses(customParams: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const reasoning = asWireRecord(customParams?.reasoning);
    const effort = cleanWire(customParams?.reasoning_effort);
    const out = {
        ...(effort ? { effort } : {}),
        ...(reasoning || {}),
    };
    return Object.keys(out).length > 0 ? out : undefined;
}

function streamOptionsForResponses(customParams: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const raw = asWireRecord(customParams?.stream_options);
    const out: Record<string, unknown> = {};
    if (typeof raw?.include_obfuscation === "boolean") out.include_obfuscation = raw.include_obfuscation;
    return Object.keys(out).length > 0 ? out : undefined;
}

export function buildBodyChat(
    modelId: string,
    messages: Message[],
    opts?: OpenAIWireChatOptions,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: opts?.wireModelId || modelId,
        messages: mapMessagesForOpenAIWire(messages),
    };
    if (typeof opts?.temperature === "number") body.temperature = opts.temperature;
    if (typeof opts?.maxTokens === "number") {
        const field = opts.maxTokensField || "max_tokens";
        body[field] = opts.maxTokens;
    }
    const tools = toolsToWire(opts?.tools);
    if (tools) body.tools = tools;
    const toolChoice = toolChoiceToWire(opts?.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    const rf = responseFormatToWire(opts?.responseFormat);
    if (rf) body.response_format = rf;
    if (opts?.customParams) {
        for (const [key, value] of Object.entries(opts.customParams)) {
            if (CHAT_OMIT.has(key)) continue;
            if (opts.maxTokensField === "max_completion_tokens" && key === "max_tokens") continue;
            if (value !== undefined && body[key] === undefined) body[key] = value;
        }
    }
    return body;
}

export function buildBodyResponses(
    modelId: string,
    input: OpenAIWireResponsesInputItem[],
    opts?: OpenAIWireResponsesOptions,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: opts?.wireModelId || modelId,
        input,
    };
    if (typeof opts?.temperature === "number") body.temperature = opts.temperature;
    if (typeof opts?.maxOutputTokens === "number") body.max_output_tokens = opts.maxOutputTokens;
    const tools = toolsToResponsesWire(opts?.tools);
    if (tools) body.tools = tools;
    const toolChoice = toolChoiceToResponsesWire(opts?.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    const text = mergeTextForResponses(opts?.customParams, opts?.responseFormat);
    if (text) body.text = text;
    const reasoning = reasoningForResponses(opts?.customParams);
    if (reasoning) body.reasoning = reasoning;
    if (opts?.customParams) {
        for (const [key, value] of Object.entries(opts.customParams)) {
            if (RESPONSES_OMIT.has(key)) continue;
            if (value !== undefined && body[key] === undefined) body[key] = value;
        }
    }
    if (opts?.stream === true) {
        body.stream = true;
        const streamOptions = streamOptionsForResponses(opts.customParams);
        if (streamOptions) body.stream_options = streamOptions;
    }
    return body;
}

// ---------------------------------------------------------------------------
// chat (non-streaming)
// ---------------------------------------------------------------------------

export async function chat(
    endpoint: OpenAIWireEndpoint,
    modelId: string,
    messages: Message[],
    opts?: OpenAIWireChatOptions,
): Promise<Output> {
    const url = endpointUrl(endpoint, "chat");
    const headers = endpointHeaders(endpoint, "application/json");
    const body = buildBodyChat(modelId, messages, opts);

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok) {
        throw new Error(`OpenAI-wire chat HTTP ${response.status}: ${await readErrorBodyWire(response)}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = asWireRecord(choices[0]);
    const message = asWireRecord(first?.message);
    const text = typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
            ? (message.content as unknown[])
                .map((part) => cleanWire(asWireRecord(part)?.text))
                .filter(Boolean)
                .join("")
            : "";
    const toolCalls = toolCallsFromAssistant(message);
    const usage = usageFromOpenAIWire(data.usage);

    return {
        modality: "text",
        content: text,
        usage,
        finishReason: finishReasonFromWire(first?.finish_reason, Boolean(toolCalls && toolCalls.length > 0)),
        ...(toolCalls ? { toolCalls } : {}),
    };
}

// ---------------------------------------------------------------------------
// streamChat (SSE → Event)
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
    id: string;
    name: string;
    args: string;
}

export async function* streamChat(
    endpoint: OpenAIWireEndpoint,
    modelId: string,
    messages: Message[],
    opts?: OpenAIWireChatOptions,
): AsyncGenerator<Event> {
    const url = endpointUrl(endpoint, "chat");
    const headers = endpointHeaders(endpoint, "application/json");
    const baseBody = buildBodyChat(modelId, messages, opts);
    const streamOptions = asWireRecord(baseBody.stream_options);
    const body = {
        ...baseBody,
        stream: true,
        stream_options: { ...(streamOptions || {}), include_usage: true },
    };

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok || !response.body) {
        throw new Error(`OpenAI-wire stream HTTP ${response.status}: ${await readErrorBodyWire(response)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage: Usage | undefined;
    let lastFinishReason: string | undefined;
    let sawToolCall = false;
    const toolCalls = new Map<number, ToolCallAccumulator>();

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
                if (!data || data === "[DONE]") continue;

                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(data) as Record<string, unknown>;
                } catch {
                    continue;
                }

                if (parsed.usage) {
                    const u = usageFromOpenAIWire(parsed.usage);
                    if (u) lastUsage = u;
                }

                const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
                const choice = asWireRecord(choices[0]);
                if (!choice) continue;
                const delta = asWireRecord(choice.delta);
                if (delta) {
                    const content = delta.content;
                    if (typeof content === "string" && content.length > 0) {
                        yield { type: "text-delta", text: content };
                    }
                    const reasoning = delta.reasoning_content;
                    if (typeof reasoning === "string" && reasoning.length > 0) {
                        yield { type: "thinking", thinking: reasoning };
                    }
                    const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
                    for (const item of deltaToolCalls) {
                        const record = asWireRecord(item);
                        if (!record) continue;
                        const index = typeof record.index === "number" ? record.index : 0;
                        const fn = asWireRecord(record.function);
                        const idDelta = cleanWire(record.id);
                        const nameDelta = cleanWire(fn?.name);
                        const argsDelta = typeof fn?.arguments === "string" ? (fn.arguments as string) : "";

                        let acc = toolCalls.get(index);
                        if (!acc) {
                            acc = { id: idDelta || `call_${index}`, name: nameDelta, args: argsDelta };
                            toolCalls.set(index, acc);
                        } else {
                            if (idDelta) acc.id = idDelta;
                            if (nameDelta) acc.name += nameDelta;
                            if (argsDelta) acc.args += argsDelta;
                        }
                        sawToolCall = true;
                        yield {
                            type: "tool-call-delta",
                            toolCallDelta: {
                                index,
                                ...(idDelta ? { id: idDelta } : {}),
                                ...(nameDelta ? { name: nameDelta } : {}),
                                ...(argsDelta ? { arguments: argsDelta } : {}),
                            },
                        };
                    }
                }
                const fr = cleanWire(choice.finish_reason);
                if (fr) lastFinishReason = fr;
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* best-effort */ }
    }

    if (sawToolCall) {
        for (const acc of toolCalls.values()) {
            yield {
                type: "tool-call",
                toolCall: { id: acc.id, name: acc.name, arguments: acc.args || "{}" },
            };
        }
    }

    yield {
        type: "done",
        finishReason: finishReasonFromWire(lastFinishReason, sawToolCall),
        usage: lastUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
}

// ---------------------------------------------------------------------------
// embeddings
// ---------------------------------------------------------------------------

export interface OpenAIWireEmbeddingsResult {
    embeddings: number[][];
    usage?: Usage;
    raw: unknown;
}

export async function embeddings(
    endpoint: OpenAIWireEndpoint,
    modelId: string,
    input: string[] | string,
    opts?: OpenAIWireEmbeddingsOptions,
): Promise<OpenAIWireEmbeddingsResult> {
    const url = endpointUrl(endpoint, "embeddings");
    const headers = endpointHeaders(endpoint, "application/json");
    const body: Record<string, unknown> = { model: modelId, input };
    if (typeof opts?.dimensions === "number") body.dimensions = opts.dimensions;
    if (opts?.customParams) {
        for (const [key, value] of Object.entries(opts.customParams)) {
            if (value !== undefined && body[key] === undefined) body[key] = value;
        }
    }
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok) {
        throw new Error(`OpenAI-wire embeddings HTTP ${response.status}: ${await readErrorBodyWire(response)}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const dataArr = Array.isArray(data.data) ? data.data : [];
    const out: number[][] = [];
    for (const item of dataArr) {
        const record = asWireRecord(item);
        const embedding = record?.embedding;
        if (Array.isArray(embedding) && embedding.every((v) => typeof v === "number")) {
            out.push(embedding as number[]);
        }
    }
    return { embeddings: out, usage: usageFromOpenAIWire(data.usage), raw: data };
}

// ---------------------------------------------------------------------------
// responses (OpenAI Responses API)
// ---------------------------------------------------------------------------

export async function responses(
    endpoint: OpenAIWireEndpoint,
    modelId: string,
    input: OpenAIWireResponsesInputItem[],
    opts?: OpenAIWireResponsesOptions,
): Promise<Output> {
    const url = endpointUrl(endpoint, "responses");
    const headers = endpointHeaders(endpoint, "application/json");
    const body = buildBodyResponses(modelId, input, opts);
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok) {
        throw new Error(`OpenAI-wire responses HTTP ${response.status}: ${await readErrorBodyWire(response)}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const text = typeof data.output_text === "string" ? data.output_text : (() => {
        const output = Array.isArray(data.output) ? data.output : [];
        const parts: string[] = [];
        for (const item of output) {
            const record = asWireRecord(item);
            const content = Array.isArray(record?.content) ? record.content : [];
            for (const part of content) {
                const partRecord = asWireRecord(part);
                if (typeof partRecord?.text === "string") parts.push(partRecord.text);
                else if (typeof partRecord?.value === "string") parts.push(partRecord.value);
            }
        }
        return parts.join("\n");
    })();
    const usage = usageFromOpenAIWire(data.usage);
    const status = cleanWire(data.status);
    const toolCalls = toolCallsFromResponses(data);
    return {
        modality: "text",
        content: text,
        ...(usage ? { usage } : {}),
        finishReason: toolCalls ? "tool-calls" : status === "completed" ? "stop" : status || "stop",
        ...(toolCalls ? { toolCalls } : {}),
    };
}

interface ResponseToolAccumulator {
    id: string;
    name: string;
    args: string;
}

function responseStatusToFinishReason(status: unknown, hadToolCalls: boolean): string {
    if (hadToolCalls) return "tool-calls";
    const value = cleanWire(status);
    if (!value || value === "completed") return "stop";
    if (value === "incomplete") return "length";
    return value;
}

function mergeResponsesToolItem(
    toolCalls: Map<number, ResponseToolAccumulator>,
    outputIndex: number,
    item: Record<string, unknown> | null,
): boolean {
    if (!item || cleanWire(item.type) !== "function_call") return false;
    const id = cleanWire(item.call_id) || cleanWire(item.id) || `call_${outputIndex}`;
    const name = cleanWire(item.name);
    const args = typeof item.arguments === "string" ? item.arguments : "";
    const acc = toolCalls.get(outputIndex) || { id, name, args: "" };
    if (id) acc.id = id;
    if (name) acc.name = name;
    if (args) acc.args = args;
    toolCalls.set(outputIndex, acc);
    return true;
}

function mergeResponsesCompletedToolCalls(
    toolCalls: Map<number, ResponseToolAccumulator>,
    data: Record<string, unknown>,
): boolean {
    const output = Array.isArray(data.output) ? data.output : [];
    let saw = false;
    for (let i = 0; i < output.length; i += 1) {
        saw = mergeResponsesToolItem(toolCalls, i, asWireRecord(output[i])) || saw;
    }
    return saw;
}

export async function* streamResponses(
    endpoint: OpenAIWireEndpoint,
    modelId: string,
    input: OpenAIWireResponsesInputItem[],
    opts?: OpenAIWireResponsesOptions,
): AsyncGenerator<Event> {
    const url = endpointUrl(endpoint, "responses");
    const headers = endpointHeaders(endpoint, "application/json");
    const body = buildBodyResponses(modelId, input, { ...opts, stream: true });

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
    });
    if (!response.ok || !response.body) {
        throw new Error(`OpenAI-wire responses stream HTTP ${response.status}: ${await readErrorBodyWire(response)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage: Usage | undefined;
    let lastStatus: unknown;
    let sawToolCall = false;
    const toolCalls = new Map<number, ResponseToolAccumulator>();

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
                if (!data || data === "[DONE]") continue;

                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(data) as Record<string, unknown>;
                } catch {
                    continue;
                }

                const type = cleanWire(parsed.type);
                if (type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta.length > 0) {
                    yield { type: "text-delta", text: parsed.delta };
                    continue;
                }
                if (
                    (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta")
                    && typeof parsed.delta === "string"
                    && parsed.delta.length > 0
                ) {
                    yield { type: "thinking", thinking: parsed.delta };
                    continue;
                }
                if (type === "response.output_item.added" || type === "response.output_item.done") {
                    const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : 0;
                    sawToolCall = mergeResponsesToolItem(toolCalls, outputIndex, asWireRecord(parsed.item)) || sawToolCall;
                    continue;
                }
                if (type === "response.function_call_arguments.delta") {
                    const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : 0;
                    const delta = typeof parsed.delta === "string" ? parsed.delta : "";
                    const acc = toolCalls.get(outputIndex) || {
                        id: cleanWire(parsed.item_id) || `call_${outputIndex}`,
                        name: "",
                        args: "",
                    };
                    if (delta) acc.args += delta;
                    toolCalls.set(outputIndex, acc);
                    sawToolCall = true;
                    yield {
                        type: "tool-call-delta",
                        toolCallDelta: {
                            index: outputIndex,
                            ...(acc.id ? { id: acc.id } : {}),
                            ...(acc.name ? { name: acc.name } : {}),
                            ...(delta ? { arguments: delta } : {}),
                        },
                    };
                    continue;
                }
                if (type === "response.function_call_arguments.done") {
                    const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : 0;
                    const acc = toolCalls.get(outputIndex) || {
                        id: cleanWire(parsed.item_id) || `call_${outputIndex}`,
                        name: "",
                        args: "",
                    };
                    const name = cleanWire(parsed.name);
                    if (name) acc.name = name;
                    if (typeof parsed.arguments === "string") acc.args = parsed.arguments;
                    toolCalls.set(outputIndex, acc);
                    sawToolCall = true;
                    continue;
                }
                if (type === "response.completed") {
                    const responseRecord = asWireRecord(parsed.response);
                    if (responseRecord) {
                        lastUsage = usageFromOpenAIWire(responseRecord.usage);
                        lastStatus = responseRecord.status;
                        sawToolCall = mergeResponsesCompletedToolCalls(toolCalls, responseRecord) || sawToolCall;
                    }
                    continue;
                }
                if (type === "response.failed") {
                    const responseRecord = asWireRecord(parsed.response);
                    const errorRecord = asWireRecord(responseRecord?.error);
                    throw new Error(cleanWire(errorRecord?.message) || "OpenAI-wire responses stream failed");
                }
                if (type === "error") {
                    const errorRecord = asWireRecord(parsed.error) || parsed;
                    throw new Error(cleanWire(errorRecord.message) || "OpenAI-wire responses stream error");
                }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* best-effort */ }
    }

    if (sawToolCall) {
        for (const acc of toolCalls.values()) {
            yield {
                type: "tool-call",
                toolCall: { id: acc.id, name: acc.name, arguments: acc.args || "{}" },
            };
        }
    }

    yield {
        type: "done",
        finishReason: responseStatusToFinishReason(lastStatus, sawToolCall),
        usage: lastUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
}

// ---------------------------------------------------------------------------
// Convenience: openai vendor's own endpoint
// ---------------------------------------------------------------------------

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function openaiEndpoint(): OpenAIWireEndpoint {
    return {
        baseURL: OPENAI_BASE_URL,
        apiKey: OPENAI_API_KEY || "",
        authStyle: "bearer",
    };
}
