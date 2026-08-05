import { getValkeyClient } from "../../x402/keys/valkey.js";
import { bumpSessionSnapshot } from "./cache.js";
import { ensure, getState, rows, setState, stateUpdatedAt } from "./db.js";
import type { NetworkId } from "../../x402/configs/chains.js";

export interface SessionRecord {
    keyId: string;
    userAddress?: string;
    network?: NetworkId;
    createdAt?: number | Date;
}

function createdDate(value: number | Date | undefined): string | null {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return new Date(value).toISOString();
    }
    return null;
}

function parseBaseline(value: string | undefined): number {
    if (!value) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function latest(values: Array<string | undefined>): string | undefined {
    const times = values
        .map((value) => value ? Date.parse(value) : NaN)
        .filter((value) => Number.isFinite(value));

    if (times.length === 0) {
        return undefined;
    }

    return new Date(Math.max(...times)).toISOString();
}

export async function recordSession(input: SessionRecord): Promise<boolean> {
    await ensure();
    const result = await rows<{ inserted: number }>(
        `INSERT INTO sessions (key_id, user_address, network, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key_id) DO NOTHING
         RETURNING 1 AS inserted`,
        [
            input.keyId,
            input.userAddress ?? null,
            input.network ?? null,
            createdDate(input.createdAt),
        ],
    );
    if (result.length > 0) {
        await setState("sessions", new Date().toISOString());
        await bumpSessionSnapshot();
        return true;
    }
    return false;
}

function purpose(value: string | undefined): "session" | "api" | undefined {
    return value === "session" || value === "api" ? value : undefined;
}

export async function syncSessionsFromValkey(): Promise<{ scanned: number; inserted: number }> {
    const valkey = await getValkeyClient();
    let scanned = 0;
    let inserted = 0;

    let cursor = "0";
    do {
        const [nextCursor, keys] = await valkey.scan(cursor, "MATCH", "key:*", "COUNT", 500);
        cursor = nextCursor;
        for (const raw of keys) {
            const recordKey = String(raw);
            if (recordKey.startsWith("key:revoked:")) {
                continue;
            }
            const record = await valkey.hgetall(recordKey);
            if (!record.keyId || purpose(record.purpose) !== "session") {
                continue;
            }

            scanned += 1;
            if (await recordSession({
                keyId: record.keyId,
                userAddress: record.userAddress,
                network: record.network as NetworkId | undefined,
                createdAt: record.createdAt ? Number.parseInt(record.createdAt, 10) : undefined,
            })) {
                inserted += 1;
            }
        }
    } while (cursor !== "0");

    await setState("sessions:seed", new Date().toISOString());
    return { scanned, inserted };
}

export async function setSessionBaseline(total: number): Promise<number> {
    if (!Number.isSafeInteger(total) || total < 0) {
        throw new Error("Session baseline must be a non-negative safe integer");
    }

    await ensure();
    await setState("sessions:baseline", String(total));
    return total;
}

export async function sessionBaseline(): Promise<number> {
    return parseBaseline(await getState("sessions:baseline"));
}

export async function sessionTotals(): Promise<{ total: number; daily: number; updatedAt?: string }> {
    await ensure();
    const [result, daily, baseline, sessionsUpdatedAt, baselineUpdatedAt] = await Promise.all([
        rows<{ total?: string | number }>(
            `SELECT count(*) AS total FROM sessions`,
        ),
        rows<{ total?: string | number }>(
            `SELECT count(*) AS total
             FROM sessions
             WHERE created_at >= date_trunc('day', now())`,
        ),
        sessionBaseline(),
        stateUpdatedAt("sessions"),
        stateUpdatedAt("sessions:baseline"),
    ]);
    return {
        total: Number(result[0]?.total ?? 0) + baseline,
        daily: Number(daily[0]?.total ?? 0),
        updatedAt: latest([sessionsUpdatedAt, baselineUpdatedAt]),
    };
}
