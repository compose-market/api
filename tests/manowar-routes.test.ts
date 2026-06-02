import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AddressInfo } from "node:net";

import {
  handlePublicRoute,
  buildRuntimeInternalUrl,
  buildRuntimeHeaders,
  buildRuntimeSessionHeaders,
  registerWorkflowRoutes,
} from "../routes.js";
import { findAgentByWallet, test as agentSearchTest } from "../agents.js";
import { createComposeKey } from "../x402/keys/storage.js";
import { closeRedis, redisDel, redisSRem } from "../x402/keys/redis.js";
import { recordChargeEvidence } from "../x402/evidence.js";
import { initializeSessionBudget } from "../x402/session-budget.js";

const ORIGINAL_RUNTIME_URL = process.env.RUNTIME_URL;
const ORIGINAL_PINATA_GATEWAY_URL = process.env.PINATA_GATEWAY_URL;
const ORIGINAL_IPFS_PINATA_GATEWAY = process.env.IPFS_PINATA_GATEWAY;
const ORIGINAL_PINATA_GATEWAY = process.env.PINATA_GATEWAY;
const ORIGINAL_PINATA_JWT = process.env.PINATA_JWT;
const ORIGINAL_DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const ORIGINAL_MERCHANT_WALLET_ADDRESS = process.env.MERCHANT_WALLET_ADDRESS;
const ORIGINAL_THIRDWEB_SERVER_WALLET_ADDRESS = process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
const ORIGINAL_AVALANCHE_MAINNET_RPC = process.env.AVALANCHE_MAINNET_RPC;
const ORIGINAL_MONGO_DB_API_KEY = process.env.MONGO_DB_API_KEY;
const ORIGINAL_EMBEDDING_API_BASE = process.env.EMBEDDING_API_BASE;
const ORIGINAL_CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const ORIGINAL_CF_GLOBAL_TOKEN = process.env.CF_GLOBAL_TOKEN;
const ORIGINAL_AGENTS_D1_ID = process.env.AGENTS_D1_ID;
const ORIGINAL_CONNECTORS_URL = process.env.CONNECTORS_URL;
const ORIGINAL_CONNECTOR_URL = process.env.CONNECTOR_URL;
const ORIGINAL_MODELS_URL = process.env.MODELS_URL;
const ORIGINAL_COMPOSE_SESSION_SECRET = process.env.COMPOSE_SESSION_SECRET;
const NATIVE_FETCH = globalThis.fetch;
const ROUTES_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../routes.ts"), "utf8");
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

function composeKeyRecordKey(keyId: string): string {
  return `compose-key:${keyId}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${userAddress.toLowerCase()}`;
}

const memory = [
  "post /api/memory/context/assemble",
  "post /api/memory/turns/record",
  "post /api/memory/remember",
  "post /api/memory/loop",
  "get /api/memory/workflows",
  "get /api/memory/workflows/:workflowId",
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

test("registerWorkflowRoutes registers the explicit public workflow surface", () => {
  const app = express();
  registerWorkflowRoutes(app);
  const routes = listRegisteredRoutes(app).map((route) => `${route.methods[0]} ${route.path}`);
  const routeSet = new Set(routes);

  assert.equal(routeSet.has("post /agent/register"), false);
  assert.equal(routeSet.has("post /workflow/register"), false);
  assert.equal(routeSet.has("post /agent/:walletAddress/chat"), true);
  assert.equal(routeSet.has("post /agent/:walletAddress/responses"), true);
  assert.equal(routeSet.has("post /agent/:walletAddress/multimodal"), false);
  assert.equal(routeSet.has("get /agent/:walletAddress/knowledge"), false);
  assert.equal(routeSet.has("post /workflow/:walletAddress/chat"), true);
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

test("GET /frameworks exposes other after manowar", async () => {
  const app = express();
  registerWorkflowRoutes(app);
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

test("buildRuntimeInternalUrl targets the embedded runtime route", () => {
  process.env.RUNTIME_URL = "https://runtime.compose.market/";
  assert.equal(
    buildRuntimeInternalUrl("/agent/0xabc/chat"),
    "https://runtime.compose.market/internal/workflow/agent/0xabc/chat",
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

test("handlePublicRoute resolves agent catalog with PINATA_GATEWAY_URL", async () => {
  process.env.PINATA_JWT = "pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
  delete process.env.IPFS_PINATA_GATEWAY;
  delete process.env.PINATA_GATEWAY;
  let pinListQuery: unknown = null;

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);

    if (url.includes("/data/pinList")) {
      const parsedUrl = new URL(url);
      const rawQuery = parsedUrl.searchParams.get("metadata[keyvalues]");
      pinListQuery = rawQuery ? JSON.parse(rawQuery) : null;
      return new Response(JSON.stringify({
        rows: [{ ipfs_pin_hash: "baf-agent-card" }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-card") {
      return new Response(JSON.stringify({
        walletAddress: "0xba04fa4baacbac0d93bb73a7fd473a41aa7f2815",
        name: "Compose Agent",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents",
        requestContext: { http: { method: "GET" } },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    assert.deepEqual(JSON.parse(result!.body), {
      agents: [{
        walletAddress: "0xba04fa4baacbac0d93bb73a7fd473a41aa7f2815",
        name: "Compose Agent",
        cid: "baf-agent-card",
        creatorFee: 1,
        framework: "other",
        protocols: [],
        plugins: [],
      }],
      total: 1,
    });
    assert.deepEqual(pinListQuery, {
      type: {
        value: "agent-card",
        op: "eq",
      },
    });
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.PINATA_JWT = ORIGINAL_PINATA_JWT;
    process.env.PINATA_GATEWAY_URL = ORIGINAL_PINATA_GATEWAY_URL;
    process.env.IPFS_PINATA_GATEWAY = ORIGINAL_IPFS_PINATA_GATEWAY;
    process.env.PINATA_GATEWAY = ORIGINAL_PINATA_GATEWAY;
  }
});

test("handlePublicRoute lists only canonical mcp/onchain agent plugins", async () => {
  process.env.PINATA_JWT = "pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
  agentSearchTest.reset();

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/data/pinList")) {
      return new Response(JSON.stringify({
        rows: [
          { ipfs_pin_hash: "baf-agent-valid" },
          { ipfs_pin_hash: "baf-agent-tools" },
          { ipfs_pin_hash: "baf-agent-goat" },
          { ipfs_pin_hash: "baf-agent-unprefixed" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-valid") {
      return new Response(JSON.stringify({
        walletAddress: "0x1111111111111111111111111111111111111111",
        name: "Canonical Agent",
        model: "gpt-4o",
        plugins: [{ registryId: "mcp:perplexity", name: "Perplexity", origin: "mcp" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-tools") {
      return new Response(JSON.stringify({
        walletAddress: "0x2222222222222222222222222222222222222222",
        name: "Legacy Tools Agent",
        model: "gpt-4o",
        plugins: [{ registryId: "tools:perplexity", name: "Perplexity", origin: "tools" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-goat") {
      return new Response(JSON.stringify({
        walletAddress: "0x3333333333333333333333333333333333333333",
        name: "Legacy Goat Agent",
        model: "gpt-4o",
        plugins: [{ registryId: "goat:coingecko", name: "Coingecko", origin: "goat" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-unprefixed") {
      return new Response(JSON.stringify({
        walletAddress: "0x4444444444444444444444444444444444444444",
        name: "Unprefixed Agent",
        model: "gpt-4o",
        plugins: [{ registryId: "coingecko", name: "Coingecko", origin: "onchain" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents",
        requestContext: { http: { method: "GET" } },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 4);
    assert.deepEqual(
      body.agents.map((agent: { walletAddress: string; plugins: Array<{ registryId: string; origin: string }> }) => ({
        walletAddress: agent.walletAddress,
        plugin: agent.plugins[0]?.registryId,
        origin: agent.plugins[0]?.origin,
      })),
      [
        {
          walletAddress: "0x1111111111111111111111111111111111111111",
          plugin: "mcp:perplexity",
          origin: "mcp",
        },
        {
          walletAddress: "0x2222222222222222222222222222222222222222",
          plugin: "mcp:perplexity",
          origin: "mcp",
        },
        {
          walletAddress: "0x3333333333333333333333333333333333333333",
          plugin: "onchain:coingecko",
          origin: "onchain",
        },
        {
          walletAddress: "0x4444444444444444444444444444444444444444",
          plugin: "onchain:coingecko",
          origin: "onchain",
        },
      ],
    );
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.PINATA_JWT = ORIGINAL_PINATA_JWT;
    process.env.PINATA_GATEWAY_URL = ORIGINAL_PINATA_GATEWAY_URL;
    agentSearchTest.reset();
  }
});

test("findAgentByWallet canonicalizes legacy source cards without catalog refresh", async () => {
  delete process.env.AGENTS_D1_ID;
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.CF_GLOBAL_TOKEN;
  process.env.PINATA_JWT = "pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
  agentSearchTest.reset();

  const target = "0xa7abfd271130c3ee5c8f8862a123f3697e75af0d";
  const calls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/data/pinList")) {
      return new Response(JSON.stringify({
        rows: [
          { ipfs_pin_hash: "baf-agent-target" },
          { ipfs_pin_hash: "baf-agent-other" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-target") {
      return new Response(JSON.stringify({
        walletAddress: target,
        name: "Hello, friend",
        model: "gpt-4o",
        framework: "manowar",
        protocols: [{ name: "Manowar", version: "1.0" }],
        chain: 43113,
        creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
        skills: ["goat:coingecko"],
        plugins: [{ registryId: "goat:coingecko", name: "coingecko", origin: "goat" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const agent = await findAgentByWallet(target);
    assert.equal(agent?.walletAddress, target);
    assert.deepEqual(agent?.skills, ["onchain:coingecko"]);
    assert.deepEqual(agent?.plugins, [{ registryId: "onchain:coingecko", name: "coingecko", origin: "onchain" }]);
    assert.deepEqual(calls, [
      "https://api.pinata.cloud/data/pinList?status=pinned&metadata[keyvalues]=%7B%22type%22%3A%7B%22value%22%3A%22agent-card%22%2C%22op%22%3A%22eq%22%7D%7D&pageLimit=1000",
      "https://compose.mypinata.cloud/ipfs/baf-agent-target",
    ]);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    restoreEnv("CF_ACCOUNT_ID", ORIGINAL_CF_ACCOUNT_ID);
    restoreEnv("CF_GLOBAL_TOKEN", ORIGINAL_CF_GLOBAL_TOKEN);
    process.env.PINATA_JWT = ORIGINAL_PINATA_JWT;
    process.env.PINATA_GATEWAY_URL = ORIGINAL_PINATA_GATEWAY_URL;
    agentSearchTest.reset();
  }
});

function d1Result(results: unknown[] = []): Response {
  return new Response(JSON.stringify({ success: true, result: [{ results }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function agentRow(card: Record<string, unknown>, target?: string | null, route?: unknown): Record<string, unknown> {
  return {
    walletAddress: card.walletAddress,
    card: JSON.stringify(card),
    text: `${card.name || ""} ${card.model || ""}`,
    target: target ?? null,
    route: route ? JSON.stringify(route) : null,
  };
}

type AgentD1Row = {
  walletAddress: string;
  card: string;
  text: string;
  creatorFee?: number | null;
  target?: string | null;
  route?: string | null;
  state?: string;
};

function agentsD1(rows: Map<string, AgentD1Row>, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body || "{}")) as { sql?: string; params?: unknown[] };
  const sql = body.sql || "";
  const params = body.params || [];
  if (sql.startsWith("PRAGMA table_info(agents)")) {
    return d1Result([
      { name: "walletAddress" },
      { name: "card" },
      { name: "text" },
      { name: "hash" },
      { name: "name" },
      { name: "model" },
      { name: "cid" },
      { name: "state" },
      { name: "batch" },
      { name: "updated" },
      { name: "target" },
      { name: "route" },
      { name: "creatorFee" },
    ]);
  }
  if (sql.startsWith("PRAGMA table_info(routes)")) {
    return d1Result([
      { name: "model" },
      { name: "target" },
      { name: "reason" },
      { name: "updated" },
      { name: "source" },
      { name: "score" },
      { name: "candidates" },
    ]);
  }
  if (sql.includes("FROM cursor")) return d1Result([]);
  if (sql.includes("FROM routes")) return d1Result([]);
  if (sql.includes("SELECT walletAddress, card, creatorFee")) return d1Result([]);
  if (sql.includes("INSERT INTO agents")) {
    const wallet = String(params[0] || "").toLowerCase();
    rows.set(wallet, {
      walletAddress: wallet,
      card: String(params[1] || "{}"),
      text: String(params[2] || ""),
      target: typeof params[6] === "string" ? params[6] : null,
      route: typeof params[7] === "string" ? params[7] : null,
      creatorFee: typeof params[9] === "number" ? params[9] : null,
      state: "queued",
    });
    return d1Result([]);
  }
  if (sql.includes("UPDATE agents") && sql.includes("state = 'indexed'")) {
    const wallet = String(params[0] || "").toLowerCase();
    const row = rows.get(wallet);
    if (row) row.state = "indexed";
    return d1Result([]);
  }
  if (sql.includes("FROM agents") && sql.includes("lower(walletAddress) IN")) {
    const wanted = new Set(params.map((item) => String(item).toLowerCase()));
    return d1Result([...rows.values()].filter((row) => row.state === "indexed" && wanted.has(row.walletAddress.toLowerCase())));
  }
  if (sql.includes("FROM agents") && sql.includes("state = 'indexed'")) {
    return d1Result([...rows.values()].filter((row) => row.state === "indexed"));
  }
  return d1Result([]);
}

function stampedAgentsD1(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body || "{}")) as { sql?: string };
  if ((body.sql || "").includes("FROM cursor")) {
    return d1Result([{ value: "creatorFee.ipfs.v1" }]);
  }
  return d1Result([]);
}

async function withAgentsD1<T>(
  card: Record<string, unknown>,
  routes: Record<string, { target: string; reason?: string; source?: string; score?: number; candidates?: string[] }>,
  selectionOrRun: { selected?: Record<string, unknown> | null; alternates?: Record<string, unknown>[]; status?: number } | (() => Promise<T>),
  maybeRun?: () => Promise<T>,
): Promise<T> {
  const selection = typeof selectionOrRun === "function" ? undefined : selectionOrRun;
  const run = typeof selectionOrRun === "function" ? selectionOrRun : maybeRun;
  if (!run) throw new Error("withAgentsD1 run callback is required");
  process.env.AGENTS_D1_ID = "agents-db";
  process.env.CF_ACCOUNT_ID = "account";
  process.env.CF_GLOBAL_TOKEN = "cf-token";
  process.env.MODELS_URL = "https://models.compose.market";
  agentSearchTest.reset();

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://models.compose.market/rebind") {
      return new Response(JSON.stringify(selection ?? { selected: null, alternates: [] }), {
        status: selection?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url !== "https://api.cloudflare.com/client/v4/accounts/account/d1/database/agents-db/query") {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    const body = JSON.parse(String(init?.body || "{}")) as { sql?: string; params?: unknown[] };
    const sql = body.sql || "";
    if (sql.startsWith("PRAGMA table_info(agents)")) {
      return d1Result([
        { name: "walletAddress" },
        { name: "card" },
        { name: "text" },
        { name: "hash" },
        { name: "name" },
        { name: "model" },
        { name: "cid" },
        { name: "state" },
        { name: "batch" },
        { name: "updated" },
        { name: "creatorFee", type: "REAL" },
      ]);
    }
    if (sql.includes("FROM cursor")) {
      return d1Result([{ value: "creatorFee.ipfs.v1" }]);
    }
    if (sql.includes("FROM agents") && sql.includes("lower(walletAddress)")) {
      return d1Result([agentRow(card)]);
    }
    if (sql.includes("FROM routes")) {
      const model = String(body.params?.[0] || "");
      const route = routes[model];
      return d1Result(route ? [{
        target: route.target,
        reason: route.reason ?? null,
        source: route.source ?? null,
        score: route.score ?? null,
        candidates: route.candidates ? JSON.stringify(route.candidates) : null,
        updated: "2026-05-27 00:00:00",
      }] : []);
    }
    if (sql.includes("INSERT INTO routes")) {
      const model = String(body.params?.[0] || "");
      const target = String(body.params?.[1] || "");
      const reason = typeof body.params?.[2] === "string" ? body.params[2] : undefined;
      const source = typeof body.params?.[3] === "string" ? body.params[3] : undefined;
      const score = typeof body.params?.[4] === "number" ? body.params[4] : undefined;
      const candidates = typeof body.params?.[5] === "string" ? JSON.parse(body.params[5]) as string[] : undefined;
      if (model && target) routes[model] = { target, reason, source, score, candidates };
      return d1Result([]);
    }
    return d1Result([]);
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    restoreEnv("CF_ACCOUNT_ID", ORIGINAL_CF_ACCOUNT_ID);
    restoreEnv("CF_GLOBAL_TOKEN", ORIGINAL_CF_GLOBAL_TOKEN);
    restoreEnv("MODELS_URL", ORIGINAL_MODELS_URL);
    agentSearchTest.reset();
  }
}

test("findAgentByWallet projects exact catalog models from Agents D1", async () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  await withAgentsD1({
    walletAddress: wallet,
    name: "Runnable Agent",
    model: "gpt-4o",
    framework: "manowar",
    protocols: [{ name: "Manowar", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, {}, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.model, "gpt-4o");
    assert.equal(agent?.target, "gpt-4o");
    assert.equal(agent?.route?.kind, "exact");
    assert.equal(agent?.route?.from, "gpt-4o");
  });
});

test("findAgentByWallet normalizes non-Manowar frameworks to other", async () => {
  const wallet = "0x1212121212121212121212121212121212121212";
  await withAgentsD1({
    walletAddress: wallet,
    name: "Other Agent",
    model: "gpt-4o",
    framework: "langchain",
    protocols: [{ name: "x402", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, {}, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.framework, "other");
    assert.deepEqual(agent?.protocols, [{ name: "x402", version: "1.0" }]);
  });
});

test("findAgentByWallet reuses cached deterministic Agents D1 routes", async () => {
  const wallet = "0x2222222222222222222222222222222222222222";
  await withAgentsD1({
    walletAddress: wallet,
    name: "Bumped Agent",
    model: "gpt-5.2",
    framework: "manowar",
    protocols: [{ name: "Manowar", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, { "gpt-5.2": { target: "gemini-2.5-flash", reason: "automatic catalog rebind", source: "models.rebind" } }, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.model, "gpt-5.2");
    assert.equal(agent?.target, "gemini-2.5-flash");
    assert.equal(agent?.route?.kind, "bump");
    assert.equal(agent?.route?.from, "gpt-5.2");
    assert.equal(agent?.route?.to, "gemini-2.5-flash");
    assert.equal(agent?.route?.reason, "automatic catalog rebind");
  });
});

test("findAgentByWallet automatically rebinds missing models through deterministic models catalog ranking", async () => {
  const wallet = "0x3333333333333333333333333333333333333333";
  const routes: Record<string, { target: string; reason?: string; source?: string; score?: number; candidates?: string[] }> = {};
  await withAgentsD1({
    walletAddress: wallet,
    name: "Missing Route Agent",
    model: "gpt-5.2",
    framework: "manowar",
    protocols: [{ name: "Manowar", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, routes, {
    selected: {
      modelId: "gemini-2.5-flash",
      provider: "gemini",
      name: "Gemini 2.5 Flash",
      score: 0.91,
    },
    alternates: [{
      modelId: "gpt-4.1-mini",
      provider: "openai",
      score: 0.82,
    }],
  }, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.model, "gpt-5.2");
    assert.equal(agent?.target, "gemini-2.5-flash");
    assert.equal(agent?.route?.kind, "bump");
    assert.equal(agent?.route?.from, "gpt-5.2");
    assert.equal(agent?.route?.to, "gemini-2.5-flash");
    assert.equal(agent?.route?.source, "models.rebind");
    assert.equal(agent?.route?.score, 0.91);
    assert.equal(routes["gpt-5.2"].target, "gemini-2.5-flash");
  });
});

test("findAgentByWallet recomputes obsolete semantic route rows", async () => {
  const wallet = "0x3434343434343434343434343434343434343434";
  const routes: Record<string, { target: string; reason?: string; source?: string; score?: number; candidates?: string[] }> = {
    "gpt-5.2": { target: "gpt-5.5-pro", reason: "stale semantic route", source: "models.select" },
  };
  await withAgentsD1({
    walletAddress: wallet,
    name: "Stale Route Agent",
    model: "gpt-5.2",
    framework: "manowar",
    protocols: [{ name: "Manowar", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, routes, {
    selected: {
      modelId: "gemini-2.5-flash",
      provider: "gemini",
      name: "Gemini 2.5 Flash",
      score: 0.93,
    },
  }, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.target, "gemini-2.5-flash");
    assert.equal(agent?.route?.source, "models.rebind");
    assert.equal(routes["gpt-5.2"].target, "gemini-2.5-flash");
    assert.equal(routes["gpt-5.2"].source, "models.rebind");
  });
});

test("findAgentByWallet does not trust legacy operator rows as automatic routes", async () => {
  const wallet = "0x3535353535353535353535353535353535353535";
  const routes: Record<string, { target: string; reason?: string; source?: string; score?: number; candidates?: string[] }> = {
    "gpt-5.2": { target: "gpt-4.1-mini", reason: "operator route" },
  };
  await withAgentsD1({
    walletAddress: wallet,
    name: "Legacy Route Agent",
    model: "gpt-5.2",
    framework: "manowar",
    protocols: [{ name: "Manowar", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, routes, {
    selected: {
      modelId: "gemini-2.5-flash",
      provider: "gemini",
      name: "Gemini 2.5 Flash",
      score: 0.93,
    },
  }, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.target, "gemini-2.5-flash");
    assert.equal(agent?.route?.source, "models.rebind");
    assert.equal(routes["gpt-5.2"].target, "gemini-2.5-flash");
  });
});

test("findAgentByWallet fails closed when automatic rebind returns no valid catalog target", async () => {
  const wallet = "0x4444444444444444444444444444444444444444";
  await withAgentsD1({
    walletAddress: wallet,
    name: "Invalid Route Agent",
    model: "gpt-5.2",
    framework: "manowar",
    protocols: [{ name: "Manowar", version: "1.0" }],
    chain: 43113,
    creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
    skills: [],
    plugins: [],
  }, {}, {
    selected: {
      modelId: "not-a-model",
      provider: "missing",
      score: 0.5,
    },
  }, async () => {
    const agent = await findAgentByWallet(wallet);
    assert.equal(agent?.model, "gpt-5.2");
    assert.equal(agent?.target, undefined);
    assert.equal(agent?.route?.kind, "missing");
    assert.equal(agent?.route?.source, "models.rebind");
    assert.deepEqual(agent?.route?.candidates, ["not-a-model"]);
  });
});

test("handlePublicRoute does not return Vectorize agent metadata without Agents D1 hydration", async () => {
  process.env.MONGO_DB_API_KEY = "mongo-key";
  process.env.EMBEDDING_API_BASE = "https://ai.mongodb.com/v1";
  process.env.CF_ACCOUNT_ID = "account";
  process.env.CF_GLOBAL_TOKEN = "cf-token";
  process.env.AGENTS_D1_ID = "agents-db";
  agentSearchTest.reset();

  const forbidden: string[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/d1/database/agents-db/query") {
      return stampedAgentsD1(init);
    }

    if (url === "https://ai.mongodb.com/v1/embeddings") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.input_type, "query");
      assert.deepEqual(body.input, ["autonomous"]);
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.9, 0.1] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/query") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.deepEqual(body.vector, [0.9, 0.1]);
      assert.equal(body.returnMetadata, "all");
      return new Response(JSON.stringify({
        success: true,
        result: {
          matches: [{
            id: "agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            score: 0.91,
            metadata: {
              walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              name: "Āutonomous",
              description: "A sharp autonomous strategy agent.",
              model: "gpt-4o",
              target: "gpt-4o",
              route: "exact",
              skills: ["strategy", "positioning"],
              plugins: ["onchain:coingecko"],
            },
          }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    forbidden.push(url);
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents/search",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { q: "autonomous", limit: "3" },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 0);
    assert.deepEqual(body.agents, []);
    assert.deepEqual(forbidden, []);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.MONGO_DB_API_KEY = ORIGINAL_MONGO_DB_API_KEY;
    process.env.EMBEDDING_API_BASE = ORIGINAL_EMBEDDING_API_BASE;
    process.env.CF_ACCOUNT_ID = ORIGINAL_CF_ACCOUNT_ID;
    process.env.CF_GLOBAL_TOKEN = ORIGINAL_CF_GLOBAL_TOKEN;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    agentSearchTest.reset();
  }
});

test("handlePublicRoute hydrates Vectorize agent candidates from Agents D1 before rerank", async () => {
  process.env.MONGO_DB_API_KEY = "mongo-key";
  process.env.EMBEDDING_API_BASE = "https://ai.mongodb.com/v1";
  process.env.CF_ACCOUNT_ID = "account";
  process.env.CF_GLOBAL_TOKEN = "cf-token";
  process.env.AGENTS_D1_ID = "agents-db";
  agentSearchTest.reset();

  const hi = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const strategist = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const rows = [
    {
      card: JSON.stringify({
        walletAddress: hi,
        name: "Hi",
        description: "A greeting-only agent for hello messages.",
        model: "gpt-4o",
        target: "gpt-4o",
        route: { kind: "exact", from: "gpt-4o", checked: "2026-06-01T00:00:00.000Z" },
        framework: "manowar",
        protocols: [{ name: "Manowar", version: "1.0" }],
        chain: 43113,
        creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
        skills: ["greeting"],
        plugins: [],
      }),
      text: "name: Hi\ndescription: A greeting-only agent for hello messages.\nskills: greeting",
      target: "gpt-4o",
      route: JSON.stringify({ kind: "exact", from: "gpt-4o", checked: "2026-06-01T00:00:00.000Z" }),
    },
    {
      card: JSON.stringify({
        walletAddress: strategist,
        name: "Positioning Studio",
        description: "Brand strategy, launch positioning, naming, and editorial product taste.",
        model: "gpt-4o",
        target: "gpt-4o",
        route: { kind: "exact", from: "gpt-4o", checked: "2026-06-01T00:00:00.000Z" },
        framework: "manowar",
        protocols: [{ name: "Manowar", version: "1.0" }],
        chain: 43113,
        creator: "0x90a1db3439ee1322a3eb9ce5037654043d707005",
        skills: ["branding", "positioning", "launch strategy"],
        plugins: [],
      }),
      text: "name: Positioning Studio\ndescription: Brand strategy, launch positioning, naming, and editorial product taste.\nskills: branding, positioning, launch strategy",
      target: "gpt-4o",
      route: JSON.stringify({ kind: "exact", from: "gpt-4o", checked: "2026-06-01T00:00:00.000Z" }),
    },
  ];

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/d1/database/agents-db/query") {
      const body = JSON.parse(String(init?.body || "{}")) as { sql?: string };
      const sql = body.sql || "";
      if (sql.includes("FROM cursor")) return d1Result([{ value: "creatorFee.ipfs.v1" }]);
      if (sql.includes("FROM agents") && sql.includes("lower(walletAddress) IN")) return d1Result(rows);
      return d1Result([]);
    }

    if (url === "https://ai.mongodb.com/v1/embeddings") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.input_type, "query");
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.9, 0.1] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/query") {
      return new Response(JSON.stringify({
        success: true,
        result: {
          matches: [
            { id: `agent:${hi}`, score: 0.98, metadata: { walletAddress: hi, name: "Hi" } },
            { id: `agent:${strategist}`, score: 0.74, metadata: { walletAddress: strategist, name: "Positioning Studio" } },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://ai.mongodb.com/v1/rerank") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.query, "launch positioning and brand strategy specialist");
      assert.equal(body.documents.length, 2);
      assert.match(body.documents[0], /greeting-only/);
      assert.match(body.documents[1], /Brand strategy, launch positioning/);
      return new Response(JSON.stringify({
        data: [{ index: 1, relevance_score: 0.97 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents/search",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { q: "launch positioning and brand strategy specialist", limit: "2" },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 1);
    assert.equal(body.agents[0].walletAddress, strategist);
    assert.equal(body.agents[0].name, "Positioning Studio");
    assert.equal(body.agents[0].score, 0.97);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.MONGO_DB_API_KEY = ORIGINAL_MONGO_DB_API_KEY;
    process.env.EMBEDDING_API_BASE = ORIGINAL_EMBEDDING_API_BASE;
    process.env.CF_ACCOUNT_ID = ORIGINAL_CF_ACCOUNT_ID;
    process.env.CF_GLOBAL_TOKEN = ORIGINAL_CF_GLOBAL_TOKEN;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    agentSearchTest.reset();
  }
});

test("handlePublicRoute searches deployed agents through API-owned semantic search", async () => {
  process.env.PINATA_JWT = "pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
  process.env.MONGO_DB_API_KEY = "mongo-key";
  process.env.EMBEDDING_API_BASE = "https://ai.mongodb.com/v1";
  process.env.CF_ACCOUNT_ID = "account";
  process.env.CF_GLOBAL_TOKEN = "cf-token";
  process.env.AGENTS_D1_ID = "agents-db";
  agentSearchTest.reset();

  const calls: string[] = [];
  const rows = new Map<string, AgentD1Row>();
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/d1/database/agents-db/query") {
      return agentsD1(rows, init);
    }

    if (url.includes("/data/pinList")) {
      return new Response(JSON.stringify({
        rows: [
          { ipfs_pin_hash: "baf-agent-crypto" },
          { ipfs_pin_hash: "baf-agent-writer" },
          { ipfs_pin_hash: "baf-agent-tools" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-crypto") {
      return new Response(JSON.stringify({
        walletAddress: "0x1111111111111111111111111111111111111111",
        name: "Coingecko Agent",
        description: "Answers crypto price questions.",
        model: "accounts/fireworks/models/minimax-m2p5",
        skills: ["onchain:coingecko"],
        plugins: [{ registryId: "onchain:coingecko", name: "Coingecko", origin: "onchain" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-writer") {
      return new Response(JSON.stringify({
        walletAddress: "0x2222222222222222222222222222222222222222",
        name: "Writer Agent",
        description: "Writes prose.",
        model: "accounts/fireworks/models/minimax-m2p5",
        skills: ["writing"],
        plugins: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-tools") {
      return new Response(JSON.stringify({
        walletAddress: "0x3333333333333333333333333333333333333333",
        name: "Legacy Tools Agent",
        description: "Uses a legacy plugin prefix.",
        model: "gpt-4o",
        skills: ["tools:perplexity"],
        plugins: [{ registryId: "tools:perplexity", name: "Perplexity", origin: "tools" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://connectors.compose.market/mcps/perplexity") {
      return new Response(JSON.stringify({
        slug: "perplexity",
        name: "Perplexity",
        description: "Live web research connector.",
        tags: ["search"],
        category: "research",
        status: "active",
        tools: [{ name: "search", description: "Search the web." }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://ai.mongodb.com/v1/embeddings") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mongo-key");
      if (body.input_type === "document") {
        assert.equal(body.input.length, 3);
        return new Response(JSON.stringify({
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.2, 0.3] },
            { index: 2, embedding: [0.3, 0.4] },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      assert.equal(body.input_type, "query");
      assert.deepEqual(body.input, ["bitcoin price"]);
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.9, 0.1] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/upsert") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cf-token");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/x-ndjson");
      const lines = String(init?.body || "").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => line.id), [
        "agent:0x1111111111111111111111111111111111111111",
        "agent:0x2222222222222222222222222222222222222222",
        "agent:0x3333333333333333333333333333333333333333",
      ]);
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/query") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.deepEqual(body.vector, [0.9, 0.1]);
      return new Response(JSON.stringify({
        success: true,
        result: {
          matches: [
            {
              id: "agent:0x1111111111111111111111111111111111111111",
              score: 0.82,
              metadata: {
                walletAddress: "0x1111111111111111111111111111111111111111",
                name: "Coingecko Agent",
                description: "Answers crypto price questions.",
                model: "accounts/fireworks/models/minimax-m2p5",
                skills: ["onchain:coingecko"],
                plugins: ["onchain:coingecko"],
              },
            },
            {
              id: "agent:0x2222222222222222222222222222222222222222",
              score: 0.41,
              metadata: {
                walletAddress: "0x2222222222222222222222222222222222222222",
                name: "Writer Agent",
                description: "Writes prose.",
                model: "accounts/fireworks/models/minimax-m2p5",
                skills: ["writing"],
                plugins: [],
              },
            },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://ai.mongodb.com/v1/rerank") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.query, "bitcoin price");
      assert.equal(body.documents.length, 2);
      assert.match(body.documents[0], /onchain:coingecko/);
      return new Response(JSON.stringify({
        data: [{ index: 0, relevance_score: 0.99 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents/search",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { q: "bitcoin price", limit: "3" },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 1);
    assert.equal(body.agents[0].walletAddress, "0x1111111111111111111111111111111111111111");
    assert.equal(body.agents[0].plugins[0].registryId, "onchain:coingecko");
    assert.equal(body.agents[0].score, 0.99);
    assert.deepEqual(calls.filter((url) => url.includes("agentverse")), []);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.PINATA_JWT = ORIGINAL_PINATA_JWT;
    process.env.PINATA_GATEWAY_URL = ORIGINAL_PINATA_GATEWAY_URL;
    process.env.MONGO_DB_API_KEY = ORIGINAL_MONGO_DB_API_KEY;
    process.env.EMBEDDING_API_BASE = ORIGINAL_EMBEDDING_API_BASE;
    process.env.CF_ACCOUNT_ID = ORIGINAL_CF_ACCOUNT_ID;
    process.env.CF_GLOBAL_TOKEN = ORIGINAL_CF_GLOBAL_TOKEN;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    agentSearchTest.reset();
  }
});

test("handlePublicRoute ranks agents using source-owned tool descriptions", async () => {
  process.env.PINATA_JWT = "pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
  process.env.MONGO_DB_API_KEY = "mongo-key";
  process.env.EMBEDDING_API_BASE = "https://ai.mongodb.com/v1";
  process.env.CF_ACCOUNT_ID = "account";
  process.env.CF_GLOBAL_TOKEN = "cf-token";
  process.env.AGENTS_D1_ID = "agents-db";
  process.env.CONNECTORS_URL = "https://connectors.compose.market";
  delete process.env.CONNECTOR_URL;
  agentSearchTest.reset();

  const rows = new Map<string, AgentD1Row>();
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/d1/database/agents-db/query") {
      return agentsD1(rows, init);
    }

    if (url.includes("/data/pinList")) {
      return new Response(JSON.stringify({
        rows: [
          { ipfs_pin_hash: "baf-agent-crypto" },
          { ipfs_pin_hash: "baf-agent-research" },
          { ipfs_pin_hash: "baf-agent-stale" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-crypto") {
      return new Response(JSON.stringify({
        walletAddress: "0x1111111111111111111111111111111111111111",
        name: "Coingecko Agent",
        description: "Answers crypto price questions.",
        model: "accounts/fireworks/models/minimax-m2p5",
        skills: ["onchain:coingecko"],
        plugins: [{ registryId: "onchain:coingecko", name: "Coingecko", origin: "onchain" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-research") {
      return new Response(JSON.stringify({
        walletAddress: "0x2222222222222222222222222222222222222222",
        name: "Research Agent",
        description: "Investigates open-ended questions.",
        model: "gpt-4o",
        skills: ["mcp:perplexity"],
        plugins: [{ registryId: "mcp:perplexity", name: "Perplexity", origin: "mcp" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://compose.mypinata.cloud/ipfs/baf-agent-stale") {
      return new Response(JSON.stringify({
        walletAddress: "0x3333333333333333333333333333333333333333",
        name: "Stale Tool Agent",
        description: "References an unserved connector.",
        model: "gpt-4o",
        skills: ["mcp:socket"],
        plugins: [{ registryId: "mcp:socket", name: "Socket", origin: "mcp" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://connectors.compose.market/mcps/perplexity") {
      return new Response(JSON.stringify({
        slug: "perplexity",
        name: "Perplexity",
        description: "Real-time web search, reasoning, and research through Perplexity's API",
        tags: ["search", "research", "ai"],
        category: "search",
        status: "credential_gated",
        tools: [{
          name: "search",
          description: "Search the live web and cite current sources.",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://connectors.compose.market/mcps/socket") {
      return new Response(JSON.stringify({
        error: { code: "SERVER_QUARANTINED", message: "server is not in the final served catalog" },
      }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://ai.mongodb.com/v1/embeddings") {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.input_type === "document") {
        assert.equal(body.input.length, 3);
        assert.doesNotMatch(body.input[0], /Real-time web search/);
        assert.match(body.input[1], /Real-time web search, reasoning, and research through Perplexity's API/);
        assert.doesNotMatch(body.input[2], /SERVER_QUARANTINED|server is not in the final served catalog/);
        return new Response(JSON.stringify({
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.2, 0.3] },
            { index: 2, embedding: [0.3, 0.4] },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      assert.equal(body.input_type, "query");
      assert.deepEqual(body.input, ["web research"]);
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.9, 0.1] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/upsert") {
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/query") {
      return new Response(JSON.stringify({
        success: true,
        result: {
          matches: [
            {
              id: "agent:0x1111111111111111111111111111111111111111",
              score: 0.82,
              metadata: {
                walletAddress: "0x1111111111111111111111111111111111111111",
                name: "Coingecko Agent",
                description: "Answers crypto price questions.",
                model: "accounts/fireworks/models/minimax-m2p5",
                skills: ["onchain:coingecko"],
                plugins: ["onchain:coingecko"],
              },
            },
            {
              id: "agent:0x2222222222222222222222222222222222222222",
              score: 0.81,
              metadata: {
                walletAddress: "0x2222222222222222222222222222222222222222",
                name: "Research Agent",
                description: "Investigates open-ended questions.",
                model: "gpt-4o",
                skills: ["mcp:perplexity"],
                plugins: ["mcp:perplexity"],
                evidence: "Research Agent; Investigates open-ended questions.; Real-time web search, reasoning, and research through Perplexity's API; Search the live web and cite current sources.",
              },
            },
            {
              id: "agent:0x3333333333333333333333333333333333333333",
              score: 0.80,
              metadata: {
                walletAddress: "0x3333333333333333333333333333333333333333",
                name: "Stale Tool Agent",
                description: "References an unserved connector.",
                model: "gpt-4o",
                skills: ["mcp:socket"],
                plugins: ["mcp:socket"],
              },
            },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://ai.mongodb.com/v1/rerank") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.query, "web research");
      assert.equal(body.documents.length, 3);
      assert.doesNotMatch(body.documents[0], /Real-time web search/);
      assert.match(body.documents[1], /Search the live web and cite current sources/);
      assert.doesNotMatch(body.documents[2], /SERVER_QUARANTINED|server is not in the final served catalog/);
      return new Response(JSON.stringify({
        data: [{ index: 1, relevance_score: 0.99 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents/search",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { q: "web research", limit: "2" },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 1);
    assert.equal(body.agents[0].walletAddress, "0x2222222222222222222222222222222222222222");
    assert.equal(body.agents[0].plugins[0].registryId, "mcp:perplexity");
    assert.equal(body.agents[0].score, 0.99);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.PINATA_JWT = ORIGINAL_PINATA_JWT;
    process.env.PINATA_GATEWAY_URL = ORIGINAL_PINATA_GATEWAY_URL;
    process.env.MONGO_DB_API_KEY = ORIGINAL_MONGO_DB_API_KEY;
    process.env.EMBEDDING_API_BASE = ORIGINAL_EMBEDDING_API_BASE;
    process.env.CF_ACCOUNT_ID = ORIGINAL_CF_ACCOUNT_ID;
    process.env.CF_GLOBAL_TOKEN = ORIGINAL_CF_GLOBAL_TOKEN;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    if (ORIGINAL_CONNECTORS_URL === undefined) delete process.env.CONNECTORS_URL;
    else process.env.CONNECTORS_URL = ORIGINAL_CONNECTORS_URL;
    if (ORIGINAL_CONNECTOR_URL === undefined) delete process.env.CONNECTOR_URL;
    else process.env.CONNECTOR_URL = ORIGINAL_CONNECTOR_URL;
    agentSearchTest.reset();
  }
});

test("handlePublicRoute skips malformed Vectorize agent candidates without local fallback", async () => {
  process.env.MONGO_DB_API_KEY = "mongo-key";
  process.env.EMBEDDING_API_BASE = "https://ai.mongodb.com/v1";
  process.env.CF_ACCOUNT_ID = "account";
  process.env.CF_GLOBAL_TOKEN = "cf-token";
  process.env.AGENTS_D1_ID = "agents-db";
  agentSearchTest.reset();

  const forbidden: string[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/d1/database/agents-db/query") {
      return stampedAgentsD1(init);
    }

    if (url === "https://ai.mongodb.com/v1/embeddings") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.input_type, "query");
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.9, 0.1] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/account/vectorize/v2/indexes/agents/query") {
      return new Response(JSON.stringify({
        success: true,
        result: {
          matches: [{
            id: "agent:not-a-wallet",
            score: 0.7,
            metadata: {
              name: "Broken Agent",
              skills: ["onchain:coingecko"],
              plugins: ["onchain:coingecko"],
            },
          }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    forbidden.push(url);
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await handlePublicRoute(
      {
        rawPath: "/agents/search",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { q: "bitcoin price" },
      },
      {},
    );

    assert.equal(result?.statusCode, 200);
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 0);
    assert.deepEqual(body.agents, []);
    assert.deepEqual(forbidden, []);
  } finally {
    globalThis.fetch = NATIVE_FETCH;
    process.env.MONGO_DB_API_KEY = ORIGINAL_MONGO_DB_API_KEY;
    process.env.EMBEDDING_API_BASE = ORIGINAL_EMBEDDING_API_BASE;
    process.env.CF_ACCOUNT_ID = ORIGINAL_CF_ACCOUNT_ID;
    process.env.CF_GLOBAL_TOKEN = ORIGINAL_CF_GLOBAL_TOKEN;
    restoreEnv("AGENTS_D1_ID", ORIGINAL_AGENTS_D1_ID);
    agentSearchTest.reset();
  }
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
  registerWorkflowRoutes(app);
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const response = await NATIVE_FETCH(`http://127.0.0.1:${port}/workflow/prices`);
    assert.equal(response.status, 200);
    const capturedCall = runtimeCalls[0];
    if (!capturedCall) {
      throw new Error("Expected runtime passthrough to be invoked");
    }
    assert.equal(capturedCall.url, "https://runtime.compose.market/internal/workflow/workflow/prices");
    assert.equal(new Headers(capturedCall.init?.headers).has("payment-signature"), false);
  } finally {
    server.close();
    globalThis.fetch = NATIVE_FETCH;
    process.env.RUNTIME_URL = ORIGINAL_RUNTIME_URL;
  }
});

test("payable stream routes settle terminal SSE usage before waiting for runtime EOF", () => {
  const branchStart = ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && settlement)");
  const fallback = ROUTES_SOURCE.indexOf("if (buffer.trim().length > 0)", branchStart);
  const branch = ROUTES_SOURCE.slice(branchStart, fallback);
  const terminal = ROUTES_SOURCE.indexOf('markTiming("terminal_settlement_event")');
  const earlyReceipt = branch.indexOf("const receipt = await settleOnce();\n            writeReceipt(receipt);");
  const cancelReader = branch.indexOf("await reader.cancel()");

  assert.ok(terminal > 0, "terminal settlement timing marker is required");
  assert.ok(earlyReceipt > 0, "terminal events must trigger settlement immediately");
  assert.ok(cancelReader > earlyReceipt, "runtime reader must be released after terminal settlement");
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

test("payable stream routes write an SSE open frame before waiting for runtime chunks", () => {
  const payableStart = ROUTES_SOURCE.indexOf("function payableStreamRoute");
  const readerStart = ROUTES_SOURCE.indexOf("const reader = runtimeResponse.body.getReader()", payableStart);
  const openStart = ROUTES_SOURCE.lastIndexOf("writeSseOpen(res);", readerStart);
  const headersStart = ROUTES_SOURCE.lastIndexOf("applyRuntimeHeaders(res, runtimeResponse);", readerStart);
  const openMark = ROUTES_SOURCE.indexOf('markTiming("gateway_open_written")', openStart);
  const firstChunkMark = ROUTES_SOURCE.indexOf('markTiming("first_runtime_chunk")', readerStart);

  assert.ok(headersStart > payableStart, "runtime headers must be applied before opening the gateway stream");
  assert.ok(openStart > headersStart, "gateway must write an SSE open frame after headers");
  assert.ok(openStart < readerStart, "gateway open frame must be written before awaiting runtime chunks");
  assert.ok(openMark > openStart && openMark < readerStart, "gateway open write must be timed before runtime chunks");
  assert.ok(firstChunkMark > readerStart, "runtime chunk timing must remain inside the reader loop");
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

test("payable stream routes write receipt before DONE when both arrive in one chunk", () => {
  const terminalBranch = ROUTES_SOURCE.slice(
    ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && settlement)"),
    ROUTES_SOURCE.indexOf("try {\n              await reader.cancel()", ROUTES_SOURCE.indexOf("if (sawTerminalSettlement && settlement)")),
  );

  assert.ok(terminalBranch.includes('const doneIndex = text.indexOf("data: [DONE]")'));
  assert.ok(terminalBranch.indexOf("res.write(beforeDone)") < terminalBranch.indexOf("writeReceipt(receipt)"));
  assert.ok(terminalBranch.indexOf("writeReceipt(receipt)") < terminalBranch.indexOf("res.write(text.slice(doneIndex))"));
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
  // The raw x402 upto challenge requires DEPLOYER_KEY (for facilitator address)
  // and MERCHANT_WALLET_ADDRESS (for payTo). Set them if not already present.
  process.env.DEPLOYER_KEY = ORIGINAL_DEPLOYER_KEY || `0x${"11".repeat(32)}`;
  process.env.MERCHANT_WALLET_ADDRESS =
    ORIGINAL_MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS =
    ORIGINAL_THIRDWEB_SERVER_WALLET_ADDRESS || "0x1111111111111111111111111111111111111111";
  process.env.AVALANCHE_MAINNET_RPC =
    ORIGINAL_AVALANCHE_MAINNET_RPC || "https://api.avax.network/ext/bc/C/rpc";

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerWorkflowRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    const endpoints: Array<{ method: "POST"; path: string; scheme: string }> = [
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/chat", scheme: "batch-settlement" },
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/stream", scheme: "batch-settlement" },
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/responses", scheme: "batch-settlement" },
      { method: "POST", path: "/workflow/0x0000000000000000000000000000000000000001/chat", scheme: "upto" },
      { method: "POST", path: "/workflow/execute", scheme: "upto" },
      { method: "POST", path: "/api/memory/search", scheme: "upto" },
    ];

    for (const ep of endpoints) {
      const response = await fetch(`http://127.0.0.1:${port}${ep.path}`, {
        method: ep.method,
        headers: {
          "content-type": "application/json",
          "x-chain-id": "43114",
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
    process.env.DEPLOYER_KEY = ORIGINAL_DEPLOYER_KEY;
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

test("agent route receipts expose a cumulative display bill without changing wrapper settlement", () => {
  const settleBody = ROUTES_SOURCE.slice(
    ROUTES_SOURCE.indexOf("async function resolveAgentEndpointSettlement"),
    ROUTES_SOURCE.indexOf("function resolveAgentTextSettlement"),
  );

  assert.match(settleBody, /const childAgents = uniqueCharges\(await listChildEvidence/);
  assert.match(settleBody, /\.\.\.direct\.map\(evidenceBill\)/);
  assert.match(settleBody, /\.\.\.childAgents\.map\(evidenceBill\)/);
  assert.match(settleBody, /const displayTotalWei = childBills\.reduce/);
  assert.match(settleBody, /finalAmountWei: wrapperFeeWei\.toString\(\)/);
  assert.match(settleBody, /agentBill\(\{/);
  assert.ok(
    settleBody.indexOf("agentBill({") < settleBody.indexOf("bill({"),
    "the first bill must be the cumulative agent display bill",
  );
});

test("agent stream settlement charges only endpoint wrapper fees over direct model provider evidence", {
  skip: !process.env.REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT || !process.env.REDIS_KEYS_DEFAULT_PASSWORD,
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
  process.env.COMPOSE_SESSION_SECRET ||= "test-compose-session-secret";
  process.env.RUNTIME_URL = "https://runtime.compose.market";

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, `https://runtime.compose.market/internal/workflow/agent/${walletAddress}/stream`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-run-id"), rootRunId);
    assert.equal(headers.has("payment-signature"), false);

    return new Response([
      "event: done\n",
      "data: ",
      JSON.stringify({
        type: "done",
        runId: executionRunId,
        composeRunId: executionRunId,
        rootComposeRunId: rootRunId,
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
  registerWorkflowRoutes(server);
  const listener = server.listen(0);
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: 1_000_000,
      expiresAt: Date.now() + 10 * 60 * 1000,
      purpose: "api",
      chainId: 43113,
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
      composeFeeWei: "10",
      finalAmountWei: "1010",
      txHash: "0xmodel",
      chainId: 43113,
      settledAt: Date.now(),
    });
    await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId: `child-${randomUUID()}`,
      parentExecutionRunId: executionRunId,
      service: "inference",
      action: "v1-responses",
      subject: "model:child-agent-brain",
      providerAmountWei: "900000",
      composeFeeWei: "9000",
      finalAmountWei: "909000",
      txHash: "0xchildmodel",
      chainId: 43113,
      settledAt: Date.now(),
    });

    const response = await NATIVE_FETCH(`http://127.0.0.1:${port}/agent/${walletAddress}/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        "x-chain-id": "43113",
        "x-run-id": rootRunId,
      },
      body: JSON.stringify({
        message: "hi",
        composeRunId: executionRunId,
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
      settlementStatus?: string;
      txHash?: string;
    };

    assert.equal(receipt.service, "agent");
    assert.equal(receipt.action, "agent-stream");
    assert.equal(receipt.providerAmountWei, "1000");
    assert.equal(receipt.platformFeeWei, "10");
    assert.equal(receipt.finalAmountWei, "20");
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
      await redisDel(composeKeyRecordKey(keyId));
      await redisSRem(userKeysKey(userAddress), keyId);
    }
    await closeRedis();
  }
});

test("agent stream settlement does not fold direct model evidence into the wrapper payment", {
  skip: !process.env.REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT || !process.env.REDIS_KEYS_DEFAULT_PASSWORD,
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
  process.env.COMPOSE_SESSION_SECRET ||= "test-compose-session-secret";
  process.env.RUNTIME_URL = "https://runtime.compose.market";

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, `https://runtime.compose.market/internal/workflow/agent/${walletAddress}/stream`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-run-id"), rootRunId);
    assert.equal(headers.has("payment-signature"), false);

    return new Response([
      "event: done\n",
      "data: ",
      JSON.stringify({
        type: "done",
        runId: executionRunId,
        composeRunId: executionRunId,
        rootComposeRunId: rootRunId,
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
  registerWorkflowRoutes(server);
  const listener = server.listen(0);
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: 1_000_000,
      expiresAt: Date.now() + 10 * 60 * 1000,
      purpose: "api",
      chainId: 43113,
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
      composeFeeWei: "10",
      finalAmountWei: "1010",
      chainId: 43113,
      settledAt: Date.now(),
    });

    const response = await NATIVE_FETCH(`http://127.0.0.1:${port}/agent/${walletAddress}/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        "x-chain-id": "43113",
        "x-run-id": rootRunId,
      },
      body: JSON.stringify({
        message: "hi",
        composeRunId: executionRunId,
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
      settlementStatus?: string;
      txHash?: string;
    };

    assert.equal(receipt.service, "agent");
    assert.equal(receipt.action, "agent-stream");
    assert.equal(receipt.providerAmountWei, "1000");
    assert.equal(receipt.platformFeeWei, "10");
    assert.equal(receipt.finalAmountWei, "20");
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
      await redisDel(composeKeyRecordKey(keyId));
      await redisSRem(userKeysKey(userAddress), keyId);
    }
    await closeRedis();
  }
});
