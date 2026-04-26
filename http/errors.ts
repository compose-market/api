/**
 * Canonical API error envelope.
 *
 * Every 4xx / 5xx response from the api/ server returns:
 *
 *   { "error": { "code": "<snake_case>", "message": "<human readable>", "details"?: {...} } }
 *
 * `code` is a finite enum; the SDK maps it to typed error subclasses.
 * `details` carries structured payloads (required balances, retry hints, payment-required bodies).
 *
 * This module intentionally has no imports from other api/ modules so it can
 * be loaded from anywhere without circular dependencies.
 */

export type ComposeErrorCode =
    | "validation_error"
    | "authentication_required"
    | "authentication_failed"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "payment_required"
    | "insufficient_balance"
    | "insufficient_allowance"
    | "budget_exhausted"
    | "key_revoked"
    | "key_expired"
    | "key_not_found"
    | "chain_not_supported"
    | "model_not_found"
    | "model_ambiguous"
    | "provider_unavailable"
    | "upstream_timeout"
    | "upstream_error"
    | "internal_error"
    | "idempotency_conflict"
    | "idempotency_in_flight"
    | "settlement_failed"
    | "session_invalid";

export interface ComposeError {
    error: {
        code: ComposeErrorCode;
        message: string;
        details?: Record<string, unknown>;
    };
}

export function buildError(
    code: ComposeErrorCode,
    message: string,
    details?: Record<string, unknown>,
): ComposeError {
    return {
        error: {
            code,
            message,
            ...(details ? { details } : {}),
        },
    };
}

export const STATUS_BY_CODE: Record<ComposeErrorCode, number> = {
    validation_error: 400,
    authentication_required: 401,
    authentication_failed: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    rate_limited: 429,
    payment_required: 402,
    insufficient_balance: 402,
    insufficient_allowance: 402,
    budget_exhausted: 402,
    key_revoked: 401,
    key_expired: 401,
    key_not_found: 404,
    chain_not_supported: 400,
    model_not_found: 404,
    model_ambiguous: 409,
    provider_unavailable: 503,
    upstream_timeout: 504,
    upstream_error: 502,
    internal_error: 500,
    idempotency_conflict: 409,
    idempotency_in_flight: 409,
    settlement_failed: 402,
    session_invalid: 401,
};

export function statusForCode(code: ComposeErrorCode): number {
    return STATUS_BY_CODE[code] ?? 500;
}
