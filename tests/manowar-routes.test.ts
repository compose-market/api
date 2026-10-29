import "dotenv/config";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { handler, registerHandlerRoutes } from "../handler.js";
import { registerUtilityRoutes } from "../routes.js";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function withServer<T>(
  app: express.Application,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
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

test("api routes and discovery contain zero runtime or agent-run coupling", () => {
  const routesSource = source("routes.ts");
  const handlerSource = source("handler.ts");
  const discoverySource = source("x402/discovery.ts");

  assert.doesNotMatch(
    routesSource,
    /RUNTIME_URL|callRuntime|\/internal\/manowar|payableStreamRoute|payableJsonRoute|passthroughJsonRoute|passthroughStreamRoute|agentBill|resolveAgentTextSettlement|resolveWorkflowSettlement/u,
  );
  assert.doesNotMatch(
    handlerSource,
    /AGENTS_ENTRYPOINT|AGENTS_CATALOG|registerManowarRoutes/u,
  );
  assert.doesNotMatch(
    discoverySource,
    /AGENTS_ENTRYPOINT|AGENTS_CATALOG|fetchAgentCatalog|buildAgentsPaymentRequired|buildAgentStreamPaymentRequired/u,
  );
});

test("registerUtilityRoutes exposes only receipts, IPFS pin proxy, and frameworks", async () => {
  const app = express();
  app.use(express.json());
  registerUtilityRoutes(app);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  await withServer(app, async (baseUrl) => {
    const frameworksRes = await fetch(`${baseUrl}/frameworks`);
    assert.equal(frameworksRes.status, 200);
    const frameworksBody = await frameworksRes.json() as { frameworks?: Array<{ id: string }> };
    assert.deepEqual(frameworksBody.frameworks?.map((f) => f.id), ["manowar", "other"]);

    const receiptsUnauth = await fetch(`${baseUrl}/api/receipts`);
    assert.equal(receiptsUnauth.status, 401);

    for (const [method, path] of [
      ["POST", "/agent/0x1111111111111111111111111111111111111111/stream"],
      ["POST", "/agent/0x1111111111111111111111111111111111111111/responses"],
      ["GET", "/agent/0x1111111111111111111111111111111111111111/runs/run-1/state"],
      ["POST", "/workflow/execute"],
      ["GET", "/workflow/prices"],
      ["POST", "/api/memory/search"],
      ["POST", "/api/workspace/search"],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      });
      assert.equal(response.status, 404, `expected 404 on api for ${method} ${path}`);
    }
  });
});

test("handler and registerHandlerRoutes return 404 for all agent, workflow, memory, and workspace routes", async () => {
  const app = express();
  app.use(express.json());
  registerHandlerRoutes(app);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  const removedPaths: Array<readonly [string, string]> = [
    ["GET", "/agents"],
    ["POST", "/agents"],
    ["GET", "/agents/list"],
    ["GET", "/agents/search"],
    ["GET", "/agent/0x1111111111111111111111111111111111111111"],
    ["GET", "/agent/0x1111111111111111111111111111111111111111/avatar"],
    ["POST", "/agent/0x1111111111111111111111111111111111111111/stream"],
    ["POST", "/agent/0x1111111111111111111111111111111111111111/responses"],
    ["GET", "/workflows"],
    ["GET", "/workflow/0x1111111111111111111111111111111111111111"],
    ["POST", "/workflow/execute"],
    ["POST", "/api/memory/search"],
    ["POST", "/api/workspace/index"],
  ];

  await withServer(app, async (baseUrl) => {
    for (const [method, path] of removedPaths) {
      const expressRes = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      });
      assert.equal(expressRes.status, 404, `expected Express 404 for ${method} ${path}`);

      const directRes = await handler({
        rawPath: path,
        requestContext: { http: { method } },
        headers: {},
      }, {});
      assert.equal(directRes.statusCode, 404, `expected handler 404 for ${method} ${path}`);
    }
  });
});
