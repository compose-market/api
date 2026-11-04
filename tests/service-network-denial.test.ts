import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { handler } from "../handler.js";
import { getFacilitatorSupported } from "../x402/facilitator.js";
import { isServiceAllowedNetwork, isServiceBlockedNetwork, isTestnetNetwork } from "../x402/configs/chains.js";

const ORIGINAL_ENV = {
  FACILITATOR_KEY: process.env.FACILITATOR_KEY,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  AVALANCHE_MAINNET_RPC: process.env.AVALANCHE_MAINNET_RPC,
  SOLANA_MAINNET_RPC: process.env.SOLANA_MAINNET_RPC,
  SVM_TREASURY_SERVER_WALLET_PUBLIC: process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC,
};

function createEvent(
  method: string,
  rawPath: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: { ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

before(() => {
  process.env.FACILITATOR_KEY = ORIGINAL_ENV.FACILITATOR_KEY || `0x${"11".repeat(32)}`;
  process.env.MERCHANT_WALLET_ADDRESS =
    ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC =
    ORIGINAL_ENV.SVM_TREASURY_SERVER_WALLET_PUBLIC || "11111111111111111111111111111111";
  delete process.env.SOLANA_MAINNET_RPC;
});

after(() => {
  if (ORIGINAL_ENV.FACILITATOR_KEY) process.env.FACILITATOR_KEY = ORIGINAL_ENV.FACILITATOR_KEY;
  if (ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS) process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS;
  if (ORIGINAL_ENV.AVALANCHE_MAINNET_RPC) process.env.AVALANCHE_MAINNET_RPC = ORIGINAL_ENV.AVALANCHE_MAINNET_RPC;
  if (ORIGINAL_ENV.SOLANA_MAINNET_RPC) process.env.SOLANA_MAINNET_RPC = ORIGINAL_ENV.SOLANA_MAINNET_RPC;
  if (ORIGINAL_ENV.SVM_TREASURY_SERVER_WALLET_PUBLIC) process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC = ORIGINAL_ENV.SVM_TREASURY_SERVER_WALLET_PUBLIC;
});

test("facilitator still supports all testnets for third-party products", async () => {
  const supported = await getFacilitatorSupported();
  const networks = new Set(supported.kinds.map((k) => k.network));

  // Third-party testnets MUST be supported by facilitator
  assert.ok(networks.has("eip155:421614"), "Arbitrum Sepolia in facilitator");
  assert.ok(networks.has("eip155:43113"), "Avalanche Fuji in facilitator");
  assert.ok(networks.has("eip155:1328"), "Sei Testnet in facilitator");
  assert.ok(networks.has("eip155:42431"), "Tempo Moderato in facilitator");
  assert.ok(networks.has("eip155:84532"), "Base Sepolia in facilitator");
  assert.ok(networks.has("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), "Solana Devnet in facilitator");

  // Mainnets must also be in facilitator
  assert.ok(networks.has("eip155:8453"), "Base mainnet in facilitator");
  assert.ok(networks.has("eip155:42161"), "Arbitrum mainnet in facilitator");
  assert.ok(networks.has("eip155:43114"), "Avalanche mainnet in facilitator");
  assert.ok(networks.has("eip155:5042"), "Arc mainnet in facilitator");
  assert.ok(networks.has("eip155:1329"), "Sei mainnet in facilitator");
});