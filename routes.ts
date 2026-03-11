import type { Application, NextFunction, Request, Response as ExpressResponse } from "express";

import { getCompiledModels } from "./inference/modelsRegistry.js";
import {
  buildResolvedSettlementMeter,
  buildUsageRecordSettlementMeter,
  resolveBillingModel,
  type MeteredSettlementInput,
  type UsageRecord,
} from "./x402/metering.js";
import {
  abortPaymentIntent,
  authorizePaymentIntent,
  settlePaymentIntent,
} from "./x402/intents.js";
import {
  extractComposeKeyFromHeader,
  getKeyBudgetInfo,
  validateComposeKey,
} from "./x402/keys/middleware.js";
import { getKeyReservedBudget } from "./x402/keys/storage.js";

interface PublicRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
}

interface PublicRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

interface AgentCard {
  schemaVersion: string;
  name: string;
  description: string;
  skills: string[];
  image?: string;
  avatar?: string;
  dnaHash: string;
  walletAddress: string;
  walletTimestamp?: number;
  chain: number;
  model: string;
  framework?: "eliza" | "langchain" | string;
  licensePrice: string;
  licenses: number;
  cloneable: boolean;
  endpoint?: string;
  protocols: Array<{ name: string; version: string }>;
  plugins?: Array<{
    registryId: string;
    name: string;
    origin: string;
  }>;
  createdAt: string;
  creator?: string;
  cid?: string;
}

interface WorkflowMetadata {
  schemaVersion: string;
  title: string;
  description: string;
  image?: string;
  dnaHash: string;
  walletAddress: string;
  walletTimestamp: number;
  agents: AgentCard[];
  edges?: Array<{
    source: number;
    target: number;
    label?: string;
  }>;
  coordinator?: {
    hasCoordinator: boolean;
    model: string;
  };
  pricing: {
    totalAgentPrice: string;
  };
  lease?: {
    enabled: boolean;
    durationDays: number;
    creatorPercent: number;
  };
  rfa?: {
    title: string;
    description: string;
    skills: string[];
    offerAmount: string;
  };
  creator: string;
  createdAt: string;
  cid?: string;
}

const PINATA_API_URL = "https://api.pinata.cloud";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const FRAMEWORKS = [
  {
    id: "eliza",
    name: "ElizaOS",
    description: "Agent framework with plugin-driven actions and social automation",
  },
  {
    id: "langchain",
    name: "LangChain",
    description: "LangChain agent framework with LangGraph support",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Skills-first continuous agent runtime with Backpack connectors",
  },
] as const;

type PaymentPreparation = {
  paymentIntentId: string;
  maxAmountWei: string;
  headers: Record<string, string>;
};

type RouteSettlement = { meter: MeteredSettlementInput };

type ParsedSseEvent = {
  eventName: string;
  data: Record<string, unknown>;
};

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

function requireConfiguredEnv(name: "PINATA_JWT" | "PINATA_GATEWAY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function fetchFromPinataGateway<T>(cid: string, gatewayHost: string): Promise<T | null> {
  const response = await fetch(`https://${gatewayHost}/ipfs/${cid}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    return null;
  }
  return await response.json() as T;
}

async function listPinsByType(type: "agent-card" | "workflow-metadata"): Promise<(AgentCard | WorkflowMetadata)[]> {
  const jwt = requireConfiguredEnv("PINATA_JWT");
  const gatewayHost = requireConfiguredEnv("PINATA_GATEWAY");
  const query = encodeURIComponent(JSON.stringify({ keyvalues: { type: { value: type, op: "eq" } } }));
  const response = await fetch(
    `${PINATA_API_URL}/data/pinList?status=pinned&metadata[keyvalues]=${query}&pageLimit=100`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok) {
    throw new Error(`Pinata list failed with status ${response.status}`);
  }

  const data = await response.json() as {
    rows: Array<{ ipfs_pin_hash: string }>;
  };

  const items: Array<AgentCard | WorkflowMetadata | null> = await Promise.all(
    data.rows.slice(0, 50).map(async (pin): Promise<AgentCard | WorkflowMetadata | null> => {
      const content = await fetchFromPinataGateway<AgentCard | WorkflowMetadata>(pin.ipfs_pin_hash, gatewayHost);
      return content ? { ...content, cid: pin.ipfs_pin_hash } : null;
    }),
  );

  return items.filter((value): value is AgentCard | WorkflowMetadata => value !== null);
}

async function findAgentByWallet(walletAddress: string): Promise<AgentCard | null> {
  const agents = await listPinsByType("agent-card");
  const normalizedAddress = walletAddress.toLowerCase();
  return agents.find((agent) => (agent as AgentCard).walletAddress?.toLowerCase() === normalizedAddress) as AgentCard | null;
}

async function findWorkflowByWallet(walletAddress: string): Promise<WorkflowMetadata | null> {
  const workflows = await listPinsByType("workflow-metadata");
  const normalizedAddress = walletAddress.toLowerCase();
  return workflows.find((workflow) => (workflow as WorkflowMetadata).walletAddress?.toLowerCase() === normalizedAddress) as WorkflowMetadata | null;
}

export async function handlePublicRoute(
  event: PublicRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<PublicRouteResult | null> {
  const { rawPath: path } = event;
  const method = event.requestContext.http.method.toUpperCase();

  try {
    if (method === "GET" && path === "/health") {
      return jsonResult(200, corsHeaders, {
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    if (method === "GET" && path === "/api/models") {
      const models = await getCompiledModels();
      return jsonResult(200, corsHeaders, {
        object: "list",
        data: models.models.slice(0, 100),
      });
    }

    if (method === "GET" && path === "/agents") {
      const agents = await listPinsByType("agent-card") as AgentCard[];
      return jsonResult(200, corsHeaders, {
        agents,
        total: agents.length,
      });
    }

    const agentMatch = path.match(/^\/agent\/(0x[a-fA-F0-9]{40})$/);
    if (method === "GET" && agentMatch) {
      const walletAddress = agentMatch[1];
      if (!isWalletAddress(walletAddress)) {
        return jsonResult(400, corsHeaders, { error: "Invalid wallet address format" });
      }
      const agent = await findAgentByWallet(walletAddress);
      if (!agent) {
        return jsonResult(404, corsHeaders, { error: "Agent not found" });
      }
      return jsonResult(200, corsHeaders, agent);
    }

    if (method === "GET" && path === "/workflows") {
      const workflows = await listPinsByType("workflow-metadata") as WorkflowMetadata[];
      return jsonResult(200, corsHeaders, {
        workflows,
        total: workflows.length,
      });
    }

    const workflowMatch = path.match(/^\/workflow\/(0x[a-fA-F0-9]{40})$/);
    if (method === "GET" && workflowMatch) {
      const walletAddress = workflowMatch[1];
      if (!isWalletAddress(walletAddress)) {
        return jsonResult(400, corsHeaders, { error: "Invalid wallet address format" });
      }
      const workflow = await findWorkflowByWallet(walletAddress);
      if (!workflow) {
        return jsonResult(404, corsHeaders, { error: "Workflow not found" });
      }
      return jsonResult(200, corsHeaders, workflow);
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[public-routes] Error:", message);
    return jsonResult(500, corsHeaders, { error: message });
  }
}

function requireRuntimeServiceUrl(): string {
  const value = process.env.RUNTIME_SERVICE_URL;
  if (!value) {
    throw new Error("RUNTIME_SERVICE_URL is required");
  }
  return value.replace(/\/+$/, "");
}

function requireRuntimeInternalToken(): string {
  const value = process.env.RUNTIME_INTERNAL_TOKEN;
  if (!value) {
    throw new Error("RUNTIME_INTERNAL_TOKEN is required");
  }
  return value;
}

export function buildWorkflowRuntimeUrl(pathAndQuery: string): string {
  return `${requireRuntimeServiceUrl()}/internal/workflow${pathAndQuery}`;
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function applyHeaders(res: ExpressResponse, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function buildRuntimeHeaders(req: Request): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || typeof value === "undefined") {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(key, value.join(","));
    } else {
      headers.set(key, value);
    }
  }

  headers.set("x-runtime-internal-token", requireRuntimeInternalToken());
  return headers;
}

function buildRuntimeBody(req: Request): string | Blob | undefined {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  const rawBody = (req as Request & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(rawBody)) {
    const copied = new Uint8Array(rawBody.byteLength);
    copied.set(rawBody);
    return new Blob([copied]);
  }
  if (typeof rawBody === "string") {
    return rawBody;
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return JSON.stringify(req.body);
  }

  return undefined;
}

async function callRuntime(req: Request, pathAndQuery = req.originalUrl): Promise<globalThis.Response> {
  return fetch(buildWorkflowRuntimeUrl(pathAndQuery), {
    method: req.method,
    headers: buildRuntimeHeaders(req),
    body: buildRuntimeBody(req),
  });
}

function applyRuntimeHeaders(res: ExpressResponse, response: globalThis.Response): void {
  response.headers.forEach((value: string, key: string) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

async function readRuntimeJson<TBody>(response: globalThis.Response): Promise<{ text: string; body: TBody | null }> {
  const text = await response.text();
  if (!text) {
    return { text, body: null };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { text, body: null };
  }

  return {
    text,
    body: JSON.parse(text) as TBody,
  };
}

async function prepareRoutePayment(
  req: Request,
  res: ExpressResponse,
  action: string,
): Promise<PaymentPreparation | null> {
  const authorization = getHeader(req, "authorization");
  if (!authorization) {
    res.status(401).json({ error: "Compose key authorization is required" });
    return null;
  }

  const chainHeader = getHeader(req, "x-chain-id");
  const chainId = chainHeader ? parseInt(chainHeader, 10) : Number.NaN;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    res.status(400).json({ error: "x-chain-id header is required" });
    return null;
  }

  let maxAmountWei = "";
  try {
    maxAmountWei = await resolveSessionBudgetReservation(authorization);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compose key budget validation failed";
    const status = /authorization|required|invalid compose key/i.test(message)
      ? 401
      : /budget exhausted/i.test(message)
        ? 402
        : 400;
    res.status(status).json({ error: message });
    return null;
  }

  const prepared = await authorizePaymentIntent({
    authorization,
    chainId,
    service: "workflow",
    action,
    resource: `https://${req.get("host")}${req.originalUrl}`,
    method: req.method,
    maxAmountWei,
    composeRunId: getHeader(req, "x-compose-run-id"),
    idempotencyKey: getHeader(req, "x-idempotency-key"),
  });

  applyHeaders(res, prepared.headers);
  if (!prepared.ok) {
    res.status(prepared.status).json(prepared.body);
    return null;
  }

  return {
    paymentIntentId: prepared.body.paymentIntentId,
    maxAmountWei: prepared.body.maxAmountWei,
    headers: prepared.headers,
  };
}

async function abortPreparedPayment(prepared: PaymentPreparation, reason: string): Promise<void> {
  await abortPaymentIntent({
    paymentIntentId: prepared.paymentIntentId,
    reason,
  });
}

async function settlePreparedPayment(
  prepared: PaymentPreparation,
  res: ExpressResponse,
  settlement: RouteSettlement,
): Promise<void> {
  const settled = await settlePaymentIntent({
    paymentIntentId: prepared.paymentIntentId,
    ...settlement,
  });

  applyHeaders(res, prepared.headers);
  applyHeaders(res, settled.headers);

  if (!settled.ok) {
    const error = settled.body as { error?: string };
    throw new Error(typeof error.error === "string" ? error.error : "Payment settlement failed");
  }
}

async function resolveSessionBudgetReservation(authorization: string): Promise<string> {
  const token = extractComposeKeyFromHeader(authorization);
  if (!token) {
    throw new Error("Compose key authorization is required");
  }

  const validation = await validateComposeKey(token, 0);
  if (!validation.valid || !validation.payload) {
    throw new Error(validation.error || "Invalid Compose key");
  }

  const budgetInfo = await getKeyBudgetInfo(validation.payload.keyId);
  if (!budgetInfo) {
    throw new Error("Compose key budget record not found");
  }

  const reserved = await getKeyReservedBudget(validation.payload.keyId);
  const available = BigInt(Math.max(0, budgetInfo.budgetLimit - budgetInfo.budgetUsed - reserved));
  if (available <= 0n) {
    throw new Error("Compose key budget exhausted");
  }

  return available.toString();
}

function resolveAgentTextSettlement(body: Record<string, unknown>): RouteSettlement {
  if (typeof body.model !== "string") {
    throw new Error("model is required for metered settlement");
  }

  const metered = buildResolvedSettlementMeter({
    resolved: resolveBillingModel(body.model),
    modality: "text",
    usage: body,
  });

  return { meter: metered.meter };
}

function resolveAgentMultimodalSettlement(body: Record<string, unknown>): RouteSettlement {
  if (typeof body.model !== "string") {
    throw new Error("model is required for metered settlement");
  }

  const task = typeof body.task === "string" ? body.task : "";
  const type = typeof body.type === "string" ? body.type : "";
  const modality =
    task === "feature-extraction" || type === "embedding"
      ? "embedding"
      : task === "text-to-image" || task === "image-to-image" || type === "image"
        ? "image"
        : task === "text-to-video" || task === "image-to-video" || type === "video"
          ? "video"
          : task === "text-to-speech" || task === "text-to-audio" || task === "automatic-speech-recognition" || type === "audio"
            ? "audio"
            : "text";

  const metered = buildResolvedSettlementMeter({
    resolved: resolveBillingModel(body.model),
    modality,
    usage: body,
    media: body,
  });

  return { meter: metered.meter };
}

function resolveWorkflowSettlement(body: Record<string, unknown>, subject: string): RouteSettlement {
  if (!Array.isArray(body.usageRecords)) {
    throw new Error("usageRecords are required for metered workflow settlement");
  }

  const metered = buildUsageRecordSettlementMeter({
    subject,
    usageRecords: body.usageRecords as UsageRecord[],
  });

  return { meter: metered.meter };
}

function workflowSettlementSubject(req: Request): string {
  const walletFromParams = typeof req.params.walletAddress === "string"
    ? req.params.walletAddress
    : typeof req.params.id === "string"
      ? req.params.id
      : undefined;
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : null;
  const payload = body && typeof body.payload === "object" ? body.payload as Record<string, unknown> : null;
  const walletFromBody = typeof payload?.walletAddress === "string"
    ? payload.walletAddress
    : typeof payload?.id === "string"
      ? payload.id
      : undefined;
  const walletAddress = walletFromParams || walletFromBody;
  if (!walletAddress) {
    throw new Error("workflow walletAddress is required for metered settlement");
  }
  return `workflow:${walletAddress}`;
}

function parseSseEventBlock(rawEvent: string): ParsedSseEvent | null {
  if (!rawEvent.trim()) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  return { eventName, data };
}

function passthroughJsonRoute(pathAndQuery?: (req: Request) => string) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const runtimeResponse = await callRuntime(req, pathAndQuery ? pathAndQuery(req) : req.originalUrl);
      const { text } = await readRuntimeJson(runtimeResponse);
      applyRuntimeHeaders(res, runtimeResponse);
      res.status(runtimeResponse.status).send(text);
    })().catch(next);
  };
}

function payableJsonRoute(config: {
  action: string;
  pathAndQuery?: (req: Request) => string;
  resolveSettlement: (body: Record<string, unknown>, req: Request) => RouteSettlement;
}) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const prepared = await prepareRoutePayment(req, res, config.action);
      if (!prepared) {
        return;
      }

      const runtimeResponse = await callRuntime(req, config.pathAndQuery ? config.pathAndQuery(req) : req.originalUrl);
      const { text, body } = await readRuntimeJson<Record<string, unknown>>(runtimeResponse);

      if (!runtimeResponse.ok) {
        await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
        applyRuntimeHeaders(res, runtimeResponse);
        res.status(runtimeResponse.status).send(text);
        return;
      }

      if (!body) {
        await abortPreparedPayment(prepared, "runtime_missing_json_body");
        res.status(502).json({ error: "Runtime JSON body is required for metered settlement" });
        return;
      }

      let settlement: RouteSettlement;
      try {
        settlement = config.resolveSettlement(body, req);
      } catch (error) {
        await abortPreparedPayment(prepared, error instanceof Error ? error.message : "invalid_runtime_settlement");
        res.status(502).json({ error: error instanceof Error ? error.message : "invalid_runtime_settlement" });
        return;
      }

      await settlePreparedPayment(prepared, res, settlement);
      applyRuntimeHeaders(res, runtimeResponse);
      res.status(runtimeResponse.status).send(text);
    })().catch(next);
  };
}

function payableStreamRoute(config: {
  action: string;
  pathAndQuery?: (req: Request) => string;
  resolveSettlement: (eventName: string, data: Record<string, unknown>, req: Request) => RouteSettlement | null;
}) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const prepared = await prepareRoutePayment(req, res, config.action);
      if (!prepared) {
        return;
      }

      const runtimeResponse = await callRuntime(req, config.pathAndQuery ? config.pathAndQuery(req) : req.originalUrl);
      if (!runtimeResponse.ok) {
        const { text } = await readRuntimeJson(runtimeResponse);
        await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
        applyRuntimeHeaders(res, runtimeResponse);
        res.status(runtimeResponse.status).send(text);
        return;
      }

      if (!runtimeResponse.body) {
        await abortPreparedPayment(prepared, "runtime_stream_missing_body");
        res.status(502).json({ error: "Runtime stream body is missing" });
        return;
      }

      applyRuntimeHeaders(res, runtimeResponse);
      res.status(runtimeResponse.status);

      const reader = runtimeResponse.body.getReader();
      let ended = false;
      let settlement: RouteSettlement | null = null;
      let buffer = "";
      const decoder = new TextDecoder();

      try {
        while (!ended) {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const separatorIndex = buffer.indexOf("\n\n");
            if (separatorIndex === -1) {
              break;
            }

            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            const parsed = parseSseEventBlock(rawEvent);
            if (!parsed) {
              continue;
            }

            const resolved = config.resolveSettlement(parsed.eventName, parsed.data, req);
            if (resolved) {
              settlement = resolved;
            }
          }

          res.write(Buffer.from(value));
        }

        if (buffer.trim().length > 0) {
          const parsed = parseSseEventBlock(buffer);
          if (parsed) {
            const resolved = config.resolveSettlement(parsed.eventName, parsed.data, req);
            if (resolved) {
              settlement = resolved;
            }
          }
        }

        if (!settlement) {
          await abortPreparedPayment(prepared, "missing_authoritative_stream_settlement");
          res.write(`event: error\ndata: ${JSON.stringify({ error: "authoritative stream settlement is required" })}\n\n`);
          res.end();
          return;
        }

        await settlePreparedPayment(prepared, res, settlement);
        res.end();
      } catch (error) {
        await abortPreparedPayment(prepared, error instanceof Error ? error.message : "runtime_stream_failed");
        throw error;
      }
    })().catch(next);
  };
}

export function registerWorkflowRoutes(app: Application): void {
  app.post("/agent/:walletAddress/knowledge", passthroughJsonRoute());
  app.get("/agent/:walletAddress/knowledge", passthroughJsonRoute());
  app.post(
    "/agent/:walletAddress/chat",
    payableJsonRoute({
      action: "agent-chat",
      resolveSettlement: (body) => resolveAgentTextSettlement(body),
    }),
  );
  app.post(
    "/agent/:walletAddress/stream",
    payableStreamRoute({
      action: "agent-stream",
      resolveSettlement: (_eventName, data) => {
        if (data.type !== "done") {
          return null;
        }
        return resolveAgentTextSettlement(data);
      },
    }),
  );
  app.post(
    "/agent/:walletAddress/multimodal",
    payableJsonRoute({
      action: "agent-multimodal",
      resolveSettlement: (body) => resolveAgentMultimodalSettlement(body),
    }),
  );
  app.get("/agent/:walletAddress/runs/:runId/state", passthroughJsonRoute());

  app.post(
    "/workflow/execute",
    payableJsonRoute({
      action: "workflow-execute",
      resolveSettlement: (body, req) => resolveWorkflowSettlement(body, workflowSettlementSubject(req)),
    }),
  );
  app.post("/api/workflow/triggers/parse", passthroughJsonRoute());
  app.get("/api/workflow/:walletAddress/triggers", passthroughJsonRoute());
  app.post("/api/workflow/:walletAddress/triggers", passthroughJsonRoute());
  app.put("/api/workflow/:walletAddress/triggers/:triggerId", passthroughJsonRoute());
  app.delete("/api/workflow/:walletAddress/triggers/:triggerId", passthroughJsonRoute());

  app.post("/api/memory/add", passthroughJsonRoute());
  app.post("/api/memory/search", passthroughJsonRoute());
  app.get("/api/memory/:agentWallet", passthroughJsonRoute());
  app.post("/api/memory/vector-search", passthroughJsonRoute());
  app.post("/api/memory/vector-index", passthroughJsonRoute());
  app.post("/api/memory/transcript-store", passthroughJsonRoute());
  app.get("/api/memory/transcript-get/:id", passthroughJsonRoute());
  app.post("/api/memory/rerank", passthroughJsonRoute());
  app.post("/api/memory/layers/search", passthroughJsonRoute());
  app.get("/api/memory/stats/:agentWallet", passthroughJsonRoute());

  app.post(
    "/workflow/:walletAddress/chat",
    payableStreamRoute({
      action: "workflow-chat",
      resolveSettlement: (eventName, data, req) => (
        eventName === "result"
          ? resolveWorkflowSettlement(data, workflowSettlementSubject(req))
          : null
      ),
    }),
  );
  app.post("/workflow/:walletAddress/stop", passthroughJsonRoute());
  app.get("/workflow/:walletAddress/runs/:runId/state", passthroughJsonRoute());
  app.post("/workflow/:walletAddress/runs/:runId/approval", passthroughJsonRoute());
  app.post(
    "/workflow/:id/run",
    payableStreamRoute({
      action: "workflow-chat",
      resolveSettlement: (eventName, data, req) => (
        eventName === "result"
          ? resolveWorkflowSettlement(data, workflowSettlementSubject(req))
          : null
      ),
    }),
  );
  app.get("/frameworks", (_req, res) => {
    res.json({ frameworks: FRAMEWORKS });
  });

  app.post("/api/desktop/memory/add", passthroughJsonRoute());
  app.post("/api/desktop/memory/search", passthroughJsonRoute());
  app.get("/api/desktop/memory/:agentWallet", passthroughJsonRoute());
  app.post("/api/desktop/memory/context", passthroughJsonRoute());
  app.get("/api/desktop/skills/recommended", passthroughJsonRoute());
  app.post("/api/desktop/skills/learn", passthroughJsonRoute());
}
