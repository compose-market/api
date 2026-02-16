/**
 * Session Expiry Worker
 * 
 * Runs every minute to check for expired sessions and notify WebSocket clients.
 * Scans compose-key:* entries for recently expired sessions.
 * 
 * @module shared/keys/expiry
 */

import type { ScheduledEvent, Context } from "aws-lambda";
import { redisSMembers, redisDel, redisSAdd, redisHGetAll, getRedisClient } from "../configs/redis.js";
import { notifyExpired } from "./ws.js";

const NOTIFY_KEY = "ws:notify:";
const KEY_PREFIX = "compose-key:";
const USER_KEYS_PREFIX = "user-key:";
const SUB_KEY = "ws:sub:";

export async function expiryWorker(
    _event: ScheduledEvent,
    _ctx: Context
): Promise<void> {
    console.log("[expiry] Scanning for expired sessions...");

    const domain = process.env.WS_DOMAIN || "api.compose.market";
    const stage = process.env.STAGE || "$default";

    try {
        const pending = await redisSMembers(NOTIFY_KEY);

        const toNotify: Array<{ addr: string; chainId: number }> = [];

        for (const item of pending) {
            const [addr, chainIdStr] = item.split(":");
            const chainId = parseInt(chainIdStr, 10);
            toNotify.push({ addr, chainId });
        }

        const subKeys = await scanKeys(SUB_KEY);
        for (const subKey of subKeys) {
            const parts = subKey.replace(SUB_KEY, "").split(":");
            if (parts.length === 2) {
                const [addr, chainIdStr] = parts;
                const chainId = parseInt(chainIdStr, 10);
                const conns = await redisSMembers(subKey);
                if (conns.length > 0 && !toNotify.some(n => n.addr === addr && n.chainId === chainId)) {
                    const keyData = await findLatestKey(addr, chainId);
                    if (keyData && keyData.expiresAt < Date.now()) {
                        toNotify.push({ addr, chainId });
                    }
                }
            }
        }

        for (const { addr, chainId } of toNotify) {
            try {
                await notifyExpired(addr, chainId, domain, stage);
            } catch (err) {
                console.error(`[expiry] Failed to notify ${addr}:${chainId}:`, err);
            }
        }

        if (pending.length > 0) {
            await redisDel(NOTIFY_KEY);
        }

        console.log(`[expiry] Notified ${toNotify.length} expirations`);
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

async function findLatestKey(userAddress: string, chainId: number): Promise<{ expiresAt: number } | null> {
    const userKeysKey = `${USER_KEYS_PREFIX}${userAddress.toLowerCase()}`;
    const keyIds = await redisSMembers(userKeysKey);
    let latest: { expiresAt: number } | null = null;

    for (const keyId of keyIds) {
        const data = await redisHGetAll(`${KEY_PREFIX}${keyId}`);
        if (data && data.chainId === String(chainId)) {
            const expiresAt = parseInt(data.expiresAt, 10);
            if (!latest || expiresAt > latest.expiresAt) {
                latest = { expiresAt };
            }
        }
    }

    return latest;
}

export async function scheduleExpiryNotify(
    userAddress: string,
    chainId: number,
    expiresAt?: number
): Promise<void> {
    const addr = userAddress.toLowerCase();
    const item = `${addr}:${chainId}`;

    // If expiresAt is provided, we can do additional logic (like checking TTL)
    // but the primary action is to record it in the central notify set.
    if (expiresAt) {
        const now = Date.now();
        const ttlMs = expiresAt - now;
        if (ttlMs < 0) {
            console.log(`[expiry] Already expired: ${item}`);
        }
    }

    await redisSAdd(NOTIFY_KEY, item);
    console.log(`[expiry] Scheduled expiry notification for ${item}`);
}