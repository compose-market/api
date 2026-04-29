import "dotenv/config"; // Load .env variables FIRST
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import { registerInferenceRoutes } from "./inference/gateway.js";
import { registerFeedbackRoutes } from "./feedback/routes.js";
import { createServer } from "http";
import { registerHandlerRoutes } from "./handler.js";
import { registerSessionEventsRoute } from "./x402/keys/sse.js";
import { corsMiddleware, requestIdMiddleware } from "./http/middleware.js";
import { buildError } from "./http/errors.js";

export { handler as apiHandler, batchSettlementHandler } from "./handler.js";
export { expiryWorker } from "./x402/keys/expiry.js";

async function runJob() {
  const task = process.env.JOB_TASK;
  if (!task) return;

  log(`🚀 Starting Cloud Run Job: ${task}`, "job");

  try {
    const { batchSettlementHandler } = await import("./handler.js");
    const { expiryWorker } = await import("./x402/keys/expiry.js");

    switch (task) {
      case "batch-settlement":
        await batchSettlementHandler({ source: "scheduled" }, {} as any);
        break;
      case "expiry-scan":
        await expiryWorker({ source: "scheduled" } as any, {} as any);
        break;
      default:
        throw new Error(`Unknown job task: ${task}`);
    }
    log(`✅ Job ${task} completed successfully.`, "job");
    process.exit(0);
  } catch (error) {
    log(`❌ Job ${task} failed: ${error}`, "job");
    process.exit(1);
  }
}

const API_PORT = 3000;

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Canonical CORS policy — single source of truth, allow-list based, explicit
// Expose-Headers, preflight-aware. Must run BEFORE request-id so OPTIONS fast
// path still emits a CORS response.
app.use(corsMiddleware());

// Canonical X-Request-Id on every response. Accepts a caller-supplied id when
// syntactically safe, mints one otherwise.
app.use(requestIdMiddleware());

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

function tryListen(port: number, maxAttempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (currentPort: number, remaining: number) => {
      if (remaining <= 0) {
        reject(new Error(`Could not find available port after ${maxAttempts} attempts`));
        return;
      }

      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          log(`Port ${currentPort} in use, trying ${currentPort + 1}...`);
          attempt(currentPort + 1, remaining - 1);
        } else {
          reject(err);
        }
      });

      httpServer.listen({ port: currentPort, host: "0.0.0.0" }, () => {
        resolve(currentPort);
      });
    };

    attempt(port, maxAttempts);
  });
}

(async () => {
  if (process.env.JOB_TASK) {
    await runJob();
    return;
  }

  registerInferenceRoutes(app);
  registerFeedbackRoutes(app);
  registerSessionEventsRoute(app);
  registerHandlerRoutes(app);

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const error = err as { status?: number; statusCode?: number; message?: string };
        const status = error.status || error.statusCode || 500;
        const message = error.message || "Internal Server Error";

        console.error("[express] Unhandled error", err);

        if (res.headersSent) {
            return;
        }

        const code = status === 400 ? "validation_error"
            : status === 401 ? "authentication_failed"
            : status === 403 ? "forbidden"
            : status === 404 ? "not_found"
            : status === 409 ? "conflict"
            : status === 429 ? "rate_limited"
            : "internal_error";

        res.status(status).json(buildError(code, message));
    });

  const preferredPort = parseInt(process.env.PORT || String(API_PORT), 10);
  const actualPort = await tryListen(preferredPort);

  console.log(`\n  ➜  API Server listening on port ${actualPort}`);
  console.log(`  ➜  Endpoints:`);
  console.log(`     POST /api/inference`);
  console.log(`     GET  /api/models`);
  console.log(`     GET  /api/hf/models`);
  console.log(`     GET  /api/hf/tasks`);
  console.log(`     GET  /api/agentverse/agents\n`);
})();
