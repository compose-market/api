/**
 * MiniMax (Hailuo) family wire.
 *
 * Pure protocol module: builds MiniMax request bodies and parses
 * responses + SSE frames into family-native types. NO endpoints,
 * NO API keys, NO network calls — vendors own the transport.
 *
 * Hosts (per https://api.minimax.io vs. https://api.minimaxi.com):
 *   - `api.minimax.io`     — Global region
 *   - `api.minimaxi.com`   — Mainland-China region
 *   - `api-uw.minimax.io`  — Lower-latency T2A endpoint
 *
 * Surfaces covered (all use Bearer JWT auth):
 *   - Chat Completion v2 — Anthropic + OpenAI compat (use the
 *     existing `families/anthropic.ts` / `families/openai.ts` body
 *     builders; MiniMax-M2.7 / M2.5 / M2.1 / M2 land there).
 *   - `POST /v1/t2a_v2`                       Sync TTS (HTTP)
 *   - `POST /v1/t2a_async_v2`                 Async long-text T2A
 *   - `GET  /v1/query/t2a_async_query_v2`     Poll T2A async task
 *   - `POST /v1/t2v_v2`                       (legacy T2V; replaced by /v1/video_generation)
 *   - `POST /v1/voice_clone`                  Voice cloning
 *   - `POST /v1/voice_design`                 Voice design from prompt
 *   - `POST /v1/voice_clone/upload_audio`     Upload reference audio
 *   - `POST /v1/video_generation`             Video LRO submit (T2V)
 *   - `POST /v1/video_generation`             with `first_frame_image` for I2V
 *   - `GET  /v1/query/video_generation`       Poll task
 *   - `POST /v1/video_agent_create`           Video Agent template
 *   - `GET  /v1/query/video_agent`            Poll Video Agent
 *   - `POST /v1/image_generation`             T2I (image-01)
 *   - `POST /v1/music_generation`             Music (music-2.6)
 *   - `POST /v1/files/upload`                 File upload (multipart)
 *   - `GET  /v1/files/list`                   List files
 *   - `GET  /v1/files/retrieve`               Retrieve metadata
 *   - `GET  /v1/files/retrieve_content`       Download file
 *   - `POST /v1/files/delete`                 Delete file
 *
 * MiniMax `base_resp.status_code` is the authoritative error
 * indicator — `200 OK` HTTP responses can still carry non-zero
 * status codes. Vendors check this after parsing.
 */

import { asRecord, assignMetric, clean, readNonNeg } from "../shared/index.js";
import type { Usage } from "../../core.js";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const MINIMAX_PATH_T2A = "/v1/t2a_v2";
export const MINIMAX_PATH_T2A_ASYNC_CREATE = "/v1/t2a_async_v2";
export const MINIMAX_PATH_T2A_ASYNC_QUERY = "/v1/query/t2a_async_query_v2";
export const MINIMAX_PATH_VOICE_CLONE = "/v1/voice_clone";
export const MINIMAX_PATH_VOICE_CLONE_UPLOAD = "/v1/voice_clone/upload_audio";
export const MINIMAX_PATH_VOICE_DESIGN = "/v1/voice_design";
export const MINIMAX_PATH_VIDEO_CREATE = "/v1/video_generation";
export const MINIMAX_PATH_VIDEO_QUERY = "/v1/query/video_generation";
export const MINIMAX_PATH_VIDEO_AGENT_CREATE = "/v1/video_agent_create";
export const MINIMAX_PATH_VIDEO_AGENT_QUERY = "/v1/query/video_agent";
export const MINIMAX_PATH_IMAGE = "/v1/image_generation";
export const MINIMAX_PATH_MUSIC = "/v1/music_generation";
export const MINIMAX_PATH_FILE_UPLOAD = "/v1/files/upload";
export const MINIMAX_PATH_FILE_LIST = "/v1/files/list";
export const MINIMAX_PATH_FILE_RETRIEVE = "/v1/files/retrieve";
export const MINIMAX_PATH_FILE_CONTENT = "/v1/files/retrieve_content";
export const MINIMAX_PATH_FILE_DELETE = "/v1/files/delete";

// ---------------------------------------------------------------------------
// base_resp
// ---------------------------------------------------------------------------

export interface MinimaxBaseResp {
    status_code: number;
    status_msg: string;
}

/**
 * Throws when MiniMax `base_resp.status_code` is non-zero.
 */
export function assertBaseResp(raw: unknown, label: string): void {
    const root = asRecord(raw);
    const baseResp = asRecord(root?.base_resp);
    if (!baseResp) return;
    const code = typeof baseResp.status_code === "number" ? baseResp.status_code : 0;
    if (code === 0) return;
    throw new Error(`MiniMax ${label} status ${code}: ${clean(baseResp.status_msg) || "unknown"}`);
}

// ---------------------------------------------------------------------------
// T2A (text-to-audio v2) — body builder + response parser
// ---------------------------------------------------------------------------

export type MinimaxT2AModel =
    | "speech-2.8-hd" | "speech-2.8-turbo"
    | "speech-2.6-hd" | "speech-2.6-turbo"
    | "speech-02-hd" | "speech-02-turbo"
    | "speech-01-hd" | "speech-01-turbo";

export type MinimaxAudioFormat = "mp3" | "pcm" | "flac" | "wav" | "pcmu_raw" | "pcmu_wav" | "opus";

export type MinimaxEmotion =
    | "happy" | "sad" | "angry" | "fearful"
    | "disgusted" | "surprised" | "calm"
    | "fluent" | "whisper";

export interface MinimaxVoiceSetting {
    voice_id?: string;
    speed?: number;       // [0.5, 2]
    vol?: number;         // (0, 10]
    pitch?: number;       // [-12, 12]
    emotion?: MinimaxEmotion;
    text_normalization?: boolean;
    latex_read?: boolean;
}

export interface MinimaxAudioSetting {
    sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100;
    bitrate?: 32000 | 64000 | 128000 | 256000;
    format?: MinimaxAudioFormat;
    channel?: 1 | 2;
    force_cbr?: boolean;
}

export interface MinimaxTimbreWeight {
    voice_id: string;
    weight: number;       // [1, 100]
}

export interface MinimaxVoiceModify {
    pitch?: number;       // [-100, 100]
    intensity?: number;
    timbre?: number;
    sound_effects?: "spacious_echo" | "auditorium_echo" | "lofi_telephone" | "robotic";
}

export interface MinimaxPronunciationDict {
    tone?: string[];
}

export interface MinimaxT2AOptions {
    voiceSetting?: MinimaxVoiceSetting;
    audioSetting?: MinimaxAudioSetting;
    pronunciationDict?: MinimaxPronunciationDict;
    timbreWeights?: MinimaxTimbreWeight[];
    languageBoost?: string;
    voiceModify?: MinimaxVoiceModify;
    subtitleEnable?: boolean;
    subtitleType?: "sentence" | "word" | "word_streaming";
    outputFormat?: "url" | "hex";
    streamOptions?: { exclude_aggregated_audio?: boolean };
}

export function buildT2ABody(
    model: MinimaxT2AModel | string,
    text: string,
    options: MinimaxT2AOptions = {},
    streaming = false,
): Record<string, unknown> {
    return {
        model,
        text,
        ...(streaming ? { stream: true } : { stream: false }),
        ...(options.streamOptions ? { stream_options: options.streamOptions } : {}),
        ...(options.voiceSetting ? { voice_setting: options.voiceSetting } : {}),
        ...(options.audioSetting ? { audio_setting: options.audioSetting } : {}),
        ...(options.pronunciationDict ? { pronunciation_dict: options.pronunciationDict } : {}),
        ...(options.timbreWeights ? { timbre_weights: options.timbreWeights } : {}),
        ...(options.languageBoost ? { language_boost: options.languageBoost } : {}),
        ...(options.voiceModify ? { voice_modify: options.voiceModify } : {}),
        ...(typeof options.subtitleEnable === "boolean" ? { subtitle_enable: options.subtitleEnable } : {}),
        ...(options.subtitleType ? { subtitle_type: options.subtitleType } : {}),
        ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
    };
}

export interface MinimaxT2AResult {
    audioHex?: string;
    audioUrl?: string;
    /** Status: 1 = synthesizing chunk, 2 = synthesis completed. */
    status: number;
    subtitleFile?: string;
    extraInfo?: {
        audioLengthMs?: number;
        audioSampleRate?: number;
        audioSizeBytes?: number;
        bitrate?: number;
        audioFormat?: MinimaxAudioFormat;
        audioChannel?: number;
        wordCount?: number;
        usageCharacters?: number;
        invisibleCharacterRatio?: number;
    };
    traceId?: string;
    raw: unknown;
}

export function parseT2AResponse(raw: unknown): MinimaxT2AResult {
    assertBaseResp(raw, "T2A");
    const root = asRecord(raw) || {};
    const data = asRecord(root.data) || {};
    const audioField = clean(data.audio);
    const isHex = !audioField.startsWith("http");
    const extra = asRecord(root.extra_info);
    return {
        ...(isHex && audioField ? { audioHex: audioField } : {}),
        ...(!isHex && audioField ? { audioUrl: audioField } : {}),
        status: typeof data.status === "number" ? data.status : 2,
        ...(typeof data.subtitle_file === "string" ? { subtitleFile: data.subtitle_file } : {}),
        ...(extra ? {
            extraInfo: {
                audioLengthMs: readNonNeg(extra, ["audio_length"]),
                audioSampleRate: readNonNeg(extra, ["audio_sample_rate"]),
                audioSizeBytes: readNonNeg(extra, ["audio_size"]),
                bitrate: readNonNeg(extra, ["bitrate"]),
                ...(typeof extra.audio_format === "string" ? { audioFormat: extra.audio_format as MinimaxAudioFormat } : {}),
                audioChannel: readNonNeg(extra, ["audio_channel"]),
                wordCount: readNonNeg(extra, ["word_count"]),
                usageCharacters: readNonNeg(extra, ["usage_characters"]),
                ...(typeof extra.invisible_character_ratio === "number" ? { invisibleCharacterRatio: extra.invisible_character_ratio } : {}),
            },
        } : {}),
        ...(typeof root.trace_id === "string" ? { traceId: root.trace_id } : {}),
        raw,
    };
}

/**
 * Build a `Usage` shape from MiniMax T2A `extra_info` so the
 * gateway's billing pipeline can charge by usage_characters /
 * audio_length.
 */
export function usageFromT2A(extraInfo: MinimaxT2AResult["extraInfo"]): Usage | undefined {
    if (!extraInfo) return undefined;
    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "character", extraInfo.usageCharacters);
    assignMetric(billingMetrics, "audio_length_ms", extraInfo.audioLengthMs);
    if (typeof extraInfo.audioLengthMs === "number") {
        const seconds = extraInfo.audioLengthMs / 1000;
        billingMetrics.second = seconds;
        billingMetrics.minute = seconds / 60;
    }
    return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        billingMetrics,
    };
}

// ---------------------------------------------------------------------------
// Voice Cloning — body builder + response parser
// ---------------------------------------------------------------------------

export interface MinimaxVoiceCloneOptions {
    /** Required — file_id from /v1/files/upload (purpose: voice_clone). */
    fileId: string;
    /** Caller-chosen new voice id, must match `^[a-zA-Z][a-zA-Z0-9]{0,99}$`. */
    voiceId: string;
    /** Reference text spoken in the audio (improves cloning accuracy). */
    text?: string;
    /** Reference language. */
    model?: MinimaxT2AModel;
    accuracy?: number;
    needNoiseReduction?: boolean;
    needVolumeNormalization?: boolean;
    /** Set to `true` to bake-in cloned voice with no charge until first use. */
    aigcWatermark?: boolean;
}

export function buildVoiceCloneBody(options: MinimaxVoiceCloneOptions): Record<string, unknown> {
    return {
        file_id: options.fileId,
        voice_id: options.voiceId,
        ...(options.text ? { text: options.text } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(typeof options.accuracy === "number" ? { accuracy: options.accuracy } : {}),
        ...(typeof options.needNoiseReduction === "boolean" ? { need_noise_reduction: options.needNoiseReduction } : {}),
        ...(typeof options.needVolumeNormalization === "boolean" ? { need_volume_normalization: options.needVolumeNormalization } : {}),
        ...(typeof options.aigcWatermark === "boolean" ? { aigc_watermark: options.aigcWatermark } : {}),
    };
}

export interface MinimaxVoiceCloneResult {
    inputSensitive?: boolean;
    inputSensitiveType?: number;
    demoAudio?: string;
    raw: unknown;
}

export function parseVoiceCloneResponse(raw: unknown): MinimaxVoiceCloneResult {
    assertBaseResp(raw, "voice_clone");
    const root = asRecord(raw) || {};
    return {
        ...(typeof root.input_sensitive === "boolean" ? { inputSensitive: root.input_sensitive } : {}),
        ...(typeof root.input_sensitive_type === "number" ? { inputSensitiveType: root.input_sensitive_type } : {}),
        ...(typeof root.demo_audio === "string" ? { demoAudio: root.demo_audio } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Voice Design — generate a custom voice from a description prompt
// ---------------------------------------------------------------------------

export interface MinimaxVoiceDesignOptions {
    prompt: string;
    previewText: string;
    /** Caller-chosen voice id (will be assigned to the generated voice). */
    voiceId?: string;
    model?: MinimaxT2AModel;
}

export function buildVoiceDesignBody(options: MinimaxVoiceDesignOptions): Record<string, unknown> {
    return {
        prompt: options.prompt,
        preview_text: options.previewText,
        ...(options.voiceId ? { voice_id: options.voiceId } : {}),
        ...(options.model ? { model: options.model } : {}),
    };
}

export interface MinimaxVoiceDesignResult {
    voiceId: string;
    /** Hex-encoded preview audio of the designed voice speaking previewText. */
    previewAudioHex?: string;
    raw: unknown;
}

export function parseVoiceDesignResponse(raw: unknown): MinimaxVoiceDesignResult {
    assertBaseResp(raw, "voice_design");
    const root = asRecord(raw) || {};
    const data = asRecord(root.data) || {};
    return {
        voiceId: clean(data.voice_id) || clean(root.voice_id),
        ...(typeof data.audio === "string" ? { previewAudioHex: data.audio } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Video Generation (Hailuo) — body + status parser
// ---------------------------------------------------------------------------

export type MinimaxVideoModel =
    | "MiniMax-Hailuo-2.3"
    | "MiniMax-Hailuo-2.3-Fast"
    | "MiniMax-Hailuo-02"
    | "T2V-01-Director"
    | "T2V-01"
    | "I2V-01"
    | "I2V-01-Director"
    | "I2V-01-live";

export type MinimaxVideoResolution = "720P" | "768P" | "1080P";

export interface MinimaxVideoOptions {
    promptOptimizer?: boolean;
    fastPretreatment?: boolean;
    duration?: 6 | 10;
    resolution?: MinimaxVideoResolution;
    callbackUrl?: string;
    /** Image-to-video — base64 (no data: prefix) or URL. */
    firstFrameImage?: string;
    lastFrameImage?: string;
    /** Reference subject(s) for character consistency. */
    subjectReference?: Array<{ type: string; image?: string[] }>;
}

export function buildVideoBody(
    model: MinimaxVideoModel | string,
    prompt: string,
    options: MinimaxVideoOptions = {},
): Record<string, unknown> {
    return {
        model,
        prompt,
        ...(typeof options.promptOptimizer === "boolean" ? { prompt_optimizer: options.promptOptimizer } : {}),
        ...(typeof options.fastPretreatment === "boolean" ? { fast_pretreatment: options.fastPretreatment } : {}),
        ...(typeof options.duration === "number" ? { duration: options.duration } : {}),
        ...(options.resolution ? { resolution: options.resolution } : {}),
        ...(options.callbackUrl ? { callback_url: options.callbackUrl } : {}),
        ...(options.firstFrameImage ? { first_frame_image: options.firstFrameImage } : {}),
        ...(options.lastFrameImage ? { last_frame_image: options.lastFrameImage } : {}),
        ...(options.subjectReference ? { subject_reference: options.subjectReference } : {}),
    };
}

export interface MinimaxVideoTaskHandle {
    taskId: string;
    raw: unknown;
}

export function parseVideoSubmitResponse(raw: unknown): MinimaxVideoTaskHandle {
    assertBaseResp(raw, "video_generation");
    const root = asRecord(raw) || {};
    const taskId = clean(root.task_id);
    if (!taskId) throw new Error("MiniMax video_generation returned no task_id");
    return { taskId, raw };
}

export type MinimaxTaskStatus = "Queueing" | "Preparing" | "Processing" | "Success" | "Fail";

export interface MinimaxVideoTaskResult {
    taskId: string;
    status: MinimaxTaskStatus;
    fileId?: string;
    videoWidth?: number;
    videoHeight?: number;
    raw: unknown;
}

export function parseVideoQueryResponse(raw: unknown): MinimaxVideoTaskResult {
    assertBaseResp(raw, "video_generation_query");
    const root = asRecord(raw) || {};
    const status = clean(root.status) as MinimaxTaskStatus;
    return {
        taskId: clean(root.task_id),
        status,
        ...(root.file_id ? { fileId: clean(root.file_id) } : {}),
        ...(typeof root.video_width === "number" ? { videoWidth: root.video_width } : {}),
        ...(typeof root.video_height === "number" ? { videoHeight: root.video_height } : {}),
        raw,
    };
}

export function isTerminalTaskStatus(status: MinimaxTaskStatus): boolean {
    return status === "Success" || status === "Fail";
}

// ---------------------------------------------------------------------------
// Image Generation (image-01) — body + response parser
// ---------------------------------------------------------------------------

export interface MinimaxImageOptions {
    n?: number;          // 1-9
    aspectRatio?: "1:1" | "16:9" | "4:3" | "3:2" | "2:3" | "3:4" | "9:16" | "21:9";
    width?: number;
    height?: number;
    promptOptimizer?: boolean;
    /** Reference image URL or base64 — for image-to-image. */
    subjectReference?: Array<{
        type: "character";
        image_file?: string;
    }>;
    /** Output format: "url" | "base64". */
    responseFormat?: "url" | "base64";
}

export function buildImageBody(
    model: string,
    prompt: string,
    options: MinimaxImageOptions = {},
): Record<string, unknown> {
    return {
        model,
        prompt,
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
        ...(typeof options.width === "number" ? { width: options.width } : {}),
        ...(typeof options.height === "number" ? { height: options.height } : {}),
        ...(typeof options.promptOptimizer === "boolean" ? { prompt_optimizer: options.promptOptimizer } : {}),
        ...(options.subjectReference ? { subject_reference: options.subjectReference } : {}),
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    };
}

export interface MinimaxImageResult {
    imageUrls?: string[];
    imageBase64?: string[];
    raw: unknown;
}

export function parseImageResponse(raw: unknown): MinimaxImageResult {
    assertBaseResp(raw, "image_generation");
    const root = asRecord(raw) || {};
    const data = asRecord(root.data) || {};
    return {
        ...(Array.isArray(data.image_urls) ? { imageUrls: data.image_urls.map(clean).filter(Boolean) as string[] } : {}),
        ...(Array.isArray(data.image_base64) ? { imageBase64: data.image_base64.map(clean).filter(Boolean) as string[] } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Music Generation (music-2.6) — body + response parser
// ---------------------------------------------------------------------------

export type MinimaxMusicModel = "music-2.6" | "music-cover" | "music-2.6-free" | "music-cover-free";

export interface MinimaxMusicOptions {
    prompt?: string;
    lyrics?: string;
    audioSetting?: { sample_rate?: number; bitrate?: number; format?: "mp3" | "wav" | "pcm" };
    outputFormat?: "url" | "hex";
    lyricsOptimizer?: boolean;
    isInstrumental?: boolean;
    /** Cover mode — exactly one of these three. */
    audioUrl?: string;
    audioBase64?: string;
    coverFeatureId?: string;
}

export function buildMusicBody(
    model: MinimaxMusicModel | string,
    options: MinimaxMusicOptions = {},
    streaming = false,
): Record<string, unknown> {
    return {
        model,
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.lyrics ? { lyrics: options.lyrics } : {}),
        ...(streaming ? { stream: true } : {}),
        ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
        ...(options.audioSetting ? { audio_setting: options.audioSetting } : {}),
        ...(typeof options.lyricsOptimizer === "boolean" ? { lyrics_optimizer: options.lyricsOptimizer } : {}),
        ...(typeof options.isInstrumental === "boolean" ? { is_instrumental: options.isInstrumental } : {}),
        ...(options.audioUrl ? { audio_url: options.audioUrl } : {}),
        ...(options.audioBase64 ? { audio_base64: options.audioBase64 } : {}),
        ...(options.coverFeatureId ? { cover_feature_id: options.coverFeatureId } : {}),
    };
}

export interface MinimaxMusicResult {
    audioHex?: string;
    audioUrl?: string;
    status: number;
    extraInfo?: {
        musicDurationMs?: number;
        musicSampleRate?: number;
        musicChannel?: number;
        bitrate?: number;
        musicSizeBytes?: number;
    };
    traceId?: string;
    raw: unknown;
}

export function parseMusicResponse(raw: unknown): MinimaxMusicResult {
    assertBaseResp(raw, "music_generation");
    const root = asRecord(raw) || {};
    const data = asRecord(root.data) || {};
    const audioField = clean(data.audio);
    const isHex = !audioField.startsWith("http");
    const extra = asRecord(root.extra_info);
    return {
        ...(isHex && audioField ? { audioHex: audioField } : {}),
        ...(!isHex && audioField ? { audioUrl: audioField } : {}),
        status: typeof data.status === "number" ? data.status : 2,
        ...(extra ? {
            extraInfo: {
                musicDurationMs: readNonNeg(extra, ["music_duration"]),
                musicSampleRate: readNonNeg(extra, ["music_sample_rate"]),
                musicChannel: readNonNeg(extra, ["music_channel"]),
                bitrate: readNonNeg(extra, ["bitrate"]),
                musicSizeBytes: readNonNeg(extra, ["music_size"]),
            },
        } : {}),
        ...(typeof root.trace_id === "string" ? { traceId: root.trace_id } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Files API — upload (multipart), retrieve, delete
// ---------------------------------------------------------------------------

export type MinimaxFilePurpose = "voice_clone" | "video_generation" | "music_cover" | "retrieval" | "fine-tune";

/**
 * Body fields for `POST /v1/files/upload`. The actual request is
 * multipart/form-data — vendors assemble the multipart with `file`
 * and merge these fields in.
 */
export function buildFileUploadFields(purpose: MinimaxFilePurpose | string): Record<string, string> {
    return { purpose: String(purpose) };
}

export interface MinimaxFileObject {
    fileId: string;
    bytes: number;
    createdAt: number;
    filename: string;
    purpose: string;
    raw: unknown;
}

export function parseFileUploadResponse(raw: unknown): MinimaxFileObject {
    assertBaseResp(raw, "files_upload");
    const root = asRecord(raw) || {};
    const file = asRecord(root.file) || root;
    return {
        fileId: clean(file.file_id),
        bytes: readNonNeg(file, ["bytes"]) ?? 0,
        createdAt: readNonNeg(file, ["created_at"]) ?? 0,
        filename: clean(file.filename),
        purpose: clean(file.purpose),
        raw,
    };
}
