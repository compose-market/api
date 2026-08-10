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
    valkeyExpire,
    valkeyGet,
    valkeySRem,
    valkeyTTL,
    getValkeyClient,
} from "./valkey.js";
import { signKey } from "./jwt.js";
import { isEvmNetwork, isNetworkId, type NetworkId } from "../configs/chains.js";
import type { WalletScope } from "../../data/user/types.js";
import { publishInvalidationBestEffort } from "../../data/shared/updates.js";
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
const USER_KEYS_PREFIX = "user-keys:";
const REVOKED_PREFIX = "key:revoked:";
const PAYMENT_INTENT_PREFIX = "payment-intent:";
const KEY_PAYMENT_INTENTS_PREFIX = "key-payment-intents:";

export const KEY_RECORD_LIST_FIELDS = [
    "keyId",
    "userAddress",
    "purpose",
    "budgetLimit",
    "budgetUsed",
    "budgetReserved",
    "createdAt",
    "expiresAt",
    "revokedAt",
    "name",
    "lastUsedAt",
    "network",
] as const;

export interface KeyListPipeline {
    smembers(key: string): this;
    hmget(key: string, ...fields: string[]): this;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface KeyListClient {
    pipeline(): KeyListPipeline;
}

function keyRecordKey(keyId: string): string {
    return `${KEY_PREFIX}${keyId}`;
}

function normalizeAddress(userAddress: string, network: NetworkId): string {
    return isEvmNetwork(network) ? userAddress.toLowerCase() : userAddress;
}

function userKeysKey(userAddress: string, network: NetworkId): string {
    return `${USER_KEYS_PREFIX}${network}:${normalizeAddress(userAddress, network)}`;
}

function revokedKey(keyId: string): string {
    return `${REVOKED_PREFIX}${keyId}`;
}

function keyPaymentIntentsKey(keyId: string): string {
    return `${KEY_PAYMENT_INTENTS_PREFIX}${keyId}`;
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
    name?: string;
    revokedAt?: number;
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
        name: candidate.name,
        revokedAt: candidate.revokedAt,
    };
}

function getInactiveReason(candidate: ActiveSessionCandidate, now: number): SessionInactiveReason | null {
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
    const network = data.network;

    if (!purpose || budgetLimit === null || budgetUsed === null || expiresAt === null || !isNetworkId(network)) {
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
        network,
        name: data.name || undefined,
        revokedAt: parseStoredInteger(data.revokedAt) ?? undefined,
    };
}

export function selectActiveSessionStatus(
    candidates: ActiveSessionCandidate[],
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
    let firstInvalid: { reason: SessionInactiveReason; key: ActiveSessionCandidate } | null = null;

    for (const candidate of sessionCandidates) {
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
        return {
            session: null,
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
    };

    // Generate token
    const token = signKey({
        sub: normalizedAddress,
        keyId,
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
    if (ttlSeconds > 0 && (indexTtlSeconds < 0 || indexTtlSeconds < ttlSeconds)) {
        await valkeyExpire(userKeysKey(normalizedAddress, request.network), ttlSeconds);
    }

    await publishInvalidationBestEffort("keys", normalizedAddress, "created");

    return {
        keyId,
        token,
        purpose: request.purpose,
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
    };
}

function parseListInteger(value: string | null, optional = false): number | null {
    if (value === null) return optional ? 0 : null;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function listRecord(
    expectedKeyId: string,
    values: unknown,
    scopesByNetwork: ReadonlyMap<NetworkId, string>,
): KeyRecord | null {
    if (!Array.isArray(values) || values.length !== KEY_RECORD_LIST_FIELDS.length) return null;
    if (values.some((value) => value !== null && typeof value !== "string")) return null;

    const data = Object.fromEntries(
        KEY_RECORD_LIST_FIELDS.map((field, index) => [field, values[index] as string | null]),
    ) as Record<(typeof KEY_RECORD_LIST_FIELDS)[number], string | null>;
    const purpose = parseKeyPurpose(data.purpose ?? undefined);
    const network = data.network;
    const budgetLimit = parseListInteger(data.budgetLimit);
    const budgetUsed = parseListInteger(data.budgetUsed);
    const budgetReserved = parseListInteger(data.budgetReserved, true);
    const createdAt = parseListInteger(data.createdAt);
    const expiresAt = parseListInteger(data.expiresAt);
    const revokedAt = data.revokedAt === null ? undefined : parseListInteger(data.revokedAt);
    const lastUsedAt = data.lastUsedAt === null ? undefined : parseListInteger(data.lastUsedAt);

    if (
        data.keyId !== expectedKeyId
        || !data.userAddress
        || !purpose
        || !network
        || !isNetworkId(network)
        || budgetLimit === null
        || budgetUsed === null
        || budgetReserved === null
        || createdAt === null
        || expiresAt === null
        || revokedAt === null
        || lastUsedAt === null
    ) {
        return null;
    }

    const scopedAddress = scopesByNetwork.get(network);
    if (!scopedAddress || normalizeAddress(data.userAddress, network) !== scopedAddress) return null;

    return {
        keyId: data.keyId,
        userAddress: normalizeAddress(data.userAddress, network),
        purpose,
        budgetLimit,
        budgetUsed,
        budgetReserved,
        createdAt,
        expiresAt,
        ...(revokedAt === undefined ? {} : { revokedAt }),
        ...(data.name ? { name: data.name } : {}),
        ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
        network,
    };
}

async function executeListPipeline(
    pipeline: KeyListPipeline,
    expectedResults: number,
): Promise<unknown[]> {
    const results = await pipeline.exec();
    if (!results || results.length !== expectedResults) {
        throw new Error("Invalid Valkey pipeline response");
    }
    return results.map(([error, value]) => {
        if (error) throw error;
        return value;
    });
}

/** List every token-free key record in the supplied enabled wallet scopes. */
export async function listUserKeys(
    scopes: readonly WalletScope[],
    client?: KeyListClient,
): Promise<KeyRecord[]> {
    if (scopes.length === 0) return [];
    const valkey = client ?? await getValkeyClient() as unknown as KeyListClient;
    const indexPipeline = valkey.pipeline();
    for (const scope of scopes) {
        indexPipeline.smembers(userKeysKey(scope.address, scope.network));
    }
    const indexResults = await executeListPipeline(indexPipeline, scopes.length);
    const keyIds = new Set<string>();
    for (const result of indexResults) {
        if (!Array.isArray(result) || result.some((keyId) => typeof keyId !== "string")) {
            throw new Error("Invalid Valkey key index response");
        }
        for (const keyId of result) keyIds.add(keyId);
    }
    if (keyIds.size === 0) return [];

    const uniqueKeyIds = [...keyIds];
    const recordPipeline = valkey.pipeline();
    for (const keyId of uniqueKeyIds) {
        recordPipeline.hmget(keyRecordKey(keyId), ...KEY_RECORD_LIST_FIELDS);
    }
    const recordResults = await executeListPipeline(recordPipeline, uniqueKeyIds.length);
    const scopesByNetwork = new Map(scopes.map((scope) => [scope.network, scope.address]));
    const records = recordResults
        .map((values, index) => listRecord(uniqueKeyIds[index]!, values, scopesByNetwork))
        .filter((record): record is KeyRecord => record !== null);
    records.sort((left, right) => right.createdAt - left.createdAt);
    return records;
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

    const normalizedAddress = normalizeAddress(userAddress, record.network);
    if (record.userAddress !== normalizedAddress || record.revokedAt) {
        return false;
    }

    const now = Date.now();
    const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - now) / 1000));
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        `local function normalize(value)
    local normalized = string.gsub(value or "0", "^0+", "")
    return normalized == "" and "0" or normalized
end
local function add(left, right)
    left = normalize(left)
    right = normalize(right)
    local result = ""
    local carry = 0
    local i = string.len(left)
    local j = string.len(right)
    while i > 0 or j > 0 or carry > 0 do
        local leftDigit = i > 0 and tonumber(string.sub(left, i, i)) or 0
        local rightDigit = j > 0 and tonumber(string.sub(right, j, j)) or 0
        local sum = leftDigit + rightDigit + carry
        result = tostring(sum % 10) .. result
        carry = math.floor(sum / 10)
        i = i - 1
        j = j - 1
    end
    return normalize(result)
end
local function greaterThan(left, right)
    left = normalize(left)
    right = normalize(right)
    if string.len(left) ~= string.len(right) then
        return string.len(left) > string.len(right)
    end
    return left > right
end
local owner = redis.call("HGET", KEYS[1], "userAddress")
local network = redis.call("HGET", KEYS[1], "network")
local revokedAt = redis.call("HGET", KEYS[1], "revokedAt")
if owner ~= ARGV[1] or network ~= ARGV[2] or revokedAt then
    return 0
end
local intentIds = redis.call("SMEMBERS", KEYS[4])
local release = {}
local totalRelease = "0"
for _, intentId in ipairs(intentIds) do
    local intentKey = ARGV[6] .. intentId
    local intentKeyId = redis.call("HGET", intentKey, "keyId")
    local status = redis.call("HGET", intentKey, "status")
    if intentKeyId == ARGV[3] and (status == "authorized" or status == "reserved") then
        local amount = redis.call("HGET", intentKey, "reservedAmountWei") or "0"
        if not string.match(amount, "^%d+$") then
            return -2
        end
        totalRelease = add(totalRelease, amount)
        table.insert(release, { key = intentKey, amount = normalize(amount) })
    end
end
local currentReserved = redis.call("HGET", KEYS[1], "budgetReserved") or "0"
if not string.match(currentReserved, "^%d+$") or greaterThan(totalRelease, currentReserved) then
    return -2
end
redis.call("HSET", KEYS[1], "revokedAt", ARGV[4])
redis.call("SET", KEYS[2], "1", "EX", ARGV[5])
redis.call("SREM", KEYS[3], ARGV[3])
for _, item in ipairs(release) do
    if item.amount ~= "0" then
        redis.call("HINCRBY", KEYS[1], "budgetReserved", "-" .. item.amount)
    end
    redis.call("HSET", item.key,
        "status", "released",
        "reservedAmountWei", "0",
        "releasedAt", ARGV[4],
        "updatedAt", ARGV[4],
        "error", "Credential revoked before billing")
end
return 1`,
        4,
        keyRecordKey(keyId),
        revokedKey(keyId),
        userKeysKey(normalizedAddress, record.network),
        keyPaymentIntentsKey(keyId),
        normalizedAddress,
        record.network,
        keyId,
        String(now),
        String(ttlSeconds),
        PAYMENT_INTENT_PREFIX,
    );

    if (Number(result) === -2) {
        throw new Error(`Cannot revoke key ${keyId}: canonical reservation state is inconsistent`);
    }

    const revoked = Number(result) === 1;
    if (revoked) {
        await publishInvalidationBestEffort("keys", normalizedAddress, "revoked");
    }
    return revoked;
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
 * @returns Active session with token, or null if none found
 */
export async function getActiveSessionStatus(
    userAddress: string,
    network: NetworkId,
): Promise<ActiveSessionStatus> {
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

    return selectActiveSessionStatus(candidates, network);
}
