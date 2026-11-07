import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  closeValkey,
  valkeyDel,
  valkeyExists,
  valkeySRem,
} from "../x402/keys/valkey.js";

const TEST_NETWORK = "eip155:84532" as const;
const TEST_BUDGET_WEI = 1_000_000;
const TEST_SPENDER = "0x89Caf60b0E742B9299E14d611B205870207B5cE3";

function randomWalletAddress(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function sessionBudgetKey(userAddress: string): string {
  return `session:budget:${TEST_NETWORK}:${userAddress.toLowerCase()}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${TEST_NETWORK}:${userAddress.toLowerCase()}`;
}

function createSessionEvent(userAddress: string) {
  return {
    rawPath: "/api/keys",
    requestContext: { http: { method: "POST" } },
    headers: {
      "x-session-user-address": userAddress,
      "x-network-id": TEST_NETWORK,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      budgetLimit: TEST_BUDGET_WEI,
      expiresAt: Date.now() + 10 * 60 * 1000,
      purpose: "session",
      name: "route-session",
    }),
  };
}

test("Session creation initializes only the key-owned durable budget", async () => {
  const originalBalance = process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
  const originalAllowance = process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
  const originalSpender = process.env.TREASURY_SERVER_WALLET_PUBLIC;
  const userAddress = randomWalletAddress();
  let keyId: string | undefined;

  try {
    process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = String(TEST_BUDGET_WEI);
    process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = String(TEST_BUDGET_WEI);
    process.env.TREASURY_SERVER_WALLET_PUBLIC = TEST_SPENDER;
    const { handler } = await import("../handler.js");

    const response = await handler(createSessionEvent(userAddress), {});
    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body) as Record<string, string>;
    keyId = body.keyId;
    assert.ok(keyId);
    assert.equal(body.budgetUsed, "0");
    assert.equal(body.budgetReserved, "0");
    assert.equal(body.budgetLocked, "0");
    assert.equal(body.budgetRemaining, String(TEST_BUDGET_WEI));
    assert.equal(await valkeyExists(sessionBudgetKey(userAddress)), false);
  } finally {
    if (keyId) {
      await valkeyDel(`key:${keyId}`);
      await valkeyDel(`key:revoked:${keyId}`);
      await valkeySRem(userKeysKey(userAddress), keyId);
    }
    await valkeyDel(userKeysKey(userAddress));
    await valkeyDel(sessionBudgetKey(userAddress));
    if (originalBalance === undefined) delete process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = originalBalance;
    if (originalAllowance === undefined) delete process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = originalAllowance;
    if (originalSpender === undefined) delete process.env.TREASURY_SERVER_WALLET_PUBLIC;
    else process.env.TREASURY_SERVER_WALLET_PUBLIC = originalSpender;
    await closeValkey();
  }
});

test("Session creation reports RPC failure separately from insufficient allowance", async () => {
  const originalBalance = process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
  const originalAllowance = process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
  const originalSpender = process.env.TREASURY_SERVER_WALLET_PUBLIC;
  const userAddress = randomWalletAddress();

  try {
    process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = String(TEST_BUDGET_WEI);
    process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = "rpc-read-failed";
    process.env.TREASURY_SERVER_WALLET_PUBLIC = TEST_SPENDER;
    const { handler } = await import("../handler.js");

    const response = await handler(createSessionEvent(userAddress), {});
    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body) as {
      code?: string;
      details?: Record<string, string>;
    };
    assert.equal(body.code, "rpc_unavailable");
    assert.equal(body.details?.network, TEST_NETWORK);
    assert.equal(body.details?.payer, userAddress);
    assert.equal(body.details?.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    assert.equal(body.details?.requiredWei, String(TEST_BUDGET_WEI));
    assert.equal(body.details?.balanceWei, String(TEST_BUDGET_WEI));
    assert.equal(body.details?.allowanceWei, undefined);
    assert.equal(body.details?.spender, TEST_SPENDER);
  } finally {
    await valkeyDel(userKeysKey(userAddress));
    await valkeyDel(sessionBudgetKey(userAddress));
    if (originalBalance === undefined) delete process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI = originalBalance;
    if (originalAllowance === undefined) delete process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI;
    else process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI = originalAllowance;
    if (originalSpender === undefined) delete process.env.TREASURY_SERVER_WALLET_PUBLIC;
    else process.env.TREASURY_SERVER_WALLET_PUBLIC = originalSpender;
    await closeValkey();
  }
});
