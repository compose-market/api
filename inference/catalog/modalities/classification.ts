/**
 * Classification — text or image modality, operation: "classify".
 *
 * Multi-input scoring: takes one or more inputs (texts / images / audio
 * clips) and returns label probability distributions. Wire varies
 * (HuggingFace text-classification pipeline, Cohere classify, OpenAI
 * Moderations, Roboflow vision, Google content-safety, NVIDIA
 * NemoGuard / GLiNER).
 */

import type { Usage } from "../../core.js";

export type ClassificationInput =
    | string
    | string[]
    | { type: "text"; text: string }
    | Array<{ type: "text"; text: string }>
    | { type: "image"; url?: string; base64?: string; mediaType?: string }
    | Array<{ type: "image"; url?: string; base64?: string; mediaType?: string }>
    | { type: "audio"; url?: string; base64?: string; mediaType?: string };

export interface ClassificationRequest {
    model: string;
    /** Inputs to classify. */
    inputs: ClassificationInput;

    /** Zero-shot label set. When omitted the model uses its built-in
     *  taxonomy (e.g. moderation categories, safety categories). */
    candidate_labels?: string[];

    /** Allow multiple labels per input (zero-shot). */
    multi_label?: boolean;

    /** Minimum score for inclusion in response. */
    threshold?: number;

    /** Top-K labels per input. */
    top_k?: number;

    /** Native — family-specific. */
    native?: ClassificationRequestNative;
    customParams?: Record<string, unknown>;
}

export interface ClassificationRequestNative {
    cohere?: CohereNativeClassify;
    openai?: OpenAINativeClassify;
    nvidia?: NvidiaNativeClassify;
    huggingface?: HuggingfaceNativeClassify;
    roboflow?: RoboflowNativeClassify;
    google?: GoogleNativeClassify;
    alibaba?: AlibabaNativeClassify;
    microsoft?: MicrosoftNativeClassify;
}

// ---------------------------------------------------------------------------
// Cohere classify (single-shot — examples-based fine-tuning baked in)
// ---------------------------------------------------------------------------

export interface CohereNativeClassify {
    /** Few-shot examples (Cohere classify). */
    examples?: Array<{ text: string; label: string }>;
    /** Truncation strategy. */
    truncate?: "NONE" | "START" | "END";
}

// ---------------------------------------------------------------------------
// OpenAI Moderations (omni-moderation-latest, text-moderation-stable)
// ---------------------------------------------------------------------------

export interface OpenAINativeClassify {
    /** Specific moderation model variant (overrides `model`). */
    model_variant?: "omni-moderation-latest" | "text-moderation-latest" | "text-moderation-stable";
}

// ---------------------------------------------------------------------------
// NVIDIA (gliner-pii, nemoguard-content-safety, jailbreak-detect, topic-control)
// ---------------------------------------------------------------------------

export interface NvidiaNativeClassify {
    /** GLiNER-PII entities to extract. */
    entities?: string[];
    /** NemoGuard content-safety policy id. */
    policy_id?: string;
    /** Topic-control banned topics. */
    banned_topics?: string[];
}

// ---------------------------------------------------------------------------
// HuggingFace text-classification pipeline (zero-shot, sentiment, etc.)
// ---------------------------------------------------------------------------

export interface HuggingfaceNativeClassify {
    /** Hypothesis template for zero-shot pipeline. */
    hypothesis_template?: string;
    /** Wait-for-model (cold-start). */
    wait_for_model?: boolean;
    /** Use cache. */
    use_cache?: boolean;
}

// ---------------------------------------------------------------------------
// Roboflow vision classification / detection / segmentation
// ---------------------------------------------------------------------------

export interface RoboflowNativeClassify {
    /** Roboflow workflow id. */
    workflow_id?: string;
    /** Detection-specific. */
    confidence?: number;
    overlap?: number;
    /** Output format. */
    format?: "json" | "image" | "image_beta";
    /** Stroke width. */
    stroke?: number;
    /** Per-class label override. */
    classes?: string[];
}

// ---------------------------------------------------------------------------
// Google Vision / content-safety
// ---------------------------------------------------------------------------

export interface GoogleNativeClassify {
    /** Vision feature types. */
    features?: Array<"LABEL_DETECTION" | "TEXT_DETECTION" | "DOCUMENT_TEXT_DETECTION" | "FACE_DETECTION" | "OBJECT_LOCALIZATION" | "SAFE_SEARCH_DETECTION" | "IMAGE_PROPERTIES">;
    /** Max results per feature. */
    max_results?: number;
}

// ---------------------------------------------------------------------------
// Alibaba (qwen-classify, gte-text-classification)
// ---------------------------------------------------------------------------

export interface AlibabaNativeClassify {
    /** DashScope classify domain. */
    domain?: string;
}

// ---------------------------------------------------------------------------
// Microsoft (Phi-4-multimodal classifier)
// ---------------------------------------------------------------------------

export interface MicrosoftNativeClassify {
    /** Confidence-threshold filter. */
    confidence_threshold?: number;
}

// ===========================================================================
// Response
// ===========================================================================

export interface ClassificationLabel {
    label: string;
    score: number;
    /** Optional detection bounding box (Roboflow / Google Vision). */
    bbox?: { x: number; y: number; width: number; height: number };
    /** Optional category breakdown for moderation responses. */
    categories?: Record<string, boolean | number>;
}

export interface ClassificationResultEntry {
    /** 0-based index into `inputs`. */
    index: number;
    /** Sorted descending by score. */
    labels: ClassificationLabel[];
    /** Raw moderation flags / safety verdict. */
    flagged?: boolean;
}

export interface ClassificationResult {
    results: ClassificationResultEntry[];
    usage?: Usage;
    raw: unknown;
}

/**
 * Default billing metrics: one classify request, N classifications.
 */
export function classifyBillingMetrics(inputCount: number): Record<string, unknown> {
    return { request: 1, classification: Math.max(1, inputCount) };
}
