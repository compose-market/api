/**
 * Shared HTTP request context helpers.
 *
 * Provides a single source of truth for:
 * - X-Request-Id generation and propagation
 * - X-Receipt encoding/decoding
 * - Canonical error-envelope shape
 *
 * Every response produced by the api/ server must carry an X-Request-Id header
 * so that integrators, the SDK, and our own telemetry can correlate calls across
 * the stack (api/ -> x402 facilitator -> inference provider -> webhook delivery).
 */

import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-Id";
export const RECEIPT_HEADER = "X-Receipt";

export interface ReceiptLineItem {
    key: string;
    unit: string;
    quantity: number;
    unitPriceUsd: number;
    amountWei: string;
}

export interface ReceiptBill {
    kind: "agent" | "workflow" | "model" | "tool" | "search" | "memory" | "connector";
    source?: string;
    name?: string;
    action?: string;
    subject?: string;
    amountWei: string;
    lineItems: ReceiptLineItem[];
    agent?: string;
    agentWallet?: string;
    depth?: number;
    model?: string;
    tokens?: Record<string, number>;
    tools?: string[];
    total?: string;
    duration?: string;
    txId?: string;
    fees?: {
        total: {
            percent: string;
            amount: string;
        };
        distribution: Record<string, string>;
    };
    children?: ReceiptBill[];
}

export interface ReceiptCumulative {
    totalAmountWei: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    receiptCount: number;
}

export interface Receipt {
    id?: string;
    service?: string;
    action?: string;
    resource?: string;
    userAddress?: string;
    subject?: string;
    lineItems?: ReceiptLineItem[];
    bills?: ReceiptBill[];
    providerAmountWei?: string;
    platformFeeWei?: string;
    finalAmountWei: string;
    settlementStatus?: "queued" | "claimed" | "settled" | "failed";
    txHash?: string;
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    sessionBudgetIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
    network: `eip155:${number}`;
    settledAt: number;
    cumulative?: ReceiptCumulative;
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
 * Encode a billing receipt for the X-Receipt response header.
 *
 * Uses url-safe base64 without padding so it can survive redirects and
 * HTTP/2 canonicalization unchanged.
 */
export function encodeReceiptHeader(receipt: Receipt): string {
    const json = JSON.stringify(receipt);
    const base64 = Buffer.from(json, "utf-8").toString("base64");
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeReceiptHeader(value: string): Receipt {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + padding, "base64").toString("utf-8");
    return JSON.parse(json) as Receipt;
}
