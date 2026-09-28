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