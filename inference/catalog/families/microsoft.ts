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

import { asRecord, bufferFromPayload, clean, sizeToDimensions } from "../shared/index.js";
import type { UnifiedUsage } from "../../core.js";

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
    usage?: UnifiedUsage;
    raw: unknown;
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
 * pair plus a billing-metrics-bearing usage envelope.
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
    return {
        ...image,
        usage: {
            promptTokens: 0, completionTokens: 0, totalTokens: 0,
            billingMetrics: { request: 1, image: options.n ?? 1 },
        },
        raw,
    };
}
