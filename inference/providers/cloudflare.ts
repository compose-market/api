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

async function cfRequest(
    modelId: string,
    body: Record<string, unknown>,
    accept: string = "application/json",
): Promise<Response> {
    if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
        throw new Error("CF_API_TOKEN or CF_ACCOUNT_ID not configured");
    }

    const url = `${CF_API_BASE}/${modelId}`;

    console.log(`[cloudflare] POST ${url}`);

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CF_API_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": accept,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Cloudflare API error: ${response.status} ${response.statusText} — ${errorBody.substring(0, 500)}`
        );
    }

    return response;
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
    const body: Record<string, unknown> = { prompt };
    if (options.width != null) body.width = options.width;
    if (options.height != null) body.height = options.height;
    if (options.num_steps != null) body.num_steps = options.num_steps;
    if (options.guidance != null) body.guidance = options.guidance;

    // Request raw image bytes
    const response = await cfRequest(modelId, body, "image/*");
    const contentType = response.headers.get("content-type") || "image/png";

    // Cloudflare returns raw image bytes for image models
    const buffer = Buffer.from(await response.arrayBuffer());

    console.log(`[cloudflare] Image generated: ${buffer.length} bytes (${contentType})`);
    return { buffer, mimeType: contentType };
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
): Promise<Buffer> {
    const response = await cfRequest(modelId, { text }, "audio/*");
    const buffer = Buffer.from(await response.arrayBuffer());

    console.log(`[cloudflare] Speech generated: ${buffer.length} bytes`);
    return buffer;
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
): Promise<{ text: string }> {
    if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
        throw new Error("CF_API_TOKEN or CF_ACCOUNT_ID not configured");
    }

    const url = `${CF_API_BASE}/${modelId}`;

    console.log(`[cloudflare] ASR transcription: ${modelId} → ${url}`);

    // Cloudflare ASR expects raw audio bytes as the body
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CF_API_TOKEN}`,
            "Content-Type": "application/octet-stream",
        },
        body: new Blob([audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength)] as ArrayBuffer[]),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Cloudflare ASR failed: ${response.status} ${response.statusText} — ${errorBody.substring(0, 500)}`
        );
    }

    const data = await response.json() as CloudflareAPIResponse;

    if (!data.success) {
        throw new Error(`Cloudflare ASR error: ${data.errors.map(e => e.message).join(", ")}`);
    }

    const result = data.result as { text?: string };
    return { text: result.text || "" };
}
