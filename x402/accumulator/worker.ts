/**
 * Canonical Compose payment-intent worker.
 *
 * Every queued checkpoint is an independent payable obligation and
 * an independent settlement operation. The worker never aggregates amounts
 * across checkpoints, credentials, payers, assets, or networks.
 */

import {
    executeCanonicalPaymentIntent,
    getCanonicalPaymentIntent,
    listCanonicalPaymentIntentIds,
    listCanonicalPaymentProjectionIds,
    reconcileCanonicalPaymentIntentProjections,
    removeCanonicalPaymentIntentWorkId,
} from "../intents.js";
import { isEvmNetwork, type NetworkId } from "../configs/chains.js";
import { valkeySMembers } from "../keys/valkey.js";
import type { BatchRunSummary, BatchSettlementResult, BatchConfig } from "./types.js";

const MAX_INTENTS_PER_RUN = 100;
const INTENT_EXECUTION_TIMEOUT_MS = 25_000;

function pendingRetry(intent: Awaited<ReturnType<typeof getCanonicalPaymentIntent>>, now: number): boolean {
    return Boolean(intent?.nextAttemptAt && intent.nextAttemptAt > now);
}

async function withIntentExecutionTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    paymentIntentId: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`Settlement worker timed out after ${timeoutMs}ms on intent ${paymentIntentId}`));
                }, timeoutMs);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function runBatchSettlement(
    config: Partial<BatchConfig> = {},
): Promise<BatchRunSummary> {
    const runId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const startTime = Date.now();
    const requestedMax = config.maxIntentsPerRun && config.maxIntentsPerRun > 0
        ? Math.floor(config.maxIntentsPerRun)
        : MAX_INTENTS_PER_RUN;
    const maxIntents = Math.min(requestedMax, MAX_INTENTS_PER_RUN);
    const projectionLimit = Math.max(1, Math.floor(maxIntents / 4));
    const projectionIds = await listCanonicalPaymentProjectionIds(projectionLimit);
    for (const paymentIntentId of projectionIds) {
        await reconcileCanonicalPaymentIntentProjections(paymentIntentId).catch((error) => {
            console.error("[settlement-worker] projection retry failed", {
                paymentIntentId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    const remainingCapacity = Math.max(0, maxIntents - projectionIds.length);
    const boundedScanLimit = Math.min(MAX_INTENTS_PER_RUN * 4, remainingCapacity * 4);
    const candidateIds = await listCanonicalPaymentIntentIds(boundedScanLimit);
    const results: BatchSettlementResult[] = [];
    for (const paymentIntentId of candidateIds) {
        if (results.length >= remainingCapacity) break;
        const intent = await getCanonicalPaymentIntent(paymentIntentId);
        if (!intent) {
            await removeCanonicalPaymentIntentWorkId(paymentIntentId);
            continue;
        }
        if (intent.status !== "queued" && intent.status !== "submitted") {
            await removeCanonicalPaymentIntentWorkId(paymentIntentId);
            continue;
        }
        if (pendingRetry(intent, startTime)) continue;
        if (intent.executionClaimToken && (intent.executionClaimExpiresAt || 0) > Date.now()) continue;
        const execution = await executeCanonicalPaymentIntent(paymentIntentId, { waitForConfirmation: false });
        const current = await getCanonicalPaymentIntent(paymentIntentId);
        if (!current) continue;
        if (current.attemptCount === intent.attemptCount && current.status === intent.status) continue;
        const confirmed = Boolean(execution.ok && current?.status === "confirmed");
        results.push({
            paymentIntentId,
            userAddress: intent.userAddress,
            network: intent.network,
            asset: intent.asset,
            totalSettledWei: confirmed ? (current?.finalAmountWei || "0") : "0",
            intentCount: 1,
            txHash: current?.txHash || "",
            status: current?.status || "failed",
            ...(!confirmed && current?.lastError ? { error: current.lastError } : {}),
        });
    }

    const confirmed = results.filter((result) => result.status === "confirmed");
    const terminalFailures = results.filter((result) => result.status === "failed");
    return {
        runId,
        startTime,
        endTime: Date.now(),
        totalUsers: new Set(results.map((result) => `${result.network}:${result.userAddress}`)).size,
        totalIntents: results.length,
        totalValueWei: confirmed
            .reduce((total, result) => total + BigInt(result.totalSettledWei), 0n)
            .toString(),
        successCount: confirmed.length,
        failCount: terminalFailures.length,
        results,
    };
}

export async function triggerImmediateSettlement(
    userAddress: string,
    network: NetworkId,
): Promise<BatchSettlementResult | null> {
    const normalizedUserAddress = isEvmNetwork(network) ? userAddress.toLowerCase() : userAddress;
    const keyIds = (await valkeySMembers(`user-keys:${network}:${normalizedUserAddress}`)).sort();
    const intentIds = new Set<string>();
    for (const keyId of keyIds) {
        for (const paymentIntentId of await valkeySMembers(`key-payment-intents:${keyId}`)) {
            intentIds.add(paymentIntentId);
        }
    }
    const candidates: Array<NonNullable<Awaited<ReturnType<typeof getCanonicalPaymentIntent>>>> = [];
    for (const paymentIntentId of intentIds) {
        const intent = await getCanonicalPaymentIntent(paymentIntentId);
        if (!intent || (intent.status !== "queued" && intent.status !== "submitted")) continue;
        if (intent.userAddress !== normalizedUserAddress || intent.network !== network) continue;
        candidates.push(intent);
    }
    candidates.sort((left, right) => {
        const leftDue = left.nextAttemptAt || left.createdAt;
        const rightDue = right.nextAttemptAt || right.createdAt;
        return leftDue - rightDue || left.paymentIntentId.localeCompare(right.paymentIntentId);
    });
    for (const intent of candidates) {
        if (pendingRetry(intent, Date.now())) continue;
        if (intent.executionClaimToken && (intent.executionClaimExpiresAt || 0) > Date.now()) continue;
        await executeCanonicalPaymentIntent(intent.paymentIntentId, { waitForConfirmation: false });
        const current = await getCanonicalPaymentIntent(intent.paymentIntentId);
        if (!current) return null;
        if (current.attemptCount === intent.attemptCount && current.status === intent.status) continue;
        return {
            paymentIntentId: intent.paymentIntentId,
            userAddress: current.userAddress,
            network: current.network,
            asset: current.asset,
            totalSettledWei: current.status === "confirmed" ? (current.finalAmountWei || "0") : "0",
            intentCount: 1,
            txHash: current.txHash || "",
            status: current.status,
            ...(current.status !== "confirmed" && current.lastError ? { error: current.lastError } : {}),
        };
    }
    return null;
}
