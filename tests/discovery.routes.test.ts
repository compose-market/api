import "dotenv/config";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validatePaymentRequired } from "@x402/core/schemas";
import express from "express";
import { isServiceAllowedNetwork, type NetworkId } from "../x402/configs/chains.js";

const ORIGINAL_ENV = {
  FACILITATOR_KEY: process.env.FACILITATOR_KEY,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  AVALANCHE_MAINNET_RPC: process.env.AVALANCHE_MAINNET_RPC,
  SOLANA_MAINNET_RPC: process.env.SOLANA_MAINNET_RPC,
};

function restoreEnv(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createEvent(method: string, rawPath: string, body?: unknown, queryStringParameters?: Record<string, string>) {
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(queryStringParameters ? { queryStringParameters } : {}),
  };
}

function createHostedEvent(method: string, rawPath: string, host: string, body?: unknown) {
  return {
    ...createEvent(method, rawPath, body),
    headers: { host },
  };
}

function decodeRequiredFromResult(result: { headers?: Record<string, string>; body: string }) {
  const header = result.headers?.["PAYMENT-REQUIRED"] ?? result.headers?.["payment-required"];
  assert.equal(typeof header, "string");
  const decoded = decodePaymentRequiredHeader(header!);
  validatePaymentRequired(decoded);
  assert.deepEqual(decoded, JSON.parse(result.body));
  return decoded;
}

function schemesByNetwork(body: { accepts: Array<{ scheme: string; network: string }> }): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const accept of body.accepts) {
    const schemes = map.get(accept.network) ?? [];
    schemes.push(accept.scheme);
    map.set(accept.network, schemes);
  }
  return map;
}

async function withFullApp<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const { registerInferenceRoutes } = await import("../inference/gateway.js");
  const { registerHandlerRoutes } = await import("../handler.js");
  const app = express();
  app.use(express.json());
  registerInferenceRoutes(app);
  registerHandlerRoutes(app);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

before(() => {
  process.env.FACILITATOR_KEY = ORIGINAL_ENV.FACILITATOR_KEY || `0x${"11".repeat(32)}`;
  process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  delete process.env.SOLANA_MAINNET_RPC;
});

after(() => {
  restoreEnv("FACILITATOR_KEY");
  restoreEnv("MERCHANT_WALLET_ADDRESS");
  restoreEnv("AVALANCHE_MAINNET_RPC");
  restoreEnv("SOLANA_MAINNET_RPC");
});

test("handler serves OpenAPI for universal facilitator and model seller only", async () => {
  const { handler } = await import("../handler.js");

  const result = await handler(createEvent("GET", "/openapi.json"), {});
  assert.equal(result.statusCode, 200);

  const body = JSON.parse(result.body) as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
    components?: { securitySchemes?: Record<string, unknown>; parameters?: Record<string, unknown> };
  };

  assert.equal(body.openapi, "3.1.0");
  assert.ok(body.paths["/models"]?.post);
  assert.ok(body.paths["/models/list"]?.get);
  assert.ok(body.paths["/api/x402/facilitator/supported"]?.get);
  assert.equal(body.paths["/agents"], undefined);
  assert.equal(body.paths["/agents/list"], undefined);
  assert.equal(body.paths["/v1/responses/{modelId}"], undefined);
  assert.equal(body.paths["/agent/{walletAddress}/stream"], undefined);
  assert.equal(body.paths["/networks/"], undefined);
  assert.equal((body.paths["/models/list"].get as { security?: unknown[] }).security?.length, 0);
  const paidOps = Object.entries(body.paths)
    .flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method, operation })))
    .filter(({ operation }) => Boolean((operation as { "x-payment-info"?: unknown })["x-payment-info"]))
    .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
    .sort();
  assert.deepEqual(paidOps, ["POST /models"]);
  assert.deepEqual(body.components?.securitySchemes ?? {}, {});
  assert.equal((body.components?.parameters?.NetworkIdHeaderOptional as { name?: string; in?: string })?.name, "x-network-id");
  assert.equal((body.components?.parameters?.NetworkIdHeaderOptional as { name?: string; in?: string })?.in, "header");
});

test("well-known x402 advertises only the models paid entrypoint on api", async () => {
  const { handler } = await import("../handler.js");

  const result = await handler(createEvent("GET", "/.well-known/x402"), {});
  assert.equal(result.statusCode, 200);

  const body = JSON.parse(result.body) as { resources: string[]; ownershipProofs: string[] };
  assert.deepEqual(body.resources, [
    "https://api.compose.market/models",
  ]);
  assert.equal(body.resources.some((resource) => resource.includes("/agents")), false);
  assert.equal(body.resources.some((resource) => resource.includes("/networks/")), false);
  assert.equal(body.resources.some((resource) => resource.includes("/api/x402/facilitator/supported")), false);
  assert.equal(body.resources.some((resource) => resource.includes("/v1/responses")), false);
  assert.equal(body.resources.some((resource) => resource.includes("/agent/")), false);
  assert.ok(body.ownershipProofs.length > 0);
});

test("api.inference.diy discovery and payment resources remain on api.inference.diy", async () => {
  const { handler } = await import("../handler.js");

  const openapi = await handler(createHostedEvent("GET", "/openapi.json", "api.inference.diy"), {});
  assert.equal(openapi.statusCode, 200);
  assert.equal(JSON.parse(openapi.body).servers[0].url, "https://api.inference.diy");

  const wellKnown = await handler(createHostedEvent("GET", "/.well-known/x402", "api.inference.diy"), {});
  assert.deepEqual(JSON.parse(wellKnown.body).resources, [
    "https://api.inference.diy/models",
  ]);

  const catalog = await handler(createHostedEvent("GET", "/models/list", "api.inference.diy"), {});
  assert.equal(JSON.parse(catalog.body).data.every((model: { endpoint: string }) => (
    model.endpoint.startsWith("https://api.inference.diy/v1/responses/")
  )), true);

  const challenge = await handler(createHostedEvent("POST", "/models", "api.inference.diy", {}), {});
  const required = decodeRequiredFromResult(challenge);
  assert.equal(required.resource.url, "https://api.inference.diy/models");
  assert.ok(required.resource.description?.includes("GET https://api.inference.diy/models/list"));
});

test("untrusted hosts and forwarded hosts cannot alter public resource identity", async () => {
  const { handler } = await import("../handler.js");
  const event = {
    ...createHostedEvent("POST", "/models", "attacker.example", {}),
    headers: {
      host: "attacker.example",
      "x-forwarded-host": "api.inference.diy",
    },
  };

  const challenge = await handler(event, {});
  assert.equal(decodeRequiredFromResult(challenge).resource.url, "https://api.compose.market/models");
});

test("/models/ is a paid entrypoint and /models/list is the separate compiled catalog", async () => {
  const { handler } = await import("../handler.js");
  const { getCompiledModels } = await import("../inference/catalog/registry.js");
  const { getFacilitatorSupported } = await import("../x402/facilitator.js");

  const entrypointGet = await handler(createEvent("GET", "/models/", undefined, { limit: "2" }), {});
  assert.notEqual(entrypointGet.statusCode, 200);

  const catalog = await handler(createEvent("GET", "/models/list", undefined, { limit: "2" }), {});
  assert.equal(catalog.statusCode, 200);
  const catalogBody = JSON.parse(catalog.body) as {
    object: string;
    data: Array<{ modelId: string; endpoint: string; method: string }>;
    total: number;
    limit: number;
    offset: number;
    nextCursor: string | null;
  };

  assert.equal(catalogBody.object, "list");
  assert.equal(catalogBody.total, getCompiledModels().models.length);
  assert.equal(catalogBody.limit, 2);
  assert.equal(catalogBody.offset, 0);
  assert.equal(catalogBody.nextCursor, "2");
  assert.equal(catalogBody.data.every((model) => model.method === "POST"), true);
  assert.equal(catalogBody.data.every((model) => model.endpoint.includes("/v1/responses/")), true);

  const challenge = await handler(createEvent("POST", "/models/", {}), {});
  assert.equal(challenge.statusCode, 402);
  const paymentRequired = decodeRequiredFromResult(challenge);
  const description = paymentRequired.resource.description || "";

  assert.ok(description.includes(`${catalogBody.total} currently payable models`));
  assert.ok(description.includes("GET https://api.compose.market/models/list"));
  assert.ok(description.includes("x-network-id"));
  assert.ok(description.includes("PAYMENT-SIGNATURE"));
  assert.ok(description.includes("POST https://api.compose.market/v1/responses/{selectedModelId}"));
  assert.equal(description.includes("GET https://api.compose.market/models/. "), false);
  assert.equal(description.includes("GET https://api.compose.market/networks/"), false);
  assert.ok(paymentRequired.extensions?.bazaar);

  const facilitatorSupported = await getFacilitatorSupported();
  const expectedNetworks = facilitatorSupported.kinds
    .filter((kind) => kind.scheme === "upto" && isServiceAllowedNetwork(kind.network as NetworkId))
    .map((kind) => kind.network)
    .sort();
  const actualNetworks = [...schemesByNetwork(paymentRequired).keys()].sort();
  assert.deepEqual(actualNetworks, expectedNetworks);
  assert.equal(paymentRequired.accepts.every((accept) => accept.scheme === "upto"), true);
  assert.equal(actualNetworks.includes("eip155:84532"), true);
  assert.equal(actualNetworks.includes("eip155:42431"), false);
  assert.equal(actualNetworks.includes("eip155:1328"), false);
  assert.equal(actualNetworks.includes("eip155:43113"), false);

  const apiCatalog = await handler(createEvent("GET", "/models/list", undefined, { limit: "2", cursor: "2" }), {});
  assert.equal(apiCatalog.statusCode, 200);
  const apiCatalogBody = JSON.parse(apiCatalog.body) as { total: number; offset: number; nextCursor: string | null };
  assert.equal(apiCatalogBody.total, getCompiledModels().models.length);
  assert.equal(apiCatalogBody.offset, 2);
  assert.equal(apiCatalogBody.nextCursor, "4");

  const signedWithoutNetwork = await handler({
    ...createEvent("POST", "/models/", {}),
    headers: { "payment-signature": "signed" },
  }, {});
  assert.equal(signedWithoutNetwork.statusCode, 400);
});

test("/agents/ is a paid entrypoint and /agents/list is the separate public catalog route", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://agents.test") {
      return NATIVE_FETCH(input, init);
    }
    assert.equal(url.origin, "https://agents.test");
    assert.equal(url.pathname, "/agents");
    return new Response(JSON.stringify({
      agents: [
        {
          schemaVersion: "1.0.0",
          walletAddress: "0x1111111111111111111111111111111111111111",
          name: "alpha",
          description: "alpha agent",
        },
      ],
      total: 1,
      count: 1,
      hasMore: false,
      nextCursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const { handler } = await import("../handler.js");
  const { getFacilitatorSupported } = await import("../x402/facilitator.js");

  const entrypointGet = await handler(createEvent("GET", "/agents/", undefined, { limit: "1" }), {});
  assert.notEqual(entrypointGet.statusCode, 200);

  const catalog = await handler(createEvent("GET", "/agents/list", undefined, { limit: "1" }), {});
  assert.equal(catalog.statusCode, 200);
  const catalogBody = JSON.parse(catalog.body) as {
    agents: Array<{ walletAddress: string; endpoint: string; method: string }>;
    total: number;
  };
  assert.equal(catalogBody.total, 1);
  assert.equal(catalogBody.agents[0]?.endpoint, "https://api.compose.market/agent/0x1111111111111111111111111111111111111111/stream");
  assert.equal(catalogBody.agents[0]?.method, "POST");

  const challenge = await handler(createEvent("POST", "/agents/", {}), {});
  assert.equal(challenge.statusCode, 402);
  const paymentRequired = decodeRequiredFromResult(challenge);
  const description = paymentRequired.resource.description || "";

  assert.ok(description.includes("1 currently payable agent streams"));
  assert.ok(description.includes("GET https://api.compose.market/agents/list"));
  assert.ok(description.includes("x-network-id"));
  assert.ok(description.includes("PAYMENT-SIGNATURE"));
  assert.ok(description.includes("POST https://api.compose.market/agent/{selectedAgentWallet}/stream"));
  assert.equal(description.includes("GET https://api.compose.market/agents/. "), false);
  assert.equal(description.includes("GET https://api.compose.market/networks/"), false);
  assert.ok(paymentRequired.extensions?.bazaar);

  const expectedNetworks = (await getFacilitatorSupported()).kinds
    .filter((kind) => kind.scheme === "batch-settlement")
    .map((kind) => kind.network)
    .sort();
  const actualNetworks = [...schemesByNetwork(paymentRequired).keys()].sort();
  assert.deepEqual(actualNetworks, expectedNetworks);
  assert.equal(paymentRequired.accepts.every((accept) => accept.scheme === "batch-settlement"), true);

  const networks = await handler(createEvent("GET", "/networks/"), {});
  assert.notEqual(networks.statusCode, 200);

  const signedWithoutNetwork = await handler({
    ...createEvent("POST", "/agents/", {}),
    headers: { "payment-signature": "signed" },
  }, {});
  assert.equal(signedWithoutNetwork.statusCode, 400);
});

test("concrete model and agent stream endpoints return Bazaar-enriched 402 to unpaid probes", async () => {
  await withFullApp(async (baseUrl) => {
    const model = await fetch(`${baseUrl}/v1/responses/gpt-4o`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(model.status, 402);
    const modelHeader = model.headers.get("payment-required");
    assert.equal(typeof modelHeader, "string");
    const modelPaymentRequired = decodePaymentRequiredHeader(modelHeader!);
    validatePaymentRequired(modelPaymentRequired);
    assert.ok(modelPaymentRequired.extensions?.bazaar);
    assert.equal(modelPaymentRequired.accepts.every((accept) => accept.scheme === "upto"), true);

    const agent = await fetch(`${baseUrl}/agent/0x1111111111111111111111111111111111111111/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(agent.status, 402);
    const agentHeader = agent.headers.get("payment-required");
    assert.equal(typeof agentHeader, "string");
    const agentPaymentRequired = decodePaymentRequiredHeader(agentHeader!);
    validatePaymentRequired(agentPaymentRequired);
    assert.ok(agentPaymentRequired.extensions?.bazaar);
    assert.equal(agentPaymentRequired.accepts.every((accept) => accept.scheme === "batch-settlement"), true);
  });
});

test("agent stream discovery challenge honors the client x-x402-max-amount-wei", async () => {
  await withFullApp(async (baseUrl) => {
    const challenged = await fetch(`${baseUrl}/agent/0x1111111111111111111111111111111111111111/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-x402-max-amount-wei": "10000000",
      },
      body: "{}",
    });
    assert.equal(challenged.status, 402);
    const header = challenged.headers.get("payment-required");
    assert.equal(typeof header, "string");
    const paymentRequired = decodePaymentRequiredHeader(header!);
    validatePaymentRequired(paymentRequired);
    assert.ok(paymentRequired.accepts.length > 0);
    assert.equal(
      paymentRequired.accepts.every((accept) => accept.amount === "10000000"),
      true,
    );
  });
});

test("agent stream nested execution skips the direct discovery challenge", async () => {
  const { maybeSendAgentStreamDiscoveryChallenge } = await import("../x402/discovery.js");

  const buildReq = (headers: Record<string, string>) => ({
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    params: { walletAddress: "0x1111111111111111111111111111111111111111" },
  }) as unknown as import("express").Request;

  const buildRes = () => {
    const sent: { status?: number } = {};
    const res = {
      status(code: number) { sent.status = code; return res; },
      json() { return res; },
      setHeader() { return res; },
    };
    return { res: res as unknown as import("express").Response, sent };
  };

  // A runtime-forwarded child call under a paid root run carries its own
  // execution run id and a parent execution run id, with no Compose Key and no
  // fresh PAYMENT-SIGNATURE. It must not be treated as a blind dial: no
  // discovery challenge, so prepareInferencePayment can resolve the inherited
  // x402 envelope (mirrors the models_call nested path).
  const nested = buildReq({
    "x-run-id": "root-run-1",
    "x-execution-run-id": "child-exec-run-1",
    "x-parent-run-id": "parent-exec-run-1",
  });
  const nestedOut = buildRes();
  assert.equal(await maybeSendAgentStreamDiscoveryChallenge(nested, nestedOut.res), false);
  assert.equal(nestedOut.sent.status, undefined);

  // Parent execution run id alone also marks a nested execution.
  const parentOnly = buildReq({
    "x-run-id": "root-run-2",
    "x-parent-run-id": "parent-exec-run-2",
  });
  const parentOnlyOut = buildRes();
  assert.equal(await maybeSendAgentStreamDiscoveryChallenge(parentOnly, parentOnlyOut.res), false);
  assert.equal(parentOnlyOut.sent.status, undefined);
});
