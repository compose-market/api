import type { ModelCard } from "../../types.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

function text(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => text(entry, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => text(entry, depth + 1));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim().toLowerCase();
    return normalized ? [normalized] : [];
  }
  return [];
}

function hasEvidence(model: ModelCard, pattern: RegExp): boolean {
  const evidence = text(model.params).concat(text(model.sourceMetadata));
  return evidence.some((entry) => pattern.test(entry));
}

function hasDepthEvidence(model: ModelCard): boolean {
  // Require actual depth-estimation semantics: bare "depth" also appears
  // in unrelated param prose (e.g. "maximum depth of the model's internal
  // reasoning process"), which must never classify a chat model as a
  // depth-estimation vision task.
  return hasEvidence(model, /\bdepth[-_\s]*(?:estimation|estimator|anything|map)\b/i);
}

function hasCompareEvidence(model: ModelCard): boolean {
  return model.provider === "roboflow" && hasEvidence(model, /\b(?:compare|similarity|perception[-_\s]+encoder)\b/);
}

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

  if (
    hasSourceType(source, ["depth-estimation"])
    || (hasInput(source, "image") && hasDepthEvidence(model))
  ) {
    capabilities.push(buildCapability(model, source, "image", "depth-estimation", false, {
      input: ["image"],
      output: source.output,
    }));
  }

  if (
    (hasSourceType(source, ["zero-shot-classification", "zero-shot-image-classification"]) && hasInput(source, "image"))
    || (hasInput(source, "image") && hasInput(source, "text") && hasCompareEvidence(model))
  ) {
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
