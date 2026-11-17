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