import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import express from "express";
import {
  closeRedis,
  redisDel,
} from "../x402/keys/redis.js";
import {
  selectActiveSessionStatus,
  type ActiveSessionCandidate,
} from "../x402/keys/storage.js";

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

async function createHandlerApp(): Promise<express.Application> {
  const { registerHandlerRoutes } = await import("../handler.js");
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  registerHandlerRoutes(app);
  return app;
}

function createEvent(method: string, rawPath: string, body?: unknown) {
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

function randomWalletAddress(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function sessionBudgetKey(userAddress: string, chainId: number): string {
  return `session:budget:${userAddress.toLowerCase()}:${chainId}`;
}

test("registerHandlerRoutes registers /health directly", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(routes.some((route) => route.path === "/health" && route.methods.includes("get")), true);
});

test("registerHandlerRoutes registers POST /api/payments/meter/model directly", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(
    routes.some((route) => route.path === "/api/payments/meter/model" && route.methods.includes("post")),
    true,
  );
});

test("registerHandlerRoutes registers compose facilitator endpoints directly", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(
    routes.some((route) => route.path === "/api/x402/facilitator/supported" && route.methods.includes("get")),
    true,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/x402/facilitator/verify" && route.methods.includes("post")),
    true,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/x402/facilitator/settle" && route.methods.includes("post")),
    true,
  );
});

test("registerHandlerRoutes does not register wallet auth endpoints directly", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(
    routes.some((route) => route.path === "/api/auth/wallet/challenge" && route.methods.includes("post")),
    false,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/auth/wallet/verify" && route.methods.includes("post")),
    false,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/auth/wallet" && route.methods.includes("get")),
    false,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/auth/wallet" && route.methods.includes("delete")),
    false,
  );
});

test("registerHandlerRoutes exposes distinct local Synapse and Filecoin Pin session routes", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(
    routes.some((route) => route.path === "/api/local/synapse/session" && route.methods.includes("post")),
    true,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/local/filecoin-pin/session" && route.methods.includes("post")),
    true,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/local/paymaster/session"),
    false,
  );
});

test("registerHandlerRoutes no longer exposes legacy account abstraction routes", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(
    routes.some((route) => route.path === "/api/aa/prepare" || route.path === "/api/aa/submit"),
    false,
  );
  assert.equal(
    routes.some((route) => route.path === "/api/aa/register-cronos"),
    false,
  );
});

test("registerHandlerRoutes does not own /v1/models", async () => {
  const app = await createHandlerApp();
  const routes = listRegisteredRoutes(app);

  assert.equal(routes.some((route) => route.path === "/v1/models"), false);
});

test("handler serves /health and validates meter payloads", async () => {
  const { handler } = await import("../handler.js");

  const healthResult = await handler(createEvent("GET", "/health"), {});
  assert.equal(healthResult.statusCode, 200);

  const healthBody = JSON.parse(healthResult.body) as { status: string; timestamp: string };
  assert.equal(healthBody.status, "ok");
  assert.ok(healthBody.timestamp);

  const meterResult = await handler(createEvent("POST", "/api/payments/meter/model", {}), {});
  assert.equal(meterResult.statusCode, 400);

  const meterBody = JSON.parse(meterResult.body) as { error: string };
  assert.equal(meterBody.error, "modelId is required");
});

test("handler serves compose facilitator supported response without cronos or v1", async () => {
  const { handler } = await import("../handler.js");

  const result = await handler(createEvent("GET", "/api/x402/facilitator/supported"), {});
  assert.equal(result.statusCode, 200);

  const body = JSON.parse(result.body) as {
    kinds: Array<{ x402Version: number; network: string; scheme: string }>;
    extensions: string[];
  };

  assert.ok(Array.isArray(body.kinds));
  assert.ok(body.kinds.length > 0);
  assert.equal(body.kinds.every((kind) => kind.x402Version === 2), true);
  assert.equal(body.kinds.some((kind) => kind.network.includes("cronos")), false);
  assert.equal(body.kinds.some((kind) => kind.scheme === "exact"), true);
  assert.equal(body.kinds.some((kind) => kind.scheme === "upto"), true);
  assert.deepEqual(
    body.extensions,
    ["compose-metering-v1", "compose-payment-intent-v1"],
  );
});

test("handler persists Backpack cloud permissions via dedicated permission routes", async () => {
  const { handler } = await import("../handler.js");
  const userAddress = "0x1111111111111111111111111111111111111111";

  const grantResult = await handler(
    createEvent("POST", "/api/backpack/permissions/grant", {
      userAddress,
      consentType: "camera",
    }),
    {},
  );
  assert.equal(grantResult.statusCode, 200);

  const listAfterGrant = await handler({
    rawPath: "/api/backpack/permissions",
    requestContext: { http: { method: "GET" } },
    headers: {},
    queryStringParameters: {
      userAddress,
    },
  }, {});
  assert.equal(listAfterGrant.statusCode, 200);
  const grantedBody = JSON.parse(listAfterGrant.body) as {
    permissions: Array<{ consentType: string; granted: boolean }>;
  };
  assert.equal(
    grantedBody.permissions.some((permission) => permission.consentType === "camera" && permission.granted),
    true,
  );

  const revokeResult = await handler(
    createEvent("POST", "/api/backpack/permissions/revoke", {
      userAddress,
      consentType: "camera",
    }),
    {},
  );
  assert.equal(revokeResult.statusCode, 200);

  const listAfterRevoke = await handler({
    rawPath: "/api/backpack/permissions",
    requestContext: { http: { method: "GET" } },
    headers: {},
    queryStringParameters: {
      userAddress,
    },
  }, {});
  assert.equal(listAfterRevoke.statusCode, 200);
  const revokedBody = JSON.parse(listAfterRevoke.body) as {
    permissions: Array<{ consentType: string; granted: boolean }>;
  };
  assert.equal(
    revokedBody.permissions.some((permission) => permission.consentType === "camera" && permission.granted),
    false,
  );
});

test("handler rejects session creation when the tied wallet lacks the required USDC funding", async () => {
  const { handler } = await import("../handler.js");

  const userAddress = randomWalletAddress();
  const chainId = 43113;
  const expiresAt = Date.now() + 10 * 60 * 1000;

  try {
    const createResult = await handler({
      rawPath: "/api/keys",
      requestContext: { http: { method: "POST" } },
      headers: {
        "x-session-user-address": userAddress,
        "x-chain-id": String(chainId),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        budgetLimit: 25_000_000,
        expiresAt,
        chainId,
        purpose: "session",
        name: "SDK Session",
      }),
    }, {});

    assert.equal(createResult.statusCode, 402);
    const createdBody = JSON.parse(createResult.body) as {
      error: string;
      hint?: string;
      details?: {
        requiredWei?: string;
        balanceWei?: string;
        allowanceWei?: string;
      };
    };
    assert.equal(createdBody.error, "Insufficient USDC balance for requested session budget");
    assert.equal(createdBody.details?.requiredWei, "25000000");
    assert.equal(createdBody.details?.balanceWei, "0");
    assert.equal(createdBody.details?.allowanceWei, "0");

    const sessionResult = await handler({
      rawPath: "/api/session",
      requestContext: { http: { method: "GET" } },
      headers: {
        "x-session-user-address": userAddress,
        "x-chain-id": String(chainId),
      },
    }, {});

    assert.equal(sessionResult.statusCode, 200);
    const sessionBody = JSON.parse(sessionResult.body) as {
      hasSession: boolean;
      reason: string;
    };
    assert.equal(sessionBody.hasSession, false);
    assert.equal(sessionBody.reason, "none");
  } finally {
    await redisDel(sessionBudgetKey(userAddress, chainId));
    await closeRedis();
  }
});

test("handler rejects malformed header wallet identity when creating a key", async () => {
  const { handler } = await import("../handler.js");

  const chainId = 43113;
  const expiresAt = Date.now() + 10 * 60 * 1000;

  await assert.rejects(
    handler({
      rawPath: "/api/keys",
      requestContext: { http: { method: "POST" } },
      headers: {
        "x-session-user-address": "not-a-wallet",
        "x-chain-id": String(chainId),
      },
      body: JSON.stringify({
        budgetLimit: 25_000_000,
        expiresAt,
        chainId,
        purpose: "session",
        name: "Allowance-Free Session",
      }),
    }, {}),
    /x-session-user-address header required/i,
  );
});

test("handler rejects api key creation when the tied wallet lacks the required USDC funding", async () => {
  const { handler } = await import("../handler.js");

  const userAddress = randomWalletAddress();
  const chainId = 43113;
  const expiresAt = Date.now() + 10 * 60 * 1000;

  try {
    const createResult = await handler({
      rawPath: "/api/keys",
      requestContext: { http: { method: "POST" } },
      headers: {
        "x-session-user-address": userAddress,
        "x-chain-id": String(chainId),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        budgetLimit: 5_000_000,
        expiresAt,
        chainId,
        purpose: "api",
        name: "Cursor",
      }),
    }, {});

    assert.equal(createResult.statusCode, 402);

    const createdBody = JSON.parse(createResult.body) as {
      error: string;
      hint?: string;
      details?: {
        requiredWei?: string;
        balanceWei?: string;
        allowanceWei?: string;
      };
    };

    assert.equal(createdBody.error, "Insufficient USDC balance for requested Compose key budget");
    assert.equal(createdBody.details?.requiredWei, "5000000");
    assert.equal(createdBody.details?.balanceWei, "0");
    assert.equal(createdBody.details?.allowanceWei, "0");

    const sessionResult = await handler({
      rawPath: "/api/session",
      requestContext: { http: { method: "GET" } },
      headers: {
        "x-session-user-address": userAddress,
        "x-chain-id": String(chainId),
      },
    }, {});

    assert.equal(sessionResult.statusCode, 200);
    const sessionBody = JSON.parse(sessionResult.body) as {
      hasSession: boolean;
      reason?: string;
    };
    assert.equal(sessionBody.hasSession, false);
    assert.equal(sessionBody.reason, "none");
  } finally {
    await closeRedis();
  }
});

test("selectActiveSessionStatus ignores API keys and uses reserved budget from session keys", () => {
  const now = 1_700_000_000_000;
  const candidates: ActiveSessionCandidate[] = [
    {
      keyId: "api-key",
      purpose: "api",
      token: "compose-api",
      budgetLimit: 5_000_000,
      budgetUsed: 0,
      budgetLocked: 0,
      budgetRemaining: 5_000_000,
      expiresAt: now + 60_000,
      createdAt: now + 10_000,
      chainId: 8453,
      name: "Cursor",
    },
    {
      keyId: "session-key",
      purpose: "session",
      token: "compose-session",
      budgetLimit: 10_000_000,
      budgetUsed: 2_000_000,
      budgetLocked: 1_000_000,
      budgetRemaining: 7_000_000,
      expiresAt: now + 60_000,
      createdAt: now,
      chainId: 8453,
      name: "Browser Session",
    },
  ];

  const status = selectActiveSessionStatus(candidates, 8453, now);

  assert.equal(status.reason, "none");
  assert.deepEqual(status.session, {
    keyId: "session-key",
    token: "compose-session",
    budgetLimit: 10_000_000,
    budgetUsed: 2_000_000,
    budgetLocked: 1_000_000,
    budgetRemaining: 7_000_000,
    expiresAt: now + 60_000,
    chainId: 8453,
    name: "Browser Session",
  });
});

test("selectActiveSessionStatus keeps a live session active while its remaining budget is fully reserved in-flight", () => {
  const now = 1_700_000_000_000;
  const candidates: ActiveSessionCandidate[] = [
    {
      keyId: "session-key",
      purpose: "session",
      token: "compose-session",
      budgetLimit: 10_000_000,
      budgetUsed: 2_000_000,
      budgetLocked: 8_000_000,
      budgetRemaining: 0,
      expiresAt: now + 60_000,
      createdAt: now,
      chainId: 8453,
      name: "Browser Session",
    },
  ];

  const status = selectActiveSessionStatus(candidates, 8453, now);

  assert.equal(status.reason, "none");
  assert.deepEqual(status.session, {
    keyId: "session-key",
    token: "compose-session",
    budgetLimit: 10_000_000,
    budgetUsed: 2_000_000,
    budgetLocked: 8_000_000,
    budgetRemaining: 0,
    expiresAt: now + 60_000,
    chainId: 8453,
    name: "Browser Session",
  });
});
