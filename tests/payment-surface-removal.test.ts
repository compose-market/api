import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("production payment surfaces contain no legacy Session-budget authority", () => {
  const ownedSurfaces = [
    "handler.ts",
    "data/metrics/sessions.ts",
    "http/request-context.ts",
    "routes.ts",
    "x402/index.ts",
    "x402/evidence.ts",
    "x402/receipts.ts",
  ];

  for (const relativePath of ownedSurfaces) {
    assert.doesNotMatch(
      source(relativePath),
      /sessionBudgetIntentId|session_budget_intent_id|session:budget:/u,
      `${relativePath} must use canonical paymentIntentId and key ledgers only`,
    );
  }
});

test("native batch settlement exposes NetworkId without a numeric chainId field", () => {
  const batch = source("x402/batch.ts");
  const channels = source("x402/channels.ts");
  const facilitator = source("x402/facilitator.ts");
  const handler = source("handler.ts");

  assert.doesNotMatch(batch, /\bchainId\b|DEFAULT_STABLECOINS|getDefaultAsset/u);
  assert.doesNotMatch(channels, /^\s*chainId\s*:/mu);
  assert.doesNotMatch(channels, /evmChainId\(/u);
  assert.doesNotMatch(facilitator, /createBatchPaymentExtra\(evmChainId\(/u);
  assert.doesNotMatch(handler, /chains\?:\s*Array<\{\s*chainId\s*:/u);
  assert.match(channels, /network:\s*EvmNetworkId/u);
});

test("canonical payment metrics require confirmed status as well as a transaction hash", () => {
  const handler = source("handler.ts");

  assert.match(
    handler,
    /result\.ok\s*&&\s*result\.body\.status\s*===\s*["']confirmed["']/u,
  );
});

test("removed synchronous key settlement endpoint leaves no routing compatibility residue", () => {
  const handler = source("handler.ts");

  assert.doesNotMatch(handler, /\/api\/keys\/settle/u);
});

test("Session metrics source durable Session credentials rather than payment-intent history", () => {
  const sessions = source("data/metrics/sessions.ts");

  assert.match(sessions, /MATCH",\s*"key:\*"/u);
  assert.doesNotMatch(sessions, /MATCH",\s*"payment-intent:\*"/u);
  assert.match(sessions, /keyId:\s*record\.keyId/u);
});

test("terminal agent identity has no legacy paymentRunId alias", () => {
  const routes = source("routes.ts");

  assert.doesNotMatch(routes, /paymentRunId/u);
});
