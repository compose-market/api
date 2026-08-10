import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  abortPaymentIntent,
  authorizePaymentIntent,
  executeCanonicalPaymentIntent,
  listCanonicalPaymentIntentIds,
  reconcileCanonicalPaymentIntentProjections,
  settlePaymentIntent,
} from "../x402/intents.js";
import { triggerImmediateSettlement } from "../x402/accumulator/worker.js";
import { createKey } from "../x402/keys/storage.js";
import {
  closeValkey,
  getValkeyClient,
  valkeyClaimPaymentIntentExecution,
  valkeyAuthorizePaymentIntent,
  valkeyDel,
  valkeyGet,
  valkeyHGetAll,
  valkeyHSet,
  valkeyReleaseReservedBudget,
  valkeyRetainClaimedPaymentIntent,
  valkeySAdd,
  valkeySMembers,
  valkeySRem,
  valkeyTTL,
  valkeyZRem,
} from "../x402/keys/valkey.js";

const NETWORK = "eip155:5042002" as const;
const BUDGET_WEI = 1_000_000;
const CHECKPOINT_WEI = 25_000;

process.env.NODE_ENV = "test";
process.env.COMPOSE_TEST_SETTLEMENT_MODE = "deterministic";
delete process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH;

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

test("test settlement identities derive from payload and nonce unless explicitly forced", async () => {
  const intentsModule = await import("../x402/intents.js") as unknown as {
    deriveTestSettlementPreparation?: (input: {
      network: typeof NETWORK;
      userAddress: string;
      amountWei: string;
      intentIdentity: string;
      evmNonce?: bigint;
      forcedTxHash?: string;
    }) => { txHash: string; payload: string; nonce?: string };
  };
  assert.equal(typeof intentsModule.deriveTestSettlementPreparation, "function");
  if (!intentsModule.deriveTestSettlementPreparation) return;

  const first = intentsModule.deriveTestSettlementPreparation({
    network: NETWORK,
    userAddress: `0x${"11".repeat(20)}`,
    amountWei: String(CHECKPOINT_WEI),
    intentIdentity: "checkpoint-a",
    evmNonce: 7n,
  });
  const second = intentsModule.deriveTestSettlementPreparation({
    network: NETWORK,
    userAddress: `0x${"11".repeat(20)}`,
    amountWei: String(CHECKPOINT_WEI),
    intentIdentity: "checkpoint-b",
    evmNonce: 8n,
  });
  assert.notEqual(first.payload, second.payload);
  assert.notEqual(first.txHash, second.txHash);
  assert.equal(first.nonce, "7");
  assert.equal(second.nonce, "8");

  const forcedTxHash = `0x${"fe".repeat(32)}`;
  const forced = intentsModule.deriveTestSettlementPreparation({
    network: NETWORK,
    userAddress: `0x${"11".repeat(20)}`,
    amountWei: String(CHECKPOINT_WEI),
    intentIdentity: "forced-checkpoint",
    evmNonce: 9n,
    forcedTxHash,
  });
  assert.equal(forced.txHash, forcedTxHash);
});

test("stale payment-intent projection ids remove themselves", async () => {
  const paymentIntentId = randomUUID();
  const projectionKey = "payment-intents:projections";
  await valkeySAdd(projectionKey, paymentIntentId);
  try {
    assert.equal(await reconcileCanonicalPaymentIntentProjections(paymentIntentId), false);
    assert.equal((await valkeySMembers(projectionKey)).includes(paymentIntentId), false);
  } finally {
    await valkeySRem(projectionKey, paymentIntentId);
    await closeValkey();
  }
});

test("budget-cap authorization resolves its cap inside the Lua linearization point", () => {
  const source = readFileSync(new URL("../x402/keys/valkey.ts", import.meta.url), "utf8");
  const authorizationStart = source.indexOf("export async function valkeyAuthorizePaymentIntent");
  const authorizationEnd = source.indexOf("export async function valkeyReserveAndQueuePaymentIntent");
  const authorizationSource = source.slice(authorizationStart, authorizationEnd);
  assert.match(authorizationSource, /useBudgetCap/);
  assert.match(authorizationSource, /local function subtract/);
  assert.match(authorizationSource, /"maxAmountWei", maxAmount/);
});

test("canonical replay identity excludes request idempotency metadata", () => {
  const source = readFileSync(new URL("../x402/intents.ts", import.meta.url), "utf8");
  const keyStart = source.indexOf("function idempotencyValkeyKey");
  const keyEnd = source.indexOf("function stableJson", keyStart);
  const keySource = source.slice(keyStart, keyEnd);
  assert.match(keySource, /rootRunId: string/);
  assert.match(keySource, /executionRunId: string/);
  assert.match(keySource, /sequence: number/);
  assert.doesNotMatch(keySource, /idempotencyKey/);

  const authorizationStart = source.indexOf("export async function authorizePaymentIntent");
  const authorizationEnd = source.indexOf("export async function settlePaymentIntent", authorizationStart);
  const authorizationSource = source.slice(authorizationStart, authorizationEnd);
  assert.match(
    authorizationSource,
    /rootRunId\?\.trim\(\)[\s\S]*runId\?\.trim\(\)[\s\S]*idempotencyKey\?\.trim\(\)/,
    "request idempotency metadata may only supply a missing root identity",
  );
});

test("budget-cap authorization survives a sibling commit after the caller snapshot", async () => {
  const payer = wallet();
  const siblingRootRunId = `sibling-root-${randomUUID()}`;
  const candidateRootRunId = `candidate-root-${randomUUID()}`;
  const candidateExecutionRunId = `candidate-execution-${randomUUID()}`;
  const candidateIntentId = randomUUID();
  const candidateIdempotencyKey =
    `payment-intent-idem:${NETWORK}:pending:${candidateRootRunId}:${candidateExecutionRunId}:0`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "budget-cap-commit-interleaving",
  });
  let siblingPaymentIntentId: string | undefined;

  try {
    const snapshot = await valkeyHGetAll(`key:${created.keyId}`);
    const staleAvailable = BigInt(snapshot.budgetLimit)
      - BigInt(snapshot.budgetUsed)
      - BigInt(snapshot.budgetReserved);
    assert.equal(staleAvailable, BigInt(BUDGET_WEI));

    const sibling = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId: siblingRootRunId,
      executionRunId: siblingRootRunId,
      sequence: 0,
    });
    assert.equal(sibling.ok, true);
    if (!sibling.ok) return;
    siblingPaymentIntentId = sibling.body.paymentIntentId;
    const siblingSettlement = await settlePaymentIntent({
      paymentIntentId: siblingPaymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(siblingSettlement.ok, true);
    assert.equal((await valkeyHGetAll(`key:${created.keyId}`)).budgetUsed, String(CHECKPOINT_WEI));
    assert.equal((await valkeyHGetAll(`key:${created.keyId}`)).budgetReserved, "0");

    const now = Date.now();
    const canonicalCandidateIdempotencyKey = candidateIdempotencyKey.replace(":pending:", `:${created.keyId}:`);
    const authorization = await valkeyAuthorizePaymentIntent({
      budgetKey: `key:${created.keyId}`,
      intentKey: `payment-intent:${candidateIntentId}`,
      keyIntentsKey: `key-payment-intents:${created.keyId}`,
      idempotencyKey: canonicalCandidateIdempotencyKey,
      intentPrefix: "payment-intent:",
      intentId: candidateIntentId,
      requestFingerprint: `fingerprint-${candidateIntentId}`,
      maxAmountWei: staleAvailable,
      useBudgetCap: true,
      now,
      ttlSeconds: 600,
      intentFields: {
        paymentIntentId: candidateIntentId,
        keyId: created.keyId,
        maxAmountWei: staleAvailable.toString(),
        status: "authorized",
        rootRunId: candidateRootRunId,
        executionRunId: candidateExecutionRunId,
        sequence: "0",
        reservedAmountWei: "0",
        createdAt: String(now),
        updatedAt: String(now),
      },
    });
    assert.deepEqual(authorization, { outcome: "created", paymentIntentId: candidateIntentId });
    const candidate = await valkeyHGetAll(`payment-intent:${candidateIntentId}`);
    assert.equal(candidate.maxAmountWei, String(BUDGET_WEI - CHECKPOINT_WEI));
    assert.equal(candidate.reservedAmountWei, "0");
  } finally {
    if (siblingPaymentIntentId) {
      await abortPaymentIntent({ paymentIntentId: siblingPaymentIntentId, reason: "test cleanup" }).catch(() => undefined);
      await valkeyDel(`payment-intent:${siblingPaymentIntentId}`);
      await valkeySRem("payment-intents:queued", siblingPaymentIntentId);
      await valkeySRem("payment-intents:submitted", siblingPaymentIntentId);
      await valkeyZRem("payment-intents:due", siblingPaymentIntentId);
    }
    await valkeyDel(`payment-intent:${candidateIntentId}`);
    await valkeyDel(candidateIdempotencyKey.replace(":pending:", `:${created.keyId}:`));
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${siblingRootRunId}:${siblingRootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("Session checkpoints use only the canonical key ledger", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "canonical-session",
  });
  let paymentIntentId: string | undefined;

  try {
    assert.deepEqual(
      await valkeyHGetAll(`session:budget:${NETWORK}:${payer.toLowerCase()}`),
      {},
      "the test must not create a payer-wide Session ledger",
    );

    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId,
      sequence: 0,
    });

    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;

    let key = await valkeyHGetAll(`key:${created.keyId}`);
    let intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, "0");
    assert.equal(intent.status, "authorized");
    assert.equal(intent.reservedAmountWei, "0");
    assert.equal(intent.sessionBudgetIntentId, undefined);
    assert.ok((await valkeySMembers(`key-payment-intents:${created.keyId}`)).includes(paymentIntentId));

    const queued = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });

    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    assert.equal(queued.body.status, "queued");
    assert.equal(queued.body.txHash, undefined);

    key = await valkeyHGetAll(`key:${created.keyId}`);
    intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    assert.equal(key.budgetReserved, String(CHECKPOINT_WEI));
    assert.equal(key.budgetUsed, "0");
    assert.equal(key.pendingIntentCount, "1");
    assert.equal(intent.status, "queued");
    assert.equal(intent.reservedAmountWei, String(CHECKPOINT_WEI));
    assert.equal(intent.finalAmountWei, String(CHECKPOINT_WEI));
    assert.equal(intent.sessionBudgetIntentId, undefined);
    const dueScore = await (await getValkeyClient()).zscore("payment-intents:due", paymentIntentId);
    assert.ok(dueScore);
    assert.ok(Number(dueScore) <= Date.now());
    const mismatchedReplay = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
      providerAmountWei: "1",
    });
    assert.equal(mismatchedReplay.ok, false);
    if (!mismatchedReplay.ok) assert.equal(mismatchedReplay.status, 409);
    assert.deepEqual(
      await valkeyHGetAll(`session:budget:${NETWORK}:${payer.toLowerCase()}`),
      {},
    );
  } finally {
    if (paymentIntentId) {
      await abortPaymentIntent({ paymentIntentId, reason: "test cleanup" }).catch(() => undefined);
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeySRem(`key-payment-intents:${created.keyId}`, paymentIntentId);
    }
    const idemKey = `payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${executionRunId}:0`;
    assert.equal(await valkeyGet(idemKey) === null || typeof await valkeyGet(idemKey) === "string", true);
    await valkeyDel(idemKey);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("a transient settlement attempt retains the exact payable checkpoint until confirmation", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "retryable-session",
  });
  let paymentIntentId: string | undefined;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/chat/completions",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    const queued = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(queued.ok, true);

    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "queued";
    const firstRun = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(firstRun.ok, true);
    if (firstRun.ok) {
      assert.equal(firstRun.body.status, "queued");
      assert.equal(firstRun.body.confirmedAt, undefined);
    }
    let key = await valkeyHGetAll(`key:${created.keyId}`);
    let intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    assert.equal(intent.status, "queued");
    assert.equal(intent.attemptCount, "1");
    assert.equal(
      await (await getValkeyClient()).zscore("payment-intents:due", paymentIntentId),
      intent.nextAttemptAt,
    );
    assert.equal(key.budgetReserved, String(CHECKPOINT_WEI));
    assert.equal(key.budgetUsed, "0");
    assert.equal(key.pendingIntentCount, "1");

    await valkeyHSet(`payment-intent:${paymentIntentId}`, "nextAttemptAt", "0");
    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "confirmed";
    const secondRun = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(secondRun.ok, true);
    if (secondRun.ok) {
      assert.equal(secondRun.body.status, "confirmed");
      assert.equal(typeof secondRun.body.confirmedAt, "number");
    }
    key = await valkeyHGetAll(`key:${created.keyId}`);
    intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    assert.equal(intent.status, "confirmed");
    assert.equal(intent.attemptCount, "2");
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, String(CHECKPOINT_WEI));
    assert.equal(key.pendingIntentCount, "0");
    assert.equal(await (await getValkeyClient()).zscore("payment-intents:due", paymentIntentId), null);

    const thirdRun = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(thirdRun.ok, true);
    if (thirdRun.ok) assert.equal(thirdRun.body.confirmedAt, Number(intent.confirmedAt));
    assert.equal((await valkeyHGetAll(`payment-intent:${paymentIntentId}`)).attemptCount, "2",
      "confirmed intents must not be submitted twice");
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeySRem(`key-payment-intents:${created.keyId}`, paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("concurrent workers claim one due settlement attempt exactly once", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "single-claim-session",
  });
  let paymentIntentId: string | undefined;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    const queued = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(queued.ok, true);

    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "queued";
    const attempts = await Promise.all([
      executeCanonicalPaymentIntent(paymentIntentId),
      executeCanonicalPaymentIntent(paymentIntentId),
    ]);
    assert.equal(attempts.every((result) => result.ok), true);
    const intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    assert.equal(intent.status, "queued");
    assert.equal(intent.attemptCount, "1");
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("a stale execution lease recovers by rebroadcasting the same prepared transaction", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "durable-claim-session",
  });
  let paymentIntentId: string | undefined;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
  const staleClaimToken = `claim-${randomUUID()}`;
  const preparedTxHash = `0x${"34".repeat(32)}`;
  const preparedPayload = `test-signed-transaction:${randomUUID()}`;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    const queued = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(queued.ok, true);

    // Model a process that durably prepared the transaction, may have
    // broadcast it, and then crashed before recording submission. Recovery
    // may take over the expired lease only because it can rebroadcast these
    // exact signed bytes and transaction identity.
    await valkeyHSet(`payment-intent:${paymentIntentId}`, {
      executionClaimToken: staleClaimToken,
      executionClaimedAt: String(Date.now() - 60_000),
      executionClaimExpiresAt: String(Date.now() - 1),
      attemptCount: "1",
      preparedTxHash,
      preparedTxPayload: preparedPayload,
    });
    await valkeyDel(`payment-intent-lock:${paymentIntentId}`);
    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "submitted";

    const recovered = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.body.status, "submitted");

    const intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    const key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.preparedTxHash, preparedTxHash);
    assert.equal(intent.preparedTxPayload, preparedPayload);
    assert.equal(intent.txHash, preparedTxHash);
    assert.equal(intent.executionClaimToken, undefined);
    assert.equal(intent.executionClaimExpiresAt, undefined);
    assert.equal(intent.attemptCount, "2");
    assert.equal(key.budgetReserved, String(CHECKPOINT_WEI));
    assert.equal(key.budgetUsed, "0");
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeyDel(`payment-intent-lock:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("API-purpose checkpoints confirm directly and replay without a second charge", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "canonical-api",
  });
  let paymentIntentId: string | undefined;

  try {
    const input = {
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true as const,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    };
    const authorized = await authorizePaymentIntent(input);
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    assert.equal((await valkeyHGetAll(`key:${created.keyId}`)).budgetReserved, "0");

    const confirmed = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    assert.equal(confirmed.body.status, "confirmed");
    assert.match(confirmed.body.txHash || "", /^0x[0-9a-f]{64}$/);
    assert.equal(typeof confirmed.body.confirmedAt, "number");

    const mismatchedReplay = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
      providerAmountWei: "1",
    });
    assert.equal(mismatchedReplay.ok, false);
    if (!mismatchedReplay.ok) assert.equal(mismatchedReplay.status, 409);

    const replaySettlement = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(replaySettlement.ok, true);
    const replayAuthorization = await authorizePaymentIntent(input);
    assert.equal(replayAuthorization.ok, true);
    if (replayAuthorization.ok) {
      assert.equal(replayAuthorization.body.paymentIntentId, paymentIntentId);
      assert.equal(replayAuthorization.body.status, "confirmed");
      assert.equal(replayAuthorization.headers["x-idempotent-replay"], "true");
    }

    const key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, String(CHECKPOINT_WEI));
    assert.deepEqual(await valkeyHGetAll(`session:budget:${NETWORK}:${payer.toLowerCase()}`), {});
  } finally {
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("submitted and reverted checkpoints do not commit usage", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "submitted-session",
  });
  let paymentIntentId: string | undefined;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/chat/completions",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    await settlePaymentIntent({ paymentIntentId, finalAmountWei: String(CHECKPOINT_WEI) });

    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "submitted";
    await executeCanonicalPaymentIntent(paymentIntentId);
    let intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    let key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.status, "submitted");
    const submittedTxHash = intent.txHash;
    assert.match(submittedTxHash || "", /^0x[0-9a-f]{64}$/);
    assert.equal(key.budgetReserved, String(CHECKPOINT_WEI));
    assert.equal(key.budgetUsed, "0");

    await valkeyHSet(`payment-intent:${paymentIntentId}`, "nextAttemptAt", "0");
    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "failed";
    await executeCanonicalPaymentIntent(paymentIntentId);
    intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.status, "failed");
    assert.equal(intent.txHash, submittedTxHash);
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, "0");
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("a submitted checkpoint with no receipt remains submitted without rebroadcast", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "submitted-rebroadcast-session",
  });
  let paymentIntentId: string | undefined;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
  const previousReconcileStatus = process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    await settlePaymentIntent({ paymentIntentId, finalAmountWei: String(CHECKPOINT_WEI) });

    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "submitted";
    const submitted = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(submitted.ok, true);
    if (submitted.ok) assert.equal(submitted.body.status, "submitted");
    let intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    const preparedTxHash = intent.preparedTxHash;
    const preparedTxPayload = intent.preparedTxPayload;
    assert.equal(intent.txHash, preparedTxHash);
    assert.ok(preparedTxPayload);

    await valkeyHSet(`payment-intent:${paymentIntentId}`, "nextAttemptAt", "0");
    process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS = "submitted";
    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "confirmed";
    const pending = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(pending.ok, true);
    if (pending.ok) assert.equal(pending.body.status, "submitted");

    intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    let key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.preparedTxHash, preparedTxHash);
    assert.equal(intent.preparedTxPayload, preparedTxPayload);
    assert.equal(intent.txHash, preparedTxHash);
    assert.equal(intent.attemptCount, "2");
    assert.equal(key.budgetReserved, String(CHECKPOINT_WEI));
    assert.equal(key.budgetUsed, "0");

    await valkeyHSet(`payment-intent:${paymentIntentId}`, "nextAttemptAt", "0");
    process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS = "confirmed";
    const recovered = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.body.status, "confirmed");

    intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.preparedTxHash, preparedTxHash);
    assert.equal(intent.preparedTxPayload, preparedTxPayload);
    assert.equal(intent.txHash, preparedTxHash);
    assert.equal(intent.attemptCount, "3");
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, String(CHECKPOINT_WEI));
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (previousReconcileStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS = previousReconcileStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeySRem(`key-payment-intents:${created.keyId}`, paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("concurrent exact checkpoints cannot over-reserve a shared key", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const amount = 100_000;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "fanout-api",
  });
  const intentIds: string[] = [];

  try {
    const authorizations = await Promise.all(Array.from({ length: 12 }, (_, sequence) => authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/chat/completions",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: `sibling-${sequence}`,
      sequence: 0,
    })));
    assert.equal(authorizations.every((result) => result.ok), true);
    intentIds.push(...authorizations.flatMap((result) => result.ok ? [result.body.paymentIntentId] : []));
    assert.equal((await valkeyHGetAll(`key:${created.keyId}`)).budgetReserved, "0");

    const settlements = await Promise.all(intentIds.map((paymentIntentId) => settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(amount),
    })));
    assert.equal(settlements.filter((result) => result.ok).length, 10);
    assert.equal(settlements.filter((result) => !result.ok && result.status === 402).length, 2);
    const key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, String(BUDGET_WEI));
    const preparedNonces = (await Promise.all(intentIds.map(async (intentId) =>
      (await valkeyHGetAll(`payment-intent:${intentId}`)).preparedTxNonce)))
      .filter((nonce): nonce is string => Boolean(nonce));
    assert.equal(preparedNonces.length, 10);
    assert.equal(new Set(preparedNonces).size, preparedNonces.length,
      "same-signer checkpoints must receive distinct durable EVM nonces");
    const successfulIdentities = (await Promise.all(intentIds.map(async (intentId) => {
      const intent = await valkeyHGetAll(`payment-intent:${intentId}`);
      return intent.status === "confirmed" ? intent : null;
    }))).filter((intent): intent is Record<string, string> => Boolean(intent));
    assert.equal(successfulIdentities.length, 10);
    assert.equal(new Set(successfulIdentities.map((intent) => intent.preparedTxHash)).size, 10,
      "successful checkpoints must have distinct durable prepared transaction hashes");
    assert.equal(new Set(successfulIdentities.map((intent) => intent.preparedTxPayload)).size, 10,
      "successful checkpoints must have distinct durable prepared payloads");
    assert.equal(new Set(successfulIdentities.map((intent) => intent.txHash)).size, 10,
      "successful checkpoints must submit distinct transaction identities");
    assert.equal(successfulIdentities.every((intent) => intent.preparedTxHash === intent.txHash), true,
      "each submitted identity must match its durable prepared identity");
  } finally {
    for (let sequence = 0; sequence < 12; sequence += 1) {
      await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:sibling-${sequence}:0`);
    }
    for (const intentId of intentIds) {
      await valkeyDel(`payment-intent:${intentId}`);
      await valkeySRem("payment-intents:queued", intentId);
      await valkeySRem("payment-intents:submitted", intentId);
      await valkeyZRem("payment-intents:due", intentId);
    }
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("the canonical tuple overrides request idempotency metadata and rejects immutable mismatches", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const idempotencyKey = `idem-${randomUUID()}`;
  const secondIdempotencyKey = `idem-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "explicit-replay-api",
  });
  const intentIds = new Set<string>();

  try {
    const baseInput = {
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      maxAmountWei: String(CHECKPOINT_WEI),
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    } as const;
    const first = await authorizePaymentIntent({ ...baseInput, idempotencyKey });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    intentIds.add(first.body.paymentIntentId);

    const replay = await authorizePaymentIntent({ ...baseInput, idempotencyKey });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      intentIds.add(replay.body.paymentIntentId);
      assert.equal(replay.body.paymentIntentId, first.body.paymentIntentId);
      assert.equal(replay.headers["x-idempotent-replay"], "true");
    }

    const metadataReplay = await authorizePaymentIntent({ ...baseInput, idempotencyKey: secondIdempotencyKey });
    assert.equal(metadataReplay.ok, true);
    if (metadataReplay.ok) {
      intentIds.add(metadataReplay.body.paymentIntentId);
      assert.equal(metadataReplay.body.paymentIntentId, first.body.paymentIntentId,
        "request idempotency metadata cannot create a second intent for one canonical tuple");
      assert.equal(metadataReplay.headers["x-idempotent-replay"], "true");
    }

    const mismatch = await authorizePaymentIntent({
      ...baseInput,
      idempotencyKey: secondIdempotencyKey,
      resource: "https://api.compose.market/external/v1/chat/completions",
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.status, 409);

    const independent = await authorizePaymentIntent({
      ...baseInput,
      idempotencyKey,
      rootRunId: `different-${rootRunId}`,
      executionRunId: `different-${rootRunId}`,
    });
    assert.equal(independent.ok, true);
    if (independent.ok) {
      intentIds.add(independent.body.paymentIntentId);
      assert.notEqual(independent.body.paymentIntentId, first.body.paymentIntentId,
        "explicit root and execution identity must not be overridden by request metadata");
    }
  } finally {
    for (const intentId of intentIds) {
      await valkeyDel(`payment-intent:${intentId}`);
      await valkeySRem(`key-payment-intents:${created.keyId}`, intentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(
      `payment-intent-idem:${NETWORK}:${created.keyId}:different-${rootRunId}:different-${rootRunId}:0`,
    );
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("the canonical sequence scopes independent checkpoints regardless of request metadata", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const idempotencyKey = `idem-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "explicit-checkpoint-sequences",
  });
  const intentIds = new Set<string>();

  try {
    const baseInput = {
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      maxAmountWei: String(CHECKPOINT_WEI),
      idempotencyKey,
      rootRunId,
      executionRunId: rootRunId,
    } as const;
    const first = await authorizePaymentIntent({ ...baseInput, sequence: 0 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    intentIds.add(first.body.paymentIntentId);

    const second = await authorizePaymentIntent({ ...baseInput, sequence: 1 });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    intentIds.add(second.body.paymentIntentId);
    assert.notEqual(second.body.paymentIntentId, first.body.paymentIntentId);

    const replaySecond = await authorizePaymentIntent({ ...baseInput, sequence: 1 });
    assert.equal(replaySecond.ok, true);
    if (replaySecond.ok) {
      assert.equal(replaySecond.body.paymentIntentId, second.body.paymentIntentId);
      assert.equal(replaySecond.headers["x-idempotent-replay"], "true");
    }
  } finally {
    for (const intentId of intentIds) {
      await valkeyDel(`payment-intent:${intentId}`);
      await valkeySRem(`key-payment-intents:${created.keyId}`, intentId);
    }
    for (const sequence of [0, 1]) {
      await valkeyDel(
        `payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:${sequence}`,
      );
    }
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("a shared request idempotency key does not collapse distinct execution lanes", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const idempotencyKey = `idem-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "parallel-execution-lanes",
  });
  const intentIds = new Set<string>();

  try {
    const baseInput = {
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      idempotencyKey,
      rootRunId,
      sequence: 0,
    } as const;
    const first = await authorizePaymentIntent({ ...baseInput, executionRunId: "sibling-a" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    intentIds.add(first.body.paymentIntentId);

    const second = await authorizePaymentIntent({ ...baseInput, executionRunId: "sibling-b" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    intentIds.add(second.body.paymentIntentId);
    assert.notEqual(second.body.paymentIntentId, first.body.paymentIntentId);

    const replay = await authorizePaymentIntent({ ...baseInput, executionRunId: "sibling-a" });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.body.paymentIntentId, first.body.paymentIntentId);
      assert.equal(replay.headers["x-idempotent-replay"], "true");
    }
  } finally {
    for (const intentId of intentIds) {
      await valkeyDel(`payment-intent:${intentId}`);
      await valkeySRem(`key-payment-intents:${created.keyId}`, intentId);
    }
    for (const executionRunId of ["sibling-a", "sibling-b"]) {
      await valkeyDel(
        `payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${executionRunId}:0`,
      );
    }
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("authorization follows credential validity and unresolved obligations do not expire", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const validitySeconds = 45 * 24 * 60 * 60;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + validitySeconds * 1000,
    purpose: "session",
    network: NETWORK,
    name: "long-running-session",
  });
  let paymentIntentId: string | undefined;
  const idemKey = `payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`;
  const indexKey = `key-payment-intents:${created.keyId}`;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    const minimumLongTtl = 44 * 24 * 60 * 60;
    assert.ok(await valkeyTTL(`payment-intent:${paymentIntentId}`) >= minimumLongTtl);
    assert.ok(await valkeyTTL(indexKey) >= minimumLongTtl);
    assert.ok(await valkeyTTL(idemKey) >= minimumLongTtl);

    const queued = await settlePaymentIntent({ paymentIntentId, finalAmountWei: String(CHECKPOINT_WEI) });
    assert.equal(queued.ok, true);
    assert.equal(await valkeyTTL(`payment-intent:${paymentIntentId}`), -1);
    assert.equal(await valkeyTTL(`key:${created.keyId}`), -1);
    assert.equal(await valkeyTTL(indexKey), -1);
    assert.equal(await valkeyTTL(idemKey), -1);

    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "confirmed";
    const confirmed = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal(confirmed.body.status, "confirmed");
    assert.ok(await valkeyTTL(`key:${created.keyId}`) >= minimumLongTtl,
      "terminal retention must not shorten the longer-lived credential ledger");
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeySRem(indexKey, paymentIntentId);
    }
    await valkeyDel(idemKey);
    await valkeyDel(indexKey);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("ambiguous broadcast recovery reconciles the durable prepared identity before rebroadcast", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "exception-recovery-session",
  });
  let paymentIntentId: string | undefined;
  const previousStatus = process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
  const previousReconcileStatus = process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    await settlePaymentIntent({ paymentIntentId, finalAmountWei: String(CHECKPOINT_WEI) });

    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "throw";
    const execution = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(execution.ok, false);
    let intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    let key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.status, "queued");
    assert.equal(intent.executionClaimToken, undefined);
    assert.equal(intent.executionClaimExpiresAt, undefined);
    assert.ok(intent.preparedTxHash);
    assert.ok(intent.preparedTxPayload);
    assert.equal(intent.txHash, undefined);
    assert.equal(key.budgetReserved, String(CHECKPOINT_WEI));
    assert.equal(key.budgetUsed, "0");

    const preparedTxHash = intent.preparedTxHash;
    const preparedTxPayload = intent.preparedTxPayload;
    await valkeyHSet(`payment-intent:${paymentIntentId}`, "nextAttemptAt", "0");
    process.env.COMPOSE_TEST_SETTLEMENT_STATUS = "queued";
    process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS = "confirmed";
    const retry = await executeCanonicalPaymentIntent(paymentIntentId);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.body.status, "confirmed");
    intent = await valkeyHGetAll(`payment-intent:${paymentIntentId}`);
    key = await valkeyHGetAll(`key:${created.keyId}`);
    assert.equal(intent.preparedTxHash, preparedTxHash);
    assert.equal(intent.preparedTxPayload, preparedTxPayload);
    assert.equal(intent.txHash, preparedTxHash);
    assert.equal(key.budgetReserved, "0");
    assert.equal(key.budgetUsed, String(CHECKPOINT_WEI));
  } finally {
    if (previousStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_STATUS = previousStatus;
    if (previousReconcileStatus === undefined) delete process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS;
    else process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS = previousReconcileStatus;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("fenced signer leases reject a lost owner's prepared transaction persistence", async () => {
  const valkeyModule = await import("../x402/keys/valkey.js") as unknown as {
    valkeyAcquireFencedLease?: (input: {
      leaseKey: string; fenceKey: string; owner: string; ttlMs: number;
    }) => Promise<{ acquired: boolean; value?: string; fence?: number }>;
    valkeyRenewFencedLease?: (leaseKey: string, value: string, ttlMs: number) => Promise<boolean>;
    valkeyReleaseFencedLease?: (leaseKey: string, value: string) => Promise<boolean>;
    valkeyPersistPreparedPaymentIntent?: (input: {
      intentKey: string; claimToken: string; leaseKey: string; leaseValue: string;
      preparedTxHash: string; preparedTxPayload: string; preparedAt: number;
    }) => Promise<string>;
  };
  assert.equal(typeof valkeyModule.valkeyAcquireFencedLease, "function");
  assert.equal(typeof valkeyModule.valkeyRenewFencedLease, "function");
  assert.equal(typeof valkeyModule.valkeyReleaseFencedLease, "function");
  assert.equal(typeof valkeyModule.valkeyPersistPreparedPaymentIntent, "function");
  if (!valkeyModule.valkeyAcquireFencedLease || !valkeyModule.valkeyRenewFencedLease
    || !valkeyModule.valkeyReleaseFencedLease
    || !valkeyModule.valkeyPersistPreparedPaymentIntent) return;

  const suffix = randomUUID();
  const leaseKey = `test:signer-lease:${suffix}`;
  const fenceKey = `test:signer-fence:${suffix}`;
  const intentKey = `test:payment-intent:${suffix}`;
  const claimToken = `claim-${suffix}`;
  try {
    await valkeyHSet(intentKey, { status: "queued", executionClaimToken: claimToken });
    const first = await valkeyModule.valkeyAcquireFencedLease({
      leaseKey, fenceKey, owner: `owner-1-${suffix}`, ttlMs: 5_000,
    });
    assert.equal(first.acquired, true);
    assert.ok(first.value);
    assert.equal(await valkeyModule.valkeyRenewFencedLease(leaseKey, first.value!, 5_000), true);
    assert.equal(await valkeyModule.valkeyReleaseFencedLease(leaseKey, first.value!), true);
    const second = await valkeyModule.valkeyAcquireFencedLease({
      leaseKey, fenceKey, owner: `owner-2-${suffix}`, ttlMs: 5_000,
    });
    assert.equal(second.acquired, true);
    assert.ok((second.fence || 0) > (first.fence || 0));

    const stalePersist = await valkeyModule.valkeyPersistPreparedPaymentIntent({
      intentKey,
      claimToken,
      leaseKey,
      leaseValue: first.value!,
      preparedTxHash: `0x${"56".repeat(32)}`,
      preparedTxPayload: `0x${"78".repeat(32)}`,
      preparedAt: Date.now(),
    });
    assert.equal(stalePersist, "stale_lease");
    assert.equal((await valkeyHGetAll(intentKey)).preparedTxHash, undefined);
    await valkeyModule.valkeyReleaseFencedLease(leaseKey, second.value!);
  } finally {
    await valkeyDel(leaseKey);
    await valkeyDel(fenceKey);
    await valkeyDel(intentKey);
    await closeValkey();
  }
});

test("settlement error classification keeps signer gas and ambiguous RPC failures retryable", async () => {
  const settlementModule = await import("../x402/settlement.js") as unknown as {
    classifySettlementError?: (
      error: unknown,
      context: { network: typeof NETWORK; phase: "prepare" | "broadcast"; txHash?: string },
    ) => { status: string; terminal?: boolean; txHash?: string };
  };
  assert.equal(typeof settlementModule.classifySettlementError, "function");
  if (!settlementModule.classifySettlementError) return;

  const signerGas = settlementModule.classifySettlementError(
    new Error("insufficient funds for gas * price + value"),
    { network: NETWORK, phase: "prepare" },
  );
  assert.equal(signerGas.status, "queued");
  assert.notEqual(signerGas.terminal, true);

  const payerAllowance = settlementModule.classifySettlementError(
    new Error("execution reverted: ERC20: insufficient allowance"),
    { network: NETWORK, phase: "prepare" },
  );
  assert.equal(payerAllowance.status, "failed");
  assert.equal(payerAllowance.terminal, true);

  const preparedHash = `0x${"90".repeat(32)}`;
  const ambiguousBroadcast = settlementModule.classifySettlementError(
    new Error("RPC request timed out"),
    { network: NETWORK, phase: "broadcast", txHash: preparedHash },
  );
  assert.equal(ambiguousBroadcast.status, "queued");
  assert.equal(ambiguousBroadcast.txHash, undefined);
  assert.notEqual(ambiguousBroadcast.terminal, true);
});

test("the settlement worker serializes execution under a hard claim cap", () => {
  const source = readFileSync(new URL("../x402/accumulator/worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Promise\.all\(candidateIds\.map/,
    "worker must not hydrate an unbounded queue eagerly");
  assert.doesNotMatch(source, /Promise\.all\(candidates\.map/,
    "worker must not acquire every candidate claim before network serialization");
  assert.match(source, /MAX_INTENTS_PER_RUN/,
    "caller configuration must be clamped to a hard maximum");
  assert.match(source, /listCanonicalPaymentIntentIds\(boundedScanLimit\)/,
    "the worker must bound candidate selection before hydrating or inspecting intents");
  assert.equal(
    source.match(/executeCanonicalPaymentIntent\([^,\n]+, \{ waitForConfirmation: false \}\)/g)?.length,
    2,
    "scheduled and immediate worker execution must yield after fresh broadcast",
  );
});

test("worker selection uses one deterministic due index and payer-targeted immediate lookup", () => {
  const intentsSource = readFileSync(new URL("../x402/intents.ts", import.meta.url), "utf8");
  const listStart = intentsSource.indexOf("export async function listCanonicalPaymentIntentIds");
  const listEnd = intentsSource.indexOf("export async function removeCanonicalPaymentIntentWorkId", listStart);
  const listSource = intentsSource.slice(listStart, listEnd);
  assert.match(listSource, /valkeyZRangeLiveWorkByScore/);
  assert.doesNotMatch(listSource, /valkeySRandMembers/);

  const workerSource = readFileSync(new URL("../x402/accumulator/worker.ts", import.meta.url), "utf8");
  const immediateStart = workerSource.indexOf("export async function triggerImmediateSettlement");
  const immediateSource = workerSource.slice(immediateStart);
  assert.match(immediateSource, /user-keys:/);
  assert.match(immediateSource, /key-payment-intents:/);
  assert.doesNotMatch(immediateSource, /listCanonicalPaymentIntentIds/);
});

test("terminal Lua uses an O(1) pending obligation counter", () => {
  const source = readFileSync(new URL("../x402/keys/valkey.ts", import.meta.url), "utf8");
  const commitStart = source.indexOf("export async function valkeyCommitReservedBudget");
  const releaseStart = source.indexOf("export async function valkeyReleaseReservedBudget");
  const releaseEnd = source.indexOf("Set key expiration", releaseStart);
  assert.ok(commitStart >= 0 && releaseStart > commitStart && releaseEnd > releaseStart);
  const terminalLua = source.slice(commitStart, releaseEnd);
  assert.match(terminalLua, /pendingIntentCount/);
  assert.doesNotMatch(terminalLua, /SMEMBERS/,
    "terminal scripts must not scan retained credential history in Valkey's event loop");
});

test("an authorized intent cannot become billable after logical credential expiry", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "logical-expiry-session",
  });
  let paymentIntentId: string | undefined;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      maxAmountWei: String(CHECKPOINT_WEI),
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;

    // Redis expiry is not an authorization boundary: model the interval after
    // logical expiry but before the rounded key TTL has physically deleted it.
    await valkeyHSet(`key:${created.keyId}`, "expiresAt", String(Date.now() - 1));
    const settlement = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(settlement.ok, false);
    if (!settlement.ok) assert.equal(settlement.status, 401);
    assert.equal((await valkeyHGetAll(`payment-intent:${paymentIntentId}`)).status, "authorized");
    assert.equal((await valkeyHGetAll(`key:${created.keyId}`)).budgetReserved, "0");
    assert.equal((await valkeySMembers("payment-intents:queued")).includes(paymentIntentId), false);
  } finally {
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeySRem(`key-payment-intents:${created.keyId}`, paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("zero-reservation release is an atomic expected-state transition", async () => {
  const suffix = randomUUID();
  const intentId = `intent-${suffix}`;
  const budgetKey = `test:key:${suffix}`;
  const intentKey = `test:payment-intent:${intentId}`;
  const queuedKey = `test:payment-intents:queued:${suffix}`;
  const submittedKey = `test:payment-intents:submitted:${suffix}`;
  const keyIntentsKey = `test:key-payment-intents:${suffix}`;
  const idempotencyKey = `test:payment-intent-idem:${suffix}`;
  const projectionKey = `test:payment-intent-projections:${suffix}`;
  const dueKey = `test:payment-intents:due:${suffix}`;

  try {
    await valkeyHSet(budgetKey, { budgetReserved: "0", budgetUsed: "0" });
    await valkeyHSet(intentKey, { status: "authorized", reservedAmountWei: "0" });
    await valkeySAdd(keyIntentsKey, intentId);

    const released = await valkeyReleaseReservedBudget({
      budgetKey,
      intentKey,
      queuedKey,
      submittedKey,
      keyIntentsKey,
      idempotencyKey,
      projectionKey,
      dueKey,
      intentId,
      terminalTtlSeconds: 60,
      reservedAmount: 0n,
      expectedStatuses: ["authorized"],
      intentFields: { status: "released", releasedAt: String(Date.now()) },
    });
    assert.equal(released, "released");
    assert.equal((await valkeyHGetAll(intentKey)).status, "released");
    assert.equal((await valkeyHGetAll(budgetKey)).budgetReserved, "0");

    await valkeyHSet(intentKey, { status: "queued", reservedAmountWei: "0" });
    await valkeySAdd(queuedKey, intentId);
    const staleRelease = await valkeyReleaseReservedBudget({
      budgetKey,
      intentKey,
      queuedKey,
      submittedKey,
      keyIntentsKey,
      idempotencyKey,
      projectionKey,
      dueKey,
      intentId,
      terminalTtlSeconds: 60,
      reservedAmount: 0n,
      expectedStatuses: ["authorized"],
      intentFields: { status: "released", releasedAt: String(Date.now()) },
    });
    assert.equal(staleRelease, "invalid_state");
    assert.equal((await valkeyHGetAll(intentKey)).status, "queued");
    assert.equal((await valkeySMembers(queuedKey)).includes(intentId), true);
  } finally {
    await valkeyDel(budgetKey);
    await valkeyDel(intentKey);
    await valkeyDel(queuedKey);
    await valkeyDel(submittedKey);
    await valkeyDel(keyIntentsKey);
    await valkeyDel(idempotencyKey);
    await valkeyDel(projectionKey);
    await valkeyDel(dueKey);
    await closeValkey();
  }
});

test("retry retention rejects a submitted hash that differs from durable prepared identity", async () => {
  const suffix = randomUUID();
  const intentId = `intent-${suffix}`;
  const intentKey = `test:payment-intent:${intentId}`;
  const queuedKey = `test:payment-intents:queued:${suffix}`;
  const submittedKey = `test:payment-intents:submitted:${suffix}`;
  const dueKey = `test:payment-intents:due:${suffix}`;
  const claimToken = `claim-${suffix}`;
  const preparedTxHash = `0x${"ab".repeat(32)}`;
  const differentTxHash = `0x${"cd".repeat(32)}`;

  try {
    await valkeyHSet(intentKey, {
      status: "queued",
      executionClaimToken: claimToken,
      preparedTxHash,
      preparedTxPayload: `0x${"ef".repeat(32)}`,
    });
    await valkeySAdd(queuedKey, intentId);
    const retained = await valkeyRetainClaimedPaymentIntent({
      intentKey,
      queuedKey,
      submittedKey,
      dueKey,
      intentId,
      claimToken,
      status: "submitted",
      txHash: differentTxHash,
      dueAt: Date.now(),
      intentFields: { updatedAt: String(Date.now()) },
    });
    assert.equal(retained, "invalid_state");
    const intent = await valkeyHGetAll(intentKey);
    assert.equal(intent.status, "queued");
    assert.equal(intent.txHash, undefined);
    assert.equal(intent.executionClaimToken, claimToken);
  } finally {
    await valkeyDel(intentKey);
    await valkeyDel(queuedKey);
    await valkeyDel(submittedKey);
    await valkeyDel(dueKey);
    await closeValkey();
  }
});

test("a submitted intent with no retry timestamp remains claimable after owner loss", async () => {
  const suffix = randomUUID();
  const intentKey = `test:payment-intent:${suffix}`;
  const now = Date.now();
  try {
    await valkeyHSet(intentKey, {
      status: "submitted",
      attemptCount: "1",
      nextAttemptAt: "",
      executionClaimToken: `stale-${suffix}`,
      executionClaimExpiresAt: String(now - 1),
    });
    const claimed = await valkeyClaimPaymentIntentExecution({
      intentKey,
      claimToken: `successor-${suffix}`,
      now,
      claimExpiresAt: now + 60_000,
    });
    assert.deepEqual(claimed, { outcome: "claimed", attemptCount: 2 });
  } finally {
    await valkeyDel(intentKey);
    await closeValkey();
  }
});

test("confirmed projection work remains durable until receipt, evidence, and Analytics projections succeed", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "api",
    network: NETWORK,
    name: "projection-outbox-api",
  });
  let paymentIntentId: string | undefined;
  const previousProjectionFailure = process.env.COMPOSE_TEST_PROJECTION_FAILURE;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      maxAmountWei: String(CHECKPOINT_WEI),
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;

    process.env.COMPOSE_TEST_PROJECTION_FAILURE = "true";
    const confirmed = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal(confirmed.body.status, "confirmed");
    assert.equal(
      (await valkeySMembers("payment-intents:projections")).includes(paymentIntentId),
      true,
    );
    assert.equal(await valkeyTTL(`payment-intent:${paymentIntentId}`), -1,
      "terminal identity must remain durable while projection work is pending");

    delete process.env.COMPOSE_TEST_PROJECTION_FAILURE;
    const intentsModule = await import("../x402/intents.js") as unknown as {
      reconcileCanonicalPaymentIntentProjections?: (
        intentId: string,
        dependencies: {
          project(input: Record<string, unknown>): Promise<boolean>;
          publish(domain: string, address: string, reason: string): Promise<void>;
        },
      ) => Promise<boolean>;
    };
    assert.equal(typeof intentsModule.reconcileCanonicalPaymentIntentProjections, "function");
    const analyticsProjections: Record<string, unknown>[] = [];
    assert.equal(await intentsModule.reconcileCanonicalPaymentIntentProjections?.(paymentIntentId, {
      async project(input) {
        analyticsProjections.push(input);
        return true;
      },
      async publish() {},
    }), true);
    assert.equal(analyticsProjections.length, 1);
    assert.equal(analyticsProjections[0]?.paymentIntentId, paymentIntentId);
    assert.equal(analyticsProjections[0]?.status, "confirmed");
    assert.equal(typeof analyticsProjections[0]?.transactionHash, "string");
    assert.equal(typeof analyticsProjections[0]?.confirmedAt, "number");
    assert.equal(
      (await valkeySMembers("payment-intents:projections")).includes(paymentIntentId),
      false,
    );
    assert.ok(await valkeyTTL(`payment-intent:${paymentIntentId}`) >= 30 * 24 * 60 * 60 - 5);
  } finally {
    if (previousProjectionFailure === undefined) delete process.env.COMPOSE_TEST_PROJECTION_FAILURE;
    else process.env.COMPOSE_TEST_PROJECTION_FAILURE = previousProjectionFailure;
    if (paymentIntentId) {
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await valkeyZRem("payment-intents:due", paymentIntentId);
      await valkeySRem("payment-intents:projections", paymentIntentId);
      await valkeySRem(`key-payment-intents:${created.keyId}`, paymentIntentId);
    }
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});

test("due intent selection is deterministic across queued and submitted states", async () => {
  const queuedDue = `queued-due-${randomUUID()}`;
  const queuedLater = `queued-later-${randomUUID()}`;
  const submittedDue = `submitted-due-${randomUUID()}`;
  const submittedLater = `submitted-later-${randomUUID()}`;
  const queuedIds = [queuedDue, queuedLater];
  const submittedIds = [submittedDue, submittedLater];
  const valkey = await getValkeyClient();
  try {
    await valkeySAdd("payment-intents:queued", ...queuedIds);
    await valkeySAdd("payment-intents:submitted", ...submittedIds);
    const now = Date.now();
    await valkey.zadd(
      "payment-intents:due",
      now - 400, queuedDue,
      now - 300, submittedDue,
      now - 200, queuedLater,
      now - 100, submittedLater,
    );
    const ids = await listCanonicalPaymentIntentIds(2);
    assert.deepEqual(ids, [queuedDue, submittedDue],
      "oldest due work must win regardless of queued/submitted state");
  } finally {
    await valkeySRem("payment-intents:queued", ...queuedIds);
    await valkeySRem("payment-intents:submitted", ...submittedIds);
    await valkey.zrem("payment-intents:due", ...queuedIds, ...submittedIds);
    await closeValkey();
  }
});

test("targeted immediate settlement cannot be hidden by unrelated global work", async () => {
  const payer = wallet();
  const rootRunId = `root-${randomUUID()}`;
  const unrelatedIds = Array.from({ length: 101 }, () => `unrelated-${randomUUID()}`);
  const created = await createKey(payer, {
    budgetLimit: BUDGET_WEI,
    expiresAt: Date.now() + 10 * 60_000,
    purpose: "session",
    network: NETWORK,
    name: "targeted-immediate-settlement",
  });
  let paymentIntentId: string | undefined;

  try {
    const authorized = await authorizePaymentIntent({
      authorization: `Bearer ${created.token}`,
      network: NETWORK,
      service: "api",
      action: "inference",
      resource: "https://api.compose.market/external/v1/responses",
      method: "POST",
      useBudgetCap: true,
      rootRunId,
      executionRunId: rootRunId,
      sequence: 0,
    });
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    paymentIntentId = authorized.body.paymentIntentId;
    const queued = await settlePaymentIntent({
      paymentIntentId,
      finalAmountWei: String(CHECKPOINT_WEI),
    });
    assert.equal(queued.ok, true);
    await valkeySAdd("payment-intents:submitted", ...unrelatedIds);

    const result = await triggerImmediateSettlement(payer, NETWORK);
    assert.ok(result);
    assert.equal(result?.paymentIntentId, paymentIntentId);
    assert.equal(result?.status, "confirmed");
  } finally {
    if (paymentIntentId) {
      await abortPaymentIntent({ paymentIntentId, reason: "test cleanup" }).catch(() => undefined);
      await valkeyDel(`payment-intent:${paymentIntentId}`);
      await valkeySRem("payment-intents:queued", paymentIntentId);
      await valkeySRem("payment-intents:submitted", paymentIntentId);
      await (await getValkeyClient()).zrem("payment-intents:due", paymentIntentId);
    }
    await valkeySRem("payment-intents:submitted", ...unrelatedIds);
    await valkeyDel(`payment-intent-idem:${NETWORK}:${created.keyId}:${rootRunId}:${rootRunId}:0`);
    await valkeyDel(`key-payment-intents:${created.keyId}`);
    await valkeySRem(`user-keys:${NETWORK}:${payer.toLowerCase()}`, created.keyId);
    await valkeyDel(`key:${created.keyId}`);
    await valkeyDel(`key:revoked:${created.keyId}`);
    await closeValkey();
  }
});
