/**
 * Shared usage normalizer — reads the typical OpenAI-style usage
 * object shape (with several alias spellings) and produces a
 * `Usage`.
 *
 * Provider-specific extensions (DashScope, Google `usageMetadata`,
 * Vertex, etc.) layer on top of this in their respective modules.
 */

import type { Usage } from "../../core.js";
import { asRecord, assignMetric, readNonNeg } from "./coerce.js";

const PROMPT_KEYS = ["prompt_tokens", "input_tokens", "promptTokens", "inputTokens"] as const;
const COMPLETION_KEYS = ["completion_tokens", "output_tokens", "completionTokens", "outputTokens"] as const;
const TOTAL_KEYS = ["total_tokens", "totalTokens"] as const;
const REASONING_KEYS = ["reasoning_tokens", "reasoningTokens", "completion_tokens_details.reasoning_tokens"] as const;
const CACHED_KEYS = ["cached_tokens", "cached_input_tokens", "cachedInputTokens", "prompt_tokens_details.cached_tokens"] as const;

const DETAIL_METRICS = [
    ["prompt_tokens_details.text_tokens", "input_text_tokens"],
    ["prompt_tokens_details.image_tokens", "input_image_tokens"],
    ["prompt_tokens_details.audio_tokens", "input_audio_tokens"],
    ["prompt_tokens_details.cached_tokens", "cached_input_tokens"],
    ["input_tokens_details.text_tokens", "input_text_tokens"],
    ["input_tokens_details.image_tokens", "input_image_tokens"],
    ["input_tokens_details.audio_tokens", "input_audio_tokens"],
    ["input_tokens_details.cached_tokens", "cached_input_tokens"],
    ["completion_tokens_details.text_tokens", "output_text_tokens"],
    ["completion_tokens_details.image_tokens", "output_image_tokens"],
    ["completion_tokens_details.audio_tokens", "output_audio_tokens"],
    ["completion_tokens_details.reasoning_tokens", "reasoning_tokens"],
    ["output_tokens_details.text_tokens", "output_text_tokens"],
    ["output_tokens_details.image_tokens", "output_image_tokens"],
    ["output_tokens_details.audio_tokens", "output_audio_tokens"],
    ["output_tokens_details.reasoning_tokens", "reasoning_tokens"],
] as const;

/** Read a key path with optional `.` separators. */
function readNested(record: Record<string, unknown> | null | undefined, paths: readonly string[]): number | undefined {
    if (!record) return undefined;
    for (const path of paths) {
        if (!path.includes(".")) {
            const value = record[path];
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
            continue;
        }
        const segments = path.split(".");
        let cursor: unknown = record;
        for (const seg of segments) {
            const r = asRecord(cursor);
            if (!r) { cursor = undefined; break; }
            cursor = r[seg];
        }
        if (typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0) return cursor;
    }
    return undefined;
}

/**
 * Normalize an OpenAI-style usage record. Accepts the union of all
 * common keys we have observed in the wild.
 */
export function normalizeOpenAIUsage(rawUsage: unknown): Usage | undefined {
    const record = asRecord(rawUsage);
    if (!record) return undefined;

    const promptTokens = readNonNeg(record, PROMPT_KEYS) ?? 0;
    const completionTokens = readNonNeg(record, COMPLETION_KEYS) ?? 0;
    const totalTokens = readNonNeg(record, TOTAL_KEYS) ?? promptTokens + completionTokens;
    const reasoningTokens = readNested(record, REASONING_KEYS);
    const cachedInputTokens = readNested(record, CACHED_KEYS);

    const billingMetrics: Record<string, unknown> = {};
    assignMetric(billingMetrics, "input_tokens", promptTokens);
    assignMetric(billingMetrics, "output_tokens", completionTokens);
    assignMetric(billingMetrics, "total_tokens", totalTokens);
    assignMetric(billingMetrics, "reasoning_tokens", reasoningTokens);
    assignMetric(billingMetrics, "cached_input_tokens", cachedInputTokens);
    for (const [path, key] of DETAIL_METRICS) {
        assignMetric(billingMetrics, key, readNested(record, [path]));
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
        ...(Object.keys(billingMetrics).length > 0 ? { billingMetrics } : {}),
        raw: record,
    };
}
