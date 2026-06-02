import { randomUUID } from "node:crypto";
import type { Application, NextFunction, Request, Response as ExpressResponse } from "express";

import {
  buildUsageRecordSettlementMeter,
  type UsageRecord,
} from "./x402/metering.js";
import {
  extractComposeKeyFromHeader,
  validateComposeKey,
} from "./x402/keys/middleware.js";
import { getActiveSessionStatus, verifyComposeKey } from "./x402/keys/index.js";
import { getActiveChainId } from "./x402/configs/chains.js";
import {
  kickBatchSettlement,
  prepareInferencePayment,
  settlePreparedInferencePayment,
  type PreparedInferencePayment,
} from "./x402/index.js";
import {
  listChildEvidence,
  listExecutionEvidence,
  recordChargeEvidence,
  type ChargeEvidence,
} from "./x402/evidence.js";
import { type Receipt, type ReceiptBill, type ReceiptLineItem } from "./http/request-context.js";
import { toReceiptStreamEvent } from "./inference/core.js";
import {
  buildAgentResponsesSettlement,
  buildAgentTextSettlement,
  finalizeReceipt,
  listReceipts,
  receiptFromInferenceSettlement,
  receiptStreamPayload,
  type ReceiptContext,
  type RouteSettlement,
} from "./x402/receipts.js";
import {
  findAgentByWallet,
  findWorkflowByWallet,
  listAgents,
  listWorkflows,
  searchAgents as searchAgentCards,
  type AgentCard,
  type WorkflowMetadata,
} from "./agents.js";
import { searchAgents as searchAgentverseAgents } from "./agentverse.js";
export type { AgentCard, WorkflowMetadata } from "./agents.js";

interface PublicRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  queryStringParameters?: Record<string, string | undefined>;
}

interface PublicRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

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

type PaymentPreparation =
  | {
    mode: "x402";
    rootRunId: string;
    prepared: PreparedInferencePayment;
    headers: Record<string, string>;
    runtimeHeaders: Record<string, string>;
    receiptContext: ReceiptContext;
  };

type ParsedSseEvent = {
  eventName: string;
  data: Record<string, unknown>;
};

function createTimingLogger(label: string, metadata: Record<string, unknown>, startedAt = Date.now()) {
  const marks: Record<string, number> = {};
  return (name: string, at = Date.now()) => {
    if (marks[name] !== undefined) {
      return;
    }
    marks[name] = at - startedAt;
    console.log(`[${label}]`, JSON.stringify({ ...metadata, mark: name, elapsedMs: marks[name], marks }));
  };
}

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

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePinataGateway(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function requireRuntimeUrl(): string {
  const value = process.env.RUNTIME_URL;
  if (!value) {
    throw new Error("RUNTIME_URL is required");
  }
  return normalizeUrl(value);
}

function publicResourceUrl(req: Request): string {
  return `https://${req.get("host")}${req.originalUrl}`;
}

function requireConnectorsUrl(): string {
  const value = process.env.CONNECTORS_URL;
  if (!value) {
    throw new Error("CONNECTORS_URL is required");
  }
  return normalizeUrl(value);
}

function modelsUrl(): string {
  return normalizeUrl(process.env.MODELS_URL || "https://models.compose.market");
}

async function listModels(): Promise<unknown[]> {
  const response = await fetch(`${modelsUrl()}/models?limit=100`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`models catalog failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const parsed = await response.json() as { data?: unknown[] };
  return Array.isArray(parsed.data) ? parsed.data : [];
}

function isWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
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
      return jsonResult(200, corsHeaders, {
        object: "list",
        data: await listModels(),
      });
    }

    if (method === "GET" && path === "/agents") {
      const agents = await listAgents();
      return jsonResult(200, corsHeaders, {
        agents,
        total: agents.length,
      });
    }

    if (method === "GET" && path === "/agents/search") {
      const q = event.queryStringParameters?.q || event.queryStringParameters?.query || "";
      if (!q.trim()) {
        return jsonResult(400, corsHeaders, { error: "q is required" });
      }
      const limit = event.queryStringParameters?.limit
        ? Math.max(1, Math.min(50, Number.parseInt(event.queryStringParameters.limit, 10) || 8))
        : 8;
      const agents = await searchAgentCards(q, limit);
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
      // agents (NOT ComposeAgentManifest); consumers wanting compose-shape
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
 * Build a runtime-internal URL. The runtime mounts ALL gateway-facing routes
 * (agent + workflow + memory + workspace + triggers) under `/internal/workflow`
 * for historical reasons; the prefix is the mount path, not a product
 * namespace. The api/ gateway proxies straight through.
 */
export function buildRuntimeInternalUrl(pathAndQuery: string): string {
  return `${requireRuntimeUrl()}/internal/workflow${pathAndQuery}`;
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

function composeKeyUserAddress(req: Request): string | undefined {
  const token = extractComposeKeyFromHeader(getHeader(req, "authorization"));
  if (!token) {
    return getHeader(req, "x-session-user-address")?.toLowerCase();
  }
  const payload = verifyComposeKey(token);
  return payload?.sub?.toLowerCase() || getHeader(req, "x-session-user-address")?.toLowerCase();
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
  const fromBody = typeof body?.composeRunId === "string" && body.composeRunId.trim()
    ? body.composeRunId.trim()
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
    "x-session-user-address": input.userAddress.toLowerCase(),
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
  return fetch(buildRuntimeInternalUrl(pathAndQuery), {
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
    const prepared = await prepareInferencePayment(req, res, {
      useBudgetCap: true,
      scheme: service === "agent" ? "batch-settlement" : "upto",
    });
    if (!prepared) {
      // 402 PAYMENT-REQUIRED (or 400/402 error) was already emitted by
      // prepareInferencePayment.
      return null;
    }
    const userAddress = composeKeyUserAddress(req);

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
  chainId?: number,
): Promise<Receipt | null> {
  const remember = async (input: {
    finalAmountWei?: string;
    txHash?: string;
    settlementStatus?: "queued" | "claimed" | "settled" | "failed";
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    sessionBudgetIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
    chainId?: number;
    settledAt?: number;
  } | null): Promise<void> => {
    if (!input || !input.finalAmountWei || !("evidence" in settlement) || !settlement.evidence) {
      return;
    }
    await recordChargeEvidence({
      ...settlement.evidence,
      finalAmountWei: input.finalAmountWei,
      settlementStatus: input.settlementStatus || (input.txHash ? "settled" : "queued"),
      txHash: input.txHash,
      claimTxHash: input.claimTxHash,
      settleTxHash: input.settleTxHash,
      paymentIntentId: input.paymentIntentId,
      sessionBudgetIntentId: input.sessionBudgetIntentId,
      paymentChannelId: input.paymentChannelId,
      paymentCumulativeAmountWei: input.paymentCumulativeAmountWei,
      chainId: input.chainId || chainId,
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
    && !settlementReceipt.sessionBudgetIntentId
    && !(settlementReceipt.paymentChannelId && settlementReceipt.paymentCumulativeAmountWei)
  ) {
    throw Object.assign(
      new Error("Nonzero settlement is missing x402 payment backing"),
      { statusCode: 402 },
    );
  }
  await remember(settlementReceipt);
  if (settlementReceipt?.evidenceOnly) {
    return null;
  }
  const receipt = await finalizeReceipt(
    withSettlementBills(receiptFromInferenceSettlement(settlementReceipt, chainId), settlement),
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
  const agent = body.agent && typeof body.agent === "object" && !Array.isArray(body.agent)
    ? body.agent as Record<string, unknown>
    : {};
  const root = stringField(body.rootComposeRunId)
    || stringField(body.paymentRunId)
    || getHeader(req, "x-run-id")
    || rootRunId(req);
  const execution = stringField(body.runId)
    || stringField(body.composeRunId)
    || stringField(body.executionRunId)
    || getHeader(req, "x-execution-run-id")
    || root;
  const parent = stringField(body.parentExecutionRunId)
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

function line(key: string, amountWei: string | undefined): ReceiptLineItem | null {
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
  kind: ReceiptBill["kind"];
  source?: string;
  action?: string;
  subject?: string;
  name?: string;
  amountWei: string;
  lineItems: Array<ReceiptLineItem | null>;
}): ReceiptBill {
  return {
    kind: input.kind,
    source: input.source,
    action: input.action,
    subject: input.subject,
    name: input.name,
    amountWei: input.amountWei,
    total: total(input.amountWei),
    duration: "0s",
    lineItems: input.lineItems.filter((item): item is ReceiptLineItem => Boolean(item)),
  };
}

function evidenceBill(charge: ChargeEvidence): ReceiptBill {
  const kind = charge.kind === "agent" || charge.kind === "model" || charge.kind === "tool"
    || charge.kind === "search" || charge.kind === "memory" || charge.kind === "connector"
    ? charge.kind
    : "tool";
  const source = charge.service || charge.action || kind;
  const subject = charge.subject || charge.walletAddress || charge.name || "unknown";
  const amountWei = charge.finalAmountWei || (
    BigInt(charge.providerAmountWei || "0")
    + BigInt(charge.composeFeeWei || "0")
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
      line(`${prefix}:compose_fee`, charge.composeFeeWei),
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
  composeFeeWei: string;
  creatorFeeWei: string;
  children: ReceiptBill[];
}): ReceiptBill {
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
        amount: total((BigInt(input.composeFeeWei) + BigInt(input.creatorFeeWei)).toString()),
      },
      distribution: {
        Compose: total(input.composeFeeWei),
        Creator: total(input.creatorFeeWei),
      },
    },
    lineItems: [
      ...input.children.flatMap((child) => child.lineItems),
      line(`${input.subject}:compose_fee`, input.composeFeeWei),
      line(`${input.subject}:creator_fee`, input.creatorFeeWei),
    ].filter((item): item is ReceiptLineItem => Boolean(item)),
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
  const directProvider = sumWei(direct, (charge) => charge.providerAmountWei);
  const feeBase = directProvider;

  const composeFeeWei = ceilPercent(feeBase, 1);
  const creatorFeeWei = ceilPercent(feeBase, meta.creatorFee);
  const wrapperFeeWei = composeFeeWei + creatorFeeWei;
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
    platformFeeWei: composeFeeWei.toString(),
    meterSubject: subject,
    bills: [
      agentBill({
        walletAddress: meta.walletAddress,
        name: meta.name,
        action,
        subject,
        amountWei: displayTotalWei.toString(),
        composeFeeWei: composeFeeWei.toString(),
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
          line(`${wrapperPrefix}:compose_fee`, composeFeeWei.toString()),
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
      composeFeeWei: composeFeeWei.toString(),
      creatorFeeWei: creatorFeeWei.toString(),
    },
  };
}

function resolveAgentTextSettlement(
  body: Record<string, unknown>,
  req: Request,
  action = "agent-chat",
): Promise<RouteSettlement> {
  return resolveAgentEndpointSettlement(body, req, action);
}

function resolveAgentResponsesSettlement(body: Record<string, unknown>, req: Request): Promise<RouteSettlement> {
  return resolveAgentEndpointSettlement(body, req, "agent-responses");
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
  return data.type === "done" || data.type === "stopped" || data.type === "error";
}

function usageful(data: Record<string, unknown>): boolean {
  const usage = data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
    ? data.usage as Record<string, unknown>
    : data;
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

function actionName(path: string): string {
  return path
    .replace(/^\/api\//u, "")
    .replace(/[:]/gu, "")
    .replace(/[/.]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
}

function zeroResourceSettlement(req: Request, kind: "memory", action: string): RouteSettlement {
  const root = getHeader(req, "x-run-id") || rootRunId(req);
  const body = bodyRecord(req);
  const execution = getHeader(req, "x-execution-run-id")
    || stringField(body?.composeRunId)
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
      composeFeeWei: "0",
    },
  };
}

function memoryRoute(path: string) {
  const action = actionName(path);
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
  ["get", "/api/memory/workflows"],
  ["get", "/api/memory/workflows/:workflowId"],
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

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function receiptChainId(req: Request): number {
  const raw = queryString(req.query.chainId) ?? getHeader(req, "x-chain-id");
  const parsed = raw ? Number.parseInt(raw, 10) : getActiveChainId();
  return Number.isInteger(parsed) && parsed > 0 ? parsed : getActiveChainId();
}

function receiptLimit(req: Request): number {
  const parsed = Number.parseInt(queryString(req.query.limit) || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

async function receiptIdentity(req: Request): Promise<{ userAddress: string; chainId: number } | { error: string; status: number }> {
  const token = extractComposeKeyFromHeader(getHeader(req, "authorization"));
  if (!token) {
    return { error: "Compose key authorization is required", status: 401 };
  }

  const validation = await validateComposeKey(token, 0);
  if (!validation.valid || !validation.payload || !validation.record) {
    return { error: validation.error || "Invalid Compose key", status: 401 };
  }

  const chainId = receiptChainId(req);
  if (validation.record.chainId && validation.record.chainId !== chainId) {
    return { error: "Compose key chainId does not match request chainId", status: 409 };
  }

  if (validation.record.purpose === "session") {
    const sessionStatus = await getActiveSessionStatus(validation.payload.sub, chainId);
    const session = sessionStatus.session;
    if (!session || session.keyId !== validation.payload.keyId) {
      return { error: "The compose-key session is inactive or expired.", status: 401 };
    }
  }

  return {
    userAddress: validation.payload.sub.toLowerCase(),
    chainId,
  };
}

function receiptsRoute() {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const identity = await receiptIdentity(req);
      if ("error" in identity) {
        res.status(identity.status).json({ error: identity.error });
        return;
      }

      res.status(200).json(await listReceipts({
        userAddress: identity.userAddress,
        chainId: identity.chainId,
        limit: receiptLimit(req),
      }));
    })().catch(next);
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
        lifecycle.cleanup();
        throw error;
      }
      markTiming("runtime_response_headers");
      if (!runtimeResponse.ok) {
        const { text } = await readRuntimeJson(runtimeResponse);
        await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
        applyRuntimeHeaders(res, runtimeResponse);
        res.status(runtimeResponse.status).send(text);
        lifecycle.done();
        return;
      }

      if (!runtimeResponse.body) {
        await abortPreparedPayment(prepared, "runtime_stream_missing_body");
        res.status(502).json({ error: "Runtime stream body is missing" });
        lifecycle.done();
        return;
      }

      applyRuntimeHeaders(res, runtimeResponse);
      res.status(runtimeResponse.status);
      writeSseOpen(res);
      markTiming("gateway_headers_flushed");
      markTiming("gateway_open_written");
      res.on("close", () => markTiming("close"));

      const reader = runtimeResponse.body.getReader();
      const cancelReader = () => {
        void reader.cancel().catch(() => {
          // Best effort: the fetch signal already carries the shutdown reason.
        });
      };
      lifecycle.signal.addEventListener("abort", cancelReader, { once: true });
      let ended = false;
      let settlement: RouteSettlement | null = null;
      let settlementPromise: Promise<Receipt | null> | null = null;
      let settlementDone = false;
      let receiptWritten = false;
      let sawExplicitErrorEvent = false;
      let buffer = "";
      const decoder = new TextDecoder();
      const chainIdHeader = getHeader(req, "x-chain-id");
      const chainId = chainIdHeader ? Number.parseInt(chainIdHeader, 10) : Number.NaN;
      const resolvedChainId = Number.isFinite(chainId) ? chainId : undefined;

      const canWrite = () => !res.destroyed && !res.writableEnded;
      const settleOnce = async () => {
        if (!settlement) {
          throw new Error("authoritative stream settlement is required");
        }
        settlementPromise ??= settlePreparedPayment(
          prepared,
          res,
          settlement,
          resolvedChainId,
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
        // clients. The gateway solves this by writing `event: compose.receipt`
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

            if (parsed.eventName === "error" || parsed.data.type === "error") {
              sawExplicitErrorEvent = true;
            }

            let resolved: RouteSettlement | null = null;
            try {
              resolved = await config.resolveSettlement(parsed.eventName, parsed.data, req);
            } catch (error) {
              if (!terminal(parsed.data)) {
                throw error;
              }
              terminalSettlementError = error;
              terminalAbortData = parsed.data;
              sawTerminalAbort = true;
              markTiming("terminal_abort_event");
            }
            if (resolved) {
              settlement = resolved;
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

          if (sawTerminalSettlement && settlement) {
            const text = Buffer.from(value).toString("utf8");
            const doneIndex = text.indexOf("data: [DONE]");
            const beforeDone = doneIndex === -1 ? text : text.slice(0, doneIndex);
            markTiming("first_downstream_write");
            if (beforeDone.length > 0) {
              res.write(beforeDone);
            }
            const receipt = await settleOnce();
            writeReceipt(receipt);
            if (canWrite() && doneIndex === -1) {
              res.write("data: [DONE]\n\n");
            } else if (canWrite()) {
              res.write(text.slice(doneIndex));
            }
            if (canWrite()) {
              res.end();
            }
            lifecycle.done();
            ended = true;
            try {
              await reader.cancel();
            } catch {
              // best-effort; settlement has already happened
            }
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

export function registerWorkflowRoutes(app: Application): void {
  app.use("/api/mcps", connectorsProxyRoute());
  app.use("/api/onchain", connectorsProxyRoute());
  app.get("/api/receipts", receiptsRoute());

  app.post(
    "/agent/:walletAddress/chat",
    payableJsonRoute({
      service: "agent",
      action: "agent-chat",
      resolveSettlement: (body, req) => resolveAgentTextSettlement(body, req, "agent-chat"),
    }),
  );
  app.post(
    "/agent/:walletAddress/stream",
    payableStreamRoute({
      service: "agent",
      action: "agent-stream",
      resolveSettlement: (_eventName, data, req) => {
        // Settle on any terminal event that carries usage metering. `done` is the
        // normal path; `stopped` (user-issued abort via /runs/:id/stop) and
        // `error` (runtime failure with partial usage already accumulated) MUST
        // also settle so partial work the model performed is paid for and the
        // x402 prepared payment is never silently aborted.
        if (data.type !== "done" && data.type !== "stopped" && data.type !== "error") {
          return null;
        }
        return resolveAgentTextSettlement(data, req, "agent-stream");
      },
    }),
  );
  app.post(
    "/agent/:walletAddress/responses",
    payableJsonRoute({
      service: "agent",
      action: "agent-responses",
      resolveSettlement: (body, req) => resolveAgentResponsesSettlement(body, req),
    }),
  );
  app.get("/agent/:walletAddress/runs/:runId/state", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/approval", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/stop", passthroughJsonRoute());

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
    "/workflow/:walletAddress/chat",
    payableStreamRoute({
      service: "workflow",
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
      service: "workflow",
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
}
