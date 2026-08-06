import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Request, Response } from "express";

import { prepareInferencePayment } from "../x402/index.js";
import { createKey } from "../x402/keys/storage.js";
import {
  closeValkey,
  valkeyDel,
  valkeySRem,
} from "../x402/keys/valkey.js";

const NETWORK = "eip155:5042002" as const;

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function request(token: string, runId: string): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    host: "api.compose.market",
    "x-network-id": NETWORK,
    "x-run-id": runId,
  };
  return {
    headers,
    method: "POST",
    originalUrl: "/external/v1/responses",
    url: "/external/v1/responses",
    protocol: "https",
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function response(): Response {
  const target = {
    headersSent: false,
    setHeader: () => target,
    status: () => target,
    json: () => target,
  };
  return target as unknown as Response;
}

test("queued Compose settlement returns the validated payer without a settlement timestamp", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousHash = process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
  const payer = wallet();
  const runId = `compose-output-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: 1_000_000,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "compose-output",
  });
  let paymentIntentId = "";

  try {
    process.env.NODE_ENV = "test";
    process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = `0x${"71".repeat(32)}`;
    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "queued";

    const payment = await prepareInferencePayment(
      request(created.token, runId),
      response(),
      { useBudgetCap: true },
    );
    assert.ok(payment);

    const settlement = await payment.settle({ finalAmountWei: "100" });
    assert.equal(settlement.success, true);
    assert.equal(settlement.userAddress, payer);
    assert.equal(settlement.settlementStatus, "queued");
    assert.equal(settlement.settledAt, undefined);
    paymentIntentId = settlement.paymentIntentId || "";
  } finally {
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeySRem(`key-payment-intents:${created.keyId}`, paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${runId}:${runId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousHash === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;
    else process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = previousHash;
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    await closeValkey();
  }
});
