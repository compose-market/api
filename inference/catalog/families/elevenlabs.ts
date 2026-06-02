import { audioDurationSeconds } from "../modalities/speech.js";

/**
 * ElevenLabs speech/audio family wire.
 *
 * Protocol helpers for text-to-speech, speech-to-text, realtime STT,
 * text-to-dialogue, voice changer, voice design, music, sound effects, and
 * audio isolation. Builders/parsers are transport-neutral; the direct
 * `generateElevenLabsSpeech` helper keeps the current adapter contract.
 *
 * Specs:
 *   - GET  /v1/models
 *   - POST /v1/text-to-speech/{voice_id}
 *   - POST /v1/speech-to-text
 *   - WSS  /v1/speech-to-text/realtime
 *   - POST /v1/text-to-dialogue
 *   - POST /v1/speech-to-speech/{voice_id}
 *   - POST /v1/text-to-voice/design
 *   - POST /v1/music
 *   - POST /v1/sound-generation
 *   - POST /v1/audio-isolation
 */

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API || process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID;

if (!ELEVENLABS_API_KEY) {
    console.warn("[elevenlabs] ELEVENLABS_API_KEY not set — ElevenLabs speech disabled");
}

export const ELEVENLABS_MODELS_PATH = "/v1/models";
export const ELEVENLABS_TTS_PATH = "/v1/text-to-speech/{voice_id}";
export const ELEVENLABS_TTS_TIMESTAMPS_PATH = "/v1/text-to-speech/{voice_id}/with-timestamps";
export const ELEVENLABS_TTS_STREAM_PATH = "/v1/text-to-speech/{voice_id}/stream";
export const ELEVENLABS_STT_PATH = "/v1/speech-to-text";
export const ELEVENLABS_STT_REALTIME_PATH = "/v1/speech-to-text/realtime";
export const ELEVENLABS_DIALOGUE_PATH = "/v1/text-to-dialogue";
export const ELEVENLABS_SPEECH_TO_SPEECH_PATH = "/v1/speech-to-speech/{voice_id}";
export const ELEVENLABS_VOICE_DESIGN_PATH = "/v1/text-to-voice/design";
export const ELEVENLABS_MUSIC_PATH = "/v1/music";
export const ELEVENLABS_SOUND_EFFECTS_PATH = "/v1/sound-generation";
export const ELEVENLABS_AUDIO_ISOLATION_PATH = "/v1/audio-isolation";

export type ElevenLabsOutputFormat =
    | "mp3_22050_32" | "mp3_24000_48"
    | "mp3_44100_32" | "mp3_44100_64" | "mp3_44100_96" | "mp3_44100_128" | "mp3_44100_192"
    | "pcm_8000" | "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_32000" | "pcm_44100" | "pcm_48000"
    | "ulaw_8000" | "alaw_8000"
    | "opus_48000_32" | "opus_48000_64" | "opus_48000_96" | "opus_48000_128" | "opus_48000_192";

export interface ElevenLabsVoiceSettings {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    speed?: number;
}

export interface ElevenLabsTextToSpeechBody {
    text: string;
    model_id?: string;
    language_code?: string;
    voice_settings?: ElevenLabsVoiceSettings;
    pronunciation_dictionary_locators?: Array<{ pronunciation_dictionary_id: string; version_id: string }>;
    seed?: number;
    previous_text?: string;
    next_text?: string;
    previous_request_ids?: string[];
    next_request_ids?: string[];
    apply_text_normalization?: "auto" | "on" | "off";
    use_pvc_as_ivc?: boolean;
}

export interface ElevenLabsTextToSpeechQuery {
    output_format?: ElevenLabsOutputFormat;
    optimize_streaming_latency?: 0 | 1 | 2 | 3 | 4;
    enable_logging?: boolean;
}

export interface ElevenLabsSpeechToTextFields {
    model_id: "scribe_v1" | "scribe_v2" | string;
    language_code?: string;
    tag_audio_events?: boolean;
    num_speakers?: number;
    timestamps_granularity?: "word" | "character" | "none";
    diarize?: boolean;
    webhook?: boolean;
    webhook_id?: string;
    keyterms?: string[];
    entity_detection?: boolean;
    enable_logging?: boolean;
}

export interface ElevenLabsRealtimeSttQuery {
    model_id?: "scribe_v2_realtime" | string;
    token?: string;
    include_timestamps?: boolean;
    include_language_detection?: boolean;
    audio_format?: "pcm_8000" | "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_44100" | "pcm_48000" | "ulaw_8000";
    language_code?: string;
    commit_strategy?: "manual" | "vad";
    keyterms?: string[];
    no_verbatim?: boolean;
    vad_silence_threshold_secs?: number;
    vad_threshold?: number;
    min_speech_duration_ms?: number;
    min_silence_duration_ms?: number;
    enable_logging?: boolean;
}

export interface ElevenLabsDialogueBody {
    model_id?: "eleven_v3" | string;
    inputs: Array<{ text: string; voice_id: string }>;
    settings?: {
        stability?: number;
        use_speaker_boost?: boolean;
        similarity_boost?: number;
        style?: number;
        speed?: number;
    };
    seed?: number;
}

export interface ElevenLabsSpeechToSpeechFields {
    model_id?: "eleven_english_sts_v2" | "eleven_multilingual_sts_v2" | string;
    voice_settings?: ElevenLabsVoiceSettings;
    seed?: number;
    remove_background_noise?: boolean;
}

export interface ElevenLabsVoiceDesignBody {
    voice_description: string;
    model_id?: "eleven_multilingual_ttv_v2" | "eleven_ttv_v3" | string;
    text?: string | null;
    auto_generate_text?: boolean;
    loudness?: number;
    seed?: number | null;
    guidance_scale?: number;
    stream_previews?: boolean;
    should_enhance?: boolean;
    remixing_session_id?: string | null;
    remixing_session_iteration_id?: string | null;
    quality?: number | null;
    reference_audio_base64?: string | null;
    prompt_strength?: number | null;
}

export interface ElevenLabsMusicBody {
    model_id?: "music_v1" | string;
    prompt?: string | null;
    composition_plan?: Record<string, unknown> | null;
    music_length_ms?: number;
}

export interface ElevenLabsSoundEffectsBody {
    text: string;
    duration_seconds?: number;
    prompt_influence?: number;
    loop?: boolean;
}

export interface ElevenLabsTimingResponse {
    audio_base64?: string;
    alignment?: Record<string, unknown>;
    normalized_alignment?: Record<string, unknown>;
}

export interface ElevenLabsTranscriptionResponse {
    text?: string;
    language_code?: string;
    language_probability?: number;
    words?: Array<Record<string, unknown>>;
    speakers?: Array<Record<string, unknown>>;
    audio_events?: Array<Record<string, unknown>>;
}

function requireElevenLabsApiKey(): string {
    if (!ELEVENLABS_API_KEY) {
        throw new Error("ElevenLabs API key not configured");
    }
    return ELEVENLABS_API_KEY;
}

export function elevenLabsHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        "xi-api-key": requireElevenLabsApiKey(),
        ...extra,
    };
}

export function voicePath(template: string, voiceId: string): string {
    return template.replace("{voice_id}", encodeURIComponent(voiceId));
}

function setQuery(params: URLSearchParams, key: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
        for (const entry of value) setQuery(params, key, entry);
        return;
    }
    if (typeof value === "boolean") {
        params.set(key, value ? "true" : "false");
        return;
    }
    params.set(key, String(value));
}

export function buildTextToSpeechQuery(options: ElevenLabsTextToSpeechQuery = {}): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        setQuery(params, key, value);
    }
    return params;
}

export function buildTextToSpeechBody(args: {
    text: string;
    modelId?: string;
    languageCode?: string;
    voiceSettings?: ElevenLabsVoiceSettings;
    seed?: number;
    previousText?: string;
    nextText?: string;
    previousRequestIds?: string[];
    nextRequestIds?: string[];
    applyTextNormalization?: "auto" | "on" | "off";
}): ElevenLabsTextToSpeechBody {
    return {
        text: args.text,
        ...(args.modelId ? { model_id: args.modelId } : {}),
        ...(args.languageCode ? { language_code: args.languageCode } : {}),
        ...(args.voiceSettings ? { voice_settings: args.voiceSettings } : {}),
        ...(typeof args.seed === "number" ? { seed: args.seed } : {}),
        ...(args.previousText ? { previous_text: args.previousText } : {}),
        ...(args.nextText ? { next_text: args.nextText } : {}),
        ...(args.previousRequestIds ? { previous_request_ids: args.previousRequestIds } : {}),
        ...(args.nextRequestIds ? { next_request_ids: args.nextRequestIds } : {}),
        ...(args.applyTextNormalization ? { apply_text_normalization: args.applyTextNormalization } : {}),
    };
}

export function buildSpeechToTextFields(fields: ElevenLabsSpeechToTextFields): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        out[key] = Array.isArray(value) ? JSON.stringify(value) : String(value);
    }
    return out;
}

export function buildRealtimeSpeechToTextQuery(options: ElevenLabsRealtimeSttQuery = {}): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        setQuery(params, key, value);
    }
    return params;
}

export function buildDialogueBody(body: ElevenLabsDialogueBody): ElevenLabsDialogueBody {
    return body;
}

export function buildSpeechToSpeechFields(fields: ElevenLabsSpeechToSpeechFields): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        out[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    return out;
}

export function buildVoiceDesignBody(body: ElevenLabsVoiceDesignBody): ElevenLabsVoiceDesignBody {
    return body;
}

export function buildMusicBody(body: ElevenLabsMusicBody): ElevenLabsMusicBody {
    return body.model_id ? body : { ...body, model_id: "music_v1" };
}

export function buildSoundEffectsBody(body: ElevenLabsSoundEffectsBody): ElevenLabsSoundEffectsBody {
    return body;
}

export function parseTranscriptionResponse(payload: ElevenLabsTranscriptionResponse): {
    text: string;
    language?: string;
    raw: ElevenLabsTranscriptionResponse;
} {
    return {
        text: payload.text || "",
        language: payload.language_code,
        raw: payload,
    };
}

export function parseTimingResponse(payload: ElevenLabsTimingResponse): {
    audioBase64: string;
    alignment?: Record<string, unknown>;
    normalizedAlignment?: Record<string, unknown>;
    raw: ElevenLabsTimingResponse;
} {
    return {
        audioBase64: payload.audio_base64 || "",
        alignment: payload.alignment,
        normalizedAlignment: payload.normalized_alignment,
        raw: payload,
    };
}

export function mapElevenLabsFormat(format?: string): ElevenLabsOutputFormat {
    switch ((format || "mp3").toLowerCase()) {
        case "wav":
        case "pcm":
            return "pcm_44100";
        case "ulaw":
        case "g711_ulaw":
            return "ulaw_8000";
        case "alaw":
        case "g711_alaw":
            return "alaw_8000";
        case "opus":
            return "opus_48000_128";
        default:
            return "mp3_44100_128";
    }
}

export function elevenLabsMimeType(outputFormat: ElevenLabsOutputFormat): string {
    if (outputFormat.startsWith("pcm_")) return "audio/pcm";
    if (outputFormat.startsWith("ulaw_")) return "audio/basic";
    if (outputFormat.startsWith("alaw_")) return "audio/basic";
    if (outputFormat.startsWith("opus_")) return "audio/ogg";
    return "audio/mpeg";
}

export interface ElevenLabsSpeechOptions {
    voiceId?: string;
    responseFormat?: string;
    speed?: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

async function resolveVoiceId(voiceId?: string): Promise<string> {
    const configured = voiceId || clean(process.env.ELEVENLABS_DEFAULT_VOICE_ID) || ELEVENLABS_DEFAULT_VOICE_ID;
    if (configured) return configured;

    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: elevenLabsHeaders({ Accept: "application/json" }),
    });
    if (!response.ok) {
        throw new Error(`ElevenLabs voices lookup failed: ${response.status} ${await response.text()}`);
    }

    const payload = record(await response.json()) || {};
    const voices = Array.isArray(payload.voices) ? payload.voices : [];
    for (const voice of voices) {
        const id = clean(record(voice)?.voice_id);
        if (id) return id;
    }

    throw new Error("ElevenLabs voice ID is required");
}

function appendBlob(form: FormData, field: string, audioBuffer: Buffer, filename: string): void {
    form.append(field, new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" }), filename);
}

function secondsFromWords(words: unknown): number | undefined {
    if (!Array.isArray(words)) return undefined;
    let max = 0;
    for (const word of words) {
        const item = record(word);
        const end = item && typeof item.end === "number" && Number.isFinite(item.end)
            ? item.end
            : item && typeof item.end_time === "number" && Number.isFinite(item.end_time)
                ? item.end_time
                : undefined;
        if (typeof end === "number" && end > max) max = end;
    }
    return max > 0 ? max : undefined;
}

export async function generateElevenLabsSpeech(
    modelId: string,
    text: string,
    options: ElevenLabsSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const voiceId = await resolveVoiceId(options.voiceId);

    const outputFormat = mapElevenLabsFormat(options.responseFormat);
    const url = new URL(`https://api.elevenlabs.io${voicePath(ELEVENLABS_TTS_PATH, voiceId)}`);
    const query = buildTextToSpeechQuery({ output_format: outputFormat });
    for (const [key, value] of query) {
        url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: elevenLabsHeaders({
            "Content-Type": "application/json",
            "Accept": elevenLabsMimeType(outputFormat),
        }),
        body: JSON.stringify(buildTextToSpeechBody({
            text,
            modelId,
            voiceSettings: {
                stability: 0.35,
                similarity_boost: 0.7,
                style: 0.35,
                speed: options.speed ?? 1,
                use_speaker_boost: true,
            },
        })),
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || elevenLabsMimeType(outputFormat),
    };
}

function textToAudioMetrics(buffer: Buffer, mimeType: string, fallback: Record<string, unknown>): Record<string, unknown> {
    const seconds = audioDurationSeconds(buffer, mimeType);
    return {
        ...fallback,
        ...(typeof seconds === "number" ? {
            second: seconds,
            audio_second: seconds,
            minute: seconds / 60,
            audio_minute: seconds / 60,
            generated_audio_minute: seconds / 60,
            duration: seconds,
        } : {}),
    };
}

export async function generateElevenLabsSound(
    text: string,
    options: {
        durationSeconds?: number;
        promptInfluence?: number;
        loop?: boolean;
    } = {},
): Promise<{ buffer: Buffer; mimeType: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics: Record<string, unknown> } }> {
    const response = await fetch(`https://api.elevenlabs.io${ELEVENLABS_SOUND_EFFECTS_PATH}`, {
        method: "POST",
        headers: elevenLabsHeaders({
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
        }),
        body: JSON.stringify(buildSoundEffectsBody({
            text,
            ...(typeof options.durationSeconds === "number" ? { duration_seconds: options.durationSeconds } : {}),
            ...(typeof options.promptInfluence === "number" ? { prompt_influence: options.promptInfluence } : {}),
            ...(typeof options.loop === "boolean" ? { loop: options.loop } : {}),
        })),
    });
    if (!response.ok) {
        throw new Error(`ElevenLabs sound generation failed: ${response.status} ${await response.text()}`);
    }

    const mimeType = response.headers.get("content-type") || "audio/mpeg";
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
        buffer,
        mimeType,
        usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            billingMetrics: textToAudioMetrics(buffer, mimeType, { generation: 1 }),
        },
    };
}

export async function generateElevenLabsMusic(
    modelId: string,
    prompt: string,
    options: {
        compositionPlan?: Record<string, unknown>;
        musicLengthMs?: number;
        outputFormat?: ElevenLabsOutputFormat;
    } = {},
): Promise<{ buffer: Buffer; mimeType: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics: Record<string, unknown> } }> {
    const url = new URL(`https://api.elevenlabs.io${ELEVENLABS_MUSIC_PATH}`);
    if (options.outputFormat) {
        url.searchParams.set("output_format", options.outputFormat);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: elevenLabsHeaders({
            "Content-Type": "application/json",
            Accept: options.outputFormat ? elevenLabsMimeType(options.outputFormat) : "audio/mpeg",
        }),
        body: JSON.stringify(buildMusicBody({
            model_id: modelId,
            prompt,
            ...(options.compositionPlan ? { composition_plan: options.compositionPlan } : {}),
            ...(typeof options.musicLengthMs === "number" ? { music_length_ms: options.musicLengthMs } : {}),
        })),
    });
    if (!response.ok) {
        throw new Error(`ElevenLabs music generation failed: ${response.status} ${await response.text()}`);
    }

    const mimeType = response.headers.get("content-type") || (options.outputFormat ? elevenLabsMimeType(options.outputFormat) : "audio/mpeg");
    const buffer = Buffer.from(await response.arrayBuffer());
    const fallback: Record<string, unknown> = { generation: 1 };
    if (typeof options.musicLengthMs === "number" && options.musicLengthMs > 0) {
        fallback.minute = options.musicLengthMs / 60_000;
        fallback.audio_minute = options.musicLengthMs / 60_000;
        fallback.generated_audio_minute = options.musicLengthMs / 60_000;
        fallback.duration = options.musicLengthMs / 1000;
    }
    return {
        buffer,
        mimeType,
        usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            billingMetrics: textToAudioMetrics(buffer, mimeType, fallback),
        },
    };
}

export async function transcribeElevenLabsAudio(
    modelId: string,
    audioBuffer: Buffer,
    options: {
        language?: string;
        tagAudioEvents?: boolean;
        timestampsGranularity?: "word" | "character" | "none";
    } = {},
): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; billingMetrics?: Record<string, unknown>; raw?: unknown }; raw: unknown }> {
    const form = new FormData();
    appendBlob(form, "file", audioBuffer, "audio.wav");
    for (const [key, value] of Object.entries(buildSpeechToTextFields({
        model_id: modelId,
        ...(options.language ? { language_code: options.language } : {}),
        ...(typeof options.tagAudioEvents === "boolean" ? { tag_audio_events: options.tagAudioEvents } : {}),
        ...(options.timestampsGranularity ? { timestamps_granularity: options.timestampsGranularity } : {}),
    }))) {
        form.set(key, value);
    }

    const response = await fetch(`https://api.elevenlabs.io${ELEVENLABS_STT_PATH}`, {
        method: "POST",
        headers: elevenLabsHeaders({ Accept: "application/json" }),
        body: form,
    });
    if (!response.ok) {
        throw new Error(`ElevenLabs transcription failed: ${response.status} ${await response.text()}`);
    }

    const raw = await response.json() as ElevenLabsTranscriptionResponse;
    const parsed = parseTranscriptionResponse(raw);
    const seconds = secondsFromWords(raw.words);
    return {
        text: parsed.text,
        ...(typeof seconds === "number" ? {
            usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                billingMetrics: {
                    second: seconds,
                    audio_second: seconds,
                },
                raw,
            },
        } : {}),
        raw,
    };
}

export async function generateElevenLabsSpeechToSpeech(
    modelId: string,
    audioBuffer: Buffer,
    options: ElevenLabsSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string; duration?: number; billingMetrics?: Record<string, unknown> }> {
    const voiceId = await resolveVoiceId(options.voiceId);
    const outputFormat = mapElevenLabsFormat(options.responseFormat);
    const duration = audioDurationSeconds(audioBuffer, "audio/wav");
    const url = new URL(`https://api.elevenlabs.io${voicePath(ELEVENLABS_SPEECH_TO_SPEECH_PATH, voiceId)}`);
    const query = buildTextToSpeechQuery({ output_format: outputFormat });
    for (const [key, value] of query) {
        url.searchParams.set(key, value);
    }

    const form = new FormData();
    appendBlob(form, "audio", audioBuffer, "audio.wav");
    for (const [key, value] of Object.entries(buildSpeechToSpeechFields({ model_id: modelId }))) {
        form.set(key, value);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: elevenLabsHeaders({ Accept: elevenLabsMimeType(outputFormat) }),
        body: form,
    });
    if (!response.ok) {
        throw new Error(`ElevenLabs speech-to-speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || elevenLabsMimeType(outputFormat),
        ...(typeof duration === "number" ? {
            duration,
            billingMetrics: {
                second: duration,
                audio_second: duration,
            },
        } : {}),
    };
}
