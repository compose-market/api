import type { ModelCard } from "../types.js";
import type { UnifiedRequest } from "../core.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "./source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

export function classifyVideoModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  if (hasSourceType(source, ["text-to-video"])) {
    capabilities.push(buildCapability(model, source, "video", "text-to-video", false));
  }

  if (hasSourceType(source, ["image-to-video"])) {
    capabilities.push(buildCapability(model, source, "video", "image-to-video", false));
  }

  if (hasSourceType(source, ["video-to-text", "video-classification"])) {
    capabilities.push(buildCapability(model, source, "video", "video-to-text", false));
  }

  if (hasSourceType(source, ["videos"]) && hasOutput(source, "video")) {
    if (hasInput(source, "text")) {
      capabilities.push(buildCapability(model, source, "video", "text-to-video", false));
    }
    if (hasInput(source, "image")) {
      capabilities.push(buildCapability(model, source, "video", "image-to-video", false));
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
  customParams?: Record<string, unknown>;
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
    ...(options?.imageUrl ? { input_reference: { image_url: options.imageUrl } } : {}),
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
  request: UnifiedRequest;
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
