/**
 * Batch Settlement Worker - Types
 * 
 * Type definitions for the batch settlement accumulator system.
 * 
 * @module shared/x402/accumulator/types
 */

import type { PaymentIntent } from "../session-budget.js";

export { PaymentIntent };

/**
 * Result of a batch settlement for a single user
 */
export interface BatchSettlementResult {
    userAddress: string;
    chainId: number;
    totalSettledWei: string;
    intentCount: number;
    txHash: string;
    gasUsed?: string;
    error?: string;
}

/**
 * Summary of a full batch settlement run
 */
export interface BatchRunSummary {
    runId: string;
    startTime: number;
    endTime: number;
    totalUsers: number;
    totalIntents: number;
    totalValueWei: string;
    successCount: number;
    failCount: number;
    results: BatchSettlementResult[];
}

/**
 * Configuration for batch settlement
 */
export interface BatchConfig {
    /** Maximum intents to process per batch run */
    maxIntentsPerRun: number;
    /** Timeout for each user settlement (ms) */
    settlementTimeoutMs: number;
    /** Retry count for failed settlements */
    retryCount: number;
    /** Delay between retries (ms) */
    retryDelayMs: number;
}

/**
 * Default batch configuration
 */
export const DEFAULT_BATCH_CONFIG: BatchConfig = {
    maxIntentsPerRun: 500,
    settlementTimeoutMs: 30000,
    retryCount: 3,
    retryDelayMs: 1000,
};
