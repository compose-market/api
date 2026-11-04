import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import express from "express";

import { registerUtilityRoutes } from "../routes.js";
import {
  listReceipts,
  markBatchReceiptsSettled,
  markIntentReceiptsFailed,
  markIntentReceiptsSettled,
  receiptForJsonBody,
  receiptFromInferenceSettlement,
  receiptStreamPayload,
  storeReceipt,
} from "../x402/receipts.js";
import {
  closeValkey,
  getValkeyClient,
  valkeyDel,
  valkeyExpire,
  valkeyGet,
  valkeyHSet,
  valkeySAdd,
  valkeySMembers,
} from "../x402/keys/valkey.js";
import type { Receipt } from "../http/request-context.js";

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

type InterceptableValkey = {
  set: (...args: unknown[]) => Promise<unknown>;
  setex: (...args: unknown[]) => Promise<unknown>;
  eval: (...args: unknown[]) => Promise<unknown>;
};

async function forceReceiptWriteAfterConcurrentTransition<T>(input: {
  settlementStatus: NonNullable<Receipt["settlementStatus"]>;
  concurrentTransition: () => Promise<unknown>;
  write: () => Promise<T>;
}): Promise<T> {
  const valkey = await getValkeyClient() as unknown as InterceptableValkey;
  const originalSet = valkey.set;
  const originalSetex = valkey.setex;
  const originalEval = valkey.eval;
  const statusNeedle = `"settlementStatus":"${input.settlementStatus}"`;
  let intercepted = false;

  const intercept = async (args: unknown[]): Promise<void> => {
    if (
      intercepted
      || !args.some((value) => typeof value === "string" && value.includes(statusNeedle))
    ) return;
    intercepted = true;
    await input.concurrentTransition();
  };

  valkey.set = async (...args: unknown[]): Promise<unknown> => {
    await intercept(args);
    return originalSet.apply(valkey, args);
  };
  valkey.setex = async (...args: unknown[]): Promise<unknown> => {
    await intercept(args);
    return originalSetex.apply(valkey, args);
  };
  valkey.eval = async (...args: unknown[]): Promise<unknown> => {
    await intercept(args);
    return originalEval.apply(valkey, args);
  };

  try {
    const result = await input.write();
    assert.equal(intercepted, true, `expected to intercept ${input.settlementStatus} receipt write`);
    return result;
  } finally {
    valkey.set = originalSet;
    valkey.setex = originalSetex;
    valkey.eval = originalEval;
  }
}

async function cleanupReceiptState(userAddress: string, network: string, intentId: string): Promise<void> {
  const userKey = `x402:receipt:user:${network}:${userAddress}`;
  for (const id of await valkeySMembers(userKey)) {
    await valkeyDel(`x402:receipt:${id}`);
  }
  await valkeyDel(userKey);
  await valkeyDel(`x402:receipt:aggregate:${network}:${userAddress}`);
  await valkeyDel(`x402:receipt:intent:${intentId}`);
  await valkeyDel(`payment-intent:${intentId}`);
}

function batchChannelIdentity(channelId: string, network: string): string {
  return network.startsWith("eip155:") ? channelId.toLowerCase() : channelId;
}

async function cleanupBatchReceiptState(input: {
  userAddress: string;
  network: string;
  channelId: string;
}): Promise<void> {
  const identity = batchChannelIdentity(input.channelId, input.network);
  const userKey = `x402:receipt:user:${input.network}:${input.userAddress}`;
  for (const id of await valkeySMembers(userKey)) {
    await valkeyDel(`x402:receipt:${id}`);
  }
  await valkeyDel(userKey);
  await valkeyDel(`x402:receipt:aggregate:${input.network}:${input.userAddress}`);
  await valkeyDel(`x402:receipt:batch:${input.network}:${identity}`);
  await valkeyDel(`x402:batch-reconciliation:${input.network}:${identity}`);
}

test("confirmed receipt applied identities and counters share one atomic Valkey key", () => {
  const source = readFileSync(new URL("../x402/receipts.ts", import.meta.url), "utf8");
  const transitionStart = source.indexOf("async function transitionNonBatchReceipt");
  const transitionEnd = source.indexOf("export async function storeReceipt");
  assert.notEqual(transitionStart, -1, "non-batch receipts must share one atomic state machine");
  assert.ok(transitionEnd > transitionStart, "non-batch state machine must precede storeReceipt");
  const aggregateTransition = source.slice(transitionStart, transitionEnd);

  assert.match(aggregateTransition, /\.eval\(/, "aggregate application must be a single Lua transaction");
  assert.match(
    aggregateTransition,
    /applied:/,
    "aggregate hash must retain each applied receipt identity for its own lifetime",
  );
  assert.match(aggregateTransition, /payment-intent:/, "publication must project intent state inside Lua");
  assert.doesNotMatch(source, /aggregateAppliedKey|aggregate-applied:/);
  assert.doesNotMatch(source, /reconcileIntentReceipt/);
  assert.doesNotMatch(aggregateTransition, /valkeyGet|valkeySet|valkeySAdd|valkeyHIncrByAmount/);
});

test("queued intent receipts are deterministic and enter paid aggregates exactly once on confirmation", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const queued = {
    userAddress,
    network,
    paymentIntentId: intentId,
    settlementStatus: "queued",
    finalAmountWei: "101",
    providerAmountWei: "100",
    platformFeeWei: "1",
  } as unknown as Receipt;

  try {
    const first = await storeReceipt(queued);
    const replay = await storeReceipt(queued);
    assert.equal(replay.id, first.id, "intent replay must address the original receipt");

    let listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.equal(listed.receipts[0]?.settlementStatus, "queued");
    assert.equal(listed.receipts[0]?.settledAt, undefined);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "0",
      providerAmountWei: "0",
      platformFeeWei: "0",
      receiptCount: 0,
    });

    await markIntentReceiptsSettled({ paymentIntentId: intentId, txHash: `0x${"12".repeat(32)}` });
    await markIntentReceiptsSettled({ paymentIntentId: intentId, txHash: `0x${"12".repeat(32)}` });
    listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.equal(listed.receipts[0]?.settlementStatus, "settled");
    assert.equal(listed.receipts[0]?.txHash, `0x${"12".repeat(32)}`);
    assert.ok(listed.receipts[0]?.settledAt);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
      receiptCount: 1,
    });
  } finally {
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("queued intent replay cannot overwrite a concurrent settlement", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const settlementTxHash = `0x${"21".repeat(32)}`;
  const queued = {
    userAddress,
    network,
    paymentIntentId: intentId,
    settlementStatus: "queued",
    finalAmountWei: "101",
    providerAmountWei: "100",
    platformFeeWei: "1",
  } as unknown as Receipt;

  try {
    await storeReceipt(queued);
    await forceReceiptWriteAfterConcurrentTransition({
      settlementStatus: "queued",
      concurrentTransition: () => markIntentReceiptsSettled({
        paymentIntentId: intentId,
        txHash: settlementTxHash,
      }),
      write: () => storeReceipt(queued),
    });

    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.equal(listed.receipts[0]?.settlementStatus, "settled");
    assert.equal(listed.receipts[0]?.txHash, settlementTxHash);
    assert.ok(listed.receipts[0]?.settledAt);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
      receiptCount: 1,
    });
  } finally {
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("terminal intent failure cannot overwrite a concurrent settlement", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const settlementTxHash = `0x${"22".repeat(32)}`;
  const failureTxHash = `0x${"23".repeat(32)}`;

  try {
    await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      settlementStatus: "queued",
      finalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
    } as unknown as Receipt);
    await forceReceiptWriteAfterConcurrentTransition({
      settlementStatus: "failed",
      concurrentTransition: () => markIntentReceiptsSettled({
        paymentIntentId: intentId,
        txHash: settlementTxHash,
      }),
      write: () => markIntentReceiptsFailed({
        paymentIntentId: intentId,
        txHash: failureTxHash,
        error: "transaction reverted",
      }),
    });

    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.equal(listed.receipts[0]?.settlementStatus, "settled");
    assert.equal(listed.receipts[0]?.txHash, settlementTxHash);
    assert.ok(listed.receipts[0]?.settledAt);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
      receiptCount: 1,
    });
  } finally {
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("first receipt publication self-projects an intent confirmed after an empty projection scan", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const txHash = `0x${"24".repeat(32)}`;
  const queued = {
    userAddress,
    network,
    paymentIntentId: intentId,
    settlementStatus: "queued",
    finalAmountWei: "101",
    providerAmountWei: "100",
    platformFeeWei: "1",
  } as unknown as Receipt;

  try {
    await valkeyHSet(`payment-intent:${intentId}`, {
      paymentIntentId: intentId,
      status: "queued",
      network,
    });
    const stored = await forceReceiptWriteAfterConcurrentTransition({
      settlementStatus: "queued",
      concurrentTransition: async () => {
        await valkeyHSet(`payment-intent:${intentId}`, {
          status: "confirmed",
          txHash,
          network,
          confirmedAt: String(Date.now()),
        });
        assert.equal(
          await markIntentReceiptsSettled({ paymentIntentId: intentId, txHash }),
          0,
          "terminal projection must scan an empty receipt index before publication resumes",
        );
      },
      write: () => storeReceipt(queued),
    });

    assert.equal(stored.settlementStatus, "settled");
    assert.equal(stored.txHash, txHash);
    assert.ok(stored.settledAt);
    assert.deepEqual(stored.cumulative, {
      totalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
      receiptCount: 1,
    });
  } finally {
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("intent receipt identity lives as long as its shared aggregate", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const firstIntentId = `pi_${randomUUID()}`;
  const secondIntentId = `pi_${randomUUID()}`;
  const firstQueued = {
    userAddress,
    network,
    paymentIntentId: firstIntentId,
    settlementStatus: "queued",
    finalAmountWei: "101",
    providerAmountWei: "100",
    platformFeeWei: "1",
  } as unknown as Receipt;
  const secondQueued = {
    userAddress,
    network,
    paymentIntentId: secondIntentId,
    settlementStatus: "queued",
    finalAmountWei: "202",
    providerAmountWei: "200",
    platformFeeWei: "2",
  } as unknown as Receipt;

  try {
    const first = await storeReceipt(firstQueued);
    await markIntentReceiptsSettled({
      paymentIntentId: firstIntentId,
      txHash: `0x${"31".repeat(32)}`,
    });
    assert.ok(first.id);
    assert.equal(await valkeyExpire(`x402:receipt:${first.id}`, 1), true);
    await valkeyExpire(`x402:receipt:aggregate-applied:${first.id}`, 1);

    await storeReceipt(secondQueued);
    await markIntentReceiptsSettled({
      paymentIntentId: secondIntentId,
      txHash: `0x${"32".repeat(32)}`,
    });

    await delay(1_100);
    assert.equal(await valkeyGet(`x402:receipt:${first.id}`), null);
    let listed = await listReceipts({ userAddress, network });
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "303",
      providerAmountWei: "300",
      platformFeeWei: "3",
      receiptCount: 2,
    });

    const replay = await storeReceipt(firstQueued);
    assert.equal(replay.id, first.id);
    await markIntentReceiptsSettled({
      paymentIntentId: firstIntentId,
      txHash: `0x${"31".repeat(32)}`,
    });

    listed = await listReceipts({ userAddress, network });
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "303",
      providerAmountWei: "300",
      platformFeeWei: "3",
      receiptCount: 2,
    });
  } finally {
    await cleanupReceiptState(userAddress, network, firstIntentId);
    await cleanupReceiptState(userAddress, network, secondIntentId);
  }
});

test("receipt creation reconciles an intent that confirmed before metadata was stored", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const txHash = `0x${"56".repeat(32)}`;

  try {
    await valkeyHSet(`payment-intent:${intentId}`, {
      paymentIntentId: intentId,
      status: "confirmed",
      txHash,
      network,
    });
    const stored = await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      settlementStatus: "queued",
      finalAmountWei: "202",
      providerAmountWei: "200",
      platformFeeWei: "2",
    } as unknown as Receipt);

    assert.equal(stored.settlementStatus, "settled");
    assert.equal(stored.txHash, txHash);
    assert.ok(stored.settledAt);
    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.cumulative.totalAmountWei, "202");
    assert.equal(listed.cumulative.receiptCount, 1);
  } finally {
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("batch receipt created after settlement is settled immediately and aggregated exactly once", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const claimTxHash = `0x${"67".repeat(32)}`;
  const settleTxHash = `0x${"78".repeat(32)}`;
  const queued = {
    userAddress,
    network,
    paymentChannelId: channelId.toLowerCase(),
    paymentCumulativeAmountWei: "700",
    settlementStatus: "queued",
    finalAmountWei: "404",
    providerAmountWei: "400",
    platformFeeWei: "4",
  } as unknown as Receipt;

  try {
    const marked = await markBatchReceiptsSettled({
      channelId: channelId.toUpperCase(),
      network,
      claimedAmountWei: "900",
      claimTxHash,
      settleTxHash,
    });
    assert.equal(marked, 0, "no metadata exists at chain-reconciliation time");

    const stored = await storeReceipt(queued);
    assert.equal(stored.settlementStatus, "settled");
    assert.equal(stored.claimTxHash, claimTxHash);
    assert.equal(stored.settleTxHash, settleTxHash);
    assert.equal(stored.txHash, settleTxHash);
    assert.equal(stored.network, network);
    assert.ok(stored.settledAt);
    assert.deepEqual(stored.cumulative, {
      totalAmountWei: "404",
      providerAmountWei: "400",
      platformFeeWei: "4",
      receiptCount: 1,
    });

    const replay = await storeReceipt(queued);
    assert.equal(replay.id, stored.id);
    assert.equal(replay.settledAt, stored.settledAt);
    assert.deepEqual(replay.cumulative, {
      totalAmountWei: "404",
      providerAmountWei: "400",
      platformFeeWei: "4",
      receiptCount: 1,
    });

    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "600",
      claimTxHash: `0x${"89".repeat(32)}`,
    });
    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts[0]?.settlementStatus, "settled");
    assert.equal(listed.receipts[0]?.claimTxHash, claimTxHash);
    assert.equal(listed.receipts[0]?.settleTxHash, settleTxHash);
    assert.equal(listed.receipts[0]?.settledAt, stored.settledAt);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "404",
      providerAmountWei: "400",
      platformFeeWei: "4",
      receiptCount: 1,
    });
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("authoritative batch settlement supersedes a previously failed receipt", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;

  try {
    const failed = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      settlementStatus: "failed",
      finalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
    } as unknown as Receipt);
    assert.equal(failed.settlementStatus, "failed");

    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: `0x${"45".repeat(32)}`,
      settleTxHash: `0x${"46".repeat(32)}`,
    });
    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts[0]?.settlementStatus, "settled");
    assert.equal(listed.receipts[0]?.settleTxHash, `0x${"46".repeat(32)}`);
    assert.equal(listed.cumulative.receiptCount, 1);
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("batch receipt transitions refresh user, batch, and intent discovery indexes atomically", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const intentId = `pi_${randomUUID()}`;
  let receiptId: string | undefined;
  const identity = batchChannelIdentity(channelId, network);
  const userKey = `x402:receipt:user:${network}:${userAddress}`;
  const batchKey = `x402:receipt:batch:${network}:${identity}`;
  const intentKey = `x402:receipt:intent:${intentId}`;

  try {
    const stored = await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      settlementStatus: "queued",
      finalAmountWei: "101",
      providerAmountWei: "100",
      platformFeeWei: "1",
    } as unknown as Receipt);
    receiptId = stored.id;
    assert.ok(receiptId);
    await Promise.all([
      valkeyExpire(userKey, 1),
      valkeyExpire(batchKey, 1),
      valkeyExpire(intentKey, 1),
    ]);

    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: `0x${"47".repeat(32)}`,
      settleTxHash: `0x${"48".repeat(32)}`,
    });
    await delay(1_100);
    assert.ok((await valkeySMembers(userKey)).includes(receiptId));
    assert.ok((await valkeySMembers(batchKey)).includes(receiptId));
    assert.ok((await valkeySMembers(intentKey)).includes(receiptId));
  } finally {
    if (receiptId) await valkeyDel(`x402:receipt:${receiptId}`);
    await cleanupBatchReceiptState({ userAddress, network, channelId });
    await valkeyDel(intentKey);
  }
});

test("batch receipt identity lives as long as its shared aggregate", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const firstQueued = {
    userAddress,
    network,
    paymentChannelId: channelId,
    paymentCumulativeAmountWei: "100",
    settlementStatus: "queued",
    finalAmountWei: "101",
    providerAmountWei: "100",
    platformFeeWei: "1",
  } as unknown as Receipt;
  const secondQueued = {
    userAddress,
    network,
    paymentChannelId: channelId,
    paymentCumulativeAmountWei: "200",
    settlementStatus: "queued",
    finalAmountWei: "202",
    providerAmountWei: "200",
    platformFeeWei: "2",
  } as unknown as Receipt;

  try {
    const first = await storeReceipt(firstQueued);
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: `0x${"41".repeat(32)}`,
      settleTxHash: `0x${"42".repeat(32)}`,
    });
    assert.ok(first.id);

    await storeReceipt(secondQueued);
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "200",
      claimTxHash: `0x${"43".repeat(32)}`,
      settleTxHash: `0x${"44".repeat(32)}`,
    });
    assert.equal(await valkeyExpire(`x402:receipt:${first.id}`, 1), true);

    await delay(1_100);
    assert.equal(await valkeyGet(`x402:receipt:${first.id}`), null);
    let listed = await listReceipts({ userAddress, network });
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "303",
      providerAmountWei: "300",
      platformFeeWei: "3",
      receiptCount: 2,
    });

    const replay = await storeReceipt(firstQueued);
    assert.equal(replay.id, first.id);
    assert.equal(replay.settlementStatus, "settled");
    listed = await listReceipts({ userAddress, network });
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "303",
      providerAmountWei: "300",
      platformFeeWei: "3",
      receiptCount: 2,
    });
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("batch receipts select earliest covering claim and settlement transitions independently", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const firstClaimTxHash = `0x${"91".repeat(32)}`;
  const secondClaimTxHash = `0x${"93".repeat(32)}`;
  const secondSettleTxHash = `0x${"94".repeat(32)}`;

  try {
    const storedBefore = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "90",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: firstClaimTxHash,
    });
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "150",
      claimTxHash: secondClaimTxHash,
      settleTxHash: secondSettleTxHash,
    });

    const storedAfter = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);

    const listed = await listReceipts({ userAddress, network });
    const reconciledBefore = listed.receipts.find((receipt) => receipt.id === storedBefore.id);
    assert.equal(reconciledBefore?.settlementStatus, "settled");
    assert.equal(reconciledBefore?.claimTxHash, firstClaimTxHash);
    assert.equal(reconciledBefore?.settleTxHash, secondSettleTxHash);
    assert.equal(reconciledBefore?.txHash, secondSettleTxHash);
    assert.equal(storedAfter.settlementStatus, "settled");
    assert.equal(storedAfter.claimTxHash, firstClaimTxHash);
    assert.equal(storedAfter.settleTxHash, secondSettleTxHash);
    assert.equal(storedAfter.txHash, secondSettleTxHash);

    await assert.rejects(
      markBatchReceiptsSettled({
        channelId,
        network,
        claimedAmountWei: "150",
        claimTxHash: `0x${"95".repeat(32)}`,
        settleTxHash: secondSettleTxHash,
      }),
      /claim transaction mismatch for cumulative watermark 150/,
    );
    await assert.rejects(
      markBatchReceiptsSettled({
        channelId,
        network,
        claimedAmountWei: "150",
        claimTxHash: secondClaimTxHash,
        settleTxHash: `0x${"96".repeat(32)}`,
      }),
      /settle transaction mismatch for cumulative watermark 150/,
    );
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("batch receipts reject noncanonical cumulative identity before storage", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const input = {
    userAddress,
    network,
    paymentChannelId: channelId,
    settlementStatus: "queued",
    finalAmountWei: "11",
    providerAmountWei: "10",
    platformFeeWei: "1",
  };

  try {
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: `0x${"97".repeat(32)}`,
      settleTxHash: `0x${"98".repeat(32)}`,
    });
    await assert.rejects(
      storeReceipt({
        ...input,
        id: `rct_${randomUUID().replace(/-/g, "")}`,
        paymentCumulativeAmountWei: "080",
      } as unknown as Receipt),
      /Batch receipt cumulative amount must be a canonical unsigned decimal integer/,
    );

    const stored = await storeReceipt({ ...input, paymentCumulativeAmountWei: "80" } as unknown as Receipt);
    const replay = await storeReceipt({ ...input, paymentCumulativeAmountWei: "80" } as unknown as Receipt);
    assert.equal(replay.id, stored.id);
    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
      receiptCount: 1,
    });
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("semantic receipt backing owns its canonical id and transaction case follows the network", async () => {
  const userAddress = wallet();
  const evmNetwork = "eip155:5042002" as const;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const intentId = `pi_${randomUUID()}`;
  const cleanupIntentId = `cleanup_${randomUUID()}`;

  try {
    const canonical = await storeReceipt({
      userAddress,
      network: evmNetwork,
      paymentIntentId: intentId,
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    await assert.rejects(
      storeReceipt({
        userAddress,
        network: evmNetwork,
        id: `rct_${randomUUID().replace(/-/g, "")}`,
        paymentIntentId: intentId,
        settlementStatus: "queued",
        finalAmountWei: "11",
        providerAmountWei: "10",
        platformFeeWei: "1",
      } as unknown as Receipt),
      /explicit receipt id conflicts with canonical backing/i,
    );

    const evmUpper = await storeReceipt({
      userAddress,
      network: evmNetwork,
      txHash: "0xAbCd",
      settlementStatus: "submitted",
      finalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
    } as unknown as Receipt);
    const evmLower = await storeReceipt({
      userAddress,
      network: evmNetwork,
      txHash: "0xabcd",
      settlementStatus: "submitted",
      finalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
    } as unknown as Receipt);
    assert.equal(evmLower.id, evmUpper.id);

    const svmUpper = await storeReceipt({
      userAddress,
      network: svmNetwork,
      txHash: "SignatureABC",
      settlementStatus: "submitted",
      finalAmountWei: "33",
      providerAmountWei: "30",
      platformFeeWei: "3",
    } as unknown as Receipt);
    const svmLower = await storeReceipt({
      userAddress,
      network: svmNetwork,
      txHash: "signatureabc",
      settlementStatus: "submitted",
      finalAmountWei: "33",
      providerAmountWei: "30",
      platformFeeWei: "3",
    } as unknown as Receipt);
    assert.notEqual(svmLower.id, svmUpper.id);
    assert.ok(canonical.id);
  } finally {
    await cleanupReceiptState(userAddress, evmNetwork, intentId);
    await cleanupReceiptState(userAddress, svmNetwork, cleanupIntentId);
  }
});

test("semantic receipt ids are validated before incomplete user metadata skips storage", async () => {
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const incomplete = {
    network,
    paymentIntentId: intentId,
    settlementStatus: "queued",
    finalAmountWei: "11",
    providerAmountWei: "10",
    platformFeeWei: "1",
  } as unknown as Receipt;

  await assert.rejects(
    storeReceipt({
      ...incomplete,
      id: "rct_explicitly_not_the_canonical_semantic_id",
    }),
    /explicit receipt id conflicts with canonical backing/i,
  );

  const unchanged = await storeReceipt(incomplete);
  assert.equal(unchanged, incomplete);
  assert.equal(unchanged.id, undefined);
});

test("non-batch higher-rank replays cannot mutate execution provenance", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const fields = ["rootRunId", "executionRunId", "parentExecutionRunId"] as const;
  const intentIds: string[] = [];

  try {
    for (const field of fields) {
      const intentId = `pi_${randomUUID()}`;
      intentIds.push(intentId);
      const queued = {
        userAddress,
        network,
        paymentIntentId: intentId,
        settlementStatus: "queued",
        rootRunId: "root-original",
        executionRunId: "execution-original",
        parentExecutionRunId: "parent-original",
        finalAmountWei: "11",
        providerAmountWei: "10",
        platformFeeWei: "1",
      } as unknown as Receipt;
      await storeReceipt(queued);

      await assert.rejects(
        storeReceipt({
          ...queued,
          settlementStatus: "submitted",
          txHash: `0x${"61".repeat(32)}`,
          [field]: `${field}-mutated`,
        }),
        new RegExp(`immutable ${field}`, "i"),
      );
    }
  } finally {
    for (const intentId of intentIds) {
      await cleanupReceiptState(userAddress, network, intentId);
    }
  }
});

test("batch higher-rank replays cannot mutate execution provenance", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const fields = ["rootRunId", "executionRunId", "parentExecutionRunId"] as const;
  const channelIds: string[] = [];

  try {
    for (const field of fields) {
      const channelId = `0x${randomUUID().replace(/-/g, "")}`;
      channelIds.push(channelId);
      const queued = {
        userAddress,
        network,
        paymentChannelId: channelId,
        paymentCumulativeAmountWei: "100",
        settlementStatus: "queued",
        rootRunId: "root-original",
        executionRunId: "execution-original",
        parentExecutionRunId: "parent-original",
        finalAmountWei: "11",
        providerAmountWei: "10",
        platformFeeWei: "1",
      } as unknown as Receipt;
      await storeReceipt(queued);

      await assert.rejects(
        storeReceipt({
          ...queued,
          settlementStatus: "claimed",
          claimTxHash: `0x${"62".repeat(32)}`,
          [field]: `${field}-mutated`,
        }),
        new RegExp(`immutable ${field}`, "i"),
      );
    }
  } finally {
    for (const channelId of channelIds) {
      await cleanupBatchReceiptState({ userAddress, network, channelId });
    }
  }
});

test("non-batch failed-to-settled transaction identity follows network case rules", async () => {
  const userAddress = wallet();
  const evmNetwork = "eip155:5042002" as const;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const equivalentIntentId = `pi_${randomUUID()}`;
  const conflictingIntentId = `pi_${randomUUID()}`;
  const svmIntentId = `pi_${randomUUID()}`;
  const lowerFailureIntentId = `pi_${randomUUID()}`;

  const receipt = (intentId: string, network: typeof evmNetwork | typeof svmNetwork) => ({
    userAddress,
    network,
    paymentIntentId: intentId,
    finalAmountWei: "11",
    providerAmountWei: "10",
    platformFeeWei: "1",
  });

  try {
    await storeReceipt({
      ...receipt(equivalentIntentId, evmNetwork),
      settlementStatus: "failed",
      txHash: "0xAbCd",
    } as unknown as Receipt);
    const equivalent = await storeReceipt({
      ...receipt(equivalentIntentId, evmNetwork),
      settlementStatus: "settled",
      txHash: "0xabcd",
      settledAt: Date.now(),
    } as unknown as Receipt);
    assert.equal(equivalent.settlementStatus, "settled");

    await storeReceipt({
      ...receipt(conflictingIntentId, evmNetwork),
      settlementStatus: "failed",
      txHash: `0x${"63".repeat(32)}`,
    } as unknown as Receipt);
    await assert.rejects(
      storeReceipt({
        ...receipt(conflictingIntentId, evmNetwork),
        settlementStatus: "settled",
        txHash: `0x${"64".repeat(32)}`,
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );

    await storeReceipt({
      ...receipt(svmIntentId, svmNetwork),
      settlementStatus: "failed",
      txHash: "SignatureABC",
    } as unknown as Receipt);
    await assert.rejects(
      storeReceipt({
        ...receipt(svmIntentId, svmNetwork),
        settlementStatus: "settled",
        txHash: "signatureabc",
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );

    const settled = await storeReceipt({
      ...receipt(lowerFailureIntentId, evmNetwork),
      settlementStatus: "settled",
      txHash: `0x${"65".repeat(32)}`,
      settledAt: Date.now(),
    } as unknown as Receipt);
    const lowerFailure = await storeReceipt({
      ...receipt(lowerFailureIntentId, evmNetwork),
      settlementStatus: "failed",
      txHash: `0x${"66".repeat(32)}`,
    } as unknown as Receipt);
    assert.equal(lowerFailure.settlementStatus, "settled");
    assert.equal(lowerFailure.txHash, settled.txHash);
  } finally {
    await cleanupReceiptState(userAddress, evmNetwork, equivalentIntentId);
    await cleanupReceiptState(userAddress, evmNetwork, conflictingIntentId);
    await cleanupReceiptState(userAddress, svmNetwork, svmIntentId);
    await cleanupReceiptState(userAddress, evmNetwork, lowerFailureIntentId);
  }
});

test("batch failed-to-settled transaction identity is enforced in publication and reconciliation", async () => {
  const userAddress = wallet();
  const evmNetwork = "eip155:5042002" as const;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const equivalentChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const conflictingChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const reconciliationChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const svmChannel = `channel-${randomUUID()}`;

  const receipt = (channelId: string, network: typeof evmNetwork | typeof svmNetwork) => ({
    userAddress,
    network,
    paymentChannelId: channelId,
    paymentCumulativeAmountWei: "100",
    finalAmountWei: "11",
    providerAmountWei: "10",
    platformFeeWei: "1",
  });

  try {
    await storeReceipt({
      ...receipt(equivalentChannel, evmNetwork),
      settlementStatus: "failed",
      txHash: "0xAbCd",
    } as unknown as Receipt);
    const equivalent = await storeReceipt({
      ...receipt(equivalentChannel, evmNetwork),
      settlementStatus: "settled",
      txHash: "0xabcd",
      settledAt: Date.now(),
    } as unknown as Receipt);
    assert.equal(equivalent.settlementStatus, "settled");

    await storeReceipt({
      ...receipt(conflictingChannel, evmNetwork),
      settlementStatus: "failed",
      txHash: `0x${"67".repeat(32)}`,
    } as unknown as Receipt);
    await assert.rejects(
      storeReceipt({
        ...receipt(conflictingChannel, evmNetwork),
        settlementStatus: "settled",
        txHash: `0x${"68".repeat(32)}`,
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );

    await storeReceipt({
      ...receipt(reconciliationChannel, evmNetwork),
      settlementStatus: "failed",
      txHash: `0x${"69".repeat(32)}`,
    } as unknown as Receipt);
    await assert.rejects(
      markBatchReceiptsSettled({
        channelId: reconciliationChannel,
        network: evmNetwork,
        claimedAmountWei: "100",
        claimTxHash: `0x${"6a".repeat(32)}`,
        settleTxHash: `0x${"6b".repeat(32)}`,
      }),
      /terminal transaction mismatch/i,
    );

    await storeReceipt({
      ...receipt(svmChannel, svmNetwork),
      settlementStatus: "failed",
      txHash: "SignatureABC",
    } as unknown as Receipt);
    await assert.rejects(
      storeReceipt({
        ...receipt(svmChannel, svmNetwork),
        settlementStatus: "settled",
        txHash: "signatureabc",
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );
  } finally {
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: equivalentChannel });
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: conflictingChannel });
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: reconciliationChannel });
    await cleanupBatchReceiptState({ userAddress, network: svmNetwork, channelId: svmChannel });
  }
});

test("direct batch publication canonicalizes EVM hashes and rejects contradictory terminal provenance", async () => {
  const userAddress = wallet();
  const evmNetwork = "eip155:5042002" as const;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const canonicalChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const conflictingChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const settleOnlyFailedChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const inconsistentChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const svmChannel = `channel-${randomUUID()}`;
  const claimUpper = `0x${"Ab".repeat(32)}`;
  const settleUpper = `0x${"Cd".repeat(32)}`;

  const receipt = (channelId: string, network: typeof evmNetwork | typeof svmNetwork) => ({
    userAddress,
    network,
    paymentChannelId: channelId,
    paymentCumulativeAmountWei: "100",
    finalAmountWei: "11",
    providerAmountWei: "10",
    platformFeeWei: "1",
  });

  try {
    const canonical = await storeReceipt({
      ...receipt(canonicalChannel, evmNetwork),
      settlementStatus: "settled",
      claimTxHash: claimUpper,
      settleTxHash: settleUpper,
      txHash: settleUpper,
      settledAt: Date.now(),
    } as unknown as Receipt);
    assert.equal(canonical.claimTxHash, claimUpper.toLowerCase());
    assert.equal(canonical.settleTxHash, settleUpper.toLowerCase());
    assert.equal(canonical.txHash, settleUpper.toLowerCase());

    const svm = await storeReceipt({
      ...receipt(svmChannel, svmNetwork),
      settlementStatus: "settled",
      claimTxHash: "ClaimSignatureABC",
      settleTxHash: "SettlementSignatureABC",
      txHash: "SettlementSignatureABC",
      settledAt: Date.now(),
    } as unknown as Receipt);
    assert.equal(svm.claimTxHash, "ClaimSignatureABC");
    assert.equal(svm.settleTxHash, "SettlementSignatureABC");
    assert.equal(svm.txHash, "SettlementSignatureABC");

    await storeReceipt({
      ...receipt(conflictingChannel, evmNetwork),
      settlementStatus: "failed",
      txHash: `0x${"81".repeat(32)}`,
    } as unknown as Receipt);
    await assert.rejects(
      storeReceipt({
        ...receipt(conflictingChannel, evmNetwork),
        settlementStatus: "settled",
        settleTxHash: `0x${"82".repeat(32)}`,
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );

    const settleOnlyFailedHash = `0x${"88".repeat(32)}`;
    const settleOnlyFailed = await storeReceipt({
      ...receipt(settleOnlyFailedChannel, evmNetwork),
      settlementStatus: "failed",
      settleTxHash: settleOnlyFailedHash,
    } as unknown as Receipt);
    assert.equal(settleOnlyFailed.txHash, settleOnlyFailedHash);
    await assert.rejects(
      storeReceipt({
        ...receipt(settleOnlyFailedChannel, evmNetwork),
        settlementStatus: "settled",
        settleTxHash: `0x${"89".repeat(32)}`,
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );

    await assert.rejects(
      storeReceipt({
        ...receipt(inconsistentChannel, evmNetwork),
        settlementStatus: "settled",
        txHash: `0x${"83".repeat(32)}`,
        settleTxHash: `0x${"84".repeat(32)}`,
        settledAt: Date.now(),
      } as unknown as Receipt),
      /terminal transaction mismatch/i,
    );
  } finally {
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: canonicalChannel });
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: conflictingChannel });
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: settleOnlyFailedChannel });
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: inconsistentChannel });
    await cleanupBatchReceiptState({ userAddress, network: svmNetwork, channelId: svmChannel });
  }
});

test("rejected batch terminal conflict leaves reconciliation and sibling receipts unchanged", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const failedTxHash = `0x${"85".repeat(32)}`;
  const conflictingSettleTxHash = `0x${"86".repeat(32)}`;
  const claimTxHash = `0x${"87".repeat(32)}`;
  const reconciliationKey = `x402:batch-reconciliation:${network}:${batchChannelIdentity(channelId, network)}`;

  try {
    const failed = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      settlementStatus: "failed",
      txHash: failedTxHash,
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    const queued = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "50",
      settlementStatus: "queued",
      finalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
    } as unknown as Receipt);

    await assert.rejects(
      markBatchReceiptsSettled({
        channelId,
        network,
        claimedAmountWei: "100",
        claimTxHash,
        settleTxHash: conflictingSettleTxHash,
      }),
      /terminal transaction mismatch/i,
    );

    const valkey = await getValkeyClient();
    assert.deepEqual(await valkey.hgetall(reconciliationKey), {});
    let listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.find((receipt) => receipt.id === failed.id)?.settlementStatus, "failed");
    assert.equal(listed.receipts.find((receipt) => receipt.id === failed.id)?.txHash, failedTxHash);
    assert.equal(listed.receipts.find((receipt) => receipt.id === queued.id)?.settlementStatus, "queued");
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "0",
      providerAmountWei: "0",
      platformFeeWei: "0",
      receiptCount: 0,
    });

    assert.equal(await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash,
      settleTxHash: failedTxHash,
    }), 2);
    listed = await listReceipts({ userAddress, network });
    assert.ok(listed.receipts.every((receipt) => receipt.settlementStatus === "settled"));
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "33",
      providerAmountWei: "30",
      platformFeeWei: "3",
      receiptCount: 2,
    });
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("batch terminal prevalidation ignores failed receipts above the incoming watermark", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const higherFailedTxHash = `0x${"8a".repeat(32)}`;
  const lowerSettleTxHash = `0x${"8b".repeat(32)}`;

  try {
    const higherFailed = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "150",
      settlementStatus: "failed",
      txHash: higherFailedTxHash,
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    const lowerQueued = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "50",
      settlementStatus: "queued",
      finalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
    } as unknown as Receipt);

    assert.equal(await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: `0x${"8c".repeat(32)}`,
      settleTxHash: lowerSettleTxHash,
    }), 1);

    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.find((receipt) => receipt.id === higherFailed.id)?.settlementStatus, "failed");
    assert.equal(listed.receipts.find((receipt) => receipt.id === higherFailed.id)?.txHash, higherFailedTxHash);
    assert.equal(listed.receipts.find((receipt) => receipt.id === lowerQueued.id)?.settlementStatus, "settled");
    assert.equal(listed.receipts.find((receipt) => receipt.id === lowerQueued.id)?.txHash, lowerSettleTxHash);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
      receiptCount: 1,
    });
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("batch reconciliation normalizes EVM hashes while preserving SVM case sensitivity", async () => {
  const userAddress = wallet();
  const evmNetwork = "eip155:5042002" as const;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const evmChannel = `0x${randomUUID().replace(/-/g, "")}`;
  const svmChannel = `channel-${randomUUID()}`;
  const claimUpper = `0x${"Ab".repeat(32)}`;
  const settleUpper = `0x${"Cd".repeat(32)}`;

  try {
    await storeReceipt({
      userAddress,
      network: evmNetwork,
      paymentChannelId: evmChannel,
      paymentCumulativeAmountWei: "80",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    await markBatchReceiptsSettled({
      channelId: evmChannel,
      network: evmNetwork,
      claimedAmountWei: "100",
      claimTxHash: claimUpper,
      settleTxHash: settleUpper,
    });
    const listed = await listReceipts({ userAddress, network: evmNetwork });
    assert.equal(listed.receipts[0]?.claimTxHash, claimUpper.toLowerCase());
    assert.equal(listed.receipts[0]?.settleTxHash, settleUpper.toLowerCase());
    assert.equal(listed.receipts[0]?.txHash, settleUpper.toLowerCase());
    await markBatchReceiptsSettled({
      channelId: evmChannel,
      network: evmNetwork,
      claimedAmountWei: "100",
      claimTxHash: claimUpper.toLowerCase(),
      settleTxHash: settleUpper.toLowerCase(),
    });

    await markBatchReceiptsSettled({
      channelId: svmChannel,
      network: svmNetwork,
      claimedAmountWei: "100",
      claimTxHash: "SignatureABC",
      settleTxHash: "SettlementABC",
    });
    await assert.rejects(
      markBatchReceiptsSettled({
        channelId: svmChannel,
        network: svmNetwork,
        claimedAmountWei: "100",
        claimTxHash: "signatureabc",
        settleTxHash: "SettlementABC",
      }),
      /claim transaction mismatch for cumulative watermark 100/i,
    );
  } finally {
    await cleanupBatchReceiptState({ userAddress, network: evmNetwork, channelId: evmChannel });
    await cleanupBatchReceiptState({ userAddress, network: svmNetwork, channelId: svmChannel });
  }
});

test("out-of-order lower batch provenance replaces a higher covering projection", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const higherClaim = `0x${"71".repeat(32)}`;
  const higherSettle = `0x${"72".repeat(32)}`;
  const lowerClaim = `0x${"73".repeat(32)}`;
  const lowerSettle = `0x${"74".repeat(32)}`;

  try {
    await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "150",
      claimTxHash: higherClaim,
      settleTxHash: higherSettle,
    });
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash: lowerClaim,
      settleTxHash: lowerSettle,
    });

    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts[0]?.claimTxHash, lowerClaim);
    assert.equal(listed.receipts[0]?.settleTxHash, lowerSettle);
    assert.equal(listed.receipts[0]?.txHash, lowerSettle);
    await assert.rejects(
      markBatchReceiptsSettled({
        channelId,
        network,
        claimedAmountWei: "100",
        claimTxHash: `0x${"75".repeat(32)}`,
        settleTxHash: lowerSettle,
      }),
      /claim transaction mismatch for cumulative watermark 100/i,
    );
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("no-op batch reconciliation refreshes receipt and discovery TTLs together", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const intentId = `pi_${randomUUID()}`;
  const claimTxHash = `0x${"76".repeat(32)}`;
  const settleTxHash = `0x${"77".repeat(32)}`;
  const identity = batchChannelIdentity(channelId, network);
  let receiptId: string | undefined;

  try {
    const stored = await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    receiptId = stored.id;
    assert.ok(receiptId);
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash,
      settleTxHash,
    });

    const keys = [
      `x402:receipt:${receiptId}`,
      `x402:receipt:user:${network}:${userAddress}`,
      `x402:receipt:batch:${network}:${identity}`,
      `x402:receipt:intent:${intentId}`,
      `x402:receipt:aggregate:${network}:${userAddress}`,
    ];
    for (const key of keys) {
      assert.equal(await valkeyExpire(key, 1), true, `expected ${key} to exist before reconciliation`);
    }

    assert.equal(await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash,
      settleTxHash,
    }), 0);
    await delay(1_100);

    const valkey = await getValkeyClient();
    for (const key of keys) {
      assert.equal(await valkey.exists(key), 1, `no-op reconciliation did not refresh ${key}`);
    }
  } finally {
    if (receiptId) await valkeyDel(`x402:receipt:${receiptId}`);
    await cleanupBatchReceiptState({ userAddress, network, channelId });
    await valkeyDel(`x402:receipt:intent:${intentId}`);
  }
});

test("legacy id-only payment-intent hashes do not project receipts", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;

  try {
    await valkeyHSet(`payment-intent:${intentId}`, {
      id: intentId,
      status: "confirmed",
      txHash: `0x${"78".repeat(32)}`,
      network,
      confirmedAt: String(Date.now()),
    });
    const nonBatch = await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    const batch = await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      settlementStatus: "queued",
      finalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
    } as unknown as Receipt);

    assert.equal(nonBatch.settlementStatus, "queued");
    assert.equal(nonBatch.txHash, undefined);
    assert.equal(batch.settlementStatus, "queued");
    assert.equal(batch.txHash, undefined);
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("receipt listing filters and removes foreign index memberships", async () => {
  const userAddress = wallet();
  const foreignUserAddress = wallet();
  const network = "eip155:5042002" as const;
  const foreignNetwork = "eip155:43114" as const;
  const foreignUserIntentId = `pi_${randomUUID()}`;
  const foreignNetworkIntentId = `pi_${randomUUID()}`;
  const targetIndex = `x402:receipt:user:${network}:${userAddress}`;

  try {
    const foreignUserReceipt = await storeReceipt({
      userAddress: foreignUserAddress,
      network,
      paymentIntentId: foreignUserIntentId,
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    const foreignNetworkReceipt = await storeReceipt({
      userAddress,
      network: foreignNetwork,
      paymentIntentId: foreignNetworkIntentId,
      settlementStatus: "queued",
      finalAmountWei: "22",
      providerAmountWei: "20",
      platformFeeWei: "2",
    } as unknown as Receipt);
    assert.ok(foreignUserReceipt.id);
    assert.ok(foreignNetworkReceipt.id);
    await valkeySAdd(targetIndex, foreignUserReceipt.id, foreignNetworkReceipt.id);

    const listed = await listReceipts({ userAddress, network });
    assert.deepEqual(listed.receipts, []);
    assert.deepEqual(await valkeySMembers(targetIndex), []);
  } finally {
    await valkeyDel(targetIndex);
    await cleanupReceiptState(foreignUserAddress, network, foreignUserIntentId);
    await cleanupReceiptState(userAddress, foreignNetwork, foreignNetworkIntentId);
  }
});

test("intent projection rejects a mismatched index record and conflicting settled hash", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const firstIntentId = `pi_${randomUUID()}`;
  const wrongIntentId = `pi_${randomUUID()}`;
  const firstTxHash = `0x${"51".repeat(32)}`;
  let receiptId: string | undefined;

  try {
    const stored = await storeReceipt({
      userAddress,
      network,
      paymentIntentId: firstIntentId,
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    receiptId = stored.id;
    assert.ok(receiptId);
    await valkeySAdd(`x402:receipt:intent:${wrongIntentId}`, receiptId);
    await assert.rejects(
      markIntentReceiptsSettled({ paymentIntentId: wrongIntentId, txHash: firstTxHash }),
      /payment intent mismatch/i,
    );

    await markIntentReceiptsSettled({ paymentIntentId: firstIntentId, txHash: firstTxHash });
    await assert.rejects(
      markIntentReceiptsSettled({
        paymentIntentId: firstIntentId,
        txHash: `0x${"52".repeat(32)}`,
      }),
      /terminal transaction mismatch/i,
    );
  } finally {
    await cleanupReceiptState(userAddress, network, firstIntentId);
    await valkeyDel(`x402:receipt:intent:${wrongIntentId}`);
  }
});

test("batch receipt publication rolls back when its aggregate transition fails", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const claimTxHash = `0x${"a1".repeat(32)}`;
  const settleTxHash = `0x${"a2".repeat(32)}`;

  try {
    await markBatchReceiptsSettled({
      channelId,
      network,
      claimedAmountWei: "100",
      claimTxHash,
      settleTxHash,
    });
    await assert.rejects(
      storeReceipt({
        userAddress,
        network,
        paymentChannelId: channelId,
        paymentCumulativeAmountWei: "80",
        settlementStatus: "queued",
        finalAmountWei: "invalid",
        providerAmountWei: "10",
        platformFeeWei: "1",
      } as unknown as Receipt),
      /receipt aggregate values must be unsigned decimal integers/,
    );

    let listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 0, "failed aggregate must roll back receipt publication");
    assert.equal(listed.cumulative.receiptCount, 0);

    const stored = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    assert.equal(stored.settlementStatus, "settled");
    listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
      receiptCount: 1,
    });

    await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      settlementStatus: "queued",
      finalAmountWei: "11",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    listed = await listReceipts({ userAddress, network });
    assert.equal(listed.cumulative.receiptCount, 1);
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("batch settlement rolls back receipt status when its aggregate transition fails", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;

  try {
    const queued = await storeReceipt({
      userAddress,
      network,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      settlementStatus: "queued",
      finalAmountWei: "invalid",
      providerAmountWei: "10",
      platformFeeWei: "1",
    } as unknown as Receipt);
    assert.equal(queued.settlementStatus, "queued");

    await assert.rejects(
      markBatchReceiptsSettled({
        channelId,
        network,
        claimedAmountWei: "100",
        claimTxHash: `0x${"b1".repeat(32)}`,
        settleTxHash: `0x${"b2".repeat(32)}`,
      }),
      /receipt aggregate values must be unsigned decimal integers/,
    );

    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts[0]?.settlementStatus, "queued");
    assert.equal(listed.receipts[0]?.settledAt, undefined);
    assert.deepEqual(listed.cumulative, {
      totalAmountWei: "0",
      providerAmountWei: "0",
      platformFeeWei: "0",
      receiptCount: 0,
    });
  } finally {
    await cleanupBatchReceiptState({ userAddress, network, channelId });
  }
});

test("terminal intent failure marks queued receipt failed without applying paid totals", async () => {
  const userAddress = wallet();
  const network = "eip155:5042002" as const;
  const intentId = `pi_${randomUUID()}`;
  try {
    await storeReceipt({
      userAddress,
      network,
      paymentIntentId: intentId,
      settlementStatus: "queued",
      finalAmountWei: "303",
      providerAmountWei: "300",
      platformFeeWei: "3",
    } as unknown as Receipt);
    await markIntentReceiptsFailed({ paymentIntentId: intentId, error: "transaction reverted" });

    const listed = await listReceipts({ userAddress, network });
    assert.equal(listed.receipts.length, 1);
    assert.equal(listed.receipts[0]?.settlementStatus, "failed");
    assert.equal(listed.receipts[0]?.settledAt, undefined);
    assert.equal(listed.cumulative.totalAmountWei, "0");
    assert.equal(listed.cumulative.receiptCount, 0);
  } finally {
    await cleanupReceiptState(userAddress, network, intentId);
  }
});

test("stream receipts expose canonical checkpoint and execution identity", () => {
  const receipt: Receipt = {
    finalAmountWei: "101",
    checkpointAmountWei: "101",
    cumulativeAmountWei: "303",
    checkpointSequence: 2,
    rootRunId: "root-1",
    executionRunId: "execution-4",
    parentExecutionRunId: "execution-1",
    paymentIntentId: "intent-3",
    settlementStatus: "submitted",
    txHash: "0xabc",
    network: "eip155:5042002",
    settledAt: 1,
  };

  assert.deepEqual(receiptStreamPayload(receipt), {
    id: undefined,
    service: undefined,
    action: undefined,
    resource: undefined,
    userAddress: undefined,
    finalAmountWei: "101",
    checkpointAmountWei: "101",
    cumulativeAmountWei: "303",
    checkpointSequence: 2,
    rootRunId: "root-1",
    executionRunId: "execution-4",
    parentExecutionRunId: "execution-1",
    providerAmountWei: undefined,
    platformFeeWei: undefined,
    meterSubject: undefined,
    lineItems: undefined,
    bills: undefined,
    txHash: "0xabc",
    settlementStatus: "submitted",
    claimTxHash: undefined,
    settleTxHash: undefined,
    paymentIntentId: "intent-3",
    paymentChannelId: undefined,
    paymentCumulativeAmountWei: undefined,
    network: "eip155:5042002",
    settledAt: 1,
    cumulative: undefined,
  });
});

test("a transaction hash without confirmed state is represented as submitted, never settled", () => {
  const receipt = receiptFromInferenceSettlement({
    finalAmountWei: "101",
    txHash: `0x${"90".repeat(32)}`,
  }, "eip155:5042002");

  assert.equal(receipt?.settlementStatus, "submitted");
  assert.equal(receipt?.settledAt, undefined);
});

test("receipt JSON never emits the removed Session-budget intent alias", () => {
  const receipt = {
    finalAmountWei: "101",
    paymentIntentId: "intent-3",
    sessionBudgetIntentId: "legacy-session-intent",
    settlementStatus: "queued",
    network: "eip155:5042002",
    settledAt: 1,
  } as Receipt & { sessionBudgetIntentId: string };

  const body = receiptForJsonBody(receipt);

  assert.equal(body?.payment_intent_id, "intent-3");
  assert.equal("session_budget_intent_id" in (body || {}), false);
});

test("receipt listing requires x-session-user-address header", async () => {
  const app = express();
  registerUtilityRoutes(app);
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/receipts?network=eip155%3A43114`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("receipt listing returns authorized receipts", async () => {
  const userAddress = wallet();

  const app = express();
  registerUtilityRoutes(app);
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;

    const authorized = await fetch(`http://127.0.0.1:${port}/api/receipts?network=eip155%3A43114`, {
      headers: { "x-session-user-address": userAddress, "x-network-id": "eip155:43114" },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json() as { userAddress?: string };
    assert.equal(body.userAddress, userAddress);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeValkey();
  }
});
