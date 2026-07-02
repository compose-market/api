import { Redis as ValkeyClient } from "ioredis";

type ValkeyClientType = ValkeyClient;
const VALKEY_COMMAND_TIMEOUT_MS = 500;
const VALKEY_KEEP_ALIVE_MS = 10_000;

let client: ValkeyClientType | null = null;
let pending: Promise<ValkeyClientType> | null = null;

function env(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Backpack ValKey configuration missing: ${name}`);
    }
    return value;
}

async function connect(): Promise<ValkeyClientType> {
    const uri = env("VALKEY_BACKPACK_SERVICE_URI");
    const tls = process.env.VALKEY_TLS === "true";

    const instance = new ValkeyClient(uri, {
        connectTimeout: 2000,
        retryStrategy: (times: number) => Math.min(times * 50, 500),
        maxRetriesPerRequest: 1,
        commandTimeout: VALKEY_COMMAND_TIMEOUT_MS,
        enableOfflineQueue: false,
        enableAutoPipelining: true,
        lazyConnect: true,
        keepAlive: VALKEY_KEEP_ALIVE_MS,
        ...(tls ? {} : {}),
    });
    instance.on("error", (error) => console.error("[backpack:valkey] client error", error));
    instance.on("end", () => {
        if (client === instance && instance.status !== "ready") {
            client = null;
        }
    });
    await instance.connect();
    await instance.ping();
    client = instance;
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
    if (client) {
        await client.quit();
    }
    client = null;
    pending = null;
}

function part(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        throw new Error("ValKey key part cannot be empty");
    }
    return encodeURIComponent(normalized);
}

export function key(...parts: string[]): string {
    const prefix = process.env.BACKPACK_VALKEY_PREFIX?.trim() || "backpack";
    return [prefix, ...parts.map(part)].join(":");
}

export async function get(name: string): Promise<string | null> {
    return (await valkey()).get(name);
}

export async function take(name: string): Promise<string | null> {
    const db = await valkey();
    const getDel = (db as unknown as { getdel?: (key: string) => Promise<string | null> }).getdel;
    if (typeof getDel === "function") {
        return getDel.call(db, name);
    }
    const value = await db.get(name);
    if (value) {
        await db.del(name);
    }
    return value;
}

export async function set(name: string, value: string, ttl?: number): Promise<void> {
    const db = await valkey();
    if (ttl && ttl > 0) {
        await db.setex(name, ttl, value);
        return;
    }
    await db.set(name, value);
}

export async function once(name: string, value: string, ttl: number): Promise<boolean> {
    const result = await (await valkey()).set(name, value, "EX", ttl, "NX");
    return result === "OK";
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

export async function push(name: string, value: string, limit: number, ttl: number): Promise<void> {
    const db = await valkey();
    const pipeline = db.pipeline();
    pipeline.rpush(name, value);
    pipeline.ltrim(name, -Math.max(1, limit), -1);
    pipeline.expire(name, ttl);
    await pipeline.exec();
}

export async function range(name: string, start = 0, stop = -1): Promise<string[]> {
    return (await valkey()).lrange(name, start, stop);
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

export async function put(name: string, value: unknown, ttl?: number): Promise<void> {
    await set(name, JSON.stringify(value), ttl);
}
