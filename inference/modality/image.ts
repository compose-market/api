import { performance } from "node:perf_hooks";
import type { ModelCard } from "../types.js";
import type { UnifiedRequest, UnifiedUsage } from "../core.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "./source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

export function classifyImageModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  if (hasSourceType(source, ["text-to-image"])) {
    capabilities.push(buildCapability(model, source, "image", "text-to-image", true));
  }

  if (hasSourceType(source, ["image-to-image"])) {
    capabilities.push(buildCapability(model, source, "image", "image-to-image", true));
  }

  if (hasSourceType(source, ["image-to-text", "image-text-to-text", "image-classification", "image-segmentation", "object-detection", "depth-estimation"])) {
    capabilities.push(buildCapability(model, source, "image", "image-to-text", true));
  }

  if (hasSourceType(source, ["image-generation", "unconditional-image-generation"]) && hasOutput(source, "image")) {
    if (hasInput(source, "text")) {
      capabilities.push(buildCapability(model, source, "image", "text-to-image", true));
    }
    if (hasInput(source, "image")) {
      capabilities.push(buildCapability(model, source, "image", "image-to-image", true));
    }
  }

  return uniqueCapabilities(capabilities);
}

export function selectImageTaskForInput(imageUrl?: string | null): "text-to-image" | "image-to-image" {
  return typeof imageUrl === "string" && imageUrl.length > 0 ? "image-to-image" : "text-to-image";
}

function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const blockLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += blockLength + 2;
    }
  }

  return null;
}

export function generatedImageCount(request: Pick<UnifiedRequest, "imageOptions">): number {
  return typeof request.imageOptions?.n === "number" && request.imageOptions.n > 0
    ? request.imageOptions.n
    : 1;
}

export function elapsedSecondsSince(startedAt: number): number {
  const elapsed = (performance.now() - startedAt) / 1000;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0.000001;
}

export function imageBillingMetricsFromOutput(args: {
  request: UnifiedRequest;
  buffer: Buffer;
  usage?: UnifiedUsage;
  generatedUnits: number;
  elapsedSeconds?: number;
}): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    ...(args.request.billingMetrics || {}),
  };

  if (typeof args.elapsedSeconds === "number" && Number.isFinite(args.elapsedSeconds) && args.elapsedSeconds > 0) {
    if (metrics.second === undefined) metrics.second = args.elapsedSeconds;
    if (metrics.duration === undefined) metrics.duration = args.elapsedSeconds;
    if (metrics.compute_second === undefined) metrics.compute_second = args.elapsedSeconds;
  }

  Object.assign(metrics, args.usage?.billingMetrics || {});

  const imageDimensions = readImageDimensions(args.buffer);
  if (imageDimensions) {
    const outputMegapixels = (imageDimensions.width * imageDimensions.height * args.generatedUnits) / 1_000_000;
    const outputPixels = imageDimensions.width * imageDimensions.height * args.generatedUnits;
    metrics.megapixel = outputMegapixels;
    if (metrics.processed_megapixel === undefined) metrics.processed_megapixel = outputMegapixels;
    if (metrics.pixel === undefined) metrics.pixel = outputPixels;
    if (metrics.processed_pixel === undefined) metrics.processed_pixel = outputPixels;
  }

  return metrics;
}

export function supportsOpenAINativeImageStreaming(card: ModelCard | null): boolean {
  if (!card?.type) {
    return false;
  }

  const types = Array.isArray(card.type) ? card.type : [card.type];
  return types.some((type) => typeof type === "string" && type.toLowerCase() === "responses");
}
