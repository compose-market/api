/**
 * Fireworks AI Provider Module
 *
 * Runtime provider for Fireworks AI models.
 * Handles capabilities NOT covered by OpenAI-compatible SDK:
 *   - Image generation (FLUX workflow API)
 *   - Audio transcription (Whisper with model-specific base URLs)
 *
 * Text chat/completion and embeddings use createOpenAICompatible in modelsRegistry.ts.
 *
 * API Docs:
 *   - Text: https://docs.fireworks.ai/guides/querying-text-models
 *   - Vision: https://docs.fireworks.ai/guides/querying-vision-language-models
 *   - Image: https://docs.fireworks.ai/guides/image-generation
 *   - Audio: https://docs.fireworks.ai/guides/querying-asr-models
 *   - Embeddings: https://docs.fireworks.ai/guides/querying-embeddings-models
 */

const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;

if (!FIREWORKS_API_KEY) {
    console.warn("[fireworks] FIREWORKS_API_KEY not set — image gen and audio transcription disabled");
}

// =============================================================================
// Image Generation — FLUX workflow API
// =============================================================================
// Endpoint: POST https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/{slug}/text_to_image
// Returns raw image bytes (Accept: image/jpeg or image/png)
// NOT OpenAI-compatible — requires direct REST call.

export interface FireworksImageOptions {
    /** Number of diffusion steps (default: model-specific) */
    steps?: number;
    /** Guidance scale (default: model-specific, typically 3.5) */
    guidanceScale?: number;
    /** Random seed (0 = random) */
    seed?: number;
    /** Image dimensions */
    width?: number;
    height?: number;
    /** Output format */
    outputFormat?: "image/jpeg" | "image/png";
    /** Number of images (Fireworks doesn't support n>1 in a single call) */
    n?: number;
    /** Provider-native request parameters */
    parameters?: Record<string, unknown>;
}

/**
 * Generate an image using Fireworks FLUX workflow API.
 *
 * @param modelId Full model ID (e.g. "accounts/fireworks/models/flux-1-schnell-fp8")
 * @param prompt Text prompt for image generation
 * @param options Generation options
 * @returns Buffer of the generated image
 */
export async function generateFireworksImage(
    modelId: string,
    prompt: string,
    options: FireworksImageOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!FIREWORKS_API_KEY) {
        throw new Error("FIREWORKS_API_KEY not configured");
    }

    // Extract slug from full model ID
    // "accounts/fireworks/models/flux-1-schnell-fp8" → use full path in URL
    const modelPath = modelId.startsWith("accounts/")
        ? modelId
        : `accounts/fireworks/models/${modelId}`;

    const url = `https://api.fireworks.ai/inference/v1/workflows/${modelPath}/text_to_image`;
    const accept = options.outputFormat || "image/jpeg";

    const body: Record<string, unknown> = {
        prompt,
        ...(options.parameters || {}),
    };
    if (options.steps != null) body.steps = options.steps;
    if (options.guidanceScale != null) body.guidance_scale = options.guidanceScale;
    if (options.seed != null) body.seed = options.seed;
    if (options.width != null) body.width = options.width;
    if (options.height != null) body.height = options.height;

    console.log(`[fireworks] Image generation: ${modelPath} → ${url}`);

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${FIREWORKS_API_KEY}`,
            "Content-Type": "application/json",
            "Accept": accept,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Fireworks image generation failed: ${response.status} ${response.statusText} — ${errorBody.substring(0, 300)}`
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || accept;

    console.log(`[fireworks] Image generated: ${buffer.length} bytes (${mimeType})`);
    return { buffer, mimeType };
}


// =============================================================================
// Audio Transcription — Whisper models with model-specific base URLs
// =============================================================================
// whisper-v3: base_url = https://audio-prod.api.fireworks.ai
// whisper-v3-turbo: base_url = https://audio-turbo.api.fireworks.ai
// Endpoint: POST {base_url}/v1/audio/transcriptions
// OpenAI-compatible multipart/form-data

/**
 * Base URL mapping for Whisper audio models.
 * Per Fireworks docs, each model has a dedicated audio endpoint.
 */
function getAudioBaseUrl(modelId: string): string {
    const slug = modelId.split("/").pop() || modelId;

    switch (slug) {
        case "whisper-v3":
            return "https://audio-prod.api.fireworks.ai";
        case "whisper-v3-turbo":
            return "https://audio-turbo.api.fireworks.ai";
        default:
            // Future whisper models default to prod
            console.warn(`[fireworks] Unknown audio model "${slug}", defaulting to audio-prod`);
            return "https://audio-prod.api.fireworks.ai";
    }
}

export interface FireworksTranscriptionOptions {
    /** Response format: json, text, srt, verbose_json, vtt */
    responseFormat?: string;
    /** Language hint (ISO-639-1) */
    language?: string;
    /** Temperature for sampling (0-1) */
    temperature?: number;
}

/**
 * Transcribe audio using Fireworks Whisper API.
 *
 * @param modelId Model ID (e.g. "accounts/fireworks/models/whisper-v3")
 * @param audioBuffer Audio data as Buffer
 * @param options Transcription options
 * @returns Transcription text
 */
export async function transcribeFireworksAudio(
    modelId: string,
    audioBuffer: Buffer,
    options: FireworksTranscriptionOptions = {},
): Promise<{ text: string }> {
    if (!FIREWORKS_API_KEY) {
        throw new Error("FIREWORKS_API_KEY not configured");
    }

    const baseUrl = getAudioBaseUrl(modelId);
    const slug = modelId.split("/").pop() || modelId;
    const url = `${baseUrl}/v1/audio/transcriptions`;

    console.log(`[fireworks] Audio transcription: ${slug} → ${url}`);

    // Build multipart form data
    const formData = new FormData();

    // Create a Blob from the Buffer for the file field
    const blob = new Blob([audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    formData.append("model", slug);

    if (options.responseFormat) formData.append("response_format", options.responseFormat);
    if (options.language) formData.append("language", options.language);
    if (options.temperature != null) formData.append("temperature", String(options.temperature));

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${FIREWORKS_API_KEY}`,
        },
        body: formData,
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Fireworks audio transcription failed: ${response.status} ${response.statusText} — ${errorBody.substring(0, 300)}`
        );
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
        const data = await response.json() as { text?: string };
        return { text: data.text || "" };
    }

    // Plain text response
    const text = await response.text();
    return { text };
}
