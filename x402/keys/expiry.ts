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
    valkeyHGetAll,
    valkeySMembers,
    valkeySRem,
    getValkeyClient,
} from "./valkey.js";
import { publishDomainInvalidationBestEffort } from "../../data/shared/updates.js";

const USER_KEYS_PREFIX = "user-keys:";
const KEY_PREFIX = "key:";

function ownerFromUserKeyIndex(index: string): string | null {
    const separator = index.lastIndexOf(":");
    if (!index.startsWith(USER_KEYS_PREFIX) || separator <= USER_KEYS_PREFIX.length) return null;
    return index.slice(separator + 1) || null;
}

export async function expiryWorker(
    _event: ScheduledEvent,
    _ctx: Context,
): Promise<void> {
    console.log("[expiry] Running session maintenance...");

    let staleRefsRemoved = 0;

    try {
        const userKeyIndexes = await scanKeys(USER_KEYS_PREFIX);
        for (const userKeyIndex of userKeyIndexes) {
            const keyIds = await valkeySMembers(userKeyIndex);
            for (const keyId of keyIds) {
                const record = await valkeyHGetAll(`${KEY_PREFIX}${keyId}`);
                if (!record || Object.keys(record).length === 0) {
                    const removed = await valkeySRem(userKeyIndex, keyId);
                    if (removed > 0) {
                        staleRefsRemoved += 1;
                        const ownerAddress = ownerFromUserKeyIndex(userKeyIndex);
                        if (ownerAddress) {
                            await publishDomainInvalidationBestEffort("keys", ownerAddress, "expired");
                        }
                    }
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
    const valkey = await getValkeyClient();
    const keys: string[] = [];
    let cursor = "0";

    do {
        const [nextCursor, keys2] = await valkey.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
        cursor = nextCursor;
        keys.push(...keys2);
    } while (cursor !== "0");

    return keys;
}
