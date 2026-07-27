import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createKey, getActiveSessionStatus } from "../x402/keys/storage.js";
import {
  valkeyDel,
  valkeySRem,
  closeValkey,
} from "../x402/keys/valkey.js";
import {
  initializeSessionBudget,
  lockBudget,
  cancelBudgetIntent,
} from "../x402/session/budget.js";

const TEST_NETWORK = "eip155:43113" as const;
const TEST_BUDGET_WEI = 1_000_000;
const TEST_LOCK_WEI = 25_000;
const TEST_MERCHANT = "0x058271e764154c322f3d3ddc18af44f7d91b1c80";

process.env.NODE_ENV = "test";
process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = String(TEST_BUDGET_WEI);

function randomWalletAddress(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function sessionBudgetKey(userAddress: string, network: string): string {
  return `session:budget:${network}:${userAddress}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${userAddress.toLowerCase()}`;
}

function keyRecordKey(keyId: string): string {
  return `key:${keyId}`;
}

function revokedKeyKey(keyId: string): string {
  return `key:revoked:${keyId}`;
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
    const created = await createKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      network: TEST_NETWORK,
      name: "test-session",
    });
    keyId = created.keyId;

    await initializeSessionBudget(
      userAddress,
      TEST_NETWORK,
      String(TEST_BUDGET_WEI),
      expiresAt,
    );

    const locked = await lockBudget(
      userAddress,
      TEST_NETWORK,
      String(TEST_LOCK_WEI),
      TEST_MERCHANT,
      randomUUID(),
      "test-model",
    );

    assert.equal(locked.success, true);
    assert.ok(locked.intentId);
    intentId = locked.intentId ?? null;

    const status = await getActiveSessionStatus(userAddress, TEST_NETWORK);

    assert.ok(status.session, "expected an active session");
    assert.equal(status.session?.keyId, keyId);
    assert.equal(status.session?.budgetLimit, TEST_BUDGET_WEI);
    assert.equal(status.session?.budgetLocked, TEST_LOCK_WEI);
    assert.equal(status.session?.budgetUsed, 0);
    assert.equal(status.session?.budgetRemaining, TEST_BUDGET_WEI - TEST_LOCK_WEI);
  } finally {
    if (intentId) {
      await cancelBudgetIntent(intentId, "test-cleanup");
      await valkeyDel(intentKey(intentId));
      await valkeySRem("intents:pending", intentId);
      await valkeySRem(userIntentsKey(userAddress), intentId);
    }

    if (keyId) {
      await valkeyDel(keyRecordKey(keyId));
      await valkeyDel(revokedKeyKey(keyId));
      await valkeySRem(userKeysKey(userAddress), keyId);
    }

    await valkeyDel(sessionBudgetKey(userAddress, TEST_NETWORK));
    await closeValkey();
  }
});
