import "dotenv/config"; // Load .env variables FIRST
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import cors from "cors";

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

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err as { status?: number; statusCode?: number; message?: string };
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  const preferredPort = parseInt(process.env.PORT || String(API_PORT), 10);
  const actualPort = await tryListen(preferredPort);
  
  console.log(`\n  ➜  API Server: http://localhost:${actualPort}/`);
  console.log(`  ➜  Endpoints:`);
  console.log(`     POST /api/inference`);
  console.log(`     GET  /api/models`);
  console.log(`     GET  /api/hf/models`);
  console.log(`     GET  /api/hf/tasks`);
  console.log(`     GET  /api/agentverse/agents\n`);
})();

