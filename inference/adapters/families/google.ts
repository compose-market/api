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
import { randomUUID } from "node:crypto";
import { GoogleGenAI, type GenerateContentResponse, type Part as GenPart } from "@google/genai";
import { getModelById } from "../registry.js";

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
        cachedContentTokenCount?: number;
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

    const cachedContentTokens = typeof record.cachedContentTokenCount === "number" && record.cachedContentTokenCount > 0
        ? record.cachedContentTokenCount
        : undefined;
    if (cachedContentTokens !== undefined) {
        billingMetrics.cached_input_tokens = cachedContentTokens;
        if (billingMetrics.cached_input_text_tokens === undefined && !record.cacheTokensDetails?.length) {
            billingMetrics.cached_input_text_tokens = cachedContentTokens;
        }
    }

    if (typeof record.thoughtsTokenCount === "number" && record.thoughtsTokenCount > 0) {
        billingMetrics.reasoning_tokens = record.thoughtsTokenCount;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens: typeof record.totalTokenCount === "number" ? record.totalTokenCount : promptTokens + completionTokens,
        ...(cachedContentTokens !== undefined ? { cachedInputTokens: cachedContentTokens } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
    };
}

// =============================================================================
// Image Generation (Nano Banana / Nano Banana Pro)
// =============================================================================

export function imageApi(modelId: string): "content" | "images" {
    const card = getModelById(modelId, "gemini");
    const output = Array.isArray(card?.output)
        ? card.output.map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
        : [];
    return output.includes("image") && !output.includes("text") ? "images" : "content";
}

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
        referenceImages?: Array<Buffer | { buffer: Buffer; mimeType: string }>;
        aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
        numberOfImages?: number;
        outputMimeType?: "image/png" | "image/jpeg" | "image/webp";
        signal?: AbortSignal;
    }
): Promise<{
    buffer: Buffer;
    mimeType: string;
    images: Array<{ buffer: Buffer; mimeType: string }>;
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
        if (imageApi(cleanModelId) === "images" && !options?.referenceImages?.length) {
            const response = await client.models.generateImages({
                model: cleanModelId,
                prompt,
                config: {
                    ...(options?.aspectRatio && { aspectRatio: options.aspectRatio }),
                    ...(options?.numberOfImages && { numberOfImages: options.numberOfImages }),
                     ...(options?.outputMimeType && { outputMimeType: options.outputMimeType }),
                     ...(options?.signal ? { abortSignal: options.signal } : {}),
                 },
             });
            const images = (response.generatedImages || [])
                .map((generated) => generated.image)
                .filter((image): image is NonNullable<typeof image> => Boolean(image?.imageBytes))
                .map((image) => ({
                    buffer: Buffer.from(image.imageBytes!, "base64"),
                    mimeType: image.mimeType || options?.outputMimeType || "image/png",
                }));
            if (images.length === 0) {
                throw new Error("No generated image data in response");
            }
            return {
                ...images[0],
                images,
                usage: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    billingMetrics: { image: images.length },
                },
            };
        }

        // Build content parts
        const parts: GenPart[] = [{ text: prompt }];

        // Add reference images if provided (for image editing / multi-image reference)
        if (options?.referenceImages) {
            for (const reference of options.referenceImages) {
                const imageBuffer = Buffer.isBuffer(reference) ? reference : reference.buffer;
                parts.push({
                    inlineData: {
                        data: imageBuffer.toString("base64"),
                        mimeType: Buffer.isBuffer(reference) ? "image/png" : reference.mimeType,
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
                ...(options?.signal ? { abortSignal: options.signal } : {}),
            },
        }) as GenerateContentResponse;

        const usage = normalizeUsageMetadata(response.usageMetadata);

        const candidates = response.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error("No candidates in response");
        }

        const parts2 = candidates.flatMap((candidate) => candidate.content?.parts || []);
        if (parts2.length === 0) {
            throw new Error("No content parts in response");
        }

        const images = parts2.flatMap((part) => "inlineData" in part && part.inlineData?.data
            ? [{
                buffer: Buffer.from(part.inlineData.data, "base64"),
                mimeType: part.inlineData.mimeType || options?.outputMimeType || "image/png",
            }]
            : []);
        if (images.length > 0) return { ...images[0], images, ...(usage ? { usage } : {}) };

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
        signal?: AbortSignal;
    }
): AsyncGenerator<
    | { type: "thinking"; text: string }
    | { type: "image-partial"; base64: string; mimeType?: string; index: number }
    | { type: "image-complete"; base64: string; mimeType?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics?: Record<string, unknown> } }
> {
    if (options?.signal?.aborted) {
        throw (options.signal.reason instanceof Error ? options.signal.reason : new Error("request aborted"));
    }
    if (imageApi(modelId) === "images" && !options?.referenceImages?.length) {
        const result = await generateImage(modelId, prompt, {
            aspectRatio: options?.aspectRatio as "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined,
            numberOfImages: options?.numberOfImages,
            outputMimeType: options?.outputMimeType as "image/png" | "image/jpeg" | "image/webp" | undefined,
        });
        yield {
            type: "image-complete",
            base64: result.buffer.toString("base64"),
            mimeType: options?.outputMimeType || "image/png",
            ...(result.usage ? { usage: result.usage } : {}),
        };
        return;
    }

    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");

    const parts: GenPart[] = [{ text: prompt }];
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
        if (options?.signal?.aborted) {
            throw (options.signal.reason instanceof Error ? options.signal.reason : new Error("request aborted"));
        }
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
    if (!GOOGLE_API_KEY) {
        throw new Error("Google API key not configured");
    }
    const cleanModelId = modelId.replace("models/", "");

    console.log(`[genai] Generating speech with model: ${cleanModelId}`);

    const endpoint = `${BASE_URL}/v1beta/models/${cleanModelId}:generateContent`;

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
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GOOGLE_API_KEY,
            },
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

export async function generateMusic(
    modelId: string,
    text: string,
    options?: {
        image?: Buffer;
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
    const client = getClient();
    const cleanModelId = modelId.replace("models/", "");
    const parts: GenPart[] = [];

    if (options?.image) {
        parts.push({
            inlineData: {
                data: options.image.toString("base64"),
                mimeType: "image/png",
            },
        });
    }
    parts.push({ text });

    const response = await client.models.generateContent({
        model: cleanModelId,
        contents: [{ role: "user", parts }],
        config: {
            responseModalities: ["AUDIO", "TEXT"],
        },
    }) as GenerateContentResponse;

    const usage = normalizeUsageMetadata(response.usageMetadata);
    const candidates = response.candidates || [];
    for (const candidate of candidates) {
        for (const part of candidate.content?.parts || []) {
            const inline = ((part as { inlineData?: unknown }).inlineData
                || (part as { inline_data?: unknown }).inline_data) as Record<string, unknown> | undefined;
            const data = inline?.data;
            const mimeType = typeof inline?.mimeType === "string"
                ? inline.mimeType
                : typeof inline?.mime_type === "string"
                    ? inline.mime_type
                    : "audio/wav";
            if (typeof data === "string" && mimeType.toLowerCase().includes("audio")) {
                return {
                    buffer: Buffer.from(data, "base64"),
                    mimeType,
                    ...(usage ? { usage } : {}),
                };
            }
        }
    }

    throw new Error(`Music generation returned no audio for model ${cleanModelId}`);
}

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
// usageMetadata → Usage with per-modality billing metrics.

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
import { bufferFromPayload } from "../shared/media.js";
import * as lower from "../shared/schema.js";

export interface GoogleWireEndpoint {
    /** Base URL up to but not including `/models/{modelId}:...`. */
    baseURL: string;
    /** Bearer access token (Vertex) OR API key (Gemini). */
    apiKey: string;
    /** "key" sends x-goog-api-key header (Gemini). "bearer" sends Authorization: Bearer (Vertex). */
    authStyle: "key" | "bearer";
    extraHeaders?: Record<string, string>;
}

export interface GoogleWireChatOptions {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: Request["responseFormat"];
    /** systemInstruction (Google's first-class field). */
    systemInstruction?: string;
    /** Cached signature lookup keyed by toolCallId. Caller owns the cache. */
    thoughtSignatureLookup?: (toolCallId: string) => string | undefined | Promise<string | undefined>;
    /** Sink for thoughtSignatures observed on the wire. Caller owns the cache. */
    onThoughtSignature?: (toolCallId: string, signature: string) => unknown;
    customParams?: Record<string, unknown>;
    signal?: AbortSignal;
}

export interface GoogleWireEmbeddingsOptions {
    taskType?: string;
    title?: string;
    outputDimensionality?: number;
    contents?: GoogleEmbeddingContent[];
    signal?: AbortSignal;
}

export interface GoogleEmbeddingContent {
    parts: Array<Record<string, unknown>>;
}

function hasGoogleUsageBreakdown(usage?: Usage): boolean {
    return Boolean(usage?.billingMetrics && Object.keys(usage.billingMetrics).some((key) => /^input_.*_tokens$/u.test(key)));
}

function asGoogleRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanGoogle(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function thoughtSignatureFromMetadata(value: unknown): string {
    const metadata = asGoogleRecord(value);
    if (!metadata) return "";
    const direct = cleanGoogle(metadata.thoughtSignature) || cleanGoogle(metadata.thought_signature);
    if (direct) return direct;
    const google = asGoogleRecord(metadata.google);
    return cleanGoogle(google?.thoughtSignature) || cleanGoogle(google?.thought_signature);
}

function googleEndpointHeaders(endpoint: GoogleWireEndpoint): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.authStyle === "bearer" && endpoint.apiKey) {
        headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
    } else if (endpoint.authStyle === "key" && endpoint.apiKey) {
        headers["x-goog-api-key"] = endpoint.apiKey;
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
    return `${base}/models/${cleanModel}:${action}`;
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

function mimeFromLocator(locator: string, fallback: string): string {
    const lower = locator.split(/[?#]/, 1)[0]?.toLowerCase() || "";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mov")) return "video/quicktime";
    return fallback;
}

async function inlinePart(locator: string, fallbackMimeType: string): Promise<Record<string, unknown>> {
    const media = await bufferFromPayload(locator, fallbackMimeType);
    return {
        inlineData: {
            mimeType: media.mimeType || fallbackMimeType,
            data: media.buffer.toString("base64"),
        },
    };
}

async function partsFromGoogleContent(content: unknown): Promise<Array<Record<string, unknown>>> {
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
                parts.push(await inlinePart(url, mimeFromLocator(url, "image/png")));
            }
            continue;
        }
        if (type === "input_audio") {
            const value = part.input_audio;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) parts.push(await inlinePart(url, mimeFromLocator(url, "audio/mpeg")));
            continue;
        }
        if (type === "video_url") {
            const value = part.video_url;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) parts.push(await inlinePart(url, mimeFromLocator(url, "video/mp4")));
            continue;
        }
    }
    return parts;
}

async function inlineEmbeddingPart(locator: string, fallbackMimeType: string): Promise<Record<string, unknown>> {
    const media = await bufferFromPayload(locator, fallbackMimeType);
    return {
        inlineData: {
            mimeType: media.mimeType || fallbackMimeType,
            data: media.buffer.toString("base64"),
        },
    };
}

async function embeddingPartsFromGoogleContent(content: unknown): Promise<Array<Record<string, unknown>>> {
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
            if (url) parts.push(await inlineEmbeddingPart(url, mimeFromLocator(url, "image/png")));
            continue;
        }
        if (type === "input_audio") {
            const value = part.input_audio;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) parts.push(await inlineEmbeddingPart(url, mimeFromLocator(url, "audio/mpeg")));
            continue;
        }
        if (type === "video_url") {
            const value = part.video_url;
            const url = typeof value === "string" ? value : cleanGoogle(asGoogleRecord(value)?.url);
            if (url) parts.push(await inlineEmbeddingPart(url, mimeFromLocator(url, "video/mp4")));
            continue;
        }
    }
    return parts;
}

export async function embeddingContentsFromMessages(
    messages: Message[],
    fallbackTexts: string[] = [],
): Promise<GoogleEmbeddingContent[]> {
    const parts: Array<Record<string, unknown>> = [];

    for (const message of messages) {
        parts.push(...await embeddingPartsFromGoogleContent(message.content));
    }

    if (parts.length > 0) {
        return [{ parts }];
    }

    return fallbackTexts
        .filter((text) => text.length > 0)
        .map((text) => ({ parts: [{ text }] }));
}

async function mapMessagesForGoogleWire(
    messages: Message[],
    options: { thoughtSignatureLookup?: (toolCallId: string) => string | undefined | Promise<string | undefined> } = {},
): Promise<{ systemInstruction: string | null; contents: Array<Record<string, unknown>> }> {
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
            const callId = cleanGoogle(message.tool_call_id);
            let resolvedName = cleanGoogle(message.name);
            if (!resolvedName && callId) {
                for (let back = messages.indexOf(message) - 1; back >= 0; back -= 1) {
                    const prevMsg = messages[back];
                    if (prevMsg?.role === "assistant" && Array.isArray(prevMsg.tool_calls)) {
                        const matched = prevMsg.tool_calls.find((tc) => tc.id === callId);
                        if (matched?.function?.name) {
                            resolvedName = cleanGoogle(matched.function.name);
                            break;
                        }
                    }
                }
            }
            const callIdent = resolvedName || callId || "tool";
            let response: unknown;
            try {
                response = JSON.parse(text);
            } catch {
                response = { result: text };
            }
            const fnPart = {
                functionResponse: {
                    name: callIdent,
                    response: typeof response === "object" && response !== null && !Array.isArray(response) ? response : { result: response },
                },
            };
            const last = contents[contents.length - 1];
            const lastParts = last && last.role === "user" && Array.isArray(last.parts) ? last.parts : null;
            const lastIsFunctionResponseTurn = Boolean(
                lastParts
                && lastParts.length > 0
                && lastParts.every((p) => Boolean(asGoogleRecord(p)?.functionResponse)),
            );
            if (lastIsFunctionResponseTurn && lastParts) {
                lastParts.push(fnPart);
            } else {
                contents.push({
                    role: "user",
                    parts: [fnPart],
                });
            }
            continue;
        }

        if (message.role === "assistant") {
            const parts: Array<Record<string, unknown>> = [];
            if (typeof message.content === "string" && message.content.length > 0) {
                parts.push({ text: message.content });
            } else if (Array.isArray(message.content)) {
                for (const p of await partsFromGoogleContent(message.content)) parts.push(p);
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
                    const sig = thoughtSignatureFromMetadata(call.providerMetadata)
                        || await options.thoughtSignatureLookup?.(call.id);
                    parts.push({ functionCall: fn, ...(sig ? { thoughtSignature: sig } : {}) });
                }
            }
            if (parts.length > 0) contents.push({ role: "model", parts });
            continue;
        }

        const parts = await partsFromGoogleContent(message.content);
        if (parts.length > 0) contents.push({ role: "user", parts });
    }

    return { systemInstruction, contents };
}

function googleToolsToWire(tools: Tool[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    const declarations: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
        if (tool.type !== "function" || !tool.name) continue;
        declarations.push({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: lower.google(lower.object(tool.parameters)),
        });
    }
    if (declarations.length === 0) return undefined;
    return [{ functionDeclarations: declarations }];
}

function googleToolConfigToWire(toolChoice: Choice | undefined): Record<string, unknown> | undefined {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") {
        if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
        if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
        return { functionCallingConfig: { mode: "AUTO" } };
    }
    if (toolChoice.type === "function" && toolChoice.name) {
        return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.name] } };
    }
    return undefined;
}

const GOOGLE_GENERATION_CONFIG = new Set([
    "audioTimestamp",
    "candidateCount",
    "enableAffectiveDialog",
    "enableEnhancedCivicAnswers",
    "frequencyPenalty",
    "logprobs",
    "maxOutputTokens",
    "mediaResolution",
    "presencePenalty",
    "responseJsonSchema",
    "responseLogprobs",
    "responseMimeType",
    "responseModalities",
    "responseSchema",
    "seed",
    "speechConfig",
    "stopSequences",
    "temperature",
    "thinkingConfig",
    "topK",
    "topP",
]);

const GOOGLE_GENERATION_ALIASES = new Map([
    ["audio_timestamp", "audioTimestamp"],
    ["candidate_count", "candidateCount"],
    ["enable_affective_dialog", "enableAffectiveDialog"],
    ["enable_enhanced_civic_answers", "enableEnhancedCivicAnswers"],
    ["frequency_penalty", "frequencyPenalty"],
    ["max_output_tokens", "maxOutputTokens"],
    ["media_resolution", "mediaResolution"],
    ["presence_penalty", "presencePenalty"],
    ["response_json_schema", "responseJsonSchema"],
    ["response_logprobs", "responseLogprobs"],
    ["response_mime_type", "responseMimeType"],
    ["response_modalities", "responseModalities"],
    ["response_schema", "responseSchema"],
    ["speech_config", "speechConfig"],
    ["stop", "stopSequences"],
    ["stop_sequences", "stopSequences"],
    ["thinking_config", "thinkingConfig"],
    ["top_k", "topK"],
    ["top_p", "topP"],
]);

const GOOGLE_THINKING_ALIASES = new Map([
    ["includeThoughts", "includeThoughts"],
    ["include_thoughts", "includeThoughts"],
    ["thinkingBudget", "thinkingBudget"],
    ["thinking_budget", "thinkingBudget"],
    ["thinkingLevel", "thinkingLevel"],
    ["thinking_level", "thinkingLevel"],
]);

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
            cfg.responseSchema = lower.google(opts.responseFormat.json_schema.schema);
        }
    }
    if (opts.customParams) {
        const thinkingFields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(opts.customParams)) {
            if (value === undefined) continue;
            const thinkingField = GOOGLE_THINKING_ALIASES.get(key);
            if (thinkingField) {
                thinkingFields[thinkingField] = value;
                continue;
            }
            const field = GOOGLE_GENERATION_ALIASES.get(key) || key;
            if (!GOOGLE_GENERATION_CONFIG.has(field)) continue;
            if (cfg[field] === undefined) cfg[field] = value;
        }
        if (Object.keys(thinkingFields).length > 0) {
            const existingThinking = cfg.thinkingConfig && typeof cfg.thinkingConfig === "object" && !Array.isArray(cfg.thinkingConfig)
                ? cfg.thinkingConfig as Record<string, unknown>
                : {};
            cfg.thinkingConfig = { ...thinkingFields, ...existingThinking };
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

export function usageFromGoogleWire(rawUsage: unknown): Usage | undefined {
    const usage = asGoogleRecord(rawUsage);
    if (!usage) return undefined;
    const promptTokens = readNonNegGoogle(usage, ["promptTokenCount"]) ?? 0;
    const candidateTokens = readNonNegGoogle(usage, ["candidatesTokenCount", "responseTokenCount"]) ?? 0;
    const reasoningTokens = readNonNegGoogle(usage, ["thoughtsTokenCount"]);
    const cachedInputTokens = readNonNegGoogle(usage, ["cachedContentTokenCount"]);
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
    if (typeof cachedInputTokens === "number" && cachedInputTokens > 0) {
        billingMetrics.cached_input_tokens = cachedInputTokens;
        if (billingMetrics.cached_input_text_tokens === undefined && !Array.isArray(usage.cacheTokensDetails)) {
            billingMetrics.cached_input_text_tokens = cachedInputTokens;
        }
    }
    if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
        billingMetrics.reasoning_tokens = reasoningTokens;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        raw: usage,
    };
}

function usageFromGoogleTokenCount(raw: unknown): Usage | undefined {
    const data = asGoogleRecord(raw);
    if (!data) return undefined;
    const totalTokens = readNonNegGoogle(data, ["totalTokens", "total_tokens"]) ?? 0;
    const billingMetrics: Record<string, unknown> = {};
    const details = Array.isArray(data.promptTokensDetails) ? data.promptTokensDetails : [];
    for (const entry of details) {
        const record = asGoogleRecord(entry);
        const tokenCount = readNonNegGoogle(record ?? undefined, ["tokenCount"]);
        if (typeof tokenCount !== "number" || tokenCount <= 0) continue;
        const modality = cleanGoogle(record?.modality).toLowerCase();
        if (!modality) continue;
        billingMetrics[`input_${modality}_tokens`] = tokenCount;
    }

    return {
        promptTokens: totalTokens,
        completionTokens: 0,
        totalTokens,
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        ...(data ? { raw: data } : {}),
    };
}

async function countEmbeddingTokens(
    endpoint: GoogleWireEndpoint,
    modelId: string,
    contents: GoogleEmbeddingContent[],
    signal?: AbortSignal,
): Promise<Usage | undefined> {
    if (contents.length === 0) return undefined;
    const url = googleEndpointUrl(endpoint, modelId, "countTokens");
    const response = await fetch(url, {
        method: "POST",
        headers: googleEndpointHeaders(endpoint),
        body: JSON.stringify({
            contents: contents.map((content) => ({ role: "user", parts: content.parts })),
        }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`Google-genai countTokens HTTP ${response.status}: ${await readGoogleErrorBody(response)}`);
    }
    return usageFromGoogleTokenCount(await response.json());
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

async function buildGoogleBody(
    messages: Message[],
    opts?: GoogleWireChatOptions,
): Promise<Record<string, unknown>> {
    const { systemInstruction, contents } = await mapMessagesForGoogleWire(messages, {
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

async function extractToolCallsAndCaptureSignatures(
    candidate: Record<string, unknown> | null,
    onSignature?: (toolCallId: string, signature: string) => unknown,
): Promise<{ text: string; reasoning: string; toolCalls: Call[] }> {
    let text = "";
    let reasoning = "";
    const toolCalls: Call[] = [];
    const content = asGoogleRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content!.parts : [];
    let toolCallIndex = 0;
    for (const part of parts) {
        const record = asGoogleRecord(part);
        if (!record) continue;
        if (typeof record.text === "string") {
            if (record.thought === true) reasoning += record.text;
            else text += record.text;
            continue;
        }
        const fc = asGoogleRecord(record.functionCall);
        if (fc) {
            const id = `gemini_call_${toolCallIndex}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
            const name = cleanGoogle(fc.name);
            const args = fc.args !== undefined ? fc.args : {};
            const sig = cleanGoogle(record.thoughtSignature)
                || cleanGoogle(record.thought_signature)
                || cleanGoogle(fc.thoughtSignature)
                || cleanGoogle(fc.thought_signature);
            if (sig && onSignature) await onSignature(id, sig);
            toolCalls.push({
                id,
                callId: id,
                outputIndex: toolCallIndex,
                name,
                arguments: typeof args === "string" ? args : JSON.stringify(args),
                ...(sig ? { providerMetadata: { google: { thoughtSignature: sig } } } : {}),
            });
            toolCallIndex += 1;
        }
    }
    return { text, reasoning, toolCalls };
}

// ---------------------------------------------------------------------------
// chat (non-streaming)
// ---------------------------------------------------------------------------

export async function chat(
    endpoint: GoogleWireEndpoint,
    modelId: string,
    messages: Message[],
    opts?: GoogleWireChatOptions,
): Promise<Output> {
    const url = googleEndpointUrl(endpoint, modelId, "generateContent");
    const headers = googleEndpointHeaders(endpoint);
    const body = await buildGoogleBody(messages, opts);

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
    const { text, reasoning, toolCalls } = await extractToolCallsAndCaptureSignatures(first, opts?.onThoughtSignature);
    const usage = usageFromGoogleWire(data.usageMetadata);
    return {
        modality: "text",
        content: text,
        ...(reasoning ? { reasoning } : {}),
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
    messages: Message[],
    opts?: GoogleWireChatOptions,
): AsyncGenerator<Event> {
    const baseUrl = googleEndpointUrl(endpoint, modelId, "streamGenerateContent");
    const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "alt=sse";
    const headers = googleEndpointHeaders(endpoint);
    const body = await buildGoogleBody(messages, opts);

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
    let lastUsage: Usage | undefined;
    let lastFinishReason: string | undefined;
    let toolCallIndex = 0;
    let sawToolCall = false;

    const take = (): string | null => {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) return null;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        return raw;
    };

    const parse = async (raw: string): Promise<Event[]> => {
        const dataLines = raw
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) return [];
        const data = dataLines.join("\n").trim();
        if (!data) return [];

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
            return [];
        }

        if (parsed.usageMetadata) {
            const u = usageFromGoogleWire(parsed.usageMetadata);
            if (u) lastUsage = u;
        }

        const events: Event[] = [];
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const candidate = asGoogleRecord(candidates[0]);
        if (!candidate) return events;
        const content = asGoogleRecord(candidate.content);
        const parts = Array.isArray(content?.parts) ? content!.parts : [];
        for (const part of parts) {
            const record = asGoogleRecord(part);
            if (!record) continue;
            if (record.thought === true && typeof record.text === "string" && record.text.length > 0) {
                events.push({ type: "thinking", thinking: record.text });
                continue;
            }
            if (typeof record.text === "string" && record.text.length > 0) {
                events.push({ type: "text-delta", text: record.text });
                continue;
            }
            const fc = asGoogleRecord(record.functionCall);
            if (fc) {
                const id = `gemini_call_${toolCallIndex}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
                const name = cleanGoogle(fc.name);
                const args = fc.args !== undefined ? fc.args : {};
                const sig = cleanGoogle(record.thoughtSignature)
                    || cleanGoogle(record.thought_signature)
                    || cleanGoogle(fc.thoughtSignature)
                    || cleanGoogle(fc.thought_signature);
                if (sig && opts?.onThoughtSignature) await opts.onThoughtSignature(id, sig);
                const argString = typeof args === "string" ? args : JSON.stringify(args);
                sawToolCall = true;
                events.push({
                    type: "tool-call",
                    toolCall: {
                        id,
                        callId: id,
                        index: toolCallIndex,
                        name,
                        arguments: argString,
                        ...(sig ? { providerMetadata: { google: { thoughtSignature: sig } } } : {}),
                    },
                });
                toolCallIndex += 1;
            }
        }
        const fr = cleanGoogle(candidate.finishReason);
        if (fr) lastFinishReason = fr;
        return events;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            while (true) {
                const raw = take();
                if (raw === null) break;
                for (const event of await parse(raw)) yield event;
            }
        }
        if (buffer.trim().length > 0) {
            for (const event of await parse(buffer)) yield event;
        }
    } finally {
        try { reader.releaseLock(); } catch { /* best-effort */ }
    }

    yield {
        type: "done",
        finishReason: finishReasonFromGoogleWire(lastFinishReason, sawToolCall),
        ...(lastUsage ? { usage: lastUsage } : {}),
    };
}

// ---------------------------------------------------------------------------
// embeddings
// ---------------------------------------------------------------------------

export interface GoogleWireEmbeddingsResult {
    embeddings: number[][];
    usage?: Usage;
    raw: unknown;
}

export async function embeddings(
    endpoint: GoogleWireEndpoint,
    modelId: string,
    input: string[] | string,
    opts?: GoogleWireEmbeddingsOptions,
): Promise<GoogleWireEmbeddingsResult> {
    const inputs = Array.isArray(input) ? input : [input];
    const contents = opts?.contents?.filter((content) => Array.isArray(content.parts) && content.parts.length > 0) ?? [];
    const useContent = contents.length > 0;
    const useBatch = useContent ? contents.length > 1 : inputs.length > 1;
    const url = googleEndpointUrl(endpoint, modelId, useBatch ? "batchEmbedContents" : "embedContent");
    const headers = googleEndpointHeaders(endpoint);

    const requestPart = (content: GoogleEmbeddingContent): Record<string, unknown> => ({
        model: `models/${modelId.replace(/^models\//, "")}`,
        content,
        ...(opts?.taskType ? { taskType: opts.taskType } : {}),
        ...(opts?.title ? { title: opts.title } : {}),
        ...(typeof opts?.outputDimensionality === "number" ? { outputDimensionality: opts.outputDimensionality } : {}),
    });

    const textContents = inputs.map((text) => ({ parts: [{ text }] }));
    const requestContents = useContent ? contents : textContents;
    const body: Record<string, unknown> = useBatch
        ? { requests: requestContents.map(requestPart) }
        : requestPart(requestContents[0] || { parts: [{ text: "" }] });

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
    let usage = usageFromGoogleWire(data.usageMetadata);
    if (useContent && !hasGoogleUsageBreakdown(usage)) {
        usage = await countEmbeddingTokens(endpoint, modelId, requestContents, opts?.signal);
    }

    return {
        embeddings: out,
        usage,
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
