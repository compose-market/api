import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PaymentPayload } from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import type { Request, Response } from "express";

import * as batchModule from "../x402/batch.js";
import { getNetwork, NETWORK_IDS, type NetworkId } from "../x402/configs/chains.js";
import {
  rawBatchCheckpointField,
  readRawEnvelope,
  resolveRawBatchBacking,
  saveRawEnvelope,
} from "../x402/envelope.js";
import { prepareInferencePayment } from "../x402/index.js";
import { closeValkey, valkeyDel, valkeyExists, valkeyExpire, valkeyHGetAll, valkeyHSet, valkeySRem } from "../x402/keys/valkey.js";
import { merchantWalletAddress } from "../x402/wallets.js";

const NETWORK: NetworkId = "eip155:84532";
const PAYER = "0x1111111111111111111111111111111111111111";
const RECEIVER = merchantWalletAddress;

type RawBatchCheckpointCommitter = (input: {
  paymentPayload: PaymentPayload;
  requirements: PaymentPayload["accepted"];
  amountWei: string;
  rootRunId: string;
  executionRunId: string;
  sequence: number;
}) => Promise<{
  channelId: string;
  cumulativeAmountWei: string;
  checkpointSequence: number;
  replayed: boolean;
}>;

function checkpointKey(input: {
  network: NetworkId;
  channelId: string;
  rootRunId: string;
  executionRunId: string;
  sequence: number;
}): string {
  return [
    "x402:raw-batch-checkpoint",
    encodeURIComponent(input.network),
    input.network.startsWith("eip155:") ? input.channelId.toLowerCase() : input.channelId,
    encodeURIComponent(input.rootRunId),
    encodeURIComponent(input.executionRunId),
    String(input.sequence),
  ].join(":");
}

function checkpointOwnerKey(input: {
  network: NetworkId;
  channelId: string;
  rootRunId: string;
}): string {
  return [
    "x402:raw-batch-checkpoint-owner",
    encodeURIComponent(input.network),
    input.network.startsWith("eip155:") ? input.channelId.toLowerCase() : input.channelId,
    encodeURIComponent(input.rootRunId),
  ].join(":");
}

async function checkpointRecord(input: {
  network: NetworkId;
  channelId: string;
  rootRunId: string;
  executionRunId: string;
  sequence: number;
}): Promise<Record<string, unknown>> {
  const envelope = await valkeyHGetAll(`x402:envelope:${input.rootRunId}`);
  const encoded = envelope[rawBatchCheckpointField(input)];
  return encoded ? JSON.parse(encoded) as Record<string, unknown> : {};
}

after(async () => {
  await closeValkey();
});

function paymentPayload(input: {
  scheme: "exact" | "upto" | "batch-settlement";
  amountWei?: string;
  channelId?: string;
  resource?: string;
}): PaymentPayload {
  const amountWei = input.amountWei || "1000";
  const channelId = input.channelId || `0x${"33".repeat(32)}`;
  const resource = input.resource || "https://api.compose.market/agent/test/stream";
  const accepted = {
    scheme: input.scheme,
    network: NETWORK,
    asset: getNetwork(NETWORK).asset.address,
    amount: amountWei,
    payTo: RECEIVER,
    maxTimeoutSeconds: 300,
    extra: {},
  };

  if (input.scheme !== "batch-settlement") {
    return {
      x402Version: 2,
      resource: { url: resource },
      accepted,
      payload: { signature: `0x${"44".repeat(65)}` },
    } as PaymentPayload;
  }

  return {
    x402Version: 2,
    resource: { url: resource },
    accepted,
    payload: {
      type: "voucher",
      channelConfig: {
        payer: PAYER,
        payerAuthorizer: PAYER,
        receiver: RECEIVER,
        receiverAuthorizer: RECEIVER,
        token: getNetwork(NETWORK).asset.address,
        withdrawDelay: 900,
        salt: `0x${"55".repeat(32)}`,
      },
      voucher: {
        channelId,
        maxClaimableAmount: amountWei,
        signature: `0x${"66".repeat(65)}`,
      },
    },
  } as PaymentPayload;
}

function rawRequest(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    headers: normalized,
    method: "POST",
    path: "/agent/test/stream",
    originalUrl: "/agent/test/stream",
    url: "/agent/test/stream",
    body: {},
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

function responseStub(capturedHeaders?: Record<string, string>): Response {
  return {
    setHeader(name: string, value: number | string | readonly string[]) {
      if (capturedHeaders) capturedHeaders[name] = String(value);
      return this;
    },
    status() {
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
}

test("an existing EVM channel refreshes authoritative chain capacity from voucher verification", async () => {
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const initial = paymentPayload({ scheme: "batch-settlement", channelId, amountWei: "1000" });
  const refreshed = structuredClone(initial);
  (refreshed.payload as { voucher: { maxClaimableAmount: string; signature: string } }).voucher.maxClaimableAmount = "6000";
  (refreshed.payload as { voucher: { maxClaimableAmount: string; signature: string } }).voucher.signature = `0x${"77".repeat(65)}`;

  try {
    await batchModule.rememberBatchChannel(initial, initial.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "5000", totalClaimed: "4000", withdrawRequestedAt: 0, refundNonce: 0 },
    });
    const before = await batchModule.getBatchChannelStorage().get(channelId);

    await batchModule.rememberBatchChannel(refreshed, refreshed.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "4999", withdrawRequestedAt: 0, refundNonce: 1 },
    });
    const after = await batchModule.getBatchChannelStorage().get(channelId);

    assert.equal(after?.chargedCumulativeAmount, before?.chargedCumulativeAmount);
    assert.equal(after?.balance, "10000");
    assert.equal(after?.totalClaimed, "4999");
    assert.equal(after?.refundNonce, 1);
    assert.ok(after?.onchainSyncedAt);
  } finally {
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("raw exact and upto payloads are never persisted as inheritable envelopes", async () => {
  for (const scheme of ["exact", "upto"] as const) {
    const rootRunId = `raw-single-use-${scheme}-${randomUUID()}`;
    try {
      await assert.rejects(
        saveRawEnvelope({
          rootRunId,
          maxAmountWei: "1000",
          network: NETWORK,
          paymentPayload: paymentPayload({ scheme }),
          payer: PAYER,
        }),
        /batch-settlement/i,
      );
      assert.equal(await readRawEnvelope(rootRunId), null);
    } finally {
      await valkeyDel(`x402:envelope:${rootRunId}`);
    }
  }
});

test("legacy exact and upto envelope records are not inheritable", async () => {
  for (const scheme of ["exact", "upto"] as const) {
    const rootRunId = `raw-legacy-single-use-${scheme}-${randomUUID()}`;
    const target = `x402:envelope:${rootRunId}`;
    try {
      await valkeyHSet(target, {
        rootRunId,
        maxAmountWei: "1000",
        network: NETWORK,
        paymentPayload: JSON.stringify(paymentPayload({ scheme })),
        usedWei: "0",
        payer: PAYER,
      });
      assert.equal(await readRawEnvelope(rootRunId), null);
    } finally {
      await valkeyDel(target);
    }
  }
});

test("a raw batch envelope rejects changed signed voucher backing for the same root", async () => {
  const rootRunId = `raw-backing-${randomUUID()}`;
  const original = paymentPayload({ scheme: "batch-settlement" });
  const changed = structuredClone(original);
  const changedRaw = changed.payload as {
    voucher: { signature: string };
  };
  changedRaw.voucher.signature = `0x${"77".repeat(65)}`;

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: original,
      payer: PAYER,
    });

    await assert.rejects(
      saveRawEnvelope({
        rootRunId,
        maxAmountWei: "1000",
        network: NETWORK,
        paymentPayload: changed,
        payer: PAYER,
      }),
      /immutable.*backing|backing.*mismatch/i,
    );

    assert.deepEqual((await readRawEnvelope(rootRunId))?.paymentPayload, original);
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
  }
});

test("a raw batch checkpoint atomically records envelope, channel, and durable identity", async () => {
  const rootRunId = `raw-atomic-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const identity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };
  const commitRawBatchCheckpoint = (batchModule as unknown as {
    commitRawBatchCheckpoint?: RawBatchCheckpointCommitter;
  }).commitRawBatchCheckpoint;

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: {
        balance: "1000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: 0,
      },
    });

    assert.equal(typeof commitRawBatchCheckpoint, "function");
    const committed = await commitRawBatchCheckpoint!({
      paymentPayload: payload,
      requirements: payload.accepted,
      amountWei: "125",
      rootRunId,
      executionRunId,
      sequence: 0,
    });

    assert.deepEqual(committed, {
      channelId: channelId.toLowerCase(),
      cumulativeAmountWei: "125",
      checkpointSequence: 0,
      replayed: false,
    });
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "125");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "125");
    assert.deepEqual(await checkpointRecord(identity), {
      network: NETWORK,
      channelId: channelId.toLowerCase(),
      rootRunId,
      executionRunId,
      sequence: 0,
      amountWei: "125",
      cumulativeAmountWei: "125",
      backingFingerprint: (await readRawEnvelope(rootRunId))!.backingFingerprint,
    });
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("an identical raw batch checkpoint replay returns its original cumulative result without charging twice", async () => {
  const rootRunId = `raw-replay-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const identity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };
  const commit = (batchModule as unknown as {
    commitRawBatchCheckpoint: RawBatchCheckpointCommitter;
  }).commitRawBatchCheckpoint;

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });
    const input = {
      paymentPayload: payload,
      requirements: payload.accepted,
      amountWei: "125",
      rootRunId,
      executionRunId,
      sequence: 0,
    };

    const first = await commit(input);
    const replay = await commit(input);

    assert.equal(first.cumulativeAmountWei, "125");
    assert.equal(first.replayed, false);
    assert.equal(replay.cumulativeAmountWei, "125");
    assert.equal(replay.replayed, true);
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "125");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "125");
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("later raw batch checkpoints keep every earlier identity replay-protected for the envelope lifetime", async () => {
  const rootRunId = `raw-replay-lifetime-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const firstIdentity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };
  const secondIdentity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 1 };
  const firstInput = {
    paymentPayload: payload,
    requirements: payload.accepted,
    amountWei: "125",
    rootRunId,
    executionRunId,
    sequence: 0,
  };

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    await batchModule.commitRawBatchCheckpoint(firstInput);
    assert.equal(await valkeyExpire(`x402:envelope:${rootRunId}`, 1), true);

    const second = await batchModule.commitRawBatchCheckpoint({
      ...firstInput,
      amountWei: "75",
      sequence: 1,
    });
    assert.equal(second.cumulativeAmountWei, "200");
    await delay(1_100);
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "200");

    const replay = await batchModule.commitRawBatchCheckpoint(firstInput);
    assert.deepEqual({
      replayed: replay.replayed,
      replayCumulativeAmountWei: replay.cumulativeAmountWei,
      envelopeUsedWei: (await readRawEnvelope(rootRunId))?.usedWei,
      channelChargedCumulativeAmount: (await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount,
    }, {
      replayed: true,
      replayCumulativeAmountWei: "125",
      envelopeUsedWei: "200",
      channelChargedCumulativeAmount: "200",
    });
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("raw batch checkpoint replay state lives in the envelope hash without per-checkpoint TTL fanout", async () => {
  const rootRunId = `raw-envelope-owned-replay-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const identity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };
  const legacyCheckpointKey = checkpointKey(identity);
  const legacyOwnerKey = checkpointOwnerKey(identity);

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    await batchModule.commitRawBatchCheckpoint({
      paymentPayload: payload,
      requirements: payload.accepted,
      amountWei: "125",
      rootRunId,
      executionRunId,
      sequence: 0,
    });

    const envelopeData = await valkeyHGetAll(`x402:envelope:${rootRunId}`);
    const checkpointData = JSON.parse(envelopeData[rawBatchCheckpointField(identity)] || "null") as {
      amountWei?: string;
      cumulativeAmountWei?: string;
    } | null;
    assert.deepEqual(checkpointData, {
      network: NETWORK,
      channelId: channelId.toLowerCase(),
      rootRunId,
      executionRunId,
      sequence: 0,
      amountWei: "125",
      cumulativeAmountWei: "125",
      backingFingerprint: (await readRawEnvelope(rootRunId))!.backingFingerprint,
    });
    assert.equal(await valkeyExists(legacyCheckpointKey), false);
    assert.equal(await valkeyExists(legacyOwnerKey), false);
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await valkeyDel(legacyCheckpointKey);
    await valkeyDel(legacyOwnerKey);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("simultaneous identical raw batch checkpoint identities commit exactly once", async () => {
  const rootRunId = `raw-simultaneous-replay-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const identity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };
  const input = {
    paymentPayload: payload,
    requirements: payload.accepted,
    amountWei: "125",
    rootRunId,
    executionRunId,
    sequence: 0,
  };

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const committed = await Promise.all(
      Array.from({ length: 12 }, () => batchModule.commitRawBatchCheckpoint(input)),
    );

    assert.deepEqual(new Set(committed.map((entry) => entry.cumulativeAmountWei)), new Set(["125"]));
    assert.equal(committed.filter((entry) => !entry.replayed).length, 1);
    assert.equal(committed.filter((entry) => entry.replayed).length, 11);
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "125");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "125");
    assert.equal((await checkpointRecord(identity)).cumulativeAmountWei, "125");
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("independent roots share one identical immutable channel backing", async () => {
  const firstRootRunId = `raw-shared-channel-a-${randomUUID()}`;
  const secondRootRunId = `raw-shared-channel-b-${randomUUID()}`;
  const executionRunId = `shared-execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const firstIdentity = {
    network: NETWORK,
    channelId,
    rootRunId: firstRootRunId,
    executionRunId,
    sequence: 0,
  };
  const secondIdentity = {
    network: NETWORK,
    channelId,
    rootRunId: secondRootRunId,
    executionRunId,
    sequence: 0,
  };

  try {
    await Promise.all([
      saveRawEnvelope({
        rootRunId: firstRootRunId,
        maxAmountWei: "1000",
        network: NETWORK,
        paymentPayload: payload,
        payer: PAYER,
      }),
      saveRawEnvelope({
        rootRunId: secondRootRunId,
        maxAmountWei: "1000",
        network: NETWORK,
        paymentPayload: payload,
        payer: PAYER,
      }),
    ]);
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const first = await batchModule.commitRawBatchCheckpoint({
      paymentPayload: payload,
      requirements: payload.accepted,
      amountWei: "40",
      rootRunId: firstRootRunId,
      executionRunId,
      sequence: 0,
    });
    const second = await batchModule.commitRawBatchCheckpoint({
      paymentPayload: payload,
      requirements: payload.accepted,
      amountWei: "60",
      rootRunId: secondRootRunId,
      executionRunId,
      sequence: 0,
    });

    const firstEnvelope = await readRawEnvelope(firstRootRunId);
    const secondEnvelope = await readRawEnvelope(secondRootRunId);
    const firstCheckpoint = await checkpointRecord(firstIdentity);
    const secondCheckpoint = await checkpointRecord(secondIdentity);
    assert.ok(firstEnvelope?.backingFingerprint);
    assert.ok(secondEnvelope?.backingFingerprint);
    assert.equal(first.cumulativeAmountWei, "40");
    assert.equal(second.cumulativeAmountWei, "100");
    assert.equal(firstEnvelope.usedWei, "40");
    assert.equal(secondEnvelope.usedWei, "60");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "100");
    assert.equal(firstCheckpoint.backingFingerprint, firstEnvelope.backingFingerprint);
    assert.equal(secondCheckpoint.backingFingerprint, secondEnvelope.backingFingerprint);
    assert.equal(firstCheckpoint.backingFingerprint, secondCheckpoint.backingFingerprint);
  } finally {
    await valkeyDel(`x402:envelope:${firstRootRunId}`);
    await valkeyDel(`x402:envelope:${secondRootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("an inherited raw batch lane serializes checkpoints with canonical queued metadata", async () => {
  const rootRunId = `raw-lane-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const prepared = await prepareInferencePayment(
      rawRequest({
        "x-network-id": NETWORK,
        "x-run-id": rootRunId,
        "x-execution-run-id": executionRunId,
      }),
      responseStub(),
      { useBudgetCap: true, scheme: "batch-settlement" },
    );
    assert.ok(prepared);

    const settlements = await Promise.all([
      prepared.settle({ finalAmountWei: "100" }),
      prepared.settle({ finalAmountWei: "50" }),
    ]);

    assert.equal(settlements[0]?.success, true, settlements[0]?.error || "first checkpoint failed");
    assert.equal(settlements[1]?.success, true, settlements[1]?.error || "second checkpoint failed");
    assert.deepEqual(settlements.map((settlement) => ({
      success: settlement.success,
      settlementStatus: settlement.settlementStatus,
      paymentChannelId: settlement.paymentChannelId,
      paymentCumulativeAmountWei: settlement.paymentCumulativeAmountWei,
      checkpointSequence: settlement.checkpointSequence,
      rootRunId: settlement.rootRunId,
      executionRunId: settlement.executionRunId,
      txHash: settlement.txHash,
      settledAt: settlement.settledAt,
    })), [
      {
        success: true,
        settlementStatus: "queued",
        paymentChannelId: channelId.toLowerCase(),
        paymentCumulativeAmountWei: "100",
        checkpointSequence: 0,
        rootRunId,
        executionRunId,
        txHash: undefined,
        settledAt: undefined,
      },
      {
        success: true,
        settlementStatus: "queued",
        paymentChannelId: channelId.toLowerCase(),
        paymentCumulativeAmountWei: "150",
        checkpointSequence: 1,
        rootRunId,
        executionRunId,
        txHash: undefined,
        settledAt: undefined,
      },
    ]);
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("sibling inherited requests under one execution settle independently with distinct idempotency keys", async () => {
  const rootRunId = `raw-sibling-idem-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const firstPrepared = await prepareInferencePayment(
      rawRequest({
        "x-network-id": NETWORK,
        "x-run-id": rootRunId,
        "x-execution-run-id": executionRunId,
        "x-idempotency-key": `${rootRunId}:call-1`,
      }),
      responseStub(),
      { useBudgetCap: true, scheme: "batch-settlement" },
    );
    const secondPrepared = await prepareInferencePayment(
      rawRequest({
        "x-network-id": NETWORK,
        "x-run-id": rootRunId,
        "x-execution-run-id": executionRunId,
        "x-idempotency-key": `${rootRunId}:call-2`,
      }),
      responseStub(),
      { useBudgetCap: true, scheme: "batch-settlement" },
    );
    assert.ok(firstPrepared);
    assert.ok(secondPrepared);

    const first = await firstPrepared.settle({ finalAmountWei: "120" });
    const second = await secondPrepared.settle({ finalAmountWei: "45" });

    assert.equal(first.success, true, first.error || "first sibling checkpoint failed");
    assert.equal(second.success, true, second.error || "second sibling checkpoint replayed against the first");
    assert.equal(first.paymentCumulativeAmountWei, "120");
    assert.equal(second.paymentCumulativeAmountWei, "165");
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "165");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "165");
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("a retried inherited request keeps replay protection within its own idempotency key", async () => {
  const rootRunId = `raw-retry-idem-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const makePrepared = () => prepareInferencePayment(
      rawRequest({
        "x-network-id": NETWORK,
        "x-run-id": rootRunId,
        "x-execution-run-id": executionRunId,
        "x-idempotency-key": `${rootRunId}:call-1`,
      }),
      responseStub(),
      { useBudgetCap: true, scheme: "batch-settlement" },
    );

    const original = await makePrepared();
    assert.ok(original);
    const first = await original.settle({ finalAmountWei: "80" });
    assert.equal(first.success, true, first.error || "original checkpoint failed");
    assert.equal(first.paymentCumulativeAmountWei, "80");

    const identicalRetry = await makePrepared();
    assert.ok(identicalRetry);
    const replay = await identicalRetry.settle({ finalAmountWei: "80" });
    assert.equal(replay.success, true, replay.error || "identical retry must dedupe");
    assert.equal(replay.paymentCumulativeAmountWei, "80");

    const changedRetry = await makePrepared();
    assert.ok(changedRetry);
    const changed = await changedRetry.settle({ finalAmountWei: "95" });
    assert.equal(changed.success, false);
    assert.match(changed.error || "", /replayed with changed amount|immutable backing/i);

    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "80");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "80");
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("an inherited raw batch PAYMENT-RESPONSE exposes canonical queued channel metadata", async () => {
  const rootRunId = `raw-payment-response-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const capturedHeaders: Record<string, string> = {};
  const response = responseStub(capturedHeaders);
  const identity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const prepared = await prepareInferencePayment(
      rawRequest({
        "x-network-id": NETWORK,
        "x-run-id": rootRunId,
        "x-execution-run-id": executionRunId,
      }),
      responseStub(),
      { useBudgetCap: true, scheme: "batch-settlement" },
    );
    assert.ok(prepared);
    const settlement = await prepared.settle({ finalAmountWei: "75" });
    assert.equal(settlement.success, true, settlement.error || "raw batch checkpoint failed");
    prepared.applyHeaders(response, settlement);

    assert.equal(typeof capturedHeaders["PAYMENT-RESPONSE"], "string");
    const decoded = decodePaymentResponseHeader(capturedHeaders["PAYMENT-RESPONSE"]!);
    assert.equal(decoded.success, true);
    assert.equal(decoded.transaction, "");
    assert.equal(decoded.network, NETWORK);
    assert.equal(decoded.amount, "75");
    assert.equal(decoded.payer, PAYER);
    assert.deepEqual(decoded.extra, {
      settlementStatus: "queued",
      batchSettlementAddress: BATCH_SETTLEMENT_ADDRESS,
      channelId: channelId.toLowerCase(),
      cumulativeAmountWei: "75",
    });
    assert.equal("settledAt" in decoded, false);
    assert.equal("txHash" in decoded, false);
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("raw batch checkpoint fields normalize EVM channel case and preserve SVM channel case", () => {
  const evmChannelId = `0x${"Ab".repeat(32)}`;
  assert.equal(
    rawBatchCheckpointField({
      network: NETWORK,
      channelId: evmChannelId,
      rootRunId: "root",
      executionRunId: "execution",
      sequence: 0,
    }),
    rawBatchCheckpointField({
      network: NETWORK,
      channelId: evmChannelId.toLowerCase(),
      rootRunId: "root",
      executionRunId: "execution",
      sequence: 0,
    }),
  );

  const network = NETWORK_IDS.solana;
  const payer = "CaseSensitivePayer111111111111111111111111111";
  const receiver = "CaseSensitiveReceiver111111111111111111111111";
  const channelId = "ChannelAbCdEf123456789";
  const resource = "https://api.compose.market/agent/SvmCase/stream";
  const payload = {
    x402Version: 2,
    resource: { url: resource },
    accepted: {
      scheme: "batch-settlement",
      network,
      asset: getNetwork(network).asset.address,
      amount: "1000",
      payTo: receiver,
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload: {
      type: "voucher",
      channelConfig: {
        payer,
        receiver,
        token: getNetwork(network).asset.address,
        network,
        resource,
        balance: "1000",
        salt: "CaseSensitiveSalt",
      },
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "CaseSensitiveSignature",
      },
    },
  } as PaymentPayload;

  const backing = resolveRawBatchBacking({
    network,
    maxAmountWei: "1000",
    paymentPayload: payload,
    payer,
  });
  assert.equal(backing.channelId, channelId);
  assert.match(rawBatchCheckpointField({
    network,
    channelId: backing.channelId,
    rootRunId: "root",
    executionRunId: "execution",
    sequence: 0,
  }), /^checkpoint:[a-f0-9]{64}$/u);
  assert.notEqual(
    rawBatchCheckpointField({ network, channelId, rootRunId: "root", executionRunId: "execution", sequence: 0 }),
    rawBatchCheckpointField({
      network,
      channelId: channelId.toLowerCase(),
      rootRunId: "root",
      executionRunId: "execution",
      sequence: 0,
    }),
  );
});

test("SVM raw batch checkpoints use the same atomic envelope and durable identity transition", async () => {
  const network = NETWORK_IDS.solana;
  const payer = "CaseSensitivePayer222222222222222222222222222";
  const receiver = "CaseSensitiveReceiver22222222222222222222222";
  const channelId = "ChannelAtomicAbCdEf987654321";
  const resource = "https://api.compose.market/agent/SvmAtomic/stream";
  const rootRunId = `svm-root-${randomUUID()}`;
  const executionRunId = `svm-execution-${randomUUID()}`;
  const payload = {
    x402Version: 2,
    resource: { url: resource },
    accepted: {
      scheme: "batch-settlement",
      network,
      asset: getNetwork(network).asset.address,
      amount: "1000",
      payTo: receiver,
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload: {
      type: "voucher",
      channelConfig: {
        payer,
        receiver,
        token: getNetwork(network).asset.address,
        network,
        resource,
        balance: "1000",
        salt: "CaseSensitiveAtomicSalt",
      },
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "CaseSensitiveAtomicSignature",
      },
    },
  } as PaymentPayload;
  const identity = { network, channelId, rootRunId, executionRunId, sequence: 0 };
  const channelKey = `x402:batch-settlement:svm:channel:${channelId}`;

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network,
      paymentPayload: payload,
      payer,
    });
    await batchModule.rememberSvmBatchChannel(payload, payload.accepted);

    const committed = await batchModule.commitRawBatchCheckpoint({
      paymentPayload: payload,
      requirements: payload.accepted,
      amountWei: "75",
      rootRunId,
      executionRunId,
      sequence: 0,
    });

    assert.equal(committed.channelId, channelId);
    assert.equal(committed.cumulativeAmountWei, "75");
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "75");
    assert.equal((await valkeyHGetAll(channelKey)).chargedCumulativeAmount, "75");
    assert.equal((await checkpointRecord(identity)).channelId, channelId);
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await valkeyDel(channelKey);
    await valkeyDel(channelKey.toLowerCase());
    await valkeySRem("x402:batch-settlement:svm:pending", channelId, channelId.toLowerCase());
  }
});

test("raw batch checkpoint replay fails closed on changed amount or immutable backing", async () => {
  const rootRunId = `raw-mismatch-${randomUUID()}`;
  const executionRunId = `execution-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const identity = { network: NETWORK, channelId, rootRunId, executionRunId, sequence: 0 };
  const input = {
    paymentPayload: payload,
    requirements: payload.accepted,
    amountWei: "100",
    rootRunId,
    executionRunId,
    sequence: 0,
  };

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });
    await batchModule.commitRawBatchCheckpoint(input);

    await assert.rejects(
      batchModule.commitRawBatchCheckpoint({ ...input, amountWei: "101" }),
      /changed amount|replayed.*changed/i,
    );

    const changedPayload = structuredClone(payload);
    (changedPayload.payload as { voucher: { signature: string } }).voucher.signature = `0x${"88".repeat(65)}`;
    await assert.rejects(
      batchModule.commitRawBatchCheckpoint({ ...input, paymentPayload: changedPayload }),
      /immutable backing mismatch/i,
    );

    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "100");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "100");
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});

test("concurrent raw batch checkpoints serialize per channel while independent execution identities remain distinct", async () => {
  const rootRunId = `raw-concurrent-${randomUUID()}`;
  const channelId = `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const payload = paymentPayload({ scheme: "batch-settlement", channelId });
  const executions = Array.from({ length: 12 }, (_, index) => `execution-${index}-${randomUUID()}`);

  try {
    await saveRawEnvelope({
      rootRunId,
      maxAmountWei: "1000",
      network: NETWORK,
      paymentPayload: payload,
      payer: PAYER,
    });
    await batchModule.rememberBatchChannel(payload, payload.accepted, {
      isValid: true,
      payer: PAYER,
      extra: { balance: "1000", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0 },
    });

    const committed = await Promise.all(executions.map((executionRunId) => (
      batchModule.commitRawBatchCheckpoint({
        paymentPayload: payload,
        requirements: payload.accepted,
        amountWei: "25",
        rootRunId,
        executionRunId,
        sequence: 0,
      })
    )));

    assert.deepEqual(
      committed.map((entry) => BigInt(entry.cumulativeAmountWei)).sort((left, right) => left < right ? -1 : 1),
      Array.from({ length: executions.length }, (_, index) => BigInt((index + 1) * 25)),
    );
    assert.equal((await readRawEnvelope(rootRunId))?.usedWei, "300");
    assert.equal((await batchModule.getBatchChannelStorage().get(channelId))?.chargedCumulativeAmount, "300");
    assert.equal(new Set(committed.map((entry) => entry.cumulativeAmountWei)).size, executions.length);
  } finally {
    await valkeyDel(`x402:envelope:${rootRunId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});
