/**
 * Session Budget Management
 * 
 * Atomic Redis operations for session-based payment bypass.
 * Enables instant inference by tracking and locking budget off-chain,
 * with deferred on-chain settlement via batch worker.
 * 
 * ARCHITECTURE:
 * - User creates session with on-chain approval (USDC.approve to TREASURY_WALLET)
 * - Session budget is tracked in Redis for instant authorization
 * - Each request "locks" budget atomically in Redis
 * - Batch worker settles locked amounts on-chain every 2 minutes
 * 
 * @module shared/x402/sessionBudget
 */

import {
    redisGet,
    redisSet,
    redisHGetAll,
    redisHSet,
    redisHIncrBy,
    redisExpire,
    redisSAdd,
    redisSMembers,
    redisSRem,
    redisExists,
} from "./keys/redis.js";
import {
    getSpendableSessionBudgetWei,
    readSessionAllowanceWei,
} from "./session-allowance.js";

// =============================================================================
// Configuration
// =============================================================================

/** Maximum lock duration before auto-release (5 minutes) */
const LOCK_TTL_SECONDS = 300;

/** Session budget key prefix */
const SESSION_KEY_PREFIX = "session:budget:";

/** Pending intents set key */
const PENDING_INTENTS_KEY = "intents:pending";

/** Intent hash key prefix */
const INTENT_KEY_PREFIX = "intent:";

// =============================================================================
// Types
// =============================================================================

export interface SessionBudget {
    userAddress: string;
    chainId: number;
    totalBudgetWei: string;      // Original session budget
    lockedBudgetWei: string;     // Amount locked for pending intents
    usedBudgetWei: string;       // Amount already settled on-chain
    expiresAt: number;           // Session expiry timestamp (Unix ms)
    createdAt: number;           // Session creation timestamp
}

export interface PaymentIntent {
    id: string;
    userAddress: string;
    merchantWallet: string;
    amountWei: string;
    chainId: number;
    model?: string;
    requestId: string;
    createdAt: number;
    status: "locked" | "pending_settlement" | "settled" | "failed";
    txHash?: string;
    settledAt?: number;
    error?: string;
}

export interface LockResult {
    success: boolean;
    availableWei: string;
    lockedWei: string;
    intentId?: string;
    error?: string;
}

export interface BudgetInfo {
    totalWei: string;
    lockedWei: string;
    usedWei: string;
    availableWei: string;
    pendingIntents: number;
}

// =============================================================================
// Key Helpers
// =============================================================================

function getSessionKey(address: string, chainId: number): string {
    return `${SESSION_KEY_PREFIX}${address.toLowerCase()}:${chainId}`;
}

function getIntentKey(intentId: string): string {
    return `${INTENT_KEY_PREFIX}${intentId}`;
}

function getUserIntentsKey(address: string): string {
    return `${SESSION_KEY_PREFIX}${address.toLowerCase()}:intents`;
}

async function getLiveBudgetAvailability(input: {
    userAddress: string;
    chainId: number;
    totalWei: bigint;
    lockedWei: bigint;
    usedWei: bigint;
}): Promise<{
    allowanceWei: bigint;
    availableWei: bigint;
}> {
    const allowanceWei = await readSessionAllowanceWei(input.userAddress, input.chainId);
    const availableWei = getSpendableSessionBudgetWei({
        budgetLimitWei: input.totalWei,
        usedWei: input.usedWei,
        lockedWei: input.lockedWei,
        allowanceWei,
    });

    return {
        allowanceWei,
        availableWei,
    };
}

// =============================================================================
// Session Budget Operations
// =============================================================================

/**
 * Initialize or update session budget from on-chain session creation
 * Called when user creates an allowance-backed session on-chain
 */
export async function initializeSessionBudget(
    userAddress: string,
    chainId: number,
    totalBudgetWei: string,
    expiresAt: number,
): Promise<void> {
    const key = getSessionKey(userAddress, chainId);

    const budget: SessionBudget = {
        userAddress: userAddress.toLowerCase(),
        chainId,
        totalBudgetWei,
        lockedBudgetWei: "0",
        usedBudgetWei: "0",
        expiresAt,
        createdAt: Date.now(),
    };

    // Store as hash for efficient field access
    await redisHSet(key, {
        userAddress: budget.userAddress,
        chainId: String(budget.chainId),
        totalBudgetWei: budget.totalBudgetWei,
        lockedBudgetWei: budget.lockedBudgetWei,
        usedBudgetWei: budget.usedBudgetWei,
        expiresAt: String(budget.expiresAt),
        createdAt: String(budget.createdAt),
    });

    // Set TTL based on session expiry
    const ttlSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    await redisExpire(key, ttlSeconds);

    console.log(`[sessionBudget] Initialized budget for ${userAddress} chain ${chainId}: ${totalBudgetWei} wei, expires in ${ttlSeconds}s`);
}

/**
 * Get current session budget state
 */
export async function getSessionBudget(
    userAddress: string,
    chainId: number,
): Promise<SessionBudget | null> {
    const key = getSessionKey(userAddress, chainId);
    const data = await redisHGetAll(key);

    if (!data || Object.keys(data).length === 0) {
        return null;
    }

    // Check if expired
    const expiresAt = parseInt(data.expiresAt);
    if (Date.now() > expiresAt) {
        console.log(`[sessionBudget] Session expired for ${userAddress} chain ${chainId}`);
        return null;
    }

    return {
        userAddress: data.userAddress,
        chainId: parseInt(data.chainId),
        totalBudgetWei: data.totalBudgetWei,
        lockedBudgetWei: data.lockedBudgetWei,
        usedBudgetWei: data.usedBudgetWei,
        expiresAt: parseInt(data.expiresAt),
        createdAt: parseInt(data.createdAt),
    };
}

/**
 * Get session status with notification flags
 * Returns status info for frontend notifications
 */
export interface SessionStatus {
    isActive: boolean;
    isExpired: boolean;
    expiresAt: number;
    expiresInSeconds: number;
    totalBudget: string;
    availableBudget: string;
    lockedBudget: string;
    usedBudget: string;
    budgetPercentRemaining: number;
    warnings: {
        budgetLow: boolean;      // < 20% remaining
        budgetDepleted: boolean;  // < 1 request worth
        expiringSoon: boolean;   // < 5 minutes
        expired: boolean;
    };
}

export async function getSessionStatus(
    userAddress: string,
    chainId: number,
    requestCostWei?: string,
): Promise<SessionStatus | null> {
    const budget = await getSessionBudget(userAddress, chainId);

    if (!budget) {
        return null;
    }

    const now = Date.now();
    const total = BigInt(budget.totalBudgetWei);
    const locked = BigInt(budget.lockedBudgetWei);
    const used = BigInt(budget.usedBudgetWei);
    const { availableWei } = await getLiveBudgetAvailability({
        userAddress,
        chainId,
        totalWei: total,
        lockedWei: locked,
        usedWei: used,
    });
    const requestCost = requestCostWei ? BigInt(requestCostWei) : 0n;

    const expiresInMs = budget.expiresAt - now;
    const expiresInSeconds = Math.max(0, Math.floor(expiresInMs / 1000));
    const isExpired = now > budget.expiresAt;

    const totalNum = Number(total);
    const availableNum = Number(availableWei);
    const budgetPercentRemaining = totalNum > 0 ? (availableNum / totalNum) * 100 : 0;

    return {
        isActive: !isExpired && availableWei > 0n,
        isExpired,
        expiresAt: budget.expiresAt,
        expiresInSeconds,
        totalBudget: budget.totalBudgetWei,
        availableBudget: availableWei.toString(),
        lockedBudget: budget.lockedBudgetWei,
        usedBudget: budget.usedBudgetWei,
        budgetPercentRemaining,
        warnings: {
            budgetLow: budgetPercentRemaining < 20,
            budgetDepleted: requestCost > 0n ? availableWei < requestCost : availableWei <= 0n,
            expiringSoon: expiresInSeconds < 300 && !isExpired, // < 5 minutes
            expired: isExpired,
        },
    };
}

/**
 * Get available budget (total - locked - used)
 */
export async function getAvailableBudget(
    userAddress: string,
    chainId: number,
): Promise<bigint> {
    const budget = await getSessionBudget(userAddress, chainId);

    if (!budget) {
        return 0n;
    }

    const total = BigInt(budget.totalBudgetWei);
    const locked = BigInt(budget.lockedBudgetWei);
    const used = BigInt(budget.usedBudgetWei);
    const { availableWei } = await getLiveBudgetAvailability({
        userAddress,
        chainId,
        totalWei: total,
        lockedWei: locked,
        usedWei: used,
    });

    return availableWei;
}

/**
 * Validate if sufficient budget is available for a request
 */
export async function validateBudgetSufficient(
    userAddress: string,
    chainId: number,
    requiredWei: string,
): Promise<boolean> {
    const available = await getAvailableBudget(userAddress, chainId);
    return available >= BigInt(requiredWei);
}

/**
 * Lock budget for a new request (atomic operation)
 * Returns remaining available budget after lock
 * 
 * This is the core function for instant authorization:
 * 1. Atomically increment lockedBudgetWei
 * 2. Store payment intent for batch settlement
 * 3. Return success if budget was available
 */
export async function lockBudget(
    userAddress: string,
    chainId: number,
    amountWei: string,
    merchantWallet: string,
    requestId: string,
    model?: string,
): Promise<LockResult> {
    const key = getSessionKey(userAddress, chainId);

    // First, check if session exists and has budget
    const budget = await getSessionBudget(userAddress, chainId);

    if (!budget) {
        return {
            success: false,
            availableWei: "0",
            lockedWei: "0",
            error: "No active session found",
        };
    }

    const total = BigInt(budget.totalBudgetWei);
    const currentLocked = BigInt(budget.lockedBudgetWei);
    const used = BigInt(budget.usedBudgetWei);
    const requestAmount = BigInt(amountWei);
    const { allowanceWei, availableWei } = await getLiveBudgetAvailability({
        userAddress,
        chainId,
        totalWei: total,
        lockedWei: currentLocked,
        usedWei: used,
    });

    // Check if sufficient budget available
    if (availableWei < requestAmount) {
        return {
            success: false,
            availableWei: availableWei.toString(),
            lockedWei: currentLocked.toString(),
            error: `Insufficient spendable session budget: need ${amountWei}, have ${availableWei.toString()}`,
        };
    }

    // Atomically increment locked amount
    // HINCRBY is atomic in Redis
    const newLockedStr = await redisHIncrBy(key, "lockedBudgetWei", Number(requestAmount));
    const newLocked = BigInt(newLockedStr);

    // Double-check we didn't over-allocate (race condition protection)
    if (newLocked + used > total || newLocked > allowanceWei) {
        // Rollback the increment
        await redisHIncrBy(key, "lockedBudgetWei", -Number(requestAmount));
        return {
            success: false,
            availableWei: availableWei.toString(),
            lockedWei: currentLocked.toString(),
            error: "Race condition: budget exhausted",
        };
    }

    // Create and store payment intent
    const intentId = `${userAddress.toLowerCase()}-${requestId}-${Date.now()}`;
    const intent: PaymentIntent = {
        id: intentId,
        userAddress: userAddress.toLowerCase(),
        merchantWallet,
        amountWei,
        chainId,
        model,
        requestId,
        createdAt: Date.now(),
        status: "locked",
    };

    // Store intent
    await storePaymentIntent(intent);

    const newAvailable = getSpendableSessionBudgetWei({
        budgetLimitWei: total,
        usedWei: used,
        lockedWei: newLocked,
        allowanceWei,
    });

    console.log(`[sessionBudget] Locked ${amountWei} wei for ${userAddress} chain ${chainId}, available: ${newAvailable.toString()}`);

    return {
        success: true,
        availableWei: newAvailable.toString(),
        lockedWei: newLocked.toString(),
        intentId,
    };
}

/**
 * Release locked budget (for failed requests)
 * Called when inference fails after budget was locked
 */
export async function unlockBudget(
    userAddress: string,
    chainId: number,
    amountWei: string,
    intentId?: string,
): Promise<void> {
    const key = getSessionKey(userAddress, chainId);

    // Atomically decrement locked amount
    await redisHIncrBy(key, "lockedBudgetWei", -Number(BigInt(amountWei)));

    // Mark intent as failed if provided
    if (intentId) {
        await markIntentFailed(intentId, "Request failed - budget released");
    }

    console.log(`[session-budget] Unlocked ${amountWei} wei for ${userAddress} chain ${chainId}`);
}

/**
 * Deterministically cancel a locked intent and release its budget.
 * Safe to call multiple times; only locked intents are released.
 */
export async function cancelBudgetIntent(
    intentId: string,
    error: string = "Request failed before settlement",
): Promise<void> {
    const intent = await getPaymentIntent(intentId);
    if (!intent) {
        return;
    }

    if (intent.status !== "locked") {
        return;
    }

    await unlockBudget(intent.userAddress, intent.chainId, intent.amountWei);
    await markIntentFailed(intentId, error);
}

/**
 * Mark locked budget as settled (after batch settlement)
 * Moves amount from locked to used
 */
export async function markSettled(
    userAddress: string,
    chainId: number,
    amountWei: string,
): Promise<void> {
    const key = getSessionKey(userAddress, chainId);
    const amount = Number(BigInt(amountWei));

    // Atomically: decrement locked, increment used
    await redisHIncrBy(key, "lockedBudgetWei", -amount);
    await redisHIncrBy(key, "usedBudgetWei", amount);

    console.log(`[session-budget] Marked ${amountWei} wei as settled for ${userAddress} chain ${chainId}`);
}

/**
 * Get comprehensive budget info for a user
 */
export async function getBudgetInfo(
    userAddress: string,
    chainId: number,
): Promise<BudgetInfo | null> {
    const budget = await getSessionBudget(userAddress, chainId);

    if (!budget) {
        return null;
    }

    const total = BigInt(budget.totalBudgetWei);
    const locked = BigInt(budget.lockedBudgetWei);
    const used = BigInt(budget.usedBudgetWei);
    const { availableWei } = await getLiveBudgetAvailability({
        userAddress,
        chainId,
        totalWei: total,
        lockedWei: locked,
        usedWei: used,
    });

    // Get pending intent count
    const intentIds = await redisSMembers(getUserIntentsKey(userAddress));
    const intents = await Promise.all(intentIds.map((id) => getPaymentIntent(id)));
    const pendingCount = intents.filter((intent) => intent && intent.status === "locked").length;

    return {
        totalWei: total.toString(),
        lockedWei: locked.toString(),
        usedWei: used.toString(),
        availableWei: availableWei.toString(),
        pendingIntents: pendingCount,
    };
}

// =============================================================================
// Payment Intent Operations
// =============================================================================

/**
 * Store a payment intent for batch settlement
 */
export async function storePaymentIntent(intent: PaymentIntent): Promise<void> {
    const intentKey = getIntentKey(intent.id);

    // Store intent data
    await redisHSet(intentKey, {
        id: intent.id,
        userAddress: intent.userAddress,
        merchantWallet: intent.merchantWallet,
        amountWei: intent.amountWei,
        chainId: String(intent.chainId),
        model: intent.model || "",
        requestId: intent.requestId,
        createdAt: String(intent.createdAt),
        status: intent.status,
        txHash: intent.txHash || "",
        settledAt: intent.settledAt ? String(intent.settledAt) : "",
        error: intent.error || "",
    });

    // Set TTL (24 hours for intents)
    await redisExpire(intentKey, 86400);

    // Add to pending set for batch worker
    await redisSAdd(PENDING_INTENTS_KEY, intent.id);

    // Add to user's intent set
    await redisSAdd(getUserIntentsKey(intent.userAddress), intent.id);

    console.log(`[sessionBudget] Stored intent ${intent.id} for ${intent.userAddress}`);
}

/**
 * Get a payment intent by ID
 */
export async function getPaymentIntent(intentId: string): Promise<PaymentIntent | null> {
    const data = await redisHGetAll(getIntentKey(intentId));

    if (!data || Object.keys(data).length === 0) {
        return null;
    }

    return {
        id: data.id,
        userAddress: data.userAddress,
        merchantWallet: data.merchantWallet,
        amountWei: data.amountWei,
        chainId: parseInt(data.chainId),
        model: data.model || undefined,
        requestId: data.requestId,
        createdAt: parseInt(data.createdAt),
        status: data.status as PaymentIntent["status"],
        txHash: data.txHash || undefined,
        settledAt: data.settledAt ? parseInt(data.settledAt) : undefined,
        error: data.error || undefined,
    };
}

/**
 * Get all pending intents (for batch worker)
 */
export async function getPendingIntents(): Promise<PaymentIntent[]> {
    const intentIds = await redisSMembers(PENDING_INTENTS_KEY);
    const intents = await Promise.all(intentIds.map((id) => getPaymentIntent(id)));
    return intents.filter((intent): intent is PaymentIntent => Boolean(intent && intent.status === "locked"));
}

/**
 * Get pending intents grouped by user and chain
 */
export async function getPendingIntentsGrouped(): Promise<Map<string, PaymentIntent[]>> {
    const intents = await getPendingIntents();
    const grouped = new Map<string, PaymentIntent[]>();

    for (const intent of intents) {
        const key = `${intent.userAddress}:${intent.chainId}`;
        const existing = grouped.get(key) || [];
        existing.push(intent);
        grouped.set(key, existing);
    }

    return grouped;
}

/**
 * Get total pending amount for a user on a chain
 */
export async function getPendingTotal(userAddress: string, chainId: number): Promise<bigint> {
    const intentIds = await redisSMembers(getUserIntentsKey(userAddress));
    const intents = await Promise.all(intentIds.map((id) => getPaymentIntent(id)));
    return intents.reduce((total, intent) => {
        if (!intent || intent.status !== "locked" || intent.chainId !== chainId) {
            return total;
        }

        return total + BigInt(intent.amountWei);
    }, 0n);
}

/**
 * Mark intents as settled (after successful batch settlement)
 */
export async function markIntentsSettled(intentIds: string[], txHash: string): Promise<void> {
    const now = Date.now();

    for (const id of intentIds) {
        const intentKey = getIntentKey(id);
        const intent = await getPaymentIntent(id);

        // Update intent status
        await redisHSet(intentKey, {
            status: "settled",
            txHash,
            settledAt: String(now),
        });

        // Remove from pending set
        await redisSRem(PENDING_INTENTS_KEY, id);

        // Remove from user's pending set
        if (intent) {
            await redisSRem(getUserIntentsKey(intent.userAddress), id);
        }
    }

    console.log(`[sessionBudget] Marked ${intentIds.length} intents as settled, tx: ${txHash}`);
}

/**
 * Mark intent as failed
 */
export async function markIntentFailed(intentId: string, error: string): Promise<void> {
    const intentKey = getIntentKey(intentId);
    const intent = await getPaymentIntent(intentId);

    await redisHSet(intentKey, {
        status: "failed",
        error,
    });

    // Failed intents should not remain pending.
    await redisSRem(PENDING_INTENTS_KEY, intentId);
    if (intent) {
        await redisSRem(getUserIntentsKey(intent.userAddress), intentId);
    }

    console.log(`[sessionBudget] Marked intent ${intentId} as failed: ${error}`);
}

// =============================================================================
// Threshold Checking
// =============================================================================

/** $1 in USDC wei (6 decimals) */
const IMMEDIATE_SETTLEMENT_THRESHOLD = 1000000n;

/**
 * Check if pending amount exceeds threshold for immediate settlement
 */
export async function shouldTriggerImmediateSettlement(
    userAddress: string,
    chainId: number,
): Promise<boolean> {
    const pending = await getPendingTotal(userAddress, chainId);
    return pending >= IMMEDIATE_SETTLEMENT_THRESHOLD;
}

/**
 * Get threshold status for a user
 */
export async function getThresholdStatus(
    userAddress: string,
    chainId: number,
): Promise<{ pendingWei: string; thresholdWei: string; shouldSettle: boolean }> {
    const pending = await getPendingTotal(userAddress, chainId);

    return {
        pendingWei: pending.toString(),
        thresholdWei: IMMEDIATE_SETTLEMENT_THRESHOLD.toString(),
        shouldSettle: pending >= IMMEDIATE_SETTLEMENT_THRESHOLD,
    };
}
