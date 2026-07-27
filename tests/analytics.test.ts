import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import express from "express";

interface RouteLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

function routes(app: express.Application): Array<{ path: string; methods: string[] }> {
  return (app.router.stack as RouteLayer[])
    .filter((layer): layer is { route: NonNullable<RouteLayer["route"]> } => Boolean(layer.route))
    .map((layer) => ({ path: String(layer.route.path), methods: Object.keys(layer.route.methods || {}) }));
}

test("analytics exposes only the canonical inference endpoint", async () => {
  const { registerAnalyticsRoutes } = await import("../analytics/index.js");
  const app = express();
  registerAnalyticsRoutes(app);
  const mounted = routes(app);
  assert.equal(mounted.some((route) => route.path === "/api/analytics/inference" && route.methods.includes("get")), true);
  assert.equal(mounted.some((route) => route.path === "/api/analytics"), false);
});

test("analytics requires the validated wallet session header before storage", async () => {
  const { registerAnalyticsRoutes } = await import("../analytics/index.js");
  const app = express();
  registerAnalyticsRoutes(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/analytics/inference`);
    assert.equal(missing.status, 401);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/analytics/inference`, {
      headers: { "x-session-user-address": "not-a-wallet", "x-network-id": "eip155:43113" },
    });
    assert.equal(malformed.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("inference emits neutral telemetry without importing analytics", async () => {
  const gateway = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const events = await readFile(join(process.cwd(), "inference/events.ts"), "utf8");
  assert.doesNotMatch(gateway, /analytics\//);
  assert.doesNotMatch(events, /analytics\//);
  assert.match(gateway, /addInferenceSettlement/);
  assert.match(events, /quote\.telemetry\.metrics/);
  assert.match(events, /quote\.telemetry\.lineItems/);
});

test("analytics has no response capture, receipt seed, or Valkey derivation", async () => {
  for (const file of ["capture.ts", "seed.ts", "valkey.ts"]) {
    await assert.rejects(access(join(process.cwd(), "analytics/inference", file)));
  }
  const index = await readFile(join(process.cwd(), "analytics/index.ts"), "utf8");
  assert.doesNotMatch(index, /decodeReceiptHeader|listReceipts|capture/);
});

test("analytics storage is request based and excludes provider dimensions", async () => {
  const db = await readFile(join(process.cwd(), "analytics/inference/db.ts"), "utf8");
  assert.match(db, /ANALYTICS_DATABASE_URL/);
  assert.doesNotMatch(db, /METRICS_DATABASE_URL/);
  assert.match(db, /inference\.requests/);
  assert.match(db, /inference\.settlements/);
  assert.doesNotMatch(db, /provider TEXT|provider,/);
  assert.doesNotMatch(db, /inference\.events|inference\.attempts/);
});

test("analytics summaries are independent from request and settlement pagination", async () => {
  const aggregate = await readFile(join(process.cwd(), "analytics/inference/aggregate.ts"), "utf8");
  const db = await readFile(join(process.cwd(), "analytics/inference/db.ts"), "utf8");
  assert.match(aggregate, /totals\(rows\.allRequests, rows\.allSettlements\)/);
  assert.match(db, /requestCursor/);
  assert.match(db, /settlementCursor/);
  assert.match(db, /allRequests/);
  assert.match(db, /allSettlements/);
});

test("authoritative inference telemetry owns analytics metrics and units", async () => {
  const telemetry = await readFile(join(process.cwd(), "inference/telemetry.ts"), "utf8");
  const events = await readFile(join(process.cwd(), "inference/events.ts"), "utf8");
  assert.match(telemetry, /metrics: Record<string, number>/);
  assert.match(telemetry, /lineItems: Array<MeterLineItem & \{ source:/);
  assert.doesNotMatch(events, /unitFor|originFor|inputText|cachedInputText/);
});
