import { createHash } from "crypto";

import { cacheDel, cached, cacheSet } from "../../cache.js";
import { getModelById, getModelRegistry } from "../../inference/adapters/registry.js";
import { isProvider, type ModelCard } from "../../inference/types.js";

import { latestBenchmarkObservations, type LatestObservationRecord } from "./db.js";
import { identityKey } from "./matching.js";
import {
    BENCHMARK_SOURCE,
    type BenchmarkMetric,
    type BenchmarkMetricDefinition,
    type BenchmarkModality,
    type BenchmarkOperation,
    type BenchmarkSnapshotInfo,
    type ComparisonWinner,
    type HeadToHeadComparison,
    type RadarDataPoint,
    type StandardBenchmarkModel,
} from "./types.js";

const BENCHMARKS_INDEX_KEY = "benchmarks:index";
const BENCHMARKS_FRONTIER_KEY = "benchmarks:frontier";
const BENCHMARKS_INDEX_L2_TTL_S = 300;
const BENCHMARKS_INDEX_L1_TTL_MS = 60_000;
const BENCHMARKS_FRONTIER_L2_TTL_S = 600;
const BENCHMARKS_FRONTIER_L1_TTL_MS = 5 * 60_000;
const MODELS_WORKER_URL = (process.env.MODELS_WORKER_URL ?? "https://models.compose.market").replace(/\/+$/, "");

const MODALITY_BY_OPERATION: Record<BenchmarkOperation, BenchmarkModality> = {
    chat: "text",
    "text-to-image": "image",
    "image-to-image": "image",
    "text-to-video": "video",
    "image-to-video": "video",
    "text-to-speech": "audio",
    "speech-to-text": "audio",
    "speech-to-speech": "audio",
    "text-to-audio": "audio",
};

const METRICS_BY_OPERATION: Record<BenchmarkOperation, BenchmarkMetricDefinition[]> = {
    chat: [
        { key: "intelligence", label: "Intelligence Index", unit: "points", direction: "higher", format: "score", headline: true },
        { key: "coding", label: "Coding Index", unit: "points", direction: "higher", format: "score", headline: true },
        { key: "agentic", label: "Agentic Index", unit: "points", direction: "higher", format: "score", headline: true },
        { key: "speed", label: "Output Speed", unit: "tokens/s", direction: "higher", format: "tokens-per-second", headline: true },
        { key: "ttft", label: "Time to First Token", unit: "s", direction: "lower", format: "milliseconds", headline: true },
        { key: "ttfa", label: "Time to First Answer", unit: "s", direction: "lower", format: "milliseconds" },
        { key: "endToEnd", label: "End-to-End Response", unit: "s", direction: "lower", format: "seconds" },
        { key: "costPerTask", label: "Cost per Intelligence Task", unit: "USD", direction: "lower", format: "currency", headline: true },
        { key: "priceInput", label: "Input Price", unit: "USD / 1M tokens", direction: "lower", format: "currency" },
        { key: "priceOutput", label: "Output Price", unit: "USD / 1M tokens", direction: "lower", format: "currency" },
        { key: "priceCacheHit", label: "Cache Hit Price", unit: "USD / 1M tokens", direction: "lower", format: "currency" },
        { key: "priceCacheWrite", label: "Cache Write Price", unit: "USD / 1M tokens", direction: "lower", format: "currency" },
    ],
    "text-to-image": [
        { key: "elo", label: "Arena Quality Elo", unit: "Elo", direction: "higher", format: "score", headline: true },
        { key: "ci95", label: "95% Confidence Interval", unit: "Elo", direction: "lower", format: "score" },
        { key: "samples", label: "Arena Samples", unit: "matchups", direction: "higher", format: "number" },
    ],
    "image-to-image": [
        { key: "elo", label: "Editing Arena Elo", unit: "Elo", direction: "higher", format: "score", headline: true },
        { key: "ci95", label: "95% Confidence Interval", unit: "Elo", direction: "lower", format: "score" },
        { key: "samples", label: "Arena Samples", unit: "matchups", direction: "higher", format: "number" },
    ],
    "text-to-video": [
        { key: "elo", label: "Video Arena Elo", unit: "Elo", direction: "higher", format: "score", headline: true },
        { key: "ci95", label: "95% Confidence Interval", unit: "Elo", direction: "lower", format: "score" },
        { key: "samples", label: "Arena Samples", unit: "matchups", direction: "higher", format: "number" },
    ],
    "image-to-video": [
        { key: "elo", label: "Image-to-Video Elo", unit: "Elo", direction: "higher", format: "score", headline: true },
        { key: "ci95", label: "95% Confidence Interval", unit: "Elo", direction: "lower", format: "score" },
        { key: "samples", label: "Arena Samples", unit: "matchups", direction: "higher", format: "number" },
    ],
    "text-to-speech": [
        { key: "elo", label: "Speech Arena Elo", unit: "Elo", direction: "higher", format: "score", headline: true },
        { key: "ci95", label: "95% Confidence Interval", unit: "Elo", direction: "lower", format: "score" },
        { key: "samples", label: "Arena Samples", unit: "matchups", direction: "higher", format: "number" },
    ],
    "speech-to-text": [
        { key: "wer", label: "AA-WER Index", unit: "error rate", direction: "lower", format: "percent", headline: true },
    ],
    "speech-to-speech": [
        { key: "tauVoice", label: "𝜏-Voice Score", unit: "score", direction: "higher", format: "percent", headline: true },
        { key: "bba", label: "Big Bench Audio", unit: "score", direction: "higher", format: "percent", headline: true },
        { key: "fdb", label: "Full Duplex Bench", unit: "score", direction: "higher", format: "percent", headline: true },
    ],
    "text-to-audio": [
        { key: "elo", label: "Music Arena Elo", unit: "Elo", direction: "higher", format: "score", headline: true },
        { key: "ci95", label: "95% Confidence Interval", unit: "Elo", direction: "lower", format: "score" },
        { key: "samples", label: "Arena Samples", unit: "matchups", direction: "higher", format: "number" },
    ],
};

let frontierCache: { expiresAt: number; index: FrontierIndex } | null = null;

export class BenchmarkHttpError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

function metricValue(metrics: Record<string, number | null>, key: string): number | null {
    const value = metrics[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function modelTypes(model: ModelCard): string[] {
    if (typeof model.type === "string") return [model.type];
    if (Array.isArray(model.type)) return model.type.filter((entry): entry is string => typeof entry === "string");
    return [];
}

function frontierKey(provider: string, modelId: string): string {
    return `${provider.toLowerCase()}:${modelId.toLowerCase()}`;
}

/**
 * Canonical model identity: lowercased, with Fireworks' p-notation version
 * dots restored (`glm-5p2` == `glm-5.2`). Frontier rows from the models
 * worker and linked catalog rows may disagree on provider or spelling —
 * especially across catalog version skew — so matching falls back to this
 * provider-independent identity.
 */
export function canonicalFrontierId(modelId: string): string {
    return modelId.toLowerCase().replace(/(\d)p(?=\d)/g, "$1.");
}

export interface FrontierIndex {
    /** Exact `provider:modelId` keys as reported by the models worker. */
    keys: Set<string>;
    /** Canonical (provider-independent) model ids as reported by the worker. */
    modelIds: Set<string>;
}

export function buildFrontierIndex(rows: Array<{ provider: string; modelId: string }>): FrontierIndex {
    const keys = new Set<string>();
    const modelIds = new Set<string>();
    for (const row of rows) {
        keys.add(frontierKey(row.provider, row.modelId));
        modelIds.add(canonicalFrontierId(row.modelId));
    }
    return { keys, modelIds };
}

/** A linked catalog model is frontier when the worker flags the exact row or the same canonical model. */
export function isFrontierModel(frontier: FrontierIndex, provider: string, modelId: string): boolean {
    if (frontier.keys.has(frontierKey(provider, modelId))) return true;
    return frontier.modelIds.has(canonicalFrontierId(modelId));
}

async function fetchFrontierIndex(): Promise<FrontierIndex> {
    if (frontierCache && frontierCache.expiresAt > Date.now()) return frontierCache.index;

    const rows = await cached(
        BENCHMARKS_FRONTIER_KEY,
        BENCHMARKS_FRONTIER_L2_TTL_S,
        BENCHMARKS_FRONTIER_L1_TTL_MS,
        async () => {
            const collected: Array<{ provider: string; modelId: string }> = [];
            let cursor: string | null = "0";
            for (let page = 0; page < 50 && cursor !== null; page += 1) {
                const url = new URL(`${MODELS_WORKER_URL}/models`);
                url.searchParams.set("frontier", "1");
                url.searchParams.set("compact", "1");
                url.searchParams.set("limit", "200");
                url.searchParams.set("cursor", cursor);
                const response = await fetch(url, {
                    headers: { Accept: "application/json" },
                    signal: AbortSignal.timeout(8_000),
                });
                if (!response.ok) {
                    throw new Error(`models.compose.market frontier request failed with HTTP ${response.status}`);
                }
                const body = await response.json() as { data?: unknown; next_cursor?: unknown };
                if (!Array.isArray(body.data)) {
                    throw new Error("models.compose.market returned an invalid frontier response");
                }
                for (const item of body.data) {
                    if (!item || typeof item !== "object") continue;
                    const row = item as Record<string, unknown>;
                    if (typeof row.provider === "string" && typeof row.modelId === "string") {
                        collected.push({ provider: row.provider, modelId: row.modelId });
                    }
                }
                cursor = typeof body.next_cursor === "string" ? body.next_cursor : null;
            }
            return collected;
        },
    );

    const index = buildFrontierIndex(rows);
    frontierCache = { expiresAt: Date.now() + BENCHMARKS_FRONTIER_L1_TTL_MS, index };
    return index;
}

function operationMetrics(operation: BenchmarkOperation, values: Record<string, number | null>): BenchmarkMetric[] {
    return METRICS_BY_OPERATION[operation].map((definition) => ({
        ...definition,
        value: metricValue(values, definition.key),
    }));
}

function parametersFor(row: LatestObservationRecord): string[] {
    if (!row.variant) return [];
    const noisyPatterns = [
        /fallback/i,
        /adaptive reasoning/i,
        /minimal/i,
        /low effort/i,
        /medium effort/i,
        /high effort/i,
        /max effort/i,
        /maximum effort/i,
    ];
    return [...new Set(
        row.variant
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0 && !noisyPatterns.some((pattern) => pattern.test(value)))
    )];
}

function toStandardModel(
    row: LatestObservationRecord,
    catalogModel: ModelCard,
    frontier: FrontierIndex,
): StandardBenchmarkModel {
    const metrics = operationMetrics(row.operation, row.metrics);
    const intelligence = metricValue(row.metrics, "intelligence");
    const costPerTask = metricValue(row.metrics, "costPerTask");
    const family = catalogModel.family || catalogModel.provider;
    const headlineMetric = metrics.find((metric) => metric.headline && metric.value !== null)?.key ?? null;

    return {
        id: row.sourceModelId,
        sourceId: row.sourceModelId,
        sourceSlug: row.sourceSlug,
        sourceName: row.sourceName,
        modelId: catalogModel.modelId,
        slug: catalogModel.modelId,
        provider: catalogModel.provider,
        family,
        creator: row.sourceCreatorName,
        creatorSlug: row.sourceCreatorSlug,
        name: catalogModel.name || row.sourceName,
        operation: row.operation,
        variant: row.variant,
        modality: MODALITY_BY_OPERATION[row.operation],
        types: modelTypes(catalogModel),
        isFrontier: isFrontierModel(frontier, catalogModel.provider, catalogModel.modelId),
        releaseDate: row.releaseDate,
        parameters: parametersFor(row),
        metrics,
        primaryMetric: headlineMetric,
        intelligenceIndex: intelligence,
        codingIndex: metricValue(row.metrics, "coding"),
        mathIndex: metricValue(row.metrics, "math"),
        agenticIndex: metricValue(row.metrics, "agentic"),
        mmluPro: null,
        gpqa: null,
        hle: null,
        livecodebench: null,
        scicode: null,
        math500: null,
        aime25: null,
        ifbench: null,
        lcr: null,
        terminalbenchHard: null,
        tau2: null,
        tokensPerSecond: metricValue(row.metrics, "speed"),
        timeToFirstTokenSeconds: metricValue(row.metrics, "ttft"),
        timeToFirstAnswerTokenSeconds: metricValue(row.metrics, "ttfa"),
        endToEndResponseSeconds: metricValue(row.metrics, "endToEnd"),
        priceBlended1M: null,
        priceInput1M: metricValue(row.metrics, "priceInput"),
        priceOutput1M: metricValue(row.metrics, "priceOutput"),
        efficiencyScore: intelligence !== null && costPerTask !== null && costPerTask > 0
            ? Number((intelligence / costPerTask).toFixed(2))
            : null,
        elo: metricValue(row.metrics, "elo"),
        ci95: metricValue(row.metrics, "ci95"),
        samples: metricValue(row.metrics, "samples"),
        aaWerIndex: metricValue(row.metrics, "wer"),
        bbaScore: metricValue(row.metrics, "bba"),
        fdbScore: metricValue(row.metrics, "fdb"),
        tauVoiceScore: metricValue(row.metrics, "tauVoice"),
    };
}

export function resolveBenchmarkCatalogModel(modelId: string, provider: string | null): ModelCard | null {
    return getModelById(modelId)
        ?? (provider && isProvider(provider) ? getModelById(modelId, provider) : null);
}

async function loadBenchmarkIndex() {
    const [rows, registry, frontier] = await Promise.all([
        latestBenchmarkObservations(),
        getModelRegistry(),
        fetchFrontierIndex(),
    ]);

    const linked = new Map<string, StandardBenchmarkModel>();
    for (const row of rows) {
        if (!row.catalogModelId) continue;
        const catalogModel = resolveBenchmarkCatalogModel(row.catalogModelId, row.catalogProvider);
        if (!catalogModel) continue;
        const model = toStandardModel(row, catalogModel, frontier);
        const key = `${model.modelId}:${model.operation}:${model.variant ?? ""}`;
        const existing = linked.get(key);
        if (!existing) {
            linked.set(key, model);
            continue;
        }

        const definition = model.primaryMetric
            ? model.metrics.find((metric) => metric.key === model.primaryMetric)
            : undefined;
        const value = definition?.value ?? null;
        const existingDefinition = existing.primaryMetric
            ? existing.metrics.find((metric) => metric.key === existing.primaryMetric)
            : undefined;
        const existingValue = existingDefinition?.value ?? null;
        const modelWins = value !== null && existingValue !== null
            ? definition?.direction === "lower" ? value < existingValue : value > existingValue
            : value !== null && existingValue === null
                ? true
                : value === null && existingValue !== null
                    ? false
                    : (model.releaseDate ?? "") > (existing.releaseDate ?? "");
        if (modelWins) linked.set(key, model);
    }
    const models = [...linked.values()];

    models.sort(compareBenchmarkModelOrder);

    const latestFetchedAt = rows
        .map((row) => row.fetchedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
    const sourceVersion = rows.find((row) => row.intelligenceIndexVersion !== null)?.sourceVersion ?? null;
    const snapshot: BenchmarkSnapshotInfo = {
        fetchedAt: latestFetchedAt,
        publishedAt: latestFetchedAt,
        source: BENCHMARK_SOURCE,
        sourceVersion,
        intelligenceIndexVersion: rows.find((row) => row.intelligenceIndexVersion !== null)?.intelligenceIndexVersion ?? null,
        stale: false,
    };
    const etag = `"${createHash("sha256").update(JSON.stringify({
        ids: models.map((model) => `${model.provider}:${model.modelId}:${model.operation}:${model.variant ?? ""}`),
        fetchedAt: latestFetchedAt,
        sourceVersion,
        catalog: registry.lastUpdated,
    })).digest("hex").slice(0, 32)}"`;

    return { snapshot, models, etag };
}

export async function invalidateBenchmarkCache(): Promise<void> {
    frontierCache = null;
    await cacheDel(BENCHMARKS_INDEX_KEY, BENCHMARKS_FRONTIER_KEY);
}

export async function getBenchmarkIndex(options: { force?: boolean } = {}) {
    if (options.force) {
        frontierCache = null;
        await cacheDel(BENCHMARKS_INDEX_KEY, BENCHMARKS_FRONTIER_KEY);
        const value = await loadBenchmarkIndex();
        await cacheSet(BENCHMARKS_INDEX_KEY, value, BENCHMARKS_INDEX_L2_TTL_S, BENCHMARKS_INDEX_L1_TTL_MS);
        return value;
    }
    return cached(BENCHMARKS_INDEX_KEY, BENCHMARKS_INDEX_L2_TTL_S, BENCHMARKS_INDEX_L1_TTL_MS, loadBenchmarkIndex);
}

export async function getBenchmarkModels(): Promise<StandardBenchmarkModel[]> {
    return (await getBenchmarkIndex()).models;
}

function metricByKey(model: StandardBenchmarkModel, key: string): BenchmarkMetric | undefined {
    return model.metrics.find((metric) => metric.key === key);
}

function compareBenchmarkModelOrder(left: StandardBenchmarkModel, right: StandardBenchmarkModel): number {
    const leftMetric = left.primaryMetric ? metricByKey(left, left.primaryMetric) : undefined;
    const rightMetric = right.primaryMetric ? metricByKey(right, right.primaryMetric) : undefined;
    const leftValue = leftMetric?.value ?? null;
    const rightValue = rightMetric?.value ?? null;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue !== null) {
        const leftDir = leftMetric?.direction ?? "higher";
        const rightDir = rightMetric?.direction ?? "higher";
        if (leftDir !== rightDir) {
            return leftDir === "higher" ? -1 : 1;
        }
        if (leftValue !== rightValue) {
            return leftDir === "lower" ? leftValue - rightValue : rightValue - leftValue;
        }
    }
    return left.name.localeCompare(right.name)
        || left.modelId.localeCompare(right.modelId)
        || left.provider.localeCompare(right.provider);
}

export async function getBenchmarkForModel(modelId: string): Promise<StandardBenchmarkModel | null> {
    const models = await getBenchmarkModels();
    const query = modelId.trim();
    const queryKey = identityKey(query);
    const matches = models.filter((model) =>
        model.modelId.toLowerCase() === query.toLowerCase() ||
        model.sourceId === query ||
        (model.sourceSlug !== null && model.sourceSlug.toLowerCase() === query.toLowerCase()) ||
        identityKey(model.modelId) === queryKey ||
        (model.sourceSlug !== null && identityKey(model.sourceSlug) === queryKey)
    );
    if (matches.length === 0) return null;
    return matches.sort(compareBenchmarkModelOrder)[0];
}

function formatWinnerValue(metric: BenchmarkMetric): string {
    if (metric.value === null) return "Leader";
    switch (metric.format) {
        case "currency":
            return `$${metric.value.toFixed(metric.value < 1 ? 3 : 2)}`;
        case "milliseconds":
            return `${Math.round(metric.value * 1000)}ms`;
        case "percent":
            return `${(metric.value * 100).toFixed(1)}%`;
        case "tokens-per-second":
            return `${metric.value.toFixed(1)} tok/s`;
        default:
            return metric.value.toFixed(metric.value < 10 ? 2 : 1);
    }
}

function winnerFor(models: StandardBenchmarkModel[], key: string): ComparisonWinner | null {
    const entries = models
        .map((model) => ({ model, metric: metricByKey(model, key) }))
        .filter((entry): entry is { model: StandardBenchmarkModel; metric: BenchmarkMetric & { value: number } } =>
            entry.metric?.value !== null && entry.metric?.value !== undefined
        );
    if (entries.length === 0) return null;

    const direction = entries[0].metric.direction;
    const winner = entries.reduce((best, current) => {
        const currentWins = direction === "higher"
            ? current.metric.value > best.metric.value
            : current.metric.value < best.metric.value;
        return currentWins ? current : best;
    });
    const challengers = entries.filter((entry) => entry.model.modelId !== winner.model.modelId);
    let advantageLabel = direction === "higher" ? "Highest" : "Lowest";
    if (challengers.length > 0) {
        const nearest = direction === "higher"
            ? Math.max(...challengers.map((entry) => entry.metric.value))
            : Math.min(...challengers.map((entry) => entry.metric.value));
        const delta = Math.abs(winner.metric.value - nearest);
        const percent = nearest !== 0 ? Math.round((delta / Math.abs(nearest)) * 100) : null;
        advantageLabel = percent !== null && percent > 0
            ? `${percent}% ${direction === "higher" ? "ahead" : "better"}`
            : `${formatWinnerValue(winner.metric)} lead`;
    }
    return {
        modelId: winner.model.modelId,
        value: winner.metric.value,
        advantageLabel,
    };
}

function normalizedRadarValue(metric: BenchmarkMetric, entries: BenchmarkMetric[]): number | null {
    if (metric.value === null) return null;
    const values = entries.map((entry) => entry.value).filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    if (metric.direction === "higher") {
        const max = Math.max(...values);
        return max > 0 ? Math.round((metric.value / max) * 100) : null;
    }
    const min = Math.min(...values);
    if (min === 0) return metric.value === 0 ? 100 : 0;
    return Math.round((min / metric.value) * 100);
}

export async function compareBenchmarkModels(modelIds: string[]): Promise<HeadToHeadComparison> {
    const requested = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
    const all = await getBenchmarkModels();
    const byCanonical = new Map(all.map((model) => [model.modelId.toLowerCase(), model]));
    const models: StandardBenchmarkModel[] = [];
    const unresolved: string[] = [];

    for (const id of requested) {
        const model = byCanonical.get(id.toLowerCase()) ?? await getBenchmarkForModel(id);
        if (model && !models.some((existing) => existing.modelId === model.modelId && existing.operation === model.operation && existing.variant === model.variant)) {
            models.push(model);
        } else if (!model) {
            unresolved.push(id);
        }
    }

    if (models.length === 0) {
        throw new BenchmarkHttpError(422, "None of the requested models have linked benchmark data");
    }

    const comparisonOperation = models[0].operation;
    if (models.some((model) => model.operation !== comparisonOperation)) {
        throw new BenchmarkHttpError(422, "Head-to-head models must share the same benchmark operation");
    }

    const definitions = METRICS_BY_OPERATION[models[0].operation];
    const winners: Record<string, ComparisonWinner> = {};
    for (const definition of definitions.filter((metric) => metric.headline)) {
        const winner = winnerFor(models, definition.key);
        if (winner) winners[definition.key] = winner;
    }

    const radarData: RadarDataPoint[] = definitions
        .filter((definition) => definition.headline)
        .map((definition) => {
            const entries = models.map((model) => metricByKey(model, definition.key)).filter((metric): metric is BenchmarkMetric => Boolean(metric));
            const point: RadarDataPoint = {
                metric: definition.label,
                fullMark: 100,
            };
            for (const model of models) {
                const metric = metricByKey(model, definition.key);
                if (!metric) continue;
                const value = normalizedRadarValue(metric, entries);
                if (value !== null) point[model.modelId] = value;
            }
            return point;
        });

    return { models, winners, radarData, unresolved };
}
