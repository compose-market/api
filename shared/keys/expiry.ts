/**
 * Session Maintenance Worker
 *
 * Cloud Run job that keeps key indexes clean.
 *
 * @module shared/keys/expiry
 */

type ScheduledEvent = { source?: string };
type Context = Record<string, unknown>;

import {
    redisHGetAll,
    redisSMembers,
    redisSRem,
    getRedisClient,
} from "../configs/redis.js";

const USER_KEYS_PREFIX = "user-keys:";
const KEY_PREFIX = "compose-key:";

export async function expiryWorker(
    _event: ScheduledEvent,
    _ctx: Context,
): Promise<void> {
    console.log("[expiry] Running session maintenance...");

    let staleRefsRemoved = 0;

    try {
        const userKeyIndexes = await scanKeys(USER_KEYS_PREFIX);
        for (const userKeyIndex of userKeyIndexes) {
            const keyIds = await redisSMembers(userKeyIndex);
            for (const keyId of keyIds) {
                const record = await redisHGetAll(`${KEY_PREFIX}${keyId}`);
                if (!record || Object.keys(record).length === 0) {
                    await redisSRem(userKeyIndex, keyId);
                    staleRefsRemoved += 1;
                }
            }
        }

        console.log(
            `[expiry] Complete. stale_refs_removed=${staleRefsRemoved}`,
        );
    } catch (err) {
        console.error("[expiry] Error:", err);
        throw err;
    }
}

async function scanKeys(prefix: string): Promise<string[]> {
    const redis = await getRedisClient();
    const keys: string[] = [];
    let cursor = "0";

    do {
        const result = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
        cursor = result.cursor;
        keys.push(...result.keys);
    } while (cursor !== "0");

    return keys;
}
