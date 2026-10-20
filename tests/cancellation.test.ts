import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(resolve(DIR, "../routes.ts"), "utf8");
const GATEWAY = readFileSync(resolve(DIR, "../inference/gateway.ts"), "utf8");
const ENGINE = readFileSync(resolve(DIR, "../inference/engine.ts"), "utf8");
const ADAPTER = readFileSync(resolve(DIR, "../inference/catalog/adapter.ts"), "utf8");

test("api routes do not proxy runtime streams", () => {
  assert.doesNotMatch(ROUTES, /callRuntime|payableStreamRoute|RUNTIME_URL/);
});

test("inference gateway threads cancellation and deadlines into provider work", () => {
  assert.match(GATEWAY, /function createRequestAbort/);
  assert.match(GATEWAY, /function withDirectDeadline/);
  assert.match(GATEWAY, /generateEngine\(nextRequest,[\s\S]{0,180}signal: direct\?\.signal \|\| lifecycle\.signal/);
  assert.match(GATEWAY, /streamEngine\(request,[\s\S]{0,180}signal: streamDeadline\?\.signal \|\| lifecycle\.signal/);
  assert.match(GATEWAY, /externalCompatibility \? null : withDirectDeadline/);
  assert.match(GATEWAY, /execute: \(signal\) => invokeDirectAdapter\(request,\s*signal\)/);
  assert.match(GATEWAY, /class UpstreamTimeoutError/);
  assert.match(GATEWAY, /code = ["']upstream_timeout["']/);
  assert.match(GATEWAY, /request\.modality === "realtime"[\s\S]{0,160}closeRealtimeEngine\(request\.responseId\)/);
});

test("inference engine and adapter expose internal abort signals without changing request schema", () => {
  assert.match(ENGINE, /export interface RunOptions[\s\S]*signal\?: AbortSignal/);
  assert.match(ENGINE, /generateWithTools\(request,[\s\S]*signal: options\.signal/);
  assert.match(ENGINE, /streamWithTools\(request,[\s\S]*signal: options\.signal/);
  assert.match(ADAPTER, /export interface AdapterTarget[\s\S]*signal\?: AbortSignal/);
  assert.doesNotMatch(readFileSync(resolve(DIR, "../inference/core.ts"), "utf8"), /interface Request[\s\S]*signal\?: AbortSignal/);
});
