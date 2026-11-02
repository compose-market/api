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

  async consume(key: string, _ttlSeconds: number): Promise<boolean> {
    if (this.used.has(key)) return false;
    this.used.add(key);
    return true;
  }
}

test("NEAR chain configurations define canonical CAIP-2 identifiers, NEP-141 USDC assets, and explorer links without RPC fallbacks", () => {
  assert.equal(NETWORK_IDS.nearTestnet, "near:testnet");
  assert.equal(NETWORK_IDS.near, "near:mainnet");

  const testnetDef = getNetwork(NEAR_TESTNET);
  assert.equal(testnetDef.namespace, "near");
  assert.equal(testnetDef.environment, "testnet");
  assert.equal(testnetDef.rpcEnvVar, "NEAR_TESTNET_RPC");
  assert.equal(
    testnetDef.asset.address,
    "usdc.tidepool-sandbox.testnet",
  );
  assert.equal(testnetDef.asset.decimals, 6);
  assert.equal(testnetDef.asset.symbol, "USDC");

  const mainnetDef = getNetwork(NEAR_MAINNET);
  assert.equal(mainnetDef.namespace, "near");
  assert.equal(mainnetDef.environment, "mainnet");
  assert.equal(mainnetDef.rpcEnvVar, "NEAR_MAINNET_RPC");
  assert.equal(
    mainnetDef.asset.address,
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  );
  assert.equal(mainnetDef.asset.decimals, 6);
  assert.equal(mainnetDef.asset.symbol, "USDC");

  assert.equal(isNearNetwork(NEAR_TESTNET), true);
  assert.equal(isNearNetwork(NEAR_MAINNET), true);
  assert.equal(isNearNetwork("eip155:8453"), false);
  assert.equal(isNearNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);

  assert.equal(isTestnetNetwork(NEAR_TESTNET), true);
  assert.equal(isTestnetNetwork(NEAR_MAINNET), false);
  assert.equal(isServiceAllowedNetwork(NEAR_MAINNET), true);
  // TEMP(near:testnet): temporary E2E exception alongside Base Sepolia; flip back to false/true when locking exclusively to near:mainnet.
  assert.equal(isServiceAllowedNetwork(NEAR_TESTNET), true);
  assert.equal(isServiceBlockedNetwork(NEAR_TESTNET), false);
  assert.equal(isServiceBlockedNetwork(NEAR_MAINNET), false);

  assert.equal(
    getExplorerUrl(NEAR_TESTNET, "tx", "9abc123TxHash"),
    "https://testnet.nearblocks.io/txns/9abc123TxHash",
  );
  assert.equal(
    getExplorerUrl(NEAR_MAINNET, "tx", "9abc123TxHash"),
    "https://nearblocks.io/txns/9abc123TxHash",
  );

  delete process.env.NEAR_TESTNET_RPC;
  delete process.env.NEAR_MAINNET_RPC;
  assert.throws(() => getNetworkRpcUrl(NEAR_TESTNET), /NEAR_TESTNET_RPC/);
  assert.throws(() => getNetworkRpcUrl(NEAR_MAINNET), /NEAR_MAINNET_RPC/);
});

test("validateNearAddress accepts canonical universal, implicit, and named NEAR accounts while rejecting malformed addresses", () => {
  const universalBody = "0123456789abcdefghjkmnpqrstvwxyz".repeat(2).slice(0, 51);
  assert.equal(validateNearAddress(`0u${universalBody}0`), true);
  assert.equal(validateNearAddress(`0u${universalBody}g`), true);
  assert.equal(validateNearAddress("a".repeat(64)), true);
  assert.equal(validateNearAddress("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"), true);
  assert.equal(validateNearAddress("alice.near"), true);
  assert.equal(validateNearAddress("bob_1-2.testnet"), true);
  assert.equal(validateNearAddress("relayer.compose.near"), true);
  assert.equal(validateNearAddress("0user.near"), true);

  assert.equal(validateNearAddress(`0u${universalBody.slice(1)}0`), false);
  assert.equal(validateNearAddress(`0u${universalBody}00`), false);
  assert.equal(validateNearAddress(`0u${universalBody}0`.toUpperCase()), false);
  assert.equal(validateNearAddress(`0u${universalBody.replace("a", "A")}0`), false);
  for (const symbol of ["i", "l", "o", "u"]) {
    assert.equal(validateNearAddress(`0u${symbol}${universalBody.slice(1)}0`), false);
  }
  for (const symbol of ["1", "f", "h", "z"]) {
    assert.equal(validateNearAddress(`0u${universalBody}${symbol}`), false);
  }

  assert.equal(validateNearAddress(""), false);
  assert.equal(validateNearAddress("a"), false);
  assert.equal(validateNearAddress("Alice.near"), false);
  assert.equal(validateNearAddress("0x1111111111111111111111111111111111111111"), false);
  assert.equal(validateNearAddress("-invalid.near"), false);
  assert.equal(validateNearAddress("invalid..near"), false);
  assert.equal(validateNearAddress("a".repeat(65)), false);
});

test("createPaymentRequirement emits spec-compliant NEAR requirements across all 3 schemes and fails closed without env vars", () => {
  process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC = FEE_PAYER;
  process.env.NEAR_MERCHANT_WALLET_ADDRESS = MERCHANT;

  for (const network of [NEAR_TESTNET, NEAR_MAINNET] as const) {
    for (const scheme of ["exact", "upto", "batch-settlement"] as const) {
      const req = createPaymentRequirement({
        amountWei: "2500",
        network,
        scheme,
      });
      assert.equal(req.scheme, scheme);
      assert.equal(req.network, network);
      assert.equal(req.amount, "2500");
      assert.equal(req.asset, getNetwork(network).asset.address);
      assert.equal(req.payTo, MERCHANT);
      assert.deepEqual(req.extra, { feePayer: FEE_PAYER });
    }
  }

  delete process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC;
  assert.throws(
    () => createPaymentRequirement({ amountWei: "100", network: NEAR_TESTNET, scheme: "exact" }),
    /NEAR_TREASURY_SERVER_WALLET_PUBLIC/,
  );
  process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC = FEE_PAYER;

  delete process.env.NEAR_MERCHANT_WALLET_ADDRESS;
  assert.throws(
    () => createPaymentRequirement({ amountWei: "100", network: NEAR_MAINNET, scheme: "upto" }),
    /NEAR_MERCHANT_WALLET_ADDRESS/,
  );
  process.env.NEAR_MERCHANT_WALLET_ADDRESS = MERCHANT;
});

test("NEAR native 3-scheme parity lives in the existing x402 modules", () => {
  assert.match(FACILITATOR_SOURCE, /new ExactNearFacilitator\(signer\)/);
  assert.match(FACILITATOR_SOURCE, /new UptoNearFacilitator\(feePayer\)/);
  assert.match(FACILITATOR_SOURCE, /new BatchSettlementNearFacilitator\(feePayer\)/);
  assert.match(FACILITATOR_SOURCE, /NEAR_FACILITATOR_KEY/);
  assert.match(FACILITATOR_SOURCE, /NEAR_TREASURY_SERVER_WALLET_PUBLIC/);
  assert.match(FACILITATOR_SOURCE, /NEAR_MERCHANT_WALLET_ADDRESS/);

  assert.match(BATCH_SOURCE, /export async function validateNearBatchPayment/);
  assert.match(BATCH_SOURCE, /export async function rememberNearBatchChannel/);
  assert.match(BATCH_SOURCE, /export async function commitNearBatchCharge/);
  assert.match(BATCH_SOURCE, /export async function runNearBatchSettlement/);

  assert.match(SETTLEMENT_SOURCE, /async function prepareNearKeyPayment/);
  assert.match(ALLOWANCE_SOURCE, /async function readNearDelegateAllowanceWei/);
  assert.match(ALLOWANCE_SOURCE, /async function readNearUsdcBalanceWei/);
  assert.match(INDEX_SOURCE, /runNearBatchSettlement/);
});

test("UptoNearFacilitator verifies implicit 64-hex account Ed25519 signatures, settles NEP-141 transfers, and blocks nonce replay", async () => {
  const keyPair = KeyPair.fromRandom("ed25519");
  const payer = implicitAccountFromKeyPair(keyPair);
  const nonceStore = new MemoryNonceStore();
  const settlements: Array<{ payer: string; amount: string; network: string }> = [];

  const facilitator = new UptoNearFacilitator(
    FEE_PAYER,
    async (settledPayer, amountWei, network) => {
      settlements.push({ payer: settledPayer, amount: String(amountWei), network });
      return {
        success: true,
        status: "confirmed",
        txHash: "NearUptoConfirmedTxHash123",
      };
    },
    nonceStore,
  );

  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: NEAR_TESTNET,
    asset: getNetwork(NEAR_TESTNET).asset.address,
    amount: "750",
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
  };

  const authorization = {
    scheme: "upto" as const,
    network: NEAR_TESTNET,
    asset: requirements.asset,
    payTo: MERCHANT,
    resource: RESOURCE_URL,
    payer,
    maxAmount: "1000",
    nonce: "nonce-implicit-001",
    deadline: Math.floor(Date.now() / 1000) + 300,
  };

  const messageBytes = new TextEncoder().encode(
    canonicalJson({
      asset: authorization.asset,
      deadline: String(authorization.deadline),
      maxAmount: authorization.maxAmount,
      network: authorization.network,
      nonce: authorization.nonce,
      payTo: authorization.payTo,
      payer: authorization.payer,
      resource: authorization.resource,
      scheme: authorization.scheme,
    }),
  );
  const signature = signNearMessage(keyPair, messageBytes);

  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepted: { ...requirements, amount: "1000" },
    payload: {
      authorization,
      signature,
    },
  };

  const verified = await facilitator.verify(payload, requirements);
  assert.equal(verified.isValid, true);
  assert.equal(verified.payer, payer);

  const settled = await facilitator.settle(payload, requirements);
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, "NearUptoConfirmedTxHash123");
  assert.equal(settled.payer, payer);
  assert.deepEqual(settlements, [{ payer, amount: "750", network: NEAR_TESTNET }]);

  // Replay with same nonce must fail closed
  const replayedVerify = await facilitator.verify(payload, requirements);
  assert.equal(replayedVerify.isValid, false);
  assert.equal(replayedVerify.invalidReason, "duplicate_authorization");

  const replayedSettle = await facilitator.settle(payload, requirements);
  assert.equal(replayedSettle.success, false);
  assert.equal(replayedSettle.errorReason, "duplicate_authorization");
});

test("UptoNearFacilitator verifies named NEAR account signatures against on-chain access keys and rejects unowned publicKeyHint", async () => {
  const ownerKeyPair = KeyPair.fromRandom("ed25519");
  const attackerKeyPair = KeyPair.fromRandom("ed25519");
  const namedPayer = "alice.testnet";

  const rpcServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const rpcReq = JSON.parse(body) as { id: string | number };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcReq.id,
          result: {
            block_height: 12345,
            block_hash: "11111111111111111111111111111111",
            keys: [
              {
                public_key: ownerKeyPair.getPublicKey().toString(),
                access_key: { nonce: 1, permission: "FullAccess" },
              },
            ],
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  const { port } = rpcServer.address() as AddressInfo;
  process.env.NEAR_TESTNET_RPC = `http://127.0.0.1:${port}`;

  try {
    const facilitator = new UptoNearFacilitator(
      FEE_PAYER,
      async () => ({ success: true, status: "confirmed", txHash: "NamedAccountTxHash" }),
      new MemoryNonceStore(),
    );

    const requirements: PaymentRequirements = {
      scheme: "upto",
      network: NEAR_TESTNET,
      asset: getNetwork(NEAR_TESTNET).asset.address,
      amount: "500",
      payTo: MERCHANT,
      maxTimeoutSeconds: 300,
      extra: { feePayer: FEE_PAYER },
    };

    const authorization = {
      scheme: "upto" as const,
      network: NEAR_TESTNET,
      asset: requirements.asset,
      payTo: MERCHANT,
      resource: RESOURCE_URL,
      payer: namedPayer,
      maxAmount: "1000",
      nonce: "nonce-named-001",
      deadline: Math.floor(Date.now() / 1000) + 300,
    };

    const messageBytes = new TextEncoder().encode(
      canonicalJson({
        asset: authorization.asset,
        deadline: String(authorization.deadline),
        maxAmount: authorization.maxAmount,
        network: authorization.network,
        nonce: authorization.nonce,
        payTo: authorization.payTo,
        payer: authorization.payer,
        resource: authorization.resource,
        scheme: authorization.scheme,
      }),
    );

    // 1. Forged signature using attackerKeyPair + attacker publicKeyHint must be rejected
    const forgedPayload: PaymentPayload = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepted: { ...requirements, amount: "1000" },
      payload: {
        authorization: {
          ...authorization,
          publicKey: attackerKeyPair.getPublicKey().toString(),
        },
        signature: signNearMessage(attackerKeyPair, messageBytes),
      },
    };
    const forgedVerify = await facilitator.verify(forgedPayload, requirements);
    assert.equal(forgedVerify.isValid, false);
    assert.equal(forgedVerify.invalidReason, "invalid_signature");

    // 2. Valid signature from on-chain ownerKeyPair succeeds
    const validPayload: PaymentPayload = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepted: { ...requirements, amount: "1000" },
      payload: {
        authorization,
        signature: signNearMessage(ownerKeyPair, messageBytes),
      },
    };
    const validVerify = await facilitator.verify(validPayload, requirements);
    assert.equal(validVerify.isValid, true);
    assert.equal(validVerify.payer, namedPayer);
  } finally {
    await new Promise<void>((resolve, reject) => rpcServer.close((err) => (err ? reject(err) : resolve())));
  }
});