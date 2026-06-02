/**
 * Vendor-agnostic helpers shared across `models/families/*` and
 * `models/vendors/*`. Importing from a single barrel keeps vendor
 * shims short (just the bits that are actually vendor-specific).
 */

export { clean, asRecord, readNonNeg, assignMetric } from "./coerce.js";
export { fetchJson, postJson, getJson, fetchBuffer, readErrorBody, throwHttpError, type HttpFetchInit } from "./http.js";
export { normalizeContentToString, messageText, primaryText, findAttachmentUrl } from "./messages.js";
export { bufferFromPayload, sizeToDimensions, audioMimeType } from "./media.js";
export { normalizeOpenAIUsage } from "./usage.js";
export { object, json, google } from "./schema.js";
