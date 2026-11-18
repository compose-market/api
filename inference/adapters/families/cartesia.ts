/**
 * Cartesia speech family wire.
 *
 * Protocol helpers for Cartesia TTS, STT, voice changer, and infill.
 * Builders/parsers are transport-neutral; `generateCartesiaSpeech` remains as
 * the adapter-facing direct transport helper.
 *
 * Specs:
 *   - POST /tts/bytes
 *   - POST /tts/sse
 *   - WSS  /tts/websocket
 *   - POST /stt
 *   - POST /voice-changer/bytes
 *   - POST /infill/bytes
 */

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_DEFAULT_VOICE_ID = process.env.CARTESIA_DEFAULT_VOICE_ID;
const CARTESIA_API_VERSION = process.env.CARTESIA_API_VERSION || "2026-03-01";

if (!CARTESIA_API_KEY) {
    console.warn("[cartesia] CARTESIA_API_KEY not set — Cartesia speech disabled");
}

export const CARTESIA_TTS_BYTES_PATH = "/tts/bytes";
export const CARTESIA_TTS_SSE_PATH = "/tts/sse";
export const CARTESIA_TTS_WEBSOCKET_PATH = "/tts/websocket";
export const CARTESIA_VOICES_PATH = "/voices";
export const CARTESIA_STT_PATH = "/stt";
export const CARTESIA_STT_WEBSOCKET_PATH = "/stt/websocket";
export const CARTESIA_VOICE_CHANGER_BYTES_PATH = "/voice-changer/bytes";
export const CARTESIA_INFILL_BYTES_PATH = "/infill/bytes";

export type CartesiaApiVersion = "2024-06-10" | "2024-11-13" | "2025-04-16" | "2026-03-01";

export type CartesiaLanguage =
    | "en" | "fr" | "de" | "es" | "pt" | "zh" | "ja" | "hi" | "it" | "ko"
    | "nl" | "pl" | "ru" | "sv" | "tr" | "tl" | "bg" | "ro" | "ar" | "cs"
    | "el" | "fi" | "hr" | "ms" | "sk" | "da" | "ta" | "uk" | "hu" | "no"
    | "vi" | "bn" | "th" | "he" | "ka" | "id" | "te" | "gu" | "kn" | "ml"
    | "mr" | "pa";

export type CartesiaSttLanguage =
    | CartesiaLanguage | "ca" | "ur" | "lt" | "la" | "mi" | "cy" | "fa" | "lv"
    | "sr" | "az" | "sl" | "et" | "mk" | "br" | "eu" | "is" | "hy" | "ne"
    | "mn" | "bs" | "kk" | "sq" | "sw" | "gl" | "si" | "km" | "sn" | "yo"
    | "so" | "af" | "oc" | "be" | "tg" | "sd" | "am" | "yi" | "lo" | "uz"
    | "fo" | "ht" | "ps" | "tk" | "nn" | "mt" | "sa" | "lb" | "my" | "bo"
    | "mg" | "as" | "tt" | "haw" | "ln" | "ha" | "ba" | "jw" | "su" | "yue";

export type CartesiaOutputFormat =
    | { container: "raw"; encoding: "pcm_s16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw"; sample_rate: number }
    | { container: "wav"; encoding: "pcm_s16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw"; sample_rate: number }
    | { container: "mp3"; encoding?: "mp3"; sample_rate?: number };

export interface CartesiaVoiceSpecifier {
    mode: "id";
    id: string;
}

export interface CartesiaGenerationConfig {
    volume?: number;
    speed?: number;
    emotion?: string[];
}

export interface CartesiaTtsRequest {
    model_id: string;
    transcript: string;
    voice: CartesiaVoiceSpecifier;
    language?: CartesiaLanguage | null;
    output_format: CartesiaOutputFormat;
    save?: boolean | null;
    pronunciation_dict_id?: string | null;
    generation_config?: CartesiaGenerationConfig;
    speed?: "slow" | "normal" | "fast";
}

export interface CartesiaSttFormFields {
    model: string;
    language?: CartesiaSttLanguage;
    "timestamp_granularities[]"?: Array<"word">;
}

export interface CartesiaSttQuery {
    encoding?: "pcm_s16le" | "pcm_s32le" | "pcm_f16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw";
    sample_rate?: number;
}

export interface CartesiaVoiceChangerFields {
    "voice[id]": string;
    "output_format[container]": "raw" | "wav" | "mp3";
    "output_format[encoding]"?: string;
    "output_format[sample_rate]"?: number;
}

export interface CartesiaInfillFields {
    model_id: string;
    language?: CartesiaLanguage;
    transcript: string;
    voice_id: string;
    "output_format[container]": "raw" | "wav" | "mp3";
    "output_format[encoding]"?: string;
    "output_format[sample_rate]"?: number;
}

export interface CartesiaTranscriptionResponse {
    text?: string;
    duration?: number;
    language?: string;
    words?: Array<{ word?: string; start?: number; end?: number }>;
}

function requireCartesiaApiKey(): string {
    if (!CARTESIA_API_KEY) {
        throw new Error("Cartesia API key not configured");
    }
    return CARTESIA_API_KEY;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

let defaultVoicePromise: Promise<string> | null = null;

async function resolveDefaultVoiceId(): Promise<string> {
    if (CARTESIA_DEFAULT_VOICE_ID) {
        return CARTESIA_DEFAULT_VOICE_ID;
    }

    defaultVoicePromise ??= (async () => {
        const url = new URL(`https://api.cartesia.ai${CARTESIA_VOICES_PATH}`);
        url.searchParams.set("limit", "1");
        const response = await fetch(url, {
            headers: cartesiaHeaders(),
        });
        if (!response.ok) {
            throw new Error(`Cartesia voice lookup failed: ${response.status} ${await response.text()}`);
        }
        const payload = await response.json() as unknown;
        const root = asRecord(payload);
        const voices = Array.isArray(root?.voices)
            ? root.voices
            : Array.isArray(root?.data)
                ? root.data
                : Array.isArray(payload)
                    ? payload
                    : [];
        for (const voice of voices) {
            const record = asRecord(voice);
            const id = clean(record?.id) || clean(record?.voice_id);
            if (id) return id;
        }
        throw new Error("Cartesia voice lookup returned no voices");
    })();

    return defaultVoicePromise;
}

export function cartesiaHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        "X-API-Key": requireCartesiaApiKey(),
        "Cartesia-Version": CARTESIA_API_VERSION,
        ...extra,
    };
}

export function mapCartesiaOutput(format?: string): CartesiaOutputFormat {
    switch ((format || "mp3").toLowerCase()) {
        case "wav":
            return { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 };
        case "pcm":
            return { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 };
        case "ulaw":
        case "g711_ulaw":
            return { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 };
        case "alaw":
        case "g711_alaw":
            return { container: "raw", encoding: "pcm_alaw", sample_rate: 8000 };
        default:
            return { container: "mp3", encoding: "mp3", sample_rate: 44100 };
    }
}

export function buildTtsBytesBody(args: {
    modelId: string;
    text: string;
    voiceId: string;
    language?: CartesiaLanguage;
    outputFormat?: CartesiaOutputFormat;
    save?: boolean;
    pronunciationDictId?: string;
    generationConfig?: CartesiaGenerationConfig;
}): CartesiaTtsRequest {
    return {
        model_id: args.modelId,
        transcript: args.text,
        voice: { mode: "id", id: args.voiceId },
        ...(args.language ? { language: args.language } : {}),
        output_format: args.outputFormat || mapCartesiaOutput(),
        ...(typeof args.save === "boolean" ? { save: args.save } : {}),
        ...(args.pronunciationDictId ? { pronunciation_dict_id: args.pronunciationDictId } : {}),
        ...(args.generationConfig ? { generation_config: args.generationConfig } : {}),
    };
}

export function buildSttQuery(args: CartesiaSttQuery = {}): URLSearchParams {
    const params = new URLSearchParams();
    if (args.encoding) params.set("encoding", args.encoding);
    if (typeof args.sample_rate === "number") params.set("sample_rate", String(args.sample_rate));
    return params;
}

export function buildSttFields(args: CartesiaSttFormFields): Record<string, string | string[]> {
    return {
        model: args.model,
        ...(args.language ? { language: args.language } : {}),
        ...(args["timestamp_granularities[]"] ? { "timestamp_granularities[]": args["timestamp_granularities[]"] } : {}),
    };
}

export function buildVoiceChangerFields(args: {
    voiceId: string;
    outputFormat?: CartesiaOutputFormat;
}): CartesiaVoiceChangerFields {
    const outputFormat = args.outputFormat || mapCartesiaOutput();
    return {
        "voice[id]": args.voiceId,
        "output_format[container]": outputFormat.container,
        ...("encoding" in outputFormat && outputFormat.encoding ? { "output_format[encoding]": outputFormat.encoding } : {}),
        ...("sample_rate" in outputFormat && outputFormat.sample_rate ? { "output_format[sample_rate]": outputFormat.sample_rate } : {}),
    };
}

export function buildInfillFields(args: {
    modelId: string;
    transcript: string;
    voiceId: string;
    language?: CartesiaLanguage;
    outputFormat?: CartesiaOutputFormat;
}): CartesiaInfillFields {
    const outputFormat = args.outputFormat || mapCartesiaOutput();
    return {
        model_id: args.modelId,
        transcript: args.transcript,
        voice_id: args.voiceId,
        ...(args.language ? { language: args.language } : {}),
        "output_format[container]": outputFormat.container,
        ...("encoding" in outputFormat && outputFormat.encoding ? { "output_format[encoding]": outputFormat.encoding } : {}),
        ...("sample_rate" in outputFormat && outputFormat.sample_rate ? { "output_format[sample_rate]": outputFormat.sample_rate } : {}),
    };
}

export function parseTranscriptionResponse(payload: CartesiaTranscriptionResponse): {
    text: string;
    language?: string;
    durationSeconds?: number;
    raw: CartesiaTranscriptionResponse;
} {
    return {
        text: payload.text || "",
        language: payload.language,
        durationSeconds: payload.duration,
        raw: payload,
    };
}

export function outputFormatToMimeType(outputFormat: CartesiaOutputFormat): string {
    switch (outputFormat.container) {
        case "wav":
            return "audio/wav";
        case "raw":
            return "audio/pcm";
        default:
            return "audio/mpeg";
    }
}

export interface CartesiaSpeechOptions {
    voiceId?: string;
    responseFormat?: string;
    speed?: number;
}

export async function generateCartesiaSpeech(
    modelId: string,
    text: string,
    options: CartesiaSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const voiceId = options.voiceId || await resolveDefaultVoiceId();

    const outputFormat = mapCartesiaOutput(options.responseFormat);
    const body = buildTtsBytesBody({
        modelId,
        text,
        voiceId,
        language: "en",
        outputFormat,
        generationConfig: typeof options.speed === "number" ? { speed: options.speed } : undefined,
    });

    const response = await fetch(`https://api.cartesia.ai${CARTESIA_TTS_BYTES_PATH}`, {
        method: "POST",
        headers: cartesiaHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Cartesia speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || outputFormatToMimeType(outputFormat),
    };
}
