/**
 * Batch Settlement Worker
 * 
 * Executes batch settlements for accumulated payment intents.
 * Triggered by CloudWatch Events (every 2 minutes) or $1 threshold.
 * 
 * SETTLEMENT FLOW:
 * 1. Read all pending intents from ValKey (grouped by user + network)
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
} from "../session/budget.js";
import { settleKeyPaymentForNetwork } from "../settlement.js";
import type { NetworkId } from "../configs/chains.js";
import { syncBudgetAfterSettlement } from "../keys/index.js";
import { markIntentEvidenceSettled } from "../evidence.js";
import { markIntentReceiptsSettled } from "../receipts.js";
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
        // Get all pending intents grouped by user:network
        const grouped = await getPendingIntentsGrouped();

        console.log(`[batch-settlement] Found ${grouped.size} network groups with pending intents`);

        // Process each user:network group
        for (const [network, byUser] of grouped.entries()) {
          for (const [userAddress, intents] of byUser.entries()) {
            if (intents.length === 0) continue;

            totalIntents += intents.length;

            try {
                const result = await settleUserBatch(userAddress, network, intents);
                results.push(result);

                if (result.error) {
                    failCount++;
                } else {
                    successCount++;
                    totalValueWei += BigInt(result.totalSettledWei);
                }
            } catch (error) {
                console.error(`[batch-settlement] Failed to settle batch for ${network}:${userAddress}:`, error);

                results.push({
                    userAddress,
                    network,
                    totalSettledWei: "0",
                    intentCount: intents.length,
                    txHash: "",
                    error: error instanceof Error ? error.message : String(error),
                });

                failCount++;
            }
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
 * Settle batch of intents for a single user on a single network
 */
export async function settleUserBatch(
    userAddress: string,
    network: NetworkId,
    intents: PaymentIntent[],
): Promise<BatchSettlementResult> {
    console.log(`[batch-settlement] Settling ${intents.length} intents for ${userAddress} on network ${network}`);

    // Calculate total amount to settle
    const totalAmount = intents.reduce(
        (sum, intent) => sum + BigInt(intent.amountWei),
        0n
    );

    const intentIds = intents.map((i) => i.id);

    console.log(`[batch-settlement] Total amount: ${totalAmount.toString()} wei`);

    try {
        // Execute single on-chain settlement for all intents
        const settlementResult = await settleKeyPaymentForNetwork(
            userAddress,
            totalAmount.toString(),
            network,
        );
        const settlementError = !settlementResult.success
            ? settlementResult.error || "Unknown error"
            : !settlementResult.txHash
                ? "Payment settlement did not return transaction hash"
                : null;

        if (settlementError) {
            console.error(`[batch-settlement] Settlement failed for ${userAddress}:`, settlementError);

            // Fallback: Try to settle individually or requeue
            await handleSettlementFailure(userAddress, network, intents, settlementError);

            return {
                userAddress,
                network,
                totalSettledWei: "0",
                intentCount: intents.length,
                txHash: "",
                error: settlementError,
            };
        }

        const txHash = settlementResult.txHash as string;

        // Success - mark all intents as settled
        await markIntentsSettled(intentIds, txHash);
        await Promise.all(intentIds.map((sessionBudgetIntentId) => Promise.all([
            markIntentEvidenceSettled({
                sessionBudgetIntentId,
                txHash,
                network,
            }),
            markIntentReceiptsSettled({
                sessionBudgetIntentId,
                txHash,
            }),
        ])));

        // Update session budget: move from locked to used
        await markSettled(userAddress, network, totalAmount.toString());

        // Sync storage.ts for UI consistency - use session-budget.ts usedBudgetWei
        const { getSessionBudget } = await import("../session/budget.js");
        const budget = await getSessionBudget(userAddress, network);
        if (budget) {
            await syncBudgetAfterSettlement(userAddress, network, budget.usedBudgetWei);
            console.log(`[batch-settlement] Synced storage.ts budgetUsed to ${budget.usedBudgetWei} for ${userAddress}`);
        }

        console.log(`[batch-settlement] Successfully settled ${intents.length} intents for ${userAddress}, tx: ${txHash}`);

        return {
            userAddress,
            network,
            totalSettledWei: totalAmount.toString(),
            intentCount: intents.length,
            txHash,
        };

    } catch (error) {
        console.error(`[batch-settlement] Exception during settlement for ${userAddress}:`, error);

        await handleSettlementFailure(
            userAddress,
            network,
            intents,
            error instanceof Error ? error.message : String(error),
        );

        return {
            userAddress,
            network,
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
    userAddress: string,
    network: NetworkId,
    intents: PaymentIntent[],
    errorMessage: string,
): Promise<void> {
    console.log(`[batch-settlement] Handling failure for ${userAddress}, ${intents.length} intents`);

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

    await unlockBudget(userAddress, network, totalAmount.toString());

    console.log(`[batch-settlement] Unlocked ${totalAmount.toString()} wei for ${userAddress} after failure`);

    console.error("[settlement-worker] batch failed after retries", errorMessage);
}

/**
 * Trigger immediate settlement for a single user (threshold reached)
 */
export async function triggerImmediateSettlement(
    userAddress: string,
    network: NetworkId,
): Promise<BatchSettlementResult | null> {
    console.log(`[batch-settlement] Triggering immediate settlement for ${userAddress} on network ${network}`);

    // Get pending intents for this user
    const grouped = await getPendingIntentsGrouped();
    const intents = grouped.get(network)?.get(userAddress);

    if (!intents || intents.length === 0) {
        console.log(`[batch-settlement] No pending intents for ${userAddress} on network ${network}`);
        return null;
    }

    // Settle immediately
    return await settleUserBatch(userAddress, network, intents);
}
