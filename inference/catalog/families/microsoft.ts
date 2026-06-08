/**
 * Microsoft AI Image family wire (`mai-image-*`).
 *
 * Pure protocol module. MAI is currently surfaced through Azure Foundry
 * at `/mai/v1/images/generations`. The request shape uses
 * `width` / `height` (or OpenAI-style `size`) and the response is a
 * lightly-modified OpenAI image-shape (`data[0].b64_json | base64 |
 * image | url`).
 *
 * NO endpoints, NO API keys, NO network. Vendors that route MAI models
 * (Azure, future direct) own the transport.
 */

import { asRecord, bufferFromPayload, clean, normalizeOpenAIUsage, sizeToDimensions } from "../shared/index.js";
import type { Usage } from "../../core.js";

/** Path under the host's MAI surface. */
export const MAI_PATH_IMAGES = "/mai/v1/images/generations";

export interface MaiImageOptions {
    n?: number;
    /** OpenAI-style `WIDTHxHEIGHT`. Translated to `width` + `height` on the wire. */
    size?: string;
    width?: number;
    height?: number;
    seed?: number;
    /** Output format hint. */
    outputFormat?: "png" | "jpeg" | "webp";
    customParams?: Record<string, unknown>;
}

export interface MaiImageResult {
    buffer: Buffer;
    mimeType: string;
    usage?: Usage;
    raw: unknown;
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.ceil(value)
        : undefined;
}

function dimensions(raw: unknown, options: MaiImageOptions = {}): { width: number; height: number } | undefined {
    const root = asRecord(raw) || {};
    const size = clean(root.size) || options.size;
    const parsed = sizeToDimensions(size);
    const width = positiveInteger(options.width) ?? positiveInteger(parsed.width);
    const height = positiveInteger(options.height) ?? positiveInteger(parsed.height);
    return width && height ? { width, height } : undefined;
}

function promptTokens(prompt: string): number {
    const text = clean(prompt);
    if (!text) return 0;
    return Math.max(7, Math.ceil(text.length / 4) + 5);
}

export function meteredImageUsage(
    prompt: string,
    raw: unknown,
    options: MaiImageOptions = {},
): Usage | undefined {
    const dim = dimensions(raw, options);
    if (!dim) return undefined;
    const count = positiveInteger(options.n) ?? 1;
    const inputTokens = promptTokens(prompt);
    const outputTokens = Math.ceil((dim.width * dim.height * count) / 1024);
    return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        billingMetrics: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            input_text_tokens: inputTokens,
            output_image_tokens: outputTokens,
        },
        raw: {
            source: "azure_monitor_meter_formula",
            width: dim.width,
            height: dim.height,
            images: count,
        },
    };
}

/**
 * Build the JSON body for `POST /mai/v1/images/generations`. Vendor
 * supplies the host + auth and POSTs this directly.
 */
export function buildImageBody(
    modelId: string,
    prompt: string,
    options: MaiImageOptions = {},
): Record<string, unknown> {
    const sizeDims = sizeToDimensions(options.size);
    const width = options.width ?? sizeDims.width;
    const height = options.height ?? sizeDims.height;

    return {
        model: modelId,
        prompt,
        ...(options.size ? { size: options.size } : {}),
        ...(typeof width === "number" ? { width } : {}),
        ...(typeof height === "number" ? { height } : {}),
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
        ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
        ...(options.customParams ?? {}),
    };
}

/**
 * Decode the raw MAI image-generation response into a buffer + mime
 * pair plus provider token usage when the API includes it.
 */
export async function parseImageResponse(
    raw: unknown,
    options: { n?: number } = {},
): Promise<MaiImageResult> {
    const root = asRecord(raw) || {};
    const data = Array.isArray(root.data) ? root.data : [];
    const first = asRecord(data[0]) ?? root;
    const payload = clean(first.b64_json) || clean(first.base64) || clean(first.image) || clean(first.url);
    if (!payload) throw new Error("MAI returned no image data");
    const image = await bufferFromPayload(payload, "image/png");
    const usage = normalizeOpenAIUsage(root.usage);
    return {
        ...image,
        ...(usage ? { usage } : {}),
        raw,
    };
}
