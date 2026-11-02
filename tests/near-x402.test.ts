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

test("BatchSettlementNearFacilitator verifies signed vouchers and queues batch settlement deltas", async () => {
  const keyPair = KeyPair.fromRandom("ed25519");
  const payer = implicitAccountFromKeyPair(keyPair);
  const asset = getNetwork(NEAR_TESTNET).asset.address;
  const salt = `0x${"ab".repeat(32)}`;

  const channelConfig = {
    payer,
    receiver: MERCHANT,
    token: asset,
    salt,
    network: NEAR_TESTNET,
    resource: RESOURCE_URL,
  };

  const channelId = `0x${createHash("sha256")
    .update(canonicalJson(channelConfig))
    .digest("hex")}`;

  const maxClaimableAmount = "5000";
  const voucherMessage = new TextEncoder().encode(
    canonicalJson({
      channelConfig,
      type: "voucher",
      voucher: {
        channelId,
        maxClaimableAmount,
      },
    }),
  );
  const signature = signNearMessage(keyPair, voucherMessage);

  const requirements: PaymentRequirements = {
    scheme: "batch-settlement",
    network: NEAR_TESTNET,
    asset,
    amount: "1200",
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
  };

  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepted: { ...requirements, amount: maxClaimableAmount },
    payload: {
      type: "voucher",
      channelConfig,
      voucher: {
        channelId,
        maxClaimableAmount,
        signature,
      },
    },
  };

  const facilitator = new BatchSettlementNearFacilitator(
    FEE_PAYER,
    async (_payload, amountWei) => ({
      channelId,
      cumulativeAmountWei: amountWei,
    }),
    (candidatePayload, candidateReq) =>
      validateNearBatchPayment(candidatePayload, candidateReq, async () => null),
  );

  const settled = await facilitator.settle(payload, requirements);
  assert.equal(settled.success, true);
  assert.equal(settled.payer, payer);
  assert.equal(settled.transaction, "");
  assert.deepEqual(settled.extra, {
    settlementStatus: "queued",
    channelId,
    cumulativeAmountWei: "1200",
  });
});

test("runNearBatchSettlement executes the durable attempt state machine identically to SVM", async () => {
  const { runNearBatchSettlement } = await import("../x402/batch.js");

  type Attempt = {
    status: "preparing" | "prepared" | "submitted" | "failed";
    settledCumulativeAmountWei: string;
    claimedCumulativeAmountWei: string;
    deltaWei: string;
    txHash?: string;
    payload?: string;
    nonce?: string;
    error?: string;
    preparedAt?: number;
    submittedAt?: number;
    lastCheckedAt?: number;
    failedAt?: number;
    receiptsReconciledAt?: number;
    receiptsReconciledCount?: number;
    evidenceReconciledAt?: number;
    evidenceReconciledCount?: number;
  };

  type Channel = {
    channelId: string;
    payer: string;
    network: NearNetworkId;
    asset: string;
    payTo: string;
    resource: string;
    signedMaxClaimable: string;
    chargedCumulativeAmount: string;
    settledCumulativeAmount: string;
    balance: string;
    signature: string;
    channelConfigFingerprint: string;
    backingFingerprint: string;
    createdAt: number;
    lastRequestTimestamp: number;
    lastTxHash?: string;
  };

  type Stored = {
    channel: Channel;
    attempt?: Attempt;
    ownerToken?: string;
    ownerExpiresAt?: number;
  };

  const records = new Map<string, Stored>();
  const pending = new Set<string>();

  const seeded: Channel = {
    channelId: "0xnearchannel001",
    payer: "alice.testnet",
    network: NEAR_TESTNET,
    asset: getNetwork(NEAR_TESTNET).asset.address,
    payTo: MERCHANT,
    resource: RESOURCE_URL,
    signedMaxClaimable: "5000",
    chargedCumulativeAmount: "400",
    settledCumulativeAmount: "100",
    balance: "5000",
    signature: "ed25519:sig",
    channelConfigFingerprint: "cfg-fp",
    backingFingerprint: "back-fp",
    createdAt: 1,
    lastRequestTimestamp: 1,
  };
  records.set(seeded.channelId, { channel: structuredClone(seeded) });
  pending.add(seeded.channelId);

  const store = {
    async listPendingChannelIds() {
      return [...pending];
    },
    async acquireAttempt(input: { channelId: string; ownerToken: string; now: number; ownerExpiresAt: number }) {
      const record = records.get(input.channelId);
      if (!record) return { outcome: "missing" as const };
      if (!record.attempt) {
        const charged = BigInt(record.channel.chargedCumulativeAmount);
        const settled = BigInt(record.channel.settledCumulativeAmount);
        record.attempt = {
          status: "preparing",
          settledCumulativeAmountWei: settled.toString(),
          claimedCumulativeAmountWei: charged.toString(),
          deltaWei: (charged - settled).toString(),
        };
      }
      record.ownerToken = input.ownerToken;
      record.ownerExpiresAt = input.ownerExpiresAt;
      return { outcome: "acquired" as const, work: structuredClone({ channel: record.channel, attempt: record.attempt }) };
    },
    async persistPreparedAttempt(input: {
      channelId: string;
      ownerToken: string;
      prepared: { network: NearNetworkId; txHash: string; payload: string; nonce?: string };
      preparedAt: number;
    }) {
      const record = records.get(input.channelId);
      if (!record || record.ownerToken !== input.ownerToken || !record.attempt) return null;
      record.attempt = {
        ...record.attempt,
        status: "prepared",
        txHash: input.prepared.txHash,
        payload: input.prepared.payload,
        ...(input.prepared.nonce ? { nonce: input.prepared.nonce } : {}),
        preparedAt: input.preparedAt,
      };
      return structuredClone({ channel: record.channel, attempt: record.attempt });
    },
    async markAttemptSubmitted(input: { channelId: string; ownerToken: string; txHash: string; submittedAt: number; error?: string }) {
      const record = records.get(input.channelId);
      if (!record || record.ownerToken !== input.ownerToken || !record.attempt) return null;
      record.attempt = {
        ...record.attempt,
        status: "submitted",
        submittedAt: input.submittedAt,
        ...(input.error ? { error: input.error } : {}),
      };
      return structuredClone({ channel: record.channel, attempt: record.attempt });
    },
    async releaseAttemptClaim(input: { channelId: string; ownerToken: string; expectedStatus: "prepared" | "submitted"; checkedAt: number; error: string }) {
      const record = records.get(input.channelId);
      if (!record || record.ownerToken !== input.ownerToken || record.attempt?.status !== input.expectedStatus) return false;
      record.attempt.lastCheckedAt = input.checkedAt;
      record.attempt.error = input.error;
      delete record.ownerToken;
      delete record.ownerExpiresAt;
      return true;
    },
    async abandonPreparation() {
      return true;
    },
    async markAttemptReconciled(input: { channelId: string; ownerToken: string; kind: "receipts" | "evidence"; count: number; reconciledAt: number }) {
      const record = records.get(input.channelId);
      if (!record || record.ownerToken !== input.ownerToken || !record.attempt) return null;
      if (input.kind === "receipts") {
        record.attempt.receiptsReconciledAt = input.reconciledAt;
        record.attempt.receiptsReconciledCount = input.count;
      } else {
        record.attempt.evidenceReconciledAt = input.reconciledAt;
        record.attempt.evidenceReconciledCount = input.count;
      }
      return structuredClone({ channel: record.channel, attempt: record.attempt });
    },
    async markAttemptFailed() {
      return null;
    },
    async completeConfirmedAttempt(input: { channelId: string; ownerToken: string; txHash: string; completedAt: number }) {
      const record = records.get(input.channelId);
      if (!record || record.ownerToken !== input.ownerToken || !record.attempt) {
        return { completed: false, hasMore: true };
      }
      record.channel.settledCumulativeAmount = record.attempt.claimedCumulativeAmountWei;
      record.channel.lastTxHash = input.txHash;
      record.channel.lastRequestTimestamp = input.completedAt;
      delete record.attempt;
      delete record.ownerToken;
      delete record.ownerExpiresAt;
      pending.delete(input.channelId);
      return { completed: true, hasMore: false };
    },
  };

  let clock = 1000;
  let loseFirstBroadcast = true;
  let prepareCalls = 0;

  const preparedTx = {
    network: NEAR_TESTNET,
    txHash: "NearBatchSettlementTxHash999",
    payload: "SignedBorshNearTransactionBase64==",
    nonce: "42",
  };

  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `near-owner-${clock}`,
    prepareKeyPaymentForNetwork: async (payer: string, amountWei: string, network: string) => {
      prepareCalls += 1;
      assert.equal(payer, "alice.testnet");
      assert.equal(amountWei, "300");
      assert.equal(network, NEAR_TESTNET);
      return { success: true as const, prepared: preparedTx };
    },
    broadcastPreparedKeyPaymentForNetwork: async () => {
      if (loseFirstBroadcast) {
        loseFirstBroadcast = false;
        throw new Error("network timeout after broadcast");
      }
      return { success: false as const, status: "submitted" as const, txHash: preparedTx.txHash };
    },
    reconcileKeyPaymentForNetwork: async (txHash: string) => ({
      success: true as const,
      status: "confirmed" as const,
      txHash,
    }),
    markBatchReceiptsSettled: async () => 1,
    markBatchEvidenceSettled: async () => 1,
  };

  // Run 1: prepares transaction and persists identity before lost broadcast
  await runNearBatchSettlement(dependencies as never);
  const afterFirst = records.get(seeded.channelId)!;
  assert.equal(afterFirst.attempt?.status, "prepared");
  assert.equal(afterFirst.attempt?.txHash, preparedTx.txHash);
  assert.equal(afterFirst.attempt?.nonce, "42");
  assert.equal(afterFirst.channel.settledCumulativeAmount, "100");

  // Run 2: reuses prepared transaction without re-preparing, confirms, and settles cumulative amount
  const secondSummary = await runNearBatchSettlement(dependencies as never);
  assert.equal(prepareCalls, 1);
  const afterSecond = records.get(seeded.channelId)!;
  assert.equal(afterSecond.attempt, undefined);
  assert.equal(afterSecond.channel.settledCumulativeAmount, "400");
  assert.equal(afterSecond.channel.lastTxHash, preparedTx.txHash);
  assert.equal(pending.has(seeded.channelId), false);
  assert.deepEqual(secondSummary.channels, [
    {
      channelId: seeded.channelId,
      payer: "alice.testnet",
      network: NEAR_TESTNET,
      settledAmountWei: "300",
      claimedAmountWei: "400",
      txHash: preparedTx.txHash,
      reconciledReceipts: 1,
      reconciledEvidence: 1,
    },
  ]);
});

test("NEAR session funding readiness resolves NEAR_TREASURY_SERVER_WALLET_PUBLIC and fails closed without it", async () => {
  process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC = FEE_PAYER;

  const readyResult = await getSessionFundingReadiness(
    {
      userAddress: "alice.testnet",
      network: NEAR_TESTNET,
      requiredBudgetWei: 1_000_000,
    },
    {
      readBalanceWei: async () => 5_000_000n,
      readAllowanceWei: async () => 10_000_000n,
    },
  );
  assert.equal(readyResult.ready, true);
  assert.equal(readyResult.network, NEAR_TESTNET);
  assert.equal(readyResult.spender, FEE_PAYER);
  assert.equal(readyResult.asset, getNetwork(NEAR_TESTNET).asset.address);

  delete process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC;
  const missingSpenderResult = await getSessionFundingReadiness(
    {
      userAddress: "alice.testnet",
      network: NEAR_MAINNET,
      requiredBudgetWei: 1_000_000,
    },
    {
      readBalanceWei: async () => 5_000_000n,
      readAllowanceWei: async () => 10_000_000n,
    },
  );
  assert.equal(missingSpenderResult.ready, false);
  assert.equal(missingSpenderResult.reason, "network_configuration_error");
  assert.match(missingSpenderResult.error || "", /NEAR_TREASURY_SERVER_WALLET_PUBLIC/);
  process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC = FEE_PAYER;
});