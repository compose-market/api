export const BENCHMARK_SOURCE = "artificial-analysis" as const;

export const BENCHMARK_OPERATIONS = [
    "chat",
    "text-to-image",
    "image-to-image",
    "text-to-video",
    "image-to-video",
    "text-to-speech",
    "speech-to-text",
    "speech-to-speech",
    "text-to-audio",
] as const;

export type BenchmarkOperation = typeof BENCHMARK_OPERATIONS[number];
export type BenchmarkVariant = string | null;
export type BenchmarkModality = "text" | "image" | "audio" | "video";
export type MetricDirection = "higher" | "lower";
export type MetricFormat = "number" | "score" | "percent" | "currency" | "milliseconds" | "seconds" | "tokens-per-second";

export interface BenchmarkMetricDefinition {
    key: string;
    label: string;
    unit: string;
    direction: MetricDirection;
    format: MetricFormat;
    headline?: boolean;
}

export interface BenchmarkMetric extends BenchmarkMetricDefinition {
    value: number | null;
}

export interface RawBenchmarkRecord {
    source: typeof BENCHMARK_SOURCE;
    sourceModelId: string;
    sourceSlug: string | null;
    sourceName: string;
    sourceCreatorName: string;
    sourceCreatorSlug: string;
    releaseDate: string | null;
    operation: BenchmarkOperation;
    variant: BenchmarkVariant;
    metrics: Record<string, number | null>;
    sourceVersion: string | null;
    payload: Record<string, unknown>;
}

export interface BenchmarkRun {
    id: string;
    endpoint: string;
    status: "running" | "succeeded" | "failed";
    startedAt: string;
    completedAt: string | null;
    fetchedAt: string | null;
    sourceVersion: string | null;
    payloadHash: string | null;
    requestCount: number;
    modelCount: number;
    errorCode: string | null;
    errorMessage: string | null;
}

export interface BenchmarkObservationRow {
    runId: string;
    sourceModelId: string;
    operation: BenchmarkOperation;
    variant: BenchmarkVariant;
    powerGroup: string;
    isBestVariant: boolean;
    metrics: Record<string, number | null>;
    payload: Record<string, unknown>;
}

export interface BenchmarkModelLink {
    operation: BenchmarkOperation;
    sourceModelId: string;
    catalogModelId: string | null;
    catalogProvider: string | null;
    matchMethod: "exact-id" | "exact-alias" | "exact-name" | "unmatched";
    matchConfidence: number;
    reviewed: boolean;
    catalogVersion: string;
}

export interface BenchmarkSnapshotInfo {
    fetchedAt: string | null;
    publishedAt: string | null;
    source: typeof BENCHMARK_SOURCE;
    sourceVersion: string | null;
    intelligenceIndexVersion: number | null;
    stale: boolean;
}

export interface StandardBenchmarkModel {
    id: string;
    sourceId: string;
    sourceSlug: string | null;
    sourceName: string;
    modelId: string;
    slug: string;
    provider: string;
    family: string;
    creator: string;
    creatorSlug: string;
    name: string;
    operation: BenchmarkOperation;
    variant: BenchmarkVariant;
    modality: BenchmarkModality;
    types: string[];
    isFrontier: boolean;
    releaseDate: string | null;
    parameters: string[];
    metrics: BenchmarkMetric[];
    primaryMetric: string | null;

    // Backwards-compatible language fields used by existing surfaces.
    intelligenceIndex: number | null;
    codingIndex: number | null;
    mathIndex: number | null;
    agenticIndex: number | null;
    mmluPro: number | null;
    gpqa: number | null;
    hle: number | null;
    livecodebench: number | null;
    scicode: number | null;
    math500: number | null;
    aime25: number | null;
    ifbench: number | null;
    lcr: number | null;
    terminalbenchHard: number | null;
    tau2: number | null;
    tokensPerSecond: number | null;
    timeToFirstTokenSeconds: number | null;
    timeToFirstAnswerTokenSeconds: number | null;
    endToEndResponseSeconds: number | null;
    priceBlended1M: number | null;
    priceInput1M: number | null;
    priceOutput1M: number | null;
    efficiencyScore: number | null;

    // Media fields.
    elo: number | null;
    ci95: number | null;
    samples: number | null;
    aaWerIndex: number | null;
    bbaScore: number | null;
    fdbScore: number | null;
    tauVoiceScore: number | null;
}

export interface ComparisonWinner {
    modelId: string;
    value: number | null;
    advantageLabel: string;
}

export interface RadarDataPoint {
    metric: string;
    fullMark: number;
    [modelId: string]: number | string | undefined;
}

export interface HeadToHeadComparison {
    models: StandardBenchmarkModel[];
    winners: Record<string, ComparisonWinner>;
    radarData: RadarDataPoint[];
    unresolved: string[];
}

export interface BenchmarkIndexResult {
    snapshot: BenchmarkSnapshotInfo;
    models: StandardBenchmarkModel[];
    etag: string;
}
