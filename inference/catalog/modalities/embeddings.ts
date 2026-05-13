import type { ModelCard } from "../../types.js";
import type { UnifiedRequest, UnifiedUsage } from "../../core.js";
import {
  buildCapability,
  hasInput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
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

export function getEmbeddingParameterCatalog(): Record<string, Record<string, unknown>> {
  return {
    encoding_format: {
      type: "string",
      required: false,
      options: ["float", "base64"],
      description: "Embedding vector encoding.",
    },
    truncate: {
      type: "string",
      required: false,
      options: ["END", "START", "NONE", "auto"],
      description: "Embedding input truncation policy.",
    },
  };
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

// ===========================================================================
// Universal embeddings request
// ===========================================================================

export type EmbeddingInput =
  | string
  | string[]
  | { type: "image"; url?: string; base64?: string; mediaType?: string }
  | Array<{ type: "image"; url?: string; base64?: string; mediaType?: string }>
  | { type: "text"; text: string }
  | Array<{ type: "text"; text: string }>;

export interface EmbeddingsRequest {
  model: string;
  input: EmbeddingInput;

  /** Output dimensions (Matryoshka — OpenAI text-embedding-3, Voyage,
   *  Cohere v4, Gemini-embedding). */
  dimensions?: number;
  /** Encoding format. */
  encoding_format?: "float" | "base64";

  /** Cohere-specific (and increasingly common): input direction. */
  input_type?: "search_query" | "search_document" | "classification" | "clustering" | "image";

  /** Truncation strategy when input exceeds context. */
  truncate?: "NONE" | "START" | "END" | "auto";

  /** Identity for safety review. */
  user?: string;

  native?: EmbeddingsRequestNative;
  customParams?: Record<string, unknown>;
}

export interface EmbeddingsRequestNative {
  openai?: OpenAINativeEmbeddings;
  google?: GoogleNativeEmbeddings;
  cohere?: CohereNativeEmbeddings;
  alibaba?: AlibabaNativeEmbeddings;
  voyage?: VoyageNativeEmbeddings;
  jina?: JinaNativeEmbeddings;
  microsoft?: MicrosoftNativeEmbeddings;
  baai?: BaaiNativeEmbeddings;
  nvidia?: NvidiaNativeEmbeddings;
  zai?: ZaiNativeEmbeddings;
  mistral?: MistralNativeEmbeddings;
  mixedbread?: MixedbreadNativeEmbeddings;
}

// ---------------------------------------------------------------------------
// OpenAI (text-embedding-3-small/large, text-embedding-ada-002)
// ---------------------------------------------------------------------------

export interface OpenAINativeEmbeddings {
  /** Truncate input to model context. */
  truncate?: boolean;
}

// ---------------------------------------------------------------------------
// Google (gemini-embedding-001, text-embedding-005, text-multilingual-embedding-002)
// ---------------------------------------------------------------------------

export interface GoogleNativeEmbeddings {
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY"
    | "CLASSIFICATION" | "CLUSTERING" | "QUESTION_ANSWERING" | "FACT_VERIFICATION" | "CODE_RETRIEVAL_QUERY";
  /** Optional title for retrieval-document task. */
  title?: string;
  /** Output dim in Matryoshka. */
  outputDimensionality?: number;
  /** Auto-truncate. */
  autoTruncate?: boolean;
}

// ---------------------------------------------------------------------------
// Cohere (embed-v4.0, embed-multilingual-v3.0, embed-english-v3.0)
// ---------------------------------------------------------------------------

export interface CohereNativeEmbeddings {
  input_type: "search_query" | "search_document" | "classification" | "clustering" | "image";
  truncate?: "NONE" | "START" | "END";
  embedding_types?: Array<"float" | "int8" | "uint8" | "binary" | "ubinary">;
  /** Image embedding only. */
  images?: Array<string>;
}

// ---------------------------------------------------------------------------
// Alibaba (text-embedding-v4, gte-*)
// ---------------------------------------------------------------------------

export interface AlibabaNativeEmbeddings {
  /** DashScope-specific (`text_type`). */
  text_type?: "query" | "document";
  /** Output type. */
  output_type?: "dense" | "sparse" | "dense&sparse";
  /** Truncate. */
  truncate_dim?: number;
}

// ---------------------------------------------------------------------------
// Voyage AI (voyage-3-large, voyage-multimodal-3, voyage-code-3)
// ---------------------------------------------------------------------------

export interface VoyageNativeEmbeddings {
  input_type: "query" | "document";
  truncation?: boolean;
  output_dimension?: 256 | 512 | 1024 | 2048;
  output_dtype?: "float" | "int8" | "uint8" | "binary" | "ubinary";
  /** voyage-multimodal: pixel/text inputs. */
  inputs?: Array<{ content: Array<{ type: "text" | "image_url" | "image_base64"; text?: string; image_url?: string; image_base64?: string }> }>;
}

// ---------------------------------------------------------------------------
// Jina (jina-embeddings-v3, jina-clip-v2)
// ---------------------------------------------------------------------------

export interface JinaNativeEmbeddings {
  task?: "retrieval.query" | "retrieval.passage" | "separation" | "classification" | "text-matching";
  late_chunking?: boolean;
  embedding_type?: "float" | "base64" | "binary";
  dimensions?: 32 | 64 | 128 | 256 | 512 | 768 | 1024;
}

// ---------------------------------------------------------------------------
// Microsoft (E5 series — published by MS Research, served by HF/etc.)
// ---------------------------------------------------------------------------

export interface MicrosoftNativeEmbeddings {
  /** E5 query/passage prefix (manual). */
  prefix?: "query: " | "passage: ";
  /** Pool method. */
  pooling?: "mean" | "cls" | "last_token";
}

// ---------------------------------------------------------------------------
// BAAI (bge-m3, bge-large-en, bge-multilingual-gemma2)
// ---------------------------------------------------------------------------

export interface BaaiNativeEmbeddings {
  /** BGE-M3 multi-modal output. */
  return_dense?: boolean;
  return_sparse?: boolean;
  return_colbert_vecs?: boolean;
  /** Max length token cap. */
  max_length?: number;
}

// ---------------------------------------------------------------------------
// NVIDIA (nv-embed-v1, nv-embedqa-*, nemoretriever-*)
// ---------------------------------------------------------------------------

export interface NvidiaNativeEmbeddings {
  input_type?: "query" | "passage";
  truncate?: "NONE" | "START" | "END";
  /** EmbedCode-specific. */
  encoding_format?: "float" | "base64";
}

// ---------------------------------------------------------------------------
// Z.AI (embedding-3, glm-embedding)
// ---------------------------------------------------------------------------

export interface ZaiNativeEmbeddings {
  user_id?: string;
  request_id?: string;
}

// ---------------------------------------------------------------------------
// Mistral (mistral-embed)
// ---------------------------------------------------------------------------

export interface MistralNativeEmbeddings {
  encoding_format?: "float" | "base64";
}

// ---------------------------------------------------------------------------
// Mixedbread (mxbai-embed-large-v1, mxbai-rerank-*)
// ---------------------------------------------------------------------------

export interface MixedbreadNativeEmbeddings {
  truncation_strategy?: "none" | "start" | "end";
  prompt?: string;
  encoding_format?: "float" | "ubinary" | "ibinary" | "int8" | "uint8";
  dimensions?: number;
}

// ===========================================================================
// Embeddings response
// ===========================================================================

export interface EmbeddingsResponse {
  embeddings: number[][];
  /** Sparse vectors (BAAI BGE-M3, DashScope sparse). */
  sparseEmbeddings?: Array<Record<string, number>>;
  /** ColBERT token-level vectors (BGE-M3). */
  colbertVectors?: number[][][];
  /** Per-input mode (when binary / int8 etc.). */
  encoding?: "float" | "base64" | "int8" | "uint8" | "binary" | "ubinary";
  usage?: UnifiedUsage;
  raw: unknown;
}
