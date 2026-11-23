import { createHash } from "node:crypto";
import type { Application, NextFunction, Request, Response as ExpressResponse } from "express";

import { cached } from "./cache.js";
import { isNetworkId, isServiceBlockedNetwork, type NetworkId } from "./x402/configs/chains.js";
import {
  buildModelsPaymentRequired,
  buildOpenApiDocument,
  buildWellKnownX402,
  listModelCatalog,
  MODELS_ENTRYPOINT,
  MODELS_CATALOG,
} from "./x402/discovery.js";
import { encodePaymentRequiredHeader } from "./x402/facilitator.js";
import { authorizeCallerForUser } from "./x402/keys/middleware.js";
import { publicOriginFromHost } from "./http/public-origin.js";
import { listReceipts, normalizeReceiptUserAddress } from "./x402/receipts.js";
import { searchAgents as searchAgentverseAgents } from "./agentverse.js";

interface PublicRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
}

interface PublicRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const FRAMEWORKS = [
  {
    id: "manowar",
    name: "Manowar",
    description: "Manowar agent framework",
  },
  {
    id: "other",
    name: "Other",
    description: "Compatibility category for agents minted with another framework",
  },
] as const;

function jsonResult(statusCode: number, headers: Record<string, string>, body: unknown): PublicRouteResult {
  return {
    statusCode,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function eventHeader(event: PublicRouteEvent, name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}

function eventSignedWithoutNetwork(event: PublicRouteEvent): boolean {
  const paymentSignature = eventHeader(event, "payment-signature");
  const network = eventHeader(event, "x-network-id");
  return Boolean(paymentSignature?.trim()) && !network?.trim();
}

function paymentRequiredResult(
  headers: Record<string, string>,
  paymentRequired: Awaited<ReturnType<typeof buildModelsPaymentRequired>>,
): PublicRouteResult {
  return jsonResult(402, {
    ...headers,
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
  }, paymentRequired);
}

function isEntrypoint(path: string, value: string): boolean {
  return path === value || path === `${value}/`;
}

export async function handlePublicRoute(
  event: PublicRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<PublicRouteResult | null> {
  const { rawPath: path } = event;
  const method = event.requestContext.http.method.toUpperCase();
  const publicOrigin = publicOriginFromHost(eventHeader(event, "host"));

  try {
    if (method === "GET" && path === "/openapi.json") {
      return jsonResult(
        200,
        corsHeaders,
        await cached(`discovery:openapi:${publicOrigin}`, 300, 60_000, () => buildOpenApiDocument(publicOrigin)),
      );
    }

    if (method === "GET" && path === "/.well-known/x402") {
      return jsonResult(
        200,
        corsHeaders,
        await cached(`discovery:wellknown:${publicOrigin}`, 300, 60_000, () => buildWellKnownX402(publicOrigin)),
      );
    }

    if (method === "GET" && path === MODELS_CATALOG) {
      return jsonResult(200, corsHeaders, listModelCatalog(event.queryStringParameters, publicOrigin));
    }

    if (method === "POST" && isEntrypoint(path, MODELS_ENTRYPOINT)) {
      if (eventSignedWithoutNetwork(event)) {
        return jsonResult(400, corsHeaders, { error: "x-network-id header is required" });
      }
      const network = eventHeader(event, "x-network-id");
      if (network && isNetworkId(network) && isServiceBlockedNetwork(network)) {
        return jsonResult(400, corsHeaders, {
          error: `Network ${network} is not supported for this service. Use a Mainnet, or ask for Testnet access.`,
        });
      }
      return paymentRequiredResult(corsHeaders, await buildModelsPaymentRequired(publicOrigin));
    }

    if (method === "GET" && path === "/health") {
      return jsonResult(200, corsHeaders, {
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    if (method === "GET" && path === "/api/models") {
      return jsonResult(200, corsHeaders, listModelCatalog(event.queryStringParameters, publicOrigin));
    }

    if (method === "GET" && path === "/api/agentverse/agents") {
      const q = event.queryStringParameters || {};
      const input = {
        search: q.search ?? q.q ?? undefined,
        category: q.category ?? undefined,
        tags: q.tags ? q.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        limit: q.limit ? Math.max(1, Math.min(100, Number.parseInt(q.limit, 10) || 30)) : undefined,
        offset: q.offset ? Math.max(0, Number.parseInt(q.offset, 10) || 0) : undefined,
        sort: q.sort as "relevancy" | "created-at" | "last-modified" | "interactions" | undefined,
        direction: q.direction === "asc" ? "asc" as const : "desc" as const,
      };
      const key = `agentverse:${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24)}`;
      const result = await cached(key, 120, 30_000, () => searchAgentverseAgents(input));
      return jsonResult(200, corsHeaders, result);
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[public-routes] Error:", message);
    return jsonResult(500, corsHeaders, { error: message });
  }
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function receiptNetwork(req: Request): NetworkId | null {
  const raw = queryValue(req.query.network) ?? getHeader(req, "x-network-id");
  return raw && isNetworkId(raw) ? raw : null;
}

function receiptLimit(req: Request): number {
  const parsed = Number.parseInt(queryValue(req.query.limit) || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

async function receiptIdentity(
  req: Request,
): Promise<{ userAddress: string; network: NetworkId } | { error: string; status: number }> {
  const raw = getHeader(req, "x-session-user-address");
  const auth = await authorizeCallerForUser({
    authHeader: getHeader(req, "authorization"),
    internalTokenHeader: getHeader(req, "x-backpack-internal-token"),
    userAddress: raw,
  });
  if (!auth.ok) {
    return { error: auth.error, status: auth.status };
  }
  const effectiveRaw = auth.userAddress;
  if (!effectiveRaw) {
    return { error: "x-session-user-address header required", status: 401 };
  }
  const network = receiptNetwork(req) ?? auth.network ?? null;
  if (!network) return { error: "Valid x-network-id header required", status: 401 };
  const userAddress = normalizeReceiptUserAddress(effectiveRaw, network);
  if (!userAddress) return { error: "x-session-user-address header required", status: 401 };
  return { userAddress, network };
}

function receiptsRoute() {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const identity = await receiptIdentity(req);
      if ("error" in identity) {
        res.status(identity.status).json({ error: identity.error });
        return;
      }

      const result = await listReceipts({
        userAddress: identity.userAddress,
        network: identity.network,
        limit: receiptLimit(req),
        rootRunId: queryValue(req.query.rootRunId),
        executionRunId: queryValue(req.query.executionRunId),
      });
      res.status(200).json(result);
    })().catch(next);
  };
}

// ---------------------------------------------------------------------------
// Server-side Pinata pin proxy.
//
// Keeps PINATA_JWT server-side and forwards only the three pin operations
// the UI needs.
// ---------------------------------------------------------------------------

const PINATA_PIN_API_URL = "https://api.pinata.cloud";
const PIN_PROXY_LIMIT_BYTES = 10 * 1024 * 1024;

function pinataJwt(): string | null {
  const jwt = (process.env.PINATA_JWT || "").trim();
  return jwt.length > 0 ? jwt : null;
}

function readCappedBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PIN_PROXY_LIMIT_BYTES) {
        reject(new Error("pin_proxy_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyPinataPin(req: Request, res: ExpressResponse, pinataPath: string): Promise<void> {
  const auth = await authorizeCallerForUser({
    authHeader: getHeader(req, "authorization"),
    internalTokenHeader: getHeader(req, "x-backpack-internal-token"),
    userAddress: getHeader(req, "x-session-user-address"),
  });
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const jwt = pinataJwt();
  if (!jwt) {
    res.status(503).json({ error: "IPFS pinning is not configured" });
    return;
  }
  try {
    const rawBody = (req as Request & { rawBody?: unknown }).rawBody;
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : await readCappedBody(req);
    const body = new Uint8Array(buffer.byteLength);
    body.set(buffer);
    const contentType = req.headers["content-type"];
    const response = await fetch(`${PINATA_PIN_API_URL}${pinataPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(typeof contentType === "string" && contentType.length > 0
          ? { "Content-Type": contentType }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    res.status(response.status);
    if (response.headers.get("content-type")?.includes("application/json")) {
      res.type("application/json");
    }
    res.send(text);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error && error.message === "pin_proxy_body_too_large"
        ? "Upload exceeds the pin proxy size limit"
        : "IPFS pinning failed",
    });
  }
}

export function registerUtilityRoutes(app: Application): void {
  app.get("/api/receipts", receiptsRoute());

  app.post("/api/ipfs/pin/file", (req, res) => {
    void proxyPinataPin(req, res, "/pinning/pinFileToIPFS");
  });
  app.post("/api/ipfs/pin/json", (req, res) => {
    void proxyPinataPin(req, res, "/pinning/pinJSONToIPFS");
  });
  app.delete("/api/ipfs/unpin/:cid", (req, res) => {
    const jwt = pinataJwt();
    if (!jwt) {
      res.status(503).json({ error: "IPFS pinning is not configured" });
      return;
    }
    const cid = req.params.cid || "";
    if (!/^[A-Za-z0-9]{20,128}$/.test(cid)) {
      res.status(400).json({ error: "Invalid CID" });
      return;
    }
    void fetch(`${PINATA_PIN_API_URL}/pinning/unpin/${cid}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(30_000),
    })
      .then(async (response) => {
        if (response.ok) {
          res.json({ ok: true, cid });
          return;
        }
        const text = await response.text().catch(() => "");
        res.status(response.status).json({ error: `Unpin failed (${response.status})`, detail: text.slice(0, 300) });
      })
      .catch(() => res.status(502).json({ error: "IPFS unpin failed" }));
  });

  app.get("/frameworks", (_req, res) => {
    res.json({ frameworks: FRAMEWORKS });
  });
}
