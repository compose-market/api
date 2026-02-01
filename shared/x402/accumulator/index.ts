/**
 * Accumulator Module - Public API
 * 
 * Exports the batch settlement worker and related utilities.
 * 
 * @module shared/x402/accumulator
 */

// Types
export type {
    BatchSettlementResult,
    BatchRunSummary,
    BatchConfig,
    PaymentIntent,
} from "./types.js";

export { DEFAULT_BATCH_CONFIG } from "./types.js";

// Worker
export {
    runBatchSettlement,
    settleUserBatch,
    triggerImmediateSettlement,
} from "./worker.js";
