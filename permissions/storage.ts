import { Redis as ValkeyClient } from "ioredis";

type ValkeyClientType = ValkeyClient;
const VALKEY_COMMAND_TIMEOUT_MS = 500;
const VALKEY_KEEP_ALIVE_MS = 10_000;

let client: ValkeyClientType | null = null;
let pending: Promise<ValkeyClientType> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

// Aiven Valkey closes connections idle at the protocol level after
// `valkey_timeout` (default 300s); TCP keepalive does not reset that timer.
// A periodic PING keeps the connection warm and a failed PING forces a clean
// reconnect before user traffic hits a half-open socket.
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

function env(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Backpack ValKey configuration missing: ${name}`);
    }
    return value;
}

async function connect(): Promise<ValkeyClientType> {
    const uri = env("VALKEY_BACKPACK_SERVICE_URI");

    // The rediss:// scheme already enables TLS in ioredis.
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
    instance.on("error", (error) => console.error("[backpack:valkey] client error", error));
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
        try {
            instance.disconnect(false);
        } catch {
            // Already closed.
        }
        throw error;
    }
    const stream = (instance as unknown as { stream?: { unref?: () => void } }).stream;
    stream?.unref?.();
    client = instance;
    startKeepAlive(instance);
    return instance;
}

export async function valkey(): Promise<ValkeyClientType> {
    if (client?.status === "ready") return client;
    if (!pending) {
        pending = connect().finally(() => {
            pending = null;
        });
    }
    return pending;
}

export async function close(): Promise<void> {
    stopKeepAlive();
    if (client) {
        await client.quit();
    }
    client = null;
    pending = null;
}

function part(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error("ValKey key part cannot be empty");
    }
    const normalized = /^0[xs][a-fA-F0-9]{40}$/u.test(trimmed) ? trimmed.toLowerCase() : trimmed;
    return encodeURIComponent(normalized);
}

export function key(...parts: string[]): string {
    const prefix = process.env.BACKPACK_VALKEY_PREFIX?.trim() || "backpack";
    return [prefix, ...parts.map(part)].join(":");
}

export async function get(name: string): Promise<string | null> {
    return (await valkey()).get(name);
}

export async function set(name: string, value: string, ttl?: number): Promise<void> {
    const db = await valkey();
    if (ttl && ttl > 0) {
        await db.setex(name, ttl, value);
        return;
    }
    await db.set(name, value);
}

export async function del(...names: string[]): Promise<number> {
    if (names.length === 0) return 0;
    return (await valkey()).del(names);
}

export async function add(name: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return (await valkey()).sadd(name, ...members);
}

export async function rem(name: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return (await valkey()).srem(name, ...members);
}

export async function members(name: string): Promise<string[]> {
    return (await valkey()).smembers(name);
}

export async function warm(): Promise<void> {
    if (!process.env.VALKEY_BACKPACK_SERVICE_URI?.trim()) return;
    await valkey().catch(() => undefined);
}

export async function json<T>(name: string): Promise<T | null> {
    const raw = await get(name);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        await del(name);
        return null;
    }
}

export async function mgetJson<T>(names: string[]): Promise<Array<T | null>> {
    if (names.length === 0) return [];
    const raws = await (await valkey()).mget(...names);
    const corrupt: string[] = [];
    const out = raws.map((raw, idx) => {
        if (!raw) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            corrupt.push(names[idx]);
            return null;
        }
    });
    if (corrupt.length > 0) {
        await del(...corrupt).catch(() => undefined);
    }
    return out;
}

export async function put(name: string, value: unknown, ttl?: number): Promise<void> {
    await set(name, JSON.stringify(value), ttl);
}
