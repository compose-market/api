import {
    bufferFromPayload,
    imageMimeType,
} from "../shared/media.js";
import { getModelById } from "../registry.js";
import { rerankBillingMetrics } from "../modalities/rerank.js";

/**
 * Cloudflare Workers AI Provider Module
 *
 * Runtime provider for Cloudflare Workers AI models.
 * Handles capabilities NOT covered by OpenAI-compatible SDK:
 *   - Image generation (text-to-image via REST API)
 *   - Text-to-speech (TTS via REST API)
 *   - Automatic speech recognition (ASR via REST API)
 *
 * Text chat/completion and embeddings use createOpenAICompatible in modelsRegistry.ts.
 *
 * API Docs:
 *   - REST API: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
 *   - Models: https://developers.cloudflare.com/workers-ai/models/
 *   - OpenAI compat: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
 *
 * All endpoints use: POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model_id}
 * Auth: Bearer token with CF_API_TOKEN
 */

const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;

if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
    console.warn("[cloudflare] CF_API_TOKEN or CF_ACCOUNT_ID not set — image gen, TTS, and ASR disabled");
}

const CF_API_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run`;

// =============================================================================
// Shared request helper
// =============================================================================

interface CloudflareAPIResponse {
    success: boolean;
    errors: { code: number; message: string }[];
    messages: string[];
    result: unknown;
}

interface CloudflareTextResult {
    text: string;
    raw: unknown;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        billingMetrics?: Record<string, unknown>;
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function unwrap(data: unknown): unknown {
    const record = asRecord(data);
    if (!record || typeof record.success !== "boolean") {
        return data;
    }
    if (!record.success) {
        const errors = Array.isArray(record.errors) ? record.errors : [];
        throw new Error(`Cloudflare API error: ${errors.map((entry) => clean(asRecord(entry)?.message)).filter(Boolean).join(", ")}`);
    }
    return "result" in record ? record.result : data;
}

function params(modelId: string): Set<string> {
    const card = getModelById(modelId, "cloudflare");
    const input = asRecord(card?.params)?.input;
    return new Set(
        (Array.isArray(input) ? input : [])
            .map((entry) => clean(entry))
            .filter(Boolean),
    );
}

function scalar(value: unknown): value is string | number | boolean {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function cfUrl(modelId: string, query?: URLSearchParams): string {
    const suffix = query && Array.from(query.keys()).length > 0 ? `?${query.toString()}` : "";
    return `${CF_API_BASE}/${modelId}${suffix}`;
}

async function cfFetch(
    modelId: string,
    init: RequestInit,
    query?: URLSearchParams,
): Promise<Response> {
    if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
        throw new Error("CF_API_TOKEN or CF_ACCOUNT_ID not configured");
    }

    const url = cfUrl(modelId, query);

    console.log(`[cloudflare] POST ${url}`);

    const response = await fetch(url, init);

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Cloudflare API error: ${response.status} ${response.statusText} — ${errorBody.substring(0, 500)}`
        );
    }

    return response;
}

async function cfRequest(
    modelId: string,
    body: Record<string, unknown>,
    accept: string = "application/json",
    signal?: AbortSignal,
): Promise<Response> {
    return cfFetch(modelId, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CF_API_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": accept,
        },
        body: JSON.stringify(body),
        signal,
    });
}

async function cfMultipartRequest(modelId: string, form: FormData, signal?: AbortSignal): Promise<Response> {
    return cfFetch(modelId, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CF_API_TOKEN}`,
            "Accept": "application/json",
        },
        body: form,
        signal,
    });
}

async function cfRawRequest(
    modelId: string,
    body: BodyInit,
    contentType: string,
    query?: URLSearchParams,
    signal?: AbortSignal,
): Promise<Response> {
    return cfFetch(modelId, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CF_API_TOKEN}`,
            "Content-Type": contentType,
            "Accept": "application/json",
        },
        body,
        signal,
    }, query);
}

function append(form: FormData, key: string, value: unknown): void {
    if (scalar(value)) form.append(key, String(value));
}

async function imageFromResponse(response: Response): Promise<{ buffer: Buffer; mimeType: string }> {
    const contentType = response.headers.get("content-type") || "image/png";
    if (contentType.toLowerCase().includes("application/json")) {
        const data = await response.json() as unknown;
        const result = unwrap(data);
        const record = asRecord(result);
        const image = clean(record?.image);
        if (!image) {
            throw new Error("Cloudflare image response did not include image data");
        }
        const media = image.startsWith("data:")
            ? await bufferFromPayload(image, "image/jpeg")
            : {
                buffer: Buffer.from(image, "base64"),
                mimeType: "image/jpeg",
            };
        const mimeType = imageMimeType(media.buffer, media.mimeType);
        console.log(`[cloudflare] Image generated: ${media.buffer.length} bytes (${mimeType})`);
        return {
            buffer: media.buffer,
            mimeType,
        };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    console.log(`[cloudflare] Image generated: ${buffer.length} bytes (${contentType})`);
    return { buffer, mimeType: contentType };
}


// =============================================================================
// Image Generation — Text-to-Image
// =============================================================================
// Models: @cf/stabilityai/stable-diffusion-xl-base-1.0, @cf/lykon/dreamshaper-8-lcm, etc.
// Endpoint: POST /ai/run/{model_id}
// Input: { prompt, width?, height?, num_steps?, guidance? }
// Output: raw image bytes (PNG)

export interface CloudflareImageOptions {
    /** Image width (default: model-specific) */
    width?: number;
    /** Image height (default: model-specific) */
    height?: number;
    /** Number of diffusion steps */
    num_steps?: number;
    /** Guidance scale */
    guidance?: number;
    /** Provider-native request parameters */
    parameters?: Record<string, unknown>;
    signal?: AbortSignal;
}

/**
 * Generate an image using Cloudflare Workers AI.
 *
 * @param modelId Full model ID (e.g. "@cf/stabilityai/stable-diffusion-xl-base-1.0")
 * @param prompt Text prompt for image generation
 * @param options Generation options
 * @returns Buffer of the generated image
 */
export async function generateCloudflareImage(
    modelId: string,
    prompt: string,
    options: CloudflareImageOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const keys = params(modelId);
    if (keys.has("multipart")) {
        const form = new FormData();
        const native = options.parameters || {};
        append(form, "prompt", prompt);
        append(form, "width", options.width ?? native.width);
        append(form, "height", options.height ?? native.height);
        append(form, "steps", native.steps ?? native.num_steps ?? options.num_steps);
        append(form, "guidance", options.guidance ?? native.guidance ?? native.guidance_scale);
        for (const [key, value] of Object.entries(native)) {
            if (["prompt", "width", "height", "steps", "num_steps", "guidance", "guidance_scale"].includes(key)) {
                continue;
            }
            append(form, key, value);
        }
        return imageFromResponse(await cfMultipartRequest(modelId, form, options.signal));
    }

    const body: Record<string, unknown> = {
        prompt,
        ...(options.parameters || {}),
    };
    if (options.width != null) body.width = options.width;
    if (options.height != null) body.height = options.height;
    if (options.num_steps != null) body.num_steps = options.num_steps;
    if (options.guidance != null) body.guidance = options.guidance;

    // Request raw image bytes
    return imageFromResponse(await cfRequest(modelId, body, "image/*", options.signal));
}


// =============================================================================
// Image Analysis — Object Detection / Classification
// =============================================================================

export async function analyzeCloudflareImage(
    modelId: string,
    imageBuffer: Buffer,
): Promise<{ text: string; raw: unknown }> {
    const response = await cfRequest(modelId, {
        image: Array.from(imageBuffer.values()),
    });
    const data = await response.json() as CloudflareAPIResponse;
    const result = unwrap(data);
    return {
        text: JSON.stringify(result),
        raw: result,
    };
}

export async function analyzeCloudflareVision(
    modelId: string,
    imageBuffer: Buffer,
    prompt: string,
    native: Record<string, unknown> = {},
): Promise<{ text: string; raw: unknown }> {
    const keys = params(modelId);
    const body: Record<string, unknown> = {
        image: Array.from(imageBuffer.values()),
    };
    if (prompt) body.prompt = prompt;
    for (const [key, value] of Object.entries(native)) {
        if (key === "image" || key === "prompt") continue;
        if (keys.has(key) && scalar(value)) body[key] = value;
    }

    const response = await cfRequest(modelId, body);
    const data = await response.json() as CloudflareAPIResponse;
    const result = unwrap(data);
    const record = asRecord(result);
    const text = clean(record?.description)
        || clean(record?.text)
        || clean(record?.response)
        || clean(record?.result)
        || (typeof result === "string" ? result : JSON.stringify(result));
    return { text, raw: result };
}


// =============================================================================
// Translation
// =============================================================================

export async function translateCloudflareText(
    modelId: string,
    text: string,
    params: Record<string, unknown> = {},
): Promise<{ text: string; raw: unknown }> {
    const id = modelId.toLowerCase();
    const targetLanguage = id.includes("indictrans2")
        ? clean(params.target_language) || clean(params.target_lang)
        : clean(params.target_lang) || clean(params.target_language);
    const body = id.includes("indictrans2")
        ? {
            text,
            target_language: targetLanguage || "hin_Deva",
        }
        : {
            text,
            ...(clean(params.source_lang) ? { source_lang: clean(params.source_lang) } : {}),
            target_lang: targetLanguage,
        };

    if (!id.includes("indictrans2") && !targetLanguage) {
        throw Object.assign(new Error("Cloudflare translation requires target_lang"), { statusCode: 400 });
    }

    const response = await cfRequest(modelId, body);
    const data = await response.json() as CloudflareAPIResponse;
    const result = unwrap(data);
    const record = asRecord(result);
    const translations = Array.isArray(record?.translations) ? record.translations : [];
    const translated = translations.map(clean).filter(Boolean).join("\n")
        || clean(record?.translated_text)
        || clean(record?.translation)
        || clean(record?.text)
        || (typeof result === "string" ? result : "");

    return {
        text: translated,
        raw: result,
    };
}

export async function rerankCloudflareText(
    modelId: string,
    query: string,
    documents: Array<string | Record<string, unknown>>,
    options: Record<string, unknown> = {},
): Promise<CloudflareTextResult> {
    const contexts = documents
        .map((document) => {
            if (typeof document === "string") return { text: document };
            const text = clean(document.text);
            return text ? { text } : { text: JSON.stringify(document) };
        })
        .filter((document) => document.text.length > 0);
    if (!query) {
        throw Object.assign(new Error("Cloudflare rerank requires query"), { statusCode: 400 });
    }
    if (contexts.length === 0) {
        throw Object.assign(new Error("Cloudflare rerank requires contexts"), { statusCode: 400 });
    }

    const body: Record<string, unknown> = { query, contexts };
    if (typeof options.top_k === "number") body.top_k = options.top_k;
    if (typeof options.top_n === "number") body.top_k = options.top_n;

    const response = await cfRequest(modelId, body);
    const data = await response.json() as CloudflareAPIResponse;
    const result = unwrap(data);
    return {
        text: JSON.stringify(result),
        raw: result,
        usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            billingMetrics: rerankBillingMetrics(contexts.length),
        },
    };
}


// =============================================================================
// Text-to-Speech (TTS)
// =============================================================================
// Endpoint: POST /ai/run/{model_id}
// Input: { text }
// Output: raw audio bytes

/**
 * Generate speech audio using Cloudflare Workers AI.
 *
 * @param modelId Full model ID
 * @param text Text to convert to speech
 * @returns Buffer of the generated audio
 */
export async function generateCloudflareSpeech(
    modelId: string,
    text: string,
    options: Record<string, unknown> = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const keys = params(modelId);
    const body: Record<string, unknown> = keys.has("prompt") && !keys.has("text")
        ? { prompt: text }
        : { text };
    if (keys.has("lang")) body.lang = clean(options.lang) || clean(options.language) || "en";
    for (const [key, value] of Object.entries(options)) {
        if (key === "text" || key === "prompt" || key === "lang" || key === "language") continue;
        if (keys.has(key) && scalar(value)) body[key] = value;
    }
    const response = await cfRequest(modelId, body, "audio/*");
    const contentType = response.headers.get("content-type") || "audio/mpeg";
    let mimeType = contentType;
    let buffer: Buffer;
    if (contentType.toLowerCase().includes("application/json")) {
        const payload = await response.json() as unknown;
        const result = asRecord(unwrap(payload));
        const audio = clean(result?.audio) || clean(result?.data);
        if (!audio) {
            throw new Error("Cloudflare speech response did not include audio data");
        }
        const media = audio.startsWith("data:")
            ? await bufferFromPayload(audio, "audio/wav")
            : {
                buffer: Buffer.from(audio, "base64"),
                mimeType: "audio/wav",
            };
        buffer = media.buffer;
        mimeType = media.mimeType;
    } else {
        buffer = Buffer.from(await response.arrayBuffer());
    }

    console.log(`[cloudflare] Speech generated: ${buffer.length} bytes`);
    return { buffer, mimeType };
}


// =============================================================================
// Automatic Speech Recognition (ASR / Transcription)
// =============================================================================
// Models: @cf/openai/whisper, @cf/openai/whisper-tiny-en, etc.
// Endpoint: POST /ai/run/{model_id}
// Input: base64 audio or audio URL
// Output: { text: string, ... }

/**
 * Transcribe audio using Cloudflare Workers AI.
 *
 * @param modelId Model ID (e.g. "@cf/openai/whisper")
 * @param audioBuffer Audio data as Buffer
 * @returns Transcription result
 */
export async function transcribeCloudflareAudio(
    modelId: string,
    audioBuffer: Buffer,
    options: {
        mimeType?: string;
        language?: string;
        customParams?: Record<string, unknown>;
    } = {},
): Promise<{ text: string }> {
    console.log(`[cloudflare] ASR transcription: ${modelId}`);

    const keys = params(modelId);
    const native = options.customParams || {};
    let response: Response;
    if (keys.has("body") && keys.has("contentType")) {
        const query = new URLSearchParams();
        if (options.language && keys.has("language")) {
            query.set("language", options.language);
        }
        for (const [key, value] of Object.entries(native)) {
            if (key === "audio" || key === "body" || key === "contentType") continue;
            if (scalar(value)) query.set(key, String(value));
        }
        response = await cfRawRequest(
            modelId,
            new Uint8Array(audioBuffer),
            options.mimeType || "audio/mpeg",
            query,
        );
    } else {
        const body: Record<string, unknown> = {
            audio: Array.from(audioBuffer.values()),
        };
        for (const [key, value] of Object.entries(native)) {
            if (key === "audio" || !keys.has(key)) continue;
            if (scalar(value)) body[key] = value;
        }
        response = await cfRequest(modelId, body);
    }
    const data = await response.json() as CloudflareAPIResponse;

    if (!data.success) {
        throw new Error(`Cloudflare ASR error: ${data.errors.map(e => e.message).join(", ")}`);
    }

    const result = data.result as unknown;
    const record = asRecord(result);
    const channels = Array.isArray(asRecord(asRecord(record?.results)?.channels)) ? [] : [];
    const direct = clean(record?.text) || clean(record?.transcript);
    if (direct) return { text: direct };

    const results = asRecord(record?.results);
    const channelItems = Array.isArray(results?.channels) ? results.channels : channels;
    const text = channelItems
        .flatMap((channel) => {
            const alternatives = Array.isArray(asRecord(channel)?.alternatives)
                ? asRecord(channel)?.alternatives as unknown[]
                : [];
            return alternatives.map((alternative) => clean(asRecord(alternative)?.transcript));
        })
        .filter(Boolean)
        .join("\n");
    return { text: text || clean(asRecord(record?.summary)?.result) || "" };
}

export async function detectCloudflareTurn(
    modelId: string,
    audioBuffer: Buffer,
    options: {
        dtype?: string;
        customParams?: Record<string, unknown>;
    } = {},
): Promise<{ isComplete: boolean; probability: number; raw: unknown }> {
    const keys = params(modelId);
    const native = options.customParams || {};
    const dtype = clean(options.dtype) || clean(native.dtype) || "uint8";
    const body: Record<string, unknown> = {
        audio: audioBuffer.toString("base64"),
    };
    if (keys.has("dtype")) body.dtype = dtype;

    const response = await cfRequest(modelId, body);
    const data = await response.json() as CloudflareAPIResponse;
    const result = unwrap(data);
    const record = asRecord(result) || {};
    return {
        isComplete: record.is_complete === true,
        probability: typeof record.probability === "number" ? record.probability : 0,
        raw: result,
    };
}
