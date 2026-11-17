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