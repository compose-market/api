import "dotenv/config"; // Load .env variables FIRST
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import { registerRoutes } from "./shared/inference/index.js";
import { createServer } from "http";
import cors from "cors";
import { handler as lambdaHandler } from "./handler.js";
import { registerSessionEventsRoute } from "./shared/keys/sse.js";

export { handler, batchSettlementHandler } from "./handler.js";
export { expiryWorker } from "./shared/keys/expiry.js";

interface APIGatewayProxyEventV2 {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers: Record<string, string | undefined>;
  body?: string;
  queryStringParameters?: Record<string, string>;
}

interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

async function runJob() {
  const task = process.env.JOB_TASK;
  if (!task) return;

  log(`🚀 Starting Cloud Run Job: ${task}`, "job");

  try {
    const { batchSettlementHandler } = await import("./handler.js");
    const { expiryWorker } = await import("./shared/keys/expiry.js");

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

// Enable CORS for all origins (frontend calls from any port/domain)
app.use(cors({ origin: true, credentials: true }));

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

function parseQueryParams(req: Request): Record<string, string> | undefined {
  const queryIndex = req.originalUrl.indexOf("?");
  if (queryIndex === -1) return undefined;

  const search = req.originalUrl.slice(queryIndex + 1);
  const params = new URLSearchParams(search);
  const parsed: Record<string, string> = {};

  for (const [key, value] of params.entries()) {
    if (!(key in parsed)) parsed[key] = value;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function buildLambdaEvent(req: Request): APIGatewayProxyEventV2 {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }

  const method = req.method.toUpperCase();
  const canHaveBody = !["GET", "HEAD", "OPTIONS"].includes(method);
  let body: string | undefined;

  if (canHaveBody) {
    if (Buffer.isBuffer(req.rawBody)) {
      body = req.rawBody.toString("utf-8");
    } else if (typeof req.rawBody === "string") {
      body = req.rawBody;
    } else if (typeof req.body === "string") {
      body = req.body;
    } else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
    }
  }
  const queryParams = parseQueryParams(req);

  return {
    rawPath: req.path,
    requestContext: { http: { method } },
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(queryParams ? { queryStringParameters: queryParams } : {}),
  };
}

async function delegateToLambda(req: Request, res: Response, next: NextFunction) {
  try {
    const event = buildLambdaEvent(req);
    const result = await lambdaHandler(event, {} as Record<string, unknown>);

    const lambdaResult = result as APIGatewayProxyResultV2;
    if (lambdaResult.headers) {
      for (const [key, value] of Object.entries(lambdaResult.headers)) {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }
    }

    res.status(lambdaResult.statusCode);
    if (lambdaResult.isBase64Encoded) {
      const decoded = Buffer.from(lambdaResult.body || "", "base64");
      res.send(decoded);
      return;
    }

    res.send(lambdaResult.body ?? "");
  } catch (err) {
    next(err);
  }
}

(async () => {
  if (process.env.JOB_TASK) {
    await runJob();
    return;
  }

  await registerRoutes(httpServer, app, { skipNotFoundHandler: true });
  registerSessionEventsRoute(app);
  app.use((req, res, next) => {
    void delegateToLambda(req, res, next);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err as { status?: number; statusCode?: number; message?: string };
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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
