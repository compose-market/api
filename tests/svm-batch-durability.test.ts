import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BATCH_SOURCE = await readFile(new URL("../x402/batch.ts", import.meta.url), "utf8");
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

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
  network: typeof NETWORK;
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

type StoredChannel = {
  channel: Channel;
  attempt?: Attempt;
  ownerToken?: string;
  ownerExpiresAt?: number;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemorySettlementStore {
  readonly records = new Map<string, StoredChannel>();
  readonly pending = new Set<string>();
  readonly events: string[] = [];

  seed(channel: Channel): void {
    this.records.set(channel.channelId, { channel: clone(channel) });
    this.pending.add(channel.channelId);
  }

  snapshot(channelId: string): StoredChannel {
    const record = this.records.get(channelId);
    assert.ok(record, `missing channel ${channelId}`);
    return clone(record);
  }

  async listPendingChannelIds(): Promise<string[]> {
    return [...this.pending];
  }

  async acquireAttempt(input: {
    channelId: string;
    ownerToken: string;
    now: number;
    ownerExpiresAt: number;
  }): Promise<Record<string, unknown>> {
    const record = this.records.get(input.channelId);
    if (!record) {
      this.pending.delete(input.channelId);
      return { outcome: "missing" };
    }
    if (record.attempt?.status === "failed") {
      return { outcome: "failed", work: clone({ channel: record.channel, attempt: record.attempt }) };
    }
    if (
      record.ownerToken
      && record.ownerToken !== input.ownerToken
      && (record.ownerExpiresAt || 0) > input.now
    ) {
      return { outcome: "busy", work: clone({ channel: record.channel, attempt: record.attempt }) };
    }
    if (!record.attempt) {
      const charged = BigInt(record.channel.chargedCumulativeAmount);
      const settled = BigInt(record.channel.settledCumulativeAmount);
      if (charged <= settled) {
        this.pending.delete(input.channelId);
        return { outcome: "settled" };
      }
      record.attempt = {
        status: "preparing",
        settledCumulativeAmountWei: settled.toString(),
        claimedCumulativeAmountWei: charged.toString(),
        deltaWei: (charged - settled).toString(),
      };
    }
    record.ownerToken = input.ownerToken;
    record.ownerExpiresAt = input.ownerExpiresAt;
    this.events.push(`acquire:${input.channelId}:${record.attempt.status}`);
    return { outcome: "acquired", work: clone({ channel: record.channel, attempt: record.attempt }) };
  }

  async persistPreparedAttempt(input: {
    channelId: string;
    ownerToken: string;
    prepared: { network: string; txHash: string; payload: string; nonce?: string };
    preparedAt: number;
  }): Promise<Record<string, unknown> | null> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (!record || record.attempt?.status !== "preparing") return null;
    record.attempt = {
      ...record.attempt,
      status: "prepared",
      txHash: input.prepared.txHash,
      payload: input.prepared.payload,
      ...(input.prepared.nonce ? { nonce: input.prepared.nonce } : {}),
      preparedAt: input.preparedAt,
    };
    this.events.push(`persist-prepared:${input.prepared.txHash}:${input.prepared.payload}`);
    return clone({ channel: record.channel, attempt: record.attempt });
  }

  async markAttemptSubmitted(input: {
    channelId: string;
    ownerToken: string;
    txHash: string;
    submittedAt: number;
    error?: string;
  }): Promise<Record<string, unknown> | null> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (!record || record.attempt?.status !== "prepared" || record.attempt.txHash !== input.txHash) return null;
    record.attempt = {
      ...record.attempt,
      status: "submitted",
      submittedAt: input.submittedAt,
      ...(input.error ? { error: input.error } : {}),
    };
    this.events.push(`submitted:${input.txHash}`);
    return clone({ channel: record.channel, attempt: record.attempt });
  }

  async releaseAttemptClaim(input: {
    channelId: string;
    ownerToken: string;
    expectedStatus: "prepared" | "submitted";
    checkedAt: number;
    error: string;
  }): Promise<boolean> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (!record || record.attempt?.status !== input.expectedStatus) return false;
    record.attempt.lastCheckedAt = input.checkedAt;
    record.attempt.error = input.error;
    delete record.ownerToken;
    delete record.ownerExpiresAt;
    this.events.push(`release:${input.expectedStatus}:${input.error}`);
    return true;
  }

  async abandonPreparation(input: {
    channelId: string;
    ownerToken: string;
    error: string;
  }): Promise<boolean> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (!record || record.attempt?.status !== "preparing") return false;
    delete record.attempt;
    delete record.ownerToken;
    delete record.ownerExpiresAt;
    this.events.push(`abandon:${input.error}`);
    return true;
  }

  async markAttemptReconciled(input: {
    channelId: string;
    ownerToken: string;
    kind: "receipts" | "evidence";
    count: number;
    reconciledAt: number;
  }): Promise<Record<string, unknown> | null> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (!record || record.attempt?.status !== "submitted") return null;
    if (input.kind === "receipts") {
      record.attempt.receiptsReconciledAt = input.reconciledAt;
      record.attempt.receiptsReconciledCount = input.count;
    } else {
      record.attempt.evidenceReconciledAt = input.reconciledAt;
      record.attempt.evidenceReconciledCount = input.count;
    }
    this.events.push(`reconciled:${input.kind}:${input.count}`);
    return clone({ channel: record.channel, attempt: record.attempt });
  }

  async markAttemptFailed(input: {
    channelId: string;
    ownerToken: string;
    txHash: string;
    failedAt: number;
    error: string;
  }): Promise<Record<string, unknown> | null> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (
      !record
      || record.attempt?.status !== "submitted"
      || record.attempt.txHash !== input.txHash
    ) return null;
    record.attempt.status = "failed";
    record.attempt.failedAt = input.failedAt;
    record.attempt.lastCheckedAt = input.failedAt;
    record.attempt.error = input.error;
    delete record.ownerToken;
    delete record.ownerExpiresAt;
    this.events.push(`failed:${input.txHash}:${input.error}`);
    return clone({ channel: record.channel, attempt: record.attempt });
  }

  async completeConfirmedAttempt(input: {
    channelId: string;
    ownerToken: string;
    txHash: string;
    completedAt: number;
  }): Promise<{ completed: boolean; hasMore: boolean }> {
    const record = this.owned(input.channelId, input.ownerToken);
    if (
      !record
      || record.attempt?.status !== "submitted"
      || record.attempt.txHash !== input.txHash
      || !record.attempt.receiptsReconciledAt
      || !record.attempt.evidenceReconciledAt
      || record.channel.settledCumulativeAmount !== record.attempt.settledCumulativeAmountWei
    ) {
      return { completed: false, hasMore: true };
    }
    const claimed = record.attempt.claimedCumulativeAmountWei;
    record.channel.settledCumulativeAmount = claimed;
    record.channel.lastTxHash = input.txHash;
    record.channel.lastRequestTimestamp = input.completedAt;
    const hasMore = BigInt(record.channel.chargedCumulativeAmount) > BigInt(claimed);
    delete record.attempt;
    delete record.ownerToken;
    delete record.ownerExpiresAt;
    if (hasMore) this.pending.add(input.channelId);
    else this.pending.delete(input.channelId);
    this.events.push(`complete:${input.txHash}:${claimed}:${hasMore}`);
    return { completed: true, hasMore };
  }

  private owned(channelId: string, ownerToken: string): StoredChannel | undefined {
    const record = this.records.get(channelId);
    return record?.ownerToken === ownerToken ? record : undefined;
  }
}

function channel(input: Partial<Channel> = {}): Channel {
  return {
    channelId: "CaseSensitiveChannelAbC123",
    payer: "CaseSensitivePayer111111111111111111111111111",
    network: NETWORK,
    asset: "CaseSensitiveMint1111111111111111111111111111",
    payTo: "CaseSensitiveReceiver1111111111111111111111111",
    resource: "https://api.compose.market/agent/CaseSensitive/stream",
    signedMaxClaimable: "1000",
    chargedCumulativeAmount: "125",
    settledCumulativeAmount: "25",
    balance: "1000",
    signature: "CaseSensitiveVoucherSignature",
    channelConfigFingerprint: "config-fingerprint",
    backingFingerprint: "backing-fingerprint",
    createdAt: 1,
    lastRequestTimestamp: 1,
    ...input,
  };
}

test("the SVM batch worker exposes an injected dependency seam", () => {
  assert.match(
    BATCH_SOURCE,
    /export async function runSvmBatchSettlement\(\s*dependencies\??:/u,
  );
});

test("the production SVM worker uses the durable attempt state machine", () => {
  const workerStart = BATCH_SOURCE.indexOf("export async function runSvmBatchSettlement");
  const workerEnd = BATCH_SOURCE.indexOf("export function queuedBatchSettlement", workerStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  const worker = BATCH_SOURCE.slice(workerStart, workerEnd);
  assert.match(worker, /defaultSvmBatchSettlementDependencies/u);
  assert.doesNotMatch(worker, /settleKeyPaymentForNetwork/u);
  assert.match(BATCH_SOURCE, /settlementAttemptPayload/u);
  assert.match(BATCH_SOURCE, /settlementAttemptClaimedCumulativeAmount/u);
  assert.match(BATCH_SOURCE, /completeConfirmedAttempt/u);
  const coordinatorStart = BATCH_SOURCE.indexOf("async function runInjectedSvmBatchSettlement");
  const coordinatorEnd = BATCH_SOURCE.indexOf("const defaultSvmBatchSettlementDependencies", coordinatorStart);
  const coordinator = BATCH_SOURCE.slice(coordinatorStart, coordinatorEnd);
  assert.ok(coordinator.indexOf("persistPreparedAttempt") < coordinator.indexOf("broadcastPreparedKeyPaymentForNetwork"));
  const completionStart = BATCH_SOURCE.indexOf("const COMPLETE_CONFIRMED_SVM_BATCH_ATTEMPT_SCRIPT");
  const completionEnd = BATCH_SOURCE.indexOf("function requireSvmBatchStoreSuccess", completionStart);
  const completion = BATCH_SOURCE.slice(completionStart, completionEnd);
  assert.match(completion, /settled ~= expectedSettled/u);
  assert.match(completion, /compare\(claimed, charged\) > 0/u);
  assert.match(completion, /"settledCumulativeAmount", claimed/u);
  assert.match(completion, /"settlementAttemptStatus"/u);
  assert.match(completion, /redis\.call\("SADD", KEYS\[2\], ARGV\[4\]\)/u);
  assert.match(completion, /redis\.call\("SREM", KEYS\[2\], ARGV\[4\]\)/u);
});

test("a lost broadcast result reuses the durably prepared SVM transaction identity", async () => {
  assert.match(
    BATCH_SOURCE,
    /const store = dependencies\?\.store/u,
    "the injected store must be selected before importing the executable worker",
  );
  const { runSvmBatchSettlement } = await import("../x402/batch.js");
  const store = new MemorySettlementStore();
  const seeded = channel();
  store.seed(seeded);
  const prepared = {
    network: NETWORK,
    txHash: "CaseSensitiveTxHashAbC123",
    payload: "CaseSensitiveSignedPayloadXyZ789==",
  };
  let prepareCalls = 0;
  const broadcasts: Array<typeof prepared> = [];
  let reconciliations = 0;
  let loseBroadcastResult = true;
  let clock = 10;

  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `owner-${clock}`,
    prepareKeyPaymentForNetwork: async (payer: string, amountWei: number | string, network: string) => {
      prepareCalls += 1;
      assert.equal(payer, seeded.payer);
      assert.equal(String(amountWei), "100");
      assert.equal(network, NETWORK);
      return { success: true as const, prepared };
    },
    broadcastPreparedKeyPaymentForNetwork: async (candidate: typeof prepared) => {
      broadcasts.push(clone(candidate));
      const persisted = store.snapshot(seeded.channelId).attempt;
      assert.equal(persisted?.status, "prepared");
      assert.equal(persisted?.txHash, prepared.txHash);
      assert.equal(persisted?.payload, prepared.payload);
      if (loseBroadcastResult) {
        loseBroadcastResult = false;
        throw new Error("broadcast response lost after send");
      }
      return { success: false as const, status: "submitted" as const, txHash: prepared.txHash };
    },
    reconcileKeyPaymentForNetwork: async () => {
      reconciliations += 1;
      return {
        success: false as const,
        status: "submitted" as const,
        txHash: prepared.txHash,
        error: "confirmation temporarily unreadable",
      };
    },
    markBatchReceiptsSettled: async () => 0,
    markBatchEvidenceSettled: async () => 0,
  };

  await runSvmBatchSettlement(dependencies as never);

  const afterLostResult = store.snapshot(seeded.channelId);
  assert.equal(afterLostResult.attempt?.status, "prepared");
  assert.equal(afterLostResult.attempt?.txHash, prepared.txHash);
  assert.equal(afterLostResult.attempt?.payload, prepared.payload);
  assert.equal(afterLostResult.attempt?.deltaWei, "100");
  assert.equal(afterLostResult.attempt?.claimedCumulativeAmountWei, "125");
  assert.equal(afterLostResult.channel.settledCumulativeAmount, "25");
  assert.ok(store.pending.has(seeded.channelId));

  await runSvmBatchSettlement(dependencies as never);

  const afterRetry = store.snapshot(seeded.channelId);
  assert.equal(prepareCalls, 1);
  assert.deepEqual(broadcasts, [prepared, prepared]);
  assert.equal(afterRetry.attempt?.status, "submitted");
  assert.equal(afterRetry.attempt?.txHash, prepared.txHash);
  assert.equal(afterRetry.attempt?.payload, prepared.payload);
  assert.equal(afterRetry.attempt?.deltaWei, "100");
  assert.equal(afterRetry.attempt?.claimedCumulativeAmountWei, "125");
  assert.equal(afterRetry.attempt?.error, "confirmation temporarily unreadable");
  assert.equal(afterRetry.channel.settledCumulativeAmount, "25");
  assert.ok(store.pending.has(seeded.channelId));

  await runSvmBatchSettlement(dependencies as never);

  assert.deepEqual(broadcasts, [prepared, prepared]);
  assert.equal(reconciliations, 2);
  assert.equal(store.snapshot(seeded.channelId).attempt?.status, "submitted");
});

test("an ambiguous broadcast response remains prepared for exact-byte rebroadcast", async () => {
  const { runSvmBatchSettlement } = await import("../x402/batch.js");
  const store = new MemorySettlementStore();
  const seeded = channel({ chargedCumulativeAmount: "40", settledCumulativeAmount: "10" });
  store.seed(seeded);
  const prepared = {
    network: NETWORK,
    txHash: "AmbiguousBroadcastTxHash",
    payload: "AmbiguousBroadcastSignedPayload==",
  };
  let clock = 50;
  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `owner-ambiguous-${clock}`,
    prepareKeyPaymentForNetwork: async () => ({ success: true as const, prepared }),
    broadcastPreparedKeyPaymentForNetwork: async () => ({
      success: false as const,
      status: "queued" as const,
      error: "RPC response unreadable after send attempt",
    }),
    reconcileKeyPaymentForNetwork: async () => {
      assert.fail("a non-submitted broadcast result must not enter reconciliation");
    },
    markBatchReceiptsSettled: async () => 0,
    markBatchEvidenceSettled: async () => 0,
  };

  await runSvmBatchSettlement(dependencies as never);

  const attempt = store.snapshot(seeded.channelId).attempt;
  assert.equal(attempt?.status, "prepared");
  assert.equal(attempt?.txHash, prepared.txHash);
  assert.equal(attempt?.payload, prepared.payload);
  assert.equal(attempt?.deltaWei, "30");
  assert.equal(attempt?.claimedCumulativeAmountWei, "40");
  assert.equal(attempt?.error, "RPC response unreadable after send attempt");
});

test("confirmation settles only the prepared cumulative amount and leaves newer usage pending", async () => {
  assert.match(BATCH_SOURCE, /completeConfirmedAttempt/u);
  const { runSvmBatchSettlement } = await import("../x402/batch.js");
  const store = new MemorySettlementStore();
  const seeded = channel({ chargedCumulativeAmount: "100", settledCumulativeAmount: "0" });
  store.seed(seeded);
  const prepared = {
    network: NETWORK,
    txHash: "ConfirmedCaseSensitiveTxHash123",
    payload: "ConfirmedSignedPayload456==",
  };
  let receiptsCalls = 0;
  let evidenceCalls = 0;
  let prepareCalls = 0;
  let clock = 100;

  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `owner-confirm-${clock}`,
    prepareKeyPaymentForNetwork: async (_payer: string, amountWei: number | string) => {
      prepareCalls += 1;
      if (prepareCalls === 1) assert.equal(String(amountWei), "100");
      else assert.equal(String(amountWei), "60");
      return {
        success: true as const,
        prepared: prepareCalls === 1
          ? prepared
          : { ...prepared, txHash: "NewerUsageTxHash", payload: "NewerUsagePayload==" },
      };
    },
    broadcastPreparedKeyPaymentForNetwork: async (candidate: typeof prepared) => {
      if (candidate.txHash === prepared.txHash) {
        const live = store.records.get(seeded.channelId);
        assert.ok(live);
        live.channel.chargedCumulativeAmount = "160";
        return { success: false as const, status: "submitted" as const, txHash: candidate.txHash };
      }
      throw new Error("stop after proving newer usage is a later transaction");
    },
    reconcileKeyPaymentForNetwork: async (txHash: string) => ({
      success: true as const,
      status: "confirmed" as const,
      txHash,
    }),
    markBatchReceiptsSettled: async (input: {
      channelId: string;
      claimedAmountWei: string;
      claimTxHash?: string;
      settleTxHash?: string;
      network: string;
    }) => {
      receiptsCalls += 1;
      assert.deepEqual(input, {
        channelId: seeded.channelId,
        claimedAmountWei: "100",
        network: NETWORK,
        claimTxHash: prepared.txHash,
        settleTxHash: prepared.txHash,
      });
      return 2;
    },
    markBatchEvidenceSettled: async (input: {
      channelId: string;
      claimedAmountWei: string;
      claimTxHash?: string;
      settleTxHash?: string;
      network: string;
    }) => {
      evidenceCalls += 1;
      assert.deepEqual(input, {
        channelId: seeded.channelId,
        claimedAmountWei: "100",
        claimTxHash: prepared.txHash,
        settleTxHash: prepared.txHash,
        network: NETWORK,
      });
      return 3;
    },
  };

  const first = await runSvmBatchSettlement(dependencies as never);

  const completed = store.snapshot(seeded.channelId);
  assert.equal(completed.channel.settledCumulativeAmount, "100");
  assert.equal(completed.channel.chargedCumulativeAmount, "160");
  assert.equal(completed.channel.lastTxHash, prepared.txHash);
  assert.equal(completed.attempt, undefined);
  assert.ok(store.pending.has(seeded.channelId));
  assert.equal(receiptsCalls, 1);
  assert.equal(evidenceCalls, 1);
  assert.deepEqual(first.channels, [{
    channelId: seeded.channelId,
    payer: seeded.payer,
    network: NETWORK,
    settledAmountWei: "100",
    claimedAmountWei: "100",
    txHash: prepared.txHash,
    reconciledReceipts: 2,
    reconciledEvidence: 3,
  }]);

  await runSvmBatchSettlement(dependencies as never);

  const nextAttempt = store.snapshot(seeded.channelId).attempt;
  assert.equal(nextAttempt?.status, "prepared");
  assert.equal(nextAttempt?.settledCumulativeAmountWei, "100");
  assert.equal(nextAttempt?.claimedCumulativeAmountWei, "160");
  assert.equal(nextAttempt?.deltaWei, "60");
  assert.equal(receiptsCalls, 1);
  assert.equal(evidenceCalls, 1);
});

test("a definitive failed receipt keeps failure evidence without settling usage", async () => {
  const { runSvmBatchSettlement } = await import("../x402/batch.js");
  const store = new MemorySettlementStore();
  const seeded = channel({ chargedCumulativeAmount: "90", settledCumulativeAmount: "10" });
  store.seed(seeded);
  const prepared = {
    network: NETWORK,
    txHash: "DefinitiveFailedTxHashAbC",
    payload: "DefinitiveFailedSignedPayloadXyZ==",
  };
  let broadcasts = 0;
  let reconciliations = 0;
  let clock = 200;
  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `owner-failed-${clock}`,
    prepareKeyPaymentForNetwork: async () => ({ success: true as const, prepared }),
    broadcastPreparedKeyPaymentForNetwork: async () => {
      broadcasts += 1;
      return { success: false as const, status: "submitted" as const, txHash: prepared.txHash };
    },
    reconcileKeyPaymentForNetwork: async () => {
      reconciliations += 1;
      return {
        success: false as const,
        status: "failed" as const,
        terminal: true,
        txHash: prepared.txHash,
        error: "SVM transaction failed: custom program error 0x1",
      };
    },
    markBatchReceiptsSettled: async () => {
      assert.fail("failed transactions must not settle receipts");
    },
    markBatchEvidenceSettled: async () => {
      assert.fail("failed transactions must not settle evidence");
    },
  };

  const first = await runSvmBatchSettlement(dependencies as never);
  const failed = store.snapshot(seeded.channelId);

  assert.equal(failed.channel.settledCumulativeAmount, "10");
  assert.equal(failed.attempt?.status, "failed");
  assert.equal(failed.attempt?.txHash, prepared.txHash);
  assert.equal(failed.attempt?.payload, prepared.payload);
  assert.equal(failed.attempt?.deltaWei, "80");
  assert.equal(failed.attempt?.claimedCumulativeAmountWei, "90");
  assert.equal(failed.attempt?.error, "SVM transaction failed: custom program error 0x1");
  assert.ok(failed.attempt?.failedAt);
  assert.ok(store.pending.has(seeded.channelId));
  assert.equal(first.channels[0]?.settledAmountWei, "0");
  assert.equal(first.channels[0]?.txHash, prepared.txHash);

  await runSvmBatchSettlement(dependencies as never);

  assert.equal(broadcasts, 1);
  assert.equal(reconciliations, 1);
  assert.equal(store.snapshot(seeded.channelId).attempt?.status, "failed");
});

test("concurrent workers create only one prepared identity for a channel delta", async () => {
  const { runSvmBatchSettlement } = await import("../x402/batch.js");
  const store = new MemorySettlementStore();
  const seeded = channel({ chargedCumulativeAmount: "70", settledCumulativeAmount: "20" });
  store.seed(seeded);
  const prepared = {
    network: NETWORK,
    txHash: "ConcurrentPreparedTxIdentity",
    payload: "ConcurrentPreparedSignedPayload==",
  };
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let preparationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    preparationStarted = resolve;
  });
  let prepareCalls = 0;
  let broadcasts = 0;
  let owner = 0;
  let clock = 300;
  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `concurrent-owner-${++owner}`,
    prepareKeyPaymentForNetwork: async () => {
      prepareCalls += 1;
      preparationStarted();
      await preparationGate;
      return { success: true as const, prepared };
    },
    broadcastPreparedKeyPaymentForNetwork: async () => {
      broadcasts += 1;
      return { success: false as const, status: "submitted" as const, txHash: prepared.txHash };
    },
    reconcileKeyPaymentForNetwork: async () => ({
      success: false as const,
      status: "submitted" as const,
      txHash: prepared.txHash,
      error: "pending",
    }),
    markBatchReceiptsSettled: async () => 0,
    markBatchEvidenceSettled: async () => 0,
  };

  const first = runSvmBatchSettlement(dependencies as never);
  await started;
  const second = await runSvmBatchSettlement(dependencies as never);
  releasePreparation();
  await first;

  const durable = store.snapshot(seeded.channelId).attempt;
  assert.equal(second.channels.length, 0);
  assert.equal(prepareCalls, 1);
  assert.equal(broadcasts, 1);
  assert.equal(durable?.status, "submitted");
  assert.equal(durable?.txHash, prepared.txHash);
  assert.equal(durable?.payload, prepared.payload);
  assert.equal(durable?.deltaWei, "50");
  assert.equal(durable?.claimedCumulativeAmountWei, "70");
});

test("SVM durable settlement identities remain case-sensitive", async () => {
  const keyStart = BATCH_SOURCE.indexOf("function svmBatchChannelKey");
  const keyEnd = BATCH_SOURCE.indexOf("function svmBatchChannelId", keyStart);
  assert.ok(keyStart >= 0 && keyEnd > keyStart);
  assert.doesNotMatch(BATCH_SOURCE.slice(keyStart, keyEnd), /toLowerCase/u);

  const { runSvmBatchSettlement } = await import("../x402/batch.js");
  const store = new MemorySettlementStore();
  const upper = channel({ channelId: "CaseSensitiveChannelAbC123", payer: "UpperCasePayer111" });
  const lower = channel({ channelId: "caseSensitiveChannelAbC123", payer: "LowerCasePayer222" });
  store.seed(upper);
  store.seed(lower);
  let clock = 400;
  const preparedByPayer = new Map([
    [upper.payer, { network: NETWORK, txHash: "UpperTxHash", payload: "UpperPayload==" }],
    [lower.payer, { network: NETWORK, txHash: "LowerTxHash", payload: "LowerPayload==" }],
  ]);
  const dependencies = {
    store,
    now: () => ++clock,
    createOwnerToken: () => `owner-case-${clock}`,
    prepareKeyPaymentForNetwork: async (payer: string) => ({
      success: true as const,
      prepared: preparedByPayer.get(payer)!,
    }),
    broadcastPreparedKeyPaymentForNetwork: async (prepared: { txHash: string }) => ({
      success: false as const,
      status: "submitted" as const,
      txHash: prepared.txHash,
    }),
    reconcileKeyPaymentForNetwork: async (txHash: string) => ({
      success: false as const,
      status: "submitted" as const,
      txHash,
      error: "pending",
    }),
    markBatchReceiptsSettled: async () => 0,
    markBatchEvidenceSettled: async () => 0,
  };

  const result = await runSvmBatchSettlement(dependencies as never);

  assert.deepEqual(
    result.channels.map((entry) => entry.channelId).sort(),
    [lower.channelId, upper.channelId].sort(),
  );
  assert.equal(store.snapshot(upper.channelId).attempt?.txHash, "UpperTxHash");
  assert.equal(store.snapshot(lower.channelId).attempt?.txHash, "LowerTxHash");
  assert.equal(store.records.size, 2);
});
