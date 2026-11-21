/**
 * ValKey Client Module
 *
 * ValKey connection and operations for Api service.
 * Uses Aiven managed ValKey with TLS via ioredis.
 *
 * @module shared/config/valkey
 */

import { Redis as ValkeyClient } from "ioredis";

type ValkeyClientType = ValkeyClient;
const VALKEY_COMMAND_TIMEOUT_MS = 1_500;
const VALKEY_KEEP_ALIVE_MS = 10_000;

// =============================================================================
// Client Singleton
// =============================================================================

let client: ValkeyClientType | null = null;
let connectionPromise: Promise<ValkeyClientType> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

// Aiven Valkey enforces `valkey_timeout` (default 300s) as an *application-level*
// idle close: TCP keepalive packets do not count as commands, so a quiet
// connection is dropped every 5 minutes and the next command pays a reconnect.
// A periodic PING below that threshold keeps the connection warm and also
// surfaces half-open sockets early (a failed PING forces a clean reconnect
// before user traffic hits the dead socket).
const VALKEY_KEEPALIVE_PING_MS = 60_000;

function startKeepAlive(instance: ValkeyClientType): void {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
        if (instance.status !== "ready") return;
        instance.ping().catch(() => {
            try {
                instance.disconnect(true);
            } catch {
                // Already disconnecting.
            }
        });
    }, VALKEY_KEEPALIVE_PING_MS);
    keepAliveTimer.unref?.();
}

function stopKeepAlive(): void {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

/**
 * Get ValKey client connection
 * Uses singleton pattern with lazy initialization
 */
export async function getValkeyClient(): Promise<ValkeyClientType> {
    if (client?.status === "ready") {
        return client;
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = connect().catch((error) => {
        connectionPromise = null;
        throw error;
    });
    return connectionPromise;
}

async function connect(): Promise<ValkeyClientType> {
    const uri = process.env.VALKEY_KEYS_SERVICE_URI?.trim();
    const password = process.env.VALKEY_KEYS_PASSWORD?.trim();
    const tls = process.env.VALKEY_TLS === "true";

    if (!uri) {
        throw new Error("ValKey configuration missing: VALKEY_KEYS_SERVICE_URI required");
    }

    console.log(`[valkey] Connecting via service URI`);

    const instance = new ValkeyClient(uri, {
        connectTimeout: 2000,
        retryStrategy: (times: number) => Math.min(times * 50, 500),
        maxRetriesPerRequest: 1,
        commandTimeout: VALKEY_COMMAND_TIMEOUT_MS,
        enableOfflineQueue: false,
        enableAutoPipelining: true,
        lazyConnect: true,
        keepAlive: VALKEY_KEEP_ALIVE_MS,
        ...(password ? { password: password } : {}),
        ...(tls ? { tls: {} } : {}),
    });

    instance.on("error", (err) => {
        console.error("[valkey] Client error:", err);
    });

    instance.on("reconnecting", () => {
        console.log("[valkey] Reconnecting...");
    });
    instance.on("end", () => {
        if (client === instance && instance.status !== "ready") {
            client = null;
        }
        stopKeepAlive();
    });

    try {
        await instance.connect();
        await instance.ping();
    } catch (error) {
        try { instance.disconnect(); } catch { /* ignore */ }
        throw error;
    }
    client = instance;
    connectionPromise = null;
    startKeepAlive(instance);
    console.log("[valkey] Connected successfully");

    return instance;
}

/**
 * Close ValKey connection
 * Call during cleanup/shutdown
 */
export async function closeValkey(): Promise<void> {
    stopKeepAlive();
    if (client) {
        await client.quit();
        client = null;
        connectionPromise = null;
        console.log("[valkey] Connection closed");
    }
}

// =============================================================================
// Key-Value Operations
// =============================================================================

/**
 * Set a value with optional TTL
 */
export async function valkeySet(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const valkey = await getValkeyClient();
    if (ttlSeconds) {
        await valkey.setex(key, ttlSeconds, value);
    } else {
        await valkey.set(key, value);
    }
}

/**
 * Get a value
 */
export async function valkeyGet(key: string): Promise<string | null> {
    const valkey = await getValkeyClient();
    return valkey.get(key);
}

/**
 * Delete a key
 */
export async function valkeyDel(key: string): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.del(key);
    return result > 0;
}

/**
 * Check if key exists
 */
export async function valkeyExists(key: string): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.exists(key);
    return result > 0;
}

/**
 * Set hash field(s)
 * Supports both single field/value and object of multiple fields
 */
export async function valkeyHSet(
    key: string,
    fieldOrData: string | Record<string, string>,
    value?: string
): Promise<void> {
    const valkey = await getValkeyClient();

    if (typeof fieldOrData === "string") {
        if (value === undefined) {
            throw new Error("valkeyHSet: value required when field is string");
        }
        await valkey.hset(key, fieldOrData, value);
    } else {
        await valkey.hset(key, fieldOrData);
    }
}

/**
 * Get a hash field
 */
export async function valkeyHGet(key: string, field: string): Promise<string | undefined> {
    const valkey = await getValkeyClient();
    const result = await valkey.hget(key, field);
    return result ?? undefined;
}

/**
 * Get all hash fields
 */
export async function valkeyHGetAll(key: string): Promise<Record<string, string>> {
    const valkey = await getValkeyClient();
    return valkey.hgetall(key);
}

/**
 * Delete hash fields
 */
export async function valkeyHDel(key: string, ...fields: string[]): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.hdel(key, ...fields);
}

/**
 * Add to a set
 */
export async function valkeySAdd(key: string, ...members: string[]): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.sadd(key, ...members);
}

/**
 * Get all set members
 */
export async function valkeySMembers(key: string): Promise<string[]> {
    const valkey = await getValkeyClient();
    return valkey.smembers(key);
}

/** Return at most `count` distinct set members without hydrating the full set. */
export async function valkeySRandMembers(key: string, count: number): Promise<string[]> {
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    const valkey = await getValkeyClient();
    const result = await valkey.srandmember(key, count);
    return Array.isArray(result) ? result : result ? [result] : [];
}

/**
 * Check set membership
 */
export async function valkeySIsMember(key: string, member: string): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.sismember(key, member);
    return Boolean(result);
}

/**
 * Remove from a set
 */
export async function valkeySRem(key: string, ...members: string[]): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.srem(key, ...members);
}

/** Return the oldest members whose numeric score is due, without hydrating the full index. */
export async function valkeyZRangeByScore(
    key: string,
    maxScore: number,
    limit: number,
): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const valkey = await getValkeyClient();
    return valkey.zrangebyscore(key, "-inf", String(maxScore), "LIMIT", 0, limit);
}

/** Return due members that are still present in at least one live work set, cleaning stale due entries. */
export async function valkeyZRangeLiveWorkByScore(input: {
    dueKey: string;
    queuedKey: string;
    submittedKey: string;
    maxScore: number;
    limit: number;
}): Promise<string[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) return [];
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        `local due_key = KEYS[1]
local queued_key = KEYS[2]
local submitted_key = KEYS[3]
local max_score = ARGV[1]
local limit = tonumber(ARGV[2])
local scan_limit = limit
local selected = {}
local stale = {}
local offset = 0

while #selected < limit do
    local candidates = redis.call("ZRANGEBYSCORE", due_key, "-inf", max_score, "LIMIT", offset, scan_limit)
    if #candidates == 0 then break end
    for _, member in ipairs(candidates) do
        if redis.call("SISMEMBER", queued_key, member) == 1 or redis.call("SISMEMBER", submitted_key, member) == 1 then
            table.insert(selected, member)
            if #selected >= limit then break end
        else
            table.insert(stale, member)
        end
    end
    offset = offset + #candidates
    if #candidates < scan_limit then break end
    scan_limit = math.min(scan_limit * 2, scan_limit + 100)
end

if #stale > 0 then
    for i = 1, #stale, 500 do
        local last = math.min(i + 499, #stale)
        redis.call("ZREM", due_key, unpack(stale, i, last))
    end
end
return selected`,
        3,
        input.dueKey,
        input.queuedKey,
        input.submittedKey,
        String(input.maxScore),
        String(input.limit),
    );
    return Array.isArray(result) ? result.map(String) : [];
}

/** Remove work identities from a sorted due index. */
export async function valkeyZRem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    const valkey = await getValkeyClient();
    return valkey.zrem(key, ...members);
}

/**
 * Increment a hash field by integer
 */
export async function valkeyHIncrBy(key: string, field: string, increment: number): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.hincrby(key, field, increment);
}

function normalizeValkeyInteger(value: string | number | bigint): string {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new Error("ValKey integer increment must be a safe integer when passed as a number");
        }
        return String(value);
    }
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        throw new Error("ValKey integer increment must be a base-10 integer");
    }
    return trimmed.replace(/^-?0+(?=\d)/, (match) => match.startsWith("-") ? "-" : "");
}

/**
 * Increment a hash field by a decimal integer string/BigInt.
 * Use this for USDC atomic amounts so financial paths do not coerce through
 * JavaScript number before ValKey performs the atomic HINCRBY.
 */
export async function valkeyHIncrByAmount(
    key: string,
    field: string,
    increment: string | number | bigint,
): Promise<string> {
    const valkey = await getValkeyClient();
    const result = await (valkey as unknown as { send_command: (cmd: string, ...args: string[]) => Promise<number> })
        .send_command("HINCRBY", key, field, normalizeValkeyInteger(increment));
    return String(result);
}

/** Atomically reserve budget and attach the reservation to its payment intent. */
export async function valkeyTryReserveBudget(input: {
    budgetKey: string;
    intentKey: string;
    amount: string | bigint;
}): Promise<boolean> {
    const valkey = await getValkeyClient();
    const amount = normalizeValkeyInteger(input.amount);
    const result = await valkey.eval(
        `local function normalize(value)
    local normalized = string.gsub(value, "^0+", "")
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
local budgetLimit = redis.call("HGET", KEYS[1], "budgetLimit") or "0"
local budgetUsed = redis.call("HGET", KEYS[1], "budgetUsed") or "0"
local budgetReserved = redis.call("HGET", KEYS[1], "budgetReserved") or "0"
local normalizedAmount = normalize(ARGV[1])
if string.sub(ARGV[1], 1, 1) == "-" or normalizedAmount == "0" or greaterThan(add(add(budgetUsed, budgetReserved), normalizedAmount), budgetLimit) then
    return 0
end
redis.call("HINCRBY", KEYS[1], "budgetReserved", ARGV[1])
redis.call("HSET", KEYS[2], "reservedAmountWei", ARGV[1])
return 1`,
        2,
        input.budgetKey,
        input.intentKey,
        amount,
    );
    return Number(result) === 1;
}

export interface PaymentIntentAuthorizationSnapshot {
    maxAmountWei: string;
    budgetLimit: number;
    budgetUsed: number;
    budgetReserved: number;
}

export type PaymentIntentAuthorizationResult = (
    | { outcome: "created"; paymentIntentId: string }
    | { outcome: "replayed"; paymentIntentId: string }
    | { outcome: "fingerprint_mismatch"; paymentIntentId: string }
    | { outcome: "revoked" | "expired" | "exhausted" | "inconsistent" }
) & {
    readonly snapshot?: PaymentIntentAuthorizationSnapshot;
};

/**
 * Atomically publish an authorization intent, its credential index entry, and
 * its replay mapping. Redis script serialization linearizes this operation
 * with credential revocation, which uses the same key record and index.
 */
export async function valkeyAuthorizePaymentIntent(input: {
    budgetKey: string;
    intentKey: string;
    keyIntentsKey: string;
    idempotencyKey: string;
    intentPrefix: string;
    intentId: string;
    requestFingerprint: string;
    maxAmountWei: string | bigint;
    useBudgetCap: boolean;
    now: number;
    ttlSeconds: number;
    intentFields: Record<string, string>;
}): Promise<PaymentIntentAuthorizationResult> {
    const valkey = await getValkeyClient();
    const fields = Object.entries(input.intentFields).flat();
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
    if string.len(left) ~= string.len(right) then return string.len(left) > string.len(right) end
    return left > right
end
local function subtract(left, right)
    left = normalize(left)
    right = normalize(right)
    if greaterThan(right, left) then return nil end
    local result = ""
    local borrow = 0
    local i = string.len(left)
    local j = string.len(right)
    while i > 0 do
        local leftDigit = tonumber(string.sub(left, i, i)) - borrow
        local rightDigit = j > 0 and tonumber(string.sub(right, j, j)) or 0
        if leftDigit < rightDigit then
            leftDigit = leftDigit + 10
            borrow = 1
        else
            borrow = 0
        end
        result = tostring(leftDigit - rightDigit) .. result
        i = i - 1
        j = j - 1
    end
    if borrow ~= 0 then return nil end
    return normalize(result)
end
if redis.call("HGET", KEYS[1], "revokedAt") then return {-1, ""} end
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
if expiresAt <= tonumber(ARGV[4]) then return {-2, ""} end
local existingIntentId = redis.call("GET", KEYS[4])
if existingIntentId then
    local existingIntentKey = ARGV[1] .. existingIntentId
    if redis.call("EXISTS", existingIntentKey) == 0 then return {-4, existingIntentId} end
    local existingFingerprint = redis.call("HGET", existingIntentKey, "requestFingerprint") or ""
    if existingFingerprint ~= ARGV[3] then return {-3, existingIntentId} end
    return {2, existingIntentId}
end
local budgetLimit = redis.call("HGET", KEYS[1], "budgetLimit") or "0"
local budgetUsed = redis.call("HGET", KEYS[1], "budgetUsed") or "0"
local budgetReserved = redis.call("HGET", KEYS[1], "budgetReserved") or "0"
local committedAmount = add(budgetUsed, budgetReserved)
local useBudgetCap = ARGV[7] == "1"
local maxAmount = normalize(ARGV[5])
if useBudgetCap then
    maxAmount = subtract(budgetLimit, committedAmount)
    if not maxAmount then return {-4, ""} end
end
if maxAmount == "0" or greaterThan(add(committedAmount, maxAmount), budgetLimit) then
    return {0, "", "", budgetLimit, budgetUsed, budgetReserved}
end
local pairCount = tonumber(ARGV[8])
local offset = 9
for index = 0, pairCount - 1 do
    redis.call("HSET", KEYS[2], ARGV[offset + index * 2], ARGV[offset + index * 2 + 1])
end
redis.call("HSET", KEYS[2], "maxAmountWei", maxAmount)
redis.call("HSET", KEYS[2], "requestFingerprint", ARGV[3])
redis.call("EXPIRE", KEYS[2], ARGV[6])
local indexExisted = redis.call("EXISTS", KEYS[3])
redis.call("SADD", KEYS[3], ARGV[2])
if indexExisted == 0 then
    redis.call("EXPIRE", KEYS[3], ARGV[6])
else
    local indexTtl = redis.call("TTL", KEYS[3])
    if indexTtl >= 0 and indexTtl < tonumber(ARGV[6]) then redis.call("EXPIRE", KEYS[3], ARGV[6]) end
end
redis.call("SET", KEYS[4], ARGV[2], "EX", ARGV[6])
return {1, ARGV[2], maxAmount, budgetLimit, budgetUsed, budgetReserved}`,
        4,
        input.budgetKey,
        input.intentKey,
        input.keyIntentsKey,
        input.idempotencyKey,
        input.intentPrefix,
        input.intentId,
        input.requestFingerprint,
        String(input.now),
        normalizeValkeyInteger(input.maxAmountWei),
        String(input.ttlSeconds),
        input.useBudgetCap ? "1" : "0",
        String(Object.keys(input.intentFields).length),
        ...fields,
    ) as Array<number | string>;
    const code = Number(result[0]);
    const paymentIntentId = String(result[1] || "");
    const attachSnapshot = <T extends PaymentIntentAuthorizationResult>(target: T): T => {
        if (result.length >= 6) {
            const snapshot: PaymentIntentAuthorizationSnapshot = {
                maxAmountWei: String(result[2] || "0"),
                budgetLimit: Number.parseInt(String(result[3] || "0"), 10) || 0,
                budgetUsed: Number.parseInt(String(result[4] || "0"), 10) || 0,
                budgetReserved: Number.parseInt(String(result[5] || "0"), 10) || 0,
            };
            Object.defineProperty(target, "snapshot", {
                value: snapshot,
                enumerable: false,
            });
        }
        return target;
    };
    if (code === 1) return attachSnapshot({ outcome: "created", paymentIntentId });
    if (code === 2) return { outcome: "replayed", paymentIntentId };
    if (code === -3) return { outcome: "fingerprint_mismatch", paymentIntentId };
    if (code === -1) return { outcome: "revoked" };
    if (code === -2) return { outcome: "expired" };
    if (code === 0) return attachSnapshot({ outcome: "exhausted" });
    return { outcome: "inconsistent" };
}

/**
 * Atomically reserve exact key budget and make the intent worker-visible.
 * Revocation uses the same key and intent records in one Lua operation, so it
 * can never observe a reservation between `reserved` and `queued` states.
 */
export async function valkeyReserveAndQueuePaymentIntent(input: {
    budgetKey: string;
    intentKey: string;
    queueKey: string;
    dueKey: string;
    keyIntentsKey: string;
    idempotencyKey: string;
    intentId: string;
    amount: string | bigint;
    now: number;
    settlementFingerprint: string;
    intentFields: Record<string, string>;
}): Promise<"reserved" | "replayed" | "exhausted" | "revoked" | "expired" | "invalid_state"> {
    const valkey = await getValkeyClient();
    const fields = Object.entries(input.intentFields).flat();
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
    if string.len(left) ~= string.len(right) then return string.len(left) > string.len(right) end
    return left > right
end
if redis.call("HGET", KEYS[1], "revokedAt") then return -1 end
local status = redis.call("HGET", KEYS[2], "status")
local existingAmount = redis.call("HGET", KEYS[2], "reservedAmountWei") or "0"
if status == "queued" or status == "submitted" or status == "confirmed" then
    local existingFingerprint = redis.call("HGET", KEYS[2], "settlementFingerprint") or ""
    if normalize(existingAmount) == normalize(ARGV[1]) and existingFingerprint == ARGV[4] then return 2 end
    return -2
end
if status ~= "authorized" then return -2 end
local existingReplay = redis.call("GET", KEYS[5])
if existingReplay and existingReplay ~= ARGV[2] then return -2 end
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt") or "0")
if expiresAt <= tonumber(ARGV[3]) then return -3 end
local budgetLimit = redis.call("HGET", KEYS[1], "budgetLimit") or "0"
local budgetUsed = redis.call("HGET", KEYS[1], "budgetUsed") or "0"
local budgetReserved = redis.call("HGET", KEYS[1], "budgetReserved") or "0"
local amount = normalize(ARGV[1])
if string.sub(ARGV[1], 1, 1) == "-" or amount == "0" or greaterThan(add(add(budgetUsed, budgetReserved), amount), budgetLimit) then
    return 0
end
redis.call("HINCRBY", KEYS[1], "budgetReserved", ARGV[1])
redis.call("HINCRBY", KEYS[1], "pendingIntentCount", 1)
redis.call("HSET", KEYS[2], "reservedAmountWei", ARGV[1])
local pairCount = tonumber(ARGV[5])
local offset = 6
for index = 0, pairCount - 1 do
    redis.call("HSET", KEYS[2], ARGV[offset + index * 2], ARGV[offset + index * 2 + 1])
end
redis.call("SADD", KEYS[3], ARGV[2])
redis.call("SADD", KEYS[4], ARGV[2])
redis.call("SET", KEYS[5], ARGV[2])
redis.call("ZADD", KEYS[6], ARGV[3], ARGV[2])
redis.call("PERSIST", KEYS[1])
redis.call("PERSIST", KEYS[2])
redis.call("PERSIST", KEYS[4])
redis.call("PERSIST", KEYS[5])
return 1`,
        6,
        input.budgetKey,
        input.intentKey,
        input.queueKey,
        input.keyIntentsKey,
        input.idempotencyKey,
        input.dueKey,
        normalizeValkeyInteger(input.amount),
        input.intentId,
        String(input.now),
        input.settlementFingerprint,
        String(Object.keys(input.intentFields).length),
        ...fields,
    );
    if (Number(result) === 1) return "reserved";
    if (Number(result) === 2) return "replayed";
    if (Number(result) === 0) return "exhausted";
    if (Number(result) === -1) return "revoked";
    if (Number(result) === -3) return "expired";
    return "invalid_state";
}

export interface PaymentIntentExecutionClaimResult {
    outcome: "claimed" | "busy" | "not_due" | "terminal" | "invalid_state" | "missing";
    attemptCount: number;
}

/**
 * Atomically claim one queued/submitted intent execution attempt.
 *
 * The claim is a recoverable lease. A stale owner is fenced from persisting a
 * newly prepared transaction, while a successor can safely rebroadcast an
 * already-persisted signed payload with the same deterministic identity.
 */
export async function valkeyClaimPaymentIntentExecution(input: {
    intentKey: string;
    claimToken: string;
    now: number;
    claimExpiresAt: number;
}): Promise<PaymentIntentExecutionClaimResult> {
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        `if redis.call("EXISTS", KEYS[1]) == 0 then return {0, 0} end
local status = redis.call("HGET", KEYS[1], "status") or ""
local attemptCount = tonumber(redis.call("HGET", KEYS[1], "attemptCount") or "0")
if status == "confirmed" or status == "failed" or status == "released" then
    return {4, attemptCount}
end
if status ~= "queued" and status ~= "submitted" then
    return {5, attemptCount}
end
local nextAttemptAt = tonumber(redis.call("HGET", KEYS[1], "nextAttemptAt") or "") or 0
if nextAttemptAt > tonumber(ARGV[2]) then
    return {3, attemptCount}
end
local existingClaim = redis.call("HGET", KEYS[1], "executionClaimToken") or ""
local existingClaimExpiresAt = tonumber(redis.call("HGET", KEYS[1], "executionClaimExpiresAt") or "0")
if existingClaim ~= "" and existingClaimExpiresAt > tonumber(ARGV[2]) then
    return {2, attemptCount}
end
attemptCount = redis.call("HINCRBY", KEYS[1], "attemptCount", 1)
redis.call("HSET", KEYS[1],
    "executionClaimToken", ARGV[1],
    "executionClaimedAt", ARGV[2],
    "executionClaimExpiresAt", ARGV[3],
    "lastAttemptAt", ARGV[2],
    "updatedAt", ARGV[2])
return {1, attemptCount}`,
        1,
        input.intentKey,
        input.claimToken,
        String(input.now),
        String(input.claimExpiresAt),
    ) as Array<number | string>;
    const code = Number(result[0]);
    const attemptCount = Number(result[1] || 0);
    const outcome = code === 1
        ? "claimed"
        : code === 2
            ? "busy"
            : code === 3
                ? "not_due"
                : code === 4
                    ? "terminal"
                    : code === 5
                        ? "invalid_state"
                        : "missing";
    return { outcome, attemptCount };
}

export interface FencedLeaseResult {
    acquired: boolean;
    value?: string;
    fence?: number;
}

/** Acquire a signer-scoped lease with a monotonically increasing fence. */
export async function valkeyAcquireFencedLease(input: {
    leaseKey: string;
    fenceKey: string;
    owner: string;
    ttlMs: number;
}): Promise<FencedLeaseResult> {
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        `if redis.call("EXISTS", KEYS[1]) == 1 then return {0, "", 0} end
local fence = redis.call("INCR", KEYS[2])
local value = ARGV[1] .. ":" .. tostring(fence)
redis.call("PSETEX", KEYS[1], ARGV[2], value)
return {1, value, fence}`,
        2,
        input.leaseKey,
        input.fenceKey,
        input.owner,
        String(input.ttlMs),
    ) as Array<number | string>;
    return Number(result[0]) === 1
        ? { acquired: true, value: String(result[1]), fence: Number(result[2]) }
        : { acquired: false };
}

/** Renew a fenced lease only while the caller still owns its exact epoch. */
export async function valkeyRenewFencedLease(
    leaseKey: string,
    value: string,
    ttlMs: number,
): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        `if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call("PEXPIRE", KEYS[1], ARGV[2])`,
        1,
        leaseKey,
        value,
        String(ttlMs),
    );
    return Number(result) === 1;
}

/** Release a fenced lease without deleting a successor's ownership. */
export async function valkeyReleaseFencedLease(leaseKey: string, value: string): Promise<boolean> {
    return valkeyCompareAndDelete(leaseKey, value);
}

export type PersistPreparedPaymentIntentResult =
    | "persisted"
    | "replayed"
    | "stale_claim"
    | "stale_lease"
    | "invalid_state";

/**
 * Persist deterministic signed bytes and their identity before broadcast.
 * When an EVM nonce is supplied, advancing the signer nonce cursor is part of
 * the same fenced operation; a crash before this script can safely retry.
 */
export async function valkeyPersistPreparedPaymentIntent(input: {
    intentKey: string;
    claimToken: string;
    leaseKey?: string;
    leaseValue?: string;
    nonceKey?: string;
    nextNonce?: string;
    secondaryNonceKey?: string;
    nextSecondaryNonce?: string;
    preparedTxHash: string;
    preparedTxPayload: string;
    preparedTxNonce?: string;
    preparedAt: number;
}): Promise<PersistPreparedPaymentIntentResult> {
    const valkey = await getValkeyClient();
    const leaseKey = input.leaseKey || "";
    const nonceKey = input.nonceKey || "";
    const secondaryNonceKey = input.secondaryNonceKey && input.secondaryNonceKey !== nonceKey
        ? input.secondaryNonceKey
        : "";
    const keys = [input.intentKey];
    let leaseIndex = 0;
    let nonceIndex = 0;
    let secondaryNonceIndex = 0;
    if (leaseKey) {
        keys.push(leaseKey);
        leaseIndex = keys.length;
    }
    if (nonceKey) {
        keys.push(nonceKey);
        nonceIndex = keys.length;
    }
    if (secondaryNonceKey) {
        keys.push(secondaryNonceKey);
        secondaryNonceIndex = keys.length;
    }
    const result = await valkey.eval(
        `local status = redis.call("HGET", KEYS[1], "status") or ""
if status ~= "queued" then return -3 end
if (redis.call("HGET", KEYS[1], "executionClaimToken") or "") ~= ARGV[1] then return -1 end
local leaseIndex = tonumber(ARGV[7])
if leaseIndex > 0 and redis.call("GET", KEYS[leaseIndex]) ~= ARGV[2] then return -2 end
local existingHash = redis.call("HGET", KEYS[1], "preparedTxHash") or ""
local existingPayload = redis.call("HGET", KEYS[1], "preparedTxPayload") or ""
if existingHash ~= "" or existingPayload ~= "" then
    if existingHash == ARGV[3] and existingPayload == ARGV[4] then return 2 end
    return -3
end
redis.call("HSET", KEYS[1],
    "preparedTxHash", ARGV[3],
    "preparedTxPayload", ARGV[4],
    "preparedTxNonce", ARGV[5],
    "preparedAt", ARGV[6],
    "updatedAt", ARGV[6])
local nonceIndex = tonumber(ARGV[8])
if nonceIndex > 0 then redis.call("SET", KEYS[nonceIndex], ARGV[9]) end
local secondaryNonceIndex = tonumber(ARGV[10])
if secondaryNonceIndex > 0 then redis.call("SET", KEYS[secondaryNonceIndex], ARGV[11]) end
return 1`,
        keys.length,
        ...keys,
        input.claimToken,
        input.leaseValue || "",
        input.preparedTxHash,
        input.preparedTxPayload,
        input.preparedTxNonce || "",
        String(input.preparedAt),
        String(leaseIndex),
        String(nonceIndex),
        input.nextNonce || "",
        String(secondaryNonceIndex),
        input.nextSecondaryNonce || "",
    );
    const code = Number(result);
    if (code === 1) return "persisted";
    if (code === 2) return "replayed";
    if (code === -1) return "stale_claim";
    if (code === -2) return "stale_lease";
    return "invalid_state";
}

export type ClaimedPaymentIntentUpdateResult =
    | "updated"
    | "already_finalized"
    | "stale_claim"
    | "invalid_state";

/** Persist a broadcast transaction hash before beginning receipt polling. */
export async function valkeyMarkClaimedPaymentIntentSubmitted(input: {
    intentKey: string;
    queuedKey: string;
    submittedKey: string;
    intentId: string;
    claimToken: string;
    txHash: string;
    submittedAt: number;
    intentFields?: Record<string, string>;
}): Promise<ClaimedPaymentIntentUpdateResult> {
    const valkey = await getValkeyClient();
    const fields = Object.entries(input.intentFields || {}).flat();
    const result = await valkey.eval(
        `local status = redis.call("HGET", KEYS[1], "status") or ""
if status == "confirmed" or status == "failed" or status == "released" then return 2 end
if (redis.call("HGET", KEYS[1], "executionClaimToken") or "") ~= ARGV[2] then return -1 end
local existingHash = redis.call("HGET", KEYS[1], "txHash") or ""
if status == "submitted" and existingHash == ARGV[3] then return 1 end
if status ~= "queued" or (existingHash ~= "" and existingHash ~= ARGV[3]) then return -2 end
local preparedHash = redis.call("HGET", KEYS[1], "preparedTxHash") or ""
local preparedPayload = redis.call("HGET", KEYS[1], "preparedTxPayload") or ""
if preparedHash ~= ARGV[3] or preparedPayload == "" then return -2 end
redis.call("HSET", KEYS[1],
    "status", "submitted",
    "txHash", ARGV[3],
    "submittedAt", ARGV[4],
    "updatedAt", ARGV[4])
redis.call("HDEL", KEYS[1], "nextAttemptAt")
local pairCount = tonumber(ARGV[5])
local offset = 6
for index = 0, pairCount - 1 do
    redis.call("HSET", KEYS[1], ARGV[offset + index * 2], ARGV[offset + index * 2 + 1])
end
redis.call("SREM", KEYS[2], ARGV[1])
redis.call("SADD", KEYS[3], ARGV[1])
return 1`,
        3,
        input.intentKey,
        input.queuedKey,
        input.submittedKey,
        input.intentId,
        input.claimToken,
        input.txHash,
        String(input.submittedAt),
        String(Object.keys(input.intentFields || {}).length),
        ...fields,
    );
    const code = Number(result);
    if (code === 1) return "updated";
    if (code === 2) return "already_finalized";
    if (code === -1) return "stale_claim";
    return "invalid_state";
}

/**
 * Atomically clear stale/expired transaction preparation (e.g. expired NEAR/SVM
 * blockhash that was never observed on-chain, or ingress InvalidNonce/Expired
 * rejection before inclusion) so the obligation can be re-prepared cleanly.
 */
export async function valkeyResetClaimedPaymentIntentPreparation(input: {
    intentKey: string;
    queuedKey: string;
    submittedKey: string;
    dueKey: string;
    intentId: string;
    claimToken: string;
    expectedTxHash?: string;
    keepClaim?: boolean;
    dueAt: number;
    updatedAt: number;
    errorMessage: string;
    nonceKey?: string;
    minNextNonce?: string;
}): Promise<ClaimedPaymentIntentUpdateResult> {
    const valkey = await getValkeyClient();
    const keys = [input.intentKey, input.queuedKey, input.submittedKey, input.dueKey];
    if (input.nonceKey && input.minNextNonce) {
        keys.push(input.nonceKey);
    }
    const result = await valkey.eval(
        `local function normalize(value)
    local normalized = string.gsub(value or "0", "^0+", "")
    return normalized == "" and "0" or normalized
end
local function greaterThan(left, right)
    left = normalize(left)
    right = normalize(right)
    if string.len(left) ~= string.len(right) then return string.len(left) > string.len(right) end
    return left > right
end
local status = redis.call("HGET", KEYS[1], "status") or ""
if status == "confirmed" or status == "failed" or status == "released" then return 2 end
if (redis.call("HGET", KEYS[1], "executionClaimToken") or "") ~= ARGV[2] then return -1 end
if status ~= "queued" and status ~= "submitted" then return -2 end
local expectedHash = ARGV[3]
if expectedHash ~= "" then
    local existingHash = redis.call("HGET", KEYS[1], "txHash") or ""
    local preparedHash = redis.call("HGET", KEYS[1], "preparedTxHash") or ""
    if existingHash ~= "" and existingHash ~= expectedHash then return -2 end
    if preparedHash ~= "" and preparedHash ~= expectedHash then return -2 end
end
redis.call("HDEL", KEYS[1],
    "txHash",
    "submittedAt",
    "preparedTxHash",
    "preparedTxPayload",
    "preparedTxNonce",
    "preparedSecondaryTxHash",
    "preparedSecondaryPayload",
    "preparedAt")
redis.call("HSET", KEYS[1],
    "status", "queued",
    "updatedAt", ARGV[6],
    "lastError", ARGV[7],
    "error", ARGV[7])
redis.call("SADD", KEYS[2], ARGV[1])
redis.call("SREM", KEYS[3], ARGV[1])
if ARGV[4] == "1" then
    redis.call("HDEL", KEYS[1], "nextAttemptAt")
else
    redis.call("HSET", KEYS[1], "nextAttemptAt", ARGV[5])
    redis.call("HDEL", KEYS[1], "executionClaimToken", "executionClaimedAt", "executionClaimExpiresAt")
    redis.call("ZADD", KEYS[4], ARGV[5], ARGV[1])
end
if #KEYS >= 5 and ARGV[8] ~= "" then
    local currentNonce = redis.call("GET", KEYS[5]) or "0"
    if greaterThan(ARGV[8], currentNonce) then
        redis.call("SET", KEYS[5], normalize(ARGV[8]))
    end
end
return 1`,
        keys.length,
        ...keys,
        input.intentId,
        input.claimToken,
        input.expectedTxHash || "",
        input.keepClaim ? "1" : "0",
        String(input.dueAt),
        String(input.updatedAt),
        input.errorMessage,
        input.minNextNonce || "",
    );
    const code = Number(result);
    if (code === 1) return "updated";
    if (code === 2) return "already_finalized";
    if (code === -1) return "stale_claim";
    return "invalid_state";
}

/** Retain a payable obligation for retry and release its current execution claim. */
export async function valkeyRetainClaimedPaymentIntent(input: {
    intentKey: string;
    queuedKey: string;
    submittedKey: string;
    dueKey: string;
    intentId: string;
    claimToken: string;
    status: "queued" | "submitted";
    txHash?: string;
    dueAt: number;
    intentFields: Record<string, string>;
}): Promise<ClaimedPaymentIntentUpdateResult> {
    const valkey = await getValkeyClient();
    const fields = Object.entries(input.intentFields).flat();
    const result = await valkey.eval(
        `local status = redis.call("HGET", KEYS[1], "status") or ""
if status == "confirmed" or status == "failed" or status == "released" then return 2 end
if (redis.call("HGET", KEYS[1], "executionClaimToken") or "") ~= ARGV[2] then return -1 end
if status ~= "queued" and status ~= "submitted" then return -2 end
local requestedStatus = ARGV[3]
local existingHash = redis.call("HGET", KEYS[1], "txHash") or ""
local requestedHash = ARGV[4]
if status == "submitted" and requestedStatus ~= "submitted" then return -2 end
if existingHash ~= "" and requestedHash ~= "" and existingHash ~= requestedHash then return -2 end
if requestedStatus == "submitted" then
    local preparedHash = redis.call("HGET", KEYS[1], "preparedTxHash") or ""
    local preparedPayload = redis.call("HGET", KEYS[1], "preparedTxPayload") or ""
    if requestedHash == "" or preparedHash ~= requestedHash or preparedPayload == "" then return -2 end
end
redis.call("HSET", KEYS[1], "status", requestedStatus)
if requestedHash ~= "" then redis.call("HSET", KEYS[1], "txHash", requestedHash) end
local pairCount = tonumber(ARGV[6])
local offset = 7
for index = 0, pairCount - 1 do
    redis.call("HSET", KEYS[1], ARGV[offset + index * 2], ARGV[offset + index * 2 + 1])
end
redis.call("HDEL", KEYS[1], "executionClaimToken", "executionClaimedAt", "executionClaimExpiresAt")
if requestedStatus == "submitted" then
    redis.call("SREM", KEYS[2], ARGV[1])
    redis.call("SADD", KEYS[3], ARGV[1])
else
    redis.call("SADD", KEYS[2], ARGV[1])
    redis.call("SREM", KEYS[3], ARGV[1])
end
redis.call("ZADD", KEYS[4], ARGV[5], ARGV[1])
return 1`,
        4,
        input.intentKey,
        input.queuedKey,
        input.submittedKey,
        input.dueKey,
        input.intentId,
        input.claimToken,
        input.status,
        input.txHash || "",
        String(input.dueAt),
        String(Object.keys(input.intentFields).length),
        ...fields,
    );
    const code = Number(result);
    if (code === 1) return "updated";
    if (code === 2) return "already_finalized";
    if (code === -1) return "stale_claim";
    return "invalid_state";
}

export type ReservedBudgetCommitResult =
    | "committed"
    | "already_finalized"
    | "stale_claim"
    | "invalid_state"
    | "inconsistent_reservation";

/** Atomically move a reservation to used budget and finalize its intent. */
export async function valkeyCommitReservedBudget(input: {
    budgetKey: string;
    intentKey: string;
    queuedKey: string;
    submittedKey: string;
    keyIntentsKey: string;
    idempotencyKey: string;
    projectionKey: string;
    dueKey: string;
    intentId: string;
    terminalTtlSeconds: number;
    reservedAmount: string | bigint;
    finalAmount: string | bigint;
    lastUsedAt: number;
    claimToken: string;
    expectedStatuses: string[];
    intentFields: Record<string, string>;
}): Promise<ReservedBudgetCommitResult> {
    const valkey = await getValkeyClient();
    const fields = Object.entries(input.intentFields).flat();
    const result = await valkey.eval(
        `local function normalize(value)
    local normalized = string.gsub(value or "0", "^0+", "")
    return normalized == "" and "0" or normalized
end
local function expireAtLeast(key, ttl)
    if redis.call("EXISTS", key) == 0 then return end
    local current = redis.call("TTL", key)
    if current == -1 or current < ttl then redis.call("EXPIRE", key, ttl) end
end
local function lessThan(left, right)
    left = normalize(left)
    right = normalize(right)
    if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
    return left < right
end
local status = redis.call("HGET", KEYS[2], "status") or ""
if status == "confirmed" then return 2 end
if (redis.call("HGET", KEYS[2], "executionClaimToken") or "") ~= ARGV[4] then return -1 end
if not string.find("|" .. ARGV[5] .. "|", "|" .. status .. "|", 1, true) then return -2 end
local reservedAmount = normalize(ARGV[1])
local storedReservation = normalize(redis.call("HGET", KEYS[2], "reservedAmountWei") or "0")
local storedFinal = normalize(redis.call("HGET", KEYS[2], "finalAmountWei") or "0")
local budgetReserved = normalize(redis.call("HGET", KEYS[1], "budgetReserved") or "0")
local pendingCount = tonumber(redis.call("HGET", KEYS[1], "pendingIntentCount") or "")
if reservedAmount == "0" or storedReservation ~= reservedAmount or storedFinal ~= normalize(ARGV[2]) or lessThan(budgetReserved, reservedAmount) or not pendingCount or pendingCount <= 0 then
    return -3
end
redis.call("HINCRBY", KEYS[1], "budgetReserved", "-" .. reservedAmount)
redis.call("HINCRBY", KEYS[1], "budgetUsed", normalize(ARGV[2]))
pendingCount = redis.call("HINCRBY", KEYS[1], "pendingIntentCount", -1)
redis.call("HSET", KEYS[1], "lastUsedAt", ARGV[3])
local pairCount = tonumber(ARGV[6])
local offset = 7
for index = 0, pairCount - 1 do
    redis.call("HSET", KEYS[2], ARGV[offset + index * 2], ARGV[offset + index * 2 + 1])
end
redis.call("HDEL", KEYS[2], "executionClaimToken", "executionClaimedAt", "executionClaimExpiresAt")
local terminalOffset = offset + pairCount * 2
local intentId = ARGV[terminalOffset]
local terminalTtl = tonumber(ARGV[terminalOffset + 1])
redis.call("SREM", KEYS[3], intentId)
redis.call("SREM", KEYS[4], intentId)
redis.call("SADD", KEYS[7], intentId)
redis.call("ZREM", KEYS[8], intentId)
redis.call("PERSIST", KEYS[2])
redis.call("PERSIST", KEYS[6])
if pendingCount > 0 then
    redis.call("PERSIST", KEYS[1])
    redis.call("PERSIST", KEYS[5])
else
    expireAtLeast(KEYS[1], terminalTtl)
    expireAtLeast(KEYS[5], terminalTtl)
end
return 1`,
        8,
        input.budgetKey,
        input.intentKey,
        input.queuedKey,
        input.submittedKey,
        input.keyIntentsKey,
        input.idempotencyKey,
        input.projectionKey,
        input.dueKey,
        normalizeValkeyInteger(input.reservedAmount),
        normalizeValkeyInteger(input.finalAmount),
        String(input.lastUsedAt),
        input.claimToken,
        input.expectedStatuses.join("|"),
        String(Object.keys(input.intentFields).length),
        ...fields,
        input.intentId,
        String(input.terminalTtlSeconds),
    );
    const code = Number(result);
    if (code === 1) return "committed";
    if (code === 2) return "already_finalized";
    if (code === -1) return "stale_claim";
    if (code === -2) return "invalid_state";
    return "inconsistent_reservation";
}

export type ReservedBudgetReleaseResult =
    | "released"
    | "already_finalized"
    | "stale_claim"
    | "invalid_state"
    | "inconsistent_reservation";

/** Atomically release a reservation and finalize its failed/aborted intent. */
export async function valkeyReleaseReservedBudget(input: {
    budgetKey: string;
    intentKey: string;
    queuedKey: string;
    submittedKey: string;
    keyIntentsKey: string;
    idempotencyKey: string;
    projectionKey: string;
    dueKey: string;
    intentId: string;
    terminalTtlSeconds: number;
    reservedAmount: string | bigint;
    claimToken?: string;
    expectedStatuses: string[];
    intentFields: Record<string, string>;
}): Promise<ReservedBudgetReleaseResult> {
    const valkey = await getValkeyClient();
    const fields = Object.entries(input.intentFields).flat();
    const targetStatus = input.intentFields.status || "released";
    const result = await valkey.eval(
        `local function normalize(value)
    local normalized = string.gsub(value or "0", "^0+", "")
    return normalized == "" and "0" or normalized
end
local function expireAtLeast(key, ttl)
    if redis.call("EXISTS", key) == 0 then return end
    local current = redis.call("TTL", key)
    if current == -1 or current < ttl then redis.call("EXPIRE", key, ttl) end
end
local function lessThan(left, right)
    left = normalize(left)
    right = normalize(right)
    if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
    return left < right
end
local status = redis.call("HGET", KEYS[2], "status") or ""
if status == ARGV[4] then return 2 end
local storedClaim = redis.call("HGET", KEYS[2], "executionClaimToken") or ""
if ARGV[2] ~= "" then
    if storedClaim ~= ARGV[2] then return -1 end
elseif storedClaim ~= "" then
    return -1
end
if not string.find("|" .. ARGV[3] .. "|", "|" .. status .. "|", 1, true) then return -2 end
local reservedAmount = normalize(ARGV[1])
local storedReservation = normalize(redis.call("HGET", KEYS[2], "reservedAmountWei") or "0")
local budgetReserved = normalize(redis.call("HGET", KEYS[1], "budgetReserved") or "0")
local pendingCount = tonumber(redis.call("HGET", KEYS[1], "pendingIntentCount") or "") or 0
local wasPending = status == "queued" or status == "submitted"
if storedReservation ~= reservedAmount or lessThan(budgetReserved, reservedAmount) or (wasPending and pendingCount <= 0) then return -3 end
if reservedAmount ~= "0" then
    redis.call("HINCRBY", KEYS[1], "budgetReserved", "-" .. reservedAmount)
end
if wasPending then pendingCount = redis.call("HINCRBY", KEYS[1], "pendingIntentCount", -1) end
local pairCount = tonumber(ARGV[5])
local offset = 6
for index = 0, pairCount - 1 do
    redis.call("HSET", KEYS[2], ARGV[offset + index * 2], ARGV[offset + index * 2 + 1])
end
redis.call("HDEL", KEYS[2], "executionClaimToken", "executionClaimedAt", "executionClaimExpiresAt")
local terminalOffset = offset + pairCount * 2
local intentId = ARGV[terminalOffset]
local terminalTtl = tonumber(ARGV[terminalOffset + 1])
redis.call("SREM", KEYS[3], intentId)
redis.call("SREM", KEYS[4], intentId)
redis.call("ZREM", KEYS[8], intentId)
if ARGV[4] == "failed" then
    redis.call("SADD", KEYS[7], intentId)
    redis.call("PERSIST", KEYS[2])
    redis.call("PERSIST", KEYS[6])
else
    expireAtLeast(KEYS[2], terminalTtl)
    expireAtLeast(KEYS[6], terminalTtl)
end
if pendingCount > 0 then
    redis.call("PERSIST", KEYS[1])
    redis.call("PERSIST", KEYS[5])
else
    expireAtLeast(KEYS[1], terminalTtl)
    expireAtLeast(KEYS[5], terminalTtl)
end
return 1`,
        8,
        input.budgetKey,
        input.intentKey,
        input.queuedKey,
        input.submittedKey,
        input.keyIntentsKey,
        input.idempotencyKey,
        input.projectionKey,
        input.dueKey,
        normalizeValkeyInteger(input.reservedAmount),
        input.claimToken || "",
        input.expectedStatuses.join("|"),
        targetStatus,
        String(Object.keys(input.intentFields).length),
        ...fields,
        input.intentId,
        String(input.terminalTtlSeconds),
    );
    const code = Number(result);
    if (code === 1) return "released";
    if (code === 2) return "already_finalized";
    if (code === -1) return "stale_claim";
    if (code === -2) return "invalid_state";
    return "inconsistent_reservation";
}

/** Clear a durable projection obligation only after all projections succeed. */
export async function valkeyCompletePaymentIntentProjection(input: {
    projectionKey: string;
    intentKey: string;
    idempotencyKey: string;
    intentId: string;
    terminalTtlSeconds: number;
}): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        `local function expireAtLeast(key, ttl)
    if redis.call("EXISTS", key) == 0 then return end
    local current = redis.call("TTL", key)
    if current == -1 or current < ttl then redis.call("EXPIRE", key, ttl) end
end
local removed = redis.call("SREM", KEYS[1], ARGV[1])
local ttl = tonumber(ARGV[2])
expireAtLeast(KEYS[2], ttl)
expireAtLeast(KEYS[3], ttl)
return removed`,
        3,
        input.projectionKey,
        input.intentKey,
        input.idempotencyKey,
        input.intentId,
        String(input.terminalTtlSeconds),
    );
    return Number(result) === 1;
}

/**
 * Set key expiration
 */
export async function valkeyExpire(key: string, seconds: number): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.expire(key, seconds);
    return Boolean(result);
}

/**
 * Set key only if it does not exist (atomic)
 * Returns true if the key was set, false if it already existed
 */
export async function valkeySetNX(key: string, value: string): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.setnx(key, value);
    return Boolean(result);
}

/**
 * Set key with NX and optional EX (atomic)
 * Returns true if the key was set, false if it already existed
 */
export async function valkeySetNXEX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
}

/** Delete a lease only when it is still owned by the expected token. */
export async function valkeyCompareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
        1,
        key,
        expectedValue,
    );
    return Number(result) > 0;
}

/** Extend a lease TTL only when it is still owned by the expected token. */
export async function valkeyCompareAndExpire(key: string, expectedValue: string, ttlSeconds: number): Promise<boolean> {
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end',
        1,
        key,
        expectedValue,
        ttlSeconds,
    );
    return Number(result) > 0;
}

/**
 * Increment a key by integer
 */
export async function valkeyIncr(key: string): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.incr(key);
}

/**
 * Increment a key by integer (with amount)
 */
export async function valkeyIncrBy(key: string, increment: number): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.incrby(key, increment);
}

/**
 * Get TTL of a key in seconds
 * Returns -2 if key does not exist, -1 if key has no expiry
 */
export async function valkeyTTL(key: string): Promise<number> {
    const valkey = await getValkeyClient();
    return valkey.ttl(key);
}
