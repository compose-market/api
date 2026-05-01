import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Request } from "express";

import { abortPaymentIntent, authorizePaymentIntent, settlePaymentIntent } from "../x402/intents.js";
import { prepareDeferredPayment } from "../x402/index.js";
import { createComposeKey, getActiveSessionStatus } from "../x402/keys/storage.js";
import { closeRedis, redisDel, redisHGetAll, redisHSet, redisSRem } from "../x402/keys/redis.js";
import { getBudgetInfo, initializeSessionBudget } from "../x402/session-budget.js";

const TEST_CHAIN_ID = 43113;
const TEST_BUDGET_WEI = 1_000_000;
const TEST_SESSION_USED_WEI = 25_000;
const TEST_STALE_KEY_USED_WEI = 50_000;
const TEST_REQUEST_WEI = 25_000;
const TEST_SETTLEMENT_TX_HASH = `0x${"12".repeat(32)}`;
const PENDING_INTENTS_KEY = "intents:pending";

process.env.NODE_ENV = "test";
process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = String(TEST_BUDGET_WEI);
process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH = TEST_SETTLEMENT_TX_HASH;

function randomWalletAddress(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function sessionBudgetKey(userAddress: string, chainId: number): string {
  return `session:budget:${userAddress.toLowerCase()}:${chainId}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${userAddress.toLowerCase()}`;
}

function composeKeyRecordKey(keyId: string): string {
  return `compose-key:${keyId}`;
}

function revokedComposeKeyKey(keyId: string): string {
  return `compose-key:revoked:${keyId}`;
}

function paymentIntentKey(paymentIntentId: string): string {
  return `payment-intent:${paymentIntentId}`;
}

function sessionIntentKey(intentId: string): string {
  return `intent:${intentId}`;
}

function userIntentsKey(userAddress: string): string {
  return `session:budget:${userAddress.toLowerCase()}:intents`;
}

async function cleanupTestState(input: {
  userAddress: string;
  keyId: string | null;
  paymentIntentIds: string[];
}): Promise<void> {
  for (const paymentIntentId of input.paymentIntentIds) {
    const intent = await redisHGetAll(paymentIntentKey(paymentIntentId));
    const sessionBudgetIntentId = intent?.sessionBudgetIntentId;
    if (sessionBudgetIntentId) {
      await redisDel(sessionIntentKey(sessionBudgetIntentId));
      await redisSRem(PENDING_INTENTS_KEY, sessionBudgetIntentId);
      await redisSRem(userIntentsKey(input.userAddress), sessionBudgetIntentId);
    }
    await redisDel(paymentIntentKey(paymentIntentId));
  }

  if (input.keyId) {
    await redisDel(composeKeyRecordKey(input.keyId));
    await redisDel(revokedComposeKeyKey(input.keyId));
    await redisSRem(userKeysKey(input.userAddress), input.keyId);
  }

  await redisDel(sessionBudgetKey(input.userAddress, TEST_CHAIN_ID));
  await closeRedis();
}

test("session payment intents authorize against the live session ledger instead of stale compose-key usage", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    await redisHSet(sessionBudgetKey(userAddress, TEST_CHAIN_ID), {
      usedBudgetWei: String(TEST_SESSION_USED_WEI),
      lockedBudgetWei: "0",
    });
    await redisHSet(composeKeyRecordKey(created.keyId), {
      budgetUsed: String(TEST_STALE_KEY_USED_WEI),
      budgetReserved: "0",
    });

    const sessionStatus = await getActiveSessionStatus(userAddress, TEST_CHAIN_ID);
    assert.equal(sessionStatus.reason, "none");
    assert.equal(sessionStatus.session?.budgetRemaining, TEST_BUDGET_WEI - TEST_SESSION_USED_WEI);

    const prepared = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "agent",
      action: "chat",
      resource: "https://api.compose.market/agent/test/chat",
      method: "POST",
      maxAmountWei: String(sessionStatus.session!.budgetRemaining),
    });

    assert.equal(prepared.ok, true, "session-backed route authorization must use the live session ledger");
    if (!prepared.ok) {
      return;
    }

    paymentIntentId = prepared.body.paymentIntentId;
    assert.equal(prepared.headers["x-session-budget-limit"], String(TEST_BUDGET_WEI));
    assert.equal(prepared.headers["x-session-budget-used"], String(TEST_SESSION_USED_WEI));
    assert.equal(prepared.headers["x-session-budget-locked"], String(TEST_BUDGET_WEI - TEST_SESSION_USED_WEI));
    assert.equal(prepared.headers["x-session-budget-remaining"], "0");

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.usedWei, String(TEST_SESSION_USED_WEI));
    assert.equal(budgetInfo?.lockedWei, String(TEST_BUDGET_WEI - TEST_SESSION_USED_WEI));
    assert.equal(budgetInfo?.availableWei, "0");
  } finally {
    if (paymentIntentId) {
      await abortPaymentIntent({
        paymentIntentId,
        reason: "test-cleanup",
      });
    }

    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});

test("aborting a session payment intent releases the live reservation and keeps the session active", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const prepared = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "workflow",
      action: "execute",
      resource: "https://api.compose.market/workflow/test/chat",
      method: "POST",
      maxAmountWei: String(TEST_REQUEST_WEI),
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) {
      return;
    }

    paymentIntentId = prepared.body.paymentIntentId;

    let budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, String(TEST_REQUEST_WEI));
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI - TEST_REQUEST_WEI));

    const aborted = await abortPaymentIntent({
      paymentIntentId,
      reason: "test-cleanup",
    });

    assert.equal(aborted.ok, true);

    budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, "0");
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI));

    const sessionStatus = await getActiveSessionStatus(userAddress, TEST_CHAIN_ID);
    assert.equal(sessionStatus.reason, "none");
    assert.equal(sessionStatus.session?.budgetRemaining, TEST_BUDGET_WEI);
    assert.equal(sessionStatus.session?.budgetLocked, 0);
  } finally {
    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});

test("session payment intents using budget caps do not lock the whole live session budget up front", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const prepared = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/v1/responses",
      method: "POST",
      useBudgetCap: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) {
      return;
    }

    paymentIntentId = prepared.body.paymentIntentId;
    assert.equal(prepared.body.maxAmountWei, String(TEST_BUDGET_WEI));
    assert.equal(prepared.headers["x-session-budget-locked"], "0");
    assert.equal(prepared.headers["x-session-budget-remaining"], String(TEST_BUDGET_WEI));

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, "0");
    assert.equal(budgetInfo?.usedWei, "0");
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI));
  } finally {
    if (paymentIntentId) {
      await abortPaymentIntent({
        paymentIntentId,
        reason: "test-cleanup",
      });
    }

    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});

test("idempotent session payment intent authorization replays the same intent without double-locking budget", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const first = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/v1/responses",
      method: "POST",
      maxAmountWei: String(TEST_REQUEST_WEI),
      idempotencyKey: "idem-session-intent-test",
    });

    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    paymentIntentId = first.body.paymentIntentId;

    const replay = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/v1/responses",
      method: "POST",
      maxAmountWei: String(TEST_REQUEST_WEI),
      idempotencyKey: "idem-session-intent-test",
    });

    assert.equal(replay.ok, true);
    if (!replay.ok) {
      return;
    }
    assert.equal(replay.body.paymentIntentId, paymentIntentId);
    assert.equal(replay.headers["x-idempotent-replay"], "true");

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, String(TEST_REQUEST_WEI));
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI - TEST_REQUEST_WEI));
  } finally {
    if (paymentIntentId) {
      await abortPaymentIntent({
        paymentIntentId,
        reason: "test-cleanup",
      });
    }

    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});

test("settling a session payment intent cannot exceed the reserved amount", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const prepared = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "agent",
      action: "chat",
      resource: "https://api.compose.market/agent/test/chat",
      method: "POST",
      maxAmountWei: String(TEST_REQUEST_WEI),
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) {
      return;
    }
    paymentIntentId = prepared.body.paymentIntentId;

    const settled = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(TEST_REQUEST_WEI + 1),
    });

    assert.equal(settled.ok, false);
    assert.equal(settled.status, 409);

    const paymentIntent = await redisHGetAll(paymentIntentKey(paymentIntentId));
    assert.equal(paymentIntent.status, "authorized");
    assert.equal(paymentIntent.finalAmountWei, undefined);

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, String(TEST_REQUEST_WEI));
    assert.equal(budgetInfo?.usedWei, "0");
  } finally {
    if (paymentIntentId) {
      await abortPaymentIntent({
        paymentIntentId,
        reason: "test-cleanup",
      });
    }

    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});

test("settling a session budget-cap intent charges on-chain before marking Redis settled", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const prepared = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/v1/responses",
      method: "POST",
      useBudgetCap: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) {
      return;
    }

    paymentIntentId = prepared.body.paymentIntentId;
    assert.equal(prepared.body.maxAmountWei, String(TEST_BUDGET_WEI));
    assert.equal(prepared.headers["x-session-budget-locked"], "0");
    assert.equal(prepared.headers["x-session-budget-remaining"], String(TEST_BUDGET_WEI));

    const settled = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(TEST_REQUEST_WEI),
    });

    assert.equal(settled.ok, true);
    if (!settled.ok) {
      return;
    }

    assert.equal(settled.body.finalAmountWei, String(TEST_REQUEST_WEI));
    assert.equal(settled.body.txHash, TEST_SETTLEMENT_TX_HASH);
    assert.equal(settled.headers["x-payment-method"], undefined);
    assert.equal(settled.headers["x-settlement"], undefined);
    assert.equal(settled.headers["x-compose-key-final-amount-wei"], String(TEST_REQUEST_WEI));
    assert.equal(settled.headers["x-compose-key-tx-hash"], TEST_SETTLEMENT_TX_HASH);

    const paymentIntent = await redisHGetAll(paymentIntentKey(paymentIntentId));
    assert.ok(paymentIntent?.sessionBudgetIntentId, "settlement should create a session-budget intent");
    assert.equal(paymentIntent.status, "settled");
    assert.equal(paymentIntent.finalAmountWei, String(TEST_REQUEST_WEI));
    assert.equal(paymentIntent.txHash, TEST_SETTLEMENT_TX_HASH);

    const sessionIntent = await redisHGetAll(sessionIntentKey(paymentIntent.sessionBudgetIntentId));
    assert.equal(sessionIntent?.status, "settled");
    assert.equal(sessionIntent?.txHash, TEST_SETTLEMENT_TX_HASH);

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, "0");
    assert.equal(budgetInfo?.usedWei, String(TEST_REQUEST_WEI));
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI - TEST_REQUEST_WEI));
  } finally {
    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});

test("settled session payment intents replay without double-charging and cannot be aborted", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const prepared = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      chainId: TEST_CHAIN_ID,
      service: "workflow",
      action: "execute",
      resource: "https://api.compose.market/workflow/test/chat",
      method: "POST",
      maxAmountWei: String(TEST_REQUEST_WEI),
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) {
      return;
    }
    paymentIntentId = prepared.body.paymentIntentId;

    const firstSettle = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(TEST_REQUEST_WEI),
    });
    assert.equal(firstSettle.ok, true);

    const replaySettle = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(TEST_REQUEST_WEI - 1),
    });
    assert.equal(replaySettle.ok, true);
    if (!replaySettle.ok) {
      return;
    }
    assert.equal(replaySettle.body.finalAmountWei, String(TEST_REQUEST_WEI));
    assert.equal(replaySettle.body.txHash, TEST_SETTLEMENT_TX_HASH);

    const abortSettled = await abortPaymentIntent({
      paymentIntentId,
      reason: "must-not-release-settled-budget",
    });
    assert.equal(abortSettled.ok, false);
    assert.equal(abortSettled.status, 409);

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, "0");
    assert.equal(budgetInfo?.usedWei, String(TEST_REQUEST_WEI));
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI - TEST_REQUEST_WEI));
  } finally {
    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
    });
  }
});


test("prepareDeferredPayment derives session bypass from the compose key and Redis session state", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let prepared: Awaited<ReturnType<typeof prepareDeferredPayment>> | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "route-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const requestHeaders = {
      authorization: `Bearer ${created.token}`,
      "x-chain-id": String(TEST_CHAIN_ID),
    };
    const request = {
      headers: requestHeaders,
      body: {
        model: "test-model",
      },
      get(name: string) {
        return requestHeaders[name.toLowerCase() as keyof typeof requestHeaders];
      },
    } as unknown as Request;

    prepared = await prepareDeferredPayment(request, TEST_REQUEST_WEI);

    assert.equal(prepared.valid, true);
    assert.equal(prepared.method, "session");
    assert.equal(prepared.metadata?.userAddress, userAddress);

    const headers = prepared.getHeaders();
    assert.equal(headers["x-payment-method"], "session-bypass");
    assert.equal(headers["x-settlement"], "deferred");

    let budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, String(TEST_REQUEST_WEI));
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI - TEST_REQUEST_WEI));

    await prepared.abort("test-cleanup");
    prepared = null;

    budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, "0");
    assert.equal(budgetInfo?.availableWei, String(TEST_BUDGET_WEI));
  } finally {
    if (prepared) {
      await prepared.abort("test-cleanup");
    }

    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: [],
    });
  }
});
