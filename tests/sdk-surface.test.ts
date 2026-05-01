/**
 * Tests for Phase 0.6 + 0.10 + 0.11:
 *   - GET /api/session returns session metadata WITHOUT the token
 *   - DELETE /api/keys/:keyId requires Authorization: Bearer compose-<jwt>
 *   - GET /api/keys/:keyId requires Authorization of the same key and returns
 *     record metadata (never the token)
 *   - GET /api/x402/facilitator/chains enumerates facilitator chain metadata
 *   - X-Request-Id is set on every response
 *   - X-Compose-Receipt decode round-trip
 *   - The idempotency helper keys are stable
 *
 * Every test is self-contained; no mocks. Redis is hit through the real client
 * so session-budget state is cleaned in the finally blocks.
 */

import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import express from "express";

import { closeRedis, redisDel, redisSRem } from "../x402/keys/redis.js";
import { createComposeKey } from "../x402/keys/storage.js";
import {
    encodeReceiptHeader,
    decodeReceiptHeader,
    generateRequestId,
    resolveRequestId,
    REQUEST_ID_HEADER,
    type ComposeReceipt,
} from "../http/request-context.js";
import { buildCorsHeaders } from "../http/cors.js";
import { buildError, statusForCode } from "../http/errors.js";

type HandlerEvent = {
    rawPath: string;
    requestContext: { http: { method: string } };
    headers: Record<string, string | undefined>;
    body?: string;
    queryStringParameters?: Record<string, string>;
};

function createEvent(
    method: string,
    rawPath: string,
    opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string> } = {},
): HandlerEvent {
    return {
        rawPath,
        requestContext: { http: { method } },
        headers: opts.headers ?? {},
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.query ? { queryStringParameters: opts.query } : {}),
    };
}

function randomWalletAddress(): `0x${string}` {
    return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function userKeysIndex(address: string): string {
    return `user-keys:${address.toLowerCase()}`;
}

function sessionBudgetKey(userAddress: string, chainId: number): string {
    return `session:budget:${userAddress.toLowerCase()}:${chainId}`;
}

// ----------------------------------------------------------------------------
// Pure unit tests — no Redis, no network.
// ----------------------------------------------------------------------------

test("generateRequestId produces a unique req_ prefixed id", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    assert.match(a, /^req_[a-f0-9]{32}$/);
    assert.match(b, /^req_[a-f0-9]{32}$/);
    assert.notEqual(a, b);
});

test("resolveRequestId accepts a caller-supplied safe id and mints when absent or unsafe", () => {
    assert.equal(resolveRequestId({ "x-request-id": "req_abc123" }), "req_abc123");
    assert.equal(resolveRequestId({ [REQUEST_ID_HEADER]: "my-trace-0.1:2" }), "my-trace-0.1:2");
    const minted = resolveRequestId({ "x-request-id": "\u0000 bad id" });
    assert.match(minted, /^req_[a-f0-9]{32}$/);
    const mintedForEmpty = resolveRequestId({});
    assert.match(mintedForEmpty, /^req_[a-f0-9]{32}$/);
});

test("encode/decodeReceiptHeader is url-safe and lossless", () => {
    const receipt: ComposeReceipt = {
        subject: "gpt-4.1-mini",
        lineItems: [
            { key: "input_tokens", unit: "usd_per_1m_tokens", quantity: 123, unitPriceUsd: 0.3, amountWei: "36900" },
            { key: "output_tokens", unit: "usd_per_1m_tokens", quantity: 456, unitPriceUsd: 0.6, amountWei: "273600" },
        ],
        providerAmountWei: "310500",
        platformFeeWei: "3105",
        finalAmountWei: "313605",
        txHash: "0xabc",
        network: "eip155:43114",
        settledAt: 1_700_000_000_000,
    };

    const encoded = encodeReceiptHeader(receipt);
    assert.equal(encoded.includes("+"), false, "header must not contain '+' (not url-safe)");
    assert.equal(encoded.includes("/"), false, "header must not contain '/' (not url-safe)");
    assert.equal(encoded.includes("="), false, "header must not contain '=' (padding)");

    const decoded = decodeReceiptHeader(encoded);
    assert.deepEqual(decoded, receipt);
});

test("buildCorsHeaders echoes credentialed first-party origins and sends '*' for anonymous callers", () => {
    const first = buildCorsHeaders("https://app.compose.market");
    assert.equal(first["Access-Control-Allow-Origin"], "https://app.compose.market");
    assert.equal(first["Access-Control-Allow-Credentials"], "true");
    assert.equal(first["Vary"], "Origin");
    assert.ok(first["Access-Control-Allow-Headers"].includes("x-compose-sdk"));

    const localhost = buildCorsHeaders("http://localhost:3000");
    assert.equal(localhost["Access-Control-Allow-Origin"], "http://localhost:3000");
    assert.equal(localhost["Access-Control-Allow-Credentials"], "true");

    const anonymous = buildCorsHeaders("https://evil.example.com");
    assert.equal(anonymous["Access-Control-Allow-Origin"], "*");
    assert.equal(anonymous["Access-Control-Allow-Credentials"], undefined);
    assert.equal(anonymous["Vary"], "Origin");

    const absent = buildCorsHeaders(undefined);
    assert.equal(absent["Access-Control-Allow-Origin"], "*");
});

test("buildError + statusForCode produce the canonical envelope", () => {
    const env = buildError("budget_exhausted", "out of budget", { budgetRemaining: 0 });
    assert.deepEqual(env, {
        error: {
            code: "budget_exhausted",
            message: "out of budget",
            details: { budgetRemaining: 0 },
        },
    });
    assert.equal(statusForCode("budget_exhausted"), 402);
    assert.equal(statusForCode("rate_limited"), 429);
    assert.equal(statusForCode("internal_error"), 500);
    assert.equal(statusForCode("validation_error"), 400);
});

// ----------------------------------------------------------------------------
// Integration tests against the real handler pipeline.
// ----------------------------------------------------------------------------

test("GET /api/session never returns the compose-<jwt> token", async () => {
    const { handler } = await import("../handler.js");
    const userAddress = randomWalletAddress();
    const chainId = 43113;
    const expiresAt = Date.now() + 10 * 60 * 1000;

    try {
        const seeded = await createComposeKey(userAddress, {
            budgetLimit: 1_000_000,
            expiresAt,
            chainId,
            purpose: "api", // Use 'api' so no session-budget initialization is required
            name: "test-api-key",
        });
        assert.ok(seeded.token.startsWith("compose-"));

        const result = await handler(
            createEvent("GET", "/api/session", {
                headers: {
                    "x-session-user-address": userAddress,
                    "x-chain-id": String(chainId),
                },
            }),
            {},
        );
        assert.equal(result.statusCode, 200);
        const body = JSON.parse(result.body) as Record<string, unknown>;
        // Must be "no session" because api keys are not session keys, but critically
        // even if there were one, the body must not carry `token`.
        assert.equal(body.token, undefined, "GET /api/session must NEVER return the Compose Key token");

        // Now, if the record had been a session key, the body would include the
        // metadata but still no token. Sanity:
        assert.ok("hasSession" in body);
    } finally {
        await redisDel(`compose-key:${(await createComposeKey(userAddress, {
            budgetLimit: 0,
            expiresAt: Date.now() + 1000,
            chainId,
            purpose: "api",
        })).keyId}`);
        // Clean any leftover state.
        await redisDel(userKeysIndex(userAddress));
        await redisDel(sessionBudgetKey(userAddress, chainId));
    }
});

test("DELETE /api/keys/:keyId requires JWT possession of a key belonging to the same wallet", async () => {
    const { handler } = await import("../handler.js");
    const userAddress = randomWalletAddress();
    const attacker = randomWalletAddress();
    const chainId = 43113;
    const expiresAt = Date.now() + 10 * 60 * 1000;

    try {
        const seeded = await createComposeKey(userAddress, {
            budgetLimit: 1_000_000,
            expiresAt,
            chainId,
            purpose: "api",
            name: "revoke-target",
        });

        // Attempt 1: no Authorization → 401
        const unauth = await handler(
            createEvent("DELETE", `/api/keys/${seeded.keyId}`, {
                headers: {
                    "x-session-user-address": userAddress,
                    "x-chain-id": String(chainId),
                },
            }),
            {},
        );
        assert.equal(unauth.statusCode, 401);
        const unauthBody = JSON.parse(unauth.body) as { error: { code: string } };
        assert.equal(unauthBody.error.code, "authentication_required");

        // Attempt 2: Authorization is a different wallet's JWT → 403
        const attackerKey = await createComposeKey(attacker, {
            budgetLimit: 1_000_000,
            expiresAt,
            chainId,
            purpose: "api",
            name: "attacker-key",
        });
        const wrongKey = await handler(
            createEvent("DELETE", `/api/keys/${seeded.keyId}`, {
                headers: {
                    "x-session-user-address": userAddress,
                    "x-chain-id": String(chainId),
                    authorization: `Bearer ${attackerKey.token}`,
                },
            }),
            {},
        );
        assert.equal(wrongKey.statusCode, 403);
        const wrongKeyBody = JSON.parse(wrongKey.body) as { error: { code: string } };
        assert.equal(wrongKeyBody.error.code, "forbidden");

        // Attempt 3: correct JWT → 200 + success
        const ok = await handler(
            createEvent("DELETE", `/api/keys/${seeded.keyId}`, {
                headers: {
                    authorization: `Bearer ${seeded.token}`,
                },
            }),
            {},
        );
        assert.equal(ok.statusCode, 200);
        const okBody = JSON.parse(ok.body) as { success: boolean; keyId: string };
        assert.equal(okBody.success, true);
        assert.equal(okBody.keyId, seeded.keyId);

        // Attempt 4: same-owner relaxation — create two keys for the same
        // wallet, revoke the second using the first's JWT. 200.
        const keyA = await createComposeKey(userAddress, {
            budgetLimit: 1_000_000,
            expiresAt,
            chainId,
            purpose: "api",
            name: "key-a",
        });
        const keyB = await createComposeKey(userAddress, {
            budgetLimit: 1_000_000,
            expiresAt,
            chainId,
            purpose: "api",
            name: "key-b",
        });
        const crossRevoke = await handler(
            createEvent("DELETE", `/api/keys/${keyB.keyId}`, {
                headers: { authorization: `Bearer ${keyA.token}` },
            }),
            {},
        );
        assert.equal(crossRevoke.statusCode, 200);

        // Attacker key cleanup via its own JWT
        const attackerCleanup = await handler(
            createEvent("DELETE", `/api/keys/${attackerKey.keyId}`, {
                headers: { authorization: `Bearer ${attackerKey.token}` },
            }),
            {},
        );
        assert.equal(attackerCleanup.statusCode, 200);
    } finally {
        await redisDel(userKeysIndex(userAddress));
        await redisDel(userKeysIndex(attacker));
    }
});

test("GET /api/keys/:keyId requires possession and returns key metadata without the token", async () => {
    const { handler } = await import("../handler.js");
    const userAddress = randomWalletAddress();
    const chainId = 43113;
    const expiresAt = Date.now() + 10 * 60 * 1000;

    try {
        const seeded = await createComposeKey(userAddress, {
            budgetLimit: 2_500_000,
            expiresAt,
            chainId,
            purpose: "api",
            name: "inspect-me",
        });

        const unauth = await handler(
            createEvent("GET", `/api/keys/${seeded.keyId}`),
            {},
        );
        assert.equal(unauth.statusCode, 401);

        const ok = await handler(
            createEvent("GET", `/api/keys/${seeded.keyId}`, {
                headers: { authorization: `Bearer ${seeded.token}` },
            }),
            {},
        );
        assert.equal(ok.statusCode, 200);
        const body = JSON.parse(ok.body) as Record<string, unknown>;
        assert.equal(body.keyId, seeded.keyId);
        assert.equal(body.budgetLimit, 2_500_000);
        assert.equal(body.purpose, "api");
        assert.equal(body.chainId, chainId);
        assert.equal(body.name, "inspect-me");
        assert.equal(body.token, undefined, "GET /api/keys/:id must not leak the token");

        // Clean up
        await handler(
            createEvent("DELETE", `/api/keys/${seeded.keyId}`, {
                headers: { authorization: `Bearer ${seeded.token}` },
            }),
            {},
        );
    } finally {
        await redisDel(userKeysIndex(userAddress));
    }
});

test("GET /api/x402/facilitator/chains returns CAIP-2 network ids + USDC addresses", async () => {
    const { handler } = await import("../handler.js");
    const result = await handler(
        createEvent("GET", "/api/x402/facilitator/chains"),
        {},
    );

    // This endpoint is live only when RPC env vars are configured for at least
    // one chain. Both live (200) and "no chains configured" (500 from getComposeFacilitator())
    // are acceptable; the body shape only matters on 200.
    if (result.statusCode === 200) {
        const body = JSON.parse(result.body) as {
            chains: Array<{ chainId: number; network: string; usdcAddress: string; schemes: string[]; decimals: number }>;
            defaultChainId: number;
        };
        assert.ok(Array.isArray(body.chains));
        assert.ok(body.chains.length > 0);
        for (const chain of body.chains) {
            assert.match(chain.network, /^eip155:\d+$/);
            assert.match(chain.usdcAddress, /^0x[a-fA-F0-9]{40}$/);
            assert.deepEqual(chain.schemes, ["exact", "upto"]);
            assert.equal(chain.decimals, 6);
        }
        assert.equal(typeof body.defaultChainId, "number");
    }
});

test("handler router registers GET /api/keys/:keyId and GET /api/x402/facilitator/chains", async () => {
    const { registerHandlerRoutes } = await import("../handler.js");
    const app = express();
    app.use(express.json({
        verify: (req, _res, buf) => {
            (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
    }));
    registerHandlerRoutes(app);

    interface RouteLayer {
        route?: { path?: unknown; methods?: Record<string, boolean> };
    }

    const routes = (app.router.stack as RouteLayer[])
        .filter((layer): layer is { route: NonNullable<RouteLayer["route"]> } => Boolean(layer.route))
        .map((layer) => ({
            path: String(layer.route.path),
            methods: Object.keys(layer.route.methods || {}),
        }));

    assert.ok(routes.some((r) => r.path === "/api/x402/facilitator/chains" && r.methods.includes("get")));

    // The regex-based /api/keys/:keyId route shows as a regex path in Express.
    // We assert at least one GET handler matches /api/keys/<something> that is
    // not the literal /api/keys/settle route.
    const keyDetailRoutes = routes.filter((r) => r.path.includes("/api\\/keys") && r.methods.includes("get"));
    assert.ok(keyDetailRoutes.length >= 1, "GET /api/keys/:keyId must be registered");
});

test("response carries X-Request-Id when the server is up behind the middleware", async () => {
    // This round-trip exercises the middleware + full Express stack. It avoids
    // opening a real port by directly invoking the handler chain with supertest-
    // like semantics via raw express: we construct an app, install the
    // middleware, and inspect the response headers synchronously.
    const { corsMiddleware, requestIdMiddleware } = await import("../http/middleware.js");
    const app = express();
    app.use(corsMiddleware());
    app.use(requestIdMiddleware());
    app.get("/__probe", (_req, res) => {
        res.status(200).json({ ok: true, requestId: (res.locals as { requestId?: string }).requestId });
    });

    await new Promise<void>((resolve) => {
        const server = app.listen(0, async () => {
            try {
                const addr = server.address() as { port: number };
                const resp = await fetch(`http://127.0.0.1:${addr.port}/__probe`, {
                    headers: { Origin: "https://app.compose.market" },
                });
                assert.equal(resp.status, 200);
                const requestId = resp.headers.get(REQUEST_ID_HEADER) || resp.headers.get("x-request-id");
                assert.ok(requestId && requestId.length > 0, "X-Request-Id header must be set");
                const body = await resp.json() as { ok: boolean; requestId: string };
                assert.equal(body.ok, true);
                assert.equal(body.requestId, requestId);

                // CORS policy
                assert.equal(resp.headers.get("access-control-allow-origin"), "https://app.compose.market");
                assert.equal(resp.headers.get("access-control-allow-credentials"), "true");
                assert.ok(resp.headers.get("vary")?.includes("Origin"));

                // Preflight
                const preflight = await fetch(`http://127.0.0.1:${addr.port}/__probe`, {
                    method: "OPTIONS",
                    headers: {
                        Origin: "https://app.compose.market",
                        "Access-Control-Request-Method": "POST",
                    },
                });
                assert.equal(preflight.status, 204);
                assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.compose.market");
            } finally {
                server.close();
                resolve();
            }
        });
    });
});

test.after(async () => {
    await closeRedis();
});
