import type { Application } from "express";

import { getRedisClient } from "../x402/keys/redis.js";
import { refreshDownloadMetrics } from "./downloads.js";
import { loadMetricsConfig } from "./config.js";
import { runMetricsBackfill } from "./onchain.js";
import { getMetricsChannel, readMetricsSnapshot } from "./redis.js";
import { getMetricsHealth, getMetricsSnapshot } from "./service.js";

export function registerMetricsRoutes(app: Application): void {
    app.get("/api/metrics", async (req, res, next) => {
        try {
            const refresh = req.query.refresh === "true" || req.query.refresh === "1";
            res.json(await getMetricsSnapshot({ refresh }));
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/metrics/health", async (_req, res, next) => {
        try {
            res.json(await getMetricsHealth());
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/metrics/downloads", async (req, res, next) => {
        try {
            const refresh = req.query.refresh === "true" || req.query.refresh === "1";
            res.json(await refreshDownloadMetrics({ force: refresh }));
        } catch (error) {
            next(error);
        }
    });

    app.post("/api/metrics/reindex", async (req, res, next) => {
        try {
            const maxRangesRaw = req.query.maxRanges ?? req.body?.maxRanges;
            const maxRanges = maxRangesRaw ? Number.parseInt(String(maxRangesRaw), 10) : undefined;
            const fromDate = typeof req.body?.fromDate === "string" ? req.body.fromDate : undefined;
            const summary = await runMetricsBackfill({ fromDate, maxRanges });
            res.json(summary);
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/metrics/events", async (_req, res, next) => {
        try {
            const config = loadMetricsConfig();
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            });

            const writeEvent = (event: string, data: unknown) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            writeEvent("metrics.snapshot", await readMetricsSnapshot(config));

            const redis = await getRedisClient();
            const subscriber = redis.duplicate();
            await subscriber.connect();
            await subscriber.subscribe(getMetricsChannel(config), async (message) => {
                writeEvent("metrics.changed", JSON.parse(message));
                writeEvent("metrics.snapshot", await readMetricsSnapshot(config));
            });

            const heartbeat = setInterval(() => {
                writeEvent("metrics.heartbeat", { at: Date.now(), dataset: config.dataset });
            }, 25_000);

            res.on("close", () => {
                clearInterval(heartbeat);
                void subscriber.unsubscribe(getMetricsChannel(config)).finally(() => subscriber.quit());
            });
        } catch (error) {
            next(error);
        }
    });
}
