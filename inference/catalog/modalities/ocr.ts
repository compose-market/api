/**
 * Optical character recognition — text modality, operation: "ocr".
 *
 * OCR takes a document (PDF / image URL / file id / base64) and
 * returns extracted markdown / structured JSON per page, optionally
 * with bounding boxes, embedded images, and document-level annotation.
 */

import type { Usage } from "../../core.js";

/**
 * Document source — accepts URL, file id, or base64 image data.
 */
export type OcrDocument =
    | { type: "document_url"; documentUrl: string }
    | { type: "image_url"; imageUrl: string }
    | { type: "file_id"; fileId: string }
    | { type: "base64"; data: string; mediaType?: string };

export type OcrTableFormat = "markdown" | "html";
export type OcrConfidenceGranularity = "word" | "page";

/**
 * Canonical OCR request.
 */
export interface OcrRequest {
    model: string;
    /** Document to extract from. */
    document: OcrDocument;
    /** Process specific pages only. 0-based. */
    pages?: number[];
    /** Embed image bytes inside the response. */
    include_image_base64?: boolean;
    /** Cap on extracted images per document. */
    image_limit?: number;
    /** Minimum embedded-image dimension to extract. */
    image_min_size?: number;
    /** Render tables as markdown or HTML. */
    table_format?: OcrTableFormat;
    /** Extract page headers / footers explicitly. */
    extract_header?: boolean;
    extract_footer?: boolean;
    /** Confidence aggregation granularity. */
    confidence_scores?: OcrConfidenceGranularity;
    /** Document-level structured extraction. */
    document_annotation_format?:
        | { type: "json_object" }
        | { type: "json_schema"; jsonSchema: Record<string, unknown> };
    document_annotation_prompt?: string;
    /** Per-bbox structured extraction. */
    bbox_annotation_format?:
        | { type: "json_object" }
        | { type: "json_schema"; jsonSchema: Record<string, unknown> };
    /** Output language hint. */
    language?: string;
    /** Native — family-specific knobs. */
    native?: OcrRequestNative;
    customParams?: Record<string, unknown>;
}

export interface OcrRequestNative {
    mistral?: MistralNativeOcr;
    google?: GoogleNativeOcr;
    azure?: AzureNativeOcr;
    zai?: ZaiNativeOcr;
    alibaba?: AlibabaNativeOcr;
    nvidia?: NvidiaNativeOcr;
    microsoft?: MicrosoftNativeOcr;
}

// ---------------------------------------------------------------------------
// Mistral (mistral-document-ai, pixtral OCR)
// ---------------------------------------------------------------------------

export interface MistralNativeOcr {
    /** Image embed inside extracted markdown blocks. */
    include_image_base64?: boolean;
    /** Include text annotation as JSON. */
    document_annotation?: { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
    /** Force a specific OCR endpoint version. */
    api_version?: string;
}

// ---------------------------------------------------------------------------
// Google (Gemini OCR / Document AI)
// ---------------------------------------------------------------------------

export interface GoogleNativeOcr {
    /** Document-AI processor id. */
    processor_id?: string;
    /** Skip human-review queue. */
    skip_human_review?: boolean;
    /** Field mask for partial response. */
    field_mask?: string;
}

// ---------------------------------------------------------------------------
// Azure (Microsoft Read / Document Intelligence + Mistral on Azure)
// ---------------------------------------------------------------------------

export interface AzureNativeOcr {
    /** API version override. */
    api_version?: string;
    /** Document Intelligence model id. */
    model_id?: string;
    /** Reading order. */
    reading_order?: "natural" | "basic";
    /** Locale hint. */
    locale?: string;
    /** Pages range string. */
    pages?: string;
    /** Add-on capabilities. */
    features?: Array<"ocr.highResolution" | "ocr.formula" | "ocr.font" | "barcodes" | "languages" | "queryFields">;
}

// ---------------------------------------------------------------------------
// Z.AI (glm-ocr / layout parsing)
// ---------------------------------------------------------------------------

export interface ZaiNativeOcr {
    /** Return per-block layout. */
    return_layout?: boolean;
    /** Return per-block visualization. */
    return_visualization?: boolean;
    /** Stream incremental pages. */
    stream?: boolean;
}

// ---------------------------------------------------------------------------
// Alibaba (qwen-vl-ocr, paraformer + qwen-doc)
// ---------------------------------------------------------------------------

export interface AlibabaNativeOcr {
    /** Return key-value pairs for tables. */
    output_kv?: boolean;
    /** Reading direction. */
    direction?: "horizontal" | "vertical" | "auto";
}

// ---------------------------------------------------------------------------
// NVIDIA (nemoretriever-parse, nemotron-parse)
// ---------------------------------------------------------------------------

export interface NvidiaNativeOcr {
    /** NemoRetriever-Parse layout output. */
    output_format?: "markdown" | "html" | "json";
    /** Return image embeddings inline. */
    include_embeddings?: boolean;
}

// ---------------------------------------------------------------------------
// Microsoft Phi-4-multimodal-instruct OCR
// ---------------------------------------------------------------------------

export interface MicrosoftNativeOcr {
    /** Phi-4 OCR temperature. */
    temperature?: number;
    /** Phi-4 OCR max tokens. */
    max_tokens?: number;
}

// ===========================================================================
// Response
// ===========================================================================

export interface OcrPageImage {
    id: string;
    /** 0-based bounding box. */
    topLeft: { x: number; y: number };
    bottomRight: { x: number; y: number };
    /** base64 — present when `include_image_base64: true`. */
    imageBase64?: string;
    /** Per-bbox structured extraction. */
    annotation?: Record<string, unknown>;
}

export interface OcrPage {
    /** 1-based page index in source-of-truth markdown. */
    index: number;
    /** Markdown text of the page (preferred output). */
    markdown: string;
    /** Embedded images on the page. */
    images: OcrPageImage[];
    /** Optional rendered dimensions. */
    dimensions?: { dpi?: number; width?: number; height?: number };
    /** Per-page confidence score. */
    confidence?: number;
}

export interface OcrResult {
    /** Per-page extraction. */
    pages: OcrPage[];
    /** Document-level structured annotation when requested. */
    documentAnnotation?: string;
    /** Detected language(s). */
    languages?: string[];
    /** Pages processed (for billing). */
    pagesProcessed: number;
    /** Document size in bytes (when known). */
    docSizeBytes?: number;
    usage?: Usage;
    raw: unknown;
}

/**
 * Default billing metrics: one OCR request, N pages.
 */
export function ocrBillingMetrics(pageCount: number): Record<string, unknown> {
    return { request: 1, page: Math.max(1, pageCount) };
}
