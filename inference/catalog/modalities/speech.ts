import type { ModelCard } from "../../types.js";
import type { Usage } from "../../core.js";
import {
  buildCapability,
  getModelSourceShape,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
import { extractPricingUnits } from "../pricing.js";
import { isRealtimeOnlyModel } from "./realtime.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

function hasVoiceUnit(model: ModelCard): boolean {
  return extractPricingUnits(model.pricing).some((unit) =>
    unit.unitKey === "per_voice_usd" || unit.valueKeys.includes("voice")
  );
}

export function classifyAudioModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];
  if (isRealtimeOnlyModel(model, source)) {
    return capabilities;
  }

  if (hasInput(source, "text") && hasOutput(source, "audio") && hasVoiceUnit(model)) {
    capabilities.push(buildCapability(model, source, "audio", "voice-design", false, {
      input: ["text"],
      output: ["audio"],
    }));
  }
  if (hasSourceType(source, ["text-to-speech", "speech-generation"])) {
    if (!hasVoiceUnit(model)) {
      capabilities.push(buildCapability(model, source, "audio", "text-to-speech", false, {
        input: ["text"],
        output: ["audio"],
      }));
    }
  }
  if (hasSourceType(source, ["speech-to-speech"])) {
    capabilities.push(buildCapability(model, source, "audio", "speech-to-speech", false, {
      input: hasInput(source, "text") ? ["audio", "text"] : ["audio"],
      output: ["audio"],
    }));
  }
  if (hasSourceType(source, ["voice-conversion", "voice-changer"])) {
    capabilities.push(buildCapability(model, source, "audio", "speech-to-speech", false, {
      input: ["audio"],
      output: ["audio"],
    }));
  }
  if (hasSourceType(source, ["text-to-audio", "music-generation", "sound-effects", "text-to-sound-effects"])) {
    capabilities.push(buildCapability(model, source, "audio", "text-to-audio", false, {
      input: ["text"],
      output: ["audio"],
    }));
  }
  if (hasSourceType(source, ["audio-isolation", "voice-isolation"])) {
    capabilities.push(buildCapability(model, source, "audio", "audio-isolation", false, {
      input: ["audio"],
      output: ["audio"],
    }));
  }
  if (hasSourceType(source, ["audio-infill", "speech-infill"])) {
    capabilities.push(buildCapability(model, source, "audio", "audio-infill", false, {
      input: hasInput(source, "text") ? ["audio", "text"] : ["audio"],
      output: ["audio"],
    }));
  }
  if (hasSourceType(source, ["audio-classification"])) {
    capabilities.push(buildCapability(model, source, "audio", "audio-classification", false, {
      input: ["audio"],
      output: source.output,
    }));
  }
  if (hasSourceType(source, ["voice-activity-detection"])) {
    capabilities.push(buildCapability(model, source, "audio", "voice-activity-detection", true, {
      input: ["audio"],
      output: source.output,
    }));
  }
  if (hasSourceType(source, ["voice-cloning", "voice-clone"])) {
    capabilities.push(buildCapability(model, source, "audio", "voice-cloning", false, {
      input: ["audio"],
      output: source.output,
    }));
  }
  if (hasSourceType(source, ["voice-design"])) {
    capabilities.push(buildCapability(model, source, "audio", "voice-design", false, {
      input: ["text"],
      output: source.output,
    }));
  }
  // Catalog-friendly umbrella type "Speech" (normalized: "speech") used by
  // the curated `models.json`. Disambiguate by input/output shape so a
  // single source type yields the right canonical operation.
  if (hasSourceType(source, ["speech"])) {
    if (hasInput(source, "text") && hasOutput(source, "audio") && !hasOutput(source, "text")) {
      capabilities.push(buildCapability(model, source, "audio", "text-to-speech", false, {
        input: ["text"],
        output: ["audio"],
      }));
    }
    if (hasInput(source, "audio") && hasOutput(source, "audio") && !hasInput(source, "text")) {
      capabilities.push(buildCapability(model, source, "audio", "speech-to-speech", false, {
        input: ["audio"],
        output: ["audio"],
      }));
    }
  }
  if (hasSourceType(source, ["dumb-pipe"]) && (hasInput(source, "audio") || hasOutput(source, "audio"))) {
    capabilities.push(buildCapability(model, source, "audio", "dumb-pipe", false));
  }

  return uniqueCapabilities(capabilities);
}

export function audioDurationSeconds(buffer: Buffer, mimeType?: string): number | undefined {
  const type = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  const looksWav = type.includes("wav")
    || (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE");
  if (!looksWav || buffer.length < 44) {
    return undefined;
  }

  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(start + 8);
    } else if (id === "data") {
      dataSize = size;
    }
    offset = start + size + (size % 2);
  }

  if (!Number.isFinite(byteRate) || byteRate <= 0 || !Number.isFinite(dataSize) || dataSize <= 0) {
    return undefined;
  }

  return dataSize / byteRate;
}

function hasMusicGenerationParams(model?: ModelCard | null): boolean {
  return Boolean(model && hasSourceType(getModelSourceShape(model), ["music-generation"]));
}

export function getSpeechParameterCatalog(model?: ModelCard | null): Record<string, Record<string, unknown>> {
  const params: Record<string, Record<string, unknown>> = {
    format: {
      type: "string",
      required: false,
      options: ["mp3", "opus", "aac", "ogg", "wav", "flac"],
      description: "Output audio format.",
    },
    output_format: {
      type: "string",
      required: false,
      options: ["mp3", "opus", "aac", "ogg", "wav", "flac"],
      description: "Output audio format.",
    },
    sample_rate: {
      type: "integer",
      required: false,
      options: [8000, 16000, 22050, 24000, 32000, 44100, 48000],
      description: "Output audio sample rate.",
    },
    speed: {
      type: "number",
      required: false,
      default: 1,
      options: [1],
      description: "Speech speed multiplier.",
    },
    channel: {
      type: "integer",
      required: false,
      options: [1, 2],
      description: "Output audio channel count.",
    },
    duration_seconds: {
      type: "number",
      required: false,
      options: [1, 5, 10, 15, 30, 60],
      description: "Generated audio duration in seconds.",
    },
    prompt_influence: {
      type: "number",
      required: false,
      options: [0, 0.3, 0.5, 0.7, 1],
      description: "Prompt influence for sound or audio generation.",
    },
    loop: {
      type: "boolean",
      required: false,
      description: "Whether generated audio should loop cleanly.",
    },
    composition_plan: {
      type: "object",
      required: false,
      description: "Structured music composition plan.",
    },
  };

  if (hasMusicGenerationParams(model)) {
    params.music_length_ms = {
      type: "integer",
      required: false,
      options: [3000, 10000, 15000, 30000, 60000, 120000],
      description: "Generated music length in milliseconds.",
    };
  }

  return params;
}

// ===========================================================================
// Universal audio-modality types
// ===========================================================================

export type AudioFormat =
  | "mp3" | "wav" | "flac" | "opus" | "pcm" | "pcm16"
  | "aac" | "g711_ulaw" | "g711_alaw" | "ogg" | "webm";

export type AudioInput =
  | { type: "url"; url: string }
  | { type: "base64"; data: string; mediaType?: string }
  | { type: "file_id"; fileId: string }
  | { type: "blob"; bytes: Buffer | Uint8Array; mediaType?: string; filename?: string };

export type SpeechTimestampGranularity = "word" | "character" | "segment" | "sentence" | "phoneme";
export type SpeechCommitStrategy = "manual" | "vad";

export interface SpeechVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

export interface SpeechEndpointShape {
  method: "GET" | "POST" | "WSS";
  path: string;
  contentType?: "application/json" | "multipart/form-data" | "audio/*";
}

// ===========================================================================
// Text-to-speech / text-to-audio
// ===========================================================================

export interface SpeechRequest {
  /** Compose model id. */
  model: string;

  /** Operation hint. */
  operation?:
    | "text-to-speech" | "text-to-audio" | "music-generation" | "speech-to-speech"
    | "voice-design" | "voice-cloning" | "voice-conversion" | "audio-isolation" | "audio-infill";

  /** Input text (TTS / music with lyrics). */
  text?: string;
  /** Music generation. */
  lyrics?: string;
  prompt?: string;

  /** Voice id (system, cloned, or designed). */
  voice?: string;
  voice_id?: string;

  /** Output format. */
  format?: AudioFormat;
  output_format?: AudioFormat | "url" | "hex";

  /** Audio settings. */
  sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
  bitrate?: number;
  channel?: 1 | 2;
  /** Speech speed multiplier (most TTS: 0.5-2.0; ElevenLabs: 0.7-1.2). */
  speed?: number;
  /** Pitch shift (MiniMax: -12..12 semitones; Cartesia: -1..1). */
  pitch?: number;
  /** Volume gain. */
  volume?: number;
  /** Style / emotion. */
  emotion?: string;
  style?: string;
  /** Language hint. */
  language?: string;

  /** Streaming. */
  stream?: boolean;
  stream_options?: { exclude_aggregated_audio?: boolean };

  /** Subtitles / timestamps. */
  subtitles?: boolean;
  subtitle_type?: "sentence" | "word" | "word_streaming";

  /** Native — family-specific. */
  native?: SpeechRequestNative;
  customParams?: Record<string, unknown>;
}

export interface SpeechRequestNative {
  openai?: OpenAINativeSpeech;
  google?: GoogleNativeSpeech;
  elevenlabs?: ElevenLabsNativeSpeech;
  cartesia?: CartesiaNativeSpeech;
  minimax?: MinimaxNativeSpeech;
  deepgram?: DeepgramNativeSpeech;
  alibaba?: AlibabaNativeSpeech;
  zai?: ZaiNativeSpeech;
  playht?: PlayHTNativeSpeech;
  myshell?: MyshellNativeSpeech;
  cloudflare?: CloudflareNativeSpeech;
  stabilityai?: StabilityNativeSpeech;
  bytedance?: BytedanceNativeSpeech;
  pipecat?: PipecatNativeSpeech;
  tencent?: TencentNativeSpeech;
}

// ---------------------------------------------------------------------------
// OpenAI (tts-1, tts-1-hd, gpt-4o-mini-tts, gpt-realtime, gpt-image audio)
// ---------------------------------------------------------------------------

export interface OpenAINativeSpeech {
  /** Voice instructions (gpt-4o-mini-tts custom expression). */
  instructions?: string;
  /** Streaming format option override. */
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

// ---------------------------------------------------------------------------
// Google Gemini TTS / Lyria Music
// ---------------------------------------------------------------------------

export interface GoogleNativeSpeech {
  /** Gemini speechConfig. */
  speechConfig?: {
    voiceConfig?: { prebuiltVoiceConfig?: { voiceName: string } };
    languageCode?: string;
    /** Multi-speaker config. */
    multiSpeakerVoiceConfig?: { speakerVoiceConfigs: Array<{ speaker: string; voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }> };
  };
  /** Lyria music config. */
  lyriaConfig?: {
    seed?: number;
    bpm?: number;
    densityMode?: "low" | "medium" | "high";
    brightnessMode?: "warm" | "neutral" | "bright";
    scale?: string;
  };
}

// ---------------------------------------------------------------------------
// ElevenLabs (eleven-*)
// ---------------------------------------------------------------------------

export interface ElevenLabsNativeSpeech {
  /** Voice settings. */
  voice_settings?: SpeechVoiceSettings;
  /** Pronunciation dictionary. */
  pronunciation_dictionary_locators?: Array<{ pronunciation_dictionary_id: string; version_id: string }>;
  /** Latency optimization (0-4). */
  optimize_streaming_latency?: 0 | 1 | 2 | 3 | 4;
  /** Output format string ("mp3_44100_128"). */
  output_format?:
    | "mp3_22050_32" | "mp3_24000_48" | "mp3_44100_32" | "mp3_44100_64" | "mp3_44100_96" | "mp3_44100_128" | "mp3_44100_192"
    | "pcm_8000" | "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_32000" | "pcm_44100" | "pcm_48000"
    | "ulaw_8000" | "alaw_8000"
    | "opus_48000_32" | "opus_48000_64" | "opus_48000_96" | "opus_48000_128" | "opus_48000_192";
  enable_logging?: boolean;
  language_code?: string;
  seed?: number;
  previous_text?: string;
  next_text?: string;
  /** v3 only: previous request ids for prosody continuity. */
  previous_request_ids?: string[];
  next_request_ids?: string[];
  /** v3 mode (high-quality / streaming / multilingual). */
  apply_text_normalization?: "auto" | "on" | "off";
  /** Text-to-dialogue (v3). */
  inputs?: Array<{ text: string; voice_id: string }>;
  /** Speech-to-text / realtime STT. */
  keyterms?: string[];
  diarize?: boolean;
  num_speakers?: number;
  timestamps_granularity?: "word" | "character" | "none";
  include_timestamps?: boolean;
  include_language_detection?: boolean;
  audio_format?: "pcm_8000" | "pcm_16000" | "pcm_22050" | "pcm_24000" | "pcm_44100" | "pcm_48000" | "ulaw_8000";
  commit_strategy?: SpeechCommitStrategy;
  vad_silence_threshold_secs?: number;
  vad_threshold?: number;
  /** Sound-effects model knobs. */
  duration_seconds?: number;
  prompt_influence?: number;
  loop?: boolean;
  /** Voice design. */
  voice_description?: string;
  auto_generate_text?: boolean;
  guidance_scale?: number;
  stream_previews?: boolean;
  reference_audio_base64?: string;
  prompt_strength?: number;
  /** Music. */
  composition_plan?: Record<string, unknown>;
  music_length_ms?: number;
}

// ---------------------------------------------------------------------------
// Cartesia (sonic-*)
// ---------------------------------------------------------------------------

export interface CartesiaNativeSpeech {
  voice?: { mode: "id" | "embedding"; id?: string; embedding?: number[]; __experimental_controls?: { speed?: number; emotion?: string[] } };
  /** Cartesia stream-by-stream output container. */
  output_format?: { container: "raw" | "wav" | "mp3"; encoding?: "pcm_s16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw"; sample_rate?: number };
  /** Continuation tokens for streaming. */
  duration?: number;
  /** Language. */
  language?: "en" | "fr" | "de" | "es" | "pt" | "zh" | "ja" | "hi" | "it" | "ko" | "nl" | "pl" | "ru" | "sv" | "tr";
  save?: boolean;
  pronunciation_dict_id?: string;
  generation_config?: {
    volume?: number;
    speed?: number;
    emotion?: string[];
  };
  /** STT batch. */
  encoding?: "pcm_s16le" | "pcm_s32le" | "pcm_f16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw";
  sample_rate?: number;
  timestamp_granularities?: Array<Extract<SpeechTimestampGranularity, "word">>;
  /** Infill / voice changer. */
  left_audio?: AudioInput;
  right_audio?: AudioInput;
  transcript?: string;
  voice_id?: string;
}

// ---------------------------------------------------------------------------
// MiniMax (speech-2.8-hd, speech-2.8-turbo, speech-2.6-*, speech-02-*, music-2.6)
// ---------------------------------------------------------------------------

export interface MinimaxNativeSpeech {
  voice_setting?: {
    voice_id?: string;
    speed?: number;
    vol?: number;
    pitch?: number;
    emotion?: "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised" | "calm" | "fluent" | "whisper";
    text_normalization?: boolean;
    latex_read?: boolean;
  };
  audio_setting?: {
    sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100;
    bitrate?: 32000 | 64000 | 128000 | 256000;
    format?: "mp3" | "pcm" | "flac" | "wav" | "pcmu_raw" | "pcmu_wav" | "opus";
    channel?: 1 | 2;
    force_cbr?: boolean;
  };
  pronunciation_dict?: { tone?: string[] };
  timbre_weights?: Array<{ voice_id: string; weight: number }>;
  language_boost?: string;
  voice_modify?: {
    pitch?: number;
    intensity?: number;
    timbre?: number;
    sound_effects?: "spacious_echo" | "auditorium_echo" | "lofi_telephone" | "robotic";
  };
  /** Music mode. */
  is_instrumental?: boolean;
  lyrics_optimizer?: boolean;
  cover_feature_id?: string;
  audio_url?: string;
  audio_base64?: string;
}

// ---------------------------------------------------------------------------
// Deepgram (nova-*, aura-*, flux)
// ---------------------------------------------------------------------------

export interface DeepgramNativeSpeech {
  /** Aura voice. */
  encoding?: "linear16" | "mulaw" | "alaw" | "mp3" | "ogg-opus";
  sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
  container?: "wav" | "mp3" | "flac" | "ogg" | "raw";
  /** Streaming bitrate / chunking. */
  bit_rate?: number;
  /** Aura-2 callback. */
  callback?: string;
  /** Listen / Flux query parameters. */
  language?: string;
  language_hint?: string[];
  keyterm?: string[];
  smart_format?: boolean;
  punctuate?: boolean;
  paragraphs?: boolean;
  diarize?: boolean;
  utterances?: boolean;
  multichannel?: boolean;
  detect_language?: boolean;
  detect_entities?: boolean;
  redact?: string[];
  replace?: string[];
  filler_words?: boolean;
  summarize?: boolean | string;
  sentiment?: boolean;
  intents?: boolean;
  topics?: boolean;
  endpointing?: number;
  eot_threshold?: number;
  eager_eot_threshold?: number;
  eot_timeout_ms?: number;
  mip_opt_out?: boolean;
  tag?: string | string[];
}

// ---------------------------------------------------------------------------
// Alibaba (cosyvoice-*, paraformer, sambert-*)
// ---------------------------------------------------------------------------

export interface AlibabaNativeSpeech {
  /** CosyVoice-3 instruct mode. */
  instruct_text?: string;
  /** CosyVoice voice. */
  voice?: string;
  /** Sample-rate enum (DashScope). */
  sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
  /** Format. */
  format?: "mp3" | "wav" | "pcm";
  /** Pitch / speed. */
  pitch_rate?: number;
  speech_rate?: number;
  volume?: number;
}

// ---------------------------------------------------------------------------
// Z.AI (glm-tts, glm-asr-2512)
// ---------------------------------------------------------------------------

export interface ZaiNativeSpeech {
  /** Stream incremental ASR segments. */
  stream?: boolean;
  /** Language hint. */
  language?: string;
  /** Voice id. */
  voice_id?: string;
}

// ---------------------------------------------------------------------------
// PlayHT (playai, playht-1.0, playht-2.0, dialog)
// ---------------------------------------------------------------------------

export interface PlayHTNativeSpeech {
  voice_engine?: "Play3.0-mini" | "PlayDialog" | "PlayHT2.0-turbo";
  voice?: string;
  output_format?: "mp3" | "wav" | "ogg" | "flac" | "mulaw" | "raw";
  voice_guidance?: number;
  text_guidance?: number;
  style_guidance?: number;
  /** Multi-speaker dialog (PlayDialog). */
  prompt?: string;
  prompt2?: string;
  voice2?: string;
  turn_prefix?: string;
  turn_prefix2?: string;
}

// ---------------------------------------------------------------------------
// MyShell (melotts)
// ---------------------------------------------------------------------------

export interface MyshellNativeSpeech {
  language?: "EN" | "ES" | "FR" | "ZH" | "JP" | "KR";
  speaker?: string;
  speed?: number;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI (whisper, melotts, m2m100 audio)
// ---------------------------------------------------------------------------

export interface CloudflareNativeSpeech {
  parameters?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stability (stable-audio-2, stable-audio-controls)
// ---------------------------------------------------------------------------

export interface StabilityNativeSpeech {
  /** Audio-to-audio strength. */
  strength?: number;
  steps?: number;
  cfg_scale?: number;
  output_format?: "mp3" | "wav";
  duration?: number;       // seconds (1-190)
}

// ---------------------------------------------------------------------------
// ByteDance (doubao-tts, doubao-asr)
// ---------------------------------------------------------------------------

export interface BytedanceNativeSpeech {
  voice_type?: string;
  encoding?: "wav" | "pcm" | "mp3" | "ogg_opus";
  rate?: number;
  speed_ratio?: number;
  volume_ratio?: number;
  pitch_ratio?: number;
  emotion?: string;
}

// ---------------------------------------------------------------------------
// Pipecat AI (real-time conversational, smart-turn)
// ---------------------------------------------------------------------------

export interface PipecatNativeSpeech {
  /** Smart-turn detection sensitivity. */
  smart_turn_sensitivity?: "low" | "medium" | "high";
  /** Pipecat-flows config. */
  flow_id?: string;
}

// ---------------------------------------------------------------------------
// Tencent Hunyuan voice
// ---------------------------------------------------------------------------

export interface TencentNativeSpeech {
  /** Voice id. */
  VoiceType?: number;
  /** Sample rate. */
  Codec?: "mp3" | "pcm" | "wav";
  SampleRate?: 8000 | 16000 | 24000 | 48000;
  /** Speed (-2 to 6 maps roughly to 0.5x to 2x). */
  Speed?: number;
  Volume?: number;
}

// ===========================================================================
// Speech response types
// ===========================================================================

export interface GeneratedAudio {
  buffer?: Buffer;
  base64?: string;
  hex?: string;
  url?: string;
  mediaType: string;
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  /** Subtitle artifact. */
  subtitleUrl?: string;
  /** Per-sentence / per-word timestamps. */
  timestamps?: Array<{ start: number; end: number; text: string; speaker?: string }>;
  providerMetadata?: Record<string, unknown>;
}

export interface SpeechResponse {
  audio: GeneratedAudio[];
  /** Async LRO (MiniMax T2A async, Stability batch). */
  jobId?: string;
  status?: "queued" | "processing" | "completed" | "failed";
  /** Voice cloning artifact. */
  voiceId?: string;
  usage?: Usage;
  raw: unknown;
}

export type SpeechStreamEvent =
  | { type: "audio-chunk"; chunk: Buffer; sequenceIndex: number }
  | { type: "subtitle"; subtitle: { start: number; end: number; text: string } }
  | { type: "warning"; warning: { code: string; message: string } }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "done"; usage?: Usage };

// ===========================================================================
// Speech-to-text (transcription)
// ===========================================================================

export interface TranscriptionRequest {
  model: string;
  audio: AudioInput;

  /** OpenAI Whisper / Azure / Deepgram / Cloudflare. */
  language?: string;
  /** Optional priming prompt. */
  prompt?: string;
  /** Output format. */
  response_format?: "json" | "text" | "srt" | "vtt" | "verbose_json";
  /** Per-word vs per-sentence timestamps. */
  timestamp_granularities?: Array<"word" | "segment">;
  /** Sampling. */
  temperature?: number;

  native?: TranscriptionRequestNative;
  customParams?: Record<string, unknown>;
}

export interface TranscriptionRequestNative {
  openai?: { temperature?: number; chunking_strategy?: "auto" | { type: "server_vad"; prefix_padding_ms?: number; silence_duration_ms?: number; threshold?: number } };
  deepgram?: {
    /** Deepgram smart-format / punctuate / paragraphs / diarize. */
    smart_format?: boolean;
    punctuate?: boolean;
    paragraphs?: boolean;
    diarize?: boolean;
    utterances?: boolean;
    detect_language?: boolean;
    /** Custom keyword boost. */
    keywords?: Array<string>;
    /** Replace specified strings. */
    replace?: Array<string>;
    /** Filler words. */
    filler_words?: boolean;
    /** Topic detection / sentiment / intents (Nova-3 add-ons). */
    topics?: boolean;
    sentiment?: boolean;
    intents?: boolean;
    /** Multichannel. */
    multichannel?: boolean;
    /** Numerals normalization. */
    numerals?: boolean;
    /** Profanity filter. */
    profanity_filter?: boolean;
    /** Redaction. */
    redact?: Array<"pci" | "ssn" | "numbers">;
    /** Streaming endpointing. */
    endpointing?: number;
    /** Tier. */
    tier?: "enhanced" | "base" | "nova" | "nova-2" | "nova-3";
    /** Flux v2 turn-taking. */
    language_hint?: string[];
    eot_threshold?: number;
    eager_eot_threshold?: number;
    eot_timeout_ms?: number;
    keyterm?: string[];
    detect_entities?: boolean;
    summarize?: boolean | string;
  };
  alibaba?: { /** Paraformer real-time. */ disfluency_removal_enabled?: boolean; vocabulary_id?: string; format?: "json" | "text" };
  cloudflare?: { task?: "transcribe" | "translate"; vad_filter?: boolean };
  google?: { /** Gemini ASR. */ speechConfig?: Record<string, unknown> };
  zai?: { stream?: boolean };
  fireworks?: { /** Whisper-Fireworks. */ vad_model?: "silero" | "auvad"; perform_vad?: boolean };
}

export interface TranscriptionSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  language?: string;
  confidence?: number;
  /** Per-word breakdown. */
  words?: Array<{ word: string; start: number; end: number; confidence?: number }>;
}

export interface TranscriptionResponse {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments?: TranscriptionSegment[];
  /** Topics / sentiment / intents (Deepgram). */
  topics?: Array<{ topic: string; confidence: number }>;
  sentiment?: { overall?: "positive" | "negative" | "neutral"; segments?: Array<{ start: number; end: number; sentiment: string; confidence: number }> };
  intents?: Array<{ intent: string; confidence: number }>;
  usage?: Usage;
  raw: unknown;
}

// ===========================================================================
// Voice Cloning
// ===========================================================================

export interface VoiceCloneRequest {
  model: string;
  /** Reference audio. */
  audio: AudioInput;
  /** Caller-chosen voice id (must be unique per account). */
  voice_id: string;
  /** Reference text spoken in the audio. */
  text?: string;
  language?: string;
  accuracy?: number;
  need_noise_reduction?: boolean;
  need_volume_normalization?: boolean;
  /** ElevenLabs descriptive metadata. */
  description?: string;
  labels?: Record<string, string>;
  native?: VoiceCloneRequestNative;
  customParams?: Record<string, unknown>;
}

export interface VoiceCloneRequestNative {
  elevenlabs?: { name: string; description?: string; labels?: Record<string, string>; remove_background_noise?: boolean };
  minimax?: { aigc_watermark?: boolean };
  cartesia?: { mode?: "stability" | "similarity"; enhance?: boolean; transcript?: string };
  playht?: { voice_name: string };
}

export interface VoiceCloneResponse {
  voiceId: string;
  /** Demo audio rendering of the cloned voice. */
  demoAudio?: GeneratedAudio;
  /** Sensitive-content flags. */
  inputSensitive?: boolean;
  raw: unknown;
}

// ===========================================================================
// Voice Design (text → voice)
// ===========================================================================

export interface VoiceDesignRequest {
  model: string;
  prompt: string;
  preview_text: string;
  voice_id?: string;
  /** ElevenLabs voice-design knobs. */
  gender?: "male" | "female" | "neutral";
  age?: "young" | "middle_aged" | "old";
  accent?: string;
  accent_strength?: number;
  native?: { elevenlabs?: { text: string; voice_description: string }; minimax?: Record<string, unknown> };
  customParams?: Record<string, unknown>;
}

export interface VoiceDesignResponse {
  voiceId: string;
  previewAudio?: GeneratedAudio;
  raw: unknown;
}
