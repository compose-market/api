import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createComposeKey, getActiveSessionStatus } from "../x402/keys/storage.js";
import {
  redisDel,
  redisSRem,
  closeRedis,
} from "../x402/keys/redis.js";
import {
  initializeSessionBudget,
  lockBudget,
  cancelBudgetIntent,
} from "../x402/session-budget.js";

const TEST_CHAIN_ID = 43113;
const TEST_BUDGET_WEI = 1_000_000;
const TEST_LOCK_WEI = 25_000;
const TEST_MERCHANT = "0x058271e764154c322f3d3ddc18af44f7d91b1c80";

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

function intentKey(intentId: string): string {
  return `intent:${intentId}`;
}

function userIntentsKey(userAddress: string): string {
  return `session:budget:${userAddress.toLowerCase()}:intents`;
}

test("getActiveSessionStatus reflects session-budget locks for active session tokens", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  let keyId: string | null = null;
  let intentId: string | null = null;

  try {
    const created = await createComposeKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      chainId: TEST_CHAIN_ID,
      name: "test-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const locked = await lockBudget(
      userAddress,
      TEST_CHAIN_ID,
      String(TEST_LOCK_WEI),
      TEST_MERCHANT,
      randomUUID(),
      "test-model",
    );

    assert.equal(locked.success, true);
    assert.ok(locked.intentId);
    intentId = locked.intentId ?? null;

    const status = await getActiveSessionStatus(userAddress, TEST_CHAIN_ID);

    assert.ok(status.session, "expected an active session");
    assert.equal(status.session?.keyId, keyId);
    assert.equal(status.session?.budgetLimit, TEST_BUDGET_WEI);
    assert.equal(status.session?.budgetLocked, TEST_LOCK_WEI);
    assert.equal(status.session?.budgetUsed, 0);
    assert.equal(status.session?.budgetRemaining, TEST_BUDGET_WEI - TEST_LOCK_WEI);
  } finally {
    if (intentId) {
      await cancelBudgetIntent(intentId, "test-cleanup");
      await redisDel(intentKey(intentId));
      await redisSRem("intents:pending", intentId);
      await redisSRem(userIntentsKey(userAddress), intentId);
    }

    if (keyId) {
      await redisDel(composeKeyRecordKey(keyId));
      await redisDel(revokedComposeKeyKey(keyId));
      await redisSRem(userKeysKey(userAddress), keyId);
    }

    await redisDel(sessionBudgetKey(userAddress, TEST_CHAIN_ID));
    await closeRedis();
  }
});
