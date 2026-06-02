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
