import type { ModelCard } from "../types.js";
import { extractPricingUnits } from "./pricing.js";
import type {
  CanonicalModality,
  CanonicalOperation,
  ModelOperationCapability,
  ModelSourceShape,
} from "./types.js";

export function normalizeSourceValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s/]+/g, "-")
    .replace(/--+/g, "-");
}

function sourceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => sourceStringList(entry));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [normalizeSourceValue(value)];
  }

  return [];
}

export function getModelSourceShape(model: ModelCard): ModelSourceShape {
  return {
    sourceTypes: sourceStringList(model.type),
    input: sourceStringList(model.input),
    output: sourceStringList(model.output),
  };
}

export function hasSourceType(source: ModelSourceShape, values: readonly string[]): boolean {
  return values.some((value) => source.sourceTypes.includes(value));
}

export function hasInput(source: ModelSourceShape, value: string): boolean {
  return source.input.includes(value);
}

export function hasOutput(source: ModelSourceShape, value: string): boolean {
  return source.output.includes(value);
}

export function buildCapability(
  model: ModelCard,
  source: ModelSourceShape,
  modality: CanonicalModality,
  operation: CanonicalOperation,
  streamable: boolean,
): ModelOperationCapability {
  return {
    modality,
    operation,
    sourceTypes: [...source.sourceTypes],
    input: [...source.input],
    output: [...source.output],
    pricingUnits: extractPricingUnits(model.pricing),
    streamable,
  };
}

export function uniqueCapabilities(capabilities: ModelOperationCapability[]): ModelOperationCapability[] {
  const byKey = new Map<string, ModelOperationCapability>();
  for (const capability of capabilities) {
    const key = `${capability.modality}:${capability.operation}`;
    if (!byKey.has(key)) {
      byKey.set(key, capability);
    }
  }
  return [...byKey.values()];
}
