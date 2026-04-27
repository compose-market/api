import type { ModelCard } from "../types.js";
import type { UnifiedRequest, UnifiedUsage } from "../core.js";
import {
  buildCapability,
  hasInput,
  hasSourceType,
  uniqueCapabilities,
} from "./source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

export function classifyEmbeddingModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  if (!hasSourceType(source, ["embeddings", "text-embeddings", "text-to-embedding", "feature-extraction"])) {
    return capabilities;
  }

  if (hasInput(source, "image") && hasInput(source, "text")) {
    capabilities.push(buildCapability(model, source, "embedding", "multimodal-embedding", false));
  } else if (hasInput(source, "image")) {
    capabilities.push(buildCapability(model, source, "embedding", "image-to-embedding", false));
  } else if (hasInput(source, "audio")) {
    capabilities.push(buildCapability(model, source, "embedding", "audio-to-embedding", false));
  } else {
    capabilities.push(buildCapability(model, source, "embedding", "text-to-embedding", false));
  }

  return uniqueCapabilities(capabilities);
}

function readEmbeddingTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function embeddingInputValues(request: Pick<UnifiedRequest, "embeddingInput">): string[] {
  return Array.isArray(request.embeddingInput)
    ? request.embeddingInput
    : [request.embeddingInput || ""];
}

export function embeddingUsageFromTokenCount(tokens: unknown): UnifiedUsage {
  const promptTokens = readEmbeddingTokenCount(tokens) ?? 0;
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
  };
}

function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function normalizeFeatureExtractionEmbeddings(output: unknown): number[][] {
  if (isNumberVector(output)) {
    return [output];
  }

  if (Array.isArray(output) && output.every(isNumberVector)) {
    return output;
  }

  throw new Error("Unsupported embedding shape returned by feature-extraction provider");
}
