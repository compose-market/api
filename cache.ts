import { Redis } from "ioredis";

export interface Store {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

interface Entry<T = unknown> {
  value: T;
  expiresAt: number;
}

const MAX_L1_ENTRIES = 10_000;
const CONNECT_TIMEOUT_MS = 2_500;
const COMMAND_TIMEOUT_MS = 1_500;
const KEEP_ALIVE_MS = 10_000;
const KEEPALIVE_PING_MS = 60_000;
const RECONNECT_COOLDOWN_MS = 10_000;

const l1 = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

let client: Redis | null = null;
let override: Store | null = null;
let connecting: Promise<Redis | null> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let retryAfter = 0;

function isTestProcess(): boolean {
  return process.execArgv.includes("--test")
    || process.argv.includes("--test")
    || Boolean(process.env.NODE_TEST_CONTEXT);
}

function isCacheEnabled(): boolean {
  if (override) return true;
  if (!isTestProcess()) return true;
  return process.env.TEST_CACHE_ENABLED === "true";
}

function startKeepAlive(instance: Redis): void {
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
  }, KEEPALIVE_PING_MS);
  keepAliveTimer.unref?.();
}

function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function cacheTarget(): { uri: string; password?: string; tls: boolean } | null {
  const uri = process.env.VALKEY_CACHE_SERVICE_URI?.trim();
  const password = process.env.VALKEY_CACHE_PASSWORD?.trim();
  const tls = process.env.VALKEY_TLS === "true";

  if (uri) {
    return {
      uri,
      ...(password ? { password } : {}),
      tls: tls || uri.startsWith("rediss://"),
    };
  }

  const host = process.env.VALKEY_CACHE_HOST?.trim();
  if (host) {
    const scheme = tls ? "rediss" : "redis";
    return {
      uri: `${scheme}://${host}`,
      ...(password ? { password } : {}),
      tls,
    };
  }

  return null;
}

async function connect(): Promise<Redis | null> {
  const target = cacheTarget();
  if (!target) return null;

  const instance = new Redis(target.uri, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    retryStrategy: (times: number) => Math.min(times * 100, 3_000),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableAutoPipelining: true,
    lazyConnect: true,
    keepAlive: KEEP_ALIVE_MS,
    ...(target.password ? { password: target.password } : {}),
    ...(target.tls ? { tls: {} } : {}),
  });

  instance.on("ready", () => {
    const stream = (instance as unknown as { stream?: { unref?: () => void } }).stream;
    stream?.unref?.();
  });

  instance.on("error", (err) => {
    console.warn("[cache] Valkey client error:", err.message);
  });

  instance.on("end", () => {
    if (client === instance && instance.status !== "ready") {
      client = null;
    }
    stopKeepAlive();
  });

  try {
    await instance.connect();
    await instance.ping();
    const stream = (instance as unknown as { stream?: { unref?: () => void } }).stream;
    stream?.unref?.();
    client = instance;
    retryAfter = 0;
    startKeepAlive(instance);
    return instance;
  } catch (error) {
    retryAfter = Date.now() + RECONNECT_COOLDOWN_MS;
    console.warn("[cache] Valkey unavailable, serving from L1:", error instanceof Error ? error.message : String(error));
    try {
      instance.disconnect(false);
    } catch {
      // Ignore cleanup failure.
    }
    return null;
  }
}

async function store(): Promise<Store | null> {
  if (override) return override;
  if (!isCacheEnabled()) return null;
  if (client?.status === "ready") return client;
  if (Date.now() < retryAfter) return null;
  if (connecting) return connecting;

  connecting = connect().finally(() => {
    connecting = null;
  });
  return connecting;
}

export function setCacheStore(next: Store | null): void {
  override = next;
}

export async function closeCache(): Promise<void> {
  stopKeepAlive();
  if (client) {
    await client.quit().catch(() => {
      client?.disconnect(false);
    });
    client = null;
  }
  connecting = null;
  retryAfter = 0;
}

export function l1Get<T>(key: string): T | undefined {
  if (!isCacheEnabled()) return undefined;
  const entry = l1.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    l1.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function l1Set<T>(key: string, value: T, ttlMs: number): void {
  if (!isCacheEnabled() || ttlMs <= 0) return;
  if (l1.size >= MAX_L1_ENTRIES && !l1.has(key)) {
    const oldestKey = l1.keys().next().value;
    if (oldestKey !== undefined) l1.delete(oldestKey);
  }
  l1.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function l1Del(...keys: string[]): void {
  for (const key of keys) {
    if (key) l1.delete(key);
  }
}

export function l1Clear(): void {
  l1.clear();
}

export async function cacheGet<T>(key: string, l1TtlMs = 30_000): Promise<T | undefined> {
  const hit = l1Get<T>(key);
  if (hit !== undefined) return hit;
  const l2 = await store();
  if (!l2) return undefined;
  try {
    const raw = await l2.get(key);
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as T;
    l1Set(key, parsed, l1TtlMs);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function cacheMGet<T>(keys: string[], l1TtlMs = 30_000): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (keys.length === 0) return result;
  const missing: string[] = [];
  for (const key of keys) {
    const hit = l1Get<T>(key);
    if (hit !== undefined) {
      result.set(key, hit);
    } else {
      missing.push(key);
    }
  }
  if (missing.length === 0) return result;
  const l2 = await store();
  if (!l2) return result;
  try {
    const raws = await l2.mget(...missing);
    for (let i = 0; i < missing.length; i += 1) {
      const raw = raws[i];
      if (raw !== null && raw !== undefined) {
        const parsed = JSON.parse(raw) as T;
        l1Set(missing[i], parsed, l1TtlMs);
        result.set(missing[i], parsed);
      }
    }
  } catch {
    // Non-fatal L2 read failure.
  }
  return result;
}

export async function cacheSet<T>(
  key: string,
  value: T,
  l2TtlSeconds = 300,
  l1TtlMs = Math.min(l2TtlSeconds * 1_000, 60_000),
): Promise<void> {
  l1Set(key, value, l1TtlMs);
  const l2 = await store();
  if (!l2) return;
  try {
    await l2.set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(l2TtlSeconds)));
  } catch {
    // Non-fatal L2 write failure; L1 still serves in-process.
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const valid = keys.filter(Boolean);
  if (valid.length === 0) return;
  l1Del(...valid);
  const l2 = await store();
  if (!l2) return;
  try {
    await l2.del(...valid);
  } catch {
    // Non-fatal L2 delete failure.
  }
}

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fn().finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}

export async function cached<T>(
  key: string,
  l2TtlSeconds: number,
  l1TtlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isCacheEnabled()) return fn();
  const hit = await cacheGet<T>(key, l1TtlMs);
  if (hit !== undefined) return hit;
  return singleFlight(`sf:${key}`, async () => {
    const recheck = l1Get<T>(key);
    if (recheck !== undefined) return recheck;
    const result = await fn();
    if (result !== undefined && result !== null) {
      await cacheSet(key, result, l2TtlSeconds, l1TtlMs);
    }
    return result;
  });
}