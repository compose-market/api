/**
 * Reranking — text modality, operation: "rerank".
 *
 * Reranking takes a query + a list of candidate documents and returns
 * the documents reordered by relevance. The wire format varies by
 * family but the canonical input/output is uniform.
 */

import type { Usage } from "../../core.js";
import type { ModelCard } from "../../types.js";
import {
    buildCapability,
    hasInput,
    hasOutput,
    hasSourceType,
    uniqueCapabilities,
} from "../source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

function metadataRecord(model: ModelCard, key: string): Record<string, unknown> | null {
    const metadata = model.sourceMetadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const value = (metadata as Record<string, unknown>)[key];
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function isRerankModel(model: ModelCard, source: ModelSourceShape): boolean {
    if (hasOutput(source, "embedding-vector") || hasOutput(source, "embedding")) {
        return false;
    }

    const name = `${model.modelId} ${model.name || ""}`.toLowerCase();
    if (/\brerank(?:er|ing)?\b/.test(name)) {
        return hasInput(source, "text") && hasOutput(source, "text");
    }

    const alibaba = metadataRecord(model, "alibaba");
    return model.provider === "alibaba"
        && Array.isArray(alibaba?.capabilities)
        && alibaba.capabilities.includes("TR")
        && hasInput(source, "text")
        && hasOutput(source, "text");
}

export function classifyRerankModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
    if (
        hasSourceType(source, ["rerank", "reranking", "reranker", "text-ranking"])
        || isRerankModel(model, source)
    ) {
        return [buildCapability(model, source, "text", "rerank", false, {
            input: ["text"],
            output: ["text"],
        })];
    }

    return uniqueCapabilities([]);
}

/**
 * Canonical rerank request — universal flat params; family-specific
 * knobs go in `native: { <family>: ... }`.
 */
export interface RerankRequest {
    /** Compose model id. */
    model: string;
    /** Search query / question. */
    query: string;
    /**
     * Candidate documents. Plain string is preferred. Records are passed
     * through unchanged — Cohere accepts structured documents
     * (YAML-formatted is recommended); Voyage / NVIDIA accept
     * `{ text }` objects.
     */
    documents: Array<string | Record<string, unknown>>;
    /** Limit the number of returned ranked documents. */
    top_n?: number;
    /** Per-document token cap (Cohere `max_tokens_per_doc`). */
    max_tokens_per_doc?: number;
    /** Return the document text alongside the rank. */
    return_documents?: boolean;
    /** Native — family-specific extensions. */
    native?: RerankRequestNative;
    /** Free-form passthrough. */
    customParams?: Record<string, unknown>;
}

export interface RerankRequestNative {
    cohere?: CohereNativeRerank;
    voyage?: VoyageNativeRerank;
    nvidia?: NvidiaNativeRerank;
    jina?: JinaNativeRerank;
    mixedbread?: MixedbreadNativeRerank;
    alibaba?: AlibabaNativeRerank;
    azure?: AzureNativeRerank;
    baai?: BaaiNativeRerank;
}

// ---------------------------------------------------------------------------
// Cohere (rerank-v3.5, rerank-v4.0-pro, rerank-multilingual-v3.0)
// ---------------------------------------------------------------------------

export interface CohereNativeRerank {
    /** Per-request priority (Cohere). */
    priority?: number;
    /** Rank fields when documents are objects (Cohere rerank v3+). */
    rank_fields?: string[];
}

// ---------------------------------------------------------------------------
// Voyage AI (rerank-2, rerank-2-lite, rerank-1)
// ---------------------------------------------------------------------------

export interface VoyageNativeRerank {
    truncation?: boolean;
}

// ---------------------------------------------------------------------------
// NVIDIA (nv-rerankqa-mistral-4b, llama-3.2-nv-rerankqa, llama-nemotron-rerank)
// ---------------------------------------------------------------------------

export interface NvidiaNativeRerank {
    truncate?: "NONE" | "START" | "END";
}

// ---------------------------------------------------------------------------
// Jina (jina-reranker-v2-base-multilingual)
// ---------------------------------------------------------------------------

export interface JinaNativeRerank {
    /** Return raw scores (else 0-1 normalized). */
    return_raw_scores?: boolean;
}

// ---------------------------------------------------------------------------
// Mixedbread (mxbai-rerank-*)
// ---------------------------------------------------------------------------

export interface MixedbreadNativeRerank {
    rank_fields?: string[];
    /** Show input chunks in response. */
    return_input?: boolean;
}

// ---------------------------------------------------------------------------
// Alibaba (gte-rerank, gte-multilingual-reranker)
// ---------------------------------------------------------------------------

export interface AlibabaNativeRerank {
    /** DashScope rerank. */
    instruction?: string;
}

// ---------------------------------------------------------------------------
// Azure (cohere-rerank-v4.0-fast on Azure Foundry)
// ---------------------------------------------------------------------------

export interface AzureNativeRerank {
    /** Azure deployment name. */
    deployment?: string;
}

// ---------------------------------------------------------------------------
// BAAI (bge-reranker-v2-m3, bge-reranker-large)
// ---------------------------------------------------------------------------

export interface BaaiNativeRerank {
    /** BGE rerank. */
    normalize?: boolean;
    max_length?: number;
}

// ===========================================================================
// Response
// ===========================================================================

/**
 * Canonical rerank result entry. `index` is the position in the
 * original `documents` array; `relevanceScore` is normalized to [0,1].
 */
export interface RerankResultItem {
    index: number;
    relevanceScore: number;
    /** Returned only when `return_documents: true`. */
    document?: string | Record<string, unknown>;
}

export interface RerankResult {
    results: RerankResultItem[];
    usage?: Usage;
    /** Cohere `meta.api_version`, `meta.warnings`, `meta.billed_units`. */
    providerMetadata?: Record<string, unknown>;
    /** Raw provider response — preserved for telemetry. */
    raw: unknown;
}

/**
 * Default billing metrics for rerank: one search request, N documents.
 */
export function rerankBillingMetrics(documentCount: number): Record<string, unknown> {
    return {
        request: 1,
        search: 1,
        document: Math.max(0, documentCount),
    };
}
