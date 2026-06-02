import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "express";

import { abortPaymentIntent, authorizePaymentIntent, settlePaymentIntent } from "../x402/intents.js";
import { markIntentEvidenceSettled, recordChargeEvidence } from "../x402/evidence.js";
import { prepareInferencePayment, settlePreparedInferencePayment } from "../x402/index.js";
import { createComposeKey, getActiveSessionStatus } from "../x402/keys/storage.js";
import { closeRedis, redisDel, redisGet, redisHGetAll, redisHSet, redisSRem } from "../x402/keys/redis.js";
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

function paymentIntentIdempotencyKey(keyId: string, idempotencyKey: string): string {
  return `payment-intent-idem:${keyId}:${idempotencyKey}`;
}

function inferenceRequest(token: string, idempotencyKey: string, body: Record<string, unknown> = {}): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-chain-id": String(TEST_CHAIN_ID),
    "x-idempotency-key": idempotencyKey,
    host: "api.compose.market",
  };

  return {
    headers,
    method: "POST",
    originalUrl: "/v1/responses",
    url: "/v1/responses",
    body: {
      model: "gpt-4.1-mini",
      ...body,
    },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function responseProbe(): { res: Response; headers: Record<string, string>; statusCode: number | null; body: unknown } {
  const probe: {
    headers: Record<string, string>;
    statusCode: number | null;
    body: unknown;
    res?: Response;
  } = {
    headers: {},
    statusCode: null,
    body: undefined,
  };

  probe.res = {
    headersSent: false,
    setHeader(name: string, value: number | string | readonly string[]) {
      probe.headers[name] = Array.isArray(value) ? value.join(",") : String(value);
      return this;
    },
    status(code: number) {
      probe.statusCode = code;
      return this;
    },
    json(body: unknown) {
      probe.body = body;
      return this;
    },
  } as unknown as Response;

  return {
    res: probe.res,
    headers: probe.headers,
    get statusCode() {
      return probe.statusCode;
    },
    get body() {
      return probe.body;
    },
  };
}

const DIRECT_INFERENCE_METER = {
  subject: "test:gpt-4.1-mini",
  lineItems: [
    {
      key: "request",
      unit: "usd_per_request",
      quantity: 1,
      unitPriceUsd: 0.001,
    },
  ],
};

async function cleanupTestState(input: {
  userAddress: string;
  keyId: string | null;
  paymentIntentIds: string[];
  extraKeys?: string[];
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

  for (const key of input.extraKeys || []) {
    await redisDel(key);
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

test("api payment intents using budget caps do not reserve the whole key budget up front", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  const paymentIntentIds: string[] = [];

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "api",
      chainId: TEST_CHAIN_ID,
      name: "opencode-api",
    });
    keyId = created.keyId;

    const [first, second] = await Promise.all([
      authorizePaymentIntent({
        authorization: `Bearer ${created.token}`,
        chainId: TEST_CHAIN_ID,
        service: "api",
        action: "inference",
        resource: "https://api.compose.market/external/v1/chat/completions",
        method: "POST",
        useBudgetCap: true,
      }),
      authorizePaymentIntent({
        authorization: `Bearer ${created.token}`,
        chainId: TEST_CHAIN_ID,
        service: "api",
        action: "inference",
        resource: "https://api.compose.market/external/v1/chat/completions",
        method: "POST",
        useBudgetCap: true,
      }),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }
    paymentIntentIds.push(first.body.paymentIntentId, second.body.paymentIntentId);

    const recordBeforeSettle = await redisHGetAll(composeKeyRecordKey(created.keyId));
    assert.equal(recordBeforeSettle.budgetReserved, "0");
    assert.equal(recordBeforeSettle.budgetUsed, "0");

    const settled = await settlePaymentIntent({
      paymentIntentId: first.body.paymentIntentId,
      finalAmountWei: String(TEST_REQUEST_WEI),
    });

    assert.equal(settled.ok, true);
    if (!settled.ok) {
      return;
    }
    assert.equal(settled.body.finalAmountWei, String(TEST_REQUEST_WEI));
    assert.equal(settled.body.txHash, TEST_SETTLEMENT_TX_HASH);

    const recordAfterSettle = await redisHGetAll(composeKeyRecordKey(created.keyId));
    assert.equal(recordAfterSettle.budgetReserved, "0");
    assert.equal(recordAfterSettle.budgetUsed, String(TEST_REQUEST_WEI));

    const aborted = await abortPaymentIntent({
      paymentIntentId: second.body.paymentIntentId,
      reason: "test-cleanup",
    });
    assert.equal(aborted.ok, true);

    const recordAfterAbort = await redisHGetAll(composeKeyRecordKey(created.keyId));
    assert.equal(recordAfterAbort.budgetReserved, "0");
    assert.equal(recordAfterAbort.budgetUsed, String(TEST_REQUEST_WEI));
  } finally {
    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds,
    });
  }
});

test("native inference compose-key settlement creates and settles a payment intent", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const idempotencyKey = "native-inference-direct-api";

  let keyId: string | null = null;
  let paymentIntentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "api",
      chainId: TEST_CHAIN_ID,
      name: "native-inference-api",
    });
    keyId = created.keyId;

    const probe = responseProbe();
    const payment = await prepareInferencePayment(
      inferenceRequest(created.token, idempotencyKey),
      probe.res,
      { useBudgetCap: true },
    );

    assert.ok(payment, "native inference compose-key preparation should succeed");
    assert.equal(probe.statusCode, null);
    paymentIntentId = await redisGet(paymentIntentIdempotencyKey(created.keyId, idempotencyKey));
    assert.ok(paymentIntentId, "native inference compose-key preparation should create a payment intent");
    assert.equal(payment.runtimeHeaders.Authorization, `Bearer ${created.token}`);
    assert.equal(payment.runtimeHeaders["x-session-active"], "false");
    assert.equal(payment.runtimeHeaders["x-session-user-address"], userAddress.toLowerCase());
    assert.equal(payment.runtimeHeaders["x-payment-intent-id"], paymentIntentId);
    assert.equal(payment.runtimeHeaders["x-chain-id"], String(TEST_CHAIN_ID));

    const receipt = await settlePreparedInferencePayment(
      payment,
      probe.res,
      { meter: DIRECT_INFERENCE_METER },
    );

    assert.ok(receipt);
    assert.equal(receipt.txHash, TEST_SETTLEMENT_TX_HASH);
    assert.equal(receipt.settlementStatus, "settled");
    assert.equal(receipt.paymentIntentId, paymentIntentId);
    assert.equal(probe.headers["x-payment-intent-id"], paymentIntentId);
    assert.equal(probe.headers["x-key-final-amount-wei"], receipt.finalAmountWei);
    assert.equal(probe.headers["x-key-tx-hash"], TEST_SETTLEMENT_TX_HASH);
    assert.equal(probe.headers["X-Transaction-Hash"], TEST_SETTLEMENT_TX_HASH);
    assert.equal(probe.headers["x-settlement"], "settled");
    assert.equal(await redisGet(paymentIntentIdempotencyKey(created.keyId, idempotencyKey)), paymentIntentId);

    const intent = await redisHGetAll(paymentIntentKey(paymentIntentId));
    assert.equal(intent.status, "settled");
    assert.equal(intent.finalAmountWei, receipt.finalAmountWei);
    assert.equal(intent.txHash, TEST_SETTLEMENT_TX_HASH);

    const record = await redisHGetAll(composeKeyRecordKey(created.keyId));
    assert.equal(record.budgetReserved || "0", "0");
    assert.equal(record.budgetUsed, receipt.finalAmountWei);
  } finally {
    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: paymentIntentId ? [paymentIntentId] : [],
      extraKeys: keyId ? [paymentIntentIdempotencyKey(keyId, idempotencyKey)] : [],
    });
  }
});

test("native inference session compose-key locks only the final authoritative settlement amount", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const idempotencyKey = "native-inference-direct-session";
  const fixedNow = 1_700_000_000_000;
  const requestId = "native-session-direct";
  const sessionIntentId = `${userAddress.toLowerCase()}-${requestId}-${fixedNow}`;

  let keyId: string | null = null;
  const originalNow = Date.now;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "native-inference-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const req = inferenceRequest(created.token, idempotencyKey);
    req.headers["x-run-id"] = requestId;
    const probe = responseProbe();
    const payment = await prepareInferencePayment(req, probe.res, { useBudgetCap: true });

    assert.ok(payment, "native inference session preparation should succeed");
    assert.equal(probe.statusCode, null);
    assert.equal(await redisGet(paymentIntentIdempotencyKey(created.keyId, idempotencyKey)), null);
    assert.equal(payment.maxAmountWei, String(TEST_BUDGET_WEI));
    assert.equal(payment.runtimeHeaders.Authorization, `Bearer ${created.token}`);
    assert.equal(payment.runtimeHeaders["x-session-active"], "true");
    assert.equal(payment.runtimeHeaders["x-session-user-address"], userAddress.toLowerCase());
    assert.equal(payment.runtimeHeaders["x-session-budget-remaining"], String(TEST_BUDGET_WEI));
    assert.equal(payment.runtimeHeaders["x-chain-id"], String(TEST_CHAIN_ID));

    Date.now = () => fixedNow;
    const receipt = await settlePreparedInferencePayment(
      payment,
      probe.res,
      { meter: DIRECT_INFERENCE_METER },
    );
    Date.now = originalNow;

    assert.ok(receipt);
    assert.equal(receipt.txHash, undefined);
    assert.equal(receipt.settlementStatus, "queued");
    assert.equal(receipt.sessionBudgetIntentId, sessionIntentId);
    assert.equal(probe.headers["x-payment-intent-id"], sessionIntentId);
    assert.equal(probe.headers["x-session-budget-intent-id"], sessionIntentId);
    assert.equal(probe.headers["x-settlement"], "queued");
    assert.equal(probe.headers["x-key-final-amount-wei"], receipt.finalAmountWei);

    const budgetInfo = await getBudgetInfo(userAddress, TEST_CHAIN_ID);
    assert.equal(budgetInfo?.lockedWei, receipt.finalAmountWei);
    assert.equal(budgetInfo?.usedWei, "0");
    assert.equal(await redisGet(paymentIntentIdempotencyKey(created.keyId, idempotencyKey)), null);

    const evidence = await recordChargeEvidence({
      kind: "model",
      rootRunId: requestId,
      executionRunId: requestId,
      action: "v1-responses",
      providerAmountWei: "1000",
      composeFeeWei: "10",
      finalAmountWei: receipt.finalAmountWei,
      settlementStatus: "queued",
      sessionBudgetIntentId: receipt.sessionBudgetIntentId,
      chainId: TEST_CHAIN_ID,
    });

    const updated = await markIntentEvidenceSettled({
      sessionBudgetIntentId: receipt.sessionBudgetIntentId,
      txHash: TEST_SETTLEMENT_TX_HASH,
      chainId: TEST_CHAIN_ID,
    });
    assert.equal(updated, 1);

    const settledEvidence = await redisHGetAll(`x402:evidence:charge:${evidence.id}`);
    assert.equal(settledEvidence?.settlementStatus, "settled");
    assert.equal(settledEvidence?.txHash, TEST_SETTLEMENT_TX_HASH);
  } finally {
    Date.now = originalNow;
    await cleanupTestState({
      userAddress,
      keyId,
      paymentIntentIds: [],
      extraKeys: [
        sessionIntentKey(sessionIntentId),
        ...(keyId ? [paymentIntentIdempotencyKey(keyId, idempotencyKey)] : []),
      ],
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
    assert.equal(settled.headers["x-key-final-amount-wei"], String(TEST_REQUEST_WEI));
    assert.equal(settled.headers["x-key-tx-hash"], TEST_SETTLEMENT_TX_HASH);

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
