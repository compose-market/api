/**
 * Shared HTTP request context helpers.
 *
 * Provides a single source of truth for:
 * - X-Request-Id generation and propagation
 * - X-Compose-Receipt encoding/decoding
 * - Canonical error-envelope shape
 *
 * Every response produced by the api/ server must carry an X-Request-Id header
 * so that integrators, the SDK, and our own telemetry can correlate calls across
 * the stack (api/ -> x402 facilitator -> inference provider -> webhook delivery).
 */

import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-Id";
export const RECEIPT_HEADER = "X-Compose-Receipt";

export interface ComposeReceipt {
    subject?: string;
    lineItems?: Array<{
        key: string;
        unit: string;
        quantity: number;
        unitPriceUsd: number;
        amountWei: string;
    }>;
    providerAmountWei?: string;
    platformFeeWei?: string;
    finalAmountWei: string;
    txHash?: string;
    network: `eip155:${number}`;
    settledAt: number;
}

/**
 * Generate a new unique request id.
 *
 * Format: `req_<uuid-without-hyphens>`. URL-safe, fits comfortably on the wire,
 * and is unambiguously ours. A caller-supplied id is accepted verbatim when it
 * matches a minimal sanity regex so we stay side-effect-free on passthrough.
 */
export function generateRequestId(): string {
    return `req_${randomUUID().replace(/-/g, "")}`;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function resolveRequestId(
    headers: Record<string, string | string[] | undefined> | undefined,
): string {
    if (!headers) {
        return generateRequestId();
    }

    const candidates: Array<string | string[] | undefined> = [
        headers[REQUEST_ID_HEADER],
        headers[REQUEST_ID_HEADER.toLowerCase()],
        headers["x-request-id"],
        headers["X-Request-Id"],
    ];

    for (const candidate of candidates) {
        const raw = Array.isArray(candidate) ? candidate[0] : candidate;
        if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (trimmed.length > 0 && SAFE_REQUEST_ID.test(trimmed)) {
                return trimmed;
            }
        }
    }

    return generateRequestId();
}

/**
 * Encode a billing receipt for the X-Compose-Receipt response header.
 *
 * Uses url-safe base64 without padding so it can survive redirects and
 * HTTP/2 canonicalization unchanged.
 */
export function encodeReceiptHeader(receipt: ComposeReceipt): string {
    const json = JSON.stringify(receipt);
    const base64 = Buffer.from(json, "utf-8").toString("base64");
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeReceiptHeader(value: string): ComposeReceipt {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + padding, "base64").toString("utf-8");
    return JSON.parse(json) as ComposeReceipt;
}
