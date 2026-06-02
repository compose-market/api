/**
 * Session Events Stream (SSE)
 *
 * Cloud Run-native, one-way real-time session signaling.
 * Used to notify clients when a session becomes inactive.
 *
 * @module shared/keys/sse
 */

import type { Express, Request, Response } from "express";
import { getActiveSessionStatus } from "./storage.js";
import type { ActiveSessionStatus } from "./types.js";

const SESSION_EVENTS_PATH = "/api/session/events";
const HEARTBEAT_MS = 25_000;
const SESSION_REFRESH_MS = 5_000;
const DEFAULT_LEASE_MS = 110_000;
const DEFAULT_RETRY_MS = 3_000;
const DEFAULT_JITTER_MS = 2_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;

interface Lease {
    leaseMs: number;
    retryMs: number;
    jitterMs: number;
}

export interface SessionEventsConfig {
    leaseMs?: number;
    retryMs?: number;
    jitterMs?: number;
}

interface SessionExpiredEvent {
    action: "session-expired";
    userAddress: string;
    chainId: number;
    message: string;
    reason: string;
    timestamp: number;
    expiresAt: number | null;
}

interface SessionLeaseEvent {
    action: "session-events-lease";
    userAddress: string;
    chainId: number;
    message: string;
    reason: "lease-expired";
    timestamp: number;
    leaseMs: number;
    retryAfterMs: number;
}

interface ComposeAlert {
    type: "compose.alert";
    code: "session_events_lease_rotate";
    severity: "info" | "warning" | "error";
    source: "session-events";
    scope: "session";
    title: string;
    message: string;
    userAddress: string;
    chainId: number;
    timestamp: number;
    leaseMs: number;
    retryAfterMs: number;
    metadata?: Record<string, unknown>;
}

interface SessionSnapshot {
    sessionId: string;
    expiresAt: number;
    budgetRemaining: number;
    budgetLocked: number;
    budgetUsed: number;
}

type StatusProvider = (userAddress: string, chainId: number) => Promise<ActiveSessionStatus>;

function normalizeAddress(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
    return normalized;
}

function parseChainId(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function readMs(name: string, fallback: number): number {
    const value = process.env[name];
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function resolveLease(config: SessionEventsConfig = {}): Lease {
    return {
        leaseMs: clamp(config.leaseMs ?? readMs("SESSION_EVENTS_LEASE_MS", DEFAULT_LEASE_MS), MIN_LEASE_MS, MAX_LEASE_MS),
        retryMs: Math.max(0, config.retryMs ?? readMs("SESSION_EVENTS_RETRY_MS", DEFAULT_RETRY_MS)),
        jitterMs: Math.max(0, config.jitterMs ?? readMs("SESSION_EVENTS_RETRY_JITTER_MS", DEFAULT_JITTER_MS)),
    };
}

function retryAfter(lease: Lease): number {
    if (lease.jitterMs <= 0) return lease.retryMs;
    return lease.retryMs + Math.floor(Math.random() * lease.jitterMs);
}

function writeEvent(res: Response, event: string, data: unknown): void {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeExpiredEvent(
    res: Response,
    userAddress: string,
    chainId: number,
    reason: string,
    expiresAt: number | null,
): void {
    const payload: SessionExpiredEvent = {
        action: "session-expired",
        userAddress,
        chainId,
        message: "Session expired, create a new session to use our services",
        reason,
        timestamp: Date.now(),
        expiresAt,
    };
    writeEvent(res, "session-expired", payload);
}

function writeLeaseEvent(
    res: Response,
    userAddress: string,
    chainId: number,
    leaseMs: number,
    retryAfterMs: number,
): void {
    const payload: SessionLeaseEvent = {
        action: "session-events-lease",
        userAddress,
        chainId,
        message: "Session event stream lease ended; reconnect to continue receiving session updates.",
        reason: "lease-expired",
        timestamp: Date.now(),
        leaseMs,
        retryAfterMs,
    };
    writeEvent(res, "session-lease", payload);
}

function writeAlertEvent(
    res: Response,
    userAddress: string,
    chainId: number,
    leaseMs: number,
    retryAfterMs: number,
): void {
    const payload: ComposeAlert = {
        type: "compose.alert",
        code: "session_events_lease_rotate",
        severity: "info",
        source: "session-events",
        scope: "session",
        title: "Session status stream rotating",
        message: "The session status stream reached its lease and will reconnect.",
        userAddress,
        chainId,
        timestamp: Date.now(),
        leaseMs,
        retryAfterMs,
    };
    writeEvent(res, "compose.alert", payload);
}

function resolveUserAddress(req: Request): string | null {
    const queryValue = req.query.userAddress;
    if (typeof queryValue === "string") {
        return normalizeAddress(queryValue);
    }

    const headerValue = req.header("x-session-user-address");
    return normalizeAddress(headerValue);
}

function resolveChainId(req: Request): number | null {
    const queryValue = req.query.chainId;
    if (typeof queryValue === "string") {
        return parseChainId(queryValue);
    }

    const headerValue = req.header("x-chain-id");
    return parseChainId(headerValue);
}

export function createSessionEventsHandler(
    status: StatusProvider = getActiveSessionStatus,
    config: SessionEventsConfig = {},
) {
    return (req: Request, res: Response): void => {
        void handleSessionEvents(req, res, status, resolveLease(config));
    };
}

export function registerSessionEventsRoute(app: Express): void {
    app.get(SESSION_EVENTS_PATH, createSessionEventsHandler());
}

async function handleSessionEvents(
    req: Request,
    res: Response,
    status: StatusProvider,
    lease: Lease,
): Promise<void> {
    const userAddress = resolveUserAddress(req);
    const chainId = resolveChainId(req);

    if (!userAddress || !chainId) {
        res.status(400).json({
            error: "Invalid or missing userAddress/chainId",
        });
        return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const retryAfterMs = retryAfter(lease);
    res.setHeader("X-Session-Events-Lease-Ms", String(lease.leaseMs));
    res.setHeader("X-Session-Events-Retry-Ms", String(retryAfterMs));

    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }

    // Hint browser-side EventSource reconnect delay.
    res.write(`retry: ${retryAfterMs}\n\n`);

    let closed = false;
    let snapshot: SessionSnapshot | null = null;
    let expiryTimer: NodeJS.Timeout | null = null;
    let refreshTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let leaseTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (leaseTimer) {
            clearTimeout(leaseTimer);
            leaseTimer = null;
        }
    };

    const closeStream = () => {
        if (closed) return;
        closed = true;
        clearTimers();
        if (!res.writableEnded) {
            res.end();
        }
    };

    const scheduleExpiryCheck = (expiresAt: number) => {
        if (expiryTimer) {
            clearTimeout(expiryTimer);
        }
        const delayMs = Math.max(0, expiresAt - Date.now()) + 25;
        expiryTimer = setTimeout(() => {
            void syncSession();
        }, delayMs);
    };

    const syncSession = async () => {
        if (closed || res.writableEnded) return;

        try {
            const active = await status(userAddress, chainId);
            if (!active.session) {
                writeExpiredEvent(
                    res,
                    userAddress,
                    chainId,
                    active.reason,
                    active.latestKey?.expiresAt ?? null,
                );
                closeStream();
                return;
            }

            const nextSnapshot: SessionSnapshot = {
                sessionId: active.session.keyId,
                expiresAt: active.session.expiresAt,
                budgetRemaining: active.session.budgetRemaining,
                budgetLocked: active.session.budgetLocked,
                budgetUsed: active.session.budgetUsed,
            };

            const shouldEmitActive =
                !snapshot ||
                snapshot.sessionId !== nextSnapshot.sessionId ||
                snapshot.expiresAt !== nextSnapshot.expiresAt ||
                snapshot.budgetRemaining !== nextSnapshot.budgetRemaining ||
                snapshot.budgetLocked !== nextSnapshot.budgetLocked ||
                snapshot.budgetUsed !== nextSnapshot.budgetUsed;

            if (shouldEmitActive) {
                snapshot = nextSnapshot;
                scheduleExpiryCheck(active.session.expiresAt);
                writeEvent(res, "session-active", {
                    userAddress,
                    chainId,
                    expiresAt: active.session.expiresAt,
                    budgetLimit: active.session.budgetLimit,
                    budgetUsed: active.session.budgetUsed,
                    budgetLocked: active.session.budgetLocked,
                    budgetRemaining: active.session.budgetRemaining,
                });
            }
        } catch (err) {
            console.error("[session-events] sync failed:", err);
            writeEvent(res, "error", {
                error: "Session stream sync failed",
                timestamp: Date.now(),
            });
            closeStream();
        }
    };

    req.on("close", closeStream);
    res.on("close", closeStream);

    heartbeatTimer = setInterval(() => {
        writeEvent(res, "ping", { timestamp: Date.now() });
    }, HEARTBEAT_MS);

    refreshTimer = setInterval(() => {
        void syncSession();
    }, SESSION_REFRESH_MS);

    leaseTimer = setTimeout(() => {
        if (closed || res.writableEnded) return;
        writeAlertEvent(res, userAddress, chainId, lease.leaseMs, retryAfterMs);
        writeLeaseEvent(res, userAddress, chainId, lease.leaseMs, retryAfterMs);
        closeStream();
    }, lease.leaseMs);

    await syncSession();
}
