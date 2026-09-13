/**
 * Media payload helpers — base64 → Buffer, URL → Buffer, dimension
 * extraction from `size` strings, MIME type sniffing, etc.
 *
 * The PNG/JPEG/MP4 byte parsers used for billing evidence live in
 * `modalities/{image,video}.ts` (they're billing-aware). This module
 * is the wire-time / runtime helpers shared between vendors.
 */

import { fetchBuffer } from "./http.js";

/**
 * Resolves a media payload to a `{ buffer, mimeType }` pair. Accepts:
 *   - `data:<mime>;base64,...` data URLs
 *   - bare base64 strings (when `fallbackMimeType` is supplied)
 *   - http(s) URLs (fetched)
 */
export async function bufferFromPayload(
    payload: string,
    fallbackMimeType = "application/octet-stream",
    signal?: AbortSignal,
): Promise<{ buffer: Buffer; mimeType: string }> {
    const trimmed = payload.trim();
    if (trimmed.startsWith("data:")) {
        const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(trimmed);
        if (!match) throw new Error("Invalid data URL");
        const mimeType = match[1] || fallbackMimeType;
        const data = match[2] || "";
        const buffer = trimmed.includes(";base64,")
            ? Buffer.from(data, "base64")
            : Buffer.from(decodeURIComponent(data));
        return { buffer, mimeType };
    }

    if (/^https?:\/\//i.test(trimmed)) {
        const { buffer, contentType } = await fetchBuffer(trimmed, { signal });
        return { buffer, mimeType: contentType?.split(";")[0]?.trim() || fallbackMimeType };
    }

    return { buffer: Buffer.from(trimmed, "base64"), mimeType: fallbackMimeType };
}

/**
 * Parse an OpenAI-style "WIDTHxHEIGHT" size string. Tolerant of `auto`,
 * `none` and missing values.
 */
export function sizeToDimensions(size: string | undefined): { width?: number; height?: number } {
    if (!size || typeof size !== "string") return {};
    const match = /^(\d+)x(\d+)$/i.exec(size.trim());
    if (!match) return {};
    return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Selects an audio MIME type from a response_format hint or response
 * Content-Type header. Falls back to "audio/mpeg".
 */
export function audioMimeType(format: string | undefined, contentType?: string | null): string {
    const norm = (value: string | undefined | null): string =>
        typeof value === "string" ? value.trim().toLowerCase() : "";
    const fmt = norm(format);
    const ct = norm(contentType?.split(";")[0]);
    if (ct.startsWith("audio/")) return ct;
    switch (fmt) {
        case "mp3": return "audio/mpeg";
        case "opus": return "audio/opus";
        case "aac": return "audio/aac";
        case "flac": return "audio/flac";
        case "wav": return "audio/wav";
        case "pcm": return "audio/L16";
        default: return "audio/mpeg";
    }
}

export function imageMimeType(buffer: Buffer, fallback = "image/png"): string {
    if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x89504e47) return "image/png";
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    return fallback;
}

export function imageDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
        const chunk = buffer.toString("ascii", 12, 16);
        if (chunk === "VP8X") return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
        if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        if (chunk === "VP8L" && buffer.length >= 25) {
            const bits = buffer.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) { offset += 1; continue; }
            const marker = buffer[offset + 1];
            const blockLength = buffer.readUInt16BE(offset + 2);
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            offset += blockLength + 2;
        }
    }
    return null;
}

export interface ImagePayload {
    payload: string;
    mimeType?: string;
    revisedPrompt?: string;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function string(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** Read the image response shapes used by OpenAI-compatible and native image APIs. */
export function imagePayloadsFromResponse(raw: unknown): ImagePayload[] {
    const root = record(raw) || {};
    const output = record(root.output);
    const candidates: unknown[] = [];
    if (Array.isArray(root.data)) candidates.push(...root.data);
    if (Array.isArray(root.images)) candidates.push(...root.images);
    if (Array.isArray(root.output)) candidates.push(...root.output);
    if (Array.isArray(output?.images)) candidates.push(...output.images);
    if (Array.isArray(output?.results)) candidates.push(...output.results);
    if (Array.isArray(output?.choices)) {
        for (const choice of output.choices) {
            const content = record(record(choice)?.message)?.content;
            if (Array.isArray(content)) candidates.push(...content);
        }
    }
    candidates.push(root, ...(output ? [output] : []));

    const images: ImagePayload[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const item = record(candidate);
        const payload = typeof candidate === "string"
            ? string(candidate)
            : string(item?.b64_json)
                || string(item?.base64)
                || string(item?.image_url)
                || string(item?.url)
                || string(item?.image);
        if (!payload || seen.has(payload)) continue;
        seen.add(payload);
        images.push({
            payload,
            ...(string(item?.mime_type) || string(item?.mimeType) || string(item?.content_type)
                ? { mimeType: string(item?.mime_type) || string(item?.mimeType) || string(item?.content_type) }
                : {}),
            ...(string(item?.revised_prompt) ? { revisedPrompt: string(item?.revised_prompt) } : {}),
        });
    }
    return images;
}

export async function imagesFromResponse(
    raw: unknown,
    fallbackMimeType = "image/png",
    signal?: AbortSignal,
): Promise<Array<{ buffer: Buffer; mimeType: string; revisedPrompt?: string }>> {
    return Promise.all(imagePayloadsFromResponse(raw).map(async (image) => {
        const media = await bufferFromPayload(image.payload, image.mimeType || fallbackMimeType, signal);
        return {
            buffer: media.buffer,
            mimeType: imageMimeType(media.buffer, image.mimeType || media.mimeType || fallbackMimeType),
            ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
        };
    }));
}
