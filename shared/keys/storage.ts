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
    redisHSet,
    redisSAdd,
    redisSMembers,
    redisExists,
    redisHIncrBy,
    redisExpire,
    redisSet,
    redisGet,
} from "../config/redis.js";
import { signComposeKey } from "./jwt.js";
import type { ComposeKeyRecord, CreateKeyRequest, CreateKeyResponse } from "./types.js";

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
        budgetLimit: request.budgetLimit,
        budgetUsed: 0,
        createdAt: now,
        expiresAt: request.expiresAt,
        name: request.name,
    };

    // Generate token
    const token = signComposeKey({
        sub: normalizedAddress,
        keyId,
        budgetLimit: request.budgetLimit,
        budgetUsed: 0,
        exp: Math.floor(request.expiresAt / 1000), // Convert to seconds
    });

    // Store record in Redis
    const recordKey = keyRecordKey(keyId);
    for (const [field, value] of Object.entries(record)) {
        if (value !== undefined) {
            await redisHSet(recordKey, field, String(value));
        }
    }

    // Set TTL based on expiration
    const ttlSeconds = Math.ceil((request.expiresAt - now) / 1000);
    if (ttlSeconds > 0) {
        await redisExpire(recordKey, ttlSeconds);
    }

    // Add to user's key set
    await redisSAdd(userKeysKey(normalizedAddress), keyId);

    console.log(`[keys/storage] Created key ${keyId} for ${normalizedAddress}, budget: ${request.budgetLimit}, expires: ${new Date(request.expiresAt).toISOString()}`);

    return {
        keyId,
        token,
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

    return {
        keyId: data.keyId,
        userAddress: data.userAddress,
        budgetLimit: parseInt(data.budgetLimit, 10),
        budgetUsed: parseInt(data.budgetUsed, 10),
        createdAt: parseInt(data.createdAt, 10),
        expiresAt: parseInt(data.expiresAt, 10),
        revokedAt: data.revokedAt ? parseInt(data.revokedAt, 10) : undefined,
        name: data.name || undefined,
        lastUsedAt: data.lastUsedAt ? parseInt(data.lastUsedAt, 10) : undefined,
    };
}

/**
 * List all keys for a user
 */
export async function listUserKeys(userAddress: string): Promise<ComposeKeyRecord[]> {
    const normalizedAddress = userAddress.toLowerCase();
    const keyIds = await redisSMembers(userKeysKey(normalizedAddress));

    const records: ComposeKeyRecord[] = [];
    for (const keyId of keyIds) {
        const record = await getKeyRecord(keyId);
        if (record) {
            records.push(record);
        }
    }

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
        console.log(`[keys/storage] Key ${keyId} not found`);
        return -1;
    }

    // Check if budget would be exceeded
    const newUsed = record.budgetUsed + amountWei;
    if (newUsed > record.budgetLimit) {
        console.log(`[keys/storage] Key ${keyId} budget exceeded: ${newUsed} > ${record.budgetLimit}`);
        return -1;
    }

    // Atomically increment usage
    const updatedUsed = await redisHIncrBy(recordKey, "budgetUsed", amountWei);

    // Update last used timestamp
    await redisHSet(recordKey, "lastUsedAt", String(Date.now()));

    console.log(`[keys/storage] Key ${keyId} usage: ${updatedUsed}/${record.budgetLimit} wei`);

    return updatedUsed;
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
        console.log(`[keys/storage] Key ${keyId} not found for revocation`);
        return false;
    }

    if (record.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
        console.log(`[keys/storage] Unauthorized revocation attempt for key ${keyId}`);
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

    console.log(`[keys/storage] Key ${keyId} revoked`);

    return true;
}

/**
 * Get remaining budget for a key
 */
export async function getKeyBudgetRemaining(keyId: string): Promise<number> {
    const record = await getKeyRecord(keyId);
    if (!record) return 0;
    return Math.max(0, record.budgetLimit - record.budgetUsed);
}

/**
 * Rollback budget usage (when on-chain settlement fails)
 * 
 * @param keyId - Key ID
 * @param amountWei - Amount to rollback
 */
export async function rollbackKeyUsage(keyId: string, amountWei: number): Promise<void> {
    const recordKey = keyRecordKey(keyId);
    await redisHIncrBy(recordKey, "budgetUsed", -amountWei);
    console.log(`[keys/storage] Key ${keyId} budget rolled back by ${amountWei} wei`);
}
