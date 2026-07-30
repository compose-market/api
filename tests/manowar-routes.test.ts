import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AddressInfo } from "node:net";

import {
  handlePublicRoute,
  buildRuntimeManowarUrl,
  buildRuntimeHeaders,
  buildRuntimeSessionHeaders,
  registerManowarRoutes,
} from "../routes.js";
import { createKey } from "../x402/keys/storage.js";
import { closeValkey, valkeyDel, valkeySRem } from "../x402/keys/valkey.js";
import { recordChargeEvidence } from "../x402/evidence.js";
import { initializeSessionBudget } from "../x402/session/budget.js";

const ORIGINAL_RUNTIME_URL = process.env.RUNTIME_URL;
const ORIGINAL_AGENTS_URL = process.env.AGENTS_URL;
const ORIGINAL_FACILITATOR_KEY = process.env.FACILITATOR_KEY;
const ORIGINAL_MERCHANT_WALLET_ADDRESS = process.env.MERCHANT_WALLET_ADDRESS;
const ORIGINAL_THIRDWEB_SERVER_WALLET_ADDRESS = process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
const ORIGINAL_AVALANCHE_MAINNET_RPC = process.env.AVALANCHE_MAINNET_RPC;
const ORIGINAL_COMPOSE_SESSION_SECRET = process.env.COMPOSE_SESSION_SECRET;
const NATIVE_FETCH = globalThis.fetch;
const ROUTES_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../routes.ts"), "utf8");
const HANDLER_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../handler.ts"), "utf8");
const CORS_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../http/cors.ts"), "utf8");
const TEST_SETTLEMENT_TX_HASH = `0x${"12".repeat(32)}`;

interface RouteLayer {
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
  };
}

function listRegisteredRoutes(app: express.Application): Array<{ methods: string[]; path: string }> {
  return (app.router.stack as RouteLayer[])
    .filter((layer): layer is { route: NonNullable<RouteLayer["route"]> } => Boolean(layer.route))
    .map((layer) => ({
      methods: Object.keys(layer.route.methods || {}),
      path: String(layer.route.path),
    }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function keyRecordKey(keyId: string): string {
  return `key:${keyId}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${userAddress.toLowerCase()}`;
}

const memory = [
  "post /api/memory/context/assemble",
  "post /api/memory/turns/record",
  "post /api/memory/remember",
  "post /api/memory/loop",
  "get /api/memory/loops",
  "get /api/memory/loops/:loopId",
  "get /api/memory/patterns",
  "get /api/memory/patterns/:patternId",
  "post /api/memory/patterns/:patternId/validate",
  "post /api/memory/patterns/:patternId/promote",
  "get /api/memory/skills",
  "get /api/memory/skills/:skillId",
  "post /api/memory/transcripts/index",
  "get /api/memory/sessions/:sessionId/working",
  "patch /api/memory/sessions/:sessionId/working",
  "post /api/memory/sessions/:sessionId/compress",
  "post /api/memory/archives/:archiveId/sync",
  "get /api/memory/schedules",
  "post /api/memory/schedules",
  "delete /api/memory/schedules",
  "post /api/memory/schedules/:scheduleId/pause",
  "post /api/memory/schedules/:scheduleId/resume",
  "post /api/memory/schedules/:scheduleId/trigger",
  "post /api/memory/add",
  "post /api/memory/search",
  "post /api/memory/vector-search",
  "post /api/memory/vector-index",
  "post /api/memory/transcript-store",
  "get /api/memory/transcript-get/:id",
  "post /api/memory/rerank",
  "post /api/memory/layers/search",
  "get /api/memory/stats/:agentWallet",
  "post /api/memory/items/search",
  "get /api/memory/items/:id",
  "patch /api/memory/items/:id",
  "delete /api/memory/items/:id",
  "post /api/memory/conflicts/:id/resolve",
  "post /api/memory/jobs",
  "get /api/memory/jobs/:jobId",
  "post /api/memory/evals/runs",
  "get /api/memory/:agentWallet",
] as const;

test("registerManowarRoutes registers the explicit public workflow surface", () => {
  const app = express();
  registerManowarRoutes(app);
  const routes = listRegisteredRoutes(app).map((route) => `${route.methods[0]} ${route.path}`);
  const routeSet = new Set(routes);

  assert.equal(routeSet.has("post /agent/register"), false);
  assert.equal(routeSet.has("post /workflow/register"), false);
  assert.equal(routeSet.has("post /agent/:walletAddress/chat"), false);
  assert.equal(routeSet.has("post /agent/:walletAddress/stream"), true);
  assert.equal(routeSet.has("post /agent/:walletAddress/responses"), true);
  assert.equal(routeSet.has("post /agent/:walletAddress/multimodal"), false);
  assert.equal(routeSet.has("get /agent/:walletAddress/knowledge"), false);
  assert.equal(routeSet.has("post /workflow/:walletAddress/chat"), false);
  assert.equal(routeSet.has("post /workflow/:walletAddress/stream"), true);
  assert.equal(routeSet.has("post /workflow/execute"), true);
  assert.equal(routeSet.has("get /workflow/prices"), true);
  assert.equal(routeSet.has("get /frameworks"), true);
  assert.equal(routeSet.has("get /v1/models"), false);

  for (const route of memory) {
    assert.equal(routeSet.has(route), true, route);
  }

  const wallet = routes.indexOf("get /api/memory/:agentWallet");
  assert.notEqual(wallet, -1);
  for (const route of memory) {
    if (route === "get /api/memory/:agentWallet") continue;
    const index = routes.indexOf(route);
    assert.ok(index !== -1 && index < wallet, `${route} must be registered before /api/memory/:agentWallet`);
  }
});

test("API route source excludes stale internal workflow names", () => {
  const source = [ROUTES_SOURCE, HANDLER_SOURCE, CORS_SOURCE].join("\n");
  for (const pattern of [
    new RegExp("/internal/" + "workflow"),
    new RegExp("register" + "WorkflowRoutes"),
    new RegExp("buildRuntime" + "InternalUrl"),
    new RegExp("X-" + "Workflow-Internal"),
    new RegExp("x-" + "workflow-internal"),
    new RegExp("/api/memory/work" + "flows"),
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});

test("GET /frameworks exposes other after manowar", async () => {
  const app = express();
  registerManowarRoutes(app);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/frameworks`);
    assert.equal(response.status, 200);
    const body = await response.json() as { frameworks: Array<{ id: string }> };
    assert.deepEqual(body.frameworks.map((item) => item.id), ["manowar", "other"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("buildRuntimeManowarUrl targets the embedded runtime route", () => {
  process.env.RUNTIME_URL = "https://runtime.compose.market/";
  assert.equal(
    buildRuntimeManowarUrl("/agent/0xabc/stream"),
    "https://runtime.compose.market/internal/manowar/agent/0xabc/stream",
  );
  process.env.RUNTIME_URL = ORIGINAL_RUNTIME_URL;
});

test("buildRuntimeHeaders overlays authoritative session context onto runtime proxy calls", () => {
  const headers = buildRuntimeHeaders(
    {
      headers: {
        authorization: "Bearer compose-test",
        "x-session-active": "false",
        "x-session-budget-remaining": "0",
      },
    } as unknown as express.Request,
    buildRuntimeSessionHeaders({
      userAddress: "0xBa04Fa4BaAcBaC0D93Bb73A7FD473A41AA7f2815",
      sessionBudgetRemaining: "2500000",
    }),
  );

  assert.equal(headers.get("x-session-active"), "true");
  assert.equal(headers.get("x-session-budget-remaining"), "2500000");
  assert.equal(
    headers.get("x-session-user-address"),
    "0xba04fa4baacbac0d93bb73a7fd473a41aa7f2815",
  );
  assert.equal(headers.has("payment-signature"), false);
});

test("runtime proxy body construction does not perform agent catalog lookups", () => {
  const bodyStart = ROUTES_SOURCE.indexOf("async function buildRuntimeBody");
  const bodyEnd = ROUTES_SOURCE.indexOf("async function callRuntime", bodyStart);
  const body = ROUTES_SOURCE.slice(bodyStart, bodyEnd);

  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, "buildRuntimeBody source slice must be present");
  assert.doesNotMatch(body, /findAgentByWallet/);
  assert.doesNotMatch(body, /runtime-forward/);
  assert.doesNotMatch(body, /agentCard/);
});

test("handlePublicRoute redirects agent lists directly to the agents Worker", async () => {
  process.env.AGENTS_URL = "https://agents.worker.test/";
  globalThis.fetch = async () => { throw new Error("API must not fetch the agents catalog"); };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents",
        requestContext: { http: { method: "GET" } },
        headers: { host: "api.test" },
        queryStringParameters: { limit: "1" },
      },
      {},
    );

    assert.equal(result?.statusCode, 307);
    assert.equal(result?.headers?.Location, "https://agents.worker.test/agents?limit=1");
    assert.equal(result?.headers?.["Cache-Control"], "no-store");
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_URL", ORIGINAL_AGENTS_URL);
  }
});

test("handlePublicRoute redirects agent searches directly to the agents Worker", async () => {
  process.env.AGENTS_URL = "https://agents.worker.test";
  globalThis.fetch = async () => { throw new Error("API must not fetch the agents catalog"); };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents/search",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { q: "bitcoin", limit: "3" },
      },
      {},
    );

    assert.equal(result?.statusCode, 307);
    assert.equal(result?.headers?.Location, "https://agents.worker.test/agents/search?q=bitcoin&limit=3");
    assert.equal(result?.headers?.["Cache-Control"], "no-store");
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_URL", ORIGINAL_AGENTS_URL);
  }
});

test("handlePublicRoute redirects exact agent cards directly to the agents Worker", async () => {
  process.env.AGENTS_URL = "https://agents.worker.test";
  const wallet = "0x2222222222222222222222222222222222222222";
  globalThis.fetch = async () => { throw new Error("API must not fetch the agents catalog"); };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agent/" + wallet,
        requestContext: { http: { method: "GET" } },
      },
      {},
    );

    assert.equal(result?.statusCode, 307);
    assert.equal(result?.headers?.Location, "https://agents.worker.test/agent/" + wallet);
    assert.equal(result?.headers?.["Cache-Control"], "no-store");
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_URL", ORIGINAL_AGENTS_URL);
  }
});

test("handlePublicRoute redirects Solana agent cards directly to the agents Worker", async () => {
  process.env.AGENTS_URL = "https://agents.worker.test";
  const wallet = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq";
  globalThis.fetch = async () => { throw new Error("API must not fetch the agents catalog"); };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agent/" + wallet,
        requestContext: { http: { method: "GET" } },
      },
      {},
    );

    assert.equal(result?.statusCode, 307);
    assert.equal(result?.headers?.Location, "https://agents.worker.test/agent/" + wallet);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_URL", ORIGINAL_AGENTS_URL);
  }
});

test("GET /agent/:wallet/avatar redirects directly to the agents Worker", async () => {
  process.env.AGENTS_URL = "https://agents.worker.test";
  const wallet = "0x4444444444444444444444444444444444444444";
  globalThis.fetch = async () => { throw new Error("API must not fetch the agents catalog"); };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agent/" + wallet + "/avatar",
        requestContext: { http: { method: "GET" } },
        headers: { "if-none-match": '"avatar-old"' },
      },
      {},
    );

    assert.equal(result?.statusCode, 307);
    assert.equal(result?.headers?.Location, "https://agents.worker.test/agent/" + wallet + "/avatar");
    assert.equal(result?.headers?.["Cache-Control"], "no-store");
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_URL", ORIGINAL_AGENTS_URL);
  }
});

test("API agent catalog routes do not import deleted catalog or workflow modules", () => {
  assert.doesNotMatch(ROUTES_SOURCE, /from \"\.\/catalog\.js\"/);
  assert.doesNotMatch(ROUTES_SOURCE, /from \"\.\/workflows\.js\"/);
});

test("workflow price passthrough uses RUNTIME_URL without payment bypass headers", async () => {
  process.env.RUNTIME_URL = "https://runtime.compose.market/";
  delete process.env.RUNTIME_SERVICE_URL;

  const runtimeCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    runtimeCalls.push({ url: String(input), init });
    return new Response(JSON.stringify({ count: 0, keys: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const app = express();
  registerManowarRoutes(app);
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const response = await NATIVE_FETCH(`http://127.0.0.1:${port}/workflow/prices`);
    assert.equal(response.status, 200);
    const capturedCall = runtimeCalls[0];
    if (!capturedCall) {
      throw new Error("Expected runtime passthrough to be invoked");
    }
    assert.equal(capturedCall.url, "https://runtime.compose.market/internal/manowar/workflow/prices");
    assert.equal(new Headers(capturedCall.init?.headers).has("payment-signature"), false);
  } finally {
    server.close();
    globalThis.fetch = NATIVE_FETCH;
    process.env.RUNTIME_URL = ORIGINAL_RUNTIME_URL;
  }
});

test("payable stream routes close terminal SSE before settlement", () => {
  const branchStart = ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && terminalSettlementPromise)");
  const fallback = ROUTES_SOURCE.indexOf("if (buffer.trim().length > 0)", branchStart);
  const branch = ROUTES_SOURCE.slice(branchStart, fallback);
  const terminal = ROUTES_SOURCE.indexOf('markTiming("terminal_settlement_event")');
  const close = branch.indexOf("res.end();");
  const settle = branch.indexOf("await settleOnce();");
  const cancelReader = branch.indexOf("await reader.cancel()");

  assert.ok(terminal > 0, "terminal settlement timing marker is required");
  assert.ok(close > 0, "terminal events must close the client stream");
  assert.ok(cancelReader > close, "runtime reader must be released after client close");
  assert.ok(settle > cancelReader, "settlement must run after client close and reader release");
  assert.ok(branchStart > 0 && fallback > branchStart, "settlement branch must be before EOF buffer handling");
});

test("payable stream routes do not abort payments after successful terminal settlement", () => {
  const payableStart = ROUTES_SOURCE.indexOf("function payableStreamRoute");
  const payableEnd = ROUTES_SOURCE.indexOf("})().catch(next);", payableStart);
  const catchStart = ROUTES_SOURCE.lastIndexOf("} catch (error) {", payableEnd);
  const catchBody = ROUTES_SOURCE.slice(catchStart, ROUTES_SOURCE.indexOf("throw error;", catchStart));

  assert.match(catchBody, /if \(settlement && !settlementDone\)/);
  assert.match(catchBody, /if \(!settlementDone\)/);
  assert.match(catchBody, /await abortPreparedPayment/);
});

test("payable stream routes write an SSE open frame before waiting for runtime headers", () => {
  const payableStart = ROUTES_SOURCE.indexOf("function payableStreamRoute");
  const paymentPrepared = ROUTES_SOURCE.indexOf('markTiming("payment_prepared")', payableStart);
  const callRuntimeStart = ROUTES_SOURCE.indexOf("runtimeResponse = await callRuntime(", payableStart);
  const openStart = ROUTES_SOURCE.indexOf("writeSseOpen(res);", paymentPrepared);
  const openMark = ROUTES_SOURCE.indexOf('markTiming("gateway_open_written")', openStart);
  const readerStart = ROUTES_SOURCE.indexOf("const reader = runtimeResponse.body.getReader()", payableStart);
  const firstChunkMark = ROUTES_SOURCE.indexOf('markTiming("first_runtime_chunk")', readerStart);

  assert.ok(paymentPrepared > payableStart, "payment preparation must be timed before opening the gateway stream");
  assert.ok(openStart > paymentPrepared, "gateway must write an SSE open frame after payment preparation");
  assert.ok(openStart < callRuntimeStart, "gateway open frame must be written before waiting for runtime headers");
  assert.ok(openStart < readerStart, "gateway open frame must be written before awaiting runtime chunks");
  assert.ok(openMark > openStart && openMark < callRuntimeStart, "gateway open write must be timed before the runtime request");
  assert.ok(firstChunkMark > readerStart, "runtime chunk timing must remain inside the reader loop");
});

test("payable stream routes mark first upstream frame, runtime model start, and first runtime text", () => {
  const payableStart = ROUTES_SOURCE.indexOf("function payableStreamRoute");
  const readerStart = ROUTES_SOURCE.indexOf("const reader = runtimeResponse.body.getReader()", payableStart);
  const loopBody = ROUTES_SOURCE.slice(readerStart, ROUTES_SOURCE.indexOf("if (sawTerminalAbort && !settlement)", readerStart));

  assert.match(loopBody, /markTiming\("first_upstream_sse_frame"\)/);
  assert.match(loopBody, /markTiming\("first_runtime_model_start"\)/);
  assert.match(loopBody, /markTiming\("first_runtime_text_delta"\)/);
});

test("payable stream routes close already-flushed SSE errors in-band", () => {
  const payableStart = ROUTES_SOURCE.indexOf("function payableStreamRoute");
  const payableEnd = ROUTES_SOURCE.indexOf("})().catch(next);", payableStart);
  const catchStart = ROUTES_SOURCE.lastIndexOf("} catch (error) {", payableEnd);
  const catchBody = ROUTES_SOURCE.slice(catchStart, ROUTES_SOURCE.indexOf("} finally", catchStart));

  assert.match(catchBody, /await reader\.cancel\(\)/);
  assert.match(catchBody, /if \(res\.headersSent\)/);
  assert.match(catchBody, /event: error/);
  assert.match(catchBody, /data: \[DONE\]/);
  assert.match(catchBody, /res\.end\(\)/);
});

test("payable stream routes skip settlement headers after SSE flush", () => {
  const applyStart = ROUTES_SOURCE.indexOf("function applyHeaders");
  const applyBody = ROUTES_SOURCE.slice(applyStart, ROUTES_SOURCE.indexOf("export function buildRuntimeSessionHeaders", applyStart));
  const settleStart = ROUTES_SOURCE.indexOf("async function settlePreparedPayment");
  const settleBody = ROUTES_SOURCE.slice(settleStart, ROUTES_SOURCE.indexOf("function ceilPercent", settleStart));

  assert.match(applyBody, /res\.headersSent/);
  assert.match(settleBody, /settlePreparedInferencePayment\(prepared\.prepared, res, settlement\)/);
});

test("payable stream routes abort terminal error streams without billable usage", () => {
  const terminalAbort = ROUTES_SOURCE.indexOf('markTiming("terminal_abort_event")');
  const abortReason = ROUTES_SOURCE.indexOf("runtime_terminal_without_billable_usage");
  const branch = ROUTES_SOURCE.slice(abortReason, ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && settlement)", abortReason));
  const readerCancel = branch.indexOf("payment has already been aborted");

  assert.ok(terminalAbort > 0, "terminal abort timing marker is required");
  assert.ok(abortReason > terminalAbort, "terminal stream failures without usage must abort prepared payment");
  assert.ok(readerCancel > 0, "runtime reader must be released after terminal abort");
});

test("payable stream routes fail closed when terminal metering cannot be priced", () => {
  const abortBranch = ROUTES_SOURCE.slice(
    ROUTES_SOURCE.indexOf("if (sawTerminalAbort && !settlement)"),
    ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && settlement)"),
  );

  assert.ok(abortBranch.includes("failclosed(terminalAbortData, terminalSettlementError)"));
  assert.ok(abortBranch.indexOf("failclosed(terminalAbortData, terminalSettlementError)") < abortBranch.indexOf("res.write(text)"));
  assert.ok(abortBranch.includes("invalid_runtime_settlement"));
  assert.ok(abortBranch.includes("event: error"));
});

test("payable stream routes write DONE and close before settlement", () => {
  const start = ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && terminalSettlementPromise)");
  const terminalBranch = ROUTES_SOURCE.slice(
    start,
    ROUTES_SOURCE.indexOf('\n          markTiming("first_downstream_write");\n          res.write', start),
  );

  assert.ok(terminalBranch.includes('!text.includes("data: [DONE]")'));
  assert.ok(terminalBranch.indexOf('res.write("data: [DONE]') < terminalBranch.indexOf("res.end()"));
  assert.ok(terminalBranch.indexOf("res.end()") < terminalBranch.indexOf("await settleOnce()"));
});

// ─────────────────────────────────────────────────────────────────────────────
// x402 contract: payable routes MUST emit 402 PAYMENT-REQUIRED when the caller
// omits the Authorization header. Agent routes are composable work boundaries
// and must advertise batch-settlement; direct non-agent wrappers can still use
// the single-request upto challenge.
// Regression guard for the previous 401 "Compose key authorization is required"
// response that locked the route to Compose-Key consumers only.
// ─────────────────────────────────────────────────────────────────────────────
test("payable resource routes emit 402 PAYMENT-REQUIRED with the expected raw x402 scheme when no Authorization is present", async () => {
  // The raw x402 upto challenge requires FACILITATOR_KEY (for facilitator address)
  // and MERCHANT_WALLET_ADDRESS (for payTo). Set them if not already present.
  process.env.FACILITATOR_KEY = ORIGINAL_FACILITATOR_KEY || `0x${"11".repeat(32)}`;
  process.env.MERCHANT_WALLET_ADDRESS =
    ORIGINAL_MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS =
    ORIGINAL_THIRDWEB_SERVER_WALLET_ADDRESS || "0x1111111111111111111111111111111111111111";
  process.env.AVALANCHE_MAINNET_RPC =
    ORIGINAL_AVALANCHE_MAINNET_RPC || "https://api.avax.network/ext/bc/C/rpc";

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerManowarRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    const endpoints: Array<{ method: "POST"; path: string; scheme: string }> = [
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/stream", scheme: "batch-settlement" },
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/responses", scheme: "batch-settlement" },
      { method: "POST", path: "/workflow/0x0000000000000000000000000000000000000001/stream", scheme: "upto" },
      { method: "POST", path: "/workflow/execute", scheme: "upto" },
      { method: "POST", path: "/workflow/0x0000000000000000000000000000000000000001/run", scheme: "upto" },
      { method: "POST", path: "/api/memory/search", scheme: "upto" },
    ];

    for (const ep of endpoints) {
      const response = await fetch(`http://127.0.0.1:${port}${ep.path}`, {
        method: ep.method,
        headers: {
          "content-type": "application/json",
          "x-network-id": "eip155:43114",
          // `x-x402-max-amount-wei` is required for the upto scheme; without
          // it the server returns 400 (the shared inference contract). The
          // test asserts the happy path where a sincere caller supplies both
          // the cap header and no credentials — the correct x402 challenge.
          "x-x402-max-amount-wei": "1000000",
        },
        body: JSON.stringify({ message: "hi", model: "gpt-4.1-mini", stream: false }),
      });

      assert.equal(response.status, 402, `${ep.path} must challenge with 402 (got ${response.status})`);
      const paymentRequired = response.headers.get("payment-required") || response.headers.get("PAYMENT-REQUIRED");
      assert.ok(paymentRequired, `${ep.path} must set PAYMENT-REQUIRED header`);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.x402Version, 2, `${ep.path} must advertise x402 v2`);
      const accepts = body.accepts as Array<{ scheme: string; amount: string }> | undefined;
      assert.ok(Array.isArray(accepts) && accepts.length > 0, `${ep.path} must advertise accepts[]`);
      const expectedScheme = ep.scheme;
      assert.equal(accepts[0].scheme, expectedScheme, `${ep.path} must challenge with scheme=${expectedScheme}`);
      assert.equal(accepts[0].amount, "1000000", `${ep.path} cap must reflect x-x402-max-amount-wei`);
    }
  } finally {
    server.close();
    process.env.FACILITATOR_KEY = ORIGINAL_FACILITATOR_KEY;
    process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_MERCHANT_WALLET_ADDRESS;
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = ORIGINAL_THIRDWEB_SERVER_WALLET_ADDRESS;
    process.env.AVALANCHE_MAINNET_RPC = ORIGINAL_AVALANCHE_MAINNET_RPC;
  }
});

test("payable route receipts kick batch settlement after evidence-backed receipt finalization", () => {
  const settleBody = ROUTES_SOURCE.slice(
    ROUTES_SOURCE.indexOf("async function settlePreparedPayment"),
    ROUTES_SOURCE.indexOf("function ceilPercent"),
  );

  assert.match(settleBody, /await remember\(settlementReceipt\)/);
  assert.match(settleBody, /const receipt = await finalizeReceipt/);
  assert.match(settleBody, /await kickBatchSettlement\(/);
  assert.ok(
    settleBody.indexOf("await remember(settlementReceipt)") < settleBody.indexOf("const receipt = await finalizeReceipt"),
    "evidence must be recorded before route receipt finalization",
  );
  assert.ok(
    settleBody.indexOf("const receipt = await finalizeReceipt") < settleBody.indexOf("await kickBatchSettlement("),
    "terminal kick must happen after receipt finalization",
  );
});

test("agent route receipts compute wrapper fees from the full internal activity basis", () => {
  const settleBody = ROUTES_SOURCE.slice(
    ROUTES_SOURCE.indexOf("async function resolveAgentEndpointSettlement"),
    ROUTES_SOURCE.indexOf("function resolveAgentTextSettlement"),
  );

  assert.match(settleBody, /const childAgents = uniqueCharges\(await listChildEvidence/);
  assert.match(settleBody, /const directBaseWei = sumWei\(direct/);
  assert.match(settleBody, /const childAgentBaseWei = sumWei\(childAgents/);
  assert.match(settleBody, /const feeBase = directBaseWei \+ childAgentBaseWei/);
  assert.match(settleBody, /\.\.\.direct\.map\(evidenceBill\)/);
  assert.match(settleBody, /\.\.\.childAgents\.map\(evidenceBill\)/);
  assert.match(settleBody, /finalAmountWei: wrapperFeeWei\.toString\(\)/);
  assert.match(settleBody, /providerAmountWei: feeBase\.toString\(\)/);
  assert.match(settleBody, /agentBill\(\{/);
  assert.match(settleBody, /const displayTotalWei = childBills\.reduce/);
});

test("agent stream settlement charges parent wrapper fees over direct and child-agent activity", {
  skip: !process.env.VALKEY_KEYS_SERVICE_URI || !process.env.VALKEY_KEYS_PASSWORD,
}, async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTxHash = process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
  const userAddress = "0x8b9dc7a221ac4756b819850ff601983100000000";
  const walletAddress = "0x00000000000000000000000000000000000000a1";
  const rootRunId = `root-${randomUUID()}`;
  const executionRunId = `exec-${randomUUID()}`;
  let keyId: string | undefined;

  process.env.NODE_ENV = "test";
  process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = TEST_SETTLEMENT_TX_HASH;
  process.env.COMPOSE_SESSION_SECRET ||= "test-session-secret";
  process.env.RUNTIME_URL = "https://runtime.compose.market";

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, `https://runtime.compose.market/internal/manowar/agent/${walletAddress}/stream`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-run-id"), rootRunId);
    assert.equal(headers.has("payment-signature"), false);

    return new Response([
      "event: done\n",
      "data: ",
      JSON.stringify({
        type: "done",
        runId: executionRunId,
        rootRunId: rootRunId,
        walletAddress,
        name: "Minimal Agent",
        model: "gpt-4.1-mini",
        creatorFee: 1,
        agent: {
          walletAddress,
          name: "Minimal Agent",
          model: "gpt-4.1-mini",
          creatorFee: 1,
        },
      }),
      "\n\n",
      "data: [DONE]\n\n",
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const server = express();
  server.use(express.json({ limit: "1mb" }));
  registerManowarRoutes(server);
  const listener = server.listen(0);
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;

  try {
    const created = await createKey(userAddress, {
      budgetLimit: 1_000_000,
      expiresAt: Date.now() + 10 * 60 * 1000,
      purpose: "api",
      network: "eip155:5042002",
      name: "agent-wrapper-fee-test",
    });
    keyId = created.keyId;

    await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      service: "inference",
      action: "v1-responses",
      subject: "model:gpt-4.1-mini",
      providerAmountWei: "1000",
      feeWei: "10",
      finalAmountWei: "1010",
      txHash: "0xmodel",
      network: "eip155:5042002",
      settledAt: Date.now(),
    });
    await recordChargeEvidence({
      kind: "memory",
      rootRunId,
      executionRunId,
      service: "memory",
      action: "fact-extraction",
      subject: "memory:fact-extraction",
      providerAmountWei: "500",
      feeWei: "5",
      finalAmountWei: "505",
      txHash: "0xmemory",
      network: "eip155:5042002",
      settledAt: Date.now(),
    });
    await recordChargeEvidence({
      kind: "agent",
      rootRunId,
      executionRunId: `child-${randomUUID()}`,
      parentExecutionRunId: executionRunId,
      service: "agent",
      action: "stream",
      subject: "agent:0x00000000000000000000000000000000000000c1",
      walletAddress: "0x00000000000000000000000000000000000000c1",
      name: "Child Agent",
      providerAmountWei: "5000",
      feeWei: "50",
      creatorFeeWei: "50",
      finalAmountWei: "100",
      txHash: "0xchildagent",
      network: "eip155:5042002",
      settledAt: Date.now(),
    });

    const response = await NATIVE_FETCH(`http://127.0.0.1:${port}/agent/${walletAddress}/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        "x-network-id": "eip155:5042002",
        "x-run-id": rootRunId,
      },
      body: JSON.stringify({
        message: "hi",
        runId: executionRunId,
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    const receiptMatch = text.match(/event: compose\.receipt\ndata: ([^\n]+)/);
    assert.ok(receiptMatch, text);
    const receipt = JSON.parse(receiptMatch[1]!) as {
      service: string;
      action: string;
      finalAmountWei: string;
      providerAmountWei: string;
      platformFeeWei: string;
      bills?: Array<{
        amountWei: string;
        children?: unknown[];
        lineItems?: unknown[];
      }>;
      settlementStatus?: string;
      txHash?: string;
    };

    assert.equal(receipt.service, "agent");
    assert.equal(receipt.action, "stream");
    assert.equal(receipt.providerAmountWei, "6500");
    assert.equal(receipt.platformFeeWei, "65");
    assert.equal(receipt.finalAmountWei, "130");
    assert.equal(receipt.bills?.length, 2);
    assert.equal(receipt.bills?.[0]?.amountWei, "1745");
    assert.equal(receipt.bills?.[0]?.children?.length, 3);
    assert.equal(receipt.bills?.[0]?.lineItems?.length, 9);
    assert.equal(receipt.bills?.[1]?.amountWei, "130");
    assert.equal(receipt.bills?.[1]?.lineItems?.length, 2);
    assert.equal(receipt.settlementStatus, "settled");
    assert.equal(receipt.txHash, TEST_SETTLEMENT_TX_HASH);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("COMPOSE_TEST_SETTLEMENT_TX_HASH", originalTxHash);
    restoreEnv("RUNTIME_URL", ORIGINAL_RUNTIME_URL);
    restoreEnv("COMPOSE_SESSION_SECRET", ORIGINAL_COMPOSE_SESSION_SECRET);
    if (keyId) {
      await valkeyDel(keyRecordKey(keyId));
      await valkeySRem(userKeysKey(userAddress), keyId);
    }
    await closeValkey();
  }
});

test("agent stream settlement does not fold direct model evidence into the wrapper payment", {
  skip: !process.env.VALKEY_KEYS_SERVICE_URI || !process.env.VALKEY_KEYS_PASSWORD,
}, async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTxHash = process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
  const userAddress = "0xc4dad482d76c473d95c722b07099644200000000";
  const walletAddress = "0x00000000000000000000000000000000000000b2";
  const rootRunId = `root-${randomUUID()}`;
  const executionRunId = `exec-${randomUUID()}`;
  let keyId: string | undefined;

  process.env.NODE_ENV = "test";
  process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = TEST_SETTLEMENT_TX_HASH;
  process.env.COMPOSE_SESSION_SECRET ||= "test-session-secret";
  process.env.RUNTIME_URL = "https://runtime.compose.market";

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, `https://runtime.compose.market/internal/manowar/agent/${walletAddress}/stream`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-run-id"), rootRunId);
    assert.equal(headers.has("payment-signature"), false);

    return new Response([
      "event: done\n",
      "data: ",
      JSON.stringify({
        type: "done",
        runId: executionRunId,
        rootRunId: rootRunId,
        walletAddress,
        name: "Minimal Agent",
        model: "gpt-4.1-mini",
        creatorFee: 1,
        agent: {
          walletAddress,
          name: "Minimal Agent",
          model: "gpt-4.1-mini",
          creatorFee: 1,
        },
      }),
      "\n\n",
      "data: [DONE]\n\n",
    ].join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const server = express();
  server.use(express.json({ limit: "1mb" }));
  registerManowarRoutes(server);
  const listener = server.listen(0);
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;

  try {
    const created = await createKey(userAddress, {
      budgetLimit: 1_000_000,
      expiresAt: Date.now() + 10 * 60 * 1000,
      purpose: "api",
      network: "eip155:5042002",
      name: "agent-unpaid-evidence-test",
    });
    keyId = created.keyId;

    await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      service: "inference",
      action: "v1-responses",
      subject: "model:gpt-4.1-mini",
      providerAmountWei: "1000",
      feeWei: "10",
      finalAmountWei: "1010",
      network: "eip155:5042002",
      settledAt: Date.now(),
    });

    const response = await NATIVE_FETCH(`http://127.0.0.1:${port}/agent/${walletAddress}/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        "x-network-id": "eip155:5042002",
        "x-run-id": rootRunId,
      },
      body: JSON.stringify({
        message: "hi",
        runId: executionRunId,
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    const receiptMatch = text.match(/event: compose\.receipt\ndata: ([^\n]+)/);
    assert.ok(receiptMatch, text);
    const receipt = JSON.parse(receiptMatch[1]!) as {
      service: string;
      action: string;
      finalAmountWei: string;
      providerAmountWei: string;
      platformFeeWei: string;
      bills?: Array<{
        amountWei: string;
        children?: unknown[];
        lineItems?: unknown[];
      }>;
      settlementStatus?: string;
      txHash?: string;
    };

    assert.equal(receipt.service, "agent");
    assert.equal(receipt.action, "stream");
    assert.equal(receipt.providerAmountWei, "1000");
    assert.equal(receipt.platformFeeWei, "10");
    assert.equal(receipt.finalAmountWei, "20");
    assert.equal(receipt.bills?.length, 2);
    assert.equal(receipt.bills?.[0]?.amountWei, "1030");
    assert.equal(receipt.bills?.[0]?.children?.length, 1);
    assert.equal(receipt.bills?.[0]?.lineItems?.length, 4);
    assert.equal(receipt.bills?.[1]?.amountWei, "20");
    assert.equal(receipt.bills?.[1]?.lineItems?.length, 2);
    assert.equal(receipt.settlementStatus, "settled");
    assert.equal(receipt.txHash, TEST_SETTLEMENT_TX_HASH);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("COMPOSE_TEST_SETTLEMENT_TX_HASH", originalTxHash);
    restoreEnv("RUNTIME_URL", ORIGINAL_RUNTIME_URL);
    restoreEnv("COMPOSE_SESSION_SECRET", ORIGINAL_COMPOSE_SESSION_SECRET);
    if (keyId) {
      await valkeyDel(keyRecordKey(keyId));
      await valkeySRem(userKeysKey(userAddress), keyId);
    }
    await closeValkey();
  }
});
