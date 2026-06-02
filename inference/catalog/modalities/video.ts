import type { ModelCard } from "../../types.js";
import type { Request, Usage } from "../../core.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

export function classifyVideoModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  if (hasSourceType(source, ["text-to-video"])) {
    capabilities.push(buildCapability(model, source, "video", "text-to-video", false, {
      input: ["text"],
      output: ["video"],
    }));
  }

  if (hasSourceType(source, ["image-to-video"])) {
    capabilities.push(buildCapability(model, source, "video", "image-to-video", false, {
      input: hasInput(source, "text") ? ["image", "text"] : ["image"],
      output: ["video"],
    }));
  }

  if (hasSourceType(source, ["video-to-text", "video-classification"])) {
    capabilities.push(buildCapability(model, source, "video", "video-to-text", false, {
      input: hasInput(source, "text") ? ["video", "text"] : ["video"],
      output: ["text"],
    }));
  }

  if (hasSourceType(source, ["video-edit", "video-to-video"])) {
    capabilities.push(buildCapability(model, source, "video", "video-edit", false, {
      input: source.input.length > 0 ? source.input : ["video"],
      output: ["video"],
    }));
  }

  // Catalog-friendly umbrella types ("video generation" / "videos") that
  // the curated `models.json` uses. Disambiguate by input shape.
  if (hasSourceType(source, ["videos", "video-generation"]) && hasOutput(source, "video")) {
    if (hasInput(source, "video")) {
      capabilities.push(buildCapability(model, source, "video", "video-edit", false, {
        input: source.input.length > 0 ? source.input : ["video"],
        output: ["video"],
      }));
    } else if (hasInput(source, "image")) {
      capabilities.push(buildCapability(model, source, "video", "image-to-video", false, {
        input: hasInput(source, "text") ? ["image", "text"] : ["image"],
        output: ["video"],
      }));
    } else if (hasInput(source, "text")) {
      capabilities.push(buildCapability(model, source, "video", "text-to-video", false, {
        input: ["text"],
        output: ["video"],
      }));
    }
  }

  return uniqueCapabilities(capabilities);
}

export interface VideoSubmissionOptions {
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  size?: string;
  imageUrl?: string;
  videoUrl?: string;
  customParams?: Record<string, unknown>;
}

export function getVideoParameterCatalog(provider?: string): Record<string, Record<string, unknown>> {
  const family = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const googleVideo = family === "gemini" || family === "vertex";
  const alibabaVideo = family === "alibaba";
  return {
    duration: {
      type: "integer",
      required: false,
      options: googleVideo ? [5, 6, 7, 8] : [4, 5, 6, 8, 10, 12],
      description: "Generated video duration in seconds.",
    },
    fps: {
      type: "integer",
      required: false,
      options: [16, 24, 30, 60],
      description: "Generated video frame rate.",
    },
    size: {
      type: "string",
      required: false,
      options: ["854x480", "1280x720", "1920x1080", "3840x2160"],
      description: "Generated video size.",
    },
    aspect_ratio: {
      type: "string",
      required: false,
      options: ["16:9", "9:16", "1:1", "21:9"],
      description: "Generated video aspect ratio.",
    },
    resolution: {
      type: "string",
      required: false,
      options: googleVideo ? ["720p", "1080p"] : ["480P", "540P", "720P", "768P", "1080P", "4K"],
      description: "Generated video resolution.",
    },
    output_format: {
      type: "string",
      required: false,
      options: ["mp4", "webm", "mov"],
      description: "Generated video output format.",
    },
    ...(alibabaVideo ? {
      prompt_extend: {
        type: "boolean",
        required: false,
        default: false,
        description: "Whether Alibaba Wan rewrites the prompt before video generation.",
      },
    } : {}),
  };
}

export interface GoogleVideoReferenceImage {
  imageBytes: string;
  mimeType: string;
}

function hasValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function copyCustomParams(params?: Record<string, unknown>): Record<string, unknown> {
  if (!params) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => hasValue(value) || Array.isArray(value) || (value !== null && typeof value === "object")),
  );
}

export function selectVideoTaskForInput(imageUrl?: string | null): "text-to-video" | "image-to-video" {
  return typeof imageUrl === "string" && imageUrl.length > 0 ? "image-to-video" : "text-to-video";
}

export function buildOpenAIVideoSubmissionBody(
  modelId: string,
  prompt: string,
  options?: VideoSubmissionOptions,
): Record<string, unknown> {
  const customParams = options?.customParams || {};
  const size = typeof options?.size === "string"
    ? options.size
    : typeof customParams.size === "string"
      ? customParams.size
      : undefined;

  return {
    model: modelId,
    prompt,
    ...(size ? { size } : {}),
    ...(typeof options?.duration === "number" && options.duration > 0 ? { seconds: String(options.duration) } : {}),
    ...(options?.imageUrl || options?.videoUrl ? {
      input_reference: options?.videoUrl
        ? { video_url: options.videoUrl }
        : { image_url: options.imageUrl },
    } : {}),
  };
}

export function buildAIMLVideoSubmissionBody(
  modelId: string,
  prompt: string,
  options?: VideoSubmissionOptions,
): Record<string, unknown> {
  const customParams = copyCustomParams(options?.customParams);
  return {
    model: modelId,
    prompt,
    ...customParams,
    ...(typeof options?.duration === "number" && options.duration > 0 ? { duration: String(options.duration) } : {}),
    ...(options?.resolution ? { resolution: options.resolution } : {}),
    ...(options?.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
    ...(options?.size ? { size: options.size } : {}),
    ...(options?.imageUrl ? { image_url: options.imageUrl } : {}),
    ...(options?.videoUrl ? { video_url: options.videoUrl } : {}),
  };
}

export function buildGoogleVideoGenerationRequest(
  modelId: string,
  prompt: string,
  options?: VideoSubmissionOptions,
  referenceImage?: GoogleVideoReferenceImage,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (typeof options?.duration === "number" && options.duration > 0) {
    config.durationSeconds = options.duration;
  }
  if (options?.aspectRatio) {
    config.aspectRatio = options.aspectRatio;
  }
  if (options?.resolution) {
    config.resolution = options.resolution;
  }

  return {
    model: modelId,
    source: {
      prompt,
      ...(referenceImage ? { image: referenceImage } : {}),
    },
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function buildVertexVideoParameters(options?: VideoSubmissionOptions): Record<string, unknown> {
  return {
    ...(options?.customParams ? copyCustomParams(options.customParams) : {}),
    ...(typeof options?.duration === "number" && options.duration > 0 ? { durationSeconds: options.duration } : {}),
    ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
    ...(options?.resolution ? { resolution: options.resolution } : {}),
  };
}

interface Mp4VideoMetadata {
  durationSeconds?: number;
  width?: number;
  height?: number;
}

const MP4_CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
]);

function readBoxType(buffer: Buffer, offset: number): string {
  return buffer.toString("ascii", offset, offset + 4);
}

function parseMp4Boxes(buffer: Buffer, start: number, end: number, metadata: Mp4VideoMetadata): void {
  let offset = start;

  while (offset + 8 <= end) {
    const size32 = buffer.readUInt32BE(offset);
    const type = readBoxType(buffer, offset + 4);
    let headerSize = 8;
    let boxSize = size32;

    if (size32 === 1) {
      if (offset + 16 > end) {
        return;
      }
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return;
      }
      boxSize = Number(largeSize);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = end - offset;
    }

    if (boxSize < headerSize || offset + boxSize > end) {
      return;
    }

    const payloadStart = offset + headerSize;
    const payloadEnd = offset + boxSize;

    if (type === "mvhd" && payloadStart + 20 <= payloadEnd) {
      const version = buffer[payloadStart];
      if (version === 0 && payloadStart + 20 <= payloadEnd) {
        const timescale = buffer.readUInt32BE(payloadStart + 12);
        const duration = buffer.readUInt32BE(payloadStart + 16);
        if (timescale > 0 && duration > 0) {
          metadata.durationSeconds = duration / timescale;
        }
      } else if (version === 1 && payloadStart + 32 <= payloadEnd) {
        const timescale = buffer.readUInt32BE(payloadStart + 20);
        const duration = buffer.readBigUInt64BE(payloadStart + 24);
        if (timescale > 0 && duration > 0n) {
          metadata.durationSeconds = Number(duration) / timescale;
        }
      }
    }

    if (type === "tkhd" && payloadEnd - payloadStart >= 8) {
      const width = buffer.readUInt32BE(payloadEnd - 8) / 65536;
      const height = buffer.readUInt32BE(payloadEnd - 4) / 65536;
      if (width > 0 && height > 0) {
        metadata.width = width;
        metadata.height = height;
      }
    }

    if (MP4_CONTAINER_BOXES.has(type)) {
      parseMp4Boxes(buffer, payloadStart, payloadEnd, metadata);
    }

    offset += boxSize;
  }
}

function readMp4VideoMetadata(buffer: Buffer): Mp4VideoMetadata {
  const metadata: Mp4VideoMetadata = {};
  parseMp4Boxes(buffer, 0, buffer.length, metadata);
  return metadata;
}

export function videoBillingMetricsFromOutput(args: {
  request: Request;
  buffer: Buffer;
  generatedUnits: number;
}): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    ...(args.request.billingMetrics || {}),
  };
  const metadata = readMp4VideoMetadata(args.buffer);

  if (typeof metadata.durationSeconds === "number" && Number.isFinite(metadata.durationSeconds) && metadata.durationSeconds > 0) {
    if (metrics.second === undefined) metrics.second = metadata.durationSeconds;
    if (metrics.duration === undefined) metrics.duration = metadata.durationSeconds;
    if (metrics.minute === undefined) metrics.minute = metadata.durationSeconds / 60;
  }

  if (
    typeof metadata.width === "number"
    && typeof metadata.height === "number"
    && Number.isFinite(metadata.width)
    && Number.isFinite(metadata.height)
    && metadata.width > 0
    && metadata.height > 0
  ) {
    const pixels = metadata.width * metadata.height * args.generatedUnits;
    metrics.width = metadata.width;
    metrics.height = metadata.height;
    if (metrics.pixel === undefined) metrics.pixel = pixels;
    if (metrics.megapixel === undefined) metrics.megapixel = pixels / 1_000_000;
    if (metrics.processed_pixel === undefined) metrics.processed_pixel = pixels;
    if (metrics.processed_megapixel === undefined) metrics.processed_megapixel = pixels / 1_000_000;
  }

  return metrics;
}

export function parseAsyncVideoJobId(jobId: string): { provider: string; providerJobId: string } {
  const separatorIndex = jobId.indexOf(":");
  const provider = separatorIndex >= 0 ? jobId.slice(0, separatorIndex) : "";
  const providerJobId = separatorIndex >= 0 ? jobId.slice(separatorIndex + 1) : "";

  if (!provider || !providerJobId) {
    throw new Error(`Invalid async job id: ${jobId}`);
  }

  return { provider, providerJobId };
}

// ===========================================================================
// Universal video-modality request shape
// ===========================================================================

export interface VideoRequest {
  /** Compose model id. */
  model: string;

  /** Operation hint. */
  operation?: "text-to-video" | "image-to-video" | "video-to-text" | "video-edit";

  prompt?: string;

  // -------------------------------------------------------------------------
  // Conditioning
  // -------------------------------------------------------------------------
  /** Source still for image-to-video. */
  image_url?: string;
  /** First-frame image (Hailuo / MiniMax / Vidu first_frame). */
  first_frame_image?: string;
  /** End-frame image (Vidu / Hailuo last-frame). */
  last_frame_image?: string;
  /** Subject reference (character consistency — Hailuo / Vidu / Veo). */
  subject_reference?: Array<{ image?: string[]; type?: "character" | "scene" }>;
  /** Reference video for video-to-video. */
  reference_video_url?: string;

  // -------------------------------------------------------------------------
  // Geometry / timing
  // -------------------------------------------------------------------------
  duration?: number;        // seconds
  fps?: number;
  size?: string;            // "1280x720" / "1920x1080"
  aspect_ratio?: string;    // "16:9" | "9:16" | "1:1" | "21:9"
  resolution?: "480P" | "540P" | "720P" | "768P" | "1080P" | "4K";
  width?: number;
  height?: number;

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------
  seed?: number;
  cfg_scale?: number;
  guidance?: number;
  steps?: number;
  negative_prompt?: string;

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  /** Include synchronized audio (Vidu / Veo). */
  audio?: boolean;
  /** Voice id when generating dubbed audio. */
  voice_id?: string;
  /** TTS-style audio prompt. */
  audio_prompt?: string;

  // -------------------------------------------------------------------------
  // Async / control
  // -------------------------------------------------------------------------
  /** Webhook URL for completion (BFL, MiniMax, Vidu). */
  callback_url?: string;
  /** Server-side prompt rewriter. */
  prompt_optimizer?: boolean;
  /** Faster optimizer pretreatment (Hailuo). */
  fast_pretreatment?: boolean;

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------
  output_format?: "mp4" | "webm" | "mov";
  watermark?: boolean;
  watermark_text?: string;

  // -------------------------------------------------------------------------
  // Native — family-specific extensions
  // -------------------------------------------------------------------------
  native?: VideoRequestNative;
  customParams?: Record<string, unknown>;
}

export interface VideoRequestNative {
  openai?: OpenAINativeVideo;
  google?: GoogleNativeVideo;
  alibaba?: AlibabaNativeVideo;
  minimax?: MinimaxNativeVideo;
  zai?: ZaiNativeVideo;
  bytedance?: BytedanceNativeVideo;
  bfl?: BflNativeVideo;
  stabilityai?: StabilityNativeVideo;
  lightricks?: LightricksNativeVideo;
  genmo?: GenmoNativeVideo;
  tencent?: TencentNativeVideo;
  meituan?: MeituanNativeVideo;
  kuaishou?: KuaishouNativeVideo;
}

// ---------------------------------------------------------------------------
// OpenAI Sora
// ---------------------------------------------------------------------------

export interface OpenAINativeVideo {
  /** OpenAI Sora video sizes. */
  size?: "480x854" | "854x480" | "720x1280" | "1280x720" | "1080x1920" | "1920x1080";
  /** Seconds — Sora accepts string seconds. */
  seconds?: "4" | "8" | "12";
  /** Reference image for video-to-video / image-input. */
  input_reference?: { image_url?: string; video_url?: string };
  /** Variants. */
  n?: number;
}

// ---------------------------------------------------------------------------
// Google Veo (veo-2, veo-3, veo-3.1)
// ---------------------------------------------------------------------------

export interface GoogleNativeVideo {
  durationSeconds?: 5 | 6 | 7 | 8;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  /** Negative prompt as a separate field on Veo. */
  negativePrompt?: string;
  /** People generation policy. */
  personGeneration?: "DONT_ALLOW" | "ALLOW_ADULT" | "ALLOW_ALL";
  /** Generate audio (Veo 3+). */
  generateAudio?: boolean;
  /** Sample count. */
  sampleCount?: 1 | 2 | 3 | 4;
  /** Seed. */
  seed?: number;
  /** Image-to-video reference. */
  image?: { imageBytes: string; mimeType: string };
  /** Last-frame conditioning (Veo 3.1). */
  lastFrame?: { imageBytes: string; mimeType: string };
  /** Reference images for character consistency. */
  referenceImages?: Array<{ imageBytes: string; mimeType: string; referenceType?: "asset" | "style" }>;
  /** Storage URI for generated video (Vertex). */
  storageUri?: string;
  /** Compression preference. */
  compressionQuality?: "lossless" | "optimized";
}

// ---------------------------------------------------------------------------
// Alibaba (wan-*, wanx-*)
// ---------------------------------------------------------------------------

export interface AlibabaNativeVideo {
  /** Wanx style flag. */
  template?: "general" | "anime" | "realistic" | "cinematic";
  /** Subject reference image (Wanx-Subject). */
  subject_image?: string;
  /** Watermark. */
  watermark?: boolean;
  /** Camera control vocabulary. */
  camera_control?: { type: "pan_left" | "pan_right" | "tilt_up" | "tilt_down" | "zoom_in" | "zoom_out" | "static"; intensity?: number };
  /** Prompt extension toggle. */
  prompt_extend?: boolean;
}

// ---------------------------------------------------------------------------
// MiniMax (Hailuo-2.3, Hailuo-02, T2V-01, I2V-01)
// ---------------------------------------------------------------------------

export interface MinimaxNativeVideo {
  /** Camera command syntax inside prompt: `[Truck left]`, `[Pan right]`,
   *  `[Push in]`, `[Pull out]`, `[Pedestal up]`, `[Pedestal down]`,
   *  `[Tilt up]`, `[Tilt down]`, `[Zoom in]`, `[Zoom out]`,
   *  `[Shake]`, `[Tracking shot]`, `[Static shot]`. */
  use_camera_commands?: boolean;
  /** Hailuo / T2V model variant. */
  model?: "MiniMax-Hailuo-2.3" | "MiniMax-Hailuo-2.3-Fast" | "MiniMax-Hailuo-02" | "T2V-01" | "T2V-01-Director" | "I2V-01" | "I2V-01-Director" | "I2V-01-live";
}

// ---------------------------------------------------------------------------
// Z.AI / Vidu (cogvideox-3, vidu-q1, vidu-2)
// ---------------------------------------------------------------------------

export interface ZaiNativeVideo {
  quality?: "speed" | "quality";
  size_ratio?: "9:16" | "16:9" | "1:1";
  with_audio?: boolean;
  /** Vidu start_image / end_image. */
  start_image_url?: string;
  end_image_url?: string;
  /** Vidu reference style ("anime" / "general"). */
  style?: "anime" | "general";
}

// ---------------------------------------------------------------------------
// ByteDance (seedance, doubao-seedream)
// ---------------------------------------------------------------------------

export interface BytedanceNativeVideo {
  /** Seedance variant. */
  variant?: "1.0-pro" | "1.0-lite";
  /** First and last frame conditioning (Seedance Pro). */
  first_image_url?: string;
  last_image_url?: string;
  /** Resolution preset. */
  ratio?: "16:9" | "9:16" | "1:1";
  watermark?: boolean;
}

// ---------------------------------------------------------------------------
// Black Forest Labs video (FLUX-video — beta)
// ---------------------------------------------------------------------------

export interface BflNativeVideo {
  webhook_url?: string;
  webhook_secret?: string;
  output_format?: "mp4" | "webm";
  /** Seconds (FLUX-video accepts 6 / 9 / 12). */
  duration?: 6 | 9 | 12;
}

// ---------------------------------------------------------------------------
// Stability (image-to-video / Stable-Video-Diffusion)
// ---------------------------------------------------------------------------

export interface StabilityNativeVideo {
  /** Motion intensity (1-255, default 127). */
  motion_bucket_id?: number;
  cfg_scale?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Lightricks (LTX-Video / LTX-2)
// ---------------------------------------------------------------------------

export interface LightricksNativeVideo {
  /** LTX scheduler. */
  scheduler?: "DDIM" | "DPM" | "Euler";
  /** Motion strength. */
  motion_strength?: number;
  /** Camera-jib LoRA control (LTX-2). */
  camera_lora?: "jib-up" | "jib-down" | "pan-left" | "pan-right" | "zoom-in" | "zoom-out";
  /** LoRA stack. */
  loras?: Array<{ path: string; scale: number }>;
}

// ---------------------------------------------------------------------------
// Genmo (Mochi-1)
// ---------------------------------------------------------------------------

export interface GenmoNativeVideo {
  num_frames?: number;
  cfg_scale?: number;
  /** Prompt rewriter strength. */
  prompt_rewrite?: boolean;
}

// ---------------------------------------------------------------------------
// Tencent Hunyuan video
// ---------------------------------------------------------------------------

export interface TencentNativeVideo {
  /** Hunyuan video model variant. */
  variant?: "hunyuan-video" | "hunyuan-video-fast";
  /** Watermark. */
  watermark?: boolean;
}

// ---------------------------------------------------------------------------
// Meituan LongCat
// ---------------------------------------------------------------------------

export interface MeituanNativeVideo {
  /** LongCat-Video specific. */
  rendering_mode?: "fast" | "balanced" | "high_quality";
}

// ---------------------------------------------------------------------------
// Kuaishou Kling AI
// ---------------------------------------------------------------------------

export interface KuaishouNativeVideo {
  /** Kling mode. */
  mode?: "std" | "pro";
  /** Camera control. */
  camera_control?: { type: "horizontal" | "vertical" | "zoom" | "tilt" | "pan" | "roll"; config?: { horizontal?: number; vertical?: number; zoom?: number; tilt?: number; pan?: number; roll?: number } };
  /** Static / dynamic frame. */
  static_mask?: string;
  dynamic_masks?: Array<{ mask: string; trajectories: Array<{ x: number; y: number }> }>;
}

// ===========================================================================
// Universal video response
// ===========================================================================

export interface GeneratedVideo {
  url?: string;
  base64?: string;
  buffer?: Buffer;
  mediaType: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  coverImageUrl?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface VideoResponse {
  videos: GeneratedVideo[];
  /** Async job id for polling (most video families are async). */
  jobId?: string;
  /** Internal status. */
  status?: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  /** File id for download (MiniMax, OpenAI Sora, Z.AI). */
  fileId?: string;
  usage?: Usage;
  raw: unknown;
}

// ===========================================================================
// Universal video streaming events (status-poll SSE)
// ===========================================================================

export type VideoStreamEvent =
  | { type: "status"; status: "queued" | "processing" | "completed" | "failed"; progress?: number }
  | { type: "video-complete"; video: GeneratedVideo }
  | { type: "warning"; warning: { code: string; message: string } }
  | { type: "error"; error: { code: string; message: string; details?: Record<string, unknown> } }
  | { type: "done"; usage?: Usage };
