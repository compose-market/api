import { randomUUID } from "crypto";

import { getAllModelCards, getModelRegistry } from "../../inference/catalog/registry.js";

import {
    beginBenchmarkRun,
    completeBenchmarkRun,
    failBenchmarkRun,
    releaseIngestionLock,
    tryAcquireIngestionLock,
} from "./db.js";
import {
    matchBenchmarkRecord,
    observationFromAnalysis,
    selectBestPowerVariants,
} from "./matching.js";
import { BENCHMARK_ENDPOINTS, fetchBenchmarkEndpoint } from "./source.js";

export interface BenchmarkIngestionSummary {
    lockAcquired: boolean;
    succeeded: number;
    failed: number;
    endpoints: Array<{
        endpoint: string;
        status: "succeeded" | "failed";
        models: number;
        requests: number;
        error?: string;
    }>;
}

async function catalogVersion(): Promise<string> {
    const registry = await getModelRegistry();
    return new Date(registry.lastUpdated).toISOString();
}

export async function ingestBenchmarks(): Promise<BenchmarkIngestionSummary> {
    const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("ARTIFICIAL_ANALYSIS_API_KEY is required");
    }

    const lockOwner = randomUUID();
    const acquired = await tryAcquireIngestionLock("artificial-analysis", lockOwner);
    if (!acquired) {
        return { lockAcquired: false, succeeded: 0, failed: 0, endpoints: [] };
    }

    const summary: BenchmarkIngestionSummary = {
        lockAcquired: true,
        succeeded: 0,
        failed: 0,
        endpoints: [],
    };

    try {
        const catalog = getAllModelCards();
        const version = await catalogVersion();

        for (const endpoint of BENCHMARK_ENDPOINTS) {
            const runId = randomUUID();
            await beginBenchmarkRun(runId, endpoint.id);
            try {
                const result = await fetchBenchmarkEndpoint(endpoint, apiKey);
                const analyzed = selectBestPowerVariants(
                    result.records,
                    endpoint.qualityMetric,
                    endpoint.qualityDirection,
                );
                const observations = analyzed.map((item) => observationFromAnalysis(runId, item));
                const links = analyzed
                    .filter((item) => item.isBest)
                    .map((item) => matchBenchmarkRecord(item.record, catalog, version));

                await completeBenchmarkRun({
                    id: runId,
                    endpoint: endpoint.id,
                    operation: endpoint.operation,
                    fetchedAt: result.fetchedAt,
                    sourceVersion: result.sourceVersion,
                    intelligenceIndexVersion: result.intelligenceIndexVersion,
                    payloadHash: result.payloadHash,
                    requestCount: result.requestCount,
                    records: result.records,
                    observations,
                    links,
                });

                summary.succeeded += 1;
                summary.endpoints.push({
                    endpoint: endpoint.id,
                    status: "succeeded",
                    models: result.records.length,
                    requests: result.requestCount,
                });
            } catch (error) {
                await failBenchmarkRun(runId, error);
                summary.failed += 1;
                summary.endpoints.push({
                    endpoint: endpoint.id,
                    status: "failed",
                    models: 0,
                    requests: 0,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    } finally {
        await releaseIngestionLock("artificial-analysis", lockOwner);
    }

    if (summary.succeeded === 0) {
        throw new Error("Artificial Analysis ingestion failed for every endpoint");
    }
    return summary;
}
