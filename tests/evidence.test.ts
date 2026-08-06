import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  listChildEvidence,
  listExecutionEvidence,
  markBatchEvidenceSettled,
  markIntentEvidenceFailed,
  markIntentEvidenceSettled,
  recordChargeEvidence,
} from "../x402/evidence.js";
import {
  closeValkey,
  getValkeyClient,
  valkeyDel,
  valkeyExpire,
  valkeyHGetAll,
  valkeyHSet,
  valkeySAdd,
  valkeySMembers,
} from "../x402/keys/valkey.js";
import type { ChargeEvidence } from "../x402/evidence.js";

const NETWORK = "eip155:5042002" as const;

after(async () => {
  await closeValkey();
});

type InterceptableValkey = {
  hset: (...args: unknown[]) => Promise<unknown>;
  eval: (...args: unknown[]) => Promise<unknown>;
};

async function forceEvidenceWriteAfterConcurrentTransition<T>(input: {
  settlementStatus: NonNullable<ChargeEvidence["settlementStatus"]>;
  concurrentTransition: () => Promise<unknown>;
  write: () => Promise<T>;
}): Promise<T> {
  const valkey = await getValkeyClient() as unknown as InterceptableValkey;
  const originalHSet = valkey.hset;
  const originalEval = valkey.eval;
  const statusNeedle = `"settlementStatus":"${input.settlementStatus}"`;
  let intercepted = false;

  const intercept = async (args: unknown[]): Promise<void> => {
    if (intercepted) return;
    const evidenceHashWrite = typeof args[0] === "string" && args[0].startsWith("x402:evidence:charge:");
    const carriesStatus = args.some((value) => (
      typeof value === "string"
        ? value.includes(statusNeedle)
        : Boolean(value && typeof value === "object"
          && (value as Record<string, unknown>).settlementStatus === input.settlementStatus)
    ));
    if (!carriesStatus || (!evidenceHashWrite && !args.some((value) => (
      typeof value === "string" && value.includes("x402:evidence")
    )))) return;
    intercepted = true;
    await input.concurrentTransition();
  };

  valkey.hset = async (...args: unknown[]): Promise<unknown> => {
    await intercept(args);
    return originalHSet.apply(valkey, args);
  };
  valkey.eval = async (...args: unknown[]): Promise<unknown> => {
    await intercept(args);
    return originalEval.apply(valkey, args);
  };

  try {
    const result = await input.write();
    assert.equal(intercepted, true, `expected to intercept ${input.settlementStatus} evidence write`);
    return result;
  } finally {
    valkey.hset = originalHSet;
    valkey.eval = originalEval;
  }
}

async function cleanupEvidence(input: {
  id?: string;
  intentId: string;
  rootRunId: string;
  executionRunId: string;
  parentExecutionRunIds?: string[];
}): Promise<void> {
  if (input.id) await valkeyDel(`x402:evidence:charge:${input.id}`);
  await valkeyDel(`x402:evidence:intent:${input.intentId}`);
  await valkeyDel(`x402:evidence:root:${input.rootRunId}:execution:${input.executionRunId}`);
  await valkeyDel(`x402:evidence:root:${input.rootRunId}:all`);
  for (const parentExecutionRunId of input.parentExecutionRunIds || []) {
    await valkeyDel(`x402:evidence:root:${input.rootRunId}:parent:${parentExecutionRunId}`);
  }
  await valkeyDel(`payment-intent:${input.intentId}`);
}

function batchChannelIdentity(channelId: string, network: string): string {
  return network.startsWith("eip155:") ? channelId.toLowerCase() : channelId;
}

async function cleanupBatchEvidence(input: {
  ids: Array<string | undefined>;
  channelIds: string[];
  network: string;
  rootRunId: string;
  executionRunId: string;
  parentExecutionRunId?: string;
  intentId?: string;
}): Promise<void> {
  const ids = new Set(input.ids.filter((id): id is string => Boolean(id)));
  for (const evidence of await listExecutionEvidence(input.rootRunId, input.executionRunId)) {
    if (evidence.id) ids.add(evidence.id);
  }
  for (const id of ids) {
    if (id) await valkeyDel(`x402:evidence:charge:${id}`);
  }
  for (const channelId of input.channelIds) {
    const identity = batchChannelIdentity(channelId, input.network);
    await valkeyDel(`x402:evidence:channel:${input.network}:${identity}`);
    await valkeyDel(`x402:batch-reconciliation:${input.network}:${identity}`);
  }
  await valkeyDel(`x402:evidence:root:${input.rootRunId}:execution:${input.executionRunId}`);
  await valkeyDel(`x402:evidence:root:${input.rootRunId}:all`);
  if (input.parentExecutionRunId) {
    await valkeyDel(`x402:evidence:root:${input.rootRunId}:parent:${input.parentExecutionRunId}`);
  }
  if (input.intentId) await valkeyDel(`x402:evidence:intent:${input.intentId}`);
}

test("non-batch evidence publication and transitions share one atomic state machine", () => {
  const source = readFileSync(new URL("../x402/evidence.ts", import.meta.url), "utf8");
  const transitionStart = source.indexOf("async function transitionNonBatchEvidence");
  const transitionEnd = source.indexOf("export async function recordChargeEvidence");
  assert.notEqual(transitionStart, -1, "non-batch evidence must share one atomic state machine");
  assert.ok(transitionEnd > transitionStart);
  const transition = source.slice(transitionStart, transitionEnd);
  assert.match(transition, /\.eval\(/);
  assert.match(transition, /payment-intent:/);
  assert.doesNotMatch(transition, /valkeyHGetAll|valkeyHSet|valkeySAdd|valkeyExpire/);
  assert.doesNotMatch(source, /reconcileIntentEvidence/);
});

test("semantic evidence identity is validated before incomplete display metadata is ignored", async () => {
  const chargeId = `charge_${randomUUID()}`;
  const incomplete = {
    kind: "model" as const,
    rootRunId: "",
    executionRunId: "",
    chargeId,
    providerAmountWei: "10",
    feeWei: "1",
    finalAmountWei: "11",
    network: NETWORK,
  };

  await assert.rejects(
    recordChargeEvidence({
      ...incomplete,
      id: `chg_${randomUUID().replace(/-/g, "")}`,
    }),
    /explicit evidence id conflicts with canonical backing/i,
  );
  assert.deepEqual(await recordChargeEvidence(incomplete), incomplete);
});

test("legacy payment intent id fields cannot project evidence publication", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const txHash = `0x${"ce".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    await valkeyHSet(`payment-intent:${intentId}`, {
      id: intentId,
      status: "confirmed",
      txHash,
      network: NETWORK,
      confirmedAt: String(Date.now()),
    });
    const queued = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      network: NETWORK,
    });
    evidenceId = queued.id;
    assert.equal(queued.settlementStatus, "queued");
    assert.equal(queued.txHash, undefined);

    await valkeyHSet(`payment-intent:${intentId}`, { paymentIntentId: intentId });
    const projected = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      network: NETWORK,
    });
    assert.equal(projected.settlementStatus, "settled");
    assert.equal(projected.txHash, txHash);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});

test("queued intent evidence is deterministic and gains settlement time only after confirmation", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  let evidenceId: string | undefined;
  try {
    const input = {
      kind: "model" as const,
      rootRunId,
      executionRunId,
      providerAmountWei: "100",
      feeWei: "1",
      finalAmountWei: "101",
      settlementStatus: "queued" as const,
      paymentIntentId: intentId,
      network: NETWORK,
    };
    const first = await recordChargeEvidence(input);
    const replay = await recordChargeEvidence(input);
    evidenceId = first.id;
    assert.equal(replay.id, first.id);

    let evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.settlementStatus, "queued");
    assert.equal(evidence[0]?.settledAt, undefined);

    const txHash = `0x${"ab".repeat(32)}`;
    await markIntentEvidenceSettled({ paymentIntentId: intentId, txHash, network: NETWORK });
    await markIntentEvidenceSettled({ paymentIntentId: intentId, txHash, network: NETWORK });
    evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.settlementStatus, "settled");
    assert.equal(evidence[0]?.txHash, txHash);
    assert.ok(evidence[0]?.settledAt);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});

test("queued evidence replay cannot overwrite a concurrent settlement", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const txHash = `0x${"aa".repeat(32)}`;
  const input = {
    kind: "model" as const,
    rootRunId,
    executionRunId,
    providerAmountWei: "100",
    feeWei: "1",
    finalAmountWei: "101",
    settlementStatus: "queued" as const,
    paymentIntentId: intentId,
    network: NETWORK,
  };
  let evidenceId: string | undefined;

  try {
    evidenceId = (await recordChargeEvidence(input)).id;
    await forceEvidenceWriteAfterConcurrentTransition({
      settlementStatus: "queued",
      concurrentTransition: () => markIntentEvidenceSettled({
        paymentIntentId: intentId,
        txHash,
        network: NETWORK,
      }),
      write: () => recordChargeEvidence(input),
    });
    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence[0]?.settlementStatus, "settled");
    assert.equal(evidence[0]?.txHash, txHash);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});

test("terminal evidence failure cannot overwrite a concurrent settlement", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const txHash = `0x${"a9".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    evidenceId = (await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "100",
      feeWei: "1",
      finalAmountWei: "101",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      network: NETWORK,
    })).id;
    await forceEvidenceWriteAfterConcurrentTransition({
      settlementStatus: "failed",
      concurrentTransition: () => markIntentEvidenceSettled({
        paymentIntentId: intentId,
        txHash,
        network: NETWORK,
      }),
      write: () => markIntentEvidenceFailed({
        paymentIntentId: intentId,
        error: "transaction reverted",
      }),
    });
    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence[0]?.settlementStatus, "settled");
    assert.equal(evidence[0]?.txHash, txHash);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});

test("first evidence publication self-projects an intent confirmed after an empty projection scan", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const txHash = `0x${"ac".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    await valkeyHSet(`payment-intent:${intentId}`, {
      paymentIntentId: intentId,
      status: "queued",
      network: NETWORK,
    });
    const stored = await forceEvidenceWriteAfterConcurrentTransition({
      settlementStatus: "queued",
      concurrentTransition: async () => {
        await valkeyHSet(`payment-intent:${intentId}`, {
          status: "confirmed",
          txHash,
          network: NETWORK,
          confirmedAt: String(Date.now()),
        });
        assert.equal(
          await markIntentEvidenceSettled({ paymentIntentId: intentId, txHash, network: NETWORK }),
          0,
          "terminal projection must scan an empty evidence index before publication resumes",
        );
      },
      write: () => recordChargeEvidence({
        kind: "model",
        rootRunId,
        executionRunId,
        providerAmountWei: "100",
        feeWei: "1",
        finalAmountWei: "101",
        settlementStatus: "queued",
        paymentIntentId: intentId,
        network: NETWORK,
      }),
    });
    evidenceId = stored.id;
    assert.equal(stored.settlementStatus, "settled");
    assert.equal(stored.txHash, txHash);
    assert.ok(stored.settledAt);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});

test("evidence creation reconciles an intent that confirmed before metadata was stored", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const txHash = `0x${"cd".repeat(32)}`;
  let evidenceId: string | undefined;
  try {
    await valkeyHSet(`payment-intent:${intentId}`, {
      paymentIntentId: intentId,
      status: "confirmed",
      txHash,
      network: NETWORK,
    });
    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "200",
      feeWei: "2",
      finalAmountWei: "202",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      network: NETWORK,
    });
    evidenceId = stored.id;
    assert.equal(stored.settlementStatus, "settled");
    assert.equal(stored.txHash, txHash);
    assert.ok(stored.settledAt);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});

test("batch evidence created after a claim is claimed immediately and later settles monotonically", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const claimTxHash = `0x${"de".repeat(32)}`;
  const settleTxHash = `0x${"ef".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    const marked = await markBatchEvidenceSettled({
      channelId: channelId.toUpperCase(),
      claimedAmountWei: "500",
      claimTxHash,
      network: NETWORK,
    });
    assert.equal(marked, 0, "no metadata exists at chain-reconciliation time");
    await markBatchEvidenceSettled({
      channelId,
      claimedAmountWei: "300",
      claimTxHash: `0x${"d0".repeat(32)}`,
      network: NETWORK,
    });

    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "300",
      feeWei: "3",
      finalAmountWei: "303",
      settlementStatus: "queued",
      paymentChannelId: channelId.toLowerCase(),
      paymentCumulativeAmountWei: "400",
      network: NETWORK,
    });
    evidenceId = stored.id;
    assert.equal(stored.settlementStatus, "claimed");
    assert.equal(stored.claimTxHash, claimTxHash);
    assert.equal(stored.network, NETWORK);
    assert.equal(stored.settledAt, undefined);

    await markBatchEvidenceSettled({
      channelId,
      claimedAmountWei: "500",
      claimTxHash,
      settleTxHash,
      network: NETWORK,
    });
    let evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence[0]?.settlementStatus, "settled");
    assert.equal(evidence[0]?.claimTxHash, claimTxHash);
    assert.equal(evidence[0]?.settleTxHash, settleTxHash);
    assert.equal(evidence[0]?.txHash, settleTxHash);
    assert.equal(evidence[0]?.network, NETWORK);
    assert.ok(evidence[0]?.settledAt);
    const settledAt = evidence[0]?.settledAt;

    await markBatchEvidenceSettled({
      channelId,
      claimedAmountWei: "200",
      claimTxHash: `0x${"f0".repeat(32)}`,
      network: NETWORK,
    });
    evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence[0]?.settlementStatus, "settled");
    assert.equal(evidence[0]?.claimTxHash, claimTxHash);
    assert.equal(evidence[0]?.settleTxHash, settleTxHash);
    assert.equal(evidence[0]?.settledAt, settledAt);
  } finally {
    await cleanupBatchEvidence({
      ids: [evidenceId],
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
    });
  }
});

test("authoritative batch settlement supersedes previously failed evidence", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  let evidenceId: string | undefined;

  try {
    const failed = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "100",
      feeWei: "1",
      finalAmountWei: "101",
      settlementStatus: "failed",
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      network: NETWORK,
    });
    evidenceId = failed.id;
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: `0x${"ad".repeat(32)}`,
      settleTxHash: `0x${"ae".repeat(32)}`,
    });
    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence[0]?.settlementStatus, "settled");
    assert.equal(evidence[0]?.settleTxHash, `0x${"ae".repeat(32)}`);
  } finally {
    await cleanupBatchEvidence({
      ids: [evidenceId],
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
    });
  }
});

test("batch evidence transitions refresh every discovery index with the record lifetime", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const parentExecutionRunId = `parent_${randomUUID()}`;
  const intentId = `pi_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  let evidenceId: string | undefined;
  const identity = batchChannelIdentity(channelId, NETWORK);
  const keys = [
    `x402:evidence:root:${rootRunId}:execution:${executionRunId}`,
    `x402:evidence:root:${rootRunId}:all`,
    `x402:evidence:root:${rootRunId}:parent:${parentExecutionRunId}`,
    `x402:evidence:channel:${NETWORK}:${identity}`,
    `x402:evidence:intent:${intentId}`,
  ];

  try {
    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      parentExecutionRunId,
      providerAmountWei: "100",
      feeWei: "1",
      finalAmountWei: "101",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "100",
      network: NETWORK,
    });
    evidenceId = stored.id;
    assert.ok(evidenceId);
    await Promise.all(keys.map((indexKey) => valkeyExpire(indexKey, 1)));
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: `0x${"af".repeat(32)}`,
      settleTxHash: `0x${"b0".repeat(32)}`,
    });
    await delay(1_100);
    for (const indexKey of keys) {
      assert.ok((await valkeySMembers(indexKey)).includes(evidenceId), `${indexKey} must remain discoverable`);
    }
  } finally {
    await cleanupBatchEvidence({
      ids: [evidenceId],
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
      parentExecutionRunId,
      intentId,
    });
  }
});

test("batch evidence selects earliest covering claim and settlement transitions independently", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const firstClaimTxHash = `0x${"11".repeat(32)}`;
  const secondClaimTxHash = `0x${"21".repeat(32)}`;
  const secondSettleTxHash = `0x${"22".repeat(32)}`;
  const ids: Array<string | undefined> = [];

  try {
    const storedBefore = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "90",
      network: NETWORK,
    });
    ids.push(storedBefore.id);
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: firstClaimTxHash,
    });
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "150",
      claimTxHash: secondClaimTxHash,
      settleTxHash: secondSettleTxHash,
    });

    const storedAfter = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      network: NETWORK,
    });
    ids.push(storedAfter.id);

    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    const reconciledBefore = evidence.find((item) => item.id === storedBefore.id);
    assert.equal(reconciledBefore?.settlementStatus, "settled");
    assert.equal(reconciledBefore?.claimTxHash, firstClaimTxHash);
    assert.equal(reconciledBefore?.settleTxHash, secondSettleTxHash);
    assert.equal(reconciledBefore?.txHash, secondSettleTxHash);
    assert.equal(storedAfter.settlementStatus, "settled");
    assert.equal(storedAfter.claimTxHash, firstClaimTxHash);
    assert.equal(storedAfter.settleTxHash, secondSettleTxHash);
    assert.equal(storedAfter.txHash, secondSettleTxHash);
    await assert.rejects(
      markBatchEvidenceSettled({
        channelId,
        network: NETWORK,
        claimedAmountWei: "150",
        claimTxHash: secondClaimTxHash,
        settleTxHash: `0x${"23".repeat(32)}`,
      }),
      /settle transaction mismatch for cumulative watermark 150/,
    );
  } finally {
    await cleanupBatchEvidence({
      ids,
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
    });
  }
});

test("batch evidence adopts a later-arriving lower covering provenance transition", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const higherClaim = `0x${"61".repeat(32)}`;
  const higherSettle = `0x${"62".repeat(32)}`;
  const lowerClaim = `0x${"63".repeat(32)}`;
  const lowerSettle = `0x${"64".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    evidenceId = (await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      network: NETWORK,
    })).id;
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "150",
      claimTxHash: higherClaim,
      settleTxHash: higherSettle,
    });
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: lowerClaim,
      settleTxHash: lowerSettle,
    });

    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence[0]?.claimTxHash, lowerClaim);
    assert.equal(evidence[0]?.settleTxHash, lowerSettle);
    assert.equal(evidence[0]?.txHash, lowerSettle);
  } finally {
    await cleanupBatchEvidence({
      ids: [evidenceId],
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
    });
  }
});

test("batch reconciliation normalizes EVM transaction identity but preserves SVM case", async () => {
  const evmRootRunId = `root_${randomUUID()}`;
  const evmExecutionRunId = `execution_${randomUUID()}`;
  const evmChannelId = `0x${randomUUID().replace(/-/g, "")}`;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const svmChannelId = `Channel${randomUUID().replace(/-/g, "")}`;
  let evidenceId: string | undefined;

  try {
    await markBatchEvidenceSettled({
      channelId: evmChannelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: "0xAbCd",
      settleTxHash: "0xEf01",
    });
    await markBatchEvidenceSettled({
      channelId: evmChannelId.toUpperCase(),
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: "0xabcd",
      settleTxHash: "0xef01",
    });
    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId: evmRootRunId,
      executionRunId: evmExecutionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentChannelId: evmChannelId,
      paymentCumulativeAmountWei: "80",
      network: NETWORK,
    });
    evidenceId = stored.id;
    assert.equal(stored.claimTxHash, "0xabcd");
    assert.equal(stored.settleTxHash, "0xef01");

    await markBatchEvidenceSettled({
      channelId: svmChannelId,
      network: svmNetwork,
      claimedAmountWei: "100",
      claimTxHash: "SignatureABC",
      settleTxHash: "SettlementABC",
    });
    await assert.rejects(
      markBatchEvidenceSettled({
        channelId: svmChannelId,
        network: svmNetwork,
        claimedAmountWei: "100",
        claimTxHash: "signatureabc",
        settleTxHash: "settlementabc",
      }),
      /claim transaction mismatch for cumulative watermark 100/,
    );
  } finally {
    await cleanupBatchEvidence({
      ids: [evidenceId],
      channelIds: [evmChannelId],
      network: NETWORK,
      rootRunId: evmRootRunId,
      executionRunId: evmExecutionRunId,
    });
    await valkeyDel(`x402:batch-reconciliation:${svmNetwork}:${svmChannelId}`);
  }
});

test("no-op batch reconciliation refreshes evidence and every discovery index together", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const parentExecutionRunId = `parent_${randomUUID()}`;
  const intentId = `pi_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const claimTxHash = `0x${"71".repeat(32)}`;
  const settleTxHash = `0x${"72".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      parentExecutionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      paymentChannelId: channelId,
      paymentCumulativeAmountWei: "80",
      network: NETWORK,
    });
    evidenceId = stored.id;
    assert.ok(evidenceId);
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash,
      settleTxHash,
    });
    const indexKeys = [
      `x402:evidence:root:${rootRunId}:execution:${executionRunId}`,
      `x402:evidence:root:${rootRunId}:all`,
      `x402:evidence:root:${rootRunId}:parent:${parentExecutionRunId}`,
      `x402:evidence:channel:${NETWORK}:${batchChannelIdentity(channelId, NETWORK)}`,
      `x402:evidence:intent:${intentId}`,
    ];
    await Promise.all([
      valkeyExpire(`x402:evidence:charge:${evidenceId}`, 1),
      ...indexKeys.map((indexKey) => valkeyExpire(indexKey, 1)),
    ]);
    assert.equal(await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash,
      settleTxHash,
    }), 0, "same provenance is a no-op state transition");
    await delay(1_100);
    assert.equal((await valkeyHGetAll(`x402:evidence:charge:${evidenceId}`)).id, evidenceId);
    for (const indexKey of indexKeys) {
      assert.ok((await valkeySMembers(indexKey)).includes(evidenceId));
    }
  } finally {
    await cleanupBatchEvidence({
      ids: [evidenceId],
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
      parentExecutionRunId,
      intentId,
    });
  }
});

test("batch evidence rejects noncanonical cumulative identity before storage", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const channelId = `0x${randomUUID().replace(/-/g, "")}`;
  const ids: Array<string | undefined> = [];
  const input = {
    kind: "model" as const,
    rootRunId,
    executionRunId,
    providerAmountWei: "10",
    feeWei: "1",
    finalAmountWei: "11",
    settlementStatus: "queued" as const,
    paymentChannelId: channelId,
    network: NETWORK,
  };

  try {
    await markBatchEvidenceSettled({
      channelId,
      network: NETWORK,
      claimedAmountWei: "100",
      claimTxHash: `0x${"31".repeat(32)}`,
      settleTxHash: `0x${"32".repeat(32)}`,
    });
    await assert.rejects(
      recordChargeEvidence({
        ...input,
        id: `chg_${randomUUID().replace(/-/g, "")}`,
        paymentCumulativeAmountWei: "080",
      }),
      /Batch charge evidence cumulative amount must be a canonical unsigned decimal integer/,
    );

    const stored = await recordChargeEvidence({ ...input, paymentCumulativeAmountWei: "80" });
    ids.push(stored.id);
    const replay = await recordChargeEvidence({ ...input, paymentCumulativeAmountWei: "80" });
    assert.equal(replay.id, stored.id);
    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence.length, 1);
  } finally {
    await cleanupBatchEvidence({
      ids,
      channelIds: [channelId],
      network: NETWORK,
      rootRunId,
      executionRunId,
    });
  }
});

test("semantic evidence backing owns its canonical id and transaction case follows the network", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const chargeId = `charge_${randomUUID()}`;
  const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const evmTransaction = `0xAbCd${randomUUID().replace(/-/g, "")}`;
  const svmTransaction = `SignatureABC${randomUUID().replace(/-/g, "")}`;
  const ids: Array<string | undefined> = [];

  try {
    const canonical = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      chargeId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      network: NETWORK,
    });
    ids.push(canonical.id);
    await assert.rejects(
      recordChargeEvidence({
        id: `chg_${randomUUID().replace(/-/g, "")}`,
        kind: "model",
        rootRunId,
        executionRunId,
        chargeId,
        providerAmountWei: "10",
        feeWei: "1",
        finalAmountWei: "11",
        network: NETWORK,
      }),
      /explicit evidence id conflicts with canonical backing/i,
    );

    const evmUpper = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "20",
      feeWei: "2",
      finalAmountWei: "22",
      settlementStatus: "submitted",
      txHash: evmTransaction.toUpperCase(),
      network: NETWORK,
    });
    ids.push(evmUpper.id);
    const evmLower = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "20",
      feeWei: "2",
      finalAmountWei: "22",
      settlementStatus: "submitted",
      txHash: evmTransaction.toLowerCase(),
      network: NETWORK,
    });
    ids.push(evmLower.id);
    assert.equal(evmLower.id, evmUpper.id);

    const svmUpper = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "30",
      feeWei: "3",
      finalAmountWei: "33",
      settlementStatus: "submitted",
      txHash: svmTransaction,
      network: svmNetwork,
    });
    ids.push(svmUpper.id);
    const svmLower = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "30",
      feeWei: "3",
      finalAmountWei: "33",
      settlementStatus: "submitted",
      txHash: svmTransaction.toLowerCase(),
      network: svmNetwork,
    });
    ids.push(svmLower.id);
    assert.notEqual(svmLower.id, svmUpper.id);
  } finally {
    for (const id of ids) if (id) await valkeyDel(`x402:evidence:charge:${id}`);
    await valkeyDel(`x402:evidence:root:${rootRunId}:execution:${executionRunId}`);
    await valkeyDel(`x402:evidence:root:${rootRunId}:all`);
  }
});

test("parent execution is immutable and cannot split evidence discovery indexes", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const firstParent = `parent_${randomUUID()}`;
  const secondParent = `parent_${randomUUID()}`;
  const chargeId = `charge_${randomUUID()}`;
  let evidenceId: string | undefined;
  const input = {
    kind: "model" as const,
    rootRunId,
    executionRunId,
    chargeId,
    providerAmountWei: "10",
    feeWei: "1",
    finalAmountWei: "11",
    network: NETWORK,
  };

  try {
    evidenceId = (await recordChargeEvidence({ ...input, parentExecutionRunId: firstParent })).id;
    await assert.rejects(
      recordChargeEvidence({ ...input, parentExecutionRunId: secondParent }),
      /immutable parentExecutionRunId/i,
    );
    assert.equal((await listChildEvidence(rootRunId, firstParent)).length, 1);
    assert.equal((await listChildEvidence(rootRunId, secondParent)).length, 0);
  } finally {
    await cleanupEvidence({
      id: evidenceId,
      intentId: `unused_${randomUUID()}`,
      rootRunId,
      executionRunId,
      parentExecutionRunIds: [firstParent, secondParent],
    });
  }
});

test("evidence readers reject and clean foreign indexed records", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const parentExecutionRunId = `parent_${randomUUID()}`;
  const foreignRootRunId = `root_${randomUUID()}`;
  const foreignExecutionRunId = `execution_${randomUUID()}`;
  const foreignParentExecutionRunId = `parent_${randomUUID()}`;
  let evidenceId: string | undefined;
  let foreignId: string | undefined;
  const executionIndex = `x402:evidence:root:${rootRunId}:execution:${executionRunId}`;
  const parentIndex = `x402:evidence:root:${rootRunId}:parent:${parentExecutionRunId}`;

  try {
    evidenceId = (await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      parentExecutionRunId,
      chargeId: `charge_${randomUUID()}`,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      network: NETWORK,
    })).id;
    foreignId = (await recordChargeEvidence({
      kind: "model",
      rootRunId: foreignRootRunId,
      executionRunId: foreignExecutionRunId,
      parentExecutionRunId: foreignParentExecutionRunId,
      chargeId: `charge_${randomUUID()}`,
      providerAmountWei: "20",
      feeWei: "2",
      finalAmountWei: "22",
      network: NETWORK,
    })).id;
    assert.ok(evidenceId);
    assert.ok(foreignId);
    await Promise.all([
      valkeySAdd(executionIndex, foreignId),
      valkeySAdd(parentIndex, foreignId),
    ]);

    assert.deepEqual(
      (await listExecutionEvidence(rootRunId, executionRunId)).map((item) => item.id),
      [evidenceId],
    );
    assert.deepEqual(
      (await listChildEvidence(rootRunId, parentExecutionRunId)).map((item) => item.id),
      [evidenceId],
    );
    assert.equal((await valkeySMembers(executionIndex)).includes(foreignId), false);
    assert.equal((await valkeySMembers(parentIndex)).includes(foreignId), false);
  } finally {
    await cleanupEvidence({
      id: evidenceId,
      intentId: `unused_${randomUUID()}`,
      rootRunId,
      executionRunId,
      parentExecutionRunIds: [parentExecutionRunId],
    });
    await cleanupEvidence({
      id: foreignId,
      intentId: `unused_${randomUUID()}`,
      rootRunId: foreignRootRunId,
      executionRunId: foreignExecutionRunId,
      parentExecutionRunIds: [foreignParentExecutionRunId],
    });
  }
});

test("intent evidence projection rejects mismatched index records and conflicting terminal hashes", async () => {
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const intentId = `pi_${randomUUID()}`;
  const wrongIntentId = `pi_${randomUUID()}`;
  const firstTxHash = `0x${"b1".repeat(32)}`;
  let evidenceId: string | undefined;

  try {
    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      network: NETWORK,
    });
    evidenceId = stored.id;
    assert.ok(evidenceId);
    await valkeySAdd(`x402:evidence:intent:${wrongIntentId}`, evidenceId);
    await assert.rejects(
      markIntentEvidenceSettled({ paymentIntentId: wrongIntentId, txHash: firstTxHash, network: NETWORK }),
      /payment intent mismatch/i,
    );
    await markIntentEvidenceSettled({ paymentIntentId: intentId, txHash: firstTxHash, network: NETWORK });
    await assert.rejects(
      markIntentEvidenceSettled({
        paymentIntentId: intentId,
        txHash: `0x${"b2".repeat(32)}`,
        network: NETWORK,
      }),
      /terminal transaction mismatch/i,
    );
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
    await valkeyDel(`x402:evidence:intent:${wrongIntentId}`);
  }
});

test("SVM batch channel identity remains case-sensitive", async () => {
  const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  const exactChannelId = `Channel${randomUUID().replace(/-/g, "")}`;
  const differentChannelId = exactChannelId.toLowerCase();
  let exactId: string | undefined;
  let differentId: string | undefined;

  try {
    const exact = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "10",
      feeWei: "1",
      finalAmountWei: "11",
      settlementStatus: "queued",
      paymentChannelId: exactChannelId,
      paymentCumulativeAmountWei: "100",
      network,
    });
    exactId = exact.id;
    const different = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "20",
      feeWei: "2",
      finalAmountWei: "22",
      settlementStatus: "queued",
      paymentChannelId: differentChannelId,
      paymentCumulativeAmountWei: "100",
      network,
    });
    differentId = different.id;

    await markBatchEvidenceSettled({
      channelId: exactChannelId,
      claimedAmountWei: "100",
      claimTxHash: "svm-claim-signature",
      settleTxHash: "svm-settle-signature",
      network,
    });

    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    const exactStored = evidence.find((item) => item.id === exactId);
    const differentStored = evidence.find((item) => item.id === differentId);
    assert.equal(exactStored?.settlementStatus, "settled");
    assert.equal(differentStored?.settlementStatus, "queued");
  } finally {
    await cleanupBatchEvidence({
      ids: [exactId, differentId],
      channelIds: [exactChannelId, differentChannelId],
      network,
      rootRunId,
      executionRunId,
    });
  }
});

test("terminal intent failure marks queued evidence failed without a settlement timestamp", async () => {
  const intentId = `pi_${randomUUID()}`;
  const rootRunId = `root_${randomUUID()}`;
  const executionRunId = `execution_${randomUUID()}`;
  let evidenceId: string | undefined;
  try {
    const stored = await recordChargeEvidence({
      kind: "model",
      rootRunId,
      executionRunId,
      providerAmountWei: "300",
      feeWei: "3",
      finalAmountWei: "303",
      settlementStatus: "queued",
      paymentIntentId: intentId,
      network: NETWORK,
    });
    evidenceId = stored.id;
    await markIntentEvidenceFailed({ paymentIntentId: intentId, error: "transaction reverted" });

    const evidence = await listExecutionEvidence(rootRunId, executionRunId);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.settlementStatus, "failed");
    assert.equal(evidence[0]?.settledAt, undefined);
  } finally {
    await cleanupEvidence({ id: evidenceId, intentId, rootRunId, executionRunId });
  }
});
