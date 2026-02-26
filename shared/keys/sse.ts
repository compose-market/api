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

const SESSION_EVENTS_PATH = "/api/session/events";
const HEARTBEAT_MS = 25_000;
const SESSION_REFRESH_MS = 5_000;

interface SessionExpiredEvent {
    action: "session-expired";
    userAddress: string;
    chainId: number;
    message: string;
    reason: string;
    timestamp: number;
    expiresAt: number | null;
}

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

export function registerSessionEventsRoute(app: Express): void {
    app.get(SESSION_EVENTS_PATH, (req, res) => {
        void handleSessionEvents(req, res);
    });
}

async function handleSessionEvents(req: Request, res: Response): Promise<void> {
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

    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }

    // Hint browser-side EventSource reconnect delay.
    res.write("retry: 3000\n\n");

    let closed = false;
    let knownExpiresAt: number | null = null;
    let expiryTimer: NodeJS.Timeout | null = null;
    let refreshTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;

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
            void syncSession("timer");
        }, delayMs);
    };

    const syncSession = async (source: "initial" | "refresh" | "timer") => {
        if (closed || res.writableEnded) return;

        try {
            const status = await getActiveSessionStatus(userAddress, chainId);
            if (!status.session) {
                writeExpiredEvent(
                    res,
                    userAddress,
                    chainId,
                    status.reason,
                    status.latestKey?.expiresAt ?? null,
                );
                closeStream();
                return;
            }

            if (knownExpiresAt !== status.session.expiresAt) {
                knownExpiresAt = status.session.expiresAt;
                scheduleExpiryCheck(status.session.expiresAt);
                writeEvent(res, "session-active", {
                    userAddress,
                    chainId,
                    expiresAt: status.session.expiresAt,
                    budgetRemaining: status.session.budgetRemaining,
                    source,
                    timestamp: Date.now(),
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

    writeEvent(res, "ready", {
        userAddress,
        chainId,
        timestamp: Date.now(),
    });

    heartbeatTimer = setInterval(() => {
        writeEvent(res, "ping", { timestamp: Date.now() });
    }, HEARTBEAT_MS);

    refreshTimer = setInterval(() => {
        void syncSession("refresh");
    }, SESSION_REFRESH_MS);

    await syncSession("initial");
}
