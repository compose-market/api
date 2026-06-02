import { performance } from "node:perf_hooks";
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

export function classifyImageModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  // Cloudflare's image-generation cards declare `output: ["binary_stream"]`
  // rather than `output: ["image"]`. Treat any binary-stream output as
  // image when the source type is image-generation; otherwise the
  // classifier yields no capability and the model is unroutable.
  const outputsImage = hasOutput(source, "image") || hasOutput(source, "binary-stream");

  if (hasSourceType(source, ["text-to-image"])) {
    capabilities.push(buildCapability(model, source, "image", "text-to-image", true, {
      input: ["text"],
      output: outputsImage ? ["image"] : source.output,
    }));
  }

  if (hasSourceType(source, ["image-to-image", "image-edit", "inpainting", "outpainting"])) {
    capabilities.push(buildCapability(model, source, "image", "image-to-image", true, {
      input: hasInput(source, "text") ? ["image", "text"] : ["image"],
      output: outputsImage ? ["image"] : source.output,
    }));
  }

  if (hasSourceType(source, ["image-to-text", "image-text-to-text"])) {
    capabilities.push(buildCapability(model, source, "image", "image-to-text", true, {
      input: hasInput(source, "text") ? ["image", "text"] : ["image"],
      output: ["text"],
    }));
  }

  if (hasSourceType(source, ["image-classification", "image-segmentation", "object-detection", "depth-estimation"])) {
    capabilities.push(buildCapability(model, source, "image", "classify", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (hasSourceType(source, ["image-generation", "unconditional-image-generation"]) && outputsImage) {
    if (hasInput(source, "text")) {
      capabilities.push(buildCapability(model, source, "image", "text-to-image", true, {
        input: ["text"],
        output: ["image"],
      }));
    }
    if (hasInput(source, "image")) {
      capabilities.push(buildCapability(model, source, "image", "image-to-image", true, {
        input: hasInput(source, "text") ? ["image", "text"] : ["image"],
        output: ["image"],
      }));
    }
  }

  return uniqueCapabilities(capabilities);
}

export function selectImageTaskForInput(imageUrl?: string | null): "text-to-image" | "image-to-image" {
  return typeof imageUrl === "string" && imageUrl.length > 0 ? "image-to-image" : "text-to-image";
}

export function getImageParameterCatalog(): Record<string, Record<string, unknown>> {
  return {
    n: {
      type: "integer",
      required: false,
      default: 1,
      options: [1, 2, 3, 4, 6, 8],
      description: "Number of images to generate.",
    },
    size: {
      type: "string",
      required: false,
      options: ["512x512", "768x768", "1024x1024", "1024x1792", "1792x1024", "2048x2048"],
      description: "Generated image size.",
    },
    aspect_ratio: {
      type: "string",
      required: false,
      options: ["1:1", "4:5", "5:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21"],
      description: "Generated image aspect ratio.",
    },
    resolution: {
      type: "string",
      required: false,
      options: ["720P", "1080P", "4K"],
      description: "Generated image resolution.",
    },
    quality: {
      type: "string",
      required: false,
      options: ["low", "standard", "medium", "high", "hd", "max"],
      description: "Generated image quality.",
    },
    output_format: {
      type: "string",
      required: false,
      options: ["jpeg", "jpg", "webp", "png", "gif"],
      description: "Generated image output format.",
    },
  };
}

function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: buffer.readUIntLE(24, 3) + 1,
        height: buffer.readUIntLE(27, 3) + 1,
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const blockLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += blockLength + 2;
    }
  }
  return null;
}

export function generatedImageCount(request: Pick<Request, "imageOptions">): number {
  return typeof request.imageOptions?.n === "number" && request.imageOptions.n > 0
    ? request.imageOptions.n : 1;
}

export function elapsedSecondsSince(startedAt: number): number {
  const elapsed = (performance.now() - startedAt) / 1000;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0.000001;
}

export function imageBillingMetricsFromOutput(args: {
  request: Request;
  buffer: Buffer;
  usage?: Usage;
  generatedUnits: number;
  elapsedSeconds?: number;
}): Record<string, unknown> {
  const metrics: Record<string, unknown> = { ...(args.request.billingMetrics || {}) };
  if (typeof args.elapsedSeconds === "number" && Number.isFinite(args.elapsedSeconds) && args.elapsedSeconds > 0) {
    if (metrics.second === undefined) metrics.second = args.elapsedSeconds;
    if (metrics.duration === undefined) metrics.duration = args.elapsedSeconds;
    if (metrics.compute_second === undefined) metrics.compute_second = args.elapsedSeconds;
  }
  Object.assign(metrics, args.usage?.billingMetrics || {});
  const dim = readImageDimensions(args.buffer);
  if (dim) {
    const mp = (dim.width * dim.height * args.generatedUnits) / 1_000_000;
    const px = dim.width * dim.height * args.generatedUnits;
    metrics.megapixel = mp;
    if (metrics.processed_megapixel === undefined) metrics.processed_megapixel = mp;
    if (metrics.pixel === undefined) metrics.pixel = px;
    if (metrics.processed_pixel === undefined) metrics.processed_pixel = px;
  }
  return metrics;
}

export function supportsOpenAINativeImageStreaming(card: ModelCard | null): boolean {
  if (!card?.type) return false;
  const types = Array.isArray(card.type) ? card.type : [card.type];
  return types.some((type) => typeof type === "string" && type.toLowerCase() === "responses");
}

// ===========================================================================
// Universal image-modality types
// ===========================================================================

/** Image input — base64, URL, or file id (provider-uploaded). */
export type ImageInput =
  | { type: "url"; url: string }
  | { type: "base64"; data: string; mediaType?: string }
  | { type: "file_id"; fileId: string };

/**
 * Edit modes — disambiguates which sub-API the family bridge dispatches
 * to. When omitted, the bridge picks based on inputs (mask -> inpaint;
 * `expand` -> outpaint; multiple images -> reference; single image ->
 * edit).
 */
export type ImageEditMode =
  | "edit"             // text + image -> image (default)
  | "fill"             // mask-driven inpaint
  | "outpaint"         // expand canvas
  | "redux"            // re-render reference (BFL Redux)
  | "depth"            // depth-conditioned (BFL / SD3.5)
  | "canny"            // canny-edge-conditioned (BFL / SD3.5)
  | "object-replace"   // semantic replace (Stability search-and-replace)
  | "object-remove"    // erase (Stability erase / FLUX Fill)
  | "background-replace" // Stability replace-background-and-relight
  | "background-remove"  // Stability remove-background
  | "upscale-conservative"
  | "upscale-creative"
  | "upscale-fast"
  | "style-transfer"   // Stability style transfer / control/style
  | "structure-preserve"
  | "sketch-to-image";

// ---------------------------------------------------------------------------
// Universal image request
// ---------------------------------------------------------------------------

export interface ImageRequest {
  /** Compose model id. */
  model: string;

  /** Operation hint. Resolver picks the right family endpoint. */
  operation?: "text-to-image" | "image-to-image" | ImageEditMode;

  prompt: string;

  /** Reference / source / subject images. */
  images?: ImageInput[];

  /** Inpainting mask (white = edit, black = preserve). */
  mask?: ImageInput;

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------
  /** Number of images to generate. */
  n?: number;
  /** "1024x1024" etc. */
  size?: string;
  width?: number;
  height?: number;
  /** "16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21". */
  aspect_ratio?: string;
  /** Compose-canonical resolution string ("720P", "1080P", "4K"). */
  resolution?: string;

  // -------------------------------------------------------------------------
  // Quality / fidelity / sampling
  // -------------------------------------------------------------------------
  quality?: "low" | "medium" | "high" | "auto" | "standard" | "hd" | "max";
  /** Output format. */
  output_format?: "png" | "jpeg" | "jpg" | "webp" | "gif";
  /** Output compression quality (0-100). */
  output_compression?: number;
  /** Random seed. */
  seed?: number;
  /** Number of diffusion steps. */
  steps?: number;
  /** Classifier-free guidance scale. */
  guidance?: number;
  cfg_scale?: number;
  /** image-to-image strength / denoise (0-1). */
  strength?: number;
  /** Negative prompt. */
  negative_prompt?: string;
  /** Style preset (Stability / OpenAI). */
  style?: string;
  style_preset?: string;
  /** Server-side prompt-rewriter toggle. */
  prompt_optimizer?: boolean;
  prompt_upsampling?: boolean;
  /** Render in raw mode (BFL FLUX Ultra). */
  raw?: boolean;
  /** Safety threshold. */
  safety_tolerance?: number;
  /** Outpaint expansion in pixels. */
  expand?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Control / fidelity (0-1). */
  control_strength?: number;
  fidelity?: number;
  creativity?: number;
  /** Inpaint mask grow (-100..100). */
  grow_mask?: number;

  // -------------------------------------------------------------------------
  // Streaming (OpenAI gpt-image-1 partial-image SSE; Gemini stream-image)
  // -------------------------------------------------------------------------
  stream?: boolean;
  partial_images?: number;     // OpenAI partials count

  // -------------------------------------------------------------------------
  // User / response
  // -------------------------------------------------------------------------
  user?: string;
  response_format?: "url" | "b64_json";

  // -------------------------------------------------------------------------
  // Native — family-specific extensions
  // -------------------------------------------------------------------------
  native?: ImageRequestNative;
  customParams?: Record<string, unknown>;
}

export interface ImageRequestNative {
  openai?: OpenAINativeImage;
  google?: GoogleNativeImage;
  bfl?: BflNativeImage;
  stabilityai?: StabilityNativeImage;
  alibaba?: AlibabaNativeImage;
  zai?: ZaiNativeImage;
  bytedance?: BytedanceNativeImage;
  ideogram?: IdeogramNativeImage;
  recraft?: RecraftNativeImage;
  kuaishou?: KuaishouNativeImage;
  hidream?: HidreamNativeImage;
  minimax?: MinimaxNativeImage;
  microsoft?: MicrosoftNativeImage;
  cloudflare?: CloudflareNativeImage;
  fireworks?: FireworksNativeImage;
  azure?: AzureNativeImage;
}

// ---------------------------------------------------------------------------
// OpenAI (dall-e-2, dall-e-3, gpt-image-*, gpt-image-1)
// ---------------------------------------------------------------------------

export interface OpenAINativeImage {
  /** Background — gpt-image-1 only. */
  background?: "transparent" | "opaque" | "auto";
  /** Moderation strictness — gpt-image-1. */
  moderation?: "low" | "auto";
  /** Output channel name (Responses API streaming). */
  modalities?: Array<"image">;
  /** Edit input fidelity. */
  input_fidelity?: "high" | "low";
  /** Stream partial-image count. */
  partial_images?: number;
}

// ---------------------------------------------------------------------------
// Google (imagen-*, gemini image-out, nano-banana)
// ---------------------------------------------------------------------------

export interface GoogleNativeImage {
  /** Imagen-only: prompt language. */
  language?: "auto" | "en" | "ja" | "ko" | "hi" | "es" | "pt-BR" | "fr" | "de" | "it" | "ru" | "zh-CN";
  /** People-generation policy. */
  person_generation?: "DONT_ALLOW" | "ALLOW_ADULT" | "ALLOW_ALL";
  /** Safety filter level. */
  safety_filter_level?: "BLOCK_LOW_AND_ABOVE" | "BLOCK_MEDIUM_AND_ABOVE" | "BLOCK_ONLY_HIGH";
  /** Add SynthID watermark (Imagen). */
  add_watermark?: boolean;
  /** Imagen sample image style. */
  sample_image_style?: "photo" | "art" | "watercolor" | "3d" | "sketch";
  /** Aspect-ratio enum (Vertex Imagen). */
  imagen_aspect_ratio?: "1:1" | "9:16" | "16:9" | "4:3" | "3:4";
  /** Edit-mode (Vertex Imagen). */
  edit_mode?: "inpainting-insert" | "inpainting-remove" | "outpainting" | "product-image" | "background-swap";
  /** Mask mode. */
  mask_mode?: "MASK_MODE_USER_PROVIDED" | "MASK_MODE_BACKGROUND" | "MASK_MODE_FOREGROUND" | "MASK_MODE_SEMANTIC";
  /** Reference image config (Imagen 3 customization). */
  reference_images?: Array<{
    referenceType: "REFERENCE_TYPE_RAW" | "REFERENCE_TYPE_MASK" | "REFERENCE_TYPE_CONTROL" | "REFERENCE_TYPE_STYLE" | "REFERENCE_TYPE_SUBJECT";
    referenceId: number;
    referenceImage?: { gcsUri?: string; bytesBase64Encoded?: string };
    subjectImageConfig?: { subjectDescription: string; subjectType: "SUBJECT_TYPE_PERSON" | "SUBJECT_TYPE_ANIMAL" | "SUBJECT_TYPE_PRODUCT" | "SUBJECT_TYPE_DEFAULT" };
    styleImageConfig?: { styleDescription: string };
    controlImageConfig?: { controlType: "CONTROL_TYPE_CANNY" | "CONTROL_TYPE_SCRIBBLE"; enableControlImageComputation?: boolean };
    maskImageConfig?: { maskMode: string; segmentationClasses?: number[]; maskDilation?: number };
  }>;
  /** Gemini image-out: include thoughts. */
  includeThoughts?: boolean;
  /** Gemini: output MIME. */
  outputMimeType?: "image/png" | "image/jpeg" | "image/webp";
}

// ---------------------------------------------------------------------------
// Black Forest Labs (flux-*, kontext-*)
// ---------------------------------------------------------------------------

export interface BflNativeImage {
  /** Webhook URL for async completion. */
  webhook_url?: string;
  webhook_secret?: string;
  /** FLUX Ultra raw mode. */
  raw?: boolean;
  /** FLUX.1 Redux strength. */
  image_prompt_strength?: number;
  /** Multi-reference (FLUX.2 up to 10). */
  image_prompts?: string[];
  /** FLUX Fill mask. */
  image_prompt?: string;
  /** Outpaint sides (pixels). */
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  /** Sampling steps (default 28-50 by model). */
  steps?: number;
  /** Output format. */
  output_format?: "png" | "jpeg" | "webp";
  /** Polling URL preference (vendor honors `polling_url` returned by submit). */
  prefer_polling_url?: boolean;
  /** Per-image LoRA stack (FLUX-dev-LoRA). */
  loras?: Array<{ path: string; scale: number; trigger?: string }>;
  /** FLUX.2 Klein finetune slot. */
  finetune_id?: string;
  finetune_strength?: number;
}

// ---------------------------------------------------------------------------
// Stability AI (stable-diffusion, sdxl, sd3, sd3.5, stable-cascade,
//                stable-image-core/ultra, stable-fast-3d)
// ---------------------------------------------------------------------------

export interface StabilityNativeImage {
  /** SD3.5 model variant. */
  model?: "sd3.5-large" | "sd3.5-large-turbo" | "sd3.5-medium" | "sd3-large" | "sd3-large-turbo" | "sd3-medium";
  /** SD3 mode — text-to-image vs image-to-image. */
  mode?: "text-to-image" | "image-to-image";
  /** Stability style preset (17 values). */
  style_preset?: "3d-model" | "analog-film" | "anime" | "cinematic" | "comic-book" | "digital-art"
    | "enhance" | "fantasy-art" | "isometric" | "line-art" | "low-poly" | "modeling-compound"
    | "neon-punk" | "origami" | "photographic" | "pixel-art" | "tile-texture";
  /** Aspect-ratio enum. */
  aspect_ratio?: "16:9" | "1:1" | "21:9" | "2:3" | "3:2" | "4:5" | "5:4" | "9:16" | "9:21";
  /** Replace-background-and-relight extras. */
  background_prompt?: string;
  foreground_prompt?: string;
  light_source_direction?: "above" | "below" | "left" | "right";
  light_source_strength?: number;
  /** Search endpoints — what to find. */
  select_prompt?: string;
  /** Sampler. */
  sampler?: string;
  /** SD3-specific. */
  init_image_mode?: "IMAGE_STRENGTH" | "STEP_SCHEDULE";
  image_strength?: number;
  step_schedule_start?: number;
  step_schedule_end?: number;
  /** Stable-fast-3d / point-aware-3d. */
  texture_resolution?: 1024 | 2048;
  foreground_ratio?: number;
  remesh?: "none" | "quad" | "triangle";
}

// ---------------------------------------------------------------------------
// Alibaba (wan-*, qwen-image-*, wanx-*)
// ---------------------------------------------------------------------------

export interface AlibabaNativeImage {
  /** Wanx style (e.g. "<auto>", "<photography>", "<oil painting>"). */
  style?: string;
  /** DashScope ref-image mode (subject / character / scene). */
  ref_mode?: "repaint" | "refonly";
  /** Image strength when using ref. */
  ref_strength?: number;
  /** Watermark toggle. */
  watermark?: boolean;
  /** Wanx async endpoint flag. */
  async_mode?: boolean;
  /** DashScope qwen-image LoRA binding. */
  lora_name?: string;
  /** DashScope per-step preview frequency. */
  preview_steps?: number;
}

// ---------------------------------------------------------------------------
// Z.AI (cogview-*, glm-image, z-image-turbo)
// ---------------------------------------------------------------------------

export interface ZaiNativeImage {
  /** CogView-4 quality. */
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  /** Async submit (recommended for cogview-3-plus). */
  async_mode?: boolean;
  /** GLM-Image: incremental return. */
  user_id?: string;
  /** Watermark toggle. */
  watermark?: boolean;
}

// ---------------------------------------------------------------------------
// ByteDance (seedream-*, doubao-image-*)
// ---------------------------------------------------------------------------

export interface BytedanceNativeImage {
  /** Seedream image LoRA. */
  lora_id?: string;
  lora_strength?: number;
  /** Watermark. */
  watermark?: boolean;
  /** Doubao-only inference profile. */
  profile?: "general" | "photography" | "illustration";
}

// ---------------------------------------------------------------------------
// Ideogram (ideogram-v3, ideogram-2, ideogram-1)
// ---------------------------------------------------------------------------

export interface IdeogramNativeImage {
  /** Magic Prompt. */
  magic_prompt_option?: "AUTO" | "ON" | "OFF";
  /** Color palette presets. */
  color_palette?: { name?: "EMBER" | "FRESH" | "JUNGLE" | "MAGIC" | "MELON" | "MOSAIC" | "PASTEL" | "ULTRAMARINE"; members?: Array<{ color_hex: string; color_weight?: number }> };
  /** Style type. */
  style_type?: "AUTO" | "GENERAL" | "REALISTIC" | "DESIGN" | "RENDER_3D" | "ANIME";
  /** Resolution preset. */
  resolution?: string;
  /** Negative prompt. */
  negative_prompt?: string;
}

// ---------------------------------------------------------------------------
// Recraft (recraft-v3, recraft-20b)
// ---------------------------------------------------------------------------

export interface RecraftNativeImage {
  style?: "any" | "realistic_image" | "digital_illustration" | "vector_illustration" | "icon";
  substyle?: string;        // e.g. "b_and_w", "pastel", "linocut", etc.
  /** Recraft generative-upscale / vectorize / replace-background. */
  controls?: { colors?: Array<{ rgb: [number, number, number] }>; background_color?: { rgb: [number, number, number] }; artistic_level?: number; no_text?: boolean };
  /** Random seed. */
  random_seed?: number;
  /** Brand id. */
  brand_id?: string;
}

// ---------------------------------------------------------------------------
// Kuaishou (kolors-*)
// ---------------------------------------------------------------------------

export interface KuaishouNativeImage {
  human_fix?: boolean;
  text_to_image_strategy?: "auto" | "balanced" | "creative";
  ip_adapter_image?: string;
  ip_adapter_scale?: number;
  controlnet_type?: "canny" | "depth" | "pose";
  controlnet_image?: string;
  controlnet_scale?: number;
}

// ---------------------------------------------------------------------------
// HiDream (hidream-i1-*, hidream-e1-*)
// ---------------------------------------------------------------------------

export interface HidreamNativeImage {
  variant?: "Full" | "Dev" | "Fast";
  /** HiDream-E1 reference. */
  reference_image?: string;
  reference_strength?: number;
  /** HiDream loras. */
  lora_paths?: string[];
}

// ---------------------------------------------------------------------------
// MiniMax (image-01, abab-image-*)
// ---------------------------------------------------------------------------

export interface MinimaxNativeImage {
  /** Subject reference (character consistency). */
  subject_reference?: Array<{ type: "character"; image_file?: string }>;
  /** Server-side prompt optimizer. */
  prompt_optimizer?: boolean;
  /** Background color. */
  background_color?: string;
  /** Output format selector. */
  output_format?: "url" | "base64";
}

// ---------------------------------------------------------------------------
// Microsoft Azure OpenAI / MAI / FLUX-on-Azure / Cohere-rerank
// ---------------------------------------------------------------------------

export interface MicrosoftNativeImage {
  /** MAI Image extras. */
  mai_seed?: number;
  /** Content-filter severity (Azure). */
  content_filter_severity?: "safe" | "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI image
// ---------------------------------------------------------------------------

export interface CloudflareNativeImage {
  num_steps?: number;
  guidance?: number;
  strength?: number;
  /** Cloudflare passes provider-specific knobs through `parameters`. */
  parameters?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fireworks (FLUX, Playground v2, SDXL fine-tunes)
// ---------------------------------------------------------------------------

export interface FireworksNativeImage {
  scheduler?: "DDIM" | "Euler" | "EulerAncestral" | "DPM" | "DPMPP_2M" | "DPMPP_2S_A" | "LMS";
  cfg_scale?: number;
  steps?: number;
  /** Fireworks LoRA binding. */
  lora_path?: string;
  lora_strength?: number;
  /** Image-to-image strength. */
  image_strength?: number;
  /** Mid-pipeline flag. */
  return_intermediate_images?: boolean;
}

// ---------------------------------------------------------------------------
// Azure FLUX / MAI Image (extra params on Azure-hosted)
// ---------------------------------------------------------------------------

export interface AzureNativeImage {
  /** BFL on Azure. */
  output_format?: "png" | "jpeg" | "webp";
  /** MAI Image. */
  width?: number;
  height?: number;
  /** Force a specific Azure deployment. */
  deployment?: string;
}

// ===========================================================================
// Universal image response
// ===========================================================================

export interface GeneratedImage {
  buffer?: Buffer;
  base64?: string;
  url?: string;
  mediaType: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
  /** Provider-specific metadata. */
  providerMetadata?: Record<string, unknown>;
}

export interface ImageResponse {
  images: GeneratedImage[];
  /** When the family ran an async LRO (BFL, Stability creative-upscale,
   *  Vertex Veo, Alibaba Wanx, MiniMax, Z.AI cogview-async). */
  jobId?: string;
  status?: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  /** Token usage (gpt-image-1 reports input/output tokens). */
  usage?: Usage;
  raw: unknown;
}

// ===========================================================================
// Universal image streaming events
// ===========================================================================

export type ImageStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "image-partial"; image: { base64: string; index: number; mediaType: string } }
  | { type: "image-complete"; image: GeneratedImage }
  | { type: "warning"; warning: { code: string; message: string } }
  | { type: "error"; error: { code: string; message: string; details?: Record<string, unknown> } }
  | { type: "done"; usage?: Usage };

// ===========================================================================
// Legacy image-edit types (preserved — used by adapter; superseded by
// the universal ImageRequest above with `operation: "edit" | "fill" | ...`)
// ===========================================================================

/** @deprecated Use `ImageRequest` with `operation` set. */
export interface ImageEditRequest {
  prompt: string;
  images: ImageInput[];
  mask?: ImageInput;
  mode?: ImageEditMode;
  n?: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  outputFormat?: string;
  expand?: { top?: number; bottom?: number; left?: number; right?: number };
  seed?: number;
  steps?: number;
  guidance?: number;
  customParams?: Record<string, unknown>;
}

/** @deprecated Use `GeneratedImage`. */
export interface EditedImage {
  buffer: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

/** @deprecated Use `ImageResponse`. */
export interface ImageEditResult {
  images: EditedImage[];
  usage?: Usage;
  raw: unknown;
}
