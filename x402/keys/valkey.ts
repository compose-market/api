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
    });

    await instance.connect();
    await instance.ping();
    client = instance;
    connectionPromise = null;
    console.log("[valkey] Connected successfully");

    return instance;
}

/**
 * Close ValKey connection
 * Call during cleanup/shutdown
 */
export async function closeValkey(): Promise<void> {
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

function throwTransactionFailure(results: Array<[Error | null, unknown]> | null): void {
    if (!results) throw new Error("ValKey transaction was aborted");
    const failure = results.find(([error]) => error);
    if (failure?.[0]) throw failure[0];
}

/** Atomically move a reservation to used budget and finalize its intent. */
export async function valkeyCommitReservedBudget(input: {
    budgetKey: string;
    intentKey: string;
    reservedAmount: string | bigint;
    finalAmount: string | bigint;
    lastUsedAt: number;
    intentFields: Record<string, string>;
}): Promise<void> {
    const valkey = await getValkeyClient();
    const transaction = valkey.multi();
    transaction.hincrby(input.budgetKey, "budgetReserved", (-BigInt(input.reservedAmount)).toString());
    transaction.hincrby(input.budgetKey, "budgetUsed", normalizeValkeyInteger(input.finalAmount));
    transaction.hset(input.budgetKey, "lastUsedAt", String(input.lastUsedAt));
    transaction.hset(input.intentKey, input.intentFields);
    throwTransactionFailure(await transaction.exec());
}

/** Atomically release a reservation and finalize its failed/aborted intent. */
export async function valkeyReleaseReservedBudget(input: {
    budgetKey: string;
    intentKey: string;
    reservedAmount: string | bigint;
    intentFields: Record<string, string>;
}): Promise<void> {
    const valkey = await getValkeyClient();
    const transaction = valkey.multi();
    transaction.hincrby(input.budgetKey, "budgetReserved", (-BigInt(input.reservedAmount)).toString());
    transaction.hset(input.intentKey, input.intentFields);
    throwTransactionFailure(await transaction.exec());
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
