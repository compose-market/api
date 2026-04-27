import type { ModelCard } from "../types.js";

export const CANONICAL_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
  "embedding",
] as const;

export type CanonicalModality = typeof CANONICAL_MODALITIES[number];
export type CanonicalOperation = string;

export interface PricingUnit {
  unitKey: string;
  unit?: string;
  header?: string;
  entries: Record<string, number>;
  valueKeys: string[];
  default?: boolean;
}

export interface ModelSourceShape {
  sourceTypes: string[];
  input: string[];
  output: string[];
}

export interface ModelOperationCapability {
  modality: CanonicalModality;
  operation: CanonicalOperation;
  sourceTypes: string[];
  input: string[];
  output: string[];
  pricingUnits: PricingUnit[];
  streamable: boolean;
}

export interface OperationCatalogEntry {
  operation: CanonicalOperation;
  modelCount: number;
  sourceTypes: string[];
  pricingUnits: PricingUnit[];
}

export interface ModalityCatalogEntry {
  modality: CanonicalModality;
  operations: OperationCatalogEntry[];
  modelCount: number;
  pricingUnits: PricingUnit[];
}

export type ModalityClassifier = (model: ModelCard, source: ModelSourceShape) => ModelOperationCapability[];
