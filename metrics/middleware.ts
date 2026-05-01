import type { NextFunction, Request, Response } from "express";

import { captureApiAttempt } from "./instrumentation.js";
import type { MetricsClientSource } from "./types.js";

function firstHeader(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] || "";
    return value || "";
}

export function classifyMetricsClientSource(headers: Request["headers"]): MetricsClientSource {
    const explicit = firstHeader(headers["x-compose-client-source"]).toLowerCase();
    if (explicit === "sdk" || explicit === "web" || explicit === "runtime" || explicit === "internal") {
        return explicit;
    }

    const sdk = firstHeader(headers["x-compose-sdk"]);
    if (sdk) return "sdk";

    const workflowInternal = firstHeader(headers["x-workflow-internal"]);
    const networkInternal = firstHeader(headers["x-network-internal"]);
    const internalSecret = firstHeader(headers["x-internal-secret"]);
    if (workflowInternal || networkInternal || internalSecret) return "internal";

    const userAgent = firstHeader(headers["user-agent"]).toLowerCase();
    if (userAgent.includes("@compose-market/sdk") || userAgent.includes("compose-sdk")) return "sdk";
    if (userAgent.includes("node") || userAgent.includes("undici")) return "runtime";

    const origin = firstHeader(headers.origin).toLowerCase();
    const referer = firstHeader(headers.referer).toLowerCase();
    const fetchMode = firstHeader(headers["sec-fetch-mode"]);
    if (origin || referer || fetchMode) return "web";

    return "unknown";
}

function shouldTrackMetricsAttempt(req: Request): boolean {
    const path = req.path || req.originalUrl || "";
    if (path === "/health") return false;
    if (path.startsWith("/api/metrics")) return false;
    if (path.startsWith("/api/session/events")) return false;
    return path.startsWith("/api")
        || path.startsWith("/agent/")
        || path.startsWith("/workflow/");
}

export function createMetricsAttemptMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!shouldTrackMetricsAttempt(req)) {
            next();
            return;
        }

        const source = classifyMetricsClientSource(req.headers);
        const startedAt = Date.now();
        res.on("finish", () => {
            const requestId = typeof res.locals.requestId === "string"
                ? res.locals.requestId
                : firstHeader(req.headers["x-request-id"]);
            captureApiAttempt({
                source,
                method: req.method,
                path: req.path || req.originalUrl,
                statusCode: res.statusCode,
                requestId,
            });
            if (Date.now() - startedAt > 30_000) {
                console.warn(`[metrics] slow attempt metric emitted after ${Date.now() - startedAt}ms`);
            }
        });
        next();
    };
}
