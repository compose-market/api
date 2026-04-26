/**
 * CORS policy — single allow-list layer with explicit Expose-Headers.
 *
 * Every *.compose.market origin and localhost development origin is allowed with
 * credentials. Other origins receive a bare `Access-Control-Allow-Origin: *`
 * without credentials (safe for the public x402 / inference endpoints because
 * the cryptographic identity of the caller is the payment signature or the
 * Compose Key JWT, neither of which is a browser cookie).
 */

import type { NextFunction, Request, Response } from "express";

const EXPOSE_HEADERS = [
    "X-Request-Id",
    "X-Transaction-Hash",
    "X-Compose-Receipt",
    "PAYMENT-REQUIRED",
    "payment-required",
    "PAYMENT-RESPONSE",
    "payment-response",
    "x-payment-intent-id",
    "x-compose-key-budget-limit",
    "x-compose-key-budget-used",
    "x-compose-key-budget-reserved",
    "x-compose-key-budget-remaining",
    "x-compose-key-final-amount-wei",
    "x-compose-key-tx-hash",
    "x-session-budget-limit",
    "x-session-budget-used",
    "x-session-budget-locked",
    "x-session-budget-remaining",
    "x-session-status",
    "x-session-expires-in",
    "x-session-budget-percent",
    "x-compose-session-invalid",
    "x-routing-primary-model",
    "x-routing-final-model",
    "x-routing-attempts",
    "x-routing-fallback-used",
];

const ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "Accept",
    "Accept-Language",
    "X-Chain-Id",
    "x-chain-id",
    "X-Request-Id",
    "x-request-id",
    "X-Session-User-Address",
    "x-session-user-address",
    "X-Payment-Data",
    "PAYMENT-SIGNATURE",
    "payment-signature",
    "X-X402-Max-Amount-Wei",
    "x-x402-max-amount-wei",
    "X-Payment-Intent-Id",
    "x-payment-intent-id",
    "X-Idempotency-Key",
    "x-idempotency-key",
    "X-Compose-Run-Id",
    "x-compose-run-id",
    "X-Internal-Secret",
    "x-internal-secret",
    "X-Workflow-Internal",
    "x-workflow-internal",
    "X-Network-Internal",
    "x-network-internal",
];

const CREDENTIALED_ORIGIN_MATCHERS: RegExp[] = [
    /^https?:\/\/([a-z0-9-]+\.)*compose\.market(?::\d+)?$/i,
    /^https?:\/\/localhost(?::\d+)?$/i,
    /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
    /^https?:\/\/0\.0\.0\.0(?::\d+)?$/i,
    /^tauri:\/\/localhost$/i,
    /^https:\/\/tauri\.localhost$/i,
];

function isCredentialedOrigin(origin: string): boolean {
    return CREDENTIALED_ORIGIN_MATCHERS.some((matcher) => matcher.test(origin));
}

/**
 * Compute a canonical CORS header bag for a given request.
 *
 * Returns the headers to be applied to the response. The `Vary: Origin` header
 * is always emitted so shared caches do not cross-contaminate responses between
 * credentialed first-party origins and anonymous public callers.
 */
export function buildCorsHeaders(
    requestOrigin: string | undefined,
): Record<string, string> {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
        "Access-Control-Expose-Headers": EXPOSE_HEADERS.join(", "),
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
    };

    if (requestOrigin && isCredentialedOrigin(requestOrigin)) {
        headers["Access-Control-Allow-Origin"] = requestOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
        return headers;
    }

    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
}

/**
 * Express middleware that applies the canonical CORS policy and handles
 * preflight requests. Only applied once at the root of the app — individual
 * route handlers must not append their own CORS headers.
 */
export function corsMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        const origin = req.get("origin") || req.get("Origin");
        const headers = buildCorsHeaders(origin);

        for (const [key, value] of Object.entries(headers)) {
            res.setHeader(key, value);
        }

        if (req.method === "OPTIONS") {
            res.status(204).end();
            return;
        }

        next();
    };
}

export function getStaticExposeHeaders(): string[] {
    return [...EXPOSE_HEADERS];
}

export function getStaticAllowedHeaders(): string[] {
    return [...ALLOWED_HEADERS];
}
