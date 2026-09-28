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
    await instance.connect();
    await instance.ping();
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