/**
 * Compose Keys - Storage Operations
 * 
 * Redis-backed storage for Compose Key records.
 * Handles key creation, lookup, usage tracking, and revocation.
 * 
 * @module shared/keys/storage
 */

import { randomUUID } from "crypto";
import {
    redisHGetAll,
    redisHGet,
    redisHSet,
    redisSAdd,
    redisSMembers,
    redisExists,
    redisHIncrBy,
    redisExpire,
    redisSet,
    redisGet,
    redisSRem,
} from "./redis.js";
import { signComposeKey } from "./jwt.js";
import { getSessionBudget } from "../session-budget.js";
import type {
    ComposeKeyRecord,
    ComposeKeyPurpose,
    CreateKeyRequest,
    CreateKeyResponse,
    ActiveSessionStatus,
    SessionInactiveReason,
} from "./types.js";

// =============================================================================
// Redis Key Patterns
// =============================================================================

const KEY_PREFIX = "compose-key:";
const USER_KEYS_PREFIX = "user-keys:";
const REVOKED_PREFIX = "compose-key:revoked:";

function keyRecordKey(keyId: string): string {
    return `${KEY_PREFIX}${keyId}`;
}

function userKeysKey(userAddress: string): string {
    return `${USER_KEYS_PREFIX}${userAddress.toLowerCase()}`;
}

function revokedKey(keyId: string): string {
    return `${REVOKED_PREFIX}${keyId}`;
}

function parseComposeKeyPurpose(value: string | undefined): ComposeKeyPurpose | null {
    if (value === "session" || value === "api") {
        return value;
    }

    return null;
}

export function getBudgetRemaining(record: Pick<ComposeKeyRecord, "budgetLimit" | "budgetUsed" | "budgetReserved">): number {
    return Math.max(0, record.budgetLimit - record.budgetUsed - (record.budgetReserved || 0));
}

export interface ActiveSessionCandidate {
    keyId: string;
    purpose: ComposeKeyPurpose;
    token?: string;
    budgetLimit: number;
    budgetUsed: number;
    budgetLocked: number;
    budgetRemaining: number;
    expiresAt: number;
    createdAt: number;
    chainId?: number;
    name?: string;
    revokedAt?: number;
    missingBudgetState?: boolean;
}

function parseStoredInteger(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function latestKeySnapshot(candidate: ActiveSessionCandidate): NonNullable<ActiveSessionStatus["latestKey"]> {
    return {
        keyId: candidate.keyId,
        budgetLimit: candidate.budgetLimit,
        budgetUsed: candidate.budgetUsed,
        budgetLocked: candidate.budgetLocked,
        budgetRemaining: candidate.budgetRemaining,
        expiresAt: candidate.expiresAt,
        chainId: candidate.chainId,
        name: candidate.name,
        revokedAt: candidate.revokedAt,
    };
}

function getInactiveReason(candidate: ActiveSessionCandidate, now: number): SessionInactiveReason | null {
    if (candidate.missingBudgetState) {
        return "missing_budget_state";
    }

    if (candidate.revokedAt) {
        return "revoked";
    }

    if (candidate.expiresAt <= now) {
        return "expired";
    }

    if (candidate.budgetRemaining <= 0 && candidate.budgetLocked <= 0) {
        return "budget_exhausted";
    }

    if (!candidate.token) {
        return "budget_exhausted";
    }

    return null;
}

function buildActiveSessionCandidate(
    keyId: string,
    data: Record<string, string>,
): ActiveSessionCandidate | null {
    const purpose = parseComposeKeyPurpose(data.purpose);
    const budgetLimit = parseStoredInteger(data.budgetLimit);
    const budgetUsed = parseStoredInteger(data.budgetUsed);
    const budgetLocked = parseStoredInteger(data.budgetReserved) ?? 0;
    const expiresAt = parseStoredInteger(data.expiresAt);

    if (!purpose || budgetLimit === null || budgetUsed === null || expiresAt === null) {
        return null;
    }

    return {
        keyId,
        purpose,
        token: data.token || undefined,
        budgetLimit,
        budgetUsed,
        budgetLocked,
        budgetRemaining: getBudgetRemaining({
            budgetLimit,
            budgetUsed,
            budgetReserved: budgetLocked,
        }),
        expiresAt,
        createdAt: parseStoredInteger(data.createdAt) ?? 0,
        chainId: parseStoredInteger(data.chainId) ?? undefined,
        name: data.name || undefined,
        revokedAt: parseStoredInteger(data.revokedAt) ?? undefined,
    };
}

function applySessionBudgetState(
    candidate: ActiveSessionCandidate,
    budget: Awaited<ReturnType<typeof getSessionBudget>> | undefined,
): ActiveSessionCandidate {
    if (!budget) {
        return {
            ...candidate,
            missingBudgetState: true,
            budgetLocked: 0,
            budgetRemaining: 0,
        };
    }

    const budgetLimit = parseStoredInteger(budget.totalBudgetWei);
    const budgetUsed = parseStoredInteger(budget.usedBudgetWei);
    const budgetLocked = parseStoredInteger(budget.lockedBudgetWei);

    if (budgetLimit === null || budgetUsed === null || budgetLocked === null) {
        return {
            ...candidate,
            missingBudgetState: true,
            budgetLocked: 0,
            budgetRemaining: 0,
        };
    }

    return {
        ...candidate,
        budgetLimit,
        budgetUsed,
        budgetLocked,
        budgetRemaining: Math.max(0, budgetLimit - budgetUsed - budgetLocked),
        expiresAt: budget.expiresAt,
    };
}

export function selectActiveSessionStatus(
    candidates: ActiveSessionCandidate[],
    chainId?: number,
    now: number = Date.now(),
): ActiveSessionStatus {
    if (candidates.length === 0) {
        return { session: null, reason: "none" };
    }

    const sessionCandidates = candidates
        .filter((candidate) => candidate.purpose === "session")
        .sort((a, b) => b.createdAt - a.createdAt);

    if (sessionCandidates.length === 0) {
        return { session: null, reason: "none" };
    }

    let sawChainMismatch = false;
    let firstInvalid: { reason: SessionInactiveReason; key: ActiveSessionCandidate } | null = null;

    for (const candidate of sessionCandidates) {
        const chainMismatch = Boolean(chainId && candidate.chainId && candidate.chainId !== chainId);
        if (chainMismatch) {
            sawChainMismatch = true;
            continue;
        }

        const inactiveReason = getInactiveReason(candidate, now);
        if (!inactiveReason) {
            return {
                session: {
                    keyId: candidate.keyId,
                    token: candidate.token!,
                    budgetLimit: candidate.budgetLimit,
                    budgetUsed: candidate.budgetUsed,
                    budgetLocked: candidate.budgetLocked,
                    budgetRemaining: candidate.budgetRemaining,
                    expiresAt: candidate.expiresAt,
                    chainId: candidate.chainId,
                    name: candidate.name,
                },
                reason: "none",
                latestKey: latestKeySnapshot(candidate),
            };
        }

        if (!firstInvalid) {
            firstInvalid = {
                reason: inactiveReason,
                key: candidate,
            };
        }
    }

    if (firstInvalid) {
        return {
            session: null,
            reason: firstInvalid.reason,
            latestKey: latestKeySnapshot(firstInvalid.key),
        };
    }

    if (sawChainMismatch) {
        return {
            session: null,
            reason: "chain_mismatch",
            latestKey: latestKeySnapshot(sessionCandidates[0]),
        };
    }

    return { session: null, reason: "none" };
}

// =============================================================================
// Key Operations
// =============================================================================

/**
 * Create a new Compose Key
 * 
 * @param userAddress - User's wallet address
 * @param request - Key creation parameters
 * @returns Created key with token
 */
export async function createComposeKey(
    userAddress: string,
    request: CreateKeyRequest
): Promise<CreateKeyResponse> {
    const keyId = randomUUID();
    const now = Date.now();
    const normalizedAddress = userAddress.toLowerCase();

    const record: ComposeKeyRecord = {
        keyId,
        userAddress: normalizedAddress,
        purpose: request.purpose,
        budgetLimit: request.budgetLimit,
        budgetUsed: 0,
        budgetReserved: 0,
        createdAt: now,
        expiresAt: request.expiresAt,
        name: request.name,
        chainId: request.chainId,
    };

    // Generate token
    const token = signComposeKey({
        sub: normalizedAddress,
        keyId,
        budgetLimit: request.budgetLimit,
        budgetUsed: 0,
        exp: Math.floor(request.expiresAt / 1000), // Convert to seconds
    });

    const recordKey = keyRecordKey(keyId);
    await redisHSet(recordKey, {
        keyId: record.keyId,
        userAddress: record.userAddress,
        purpose: record.purpose,
        budgetLimit: String(record.budgetLimit),
        budgetUsed: String(record.budgetUsed),
        budgetReserved: String(record.budgetReserved || 0),
        createdAt: String(record.createdAt),
        expiresAt: String(record.expiresAt),
        ...(record.name ? { name: record.name } : {}),
        ...(record.chainId ? { chainId: String(record.chainId) } : {}),
        token,
    });

    // Set TTL based on expiration
    const ttlSeconds = Math.ceil((request.expiresAt - now) / 1000);
    if (ttlSeconds > 0) {
        await redisExpire(recordKey, ttlSeconds);
    }

    // Add to user's key set
    await redisSAdd(userKeysKey(normalizedAddress), keyId);

    return {
        keyId,
        token,
        purpose: request.purpose,
        budgetLimit: request.budgetLimit,
        expiresAt: request.expiresAt,
        name: request.name,
    };
}

/**
 * Get a key record by ID
 */
export async function getKeyRecord(keyId: string): Promise<ComposeKeyRecord | null> {
    const data = await redisHGetAll(keyRecordKey(keyId));

    if (!data || Object.keys(data).length === 0) {
        return null;
    }

    const purpose = parseComposeKeyPurpose(data.purpose);
    if (!purpose) {
        return null;
    }

    return {
        keyId: data.keyId,
        userAddress: data.userAddress,
        purpose,
        budgetLimit: parseInt(data.budgetLimit, 10),
        budgetUsed: parseInt(data.budgetUsed, 10),
        budgetReserved: data.budgetReserved ? parseInt(data.budgetReserved, 10) : 0,
        createdAt: parseInt(data.createdAt, 10),
        expiresAt: parseInt(data.expiresAt, 10),
        revokedAt: data.revokedAt ? parseInt(data.revokedAt, 10) : undefined,
        name: data.name || undefined,
        lastUsedAt: data.lastUsedAt ? parseInt(data.lastUsedAt, 10) : undefined,
        chainId: data.chainId ? parseInt(data.chainId, 10) : undefined,
    };
}

/**
 * List all keys for a user
 */
export async function listUserKeys(userAddress: string): Promise<ComposeKeyRecord[]> {
    const normalizedAddress = userAddress.toLowerCase();
    const keyIds = await redisSMembers(userKeysKey(normalizedAddress));
    const records = (await Promise.all(keyIds.map((keyId) => getKeyRecord(keyId))))
        .filter((record): record is ComposeKeyRecord => record !== null);

    // Sort by creation date, newest first
    records.sort((a, b) => b.createdAt - a.createdAt);

    return records;
}

/**
 * Record usage against a key's budget
 * 
 * @param keyId - Key ID
 * @param amountWei - Amount to deduct in USDC wei
 * @returns New budget used, or -1 if budget exceeded
 */
export async function recordKeyUsage(keyId: string, amountWei: number): Promise<number> {
    const recordKey = keyRecordKey(keyId);

    // Get current values
    const record = await getKeyRecord(keyId);
    if (!record) {
        return -1;
    }

    // Check if budget would be exceeded
    const newUsed = record.budgetUsed + amountWei;
    if (newUsed > record.budgetLimit) {
        return -1;
    }

    // Atomically increment usage
    const updatedUsed = await redisHIncrBy(recordKey, "budgetUsed", amountWei);

    // Update last used timestamp
    await redisHSet(recordKey, "lastUsedAt", String(Date.now()));

    return updatedUsed;
}

/**
 * Sync budget from batch settlement
 * Called by batch worker after on-chain settlement completes
 * Updates storage.ts budgetUsed to match settled amount
 * 
 * @param userAddress - User wallet address
 * @param chainId - Chain ID
 * @param totalUsedWei - Total USDC wei settled on-chain
 */
export async function syncBudgetAfterSettlement(
    userAddress: string,
    chainId: number,
    totalUsedWei: string,
): Promise<void> {
    const addr = userAddress.toLowerCase();
    const keyIds = await redisSMembers(userKeysKey(addr));

    for (const keyId of keyIds) {
        const record = await getKeyRecord(keyId);
        if (record && record.chainId === chainId) {
            const recordKey = keyRecordKey(keyId);
            await redisHSet(recordKey, "budgetUsed", totalUsedWei);
            return;
        }
    }
}

/**
 * Check if a key is revoked
 */
export async function isKeyRevoked(keyId: string): Promise<boolean> {
    return redisExists(revokedKey(keyId));
}

/**
 * Revoke a key
 * 
 * @param keyId - Key ID
 * @param userAddress - Must match key owner
 * @returns true if revoked, false if not found or unauthorized
 */
export async function revokeKey(keyId: string, userAddress: string): Promise<boolean> {
    const record = await getKeyRecord(keyId);

    if (!record) {
        return false;
    }

    if (record.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
        return false;
    }

    // Mark as revoked in hash
    await redisHSet(keyRecordKey(keyId), "revokedAt", String(Date.now()));

    // Also set a revoked marker (for fast lookup without fetching full record)
    // TTL matches key expiration
    const ttlSeconds = Math.ceil((record.expiresAt - Date.now()) / 1000);
    if (ttlSeconds > 0) {
        await redisSet(revokedKey(keyId), "1", ttlSeconds);
    }

    return true;
}

/**
 * Get remaining budget for a key
 */
export async function getKeyBudgetRemaining(keyId: string): Promise<number> {
    const record = await getKeyRecord(keyId);
    if (!record) return 0;
    return getBudgetRemaining(record);
}

export async function getKeyReservedBudget(keyId: string): Promise<number> {
    const value = await redisHGet(keyRecordKey(keyId), "budgetReserved");
    if (!value) {
        return 0;
    }

    return parseInt(value, 10);
}

/**
 * Get active session for a user (most recent non-expired, non-revoked key with budget)
 * Returns the key WITH token for session restoration
 * 
 * @param userAddress - User's wallet address
 * @param chainId - Optional chain ID filter
 * @returns Active session with token, or null if none found
 */
export async function getActiveSessionStatus(
    userAddress: string,
    chainId?: number,
): Promise<ActiveSessionStatus> {
    const normalizedAddress = userAddress.toLowerCase();
    const keyIds = await redisSMembers(userKeysKey(normalizedAddress));
    const userKeyIndex = userKeysKey(normalizedAddress);
    const loadedRecords = await Promise.all(
        keyIds.map(async (keyId) => [keyId, await redisHGetAll(keyRecordKey(keyId))] as const),
    );

    const staleKeyIds = loadedRecords
        .filter(([, data]) => !data || Object.keys(data).length === 0)
        .map(([keyId]) => keyId);

    if (staleKeyIds.length > 0) {
        await Promise.all(staleKeyIds.map((keyId) => redisSRem(userKeyIndex, keyId)));
    }

    const candidates = loadedRecords
        .map(([keyId, data]) => {
            if (!data || Object.keys(data).length === 0) {
                return null;
            }

            return buildActiveSessionCandidate(keyId, data);
        })
        .filter((candidate): candidate is ActiveSessionCandidate => candidate !== null);

    const sessionChainIds = [...new Set(
        candidates
            .filter((candidate) => candidate.purpose === "session" && typeof candidate.chainId === "number")
            .map((candidate) => candidate.chainId as number),
    )];

    const sessionBudgets = new Map<number, Awaited<ReturnType<typeof getSessionBudget>> | undefined>();
    const sessionBudgetEntries = await Promise.all(
        sessionChainIds.map(async (candidateChainId) => (
            [candidateChainId, await getSessionBudget(normalizedAddress, candidateChainId)] as const
        )),
    );
    for (const [candidateChainId, budget] of sessionBudgetEntries) {
        sessionBudgets.set(candidateChainId, budget);
    }

    const resolvedCandidates = candidates.map((candidate) => {
        if (candidate.purpose !== "session" || typeof candidate.chainId !== "number") {
            return candidate;
        }

        return applySessionBudgetState(candidate, sessionBudgets.get(candidate.chainId));
    });

    return selectActiveSessionStatus(resolvedCandidates, chainId);
}
