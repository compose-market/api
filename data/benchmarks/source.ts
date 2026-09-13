import { createHash } from "crypto";
import { z } from "zod";

import {
    BENCHMARK_SOURCE,
    type BenchmarkOperation,
    type BenchmarkVariant,
    type RawBenchmarkRecord,
} from "./types.js";

const AA_API_BASE = "https://artificialanalysis.ai/api/v2";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_LANGUAGE_PAGES = 20;

const unknownRecord = z.record(z.string(), z.unknown());
const creatorSchema = z.looseObject({
    id: z.unknown(),
    name: z.unknown(),
    slug: z.unknown().optional(),
    country: z.unknown().optional(),
});
const languageModelSchema = z.looseObject({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    release_date: z.unknown().optional(),
    model_creator: creatorSchema,
    evaluations: unknownRecord,
    pricing: unknownRecord.optional(),
    performance: unknownRecord.optional(),
    artificial_analysis_intelligence_index_cost: unknownRecord.nullable().optional(),
});
const languagePageSchema = z.looseObject({
    tier: z.string(),
    intelligence_index_version: z.number(),
    pagination: z.looseObject({ has_more: z.boolean() }),
    data: z.array(languageModelSchema),
});
const mediaModelSchema = z.looseObject({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.unknown().optional(),
    release_date: z.unknown().optional(),
    model_creator: creatorSchema,
    elo: z.unknown().optional(),
    ci_95: z.unknown().optional(),
    samples: z.unknown().optional(),
    aa_wer_index: z.unknown().optional(),
    bba_score: z.unknown().optional(),
    fdb_score: z.unknown().optional(),
    tau_voice_score: z.unknown().optional(),
});
const mediaResponseSchema = z.looseObject({
    tier: z.string().optional(),
    data: z.array(mediaModelSchema),
});

export interface BenchmarkEndpointDefinition {
    id: string;
    path: string;
    operation: BenchmarkOperation;
    variant: BenchmarkVariant;
    paginated: boolean;
    qualityMetric: string;
    qualityDirection: "higher" | "lower";
}

export const BENCHMARK_ENDPOINTS: BenchmarkEndpointDefinition[] = [
    { id: "language", path: "/language/models/free", operation: "chat", variant: null, paginated: true, qualityMetric: "intelligence", qualityDirection: "higher" },
    { id: "text-to-image", path: "/media/text-to-image/models/free", operation: "text-to-image", variant: null, paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "image-editing", path: "/media/image-editing/models/free", operation: "image-to-image", variant: null, paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "text-to-video", path: "/media/text-to-video/models/free", operation: "text-to-video", variant: null, paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "image-to-video", path: "/media/image-to-video/models/free", operation: "image-to-video", variant: null, paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "text-to-video-audio", path: "/media/text-to-video-audio/models/free", operation: "text-to-video", variant: "with-audio", paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "image-to-video-audio", path: "/media/image-to-video-audio/models/free", operation: "image-to-video", variant: "with-audio", paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "text-to-speech", path: "/media/text-to-speech/models/free", operation: "text-to-speech", variant: null, paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "speech-to-text", path: "/media/speech-to-text/models/free", operation: "speech-to-text", variant: null, paginated: false, qualityMetric: "wer", qualityDirection: "lower" },
    { id: "speech-to-speech", path: "/media/speech-to-speech/models/free", operation: "speech-to-speech", variant: null, paginated: false, qualityMetric: "tauVoice", qualityDirection: "higher" },
    { id: "music-instrumental", path: "/media/music/instrumental/models/free", operation: "text-to-audio", variant: "instrumental", paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
    { id: "music-with-vocals", path: "/media/music/with-vocals/models/free", operation: "text-to-audio", variant: "with-vocals", paginated: false, qualityMetric: "elo", qualityDirection: "higher" },
];

export interface EndpointFetchResult {
    endpoint: BenchmarkEndpointDefinition;
    records: RawBenchmarkRecord[];
    payloadHash: string;
    sourceVersion: string | null;
    intelligenceIndexVersion: number | null;
    requestCount: number;
    fetchedAt: string;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.replace(/[^\d.+-]/g, ""));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function numberRecord(value: Record<string, unknown> | undefined): Record<string, number | null> {
    const output: Record<string, number | null> = {};
    for (const [key, entry] of Object.entries(value ?? {})) {
        if (entry === null || typeof entry === "number" || typeof entry === "string") {
            output[key] = numberOrNull(entry);
        }
    }
    return output;
}

function creatorOf(model: z.infer<typeof languageModelSchema> | z.infer<typeof mediaModelSchema>): { name: string; slug: string } {
    const name = text(model.model_creator.name) ?? "Independent";
    const slug = text(model.model_creator.slug) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return { name, slug: slug || "independent" };
}

function releaseDate(value: unknown): string | null {
    return text(value);
}

function languageRecord(model: z.infer<typeof languageModelSchema>, sourceVersion: string | null): RawBenchmarkRecord {
    const evaluations = numberRecord(model.evaluations);
    const pricing = numberRecord(model.pricing);
    const performance = numberRecord(model.performance);
    const cost = model.artificial_analysis_intelligence_index_cost;
    const costPerTask = cost?.cost_per_task && typeof cost.cost_per_task === "object"
        ? numberOrNull((cost.cost_per_task as Record<string, unknown>).total_cost)
        : null;
    const creator = creatorOf(model);

    return {
        source: BENCHMARK_SOURCE,
        sourceModelId: model.id,
        sourceSlug: model.slug,
        sourceName: model.name,
        sourceCreatorName: creator.name,
        sourceCreatorSlug: creator.slug,
        releaseDate: releaseDate(model.release_date),
        operation: "chat",
        variant: null,
        sourceVersion,
        payload: model,
        metrics: {
            intelligence: evaluations.artificial_analysis_intelligence_index ?? null,
            coding: evaluations.artificial_analysis_coding_index ?? null,
            agentic: evaluations.artificial_analysis_agentic_index ?? null,
            math: evaluations.artificial_analysis_math_index ?? null,
            costPerTask,
            priceInput: pricing.price_1m_input_tokens ?? null,
            priceOutput: pricing.price_1m_output_tokens ?? null,
            priceCacheHit: pricing.price_1m_cache_hit_tokens ?? null,
            priceCacheWrite: pricing.price_1m_cache_write_tokens ?? null,
            speed: performance.median_output_tokens_per_second ?? null,
            ttft: performance.median_time_to_first_token_seconds ?? null,
            ttfa: performance.median_time_to_first_answer_token_seconds ?? null,
            endToEnd: performance.median_end_to_end_response_time_seconds ?? null,
        },
    };
}

function mediaRecord(
    model: z.infer<typeof mediaModelSchema>,
    endpoint: BenchmarkEndpointDefinition,
): RawBenchmarkRecord {
    const creator = creatorOf(model);
    const metrics: Record<string, number | null> = {};

    if (endpoint.qualityMetric === "elo") metrics.elo = numberOrNull(model.elo);
    if (endpoint.qualityMetric === "wer") metrics.wer = numberOrNull(model.aa_wer_index);
    if (endpoint.operation === "speech-to-speech") {
        metrics.bba = numberOrNull(model.bba_score);
        metrics.fdb = numberOrNull(model.fdb_score);
        metrics.tauVoice = numberOrNull(model.tau_voice_score);
    }
    metrics.ci95 = numberOrNull(model.ci_95);
    metrics.samples = numberOrNull(model.samples);

    return {
        source: BENCHMARK_SOURCE,
        sourceModelId: model.id,
        sourceSlug: text(model.slug),
        sourceName: model.name,
        sourceCreatorName: creator.name,
        sourceCreatorSlug: creator.slug,
        releaseDate: releaseDate(model.release_date),
        operation: endpoint.operation,
        variant: endpoint.variant,
        sourceVersion: null,
        payload: model,
        metrics,
    };
}

async function fetchJson(path: string, apiKey: string): Promise<{ body: unknown; raw: string }> {
    const response = await fetch(`${AA_API_BASE}${path}`, {
        headers: {
            "x-api-key": apiKey,
            Accept: "application/json",
            "User-Agent": "ComposeMarket/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
        const suffix = response.status === 429 ? " rate limit exhausted" : "";
        throw new Error(`Artificial Analysis request failed with HTTP ${response.status}${suffix}`);
    }

    const raw = await response.text();
    try {
        return { body: JSON.parse(raw), raw };
    } catch {
        throw new Error("Artificial Analysis returned invalid JSON");
    }
}

export async function fetchBenchmarkEndpoint(
    endpoint: BenchmarkEndpointDefinition,
    apiKey: string,
): Promise<EndpointFetchResult> {
    const records: RawBenchmarkRecord[] = [];
    const hashes: string[] = [];
    let sourceVersion: string | null = null;
    let intelligenceIndexVersion: number | null = null;
    let requestCount = 0;

    if (endpoint.paginated) {
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_LANGUAGE_PAGES) {
            const separator = endpoint.path.includes("?") ? "&" : "?";
            const { body, raw } = await fetchJson(`${endpoint.path}${separator}page=${page}`, apiKey);
            requestCount += 1;
            hashes.push(createHash("sha256").update(raw).digest("hex"));
            const parsed = languagePageSchema.parse(body);
            intelligenceIndexVersion = parsed.intelligence_index_version;
            sourceVersion = String(parsed.intelligence_index_version);
            records.push(...parsed.data.map((model) => languageRecord(model, sourceVersion)));
            hasMore = parsed.pagination.has_more;
            page += 1;
        }
        if (hasMore) {
            throw new Error(`Artificial Analysis pagination exceeded ${MAX_LANGUAGE_PAGES} pages`);
        }
    } else {
        const { body, raw } = await fetchJson(endpoint.path, apiKey);
        requestCount = 1;
        hashes.push(createHash("sha256").update(raw).digest("hex"));
        const parsed = mediaResponseSchema.parse(body);
        records.push(...parsed.data.map((model) => mediaRecord(model, endpoint)));
    }

    return {
        endpoint,
        records,
        payloadHash: createHash("sha256").update(hashes.join(":")).digest("hex"),
        sourceVersion,
        intelligenceIndexVersion,
        requestCount,
        fetchedAt: new Date().toISOString(),
    };
}
