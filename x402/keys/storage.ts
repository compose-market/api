/**
 * Compose Keys - Storage Operations
 * 
 * ValKey-backed storage for Compose Key records.
 * Handles key creation, lookup, usage tracking, and revocation.
 * 
 * @module shared/keys/storage
 */

import { randomUUID } from "crypto";
import {
    valkeyHGetAll,
    valkeyHGet,
    valkeyHSet,
    valkeySAdd,
    valkeySMembers,
    valkeyExists,
    valkeyHIncrBy,
    valkeyExpire,
    valkeySet,
    valkeyGet,
    valkeySRem,
    valkeyTTL,
} from "./valkey.js";
import { signKey } from "./jwt.js";
import { getBudgetInfo as getSessionBudgetInfo, getSessionBudget } from "../session/budget.js";
import { isEvmNetwork, type NetworkId } from "../configs/chains.js";
import type {
    KeyRecord,
    KeyPurpose,
    CreateKeyRequest,
    CreateKeyResponse,
    ActiveSessionStatus,
    SessionInactiveReason,
} from "./types.js";

// =============================================================================
// ValKey Key Patterns
// =============================================================================

const KEY_PREFIX = "key:";
const KEY_PREFIX = "key:";
const USER_KEYS_PREFIX = "user-keys:";
const REVOKED_PREFIX = "key:revoked:";
const REVOKED_PREFIX = "key:revoked:";

function keyRecordKey(keyId: string): string {
    return `${KEY_PREFIX}${keyId}`;
}

function normalizeAddress(userAddress: string, network: NetworkId): string {
    return isEvmNetwork(network) ? userAddress.toLowerCase() : userAddress;
}

function userKeysKey(userAddress: string, network: NetworkId): string {
    return `${USER_KEYS_PREFIX}${network}:${normalizeAddress(userAddress, network)}`;
    function normalizeAddress(userAddress: string, network: NetworkId): string {
        return isEvmNetwork(network) ? userAddress.toLowerCase() : userAddress;
    }

    function userKeysKey(userAddress: string, network: NetworkId): string {
        return `${USER_KEYS_PREFIX}${network}:${normalizeAddress(userAddress, network)}`;
    }

    function revokedKey(keyId: string): string {
        return `${REVOKED_PREFIX}${keyId}`;
    }

    function parseKeyPurpose(value: string | undefined): KeyPurpose | null {
        if (value === "session" || value === "api") {
            return value;
        }

        return null;
    }

    export function getBudgetRemaining(record: Pick<KeyRecord, "budgetLimit" | "budgetUsed" | "budgetReserved">): number {
        return Math.max(0, record.budgetLimit - record.budgetUsed - (record.budgetReserved || 0));
    }

    export interface ActiveSessionCandidate {
        keyId: string;
        purpose: KeyPurpose;
        token?: string;
        budgetLimit: number;
        budgetUsed: number;
        budgetLocked: number;
        budgetRemaining: number;
        expiresAt: number;
        createdAt: number;
        network: NetworkId;
        network: NetworkId;
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
            network: candidate.network,
            network: candidate.network,
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
        const purpose = parseKeyPurpose(data.purpose);
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
            network: data.network as NetworkId,
            network: data.network as NetworkId,
            name: data.name || undefined,
            revokedAt: parseStoredInteger(data.revokedAt) ?? undefined,
        };
    }

    function applySessionBudgetState(
        candidate: ActiveSessionCandidate,
        budget: Awaited<ReturnType<typeof getSessionBudget>> | undefined,
        info: Awaited<ReturnType<typeof getSessionBudgetInfo>> | undefined,
    ): ActiveSessionCandidate {
        if (!budget || !info) {
            return {
                ...candidate,
                missingBudgetState: true,
                budgetLocked: 0,
                budgetRemaining: 0,
            };
        }

        const budgetLimit = parseStoredInteger(info.totalWei);
        const budgetUsed = parseStoredInteger(info.usedWei);
        const budgetLocked = parseStoredInteger(info.lockedWei);
        const budgetRemaining = parseStoredInteger(info.availableWei);

        if (budgetLimit === null || budgetUsed === null || budgetLocked === null || budgetRemaining === null) {
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
            budgetRemaining: Math.max(0, budgetRemaining),
            expiresAt: budget.expiresAt,
        };
    }

    export function selectActiveSessionStatus(
        candidates: ActiveSessionCandidate[],
        network?: NetworkId,
        network?: NetworkId,
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

        let sawNetworkMismatch = false;
        let sawNetworkMismatch = false;
        let firstInvalid: { reason: SessionInactiveReason; key: ActiveSessionCandidate } | null = null;

        for (const candidate of sessionCandidates) {
            const networkMismatch = Boolean(network && candidate.network !== network);
            if (networkMismatch) {
                sawNetworkMismatch = true;
                const networkMismatch = Boolean(network && candidate.network !== network);
                if (networkMismatch) {
                    sawNetworkMismatch = true;
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
                            network: candidate.network,
                            network: candidate.network,
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

            if (sawNetworkMismatch) {
                if (sawNetworkMismatch) {
                    return {
                        session: null,
                        reason: "network_mismatch",
                        reason: "network_mismatch",
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
            export async function createKey(
                userAddress: string,
                request: CreateKeyRequest
            ): Promise<CreateKeyResponse> {
                const keyId = randomUUID();
                const now = Date.now();
                const normalizedAddress = normalizeAddress(userAddress, request.network);
                const normalizedAddress = normalizeAddress(userAddress, request.network);

                const record: KeyRecord = {
                    keyId,
                    userAddress: normalizedAddress,
                    purpose: request.purpose,
                    budgetLimit: request.budgetLimit,
                    budgetUsed: 0,
                    budgetReserved: 0,
                    createdAt: now,
                    expiresAt: request.expiresAt,
                    name: request.name,
                    network: request.network,
                    network: request.network,
                };

                // Generate token
                const token = signKey({
                    sub: normalizedAddress,
                    keyId,
                    network: request.network,
                    network: request.network,
                    budgetLimit: request.budgetLimit,
                    budgetUsed: 0,
                    exp: Math.floor(request.expiresAt / 1000), // Convert to seconds
                });

                const recordKey = keyRecordKey(keyId);
                await valkeyHSet(recordKey, {
                    keyId: record.keyId,
                    userAddress: record.userAddress,
                    purpose: record.purpose,
                    budgetLimit: String(record.budgetLimit),
                    budgetUsed: String(record.budgetUsed),
                    budgetReserved: String(record.budgetReserved || 0),
                    createdAt: String(record.createdAt),
                    expiresAt: String(record.expiresAt),
                    ...(record.name ? { name: record.name } : {}),
                    network: record.network,
                    network: record.network,
                    token,
                });

                // Set TTL based on expiration
                const ttlSeconds = Math.ceil((request.expiresAt - now) / 1000);
                if (ttlSeconds > 0) {
                    await valkeyExpire(recordKey, ttlSeconds);
                }

                // Add to user's key set
                await valkeySAdd(userKeysKey(normalizedAddress, request.network), keyId);
                const indexTtlSeconds = await valkeyTTL(userKeysKey(normalizedAddress, request.network));
                await valkeySAdd(userKeysKey(normalizedAddress, request.network), keyId);
                const indexTtlSeconds = await valkeyTTL(userKeysKey(normalizedAddress, request.network));
                if (ttlSeconds > 0 && (indexTtlSeconds < 0 || indexTtlSeconds < ttlSeconds)) {
                    await valkeyExpire(userKeysKey(normalizedAddress, request.network), ttlSeconds);
                    await valkeyExpire(userKeysKey(normalizedAddress, request.network), ttlSeconds);
                }

                return {
                    keyId,
                    token,
                    purpose: request.purpose,
                    network: request.network,
                    network: request.network,
                    budgetLimit: request.budgetLimit,
                    expiresAt: request.expiresAt,
                    name: request.name,
                };
            }

            /**
             * Get a key record by ID
             */
            export async function getKeyRecord(keyId: string): Promise<KeyRecord | null> {
                const data = await valkeyHGetAll(keyRecordKey(keyId));

                if (!data || Object.keys(data).length === 0) {
                    return null;
                }

                const purpose = parseKeyPurpose(data.purpose);
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
                    network: data.network as NetworkId,
                    network: data.network as NetworkId,
                };
            }

            /**
             * List all keys for a user
             */
            export async function listUserKeys(userAddress: string, network: NetworkId): Promise<KeyRecord[]> {
                const normalizedAddress = normalizeAddress(userAddress, network);
                const keyIds = await valkeySMembers(userKeysKey(normalizedAddress, network));
                export async function listUserKeys(userAddress: string, network: NetworkId): Promise<KeyRecord[]> {
                    const normalizedAddress = normalizeAddress(userAddress, network);
                    const keyIds = await valkeySMembers(userKeysKey(normalizedAddress, network));
                    const records = (await Promise.all(keyIds.map((keyId) => getKeyRecord(keyId))))
                        .filter((record): record is KeyRecord => record !== null);

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
                    const updatedUsed = await valkeyHIncrBy(recordKey, "budgetUsed", amountWei);

                    // Update last used timestamp
                    await valkeyHSet(recordKey, "lastUsedAt", String(Date.now()));

                    return updatedUsed;
                }

                /**
                 * Sync budget from batch settlement
                 * Called by batch worker after on-chain settlement completes
                 * Updates storage.ts budgetUsed to match settled amount
                 * 
                 * @param userAddress - User wallet address
                 * @param network - CAIP-2 network
                 * @param network - CAIP-2 network
                 * @param totalUsedWei - Total USDC wei settled on-chain
                 */
                export async function syncBudgetAfterSettlement(
                    userAddress: string,
                    network: NetworkId,
                    network: NetworkId,
                    totalUsedWei: string,
                ): Promise<void> {
                    const addr = normalizeAddress(userAddress, network);
                    const keyIds = await valkeySMembers(userKeysKey(addr, network));
                    const addr = normalizeAddress(userAddress, network);
                    const keyIds = await valkeySMembers(userKeysKey(addr, network));

                    for (const keyId of keyIds) {
                        const record = await getKeyRecord(keyId);
                        if (record && record.network === network) {
                            if (record && record.network === network) {
                                const recordKey = keyRecordKey(keyId);
                                await valkeyHSet(recordKey, "budgetUsed", totalUsedWei);
                                return;
                            }
                        }
                    }

                    /**
                     * Check if a key is revoked
                     */
                    export async function isKeyRevoked(keyId: string): Promise<boolean> {
                        return valkeyExists(revokedKey(keyId));
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
                        await valkeyHSet(keyRecordKey(keyId), "revokedAt", String(Date.now()));

                        // Also set a revoked marker (for fast lookup without fetching full record)
                        // TTL matches key expiration
                        const ttlSeconds = Math.ceil((record.expiresAt - Date.now()) / 1000);
                        if (ttlSeconds > 0) {
                            await valkeySet(revokedKey(keyId), "1", ttlSeconds);
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
                        const value = await valkeyHGet(keyRecordKey(keyId), "budgetReserved");
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
                     * @param network - CAIP-2 network
                     * @param network - CAIP-2 network
                     * @returns Active session with token, or null if none found
                     */
                    export async function getActiveSessionStatus(
                        userAddress: string,
                        network: NetworkId,
                        network: NetworkId,
                    ): Promise<ActiveSessionStatus> {
                        const normalizedAddress = normalizeAddress(userAddress, network);
                        const keyIds = await valkeySMembers(userKeysKey(normalizedAddress, network));
                        const userKeyIndex = userKeysKey(normalizedAddress, network);
                        const normalizedAddress = normalizeAddress(userAddress, network);
                        const keyIds = await valkeySMembers(userKeysKey(normalizedAddress, network));
                        const userKeyIndex = userKeysKey(normalizedAddress, network);
                        const loadedRecords = await Promise.all(
                            keyIds.map(async (keyId) => [keyId, await valkeyHGetAll(keyRecordKey(keyId))] as const),
                        );

                        const staleKeyIds = loadedRecords
                            .filter(([, data]) => !data || Object.keys(data).length === 0)
                            .map(([keyId]) => keyId);

                        if (staleKeyIds.length > 0) {
                            await Promise.all(staleKeyIds.map((keyId) => valkeySRem(userKeyIndex, keyId)));
                        }

                        const candidates = loadedRecords
                            .map(([keyId, data]) => {
                                if (!data || Object.keys(data).length === 0) {
                                    return null;
                                }

                                return buildActiveSessionCandidate(keyId, data);
                            })
                            .filter((candidate): candidate is ActiveSessionCandidate => candidate !== null);

                        const sessionNetworks = [...new Set(
    const sessionNetworks = [...new Set(
                            candidates
                                .filter((candidate) => candidate.purpose === "session")
                                .map((candidate) => candidate.network),
            .filter((candidate) => candidate.purpose === "session")
                            .map((candidate) => candidate.network),
    )];

                        const sessionBudgets = new Map<NetworkId, Awaited<ReturnType<typeof getSessionBudget>> | undefined>();
                        const sessionBudgetInfo = new Map<NetworkId, Awaited<ReturnType<typeof getSessionBudgetInfo>> | undefined>();
                        const sessionBudgetEntries = await Promise.all(
                            sessionNetworks.map(async (candidateNetwork) => {
                                const [budget, info] = await Promise.all([
                                    getSessionBudget(normalizedAddress, candidateNetwork),
                                    getSessionBudgetInfo(normalizedAddress, candidateNetwork),
                                ]);
                                return [candidateNetwork, budget, info] as const;
                            }),
                        );
                        for (const [candidateNetwork, budget, info] of sessionBudgetEntries) {
                            sessionBudgets.set(candidateNetwork, budget);
                            sessionBudgetInfo.set(candidateNetwork, info);
                        }

                        const resolvedCandidates = candidates.map((candidate) => {
                            if (candidate.purpose !== "session") {
                                if (candidate.purpose !== "session") {
                                    return candidate;
                                }

                                return applySessionBudgetState(
                                    candidate,
                                    sessionBudgets.get(candidate.network),
                                    sessionBudgetInfo.get(candidate.network),
                                );
                            });

                        return selectActiveSessionStatus(resolvedCandidates, network);
                        return selectActiveSessionStatus(resolvedCandidates, network);
                    }
