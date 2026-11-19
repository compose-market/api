/**
 * Tiny value-coercion helpers used across the inference adapter
 * (vendors, families, modalities). Kept small and dependency-free.
 */

/**
 * Returns the value as a trimmed string, or `""` when it isn't a string.
 * Used everywhere we read environment variables, JSON fields, etc.
 */
export function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Returns the value as a `Record<string, unknown>` when it is a plain
 * object (not an array, not null, not a primitive). Otherwise `null`.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * Reads the first non-negative number among the given keys from a
 * record. Returns `undefined` if none of the keys hold a finite
 * non-negative number.
 *
 * Used to normalize provider-shaped usage objects where the same
 * value is exposed under several names (e.g. `prompt_tokens`,
 * `input_tokens`, `inputTokens`).
 */
export function readNonNeg(
    record: Record<string, unknown> | null | undefined,
    keys: readonly string[],
): number | undefined {
    if (!record) return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
}

/**
 * Assigns a numeric metric onto a billing-metrics record, only if the
 * value is a finite non-negative number. Skips otherwise.
 */
export function assignMetric(
    metrics: Record<string, unknown>,
    key: string,
    value: unknown,
): void {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        metrics[key] = value;
    }
}

const RESPONSES_ONLY_PARAM_KEYS = [
    "context_management",
    "include",
    "instructions",
    "max_tool_calls",
    "previous_response_id",
    "prompt_cache_retention",
    "store",
    "stream",
    "stream_options",
    "text",
    "truncation",
    "verbosity",
] as const;

/**
 * Shallow-copy `customParams` with Responses-API-only keys removed so
 * Chat Completions / Messages-API family wires never send invalid params.
 */
export function stripResponsesParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!params) return {};
    const out = { ...params };
    for (const key of RESPONSES_ONLY_PARAM_KEYS) {
        delete out[key];
    }
    return out;
}
