/**
 * Batch Settlement Worker
 * 
 * Executes batch settlements for accumulated payment intents.
 * Triggered by CloudWatch Events (every 2 minutes) or $1 threshold.
 * 
 * SETTLEMENT FLOW:
 * 1. Read all pending intents from Redis (grouped by user + chain)
 * 2. For each user, calculate total amount to settle
 * 3. Execute single USDC.transferFrom per user (from locked allowance)
 * 4. Mark intents as settled on success
 * 5. On failure, fallback to per-intent settlement or requeue
 * 
 * @module shared/x402/accumulator/worker
 */

import {
    getPendingIntentsGrouped,
    markIntentsSettled,
    markIntentFailed,
    markSettled,
    unlockBudget,
    type PaymentIntent,
} from "../session-budget.js";
import { settleComposeKeyPayment } from "../settlement.js";
import { syncBudgetAfterSettlement } from "../../keys/index.js";
import type { BatchSettlementResult, BatchRunSummary, BatchConfig, DEFAULT_BATCH_CONFIG } from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

/** $1 threshold for immediate settlement (USDC with 6 decimals) */
const IMMEDIATE_THRESHOLD_WEI = 1000000n;

// =============================================================================
// Batch Settlement Worker
// =============================================================================

/**
 * Run a complete batch settlement cycle
 * 
 * Called by:
 * - CloudWatch Events (scheduled every 2 minutes)
 * - Immediate trigger when $1 threshold reached
 */
export async function runBatchSettlement(
    config: Partial<BatchConfig> = {},
): Promise<BatchRunSummary> {
    const runId = `batch-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const startTime = Date.now();

    console.log(`[batch-settlement] Starting batch run ${runId}`);

    const results: BatchSettlementResult[] = [];
    let successCount = 0;
    let failCount = 0;
    let totalIntents = 0;
    let totalValueWei = 0n;

    try {
        // Get all pending intents grouped by user:chain
        const grouped = await getPendingIntentsGrouped();

        console.log(`[batch-settlement] Found ${grouped.size} user:chain groups with pending intents`);

        // Process each user:chain group
        for (const [key, intents] of grouped.entries()) {
            if (intents.length === 0) continue;

            const [userWallet, chainIdStr] = key.split(":");
            const chainId = parseInt(chainIdStr);

            totalIntents += intents.length;

            try {
                const result = await settleUserBatch(userWallet, chainId, intents);
                results.push(result);

                if (result.error) {
                    failCount++;
                } else {
                    successCount++;
                    totalValueWei += BigInt(result.totalSettledWei);
                }
            } catch (error) {
                console.error(`[batch-settlement] Failed to settle batch for ${key}:`, error);

                results.push({
                    userWallet,
                    chainId,
                    totalSettledWei: "0",
                    intentCount: intents.length,
                    txHash: "",
                    error: error instanceof Error ? error.message : String(error),
                });

                failCount++;
            }
        }

    } catch (error) {
        console.error(`[batch-settlement] Fatal error in batch run:`, error);
    }

    const endTime = Date.now();
    const totalUsers = results.length;

    console.log(`[batch-settlement] Completed batch run ${runId}:`, {
        duration: `${endTime - startTime}ms`,
        totalUsers,
        totalIntents,
        successCount,
        failCount,
        totalValueWei: totalValueWei.toString(),
    });

    return {
        runId,
        startTime,
        endTime,
        totalUsers,
        totalIntents,
        totalValueWei: totalValueWei.toString(),
        successCount,
        failCount,
        results,
    };
}

/**
 * Settle batch of intents for a single user on a single chain
 */
export async function settleUserBatch(
    userWallet: string,
    chainId: number,
    intents: PaymentIntent[],
): Promise<BatchSettlementResult> {
    console.log(`[batch-settlement] Settling ${intents.length} intents for ${userWallet} on chain ${chainId}`);

    // Calculate total amount to settle
    const totalAmount = intents.reduce(
        (sum, intent) => sum + BigInt(intent.amountWei),
        0n
    );

    const intentIds = intents.map((i) => i.id);

    console.log(`[batch-settlement] Total amount: ${totalAmount.toString()} wei`);

    try {
        // Execute single on-chain settlement for all intents
        const settlementResult = await settleComposeKeyPayment(
            userWallet,
            totalAmount.toString(),
            chainId,
        );

        if (!settlementResult.success) {
            console.error(`[batch-settlement] Settlement failed for ${userWallet}:`, settlementResult.error);

            // Fallback: Try to settle individually or requeue
            await handleSettlementFailure(userWallet, chainId, intents, settlementResult.error || "Unknown error");

            return {
                userWallet,
                chainId,
                totalSettledWei: "0",
                intentCount: intents.length,
                txHash: "",
                error: settlementResult.error,
            };
        }

        // Success - mark all intents as settled
        await markIntentsSettled(intentIds, settlementResult.txHash || "");

        // Update session budget: move from locked to used
        await markSettled(userWallet, chainId, totalAmount.toString());

        // Sync storage.ts for UI consistency - use session-budget.ts usedBudgetWei
        const { getSessionBudget } = await import("../session-budget.js");
        const budget = await getSessionBudget(userWallet, chainId);
        if (budget) {
            await syncBudgetAfterSettlement(userWallet, chainId, budget.usedBudgetWei);
            console.log(`[batch-settlement] Synced storage.ts budgetUsed to ${budget.usedBudgetWei} for ${userWallet}`);
        }

        console.log(`[batch-settlement] Successfully settled ${intents.length} intents for ${userWallet}, tx: ${settlementResult.txHash}`);

        return {
            userWallet,
            chainId,
            totalSettledWei: totalAmount.toString(),
            intentCount: intents.length,
            txHash: settlementResult.txHash || "",
        };

    } catch (error) {
        console.error(`[batch-settlement] Exception during settlement for ${userWallet}:`, error);

        await handleSettlementFailure(
            userWallet,
            chainId,
            intents,
            error instanceof Error ? error.message : String(error),
        );

        return {
            userWallet,
            chainId,
            totalSettledWei: "0",
            intentCount: intents.length,
            txHash: "",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Handle settlement failure - fallback strategies
 */
async function handleSettlementFailure(
    userWallet: string,
    chainId: number,
    intents: PaymentIntent[],
    errorMessage: string,
): Promise<void> {
    console.log(`[batch-settlement] Handling failure for ${userWallet}, ${intents.length} intents`);

    // Strategy: Mark all intents as failed and unlock budget
    // The user can retry or use a different payment method

    for (const intent of intents) {
        await markIntentFailed(intent.id, `Batch settlement failed: ${errorMessage}`);
    }

    // Unlock the budget so user can try again
    const totalAmount = intents.reduce(
        (sum, intent) => sum + BigInt(intent.amountWei),
        0n
    );

    await unlockBudget(userWallet, chainId, totalAmount.toString());

    console.log(`[batch-settlement] Unlocked ${totalAmount.toString()} wei for ${userWallet} after failure`);

    // TODO: In production, add to dead letter queue for manual review
    // TODO: Send alert to monitoring system
}

/**
 * Trigger immediate settlement for a single user (threshold reached)
 */
export async function triggerImmediateSettlement(
    userWallet: string,
    chainId: number,
): Promise<BatchSettlementResult | null> {
    console.log(`[batch-settlement] Triggering immediate settlement for ${userWallet} on chain ${chainId}`);

    // Get pending intents for this user
    const grouped = await getPendingIntentsGrouped();
    const key = `${userWallet.toLowerCase()}:${chainId}`;
    const intents = grouped.get(key);

    if (!intents || intents.length === 0) {
        console.log(`[batch-settlement] No pending intents for ${userWallet} on chain ${chainId}`);
        return null;
    }

    // Settle immediately
    return await settleUserBatch(userWallet, chainId, intents);
}
