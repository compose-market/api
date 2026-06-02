import type { ModelCard } from "../../types.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

/**
 * Rich computer-vision tasks that are more specific than generic
 * image-generation / image-understanding.
 *
 * We keep the canonical top-level modality as `image` or `text` so the
 * public modality registry remains stable, but expose exact operations
 * such as object detection, segmentation, OCR, and gaze detection.
 */
export function classifyVisionModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  if (hasSourceType(source, ["object-detection"])) {
    capabilities.push(buildCapability(model, source, "image", "object-detection", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (hasSourceType(source, [
    "image-segmentation",
    "instance-segmentation",
    "semantic-segmentation",
    "unsupervised-segmentation",
  ])) {
    capabilities.push(buildCapability(model, source, "image", "image-segmentation", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (hasSourceType(source, ["keypoints-detection", "keypoint-detection", "pose-detection"])) {
    capabilities.push(buildCapability(model, source, "image", "keypoint-detection", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (
    hasSourceType(source, ["image-classification"])
    || (hasSourceType(source, ["classification"]) && hasInput(source, "image"))
  ) {
    capabilities.push(buildCapability(model, source, "image", "image-classification", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (hasSourceType(source, ["ocr"])) {
    capabilities.push(buildCapability(model, source, "text", "ocr", false, {
      input: ["image"],
      output: ["text"],
    }));
  }

  if (hasSourceType(source, ["gaze-detection"])) {
    capabilities.push(buildCapability(model, source, "image", "gaze-detection", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (hasSourceType(source, ["zero-shot-classification"]) && hasInput(source, "image")) {
    capabilities.push(buildCapability(model, source, "image", "zero-shot-classification", false, {
      input: ["image", "text"],
      output: source.output,
    }));
  }

  if (
    hasSourceType(source, ["image-text-to-text", "vision-language"])
    || (hasInput(source, "image") && hasOutput(source, "text") && hasSourceType(source, ["text-generation"]))
  ) {
    capabilities.push(buildCapability(model, source, "text", "vision-chat", true, {
      input: ["image", "text"],
      output: ["text"],
    }));
  }

  return uniqueCapabilities(capabilities);
}

export type VisionInput =
  | { type: "url"; url: string }
  | { type: "base64"; data: string; mediaType?: string };

export interface VisionDetectionRequest {
  model: string;
  image: VisionInput;
  confidence?: number;
  overlap?: number;
  classes?: string[];
  customParams?: Record<string, unknown>;
}

export interface VisionSegmentationRequest {
  model: string;
  image: VisionInput;
  prompt?: string;
  prompts?: Array<Record<string, unknown>>;
  format?: "polygon" | "rle" | "binary";
  customParams?: Record<string, unknown>;
}

export interface VisionOcrRequest {
  model: string;
  image: VisionInput;
  language_codes?: string[];
  generate_bounding_boxes?: boolean;
  customParams?: Record<string, unknown>;
}

export interface VisionLanguageRequest {
  model: string;
  image: VisionInput;
  prompt: string;
  max_new_tokens?: number;
  enable_thinking?: boolean;
  customParams?: Record<string, unknown>;
}

export interface VisionPrediction {
  label?: string;
  score?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  mask?: unknown;
  keypoints?: unknown;
  raw?: unknown;
}

export interface VisionResult {
  text?: string;
  predictions?: VisionPrediction[];
  embeddings?: number[][];
  raw: unknown;
}
