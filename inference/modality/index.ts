import type { ModelCard } from "../types.js";
import { classifyAudioModel } from "./audio.js";
import { classifyEmbeddingModel } from "./embeddings.js";
import { classifyImageModel } from "./image.js";
import { mergePricingUnits } from "./pricing.js";
import { getModelSourceShape } from "./source.js";
import { classifyTextModel } from "./text.js";
import type {
  CanonicalModality,
  CanonicalOperation,
  ModalityCatalogEntry,
  ModelOperationCapability,
  ModalityClassifier,
  OperationCatalogEntry,
  PricingUnit,
} from "./types.js";
import { CANONICAL_MODALITIES } from "./types.js";
import { classifyVideoModel } from "./video.js";

export {
  CANONICAL_MODALITIES,
  type CanonicalModality,
  type CanonicalOperation,
  type ModalityCatalogEntry,
  type ModelOperationCapability,
  type OperationCatalogEntry,
  type PricingUnit,
} from "./types.js";
export { extractPricingUnits, mergePricingUnits } from "./pricing.js";
export { getModelSourceShape } from "./source.js";

const CLASSIFIERS: readonly ModalityClassifier[] = [
  classifyTextModel,
  classifyEmbeddingModel,
  classifyImageModel,
  classifyVideoModel,
  classifyAudioModel,
];

const modelCapabilityCache = new WeakMap<ModelCard, ModelOperationCapability[]>();
let catalogCacheModels: ModelCard[] | null = null;
let catalogCacheEntries: ModalityCatalogEntry[] | null = null;
type CapabilityWithModelId = ModelOperationCapability & { modelId: string };

function clonePricingUnits(units: PricingUnit[]): PricingUnit[] {
  return units.map((unit) => ({
    ...unit,
    entries: { ...unit.entries },
    valueKeys: [...unit.valueKeys],
  }));
}

function cloneCapability(capability: ModelOperationCapability): ModelOperationCapability {
  return {
    ...capability,
    sourceTypes: [...capability.sourceTypes],
    input: [...capability.input],
    output: [...capability.output],
    pricingUnits: clonePricingUnits(capability.pricingUnits),
  };
}

export function isCanonicalModality(value: unknown): value is CanonicalModality {
  return typeof value === "string" && CANONICAL_MODALITIES.includes(value as CanonicalModality);
}

export function isCanonicalOperation(value: unknown): value is CanonicalOperation {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

export function isStreamableModality(modality: CanonicalModality | string): boolean {
  return modality === "text" || modality === "image";
}

export function getModelCapabilities(model: ModelCard): ModelOperationCapability[] {
  const cached = modelCapabilityCache.get(model);
  if (cached) {
    return cached.map(cloneCapability);
  }

  const source = getModelSourceShape(model);
  const capabilities = CLASSIFIERS.flatMap((classifier) => classifier(model, source));
  modelCapabilityCache.set(model, capabilities);
  return capabilities.map(cloneCapability);
}

export function classifyModelCard(model: ModelCard): ModelOperationCapability {
  return getModelCapabilities(model)[0] ?? {
    modality: "text",
    operation: "unknown",
    sourceTypes: getModelSourceShape(model).sourceTypes,
    input: getModelSourceShape(model).input,
    output: getModelSourceShape(model).output,
    pricingUnits: [],
    streamable: false,
  };
}

export function modelMatchesModalityOperation(
  model: ModelCard,
  filters: {
    modality?: CanonicalModality;
    operation?: CanonicalOperation;
    streamable?: boolean;
  },
): boolean {
  return getModelCapabilities(model).some((capability) => {
    if (filters.modality && capability.modality !== filters.modality) {
      return false;
    }
    if (filters.operation && capability.operation !== filters.operation) {
      return false;
    }
    if (filters.streamable === true && !capability.streamable) {
      return false;
    }
    return true;
  });
}

function operationCatalogFromCapabilities(capabilities: CapabilityWithModelId[]): OperationCatalogEntry[] {
  const byOperation = new Map<string, {
    modelIds: Set<string>;
    sourceTypes: Set<string>;
    pricingUnits: PricingUnit[];
  }>();

  for (const capability of capabilities) {
    const bucket = byOperation.get(capability.operation) ?? {
      modelIds: new Set<string>(),
      sourceTypes: new Set<string>(),
      pricingUnits: [],
    };
    bucket.modelIds.add(capability.modelId);
    for (const sourceType of capability.sourceTypes) {
      bucket.sourceTypes.add(sourceType);
    }
    bucket.pricingUnits.push(...capability.pricingUnits);
    byOperation.set(capability.operation, bucket);
  }

  return [...byOperation.entries()]
    .map(([operation, bucket]) => ({
      operation,
      modelCount: bucket.modelIds.size,
      sourceTypes: [...bucket.sourceTypes].sort(),
      pricingUnits: mergePricingUnits(bucket.pricingUnits),
    }))
    .sort((a, b) => a.operation.localeCompare(b.operation));
}

export function getModalityOperations(models: ModelCard[] = [], modality?: CanonicalModality): OperationCatalogEntry[] {
  const capabilities: CapabilityWithModelId[] = models.flatMap((model) =>
    getModelCapabilities(model)
      .filter((capability) => !modality || capability.modality === modality)
      .map((capability) => ({ ...capability, modelId: model.modelId })),
  );
  return operationCatalogFromCapabilities(capabilities);
}

export function getModalityCatalog(models: ModelCard[] = []): ModalityCatalogEntry[] {
  if (catalogCacheModels === models && catalogCacheEntries) {
    return catalogCacheEntries.map((entry) => ({
      ...entry,
      operations: entry.operations.map((operation) => ({
        ...operation,
        sourceTypes: [...operation.sourceTypes],
        pricingUnits: clonePricingUnits(operation.pricingUnits),
      })),
      pricingUnits: clonePricingUnits(entry.pricingUnits),
    }));
  }

  const modelIdsByModality = new Map<CanonicalModality, Set<string>>();
  const pricingByModality = new Map<CanonicalModality, PricingUnit[]>();
  for (const modality of CANONICAL_MODALITIES) {
    modelIdsByModality.set(modality, new Set<string>());
    pricingByModality.set(modality, []);
  }

  const allCapabilities: CapabilityWithModelId[] = [];
  for (const model of models) {
    for (const capability of getModelCapabilities(model)) {
      allCapabilities.push({ ...capability, modelId: model.modelId });
      modelIdsByModality.get(capability.modality)?.add(model.modelId);
      pricingByModality.get(capability.modality)?.push(...capability.pricingUnits);
    }
  }

  const catalog = CANONICAL_MODALITIES.map((modality) => ({
    modality,
    operations: operationCatalogFromCapabilities(allCapabilities.filter((capability) => capability.modality === modality)),
    modelCount: modelIdsByModality.get(modality)?.size ?? 0,
    pricingUnits: mergePricingUnits(pricingByModality.get(modality) ?? []),
  }));

  catalogCacheModels = models;
  catalogCacheEntries = catalog;
  return catalog.map((entry) => ({
    ...entry,
    operations: entry.operations.map((operation) => ({
      ...operation,
      sourceTypes: [...operation.sourceTypes],
      pricingUnits: clonePricingUnits(operation.pricingUnits),
    })),
    pricingUnits: clonePricingUnits(entry.pricingUnits),
  }));
}
