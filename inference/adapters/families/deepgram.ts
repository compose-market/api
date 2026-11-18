/**
 * Deepgram speech family wire.
 *
 * Protocol helpers for Deepgram Listen, Flux Listen v2, and Speak.
 * The builder/parser functions are transport-neutral. The small
 * generate/transcribe helpers at the bottom preserve the existing adapter
 * contract for direct Deepgram calls.
 *
 * Specs:
 *   - GET/POST /v1/listen
 *   - WSS /v2/listen (Flux)
 *   - POST /v1/speak
 */

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
    console.warn("[deepgram] DEEPGRAM_API_KEY not set — Deepgram speech disabled");
}

export const DEEPGRAM_LISTEN_PATH = "/v1/listen";
export const DEEPGRAM_FLUX_LISTEN_PATH = "/v2/listen";
export const DEEPGRAM_SPEAK_PATH = "/v1/speak";

export type DeepgramSpeakEncoding =
    | "linear16" | "mulaw" | "alaw" | "mp3" | "opus" | "ogg-opus" | "flac" | "aac";

export type DeepgramSpeakContainer =
    | "wav" | "mp3" | "flac" | "ogg" | "raw" | "aac";

export type DeepgramListenEncoding =
    | "linear16" | "linear32" | "mulaw" | "alaw" | "opus" | "ogg-opus"
    | "flac" | "m4a" | "mp3" | "mp4" | "mpeg" | "mpga" | "oga" | "ogg" | "wav" | "webm";

export interface DeepgramListenOptions {
    language?: string;
    detect_language?: boolean;
    smart_format?: boolean;
    punctuate?: boolean;
    paragraphs?: boolean;
    diarize?: boolean;
    utterances?: boolean;
    multichannel?: boolean;
    numerals?: boolean;
    profanity_filter?: boolean;
    redact?: string | string[];
    replace?: string | string[];
    keywords?: string | string[];
    keyterm?: string | string[];
    filler_words?: boolean;
    detect_topics?: boolean;
    detect_entities?: boolean;
    sentiment?: boolean;
    intents?: boolean;
    summarize?: boolean | string;
    search?: string | string[];
    callback?: string;
    mip_opt_out?: boolean;
    tag?: string | string[];
    encoding?: DeepgramListenEncoding;
    sample_rate?: number;
    channels?: number;
    customParams?: Record<string, unknown>;
}

export interface DeepgramFluxListenOptions {
    encoding?: "linear16" | "linear32" | "mulaw" | "alaw" | "opus" | "ogg-opus";
    sample_rate?: 8000 | 16000 | 24000 | 44100 | 48000 | number;
    eager_eot_threshold?: number;
    eot_threshold?: number;
    eot_timeout_ms?: number;
    keyterm?: string | string[];
    language_hint?: string | string[];
    mip_opt_out?: boolean;
    tag?: string | string[];
    customParams?: Record<string, unknown>;
}

export interface DeepgramSpeakOptions {
    encoding?: DeepgramSpeakEncoding;
    container?: DeepgramSpeakContainer;
    sample_rate?: number;
    bit_rate?: number;
    callback?: string;
    mip_opt_out?: boolean;
    tag?: string | string[];
    customParams?: Record<string, unknown>;
}

export interface DeepgramSpeakRequestBody {
    text: string;
}

export interface DeepgramTranscriptionAlternative {
    transcript?: string;
    confidence?: number;
    words?: Array<{
        word?: string;
        start?: number;
        end?: number;
        confidence?: number;
        speaker?: number | string;
    }>;
}

export interface DeepgramTranscriptionResponse {
    metadata?: Record<string, unknown>;
    results?: {
        channels?: Array<{
            alternatives?: DeepgramTranscriptionAlternative[];
        }>;
        utterances?: Array<Record<string, unknown>>;
    };
}

function requireDeepgramApiKey(): string {
    if (!DEEPGRAM_API_KEY) {
        throw new Error("DEEPGRAM_API_KEY not configured");
    }
    return DEEPGRAM_API_KEY;
}

export function stripDeepgramPrefix(modelId: string): string {
    return modelId.replace(/^deepgram\//, "");
}

function appendParam(url: URL, key: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
        for (const entry of value) appendParam(url, key, entry);
        return;
    }
    if (typeof value === "boolean") {
        url.searchParams.append(key, value ? "true" : "false");
        return;
    }
    url.searchParams.append(key, String(value));
}

function appendCustomParams(url: URL, params: Record<string, unknown> | undefined): void {
    if (!params) return;
    for (const [key, value] of Object.entries(params)) {
        appendParam(url, key, value);
    }
}

export function buildListenUrl(baseUrl: string, modelId: string, options: DeepgramListenOptions = {}): URL {
    const url = new URL(DEEPGRAM_LISTEN_PATH, baseUrl);
    url.searchParams.set("model", stripDeepgramPrefix(modelId));

    for (const [key, value] of Object.entries(options)) {
        if (key === "customParams") continue;
        appendParam(url, key, value);
    }
    appendCustomParams(url, options.customParams);
    return url;
}

export function buildFluxListenUrl(baseUrl: string, modelId: string, options: DeepgramFluxListenOptions = {}): URL {
    const url = new URL(DEEPGRAM_FLUX_LISTEN_PATH, baseUrl.replace(/^http/, "ws"));
    url.searchParams.set("model", stripDeepgramPrefix(modelId));

    for (const [key, value] of Object.entries(options)) {
        if (key === "customParams") continue;
        appendParam(url, key, value);
    }
    appendCustomParams(url, options.customParams);
    return url;
}

export function buildSpeakUrl(baseUrl: string, modelId: string, options: DeepgramSpeakOptions = {}): URL {
    const url = new URL(DEEPGRAM_SPEAK_PATH, baseUrl);
    url.searchParams.set("model", stripDeepgramPrefix(modelId));

    for (const [key, value] of Object.entries(options)) {
        if (key === "customParams") continue;
        appendParam(url, key, value);
    }
    appendCustomParams(url, options.customParams);
    return url;
}

export function buildSpeakBody(text: string): DeepgramSpeakRequestBody {
    return { text };
}

export function parseListenResponse(payload: DeepgramTranscriptionResponse): {
    text: string;
    metadata?: Record<string, unknown>;
    raw: DeepgramTranscriptionResponse;
} {
    const text = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    return { text, metadata: payload.metadata, raw: payload };
}

export function mapDeepgramSpeakFormat(format?: string): DeepgramSpeakOptions {
    switch ((format || "wav").toLowerCase()) {
        case "wav":
            return { container: "wav", encoding: "linear16" };
        case "pcm":
            return { encoding: "linear16", container: "raw" };
        case "opus":
        case "ogg":
            return { encoding: "opus", container: "ogg" };
        case "aac":
            return { encoding: "aac", container: "aac" };
        case "flac":
            return { encoding: "flac", container: "flac" };
        case "mp3":
            return { encoding: "mp3", container: "mp3" };
        default:
            return { container: "wav", encoding: "linear16" };
    }
}

export function deepgramMimeType(options: DeepgramSpeakOptions): string {
    switch (options.container || options.encoding) {
        case "wav":
            return "audio/wav";
        case "ogg":
        case "opus":
        case "ogg-opus":
            return "audio/ogg";
        case "flac":
            return "audio/flac";
        case "aac":
            return "audio/aac";
        case "raw":
        case "linear16":
            return "audio/pcm";
        default:
            return "audio/mpeg";
    }
}

export interface DeepgramSpeechOptions {
    voice?: string;
    responseFormat?: string;
}

export async function transcribeDeepgramAudio(
    modelId: string,
    audioBuffer: Buffer,
    options: { language?: string } = {},
): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    const url = buildListenUrl("https://api.deepgram.com", modelId, {
        language: options.language,
        smart_format: true,
    });

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Token ${requireDeepgramApiKey()}`,
            "Content-Type": "audio/wav",
        },
        body: new Blob([audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer], {
            type: "audio/wav",
        }),
    });

    if (!response.ok) {
        throw new Error(`Deepgram transcription failed: ${response.status} ${await response.text()}`);
    }

    return parseListenResponse(await response.json() as DeepgramTranscriptionResponse);
}

export async function generateDeepgramSpeech(
    modelId: string,
    text: string,
    options: DeepgramSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const wireOptions = mapDeepgramSpeakFormat(options.responseFormat);
    if (options.voice) {
        wireOptions.customParams = { voice: options.voice };
    }

    const response = await fetch(buildSpeakUrl("https://api.deepgram.com", modelId, wireOptions), {
        method: "POST",
        headers: {
            "Authorization": `Token ${requireDeepgramApiKey()}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(buildSpeakBody(text)),
    });

    if (!response.ok) {
        throw new Error(`Deepgram speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || deepgramMimeType(wireOptions),
    };
}
