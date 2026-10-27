import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  createKey,
  getActiveSessionStatus,
  revokeKey,
} from "../x402/keys/storage.js";
import {
  closeValkey,
  valkeyDel,
  valkeyExists,
  valkeyHGetAll,
  valkeyHSet,
  valkeySAdd,
  valkeySIsMember,
  valkeySRem,
} from "../x402/keys/valkey.js";

const TEST_NETWORK = "eip155:84532" as const;
const TEST_BUDGET_WEI = 1_000_000;

process.env.NODE_ENV = "test";

function randomWalletAddress(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function sessionBudgetKey(userAddress: string): string {
  return `session:budget:${TEST_NETWORK}:${userAddress.toLowerCase()}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${TEST_NETWORK}:${userAddress.toLowerCase()}`;
}

function keyRecordKey(keyId: string): string {
  return `key:${keyId}`;
}

function revokedKeyKey(keyId: string): string {
  return `key:revoked:${keyId}`;
}

function keyIntentIndexKey(keyId: string): string {
  return `key-payment-intents:${keyId}`;
}

function paymentIntentKey(intentId: string): string {
  return `payment-intent:${intentId}`;
}

async function cleanupKeyState(userAddress: string, keyIds: string[], intentIds: string[] = []): Promise<void> {
  await Promise.all(intentIds.map((intentId) => valkeyDel(paymentIntentKey(intentId))));
  await Promise.all(keyIds.flatMap((keyId) => [
    valkeyDel(keyRecordKey(keyId)),
    valkeyDel(revokedKeyKey(keyId)),
    valkeyDel(keyIntentIndexKey(keyId)),
    valkeySRem(userKeysKey(userAddress), keyId),
  ]));
  await valkeyDel(userKeysKey(userAddress));
  await valkeyDel(sessionBudgetKey(userAddress));
}

test("getActiveSessionStatus uses only the durable key ledger", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  let keyId: string | null = null;
  const previousAllowanceOverride = process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;

  try {
    const created = await createKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      network: TEST_NETWORK,
      name: "durable-session",
    });
    keyId = created.keyId;

    await valkeyHSet(keyRecordKey(keyId), {
      budgetUsed: "125000",
      budgetReserved: "25000",
    });

    // A legacy payer-wide record and a broken live allowance reader must not
    // participate in Session identity or overwrite the key-owned ledger.
    await valkeyHSet(sessionBudgetKey(userAddress), {
      userAddress: userAddress.toLowerCase(),
      network: TEST_NETWORK,
      totalBudgetWei: "9000000",
      lockedBudgetWei: "8000000",
      usedBudgetWei: "500000",
      expiresAt: String(expiresAt),
      createdAt: String(Date.now()),
    });
    process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = "rpc-must-not-be-read";

    const status = await getActiveSessionStatus(userAddress, TEST_NETWORK);

    assert.ok(status.session, "expected the durable Session key to remain active");
    assert.equal(status.session.keyId, keyId);
    assert.equal(status.session.budgetLimit, TEST_BUDGET_WEI);
    assert.equal(status.session.budgetUsed, 125_000);
    assert.equal(status.session.budgetLocked, 25_000);
    assert.equal(status.session.budgetRemaining, 850_000);

    const { handler } = await import("../handler.js");
    const response = await handler({
      rawPath: "/api/session",
      requestContext: { http: { method: "GET" } },
      headers: {
        "x-session-user-address": userAddress,
        "x-network-id": TEST_NETWORK,
      },
    }, {});
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    assert.equal(body.hasSession, true);
    assert.equal(body.keyId, keyId);
    assert.equal(body.budgetLimit, String(TEST_BUDGET_WEI));
    assert.equal(body.budgetUsed, "125000");
    assert.equal(body.budgetReserved, "25000");
    assert.equal(body.budgetLocked, "25000");
    assert.equal(body.budgetRemaining, "850000");
  } finally {
    if (previousAllowanceOverride === undefined) {
      delete process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
    } else {
      process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = previousAllowanceOverride;
    }
    await cleanupKeyState(userAddress, keyId ? [keyId] : []);
    await closeValkey();
  }
});

test("revocation removes the active index and releases only pre-billing canonical intents", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  let keyId: string | null = null;
  const intentIds = {
    authorized: randomUUID(),
    reserved: randomUUID(),
    queued: randomUUID(),
    submitted: randomUUID(),
  };

  try {
    const created = await createKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      network: TEST_NETWORK,
      name: "revoked-session",
    });
    keyId = created.keyId;

    await valkeyHSet(keyRecordKey(keyId), "budgetReserved", "60000");
    await valkeySAdd(keyIntentIndexKey(keyId), ...Object.values(intentIds));
    await Promise.all([
      valkeyHSet(paymentIntentKey(intentIds.authorized), {
        paymentIntentId: intentIds.authorized,
        keyId,
        status: "authorized",
        reservedAmountWei: "0",
      }),
      valkeyHSet(paymentIntentKey(intentIds.reserved), {
        paymentIntentId: intentIds.reserved,
        keyId,
        status: "reserved",
        reservedAmountWei: "10000",
      }),
      valkeyHSet(paymentIntentKey(intentIds.queued), {
        paymentIntentId: intentIds.queued,
        keyId,
        status: "queued",
        reservedAmountWei: "20000",
      }),
      valkeyHSet(paymentIntentKey(intentIds.submitted), {
        paymentIntentId: intentIds.submitted,
        keyId,
        status: "submitted",
        reservedAmountWei: "30000",
      }),
    ]);

    assert.equal(await revokeKey(keyId, userAddress), true);

    const key = await valkeyHGetAll(keyRecordKey(keyId));
    assert.ok(Number(key.revokedAt) > 0);
    assert.equal(key.budgetReserved, "50000");
    assert.equal(await valkeyExists(revokedKeyKey(keyId)), true);
    assert.equal(await valkeySIsMember(userKeysKey(userAddress), keyId), false);

    const authorized = await valkeyHGetAll(paymentIntentKey(intentIds.authorized));
    const reserved = await valkeyHGetAll(paymentIntentKey(intentIds.reserved));
    const queued = await valkeyHGetAll(paymentIntentKey(intentIds.queued));
    const submitted = await valkeyHGetAll(paymentIntentKey(intentIds.submitted));
    assert.equal(authorized.status, "released");
    assert.equal(reserved.status, "released");
    assert.equal(queued.status, "queued");
    assert.equal(submitted.status, "submitted");
  } finally {
    await cleanupKeyState(userAddress, keyId ? [keyId] : [], Object.values(intentIds));
    await closeValkey();
  }
});

test("a replacement Session owns an independent zeroed durable ledger", async () => {
  const userAddress = randomWalletAddress();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const keyIds: string[] = [];

  try {
    const previous = await createKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      network: TEST_NETWORK,
      name: "previous-session",
    });
    keyIds.push(previous.keyId);
    await valkeyHSet(keyRecordKey(previous.keyId), {
      budgetUsed: "400000",
      budgetReserved: "200000",
    });
    assert.equal(await revokeKey(previous.keyId, userAddress), true);

    const replacement = await createKey(userAddress, {
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt,
      purpose: "session",
      network: TEST_NETWORK,
      name: "replacement-session",
    });
    keyIds.push(replacement.keyId);

    const status = await getActiveSessionStatus(userAddress, TEST_NETWORK);
    assert.ok(status.session);
    assert.equal(status.session.keyId, replacement.keyId);
    assert.equal(status.session.budgetUsed, 0);
    assert.equal(status.session.budgetLocked, 0);
    assert.equal(status.session.budgetRemaining, TEST_BUDGET_WEI);
  } finally {
    await cleanupKeyState(userAddress, keyIds);
    await closeValkey();
  }
});
