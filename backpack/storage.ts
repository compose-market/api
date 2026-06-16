import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;
let pending: Promise<RedisClientType> | null = null;

function env(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Backpack Redis configuration missing: ${name}`);
    }
    return value;
}

function endpoint(value: string): { host: string; port: number } {
    const [host, raw] = value.split(":");
    const port = Number.parseInt(raw || "", 10);
    if (!host || !Number.isInteger(port) || port <= 0) {
        throw new Error("REDIS_BACKPACK_DATABASE_PUBLIC_ENDPOINT must be host:port");
    }
    return { host, port };
}

async function connect(): Promise<RedisClientType> {
    const { host, port } = endpoint(env("REDIS_BACKPACK_DATABASE_PUBLIC_ENDPOINT"));
    const password = env("REDIS_BACKPACK_DEFAULT_PASSWORD");
    env("REDIS_BACKPACK_API_KEY");
    const tls = process.env.REDIS_TLS === "true";

    client = createClient({
        password,
        socket: tls ? { host, port, tls: true as const } : { host, port },
    });
    client.on("error", (error) => console.error("[backpack:redis] client error", error));
    await client.connect();
    return client;
}

export async function redis(): Promise<RedisClientType> {
    if (client?.isOpen) return client;
    if (!pending) {
        pending = connect().finally(() => {
            pending = null;
        });
    }
    return pending;
}

export async function close(): Promise<void> {
    if (client?.isOpen) {
        await client.quit();
    }
    client = null;
    pending = null;
}

function part(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        throw new Error("Redis key part cannot be empty");
    }
    return encodeURIComponent(normalized);
}

export function key(...parts: string[]): string {
    const prefix = process.env.BACKPACK_REDIS_PREFIX?.trim() || "backpack";
    return [prefix, ...parts.map(part)].join(":");
}

export async function get(name: string): Promise<string | null> {
    return (await redis()).get(name);
}

export async function take(name: string): Promise<string | null> {
    const db = await redis();
    const getDel = (db as unknown as { getDel?: (key: string) => Promise<string | null> }).getDel;
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
    const db = await redis();
    if (ttl && ttl > 0) {
        await db.setEx(name, ttl, value);
        return;
    }
    await db.set(name, value);
}

export async function once(name: string, value: string, ttl: number): Promise<boolean> {
    const result = await (await redis()).set(name, value, { NX: true, EX: ttl });
    return result === "OK";
}

export async function del(...names: string[]): Promise<number> {
    if (names.length === 0) return 0;
    return (await redis()).del(names);
}

export async function add(name: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return (await redis()).sAdd(name, members);
}

export async function rem(name: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return (await redis()).sRem(name, members);
}

export async function members(name: string): Promise<string[]> {
    return (await redis()).sMembers(name);
}

export async function push(name: string, value: string, limit: number, ttl: number): Promise<void> {
    const db = await redis();
    await db.rPush(name, value);
    await db.lTrim(name, -Math.max(1, limit), -1);
    await db.expire(name, ttl);
}

export async function range(name: string, start = 0, stop = -1): Promise<string[]> {
    return (await redis()).lRange(name, start, stop);
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
