import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import { KeyPair } from "@near-js/crypto";
import { base58 } from "@scure/base";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { validateNearBatchPayment } from "../x402/batch.js";
import {
  getExplorerUrl,
  getNetwork,
  getNetworkRpcUrl,
  isAddressValidForNetwork,
  isNearNetwork,
  isServiceAllowedNetwork,
  isServiceBlockedNetwork,
  isTestnetNetwork,
  NETWORK_IDS,
  validateNearAddress,
  validateSolanaAddress,
  type NearNetworkId,
} from "../x402/configs/chains.js";
import {
  BatchSettlementNearFacilitator,
  createPaymentRequirement,
  getFacilitatorSupported,
  UptoNearFacilitator,
} from "../x402/facilitator.js";
import { getSessionFundingReadiness } from "../x402/session/allowance.js";

const FACILITATOR_SOURCE = await readFile(new URL("../x402/facilitator.ts", import.meta.url), "utf8");
const BATCH_SOURCE = await readFile(new URL("../x402/batch.ts", import.meta.url), "utf8");
const SETTLEMENT_SOURCE = await readFile(new URL("../x402/settlement.ts", import.meta.url), "utf8");
const ALLOWANCE_SOURCE = await readFile(new URL("../x402/session/allowance.ts", import.meta.url), "utf8");
const INDEX_SOURCE = await readFile(new URL("../x402/index.ts", import.meta.url), "utf8");

const NEAR_TESTNET: NearNetworkId = "near:testnet";
const NEAR_MAINNET: NearNetworkId = "near:mainnet";
const FEE_PAYER = "compose-relayer.testnet";
const MERCHANT = "compose-merchant.testnet";
const RESOURCE_URL = "https://api.compose.market/models";

const ORIGINAL_ENV = {
  NEAR_TESTNET_RPC: process.env.NEAR_TESTNET_RPC,
  NEAR_MAINNET_RPC: process.env.NEAR_MAINNET_RPC,
  NEAR_FACILITATOR_KEY: process.env.NEAR_FACILITATOR_KEY,
  NEAR_FACILITATOR_ACCOUNT: process.env.NEAR_FACILITATOR_ACCOUNT,
  NEAR_TREASURY_SERVER_WALLET_PUBLIC: process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC,
  NEAR_MERCHANT_WALLET_ADDRESS: process.env.NEAR_MERCHANT_WALLET_ADDRESS,
  NEAR_TESTNET_FACILITATOR_ACCOUNT: process.env.NEAR_TESTNET_FACILITATOR_ACCOUNT,
  NEAR_TESTNET_TREASURY_SERVER_WALLET_PUBLIC: process.env.NEAR_TESTNET_TREASURY_SERVER_WALLET_PUBLIC,
  NEAR_TESTNET_MERCHANT_WALLET_ADDRESS: process.env.NEAR_TESTNET_MERCHANT_WALLET_ADDRESS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

before(() => {
  process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC = FEE_PAYER;
  process.env.NEAR_MERCHANT_WALLET_ADDRESS = MERCHANT;
  delete process.env.NEAR_FACILITATOR_ACCOUNT;
  delete process.env.NEAR_TESTNET_FACILITATOR_ACCOUNT;
  delete process.env.NEAR_TESTNET_TREASURY_SERVER_WALLET_PUBLIC;
  delete process.env.NEAR_TESTNET_MERCHANT_WALLET_ADDRESS;
});

after(() => {
  restoreEnv();
});

function orderedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(input)
    .filter((key) => input[key] !== undefined)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const value = input[key];
      acc[key] = value && typeof value === "object" && !Array.isArray(value)
        ? orderedRecord(value as Record<string, unknown>)
        : value;
      return acc;
    }, {});
}

function canonicalJson(input: Record<string, unknown>): string {
  return JSON.stringify(orderedRecord(input));
}

function implicitAccountFromKeyPair(keyPair: KeyPair): string {
  return Buffer.from(keyPair.getPublicKey().data).toString("hex");
}

function signNearMessage(keyPair: KeyPair, message: Uint8Array): string {
  const signed = keyPair.sign(message);
  return `ed25519:${base58.encode(signed.signature)}`;
}

class MemoryNonceStore {
  private readonly used = new Set<string>();

  async has(key: string): Promise<boolean> {
    return this.used.has(key);
  }
}