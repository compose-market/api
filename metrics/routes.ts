import type { Application } from "express";

import { ensure, sql } from "./db.js";
import { syncDownloads } from "./downloads.js";
import { syncPayments } from "./payments.js";
import { syncSessionsFromValkey } from "./sessions.js";
import { syncAllExpenses, volumeTotals } from "./expenses/index.js";
import { getMetricsSnapshot, refreshMetricsSnapshot } from "./snapshot.js";

export function registerMetricsRoutes(app: Application): void {
    app.get("/api/metrics", async (req, res, next) => {
        try {
            if (req.query.refresh === "true" || req.query.refresh === "1") {
                await syncDownloads();
                await syncSessionsFromValkey();
                await syncPayments();
                await syncAllExpenses();
                res.json(await refreshMetricsSnapshot());
                return;
            }
            res.json(await getMetricsSnapshot());
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/metrics/volume", async (_req, res, next) => {
        try {
            res.json(await volumeTotals());
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/metrics/health", async (_req, res, next) => {
        try {
            await ensure();
            await sql().query("SELECT 1");
            res.json({
                ok: true,
                database: true,
                tables: ["downloads", "payments", "sessions", "expenses", "state"],
            });
        } catch (error) {
            next(error);
        }
    });
}
