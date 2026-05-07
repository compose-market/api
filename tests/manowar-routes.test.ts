import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";

import {
  handlePublicRoute,
  buildRuntimeInternalUrl,
  buildRuntimeHeaders,
  buildRuntimeSessionHeaders,
  registerWorkflowRoutes,
} from "../routes.js";

const ORIGINAL_RUNTIME_URL = process.env.RUNTIME_URL;
const ORIGINAL_RUNTIME_INTERNAL_SECRET = process.env.RUNTIME_INTERNAL_SECRET;
const ORIGINAL_PINATA_GATEWAY_URL = process.env.PINATA_GATEWAY_URL;
const ORIGINAL_IPFS_PINATA_GATEWAY = process.env.IPFS_PINATA_GATEWAY;
const ORIGINAL_PINATA_GATEWAY = process.env.PINATA_GATEWAY;
const ORIGINAL_PINATA_JWT = process.env.PINATA_JWT;
const ORIGINAL_DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const ORIGINAL_MERCHANT_WALLET_ADDRESS = process.env.MERCHANT_WALLET_ADDRESS;
const ORIGINAL_THIRDWEB_SERVER_WALLET_ADDRESS = process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
const ORIGINAL_AVALANCHE_MAINNET_RPC = process.env.AVALANCHE_MAINNET_RPC;
const NATIVE_FETCH = globalThis.fetch;

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

test("registerWorkflowRoutes registers the explicit public workflow surface", () => {
  const app = express();
  registerWorkflowRoutes(app);
  const routeSet = new Set(listRegisteredRoutes(app).map((route) => `${route.methods[0]} ${route.path}`));

  assert.equal(routeSet.has("post /agent/register"), false);
  assert.equal(routeSet.has("post /workflow/register"), false);
  assert.equal(routeSet.has("post /agent/:walletAddress/chat"), true);
  assert.equal(routeSet.has("post /agent/:walletAddress/responses"), true);
  assert.equal(routeSet.has("post /agent/:walletAddress/multimodal"), false);
  assert.equal(routeSet.has("post /workflow/:walletAddress/chat"), true);
  assert.equal(routeSet.has("post /workflow/execute"), true);
  assert.equal(routeSet.has("get /api/memory/:agentWallet"), true);
  assert.equal(routeSet.has("get /frameworks"), true);
  assert.equal(routeSet.has("get /v1/models"), false);
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
  process.env.RUNTIME_INTERNAL_SECRET = "shared-runtime-secret";

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
  assert.equal(headers.get("x-runtime-internal-token"), "shared-runtime-secret");

  process.env.RUNTIME_INTERNAL_SECRET = ORIGINAL_RUNTIME_INTERNAL_SECRET;
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

test("knowledge passthrough uses RUNTIME_URL and shared internal secret", async () => {
  process.env.RUNTIME_URL = "https://runtime.compose.market/";
  process.env.RUNTIME_INTERNAL_SECRET = "shared-runtime-secret";
  delete process.env.RUNTIME_SERVICE_URL;
  delete process.env.RUNTIME_INTERNAL_TOKEN;

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
    const response = await NATIVE_FETCH(
      `http://127.0.0.1:${port}/agent/0xba04fa4baacbac0d93bb73a7fd473a41aa7f2815/knowledge`,
    );

    assert.equal(response.status, 200);
    const capturedCall = runtimeCalls[0];
    if (!capturedCall) {
      throw new Error("Expected runtime passthrough to be invoked");
    }
    assert.equal(capturedCall.url, "https://runtime.compose.market/internal/workflow/agent/0xba04fa4baacbac0d93bb73a7fd473a41aa7f2815/knowledge");
    assert.equal(
      new Headers(capturedCall.init?.headers).get("x-runtime-internal-token"),
      "shared-runtime-secret",
    );
  } finally {
    server.close();
    globalThis.fetch = NATIVE_FETCH;
    process.env.RUNTIME_URL = ORIGINAL_RUNTIME_URL;
    process.env.RUNTIME_INTERNAL_SECRET = ORIGINAL_RUNTIME_INTERNAL_SECRET;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// x402 contract: agent + workflow routes MUST emit 402 PAYMENT-REQUIRED
// (scheme: "upto") when the caller omits the Authorization header. The route
// is usage-priced — the cap comes from the `x-x402-max-amount-wei` header,
// settlement debits the actual metered amount from the SSE body.
// Regression guard for the previous 401 "Compose key authorization is required"
// response that locked the route to Compose-Key consumers only.
// ─────────────────────────────────────────────────────────────────────────────
test("agent + workflow routes emit 402 PAYMENT-REQUIRED with scheme=upto when no Authorization is present", async () => {
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
    const endpoints: Array<{ method: "POST"; path: string }> = [
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/chat" },
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/stream" },
      { method: "POST", path: "/agent/0x0000000000000000000000000000000000000001/responses" },
      { method: "POST", path: "/workflow/0x0000000000000000000000000000000000000001/chat" },
      { method: "POST", path: "/workflow/execute" },
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
      assert.equal(accepts[0].scheme, "upto", `${ep.path} must challenge with scheme=upto`);
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
