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
    const uri = process.env.VALKEY_KEYS_SERVICE_URI;

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
