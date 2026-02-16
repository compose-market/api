/**
 * Redis Client Module
 * 
 * Redis connection and operations for Lambda.
 * Uses cloud.redis.io with TLS.
 * 
 * @module shared/config/redis
 */

import { createClient, type RedisClientType } from "redis";

// =============================================================================
// Client Singleton
// =============================================================================

let client: RedisClientType | null = null;
let connectionPromise: Promise<RedisClientType> | null = null;

/**
 * Get Redis client connection
 * Uses singleton pattern with lazy initialization
 */
export async function getRedisClient(): Promise<RedisClientType> {
    if (client?.isOpen) {
        return client;
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = connect();
    return connectionPromise;
}

async function connect(): Promise<RedisClientType> {
    const endpoint = process.env.REDIS_DATABASE_PUBLIC_ENDPOINT;
    const password = process.env.REDIS_DEFAULT_PASSWORD;
    const useTls = process.env.REDIS_TLS === "true";

    if (!endpoint || !password) {
        throw new Error("Redis configuration missing: REDIS_DATABASE_PUBLIC_ENDPOINT and REDIS_DEFAULT_PASSWORD required");
    }

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10);

    console.log(`[redis] Connecting to ${host}:${port} (TLS: ${useTls})`);

    client = createClient({
        socket: useTls ? {
            host,
            port,
            tls: true as const,
        } : {
            host,
            port,
        },
        password,
    });

    client.on("error", (err) => {
        console.error("[redis] Client error:", err);
    });

    client.on("reconnecting", () => {
        console.log("[redis] Reconnecting...");
    });

    await client.connect();
    console.log("[redis] Connected successfully");

    return client;
}

/**
 * Close Redis connection
 * Call during cleanup/shutdown
 */
export async function closeRedis(): Promise<void> {
    if (client?.isOpen) {
        await client.quit();
        client = null;
        connectionPromise = null;
        console.log("[redis] Connection closed");
    }
}

// =============================================================================
// Key-Value Operations
// =============================================================================

/**
 * Set a value with optional TTL
 */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const redis = await getRedisClient();
    if (ttlSeconds) {
        await redis.setEx(key, ttlSeconds, value);
    } else {
        await redis.set(key, value);
    }
}

/**
 * Get a value
 */
export async function redisGet(key: string): Promise<string | null> {
    const redis = await getRedisClient();
    return redis.get(key);
}

/**
 * Delete a key
 */
export async function redisDel(key: string): Promise<boolean> {
    const redis = await getRedisClient();
    const result = await redis.del(key);
    return result > 0;
}

/**
 * Check if key exists
 */
export async function redisExists(key: string): Promise<boolean> {
    const redis = await getRedisClient();
    const result = await redis.exists(key);
    return result > 0;
}

/**
 * Set hash field(s)
 * Supports both single field/value and object of multiple fields
 */
export async function redisHSet(
    key: string,
    fieldOrData: string | Record<string, string>,
    value?: string
): Promise<void> {
    const redis = await getRedisClient();

    if (typeof fieldOrData === "string") {
        // Single field/value mode
        if (value === undefined) {
            throw new Error("redisHSet: value required when field is string");
        }
        await redis.hSet(key, fieldOrData, value);
    } else {
        // Object mode - set multiple fields at once
        for (const [field, val] of Object.entries(fieldOrData)) {
            await redis.hSet(key, field, val);
        }
    }
}

/**
 * Get a hash field
 */
export async function redisHGet(key: string, field: string): Promise<string | undefined> {
    const redis = await getRedisClient();
    const result = await redis.hGet(key, field);
    return result ?? undefined;
}

/**
 * Get all hash fields
 */
export async function redisHGetAll(key: string): Promise<Record<string, string>> {
    const redis = await getRedisClient();
    return redis.hGetAll(key);
}

/**
 * Delete hash fields
 */
export async function redisHDel(key: string, ...fields: string[]): Promise<number> {
    const redis = await getRedisClient();
    return redis.hDel(key, fields);
}

/**
 * Add to a set
 */
export async function redisSAdd(key: string, ...members: string[]): Promise<number> {
    const redis = await getRedisClient();
    return redis.sAdd(key, members);
}

/**
 * Get all set members
 */
export async function redisSMembers(key: string): Promise<string[]> {
    const redis = await getRedisClient();
    return redis.sMembers(key);
}

/**
 * Check set membership
 */
export async function redisSIsMember(key: string, member: string): Promise<boolean> {
    const redis = await getRedisClient();
    const result = await redis.sIsMember(key, member);
    return Boolean(result);
}

/**
 * Remove from a set
 */
export async function redisSRem(key: string, ...members: string[]): Promise<number> {
    const redis = await getRedisClient();
    return redis.sRem(key, members);
}

/**
 * Increment a hash field by integer
 */
export async function redisHIncrBy(key: string, field: string, increment: number): Promise<number> {
    const redis = await getRedisClient();
    return redis.hIncrBy(key, field, increment);
}

/**
 * Set key expiration
 */
export async function redisExpire(key: string, seconds: number): Promise<boolean> {
    const redis = await getRedisClient();
    const result = await redis.expire(key, seconds);
    return Boolean(result);
}

/**
 * Set key only if it does not exist (atomic)
 * Returns true if the key was set, false if it already existed
 */
export async function redisSetNX(key: string, value: string): Promise<boolean> {
    const redis = await getRedisClient();
    const result = await redis.setNX(key, value);
    return result;
}

/**
 * Set key with NX and optional EX (atomic)
 * Returns true if the key was set, false if it already existed
 */
export async function redisSetNXEX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const redis = await getRedisClient();
    const result = await redis.set(key, value, {
        NX: true,
        EX: ttlSeconds,
    });
    return result === "OK";
}

/**
 * Increment a key by integer
 */
export async function redisIncr(key: string): Promise<number> {
    const redis = await getRedisClient();
    return redis.incr(key);
}

/**
 * Increment a key by integer (with amount)
 */
export async function redisIncrBy(key: string, increment: number): Promise<number> {
    const redis = await getRedisClient();
    return redis.incrBy(key, increment);
}

/**
 * Get TTL of a key in seconds
 * Returns -2 if key does not exist, -1 if key has no expiry
 */
export async function redisTTL(key: string): Promise<number> {
    const redis = await getRedisClient();
    return redis.ttl(key);
}
