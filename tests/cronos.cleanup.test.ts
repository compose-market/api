import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const API_ROOT = "/Users/jabyl/Downloads/compose-market/api";

test("backend cronos implementation files are removed", () => {
  assert.equal(existsSync(`${API_ROOT}/aa/index.ts`), false);
  assert.equal(existsSync(`${API_ROOT}/aa/paymaster.ts`), false);
  assert.equal(existsSync(`${API_ROOT}/aa/userop.ts`), false);
  assert.equal(existsSync(`${API_ROOT}/x402/configs/cronos.ts`), false);
});

test("backend deploy surfaces no longer reference cronos secrets", () => {
  const deploySource = readFileSync(`${API_ROOT}/deploy.ts`, "utf8");
  const cloudbuildSource = readFileSync(`${API_ROOT}/cloudbuild.yaml`, "utf8");

  assert.equal(/CRONOS_/u.test(deploySource), false);
  assert.equal(/DEV_USDC_E_ADDRESS/u.test(deploySource), false);
  assert.equal(/CRONOS_/u.test(cloudbuildSource), false);
  assert.equal(/DEV_USDC_E_ADDRESS/u.test(cloudbuildSource), false);
});

test("backend x402 entrypoint no longer documents legacy cronos headers or chains", () => {
  const x402Source = readFileSync(`${API_ROOT}/x402/index.ts`, "utf8");

  assert.equal(/X-PAYMENT/u.test(x402Source), false);
  assert.equal(/Cronos/u.test(x402Source), false);
  assert.equal(/\b338\b/u.test(x402Source), false);
  assert.equal(/\b25\b/u.test(x402Source), false);
});
