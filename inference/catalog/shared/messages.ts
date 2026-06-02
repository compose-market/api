/**
 * Message utilities — text extraction, attachment URL discovery,
 * content normalization. Reused by every vendor that needs to peek
 * inside a `Message` array (which is most of them).
 */

import type { Part, Message } from "../../core.js";

/**
 * Coerce a `Message.content` to a plain text string. Drops
 * non-text parts (image/audio/video URLs etc.).
 */
export function normalizeContentToString(content: unknown): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content);
    return content
        .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => (part as { text?: string }).text)
        .filter((text): text is string => typeof text === "string")
        .join("\n");
}

/**
 * Returns the textual content of a message regardless of whether it
 * was passed as a string or as a content-part array.
 */
export function messageText(message: Message): string {
    return normalizeContentToString(message.content);
}

/**
 * Returns the first non-empty text payload found in the messages,
 * preferring user messages, then falling back to system / assistant.
 *
 * Used for prompt extraction in single-prompt modalities (image,
 * audio TTS, video).
 */
export function primaryText(messages: Message[]): string {
    const fromRole = (role: Message["role"]): string => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message?.role === role) {
                const text = messageText(message);
                if (text.trim().length > 0) return text;
            }
        }
        return "";
    };
    return fromRole("user") || fromRole("system") || fromRole("assistant");
}

/**
 * Extract the URL from a `Part` of the given attachment
 * kind, if present.
 */
function urlFromPart(part: Part, kind: "image_url" | "input_audio" | "video_url"): string | undefined {
    if (part.type !== kind) return undefined;
    const value = part[kind];
    if (!value) return undefined;
    if (typeof value === "string") return value;
    if (typeof value === "object" && "url" in value && typeof value.url === "string") return value.url;
    return undefined;
}

/**
 * Walks `messages` (most-recent-first) and returns the first
 * attachment URL of the requested kind.
 */
export function findAttachmentUrl(
    messages: Message[],
    kind: "image_url" | "input_audio" | "video_url",
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message) continue;
        const content = message.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const url = urlFromPart(part, kind);
            if (url) return url;
        }
    }
    return undefined;
}
