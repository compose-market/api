import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(resolve(API_ROOT, relativePath), "utf8");
}

test("the payer-wide Session budget authority no longer exists", () => {
  assert.equal(existsSync(resolve(API_ROOT, "x402/session/budget.ts")), false);
});

test("removed alternate Compose Key mutation APIs do not remain", () => {
  const keySources = [
    source("x402/keys/index.ts"),
    source("x402/keys/middleware.ts"),
    source("x402/keys/storage.ts"),
  ].join("\n");

  assert.doesNotMatch(
    keySources,
    /\b(?:recordKeyUsage|syncBudgetAfterSettlement|consumeKeyBudget)\b/u,
  );
});
