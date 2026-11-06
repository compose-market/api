import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import {
  getSessionFundingReadiness,
  resolveSessionAllowanceSpenderAddress,
} from "../x402/session/allowance.js";
import { getNetwork } from "../x402/configs/chains.js";

const TEST_NETWORK = "eip155:84532" as const;
const TEST_PAYER = "0x1111111111111111111111111111111111111111";
const COMPOSE_SETTLEMENT_SPENDER = "0x89Caf60b0E742B9299E14d611B205870207B5cE3";

test("Tempo readiness uses the advertised OpenUSD asset and names it in funding errors", async () => {
  const definition = getNetwork("eip155:42431");
  assert.equal(definition.asset.symbol, "OUSD");
  assert.equal(definition.asset.name, "OpenUSD");
  const result = await getSessionFundingReadiness({ userAddress: TEST_PAYER, network: definition.id, requiredBudgetWei: 1_000_000 }, {
    resolveSpender: () => COMPOSE_SETTLEMENT_SPENDER,
    readBalanceWei: async () => 0n,
    readAllowanceWei: async () => 0n,
  });
  assert.equal(result.asset, definition.asset.address);
  assert.equal(result.reason, "insufficient_balance");
  assert.match(result.error ?? "", /OUSD/);
});

test("EVM readiness uses the configured public Compose settlement spender", () => {
  const spender = resolveSessionAllowanceSpenderAddress({
    TREASURY_SERVER_WALLET_PUBLIC: COMPOSE_SETTLEMENT_SPENDER,
  } as NodeJS.ProcessEnv);

  assert.equal(spender, COMPOSE_SETTLEMENT_SPENDER);
});

test("funding readiness reports RPC failure instead of inventing zero allowance", async () => {
  const result = await getSessionFundingReadiness({
    userAddress: TEST_PAYER,
    network: TEST_NETWORK,
    requiredBudgetWei: 1_000_000,
  }, {
    resolveSpender: () => COMPOSE_SETTLEMENT_SPENDER,
    readBalanceWei: async () => {
      throw new Error("Arc RPC unavailable");
    },
    readAllowanceWei: async () => 1_000_000n,
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "rpc_unavailable");
  assert.equal(result.network, TEST_NETWORK);
  assert.equal(result.payer, TEST_PAYER);
  assert.equal(result.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(result.requiredWei, "1000000");
  assert.equal(result.spender, COMPOSE_SETTLEMENT_SPENDER);
  assert.equal(result.balanceWei, undefined);
  assert.equal(result.allowanceWei, "1000000");
  assert.match(result.error || "", /Arc RPC unavailable/);
});

test("funding readiness returns observed balance and allowance for insufficiency", async () => {
  const result = await getSessionFundingReadiness({
    userAddress: TEST_PAYER,
    network: TEST_NETWORK,
    requiredBudgetWei: 1_000_000,
  }, {
    resolveSpender: () => COMPOSE_SETTLEMENT_SPENDER,
    readBalanceWei: async () => 2_000_000n,
    readAllowanceWei: async () => 750_000n,
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "insufficient_allowance");
  assert.equal(result.network, TEST_NETWORK);
  assert.equal(result.payer, TEST_PAYER);
  assert.equal(result.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(result.requiredWei, "1000000");
  assert.equal(result.balanceWei, "2000000");
  assert.equal(result.allowanceWei, "750000");
  assert.equal(result.spender, COMPOSE_SETTLEMENT_SPENDER);
});
