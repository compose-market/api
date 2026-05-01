import { loadMetricsConfig } from "./config.js";
import {
    recordApiAttemptMetric,
    recordSettledBillableCallMetric,
    recordSettlementTransactionMetric,
} from "./redis.js";
import type { MetricsClientSource } from "./types.js";

function warnMetricFailure(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[metrics] ${action} failed: ${message}`);
}

export function captureSettlementTransaction(input: {
    chainId: number;
    txHash?: string | null;
    amountWei: string | number | bigint;
    from?: string | null;
    to?: string | null;
    blockNumber?: string | number | bigint | null;
    source: string;
}): void {
    void recordSettlementTransactionMetric(input).catch((error) => warnMetricFailure("record settlement transaction", error));
}

export function captureSettledBillableCall(input: {
    chainId: number;
    id: string;
    amountWei?: string | number | bigint;
    txHash?: string | null;
    source: string;
    userAddress?: string | null;
}): void {
    void recordSettledBillableCallMetric(input).catch((error) => warnMetricFailure("record settled billable call", error));
}

export function captureSettledBillableCalls(inputs: Array<{
    chainId: number;
    id: string;
    amountWei?: string | number | bigint;
    txHash?: string | null;
    source: string;
    userAddress?: string | null;
}>): void {
    for (const input of inputs) {
        captureSettledBillableCall(input);
    }
}

export function captureApiAttempt(input: {
    source: MetricsClientSource;
    method: string;
    path: string;
    statusCode: number;
    requestId?: string | null;
}): void {
    void recordApiAttemptMetric(input).catch((error) => warnMetricFailure("record api attempt", error));
}

export function metricsDatasetName(): string {
    return loadMetricsConfig().dataset;
}
