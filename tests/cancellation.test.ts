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

test("api runtime proxy passes client abort signals upstream", () => {
  assert.match(ROUTES, /function createRequestAbort/);
  assert.match(ROUTES, /req\.on\(["']aborted["']/);
  assert.match(ROUTES, /res\.on\(["']close["']/);
  assert.match(ROUTES, /async function callRuntime[\s\S]*signal\?: AbortSignal[\s\S]*signal,/);
  assert.match(ROUTES, /fetch\(`\$\{requireConnectorsUrl\(\)\}\$\{target\.path\}`[\s\S]*signal: lifecycle\.signal/);
});

test("payable stream route aborts unsettled runtime streams on client close", () => {
  const payableStart = ROUTES.indexOf("function payableStreamRoute");
  const payable = ROUTES.slice(payableStart);

  assert.match(payable, /callRuntime\([\s\S]*lifecycle\.signal/);
  assert.match(payable, /lifecycle\.signal\.addEventListener\(["']abort["'],\s*cancelReader/);
  assert.match(payable, /await abortPreparedPayment\(prepared,\s*abortReason\(lifecycle\.signal\)\)/);
  assert.match(payable, /if \(settlement && !settlementDone\)/);
  assert.match(payable, /if \(!settlementDone\)[\s\S]*await abortPreparedPayment/);
});

test("inference gateway threads cancellation and deadlines into provider work", () => {
  assert.match(GATEWAY, /function createRequestAbort/);
  assert.match(GATEWAY, /function withDirectDeadline/);
  assert.match(GATEWAY, /generateEngine\(request,\s*\{\s*signal: direct\.signal\s*\}\)/);
  assert.match(GATEWAY, /streamEngine\(request,\s*\{\s*signal: lifecycle\.signal\s*\}\)/);
  assert.match(GATEWAY, /execute: \(signal\) => invokeDirectAdapter\(request,\s*signal\)/);
  assert.match(GATEWAY, /class UpstreamTimeoutError/);
  assert.match(GATEWAY, /code = ["']upstream_timeout["']/);
});

test("inference engine and adapter expose internal abort signals without changing request schema", () => {
  assert.match(ENGINE, /export interface RunOptions[\s\S]*signal\?: AbortSignal/);
  assert.match(ENGINE, /generateWithTools\(request,[\s\S]*signal: options\.signal/);
  assert.match(ENGINE, /streamWithTools\(request,[\s\S]*signal: options\.signal/);
  assert.match(ADAPTER, /export interface AdapterTarget[\s\S]*signal\?: AbortSignal/);
  assert.doesNotMatch(readFileSync(resolve(DIR, "../inference/core.ts"), "utf8"), /interface Request[\s\S]*signal\?: AbortSignal/);
});
