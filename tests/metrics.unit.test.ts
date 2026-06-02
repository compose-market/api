import assert from "node:assert/strict";
import test from "node:test";

import { classifyMetricsClientSource } from "../metrics/middleware.js";
import { formatUsdcAtomic } from "../metrics/redis.js";

test("formatUsdcAtomic renders USDC 6-decimal atomic amounts without floating point math", () => {
  assert.equal(formatUsdcAtomic("0"), "0");
  assert.equal(formatUsdcAtomic("1"), "0.000001");
  assert.equal(formatUsdcAtomic("1000"), "0.001");
  assert.equal(formatUsdcAtomic("1000000"), "1");
  assert.equal(formatUsdcAtomic("123456789"), "123.456789");
});

test("classifyMetricsClientSource honors explicit source headers", () => {
  assert.equal(classifyMetricsClientSource({ "x-client-source": "sdk" }), "sdk");
  assert.equal(classifyMetricsClientSource({ "x-client-source": "web" }), "web");
  assert.equal(classifyMetricsClientSource({ "x-client-source": "runtime" }), "runtime");
  assert.equal(classifyMetricsClientSource({ "x-client-source": "internal" }), "internal");
});

test("classifyMetricsClientSource infers SDK, web, and internal callers", () => {
  assert.equal(classifyMetricsClientSource({ "x-sdk": "typescript/0.6.8" }), "sdk");
  assert.equal(classifyMetricsClientSource({ origin: "https://compose.market" }), "web");
  assert.equal(classifyMetricsClientSource({ "x-workflow-internal": "present" }), "internal");
  assert.equal(classifyMetricsClientSource({ "user-agent": "undici" }), "runtime");
  assert.equal(classifyMetricsClientSource({}), "unknown");
});
