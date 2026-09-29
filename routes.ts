import type { Application, NextFunction, Request, Response as ExpressResponse } from "express";

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
import { publicOriginFromHost } from "./http/public-origin.js";
import { listReceipts } from "./x402/receipts.js";
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
      return jsonResult(200, corsHeaders, await buildOpenApiDocument(publicOrigin));
    }

    if (method === "GET" && path === "/.well-known/x402") {
      return jsonResult(200, corsHeaders, await buildWellKnownX402(publicOrigin));
    }

    if (method === "GET" && path === MODELS_CATALOG) {
      return jsonResult(200, corsHeaders, listModelCatalog(event.queryStringParameters, publicOrigin));
    }

    if (method === "GET" && path === AGENTS_CATALOG) {
      return jsonResult(200, corsHeaders, await fetchAgentCatalog(event.queryStringParameters, publicOrigin));
    }

    if (method === "POST" && isEntrypoint(path, MODELS_ENTRYPOINT)) {
      if (eventSignedWithoutNetwork(event)) {
        return jsonResult(400, corsHeaders, { error: "x-network-id header is required" });
      }
      return paymentRequiredResult(corsHeaders, await buildModelsPaymentRequired(publicOrigin));
    }

    if (method === "POST" && isEntrypoint(path, AGENTS_ENTRYPOINT)) {
      if (eventSignedWithoutNetwork(event)) {
        return jsonResult(400, corsHeaders, { error: "x-network-id header is required" });
      }
      return paymentRequiredResult(corsHeaders, await buildAgentsPaymentRequired(publicOrigin));
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

    if (method === "GET" && path === "/agents") {
      return agentsRedirect(event, corsHeaders);
    }

    if (method === "GET" && path === "/agents/search") {
      const q = event.queryStringParameters?.q || event.queryStringParameters?.query || "";
      if (!q.trim()) {
        return jsonResult(400, corsHeaders, { error: "q is required" });
      }
      return agentsRedirect(event, corsHeaders);
    }

    const agentAvatarMatch = path.match(/^\/agent\/([^/]+)\/avatar$/);
    if (method === "GET" && agentAvatarMatch) {
      const walletAddress = agentAvatarMatch[1];
      if (!isWalletAddress(walletAddress)) {
        return jsonResult(400, corsHeaders, { error: "Invalid wallet address format" });
      }
      return agentsRedirect(event, corsHeaders);
    }

    const agentMatch = path.match(/^\/agent\/([^/]+)$/);
    if (method === "GET" && agentMatch) {
      const walletAddress = agentMatch[1];
      if (!isWalletAddress(walletAddress)) {
        return jsonResult(400, corsHeaders, { error: "Invalid wallet address format" });
      }
      return agentsRedirect(event, corsHeaders);
    }

    if (method === "GET" && path === "/workflows") {
      const workflows = await listWorkflows();
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

    if (method === "GET" && path === "/api/agentverse/agents") {
      // Bridge to Fetch.ai's Agentverse directory. Returns Agentverse-shape
      // agents (NOT AgentManifest); consumers wanting compose-shape
      // should map via toAgentManifest. Filter is "compose-compatible"
      // (active + non-empty name) per external/agentverse.ts.
      const q = event.queryStringParameters || {};
      const result = await searchAgentverseAgents({
        search: q.search ?? q.q ?? undefined,
        category: q.category ?? undefined,
        tags: q.tags ? q.tags.split(",").map(s => s.trim()).filter(Boolean) : undefined,
        limit: q.limit ? Math.max(1, Math.min(100, Number.parseInt(q.limit, 10) || 30)) : undefined,
        offset: q.offset ? Math.max(0, Number.parseInt(q.offset, 10) || 0) : undefined,
        sort: q.sort as "relevancy" | "created-at" | "last-modified" | "interactions" | undefined,
        direction: q.direction === "asc" ? "asc" : "desc",
      });
      return jsonResult(200, corsHeaders, result);
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[public-routes] Error:", message);
    return jsonResult(500, corsHeaders, { error: message });
  }
}

/**
 * Build a runtime-internal URL. The runtime mounts all gateway-facing Manowar
 * routes (agent + workflow + memory + workspace + triggers) under one
 * internal prefix. The api/ gateway proxies straight through.
 */
export function buildRuntimeManowarUrl(pathAndQuery: string): string {
  return `${requireRuntimeUrl()}/internal/manowar${pathAndQuery}`;
}
function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function setRequestHeader(req: Request, name: string, value: string): void {
  req.headers[name.toLowerCase()] = value;
}

function keyUserAddress(req: Request): string | undefined {
  const token = extractKeyFromHeader(getHeader(req, "authorization"));
  if (!token) {
    const userAddress = getHeader(req, "x-session-user-address");
    return userAddress && /^0x[a-fA-F0-9]{40}$/.test(userAddress) ? userAddress.toLowerCase() : userAddress;
  }
  const payload = verifyKey(token);
  const userAddress = payload?.sub || getHeader(req, "x-session-user-address");
  return userAddress && /^0x[a-fA-F0-9]{40}$/.test(userAddress) ? userAddress.toLowerCase() : userAddress;
}

function bodyRecord(req: Request): Record<string, unknown> | null {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
}

function rootRunId(req: Request): string {
  const existing = getHeader(req, "x-run-id");
  if (existing?.trim()) {
    return existing.trim();
  }
  const body = bodyRecord(req);
  const fromBody = typeof body?.runId === "string" && body.runId.trim()
    ? body.runId.trim()
    : undefined;
  return fromBody || randomUUID();
}

function applyHeaders(res: ExpressResponse, headers: Record<string, string>): void {
  if (res.headersSent) {
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

interface RequestAbort {
  signal: AbortSignal;
  aborted: () => boolean;
  done: () => void;
  cleanup: () => void;
}

function createRequestAbort(req: Request, res: ExpressResponse): RequestAbort {
  const controller = new AbortController();
  let completed = false;

  const abort = (reason: string) => {
    if (completed || controller.signal.aborted) {
      return;
    }
    controller.abort(new Error(reason));
  };

  const onReqAborted = () => abort("client_request_aborted");
  const onReqClose = () => {
    if (req.destroyed && !req.complete) {
      abort("client_request_closed");
    }
  };
  const onResClose = () => {
    if (!res.writableEnded && !res.writableFinished) {
      abort("client_response_closed");
    }
  };

  const cleanup = () => {
    req.off("aborted", onReqAborted);
    req.off("close", onReqClose);
    res.off("close", onResClose);
    res.off("finish", done);
  };

  const done = () => {
    completed = true;
    cleanup();
  };

  req.on("aborted", onReqAborted);
  req.on("close", onReqClose);
  res.on("close", onResClose);
  res.on("finish", done);

  return {
    signal: controller.signal,
    aborted: () => controller.signal.aborted,
    done,
    cleanup,
  };
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "client_closed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /aborted|abort|client_.*closed|client_.*aborted/i.test(error.message));
}

export function buildRuntimeSessionHeaders(input: {
  userAddress: string;
  sessionBudgetRemaining: string;
}): Record<string, string> {
  return {
    "x-session-active": "true",
    "x-session-user-address": /^0x[a-fA-F0-9]{40}$/.test(input.userAddress)
      ? input.userAddress.toLowerCase()
      : input.userAddress,
    "x-session-budget-remaining": input.sessionBudgetRemaining,
  };
}

export function buildRuntimeHeaders(req: Request, extraHeaders: Record<string, string> = {}): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "payment-signature" || typeof value === "undefined") {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(key, value.join(","));
    } else {
      headers.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return headers;
}

async function buildRuntimeBody(req: Request): Promise<string | Blob | undefined> {
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

async function callRuntime(
  req: Request,
  pathAndQuery = req.originalUrl,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<globalThis.Response> {
  return fetch(buildRuntimeManowarUrl(pathAndQuery), {
    method: req.method,
    headers: buildRuntimeHeaders(req, extraHeaders),
    body: await buildRuntimeBody(req),
    signal,
  });
}

function applyRuntimeHeaders(res: ExpressResponse, response: globalThis.Response): void {
  if (res.headersSent) {
    return;
  }
  response.headers.forEach((value: string, key: string) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

const SSE_OPEN_PADDING = " ".repeat(2048);

function writeSseOpen(res: ExpressResponse): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  res.write(`: open ${SSE_OPEN_PADDING}\n\n`);
  const flush = (res as ExpressResponse & { flush?: () => void }).flush;
  if (typeof flush === "function") {
    flush.call(res);
  }
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
  service: string,
  action: string,
): Promise<PaymentPreparation | null> {
  const resolvedRootRunId = rootRunId(req);
  setRequestHeader(req, "x-run-id", resolvedRootRunId);
  res.setHeader("x-run-id", resolvedRootRunId);

  // Compose Key and raw x402 share the same endpoint wrapper shape here:
  // authorize the boundary, forward the inherited run context to runtime, and
  // settle only the terminal amount when the endpoint emits usage evidence.
  try {
    if (service === "agent" && action === "stream") {
      const challenged = await maybeSendAgentStreamDiscoveryChallenge(req, res);
      if (challenged) {
        return null;
      }
    }

    const prepared = await prepareInferencePayment(req, res, {
      useBudgetCap: true,
      scheme: service === "agent" ? "batch-settlement" : "upto",
    });
    if (!prepared) {
      // 402 PAYMENT-REQUIRED (or 400/402 error) was already emitted by
      // prepareInferencePayment.
      return null;
    }
    const userAddress = keyUserAddress(req);

    return {
      mode: "x402",
      rootRunId: resolvedRootRunId,
      prepared,
      headers: {},
      runtimeHeaders: {
        ...prepared.runtimeHeaders,
        ...(userAddress ? { "x-session-user-address": userAddress } : {}),
        "x-run-id": resolvedRootRunId,
      },
      receiptContext: {
        service,
        action,
        resource: publicResourceUrl(req),
        userAddress,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment preparation failed";
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 400;
    res.status(statusCode).json({ error: message });
    return null;
  }
}

async function abortPreparedPayment(prepared: PaymentPreparation, reason: string): Promise<void> {
  await prepared.prepared.abort(reason);
}

async function settlePreparedPayment(
  prepared: PaymentPreparation,
  res: ExpressResponse,
  settlement: RouteSettlement,
  network?: NetworkId,
): Promise<Receipt | null> {
  const remember = async (input: {
    finalAmountWei?: string;
    txHash?: string;
    settlementStatus?: "queued" | "submitted" | "claimed" | "settled" | "failed";
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
    network?: NetworkId;
    settledAt?: number;
  } | null): Promise<void> => {
    if (!input || !input.finalAmountWei || !("evidence" in settlement) || !settlement.evidence) {
      return;
    }
    await recordChargeEvidence({
      ...settlement.evidence,
      finalAmountWei: input.finalAmountWei,
      settlementStatus: input.settlementStatus || (input.txHash ? "submitted" : "queued"),
      txHash: input.txHash,
      claimTxHash: input.claimTxHash,
      settleTxHash: input.settleTxHash,
      paymentIntentId: input.paymentIntentId,
      paymentChannelId: input.paymentChannelId,
      paymentCumulativeAmountWei: input.paymentCumulativeAmountWei,
      network: input.network || network,
      settledAt: input.settledAt,
    });
  };

  // Settle via prepareInferencePayment's built-in harness. It handles both
  // Compose Key and raw x402 payment methods, applies receipt headers, and
  // surfaces settlement errors.
  const settlementReceipt = await settlePreparedInferencePayment(prepared.prepared, res, settlement);
  if (
    settlementReceipt
    && BigInt(settlementReceipt.finalAmountWei || "0") > 0n
    && !settlementReceipt.txHash
    && !settlementReceipt.paymentIntentId
    && !(settlementReceipt.paymentChannelId && settlementReceipt.paymentCumulativeAmountWei)
  ) {
    throw Object.assign(
      new Error("Nonzero settlement is missing x402 payment backing"),
      { statusCode: 402 },
    );
  }
  if (settlementReceipt?.txHash && settlementReceipt.settlementStatus === "settled") void settlementReceipt.txHash;
  await remember(settlementReceipt);
  if (settlementReceipt?.evidenceOnly) {
    return null;
  }
  const receipt = await finalizeReceipt(
    withSettlementBills(receiptFromInferenceSettlement(settlementReceipt, network), settlement),
    prepared.receiptContext,
  );
  await kickBatchSettlement(
    settlementReceipt,
    `${prepared.receiptContext.service || "route"}:${prepared.receiptContext.action || "settled"}`,
  );
  return receipt;
}

function ceilPercent(amountWei: bigint, percent: number): bigint {
  if (amountWei <= 0n || percent <= 0) return 0n;
  const numerator = amountWei * BigInt(Math.trunc(percent));
  return ((numerator - 1n) / 100n) + 1n;
}



function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function terminalAgentMetadata(body: Record<string, unknown>, req: Request): {
  rootRunId: string;
  executionRunId: string;
  parentExecutionRunId?: string;
  walletAddress?: string;
  name?: string;
  model?: string;
  creatorFee: number;
} {
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
    ? body.payload as Record<string, unknown>
    : null;
  const payloadAgent = payload?.agent && typeof payload.agent === "object" && !Array.isArray(payload.agent)
    ? payload.agent as Record<string, unknown>
    : null;
  const agent = payloadAgent
    ?? (body.agent && typeof body.agent === "object" && !Array.isArray(body.agent)
      ? body.agent as Record<string, unknown>
      : {});
  const root = stringField(body.rootRunId)
    || stringField(body.rootId)
    || stringField(payload?.rootRunId)
    || getHeader(req, "x-run-id")
    || rootRunId(req);
  const execution = stringField(body.runId)
    || stringField(payload?.runId)
    || stringField(body.executionRunId)
    || getHeader(req, "x-execution-run-id")
    || root;
  const parent = stringField(body.parentExecutionRunId)
    || stringField(payload?.parentExecutionRunId)
    || getHeader(req, "x-parent-run-id");
  const creatorFee = numberField(agent.creatorFee)
    ?? numberField(body.creatorFee)
    ?? 1;
  return {
    rootRunId: root,
    executionRunId: execution,
    ...(parent ? { parentExecutionRunId: parent } : {}),
    walletAddress: stringField(agent.walletAddress) || stringField(body.walletAddress) || stringField(req.params.walletAddress),
    name: stringField(agent.name) || stringField(body.name),
    model: stringField(agent.model) || stringField(body.model),
    creatorFee: Math.max(0, Math.trunc(creatorFee)),
  };
}

function sumWei(charges: ChargeEvidence[], pick: (charge: ChargeEvidence) => string | undefined): bigint {
  return charges.reduce((total, charge) => {
    const value = pick(charge);
    return value && /^\d+$/.test(value) ? total + BigInt(value) : total;
  }, 0n);
}

function uniqueCharges(charges: ChargeEvidence[]): ChargeEvidence[] {
  const seen = new Set<string>();
  const result: ChargeEvidence[] = [];
  for (const charge of charges) {
    const id = charge.chargeId || charge.id || [
      charge.kind,
      charge.rootRunId,
      charge.executionRunId,
      charge.subject,
      charge.finalAmountWei,
      charge.settledAt,
    ].join(":");
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(charge);
  }
  return result;
}

function usd(amountWei: string | undefined): number {
  if (!amountWei || !/^\d+$/u.test(amountWei)) return 0;
  return Number(amountWei) / 1_000_000;
}

function total(amountWei: string | undefined): string {
  return `${usd(amountWei).toFixed(6)} USDC`;
}

function line(key: string, amountWei: string | undefined): LineItem | null {
  if (!amountWei || !/^\d+$/u.test(amountWei) || BigInt(amountWei) <= 0n) return null;
  return {
    key,
    unit: "charge",
    quantity: 1,
    unitPriceUsd: usd(amountWei),
    amountWei,
  };
}

function bill(input: {
  kind: Bill["kind"];
  source?: string;
  action?: string;
  subject?: string;
  name?: string;
  amountWei: string;
  lineItems: Array<LineItem | null>;
}): Bill {
  return {
    kind: input.kind,
    source: input.source,
    action: input.action,
    subject: input.subject,
    name: input.name,
    amountWei: input.amountWei,
    total: total(input.amountWei),
    duration: "0s",
    lineItems: input.lineItems.filter((item): item is LineItem => Boolean(item)),
  };
}

function evidenceBill(charge: ChargeEvidence): Bill {
  const kind = charge.kind === "agent" || charge.kind === "model" || charge.kind === "tool"
    || charge.kind === "search" || charge.kind === "memory" || charge.kind === "connector"
    ? charge.kind
    : "tool";
  const source = charge.service || charge.action || kind;
  const subject = charge.subject || charge.walletAddress || charge.name || "unknown";
  const amountWei = charge.finalAmountWei || (
    BigInt(charge.providerAmountWei || "0")
    + BigInt(charge.feeWei || "0")
    + BigInt(charge.creatorFeeWei || "0")
  ).toString();
  const prefix = `${kind}.${source}.${subject}`;
  return bill({
    kind,
    source,
    action: charge.action,
    subject,
    name: charge.name,
    amountWei,
    lineItems: [
      line(`${prefix}:provider`, charge.providerAmountWei),
      line(`${prefix}:compose_fee`, charge.feeWei),
      line(`${prefix}:creator_fee`, charge.creatorFeeWei),
    ],
  });
}

function withSettlementBills(receipt: Receipt | null, settlement: RouteSettlement): Receipt | null {
  if (!receipt || !("bills" in settlement) || !settlement.bills?.length) {
    return receipt;
  }
  return {
    ...receipt,
    bills: settlement.bills,
  };
}

function agentBill(input: {
  walletAddress?: string;
  name?: string;
  action: string;
  subject: string;
  amountWei: string;
  feeWei: string;
  creatorFeeWei: string;
  children: Bill[];
}): Bill {
  return {
    kind: "agent",
    source: "agent",
    action: input.action,
    subject: input.subject,
    name: input.name,
    amountWei: input.amountWei,
    agent: input.name || input.subject,
    ...(input.walletAddress ? { agentWallet: input.walletAddress } : {}),
    depth: 0,
    tokens: {},
    tools: input.children
      .map((child) => child.action || child.source || child.kind)
      .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index),
    total: total(input.amountWei),
    duration: "0s",
    fees: {
      total: {
        percent: "agent",
        amount: total((BigInt(input.feeWei) + BigInt(input.creatorFeeWei)).toString()),
      },
      distribution: {
        Compose: total(input.feeWei),
        Creator: total(input.creatorFeeWei),
      },
    },
    lineItems: [
      ...input.children.flatMap((child) => child.lineItems),
      line(`${input.subject}:compose_fee`, input.feeWei),
      line(`${input.subject}:creator_fee`, input.creatorFeeWei),
    ].filter((item): item is LineItem => Boolean(item)),
    children: input.children,
  };
}

async function resolveAgentEndpointSettlement(
  body: Record<string, unknown>,
  req: Request,
  action: string,
): Promise<RouteSettlement> {
  const meta = terminalAgentMetadata(body, req);
  const executionCharges = await listExecutionEvidence(meta.rootRunId, meta.executionRunId);
  const direct = uniqueCharges(executionCharges)
    .filter((charge) => charge.kind !== "agent");
  const childAgents = uniqueCharges(await listChildEvidence(meta.rootRunId, meta.executionRunId))
    .filter((charge) => charge.kind === "agent");
  const directBaseWei = sumWei(direct, (charge) => charge.providerAmountWei);
  const childAgentBaseWei = sumWei(childAgents, (charge) => charge.providerAmountWei);
  const feeBase = directBaseWei + childAgentBaseWei;

  const feeWei = ceilPercent(feeBase, 1);
  const creatorFeeWei = ceilPercent(feeBase, meta.creatorFee);
  const wrapperFeeWei = feeWei + creatorFeeWei;
  const childBills = [
    ...direct.map(evidenceBill),
    ...childAgents.map(evidenceBill),
  ];
  const displayTotalWei = childBills.reduce(
    (sum, child) => sum + BigInt(child.amountWei || "0"),
    wrapperFeeWei,
  );
  const subject = `agent:${(meta.walletAddress || stringField(req.params.walletAddress) || "unknown").toLowerCase()}`;
  const wrapperPrefix = `agent.${action}.${subject}`;

  return {
    finalAmountWei: wrapperFeeWei.toString(),
    providerAmountWei: feeBase.toString(),
    platformFeeWei: feeWei.toString(),
    meterSubject: subject,
    bills: [
      agentBill({
        walletAddress: meta.walletAddress,
        name: meta.name,
        action,
        subject,
        amountWei: displayTotalWei.toString(),
        feeWei: feeWei.toString(),
        creatorFeeWei: creatorFeeWei.toString(),
        children: childBills,
      }),
      bill({
        kind: "agent",
        source: "agent",
        action,
        subject,
        name: meta.name,
        amountWei: wrapperFeeWei.toString(),
        lineItems: [
          line(`${wrapperPrefix}:compose_fee`, feeWei.toString()),
          line(`${wrapperPrefix}:creator_fee`, creatorFeeWei.toString()),
        ],
      }),
    ],
    evidence: {
      kind: "agent",
      rootRunId: meta.rootRunId,
      executionRunId: meta.executionRunId,
      ...(meta.parentExecutionRunId ? { parentExecutionRunId: meta.parentExecutionRunId } : {}),
      walletAddress: meta.walletAddress,
      name: meta.name,
      service: "agent",
      action,
      subject,
      providerAmountWei: feeBase.toString(),
      feeWei: feeWei.toString(),
      creatorFeeWei: creatorFeeWei.toString(),
    },
  };
}

function resolveAgentTextSettlement(
  body: Record<string, unknown>,
  req: Request,
  action = "stream",
): Promise<RouteSettlement> {
  return resolveAgentEndpointSettlement(body, req, action);
}

function resolveAgentResponsesSettlement(body: Record<string, unknown>, req: Request): Promise<RouteSettlement> {
  return resolveAgentEndpointSettlement(body, req, "responses");
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

  for (const line of rawEvent.split(/\r?\n/)) {
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

  const dataStr = dataLines.join("\n").trim();
  // `[DONE]` is the canonical OpenAI/SSE stream terminator; not JSON. Skip it
  // here so it passes through to the client unchanged. Without this guard,
  // JSON.parse throws, the gateway aborts the prepared x402 payment, and on-chain
  // settlement never lands — the symptom that looks like "agent loops forever"
  // because the gateway holds the connection until Cloud Run timeout (5 min).
  if (dataStr === "[DONE]") {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    // Non-JSON data lines (e.g. arbitrary SSE comments routed via `data:`)
    // never carry settlement metadata. Skip silently so the stream continues.
    return null;
  }
  return { eventName, data };
}

function terminal(data: Record<string, unknown>): boolean {
  if (data.domain === "activity") {
    // The runtime opens every stream with an `activity.run` frame in the
    // `running` status; only the non-running frames are terminals.
    return (data.type === "activity.run" || data.type === "activity.error") && data.status !== "running";
  }
  return data.type === "done" || data.type === "stopped" || data.type === "error";
}

function sseDataHasTextDelta(data: Record<string, unknown>): boolean {
  if (data.domain === "model" && data.type === "model.text.delta" && typeof data.delta === "string") {
    return true;
  }
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return false;
  }
  const delta = (first as { delta?: unknown }).delta;
  return Boolean(delta && typeof delta === "object" && typeof (delta as { content?: unknown }).content === "string");
}

function usageful(data: Record<string, unknown>): boolean {
  const payload = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
    ? data.payload as Record<string, unknown>
    : null;
  const payloadUsage = payload?.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
    ? payload.usage as Record<string, unknown>
    : null;
  const usage = payloadUsage
    || (data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
      ? data.usage as Record<string, unknown>
      : data);
  const numericKeys = [
    "prompt_tokens",
    "completion_tokens",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
    "promptTokens",
    "completionTokens",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ];
  if (numericKeys.some((key) => typeof usage[key] === "number" && usage[key] > 0)) {
    return true;
  }
  const billingMetrics = usage.billingMetrics && typeof usage.billingMetrics === "object" && !Array.isArray(usage.billingMetrics)
    ? usage.billingMetrics as Record<string, unknown>
    : null;
  return Boolean(billingMetrics && Object.values(billingMetrics).some((value) => typeof value === "number" && value > 0));
}

function metered(data: Record<string, unknown>): boolean {
  return Array.isArray(data.meters) && data.meters.length > 0;
}

function failclosed(data: Record<string, unknown>, error: unknown): boolean {
  return Boolean(
    error
    && terminal(data)
    && (data.type === "done" || metered(data) || usageful(data))
  );
}

function passthroughJsonRoute(pathAndQuery?: (req: Request) => string) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      try {
        const runtimeResponse = await callRuntime(req, pathAndQuery ? pathAndQuery(req) : req.originalUrl, {}, lifecycle.signal);
        const { text } = await readRuntimeJson(runtimeResponse);
        if (lifecycle.aborted()) {
          return;
        }
        applyRuntimeHeaders(res, runtimeResponse);
        res.status(runtimeResponse.status).send(text);
        lifecycle.done();
      } finally {
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

function command(path: string): string {
  return path
    .replace(/^\/api\//u, "")
    .replace(/[:]/gu, "")
    .replace(/[/.]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
}

/**
 * Unpaid byte-for-byte SSE passthrough for observation streams (run watch).
 * The runtime owns the event vocabulary; the gateway only pipes frames and
 * lifecycle. Non-OK runtime responses surface as JSON with the runtime's
 * status, mirroring passthroughJsonRoute.
 */
function passthroughStreamRoute() {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      try {
        const runtimeResponse = await callRuntime(req, req.originalUrl, {}, lifecycle.signal);
        if (!runtimeResponse.ok) {
          const { text } = await readRuntimeJson(runtimeResponse);
          if (lifecycle.aborted()) {
            return;
          }
          applyRuntimeHeaders(res, runtimeResponse);
          res.status(runtimeResponse.status).send(text);
          lifecycle.done();
          return;
        }
        if (lifecycle.aborted()) {
          return;
        }
        writeSseOpen(res);
        if (!runtimeResponse.body) {
          res.write("data: [DONE]\n\n");
          res.end();
          lifecycle.done();
          return;
        }
        const reader = runtimeResponse.body.getReader();
        res.on("close", () => {
          void reader.cancel().catch(() => undefined);
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (lifecycle.aborted()) {
            void reader.cancel().catch(() => undefined);
            return;
          }
          if (!res.write(value)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
        if (!res.writableEnded) {
          res.end();
        }
        lifecycle.done();
      } finally {
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

function zeroResourceSettlement(req: Request, kind: "memory", action: string): RouteSettlement {
  const root = getHeader(req, "x-run-id") || rootRunId(req);
  const body = bodyRecord(req);
  const execution = getHeader(req, "x-execution-run-id")
    || stringField(body?.runId)
    || root;
  const parent = getHeader(req, "x-parent-run-id")
    || stringField(body?.parentExecutionRunId);
  const subject = `${kind}:${action}`;
  return {
    finalAmountWei: "0",
    providerAmountWei: "0",
    platformFeeWei: "0",
    meterSubject: subject,
    evidence: {
      kind,
      rootRunId: root,
      executionRunId: execution,
      ...(parent ? { parentExecutionRunId: parent } : {}),
      service: kind,
      action,
      subject,
      providerAmountWei: "0",
      feeWei: "0",
    },
  };
}

function memoryRoute(path: string) {
  const action = command(path);
  return payableJsonRoute({
    service: "memory",
    action,
    resolveSettlement: (_body, req) => zeroResourceSettlement(req, "memory", action),
  });
}

type Method = "get" | "post" | "patch" | "delete";

const memory: ReadonlyArray<readonly [Method, string]> = [
  ["post", "/api/memory/context/assemble"],
  ["post", "/api/memory/turns/record"],
  ["post", "/api/memory/remember"],
  ["post", "/api/memory/loop"],
  ["get", "/api/memory/loops"],
  ["get", "/api/memory/loops/:loopId"],
  ["get", "/api/memory/patterns"],
  ["get", "/api/memory/patterns/:patternId"],
  ["post", "/api/memory/patterns/:patternId/validate"],
  ["post", "/api/memory/patterns/:patternId/promote"],
  ["get", "/api/memory/skills"],
  ["get", "/api/memory/skills/:skillId"],
  ["post", "/api/memory/transcripts/index"],
  ["get", "/api/memory/sessions/:sessionId/working"],
  ["patch", "/api/memory/sessions/:sessionId/working"],
  ["post", "/api/memory/sessions/:sessionId/compress"],
  ["post", "/api/memory/archives/:archiveId/sync"],
  ["get", "/api/memory/schedules"],
  ["post", "/api/memory/schedules"],
  ["delete", "/api/memory/schedules"],
  ["post", "/api/memory/schedules/:scheduleId/pause"],
  ["post", "/api/memory/schedules/:scheduleId/resume"],
  ["post", "/api/memory/schedules/:scheduleId/trigger"],
  ["post", "/api/memory/add"],
  ["post", "/api/memory/search"],
  ["post", "/api/memory/vector-search"],
  ["post", "/api/memory/vector-index"],
  ["post", "/api/memory/transcript-store"],
  ["get", "/api/memory/transcript-get/:id"],
  ["post", "/api/memory/rerank"],
  ["post", "/api/memory/layers/search"],
  ["get", "/api/memory/stats/:agentWallet"],
  ["post", "/api/memory/items/search"],
  ["get", "/api/memory/items/:id"],
  ["patch", "/api/memory/items/:id"],
  ["delete", "/api/memory/items/:id"],
  ["post", "/api/memory/conflicts/:id/resolve"],
  ["post", "/api/memory/jobs"],
  ["get", "/api/memory/jobs/:jobId"],
  ["post", "/api/memory/evals/runs"],
  ["get", "/api/memory/:agentWallet"],
];

function mount(app: Application, routes: ReadonlyArray<readonly [Method, string]>): void {
  for (const [method, path] of routes) {
    app[method](path, memoryRoute(path));
  }
}

function pathSegment(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
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

function receiptIdentity(req: Request): { userAddress: string; network: NetworkId } | { error: string; status: number } {
  const raw = getHeader(req, "x-session-user-address");
  if (!raw) {
    return { error: "x-session-user-address header required", status: 401 };
  }
  const userAddress = raw.trim();
  const network = receiptNetwork(req);
  if (!userAddress || !network) return { error: "Valid x-network-id header required", status: 401 };
  return { userAddress, network };
}

function receiptsRoute() {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    const identity = receiptIdentity(req);
    if ("error" in identity) {
      res.status(identity.status).json({ error: identity.error });
      return;
    }

    void listReceipts({
      userAddress: identity.userAddress,
      network: identity.network,
      limit: receiptLimit(req),
    }).then((result) => res.status(200).json(result)).catch(next);
  };
}

function mapConnectorsProxyTarget(req: Request): { path: string; method?: string; body?: unknown } | null {
  const url = new URL(req.originalUrl, "http://compose-api.local");
  const pathname = url.pathname;
  const search = url.search;

  if (pathname.startsWith("/api/mcps")) {
    return { path: `/mcps${pathname.slice("/api/mcps".length)}${search}` };
  }
  if (pathname.startsWith("/api/onchain")) {
    return { path: `/onchain${pathname.slice("/api/onchain".length)}${search}` };
  }

  return null;
}

function connectorsProxyRoute() {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      const target = mapConnectorsProxyTarget(req);
      if (!target) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      try {
        const headers = buildRuntimeHeaders(req);
        const method = target.method || req.method;
        const body = target.body === undefined
          ? (method === "GET" || method === "HEAD" ? undefined : await buildRuntimeBody(req))
          : JSON.stringify(target.body);
        if (target.body !== undefined) {
          headers.set("Content-Type", "application/json");
        }
        // The connectors Worker Bearer-gates privileged routes when
        // CONNECTORS_API_TOKEN is set; the browser never holds this token,
        // so the API injects it server-side.
        const connectorsToken = (process.env.CONNECTORS_API_TOKEN || "").trim();
        if (connectorsToken) {
          headers.set("Authorization", `Bearer ${connectorsToken}`);
        }
        const response = await fetch(`${requireConnectorsUrl()}${target.path}`, {
          method,
          headers,
          body,
          signal: lifecycle.signal,
        });
        const text = await response.text();
        if (lifecycle.aborted()) {
          return;
        }
        applyRuntimeHeaders(res, response);
        res.status(response.status).send(text);
        lifecycle.done();
      } finally {
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

// ---------------------------------------------------------------------------
// Server-side Pinata pin proxy.
//
// The web client used to embed VITE_PINATA_JWT and call api.pinata.cloud
// directly, which leaks full pin/unpin authority to every browser. These
// routes keep the JWT server-side and forward only the three pin operations
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

function payableJsonRoute(config: {
  service: string;
  action: string;
  pathAndQuery?: (req: Request) => string;
  resolveSettlement: (body: Record<string, unknown>, req: Request) => RouteSettlement | Promise<RouteSettlement>;
}) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      let prepared: PaymentPreparation | null = null;
      prepared = await prepareRoutePayment(req, res, config.service, config.action);
      if (!prepared) {
        lifecycle.cleanup();
        return;
      }

      try {
        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }

        const runtimeResponse = await callRuntime(
          req,
          config.pathAndQuery ? config.pathAndQuery(req) : req.originalUrl,
          prepared.runtimeHeaders,
          lifecycle.signal,
        );
        const { text, body } = await readRuntimeJson<Record<string, unknown>>(runtimeResponse);

        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }

        let settlement: RouteSettlement | null = null;
        if (body) {
          try {
            settlement = await config.resolveSettlement(body, req);
          } catch {
            settlement = null;
          }
        }

        if (!runtimeResponse.ok) {
          if (settlement) {
            await settlePreparedPayment(prepared, res, settlement);
          } else {
            await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
          }
          applyRuntimeHeaders(res, runtimeResponse);
          res.status(runtimeResponse.status).send(text);
          lifecycle.done();
          return;
        }

        if (!body) {
          await abortPreparedPayment(prepared, "runtime_missing_json_body");
          res.status(502).json({ error: "Runtime JSON body is required for metered settlement" });
          lifecycle.done();
          return;
        }

        if (!settlement) {
          try {
            settlement = await config.resolveSettlement(body, req);
          } catch (error) {
            await abortPreparedPayment(prepared, error instanceof Error ? error.message : "invalid_runtime_settlement");
            res.status(502).json({ error: error instanceof Error ? error.message : "invalid_runtime_settlement" });
            lifecycle.done();
            return;
          }
        }

        await settlePreparedPayment(prepared, res, settlement);
        applyRuntimeHeaders(res, runtimeResponse);
        res.status(runtimeResponse.status).send(text);
        lifecycle.done();
      } catch (error) {
        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }
        throw error;
      } finally {
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

function payableStreamRoute(config: {
  service: string;
  action: string;
  pathAndQuery?: (req: Request) => string;
  isSettlementEvent: (eventName: string, data: Record<string, unknown>) => boolean;
  resolveSettlement: (eventName: string, data: Record<string, unknown>, req: Request) => RouteSettlement | null | Promise<RouteSettlement | null>;
}) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      const requestReceivedAt = Date.now();
      const markTiming = createTimingLogger("api-stream-timing", {
        service: config.service,
        action: config.action,
        path: req.originalUrl,
      }, requestReceivedAt);
      markTiming("request_received", requestReceivedAt);
      const prepared = await prepareRoutePayment(req, res, config.service, config.action);
      if (!prepared) {
        lifecycle.cleanup();
        return;
      }
      markTiming("payment_prepared");

      if (lifecycle.aborted()) {
        await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
        lifecycle.cleanup();
        return;
      }

      writeSseOpen(res);
      markTiming("gateway_headers_flushed");
      markTiming("gateway_open_written");
      res.on("close", () => markTiming("close"));

      const writeGatewayError = (status: number, error: string) => {
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ error, status })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
        lifecycle.done();
      };

      let runtimeResponse: globalThis.Response;
      try {
        runtimeResponse = await callRuntime(
          req,
          config.pathAndQuery ? config.pathAndQuery(req) : req.originalUrl,
          prepared.runtimeHeaders,
          lifecycle.signal,
        );
      } catch (error) {
        if (lifecycle.aborted() || isAbortError(error)) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          lifecycle.cleanup();
          return;
        }
        const message = error instanceof Error ? error.message : "runtime_stream_unavailable";
        await abortPreparedPayment(prepared, message);
        writeGatewayError(502, message);
        return;
      }
      markTiming("runtime_response_headers");
      if (!runtimeResponse.ok) {
        const { text } = await readRuntimeJson(runtimeResponse);
        await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
        writeGatewayError(runtimeResponse.status, text || `runtime_${runtimeResponse.status}`);
        return;
      }

      if (!runtimeResponse.body) {
        await abortPreparedPayment(prepared, "runtime_stream_missing_body");
        writeGatewayError(502, "Runtime stream body is missing");
        return;
      }

      applyRuntimeHeaders(res, runtimeResponse);

      const reader = runtimeResponse.body.getReader();
      const cancelReader = () => {
        void reader.cancel().catch(() => {
          // Best effort: the fetch signal already carries the shutdown reason.
        });
      };
      lifecycle.signal.addEventListener("abort", cancelReader, { once: true });
      let ended = false;
      let settlement: RouteSettlement | null = null;
      let terminalSettlementPromise: Promise<RouteSettlement | null> | null = null;
      let settlementPromise: Promise<Receipt | null> | null = null;
      let settlementDone = false;
      let receiptWritten = false;
      let sawExplicitErrorEvent = false;
      let buffer = "";
      const decoder = new TextDecoder();
      const networkHeader = getHeader(req, "x-network-id");
      const resolvedNetwork = networkHeader && isNetworkId(networkHeader) ? networkHeader : undefined;

      const canWrite = () => !res.destroyed && !res.writableEnded;
      const settleOnce = async () => {
        if (!settlement) {
          throw new Error("authoritative stream settlement is required");
        }
        settlementPromise ??= settlePreparedPayment(
          prepared,
          res,
          settlement,
          resolvedNetwork,
        ).then((receipt) => {
          settlementDone = true;
          markTiming("settled");
          return receipt;
        });
        return settlementPromise;
      };
      const writeReceipt = (receipt: Receipt | null) => {
        if (!receipt || receiptWritten || !canWrite()) {
          return;
        }
        // Streaming receipts must be emitted in-band. The underlying
        // Node response flushes headers on the first `res.write`, so any
        // settlement headers set after the stream starts are not visible to
        // clients. The gateway solves this by writing `event: receipt`
        // before ending the stream; the generic runtime paywall must do the
        // same for agent/workflow SSE routes.
        res.write(toReceiptStreamEvent(receiptStreamPayload(receipt)));
        receiptWritten = true;
        markTiming("receipt_written");
      };
      const takeSseBlock = (): string | null => {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) {
          return null;
        }
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        return rawEvent;
      };

      try {
        while (!ended) {
          if (lifecycle.aborted()) {
            await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            markTiming("runtime_stream_done");
            break;
          }

          markTiming("first_runtime_chunk");
          buffer += decoder.decode(value, { stream: true });
          let sawTerminalSettlement = false;
          let sawTerminalAbort = false;
          let terminalSettlementError: unknown = null;
          let terminalAbortData: Record<string, unknown> | null = null;
          while (true) {
            const rawEvent = takeSseBlock();
            if (rawEvent === null) {
              break;
            }
            const parsed = parseSseEventBlock(rawEvent);
            if (!parsed) {
              continue;
            }
            markTiming("first_upstream_sse_frame");
            if (
              parsed.data.type === "model_start"
              || (parsed.data.type === "timing" && parsed.data.mark === "model_start")
              || (parsed.data.domain === "model" && parsed.data.type === "model.start")
            ) {
              markTiming("first_runtime_model_start");
            }
            if (
              sseDataHasTextDelta(parsed.data)
              || (parsed.data.type === "timing" && parsed.data.mark === "first_text_delta")
            ) {
              markTiming("first_runtime_text_delta");
            }

            if (parsed.eventName === "error" || parsed.data.type === "error") {
              sawExplicitErrorEvent = true;
            }

            if (config.isSettlementEvent(parsed.eventName, parsed.data)) {
              terminalSettlementPromise ??= Promise.resolve().then(() =>
                config.resolveSettlement(parsed.eventName, parsed.data, req),
              );
              sawTerminalSettlement = true;
              markTiming("terminal_settlement_event");
            } else if (terminal(parsed.data)) {
              terminalAbortData = parsed.data;
              sawTerminalAbort = true;
              markTiming("terminal_abort_event");
            }
          }

          if (sawTerminalAbort && !settlement) {
            const text = Buffer.from(value).toString("utf8");
            markTiming("first_downstream_write");
            if (terminalAbortData && failclosed(terminalAbortData, terminalSettlementError)) {
              await abortPreparedPayment(prepared, terminalSettlementError instanceof Error ? terminalSettlementError.message : "invalid_runtime_settlement");
              if (canWrite()) {
                res.write(`event: error\ndata: ${JSON.stringify({
                  error: terminalSettlementError instanceof Error ? terminalSettlementError.message : "invalid_runtime_settlement",
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
              }
              lifecycle.done();
              ended = true;
              try {
                await reader.cancel();
              } catch {
                // best-effort; payment has already been aborted
              }
              break;
            }
            if (canWrite()) {
              res.write(text);
            }
            await abortPreparedPayment(prepared, "runtime_terminal_without_billable_usage");
            if (canWrite() && !text.includes("data: [DONE]")) {
              res.write("data: [DONE]\n\n");
            }
            if (canWrite()) {
              res.end();
            }
            lifecycle.done();
            ended = true;
            try {
              await reader.cancel();
            } catch {
              // best-effort; payment has already been aborted
            }
            break;
          }

          if (sawTerminalSettlement && terminalSettlementPromise) {
            const text = Buffer.from(value).toString("utf8");
            markTiming("first_downstream_write");
            if (canWrite()) {
              res.write(text);
            }
            if (canWrite() && !text.includes("data: [DONE]")) {
              res.write("data: [DONE]\n\n");
            }
            if (canWrite()) {
              res.end();
            }
            lifecycle.done();
            ended = true;
            try {
              await reader.cancel();
            } catch {
              // best-effort; the client stream is already complete
            }

            settlement = await terminalSettlementPromise;
            if (!settlement) {
              await abortPreparedPayment(prepared, "runtime_terminal_without_billable_usage");
              break;
            }
            await settleOnce();
            break;
          }

          markTiming("first_downstream_write");
          res.write(Buffer.from(value));
        }

        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }

        if (buffer.trim().length > 0) {
          const parsed = parseSseEventBlock(buffer);
          if (parsed) {
            if (parsed.eventName === "error" || parsed.data.type === "error") {
              sawExplicitErrorEvent = true;
            }
            let resolved: RouteSettlement | null = null;
            let terminalSettlementError: unknown = null;
            try {
              resolved = await config.resolveSettlement(parsed.eventName, parsed.data, req);
            } catch (error) {
              if (!terminal(parsed.data)) {
                throw error;
              }
              terminalSettlementError = error;
              markTiming("terminal_abort_event");
            }
            if (resolved) {
              settlement = resolved;
              markTiming("terminal_settlement_event");
            } else if (failclosed(parsed.data, terminalSettlementError)) {
              throw terminalSettlementError instanceof Error ? terminalSettlementError : new Error("invalid_runtime_settlement");
            }
          }
        }

        if (!settlement) {
          await abortPreparedPayment(prepared, "missing_authoritative_stream_settlement");
          if (!sawExplicitErrorEvent) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: "authoritative stream settlement is required" })}\n\n`);
          }
          res.end();
          lifecycle.done();
          return;
        }

        const receipt = await settleOnce();
        writeReceipt(receipt);
        if (canWrite()) {
          res.end();
        }
        lifecycle.done();
      } catch (error) {
        if (lifecycle.aborted() || isAbortError(error)) {
          if (!settlementDone) {
            await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          }
          try {
            await reader.cancel();
          } catch {
            // best-effort cleanup after a client abort
          }
          return;
        }
        if (settlement && !settlementDone) {
          const receipt = await settleOnce();
          writeReceipt(receipt);
        }
        if (!settlementDone) {
          await abortPreparedPayment(prepared, error instanceof Error ? error.message : "runtime_stream_failed");
        }
        try {
          await reader.cancel();
        } catch {
          // best-effort cleanup after a stream failure
        }
        if (!canWrite()) {
          return;
        }
        if (res.headersSent) {
          const message = error instanceof Error ? error.message : "runtime_stream_failed";
          res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        throw error;
      } finally {
        lifecycle.signal.removeEventListener("abort", cancelReader);
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

export function registerManowarRoutes(app: Application): void {
  app.use("/api/mcps", connectorsProxyRoute());
  app.use("/api/onchain", connectorsProxyRoute());
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

  app.post(
    "/agent/:walletAddress/stream",
    payableStreamRoute({
      service: "agent",
      action: "stream",
      isSettlementEvent: (_eventName, data) => (
        data.domain === "activity"
          ? (data.type === "activity.run" || data.type === "activity.error") && data.status !== "running"
          : data.type === "done" || data.type === "stopped" || data.type === "error"
      ),
      resolveSettlement: (_eventName, data, req) => {
        // Settle on any terminal event. The domain protocol closes every
        // stream with a non-running `activity.run` (completed/cancelled) or an
        // `activity.error`, both carrying `payload.usage`/`payload.agent` —
        // the runtime's opening `activity.run` frame has status `running` and
        // is NOT a terminal. The legacy wire names remain accepted so
        // pre-cutover runtimes still settle.
        const domainTerminal = data.domain === "activity"
          && (data.type === "activity.run" || data.type === "activity.error")
          && data.status !== "running";
        const legacyTerminal = data.type === "done" || data.type === "stopped" || data.type === "error";
        if (!domainTerminal && !legacyTerminal) {
          return null;
        }
        return resolveAgentTextSettlement(data, req, "stream");
      },
    }),
  );
  app.post(
    "/agent/:walletAddress/responses",
    payableJsonRoute({
      service: "agent",
      action: "responses",
      resolveSettlement: (body, req) => resolveAgentResponsesSettlement(body, req),
    }),
  );
  app.get("/agent/:walletAddress/runs/:runId/state", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/approval", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/connector", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/stop", passthroughJsonRoute());
  app.get("/agent/:walletAddress/runs/:runId/events", passthroughStreamRoute());

  app.post(
    "/workflow/execute",
    payableJsonRoute({
      service: "workflow",
      action: "workflow-execute",
      resolveSettlement: (body, req) => resolveWorkflowSettlement(body, workflowSettlementSubject(req)),
    }),
  );
  app.get("/workflow/prices", passthroughJsonRoute());
  app.post("/api/workflow/triggers/parse", passthroughJsonRoute());
  app.get("/api/workflow/:walletAddress/triggers", passthroughJsonRoute());
  app.post("/api/workflow/:walletAddress/triggers", passthroughJsonRoute());
  app.put("/api/workflow/:walletAddress/triggers/:triggerId", passthroughJsonRoute());
  app.delete("/api/workflow/:walletAddress/triggers/:triggerId", passthroughJsonRoute());

  app.post("/api/workspace/index", passthroughJsonRoute());
  app.post("/api/workspace/search", passthroughJsonRoute());

  mount(app, memory);

  app.post(
    "/workflow/:walletAddress/stream",
    payableStreamRoute({
      service: "workflow",
      action: "workflow-stream",
      isSettlementEvent: (eventName) => eventName === "result",
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
      service: "workflow",
      action: "workflow-stream",
      isSettlementEvent: (eventName) => eventName === "result",
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
}
