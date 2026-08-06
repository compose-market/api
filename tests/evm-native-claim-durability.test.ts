import "dotenv/config";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";

import * as channelsModule from "../x402/channels.js";
import { runNativeBatchSettlement } from "../x402/channels.js";
import type {
  NativeEvmOperationSnapshot,
  NativeEvmOperationState,
  NativeEvmOperationStore,
} from "../x402/channels.js";
import { closeValkey, getValkeyClient } from "../x402/keys/valkey.js";

after(async () => {
  await closeValkey();
});

const NETWORK = "eip155:5042002";
const ASSET = "0x3600000000000000000000000000000000000000";
const RECEIVER = "0x1111111111111111111111111111111111111111";

function txHash(label: string): `0x${string}` {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

type Channel = {
  channelId: string;
  chargedCumulativeAmount: string;
  totalClaimed: string;
  lastRequestTimestamp: number;
  network: string;
  asset: string;
  receiver: string;
  channelConfig: {
    token: string;
    receiver: string;
  };
};

type OperationState = NativeEvmOperationState;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function initialState(): OperationState {
  return { version: 1, revision: 0, phase: "claiming", claims: {}, claimAttempts: {} };
}

class MemoryOperationStore {
  readonly states = new Map<string, OperationState>();

  async load(network: string): Promise<NativeEvmOperationSnapshot> {
    const persisted = this.states.has(network)
      ? JSON.stringify(this.states.get(network))
      : null;
    return { state: clone(this.states.get(network) || initialState()), persisted };
  }

  async compareAndSet(
    network: string,
    expected: NativeEvmOperationSnapshot,
    next: OperationState,
  ): Promise<boolean> {
    const currentPersisted = this.states.has(network)
      ? JSON.stringify(this.states.get(network))
      : null;
    if (currentPersisted !== expected.persisted) return false;
    this.states.set(network, clone(next));
    return true;
  }

  snapshot(): OperationState {
    return clone(this.states.get(NETWORK) || initialState());
  }
}

class ClaimRejectedError extends Error {
  readonly definitive = true;
}

class ClaimOutcomeUnknownError extends Error {}

type ClaimManagerInput = {
  onConfirmedClaim(input: {
    channelId: string;
    claimedAmountWei: string;
    claimTxHash: string;
    vouchers: number;
  }): Promise<void>;
};

class ClaimHarness {
  readonly calls: string[] = [];
  readonly channels: Channel[];
  readonly transactions: Record<string, string | string[]>;
  readonly failOnce = new Set<string>();
  readonly ambiguousOnce = new Set<string>();
  beforeSelection?: () => void;
  beforeBroadcast?: (channelId: string) => Promise<void>;

  constructor(channels: Channel[], transactions: Record<string, string | string[]>) {
    this.channels = channels;
    this.transactions = transactions;
  }

  createManager({ onConfirmedClaim }: ClaimManagerInput) {
    return {
      claim: async (options: {
        maxClaimsPerBatch: number;
        idleSecs: number;
        selectClaimChannels(channels: Channel[]): Channel[] | Promise<Channel[]>;
      }) => {
        assert.equal(options.maxClaimsPerBatch, 1);
        this.beforeSelection?.();
        this.beforeSelection = undefined;
        const selected = await options.selectClaimChannels(this.channels);
        if (selected.length === 0) return [];
        assert.equal(selected.length, 1);
        const channel = selected[0];
        this.calls.push(channel.channelId);
        await this.beforeBroadcast?.(channel.channelId);
        if (this.failOnce.delete(channel.channelId)) {
          throw new ClaimRejectedError(`claim rejected for ${channel.channelId}`);
        }
        if (this.ambiguousOnce.delete(channel.channelId)) {
          throw new ClaimOutcomeUnknownError(`claim response lost for ${channel.channelId}`);
        }
        const configured = this.transactions[channel.channelId];
        const channelCallIndex = this.calls.filter((entry) => entry === channel.channelId).length - 1;
        const transaction = Array.isArray(configured) ? configured[channelCallIndex] : configured;
        assert.ok(transaction);
        await onConfirmedClaim({
          channelId: channel.channelId,
          claimedAmountWei: channel.chargedCumulativeAmount,
          claimTxHash: transaction,
          vouchers: 1,
        });
        channel.totalClaimed = channel.chargedCumulativeAmount;
        return [{ vouchers: 1, transaction }];
      },
    };
  }
}

type Projection = {
  channelId: string;
  claimedAmountWei: string;
  network: string;
  claimTxHash?: string;
  settleTxHash?: string;
};

function channel(
  channelId: string,
  charged = "100",
  overrides: Partial<Pick<Channel, "network" | "asset" | "receiver">> & {
    channelToken?: string;
    channelReceiver?: string;
  } = {},
): Channel {
  const network = overrides.network || NETWORK;
  const asset = overrides.asset || ASSET;
  const receiver = overrides.receiver || RECEIVER;
  return {
    channelId,
    chargedCumulativeAmount: charged,
    totalClaimed: "0",
    lastRequestTimestamp: 1,
    network,
    asset,
    receiver,
    channelConfig: {
      token: overrides.channelToken || asset,
      receiver: overrides.channelReceiver || receiver,
    },
  };
}

function baseDependencies(input: {
  store: NativeEvmOperationStore;
  claims: ClaimHarness;
  executeSettlement?: (input: unknown) => Promise<Record<string, unknown>>;
  reconcileSettlement?: (input: unknown) => Promise<Record<string, unknown>>;
  receiptProjections?: Projection[];
  evidenceProjections?: Projection[];
}) {
  let clock = 1_000;
  let operation = 0;
  return {
    networks: () => [NETWORK],
    claimBacking: () => ({ asset: ASSET, receiver: RECEIVER }),
    store: input.store,
    createClaimManager: (factoryInput: ClaimManagerInput) => input.claims.createManager(factoryInput),
    executeSettlement: input.executeSettlement || (async () => ({
      status: "confirmed",
      txHash: txHash("settle-default"),
    })),
    reconcileSettlement: input.reconcileSettlement || (async () => ({ status: "pending" })),
    markBatchReceiptsSettled: async (projection: Projection) => {
      input.receiptProjections?.push(clone(projection));
      return 1;
    },
    markBatchEvidenceSettled: async (projection: Projection) => {
      input.evidenceProjections?.push(clone(projection));
      return 1;
    },
    now: () => ++clock,
    createOperationId: () => `settle-operation-${++operation}`,
    idleSecs: 0,
    isDefinitiveClaimFailure: (error: unknown) => error instanceof ClaimRejectedError,
  };
}

async function runInjected(dependencies: ReturnType<typeof baseDependencies>) {
  return (runNativeBatchSettlement as unknown as (
    dependencies: ReturnType<typeof baseDependencies>,
  ) => ReturnType<typeof runNativeBatchSettlement>)(dependencies);
}

type ProductionStoreConstructor = new (keyPrefix?: string) => NativeEvmOperationStore;

function productionStore(keyPrefix: string): NativeEvmOperationStore {
  const Store = (channelsModule as unknown as {
    ValkeyNativeEvmOperationStore?: ProductionStoreConstructor;
  }).ValkeyNativeEvmOperationStore;
  assert.ok(Store, "native durability tests require the production Valkey operation store");
  return new Store(keyPrefix);
}

async function withProductionStore<T>(
  run: (input: {
    key: string;
    keyPrefix: string;
    store: NativeEvmOperationStore;
  }) => Promise<T>,
): Promise<T> {
  const keyPrefix = `x402:batch-settlement:evm:native-operation:test:${randomUUID()}`;
  const key = `${keyPrefix}:${NETWORK}`;
  const valkey = await getValkeyClient();
  try {
    return await run({ key, keyPrefix, store: productionStore(keyPrefix) });
  } finally {
    await valkey.del(key);
  }
}

test("the production store rejects persisted native state with no claim ownership map", async () => {
  await withProductionStore(async ({ key, store }) => {
    const valkey = await getValkeyClient();
    const raw = JSON.stringify({
      version: 1,
      revision: 0,
      phase: "claiming",
      claims: {},
    });
    await valkey.set(key, raw);
    const onlyChannel = channel("0xmissing-ownership");
    const claims = new ClaimHarness(
      [onlyChannel],
      { [onlyChannel.channelId]: txHash("must-not-broadcast-missing-ownership") },
    );

    const result = await runInjected(baseDependencies({ store, claims }));

    assert.match(result.chains[0]?.error || "", /invalid native EVM claim attempts/iu);
    assert.equal(claims.calls.length, 0);
    assert.equal(await valkey.get(key), raw, "invalid state must not be rewritten as an empty owner map");

    await valkey.set(key, "");
    await assert.rejects(
      store.load(NETWORK),
      /unexpected end of JSON input/iu,
      "an empty but persisted state is not equivalent to an absent key",
    );
  });
});

test("the production store rejects terminal settlement history with an empty error", async () => {
  await withProductionStore(async ({ key, store }) => {
    const valkey = await getValkeyClient();
    await valkey.set(key, JSON.stringify({
      version: 1,
      revision: 1,
      phase: "settling",
      claims: {},
      claimAttempts: {},
      failedSettleAttempts: {
        "failed-operation": {
          operationId: "failed-operation",
          status: "failed",
          claims: [{
            channelId: "0xfailed-history",
            claimedAmountWei: "100",
            claimTxHash: txHash("claim-history"),
            claimOperationId: "claim-operation-history",
            confirmedAt: 100,
          }],
          preparedAt: 101,
          txHash: txHash("settle-history"),
          submittedAt: 101,
          error: "",
          failedAt: 102,
        },
      },
    }));

    await assert.rejects(
      store.load(NETWORK),
      /invalid native EVM failed settle attempt provenance/iu,
    );
  });
});

test("production CAS rejects malformed same-revision replacement instead of repairing it", async () => {
  await withProductionStore(async ({ key, store }) => {
    const valkey = await getValkeyClient();
    const valid: NativeEvmOperationState = {
      version: 1,
      revision: 1,
      phase: "claiming",
      claims: {},
      claimAttempts: {},
    };
    await valkey.set(key, JSON.stringify(valid));
    const loaded = await store.load(NETWORK);
    const malformed = JSON.stringify({
      version: 1,
      revision: 1,
      phase: "claiming",
      claims: {},
    });
    await valkey.set(key, malformed);

    const applied = await store.compareAndSet(NETWORK, loaded, {
      ...loaded.state,
      revision: 2,
    });

    assert.equal(applied, false, "CAS ownership is the exact validated document, not its revision alone");
    assert.equal(await valkey.get(key), malformed);
  });
});

test("production CAS rejects an invalid proposed document before invoking Lua", async () => {
  await withProductionStore(async ({ key, store }) => {
    const valkey = await getValkeyClient();
    const valid: NativeEvmOperationState = {
      version: 1,
      revision: 1,
      phase: "claiming",
      claims: {},
      claimAttempts: {},
    };
    await valkey.set(key, JSON.stringify(valid));
    const loaded = await store.load(NETWORK);
    await assert.rejects(
      store.compareAndSet(NETWORK, loaded, {
        ...loaded.state,
        revision: 2,
        blockedReason: 42,
      } as unknown as NativeEvmOperationState),
      /invalid native EVM/iu,
      "CAS must validate the complete proposed document before invoking Lua",
    );
    assert.equal(await valkey.get(key), JSON.stringify(valid));
  });
});

test("the production parser rejects noncanonical hashes and nonpositive claim or attempt timestamps", async () => {
  await withProductionStore(async ({ key, store }) => {
    const valkey = await getValkeyClient();
    const canonicalClaim = {
      channelId: "0xstrict-claim",
      claimedAmountWei: "100",
      claimTxHash: txHash("strict-claim"),
      claimOperationId: "strict-claim-operation",
      confirmedAt: 100,
    };
    const invalidStates: Array<{ name: string; state: Record<string, unknown> }> = [
      {
        name: "claim hash",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: { [canonicalClaim.channelId]: { ...canonicalClaim, claimTxHash: "0xshort" } },
          claimAttempts: {},
        },
      },
      {
        name: "claim confirmation timestamp",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: { [canonicalClaim.channelId]: { ...canonicalClaim, confirmedAt: 0 } },
          claimAttempts: {},
        },
      },
      {
        name: "claim attempt preparation timestamp",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: {},
          claimAttempts: {
            "0xstrict-attempt": {
              operationId: "strict-attempt-operation",
              status: "prepared",
              channelId: "0xstrict-attempt",
              claimedAmountWei: "100",
              preparedAt: 0,
            },
          },
        },
      },
      {
        name: "submitted settlement hash and timestamp",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [canonicalClaim.channelId]: canonicalClaim },
          claimAttempts: {},
          settleAttempt: {
            operationId: "strict-settle-operation",
            status: "submitted",
            claims: [canonicalClaim],
            preparedAt: 101,
            txHash: "0xshort",
          },
        },
      },
      {
        name: "settlement preparation timestamp",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [canonicalClaim.channelId]: canonicalClaim },
          claimAttempts: {},
          settleAttempt: {
            operationId: "strict-unprepared-settle-operation",
            status: "prepared",
            claims: [canonicalClaim],
            preparedAt: 0,
          },
        },
      },
      {
        name: "settlement submission timestamp",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [canonicalClaim.channelId]: canonicalClaim },
          claimAttempts: {},
          settleAttempt: {
            operationId: "strict-unsubmitted-settle-operation",
            status: "submitted",
            claims: [canonicalClaim],
            preparedAt: 101,
            submittedAt: 0,
            txHash: txHash("strict-unsubmitted-settle"),
          },
        },
      },
      {
        name: "failed settlement hash",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [canonicalClaim.channelId]: canonicalClaim },
          claimAttempts: {},
          failedSettleAttempts: {
            "strict-failed-settle-operation": {
              operationId: "strict-failed-settle-operation",
              status: "failed",
              claims: [canonicalClaim],
              preparedAt: 101,
              submittedAt: 102,
              txHash: "0xshort",
              error: "reverted",
              failedAt: 103,
            },
          },
        },
      },
      {
        name: "settlement failure timestamp",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [canonicalClaim.channelId]: canonicalClaim },
          claimAttempts: {},
          failedSettleAttempts: {
            "strict-unfailed-settle-operation": {
              operationId: "strict-unfailed-settle-operation",
              status: "failed",
              claims: [canonicalClaim],
              preparedAt: 101,
              submittedAt: 102,
              txHash: txHash("strict-unfailed-settle"),
              error: "reverted",
              failedAt: 0,
            },
          },
        },
      },
    ];

    for (const fixture of invalidStates) {
      await valkey.set(key, JSON.stringify(fixture.state));
      await assert.rejects(
        store.load(NETWORK),
        /invalid native EVM/iu,
        `${fixture.name} must fail closed`,
      );
    }
  });
});

test("the production parser rejects causally impossible native operation states", async () => {
  await withProductionStore(async ({ key, store }) => {
    const valkey = await getValkeyClient();
    const claim = {
      channelId: "0xcausal-channel",
      claimedAmountWei: "100",
      claimTxHash: txHash("causal-claim"),
      claimOperationId: "causal-claim-operation",
      confirmedAt: 100,
    };
    const submitted = {
      operationId: "causal-settle-operation",
      status: "submitted",
      claims: [claim],
      preparedAt: 101,
      submittedAt: 102,
      txHash: txHash("causal-settle"),
    };
    const invalidStates: Array<{ name: string; state: Record<string, unknown> }> = [
      {
        name: "active settlement with a claim owner",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [claim.channelId]: claim },
          claimAttempts: {
            "0xother-owner": {
              operationId: "other-owner-operation",
              status: "prepared",
              channelId: "0xother-owner",
              claimedAmountWei: "50",
              preparedAt: 99,
            },
          },
          settleAttempt: submitted,
        },
      },
      {
        name: "settlement claim provenance mismatch",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [claim.channelId]: claim },
          claimAttempts: {},
          settleAttempt: {
            ...submitted,
            claims: [{ ...claim, claimTxHash: txHash("different-claim") }],
          },
        },
      },
      {
        name: "settlement in claiming phase",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: { [claim.channelId]: claim },
          claimAttempts: {},
          settleAttempt: submitted,
        },
      },
      {
        name: "invalid optional blocked reason",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: {},
          claimAttempts: {},
          blockedReason: 42,
        },
      },
      {
        name: "active settlement prepared before its claim was confirmed",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [claim.channelId]: claim },
          claimAttempts: {},
          settleAttempt: {
            ...submitted,
            preparedAt: 99,
          },
        },
      },
      {
        name: "failed settlement prepared before its claim was confirmed",
        state: {
          version: 1,
          revision: 1,
          phase: "settling",
          claims: { [claim.channelId]: claim },
          claimAttempts: {},
          failedSettleAttempts: {
            "causal-failed-operation": {
              operationId: "causal-failed-operation",
              status: "failed",
              claims: [claim],
              preparedAt: 99,
              submittedAt: 102,
              txHash: txHash("causal-failed-settle"),
              error: "reverted",
              failedAt: 103,
            },
          },
        },
      },
      {
        name: "claim owner not above its pending watermark",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: { [claim.channelId]: claim },
          claimAttempts: {
            [claim.channelId]: {
              operationId: "nonincremental-pending-owner",
              status: "prepared",
              channelId: claim.channelId,
              claimedAmountWei: claim.claimedAmountWei,
              preparedAt: 101,
            },
          },
        },
      },
      {
        name: "claim owner not above its settled watermark",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: {},
          claimAttempts: {
            [claim.channelId]: {
              operationId: "nonincremental-settled-owner",
              status: "prepared",
              channelId: claim.channelId,
              claimedAmountWei: claim.claimedAmountWei,
              preparedAt: 101,
            },
          },
          settledClaims: { [claim.channelId]: claim },
        },
      },
      {
        name: "orphan failed settlement history in claiming phase",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: {},
          claimAttempts: {},
          failedSettleAttempts: {
            "orphan-failed-operation": {
              operationId: "orphan-failed-operation",
              status: "failed",
              claims: [claim],
              preparedAt: 101,
              submittedAt: 102,
              txHash: txHash("orphan-failed-settle"),
              error: "reverted",
              failedAt: 103,
            },
          },
        },
      },
      {
        name: "failed settlement history mismatched with equal settled watermark",
        state: {
          version: 1,
          revision: 1,
          phase: "claiming",
          claims: {},
          claimAttempts: {},
          settledClaims: { [claim.channelId]: claim },
          failedSettleAttempts: {
            "mismatched-failed-operation": {
              operationId: "mismatched-failed-operation",
              status: "failed",
              claims: [{ ...claim, claimTxHash: txHash("mismatched-failed-claim") }],
              preparedAt: 101,
              submittedAt: 102,
              txHash: txHash("mismatched-failed-settle"),
              error: "reverted",
              failedAt: 103,
            },
          },
        },
      },
    ];

    for (const fixture of invalidStates) {
      await valkey.set(key, JSON.stringify(fixture.state));
      await assert.rejects(
        store.load(NETWORK),
        /invalid native EVM/iu,
        `${fixture.name} must fail closed`,
      );
    }
  });
});

async function assertBackingSelection(invalid: Channel): Promise<void> {
  const arcChannel = channel(`0xvalid-${invalid.channelId}`, "40");
  const claims = new ClaimHarness(
    [invalid, arcChannel],
    {
      [invalid.channelId]: txHash(`claim-${invalid.channelId}`),
      [arcChannel.channelId]: txHash(`claim-${arcChannel.channelId}`),
    },
  );
  const store = new MemoryOperationStore();

  const result = await runInjected(baseDependencies({ store, claims }));

  assert.equal(result.chains[0]?.error, undefined);
  assert.deepEqual(claims.calls, [arcChannel.channelId]);
  assert.deepEqual(result.chains[0]?.claimTxHashes, [txHash(`claim-${arcChannel.channelId}`)]);
  assert.deepEqual(Object.keys(store.snapshot().settledClaims || {}), [arcChannel.channelId]);
}

test("Arc claim selection rejects a different network independently", async () => {
  await assertBackingSelection(channel("0xwrong-network", "10", { network: "eip155:43114" }));
});

test("Arc claim selection rejects a different top-level registry asset independently", async () => {
  await assertBackingSelection(channel("0xwrong-top-level-asset", "20", {
    asset: "0x2222222222222222222222222222222222222222",
    channelToken: ASSET,
  }));
});

test("Arc claim selection rejects a different nested channel token independently", async () => {
  await assertBackingSelection(channel("0xwrong-nested-token", "30", {
    channelToken: "0x2222222222222222222222222222222222222222",
  }));
});

test("Arc claim selection rejects a different top-level receiver independently", async () => {
  await assertBackingSelection(channel("0xwrong-top-level-receiver", "40", {
    receiver: "0x3333333333333333333333333333333333333333",
    channelReceiver: RECEIVER,
  }));
});

test("Arc claim selection rejects a different nested merchant receiver independently", async () => {
  await assertBackingSelection(channel("0xwrong-nested-receiver", "50", {
    channelReceiver: "0x3333333333333333333333333333333333333333",
  }));
});

test("Arc claim selection does not fall through to an SDK default when every channel is invalid", async () => {
  const invalid = channel("0xinvalid-only", "60", {
    channelToken: "0x2222222222222222222222222222222222222222",
  });
  const claims = new ClaimHarness(
    [invalid],
    { [invalid.channelId]: txHash("claim-invalid-only") },
  );
  const store = new MemoryOperationStore();

  const result = await runInjected(baseDependencies({ store, claims }));

  assert.equal(result.chains[0]?.error, undefined);
  assert.deepEqual(claims.calls, []);
  assert.deepEqual(result.chains[0]?.claimTxHashes, []);
  assert.deepEqual(store.snapshot(), initialState());
});

test("concurrent workers acquire one durable channel owner before claim broadcast", async () => {
  const onlyChannel = channel("0xconcurrent-owner");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: [txHash("claim-owner"), txHash("claim-non-owner")] },
  );
  const store = new MemoryOperationStore();
  let selected!: () => void;
  let release!: () => void;
  const selectedPromise = new Promise<void>((resolve) => { selected = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  claims.beforeBroadcast = async () => {
    entered += 1;
    if (entered === 1) selected();
    await releasePromise;
  };
  const dependencies = baseDependencies({ store, claims });

  const first = runInjected(dependencies);
  await selectedPromise;
  const second = runInjected(dependencies);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);

  assert.deepEqual(claims.calls, [onlyChannel.channelId], "only the CAS owner may broadcast");
  assert.deepEqual(
    results.flatMap((result) => result.chains[0]?.claimTxHashes || []),
    [txHash("claim-owner")],
    "a non-owner must not report the owner's transaction",
  );
  assert.deepEqual(store.snapshot().claimAttempts, {});
  assert.equal(
    store.snapshot().settledClaims?.[onlyChannel.channelId]?.claimTxHash,
    txHash("claim-owner"),
  );
});

test("a known concurrent claim survives another channel's hashless global ambiguity", async () => {
  const ambiguousChannel = channel("0xconcurrent-ambiguous", "100");
  const confirmedChannel = channel("0xconcurrent-confirmed", "200");
  const confirmedHash = txHash("concurrent-confirmed-claim");
  const claims = new ClaimHarness(
    [ambiguousChannel, confirmedChannel],
    {
      [ambiguousChannel.channelId]: txHash("unreachable-concurrent-ambiguous"),
      [confirmedChannel.channelId]: confirmedHash,
    },
  );
  claims.ambiguousOnce.add(ambiguousChannel.channelId);
  const store = new MemoryOperationStore();
  let ambiguousEntered!: () => void;
  let confirmedEntered!: () => void;
  let releaseAmbiguous!: () => void;
  let releaseConfirmed!: () => void;
  const ambiguousEnteredPromise = new Promise<void>((resolve) => { ambiguousEntered = resolve; });
  const confirmedEnteredPromise = new Promise<void>((resolve) => { confirmedEntered = resolve; });
  const releaseAmbiguousPromise = new Promise<void>((resolve) => { releaseAmbiguous = resolve; });
  const releaseConfirmedPromise = new Promise<void>((resolve) => { releaseConfirmed = resolve; });
  claims.beforeBroadcast = async (channelId) => {
    if (channelId === ambiguousChannel.channelId) {
      ambiguousEntered();
      await releaseAmbiguousPromise;
      return;
    }
    assert.equal(channelId, confirmedChannel.channelId);
    confirmedEntered();
    await releaseConfirmedPromise;
  };
  let settleCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    executeSettlement: async () => {
      settleCalls += 1;
      return { status: "confirmed", txHash: txHash("unreachable-concurrent-settlement") };
    },
  });

  const ambiguousRun = runInjected(dependencies);
  await ambiguousEnteredPromise;
  const confirmedRun = runInjected(dependencies);
  await confirmedEnteredPromise;
  const confirmedOwnerId = store.snapshot().claimAttempts[confirmedChannel.channelId]?.operationId;
  assert.ok(confirmedOwnerId);
  releaseAmbiguous();
  const ambiguousResult = await ambiguousRun;
  assert.match(ambiguousResult.chains[0]?.error || "", /claim response lost/iu);
  assert.equal(store.snapshot().phase, "blocked");
  releaseConfirmed();
  const confirmedResult = await confirmedRun;

  assert.deepEqual(claims.calls, [ambiguousChannel.channelId, confirmedChannel.channelId]);
  assert.deepEqual(confirmedResult.chains[0]?.claimTxHashes, [confirmedHash]);
  assert.equal(settleCalls, 0, "global ambiguity must continue blocking settlement");
  const state = store.snapshot();
  assert.equal(state.phase, "blocked");
  assert.match(state.blockedReason || "", /claim response lost/iu);
  assert.equal(state.claimAttempts[ambiguousChannel.channelId]?.status, "blocked");
  assert.equal(state.claimAttempts[confirmedChannel.channelId], undefined);
  assert.equal(state.claims[confirmedChannel.channelId]?.claimTxHash, confirmedHash);
  assert.equal(
    state.claims[confirmedChannel.channelId]?.claimOperationId,
    confirmedOwnerId,
  );
});

test("two production Valkey stores permit exactly one claim broadcast owner", async () => {
  await withProductionStore(async ({ keyPrefix, store }) => {
    const onlyChannel = channel("0xproduction-concurrent-owner");
    const ownerHash = txHash("production-claim-owner");
    const claims = new ClaimHarness(
      [onlyChannel],
      { [onlyChannel.channelId]: [ownerHash, txHash("production-claim-non-owner")] },
    );
    let selected!: () => void;
    let release!: () => void;
    const selectedPromise = new Promise<void>((resolve) => { selected = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    claims.beforeBroadcast = async () => {
      entered += 1;
      if (entered === 1) selected();
      await releasePromise;
    };
    const firstDependencies = baseDependencies({ store, claims });
    const secondDependencies = baseDependencies({ store: productionStore(keyPrefix), claims });
    let firstOperation = 0;
    let secondOperation = 0;
    firstDependencies.createOperationId = () => `worker-a-operation-${++firstOperation}`;
    secondDependencies.createOperationId = () => `worker-b-operation-${++secondOperation}`;

    const first = runInjected(firstDependencies);
    await selectedPromise;
    const second = runInjected(secondDependencies);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);

    assert.deepEqual(claims.calls, [onlyChannel.channelId], "only one exact-document CAS owner broadcasts");
    assert.deepEqual(
      results.flatMap((result) => result.chains[0]?.claimTxHashes || []),
      [ownerHash],
      "the non-owner cannot report the owner's transaction",
    );
    const persisted = (await productionStore(keyPrefix).load(NETWORK)).state;
    assert.deepEqual(persisted.claimAttempts, {});
    assert.equal(persisted.settledClaims?.[onlyChannel.channelId]?.claimTxHash, ownerHash);
  });
});

test("a hashless ambiguous claim remains durably blocked and is never broadcast again", async () => {
  const onlyChannel = channel("0xambiguous-claim");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("unreachable-claim") },
  );
  claims.ambiguousOnce.add(onlyChannel.channelId);
  const store = new MemoryOperationStore();
  const dependencies = baseDependencies({ store, claims });

  const first = await runInjected(dependencies);
  const second = await runInjected(dependencies);

  assert.match(first.chains[0]?.error || "", /claim response lost/u);
  assert.match(second.chains[0]?.error || "", /claim response lost/u);
  assert.equal(claims.calls.length, 1);
  assert.deepEqual(
    {
      ...store.snapshot().claimAttempts[onlyChannel.channelId],
      preparedAt: undefined,
    },
    {
      operationId: "settle-operation-1",
      status: "blocked",
      channelId: onlyChannel.channelId,
      claimedAmountWei: "100",
      preparedAt: undefined,
      error: `claim response lost for ${onlyChannel.channelId}`,
    },
  );
});

test("a noncanonical confirmed claim hash is durably blocked before provenance can be persisted", async () => {
  const onlyChannel = channel("0xinvalid-claim-hash");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: "0xshort" },
  );
  const store = new MemoryOperationStore();
  let settleCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    executeSettlement: async () => {
      settleCalls += 1;
      return { status: "confirmed", txHash: txHash("unreachable-settlement") };
    },
  });

  const first = await runInjected(dependencies);
  const second = await runInjected(dependencies);

  assert.match(first.chains[0]?.error || "", /claim transaction hash/iu);
  assert.match(second.chains[0]?.error || "", /claim transaction hash/iu);
  assert.equal(claims.calls.length, 1);
  assert.equal(settleCalls, 0);
  assert.equal(store.snapshot().phase, "blocked");
  assert.equal(store.snapshot().claimAttempts[onlyChannel.channelId]?.status, "blocked");
  assert.deepEqual(store.snapshot().claims, {});
});

test("a nonpositive claim preparation timestamp fails before claim broadcast", async () => {
  const onlyChannel = channel("0xinvalid-claim-prepared-at");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("invalid-claim-prepared-at") },
  );
  const store = new MemoryOperationStore();
  const dependencies = baseDependencies({ store, claims });
  dependencies.now = () => 0;

  const result = await runInjected(dependencies);

  assert.match(result.chains[0]?.error || "", /claim preparation timestamp/iu);
  assert.deepEqual(claims.calls, []);
  assert.deepEqual(store.snapshot(), initialState());
});

test("a surviving prepared claim owner blocks rebroadcast when the SDK lost the post-broadcast identity", async () => {
  const onlyChannel = channel("0xsurviving-owner");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("must-not-broadcast-surviving-owner") },
  );
  const store = new MemoryOperationStore();
  store.states.set(NETWORK, {
    ...initialState(),
    revision: 1,
    claimAttempts: {
      [onlyChannel.channelId]: {
        operationId: "surviving-claim-operation",
        status: "prepared",
        channelId: onlyChannel.channelId,
        claimedAmountWei: "100",
        preparedAt: 500,
      },
    },
  });

  const result = await runInjected(baseDependencies({ store, claims }));

  assert.match(result.chains[0]?.error || "", /durable claim attempt.*rebroadcast is blocked/iu);
  assert.equal(claims.calls.length, 0);
  assert.equal(
    store.snapshot().claimAttempts[onlyChannel.channelId]?.operationId,
    "surviving-claim-operation",
  );
});

test("a successful one-channel claim survives a later claim failure and the retry settles once", async () => {
  const firstChannel = channel("0xaaa");
  const secondChannel = channel("0xbbb", "200");
  const claims = new ClaimHarness(
    [firstChannel, secondChannel],
    {
      [firstChannel.channelId]: txHash("claim-a"),
      [secondChannel.channelId]: txHash("claim-b"),
    },
  );
  claims.failOnce.add(secondChannel.channelId);
  const store = new MemoryOperationStore();
  const receipts: Projection[] = [];
  let settleCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    receiptProjections: receipts,
    executeSettlement: async () => {
      settleCalls += 1;
      return { status: "confirmed", txHash: txHash("settle") };
    },
  });

  const failed = await runInjected(dependencies);

  assert.match(failed.chains[0]?.error || "", /claim rejected for 0xbbb/u);
  const firstClaim = store.snapshot().claims[firstChannel.channelId];
  assert.ok(firstClaim.claimOperationId);
  assert.deepEqual(
    { ...firstClaim, confirmedAt: undefined, claimOperationId: undefined },
    {
      channelId: firstChannel.channelId,
      claimedAmountWei: "100",
      claimTxHash: txHash("claim-a"),
      claimOperationId: undefined,
      confirmedAt: undefined,
    },
  );
  assert.ok(store.snapshot().claims[firstChannel.channelId].confirmedAt > 0);
  assert.equal(store.snapshot().phase, "claiming");
  assert.equal(settleCalls, 0);
  assert.ok(receipts.some((entry) => entry.channelId === firstChannel.channelId
    && entry.claimTxHash === txHash("claim-a") && !entry.settleTxHash));

  const retried = await runInjected(dependencies);

  assert.equal(retried.chains[0]?.error, undefined);
  assert.equal(settleCalls, 1);
  assert.deepEqual(store.snapshot().claims, {});
  assert.equal(store.snapshot().phase, "claiming");
  assert.deepEqual(claims.calls, [firstChannel.channelId, secondChannel.channelId, secondChannel.channelId]);
});

test("a definitive settle failure remains pending and retries with no fresh claim", async () => {
  const onlyChannel = channel("0xccc");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-c") },
  );
  const store = new MemoryOperationStore();
  const receipts: Projection[] = [];
  let settleCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    receiptProjections: receipts,
    executeSettlement: async () => {
      settleCalls += 1;
      return settleCalls === 1
        ? { status: "rejected", error: "simulation rejected before broadcast" }
        : { status: "confirmed", txHash: txHash("settle-c") };
    },
  });

  const failed = await runInjected(dependencies);

  assert.match(failed.chains[0]?.error || "", /simulation rejected/u);
  assert.equal(store.snapshot().phase, "settling");
  assert.equal(store.snapshot().settleAttempt, undefined);
  assert.equal(claims.calls.length, 1);
  assert.ok(receipts.some((entry) => entry.claimTxHash === txHash("claim-c") && !entry.settleTxHash));
  assert.ok(receipts.every((entry) => !entry.settleTxHash), "a rejected settle must not project settled state");

  const retried = await runInjected(dependencies);

  assert.equal(retried.chains[0]?.settleTxHash, txHash("settle-c"));
  assert.equal(settleCalls, 2);
  assert.equal(claims.calls.length, 1, "settlement retry must not require or repeat a claim");
  assert.ok(receipts.some((entry) => entry.claimTxHash === txHash("claim-c")
    && entry.settleTxHash === txHash("settle-c")));
});

test("a reverted settle transaction is durably preserved before and after retry", async () => {
  const onlyChannel = channel("0xreverted-settle");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-before-revert") },
  );
  const store = new MemoryOperationStore();
  const receipts: Projection[] = [];
  let settleCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    receiptProjections: receipts,
    executeSettlement: async () => {
      settleCalls += 1;
      return settleCalls === 1
        ? {
          status: "rejected",
          txHash: txHash("settle-reverted"),
          error: "settlement transaction reverted",
        }
        : { status: "confirmed", txHash: txHash("settle-retry") };
    },
  });

  const failed = await runInjected(dependencies);

  assert.match(failed.chains[0]?.error || "", /reverted/u);
  const failedAttempts = Object.values(store.snapshot().failedSettleAttempts || {});
  assert.equal(failedAttempts.length, 1);
  assert.deepEqual(
    {
      ...failedAttempts[0],
      claims: failedAttempts[0].claims.map((claim) => ({ ...claim, confirmedAt: undefined })),
      preparedAt: undefined,
      failedAt: undefined,
    },
    {
      operationId: failedAttempts[0].operationId,
      status: "failed",
      claims: [{
        channelId: onlyChannel.channelId,
        claimedAmountWei: "100",
        claimTxHash: txHash("claim-before-revert"),
        claimOperationId: failedAttempts[0].claims[0].claimOperationId,
        confirmedAt: undefined,
      }],
      preparedAt: undefined,
      txHash: txHash("settle-reverted"),
      submittedAt: failedAttempts[0].submittedAt,
      error: "settlement transaction reverted",
      failedAt: undefined,
    },
  );
  assert.ok(failedAttempts[0].failedAt && failedAttempts[0].failedAt > 0);
  assert.ok(receipts.every((entry) => !entry.settleTxHash));

  const retried = await runInjected(dependencies);

  assert.equal(retried.chains[0]?.settleTxHash, txHash("settle-retry"));
  assert.equal(settleCalls, 2);
  assert.equal(claims.calls.length, 1);
  assert.equal(Object.values(store.snapshot().failedSettleAttempts || {}).length, 1);
  assert.ok(receipts.some((entry) => entry.settleTxHash === txHash("settle-retry")));
  assert.ok(receipts.every((entry) => entry.settleTxHash !== txHash("settle-reverted")));
});

test("a persisted submitted revert archives exact provenance before retry without a new claim", async () => {
  await withProductionStore(async ({ keyPrefix, store }) => {
    const onlyChannel = channel("0xsubmitted-revert");
    const claims = new ClaimHarness(
      [onlyChannel],
      { [onlyChannel.channelId]: txHash("claim-before-submitted-revert") },
    );
    const receipts: Projection[] = [];
    let executeCalls = 0;
    let reconcileCalls = 0;
    const dependencies = baseDependencies({
      store,
      claims,
      receiptProjections: receipts,
      executeSettlement: async () => {
        executeCalls += 1;
        return executeCalls === 1
          ? {
            status: "ambiguous",
            txHash: txHash("submitted-then-reverted"),
            error: "receipt unavailable after broadcast",
          }
          : { status: "confirmed", txHash: txHash("settle-after-revert") };
      },
      reconcileSettlement: async (input: unknown) => {
        reconcileCalls += 1;
        assert.equal((input as { txHash: string }).txHash, txHash("submitted-then-reverted"));
        return { status: "failed", error: "persisted settlement transaction reverted" };
      },
    });

    await runInjected(dependencies);
    const submittedStore = productionStore(keyPrefix);
    const submitted = (await submittedStore.load(NETWORK)).state;
    const submittedAttempt = submitted.settleAttempt;
    assert.equal(submittedAttempt?.status, "submitted");
    assert.equal(submittedAttempt?.txHash, txHash("submitted-then-reverted"));
    assert.ok(submittedAttempt?.submittedAt && submittedAttempt.submittedAt > 0);
    assert.ok(submittedAttempt?.operationId);
    assert.equal(submittedAttempt?.claims.length, 1);

    dependencies.store = submittedStore;
    const failed = await runInjected(dependencies);
    assert.match(failed.chains[0]?.error || "", /persisted settlement transaction reverted/u);

    const failedStore = productionStore(keyPrefix);
    const failedState = (await failedStore.load(NETWORK)).state;
    assert.equal(failedState.settleAttempt, undefined);
    const archived = failedState.failedSettleAttempts?.[submittedAttempt.operationId];
    assert.ok(archived);
    assert.equal(archived.status, "failed");
    assert.equal(archived.operationId, submittedAttempt.operationId);
    assert.equal(archived.txHash, txHash("submitted-then-reverted"));
    assert.equal(archived.error, "persisted settlement transaction reverted");
    assert.ok(archived.failedAt && archived.failedAt > 0);
    assert.deepEqual(archived.claims, submittedAttempt.claims);
    assert.ok(receipts.every((entry) => entry.settleTxHash !== txHash("submitted-then-reverted")));

    dependencies.store = failedStore;
    const retried = await runInjected(dependencies);

    assert.equal(retried.chains[0]?.settleTxHash, txHash("settle-after-revert"));
    assert.equal(executeCalls, 2);
    assert.equal(reconcileCalls, 1);
    assert.equal(claims.calls.length, 1, "settlement retry must reuse the durable claim");
    const completed = (await productionStore(keyPrefix).load(NETWORK)).state;
    assert.deepEqual(completed.claims, {});
    assert.equal(
      completed.failedSettleAttempts?.[submittedAttempt.operationId]?.txHash,
      txHash("submitted-then-reverted"),
    );
  });
});

test("an ambiguous settle response reconciles its persisted transaction without rebroadcast", async () => {
  const onlyChannel = channel("0xddd");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-d") },
  );
  const store = new MemoryOperationStore();
  let executeCalls = 0;
  let reconcileCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    executeSettlement: async () => {
      executeCalls += 1;
      return {
        status: "ambiguous",
        txHash: txHash("settle-ambiguous"),
        error: "response lost after broadcast",
      };
    },
    reconcileSettlement: async (input: unknown) => {
      reconcileCalls += 1;
      assert.equal((input as { txHash: string }).txHash, txHash("settle-ambiguous"));
      assert.equal(store.snapshot().settleAttempt?.txHash, txHash("settle-ambiguous"));
      return reconcileCalls === 1
        ? { status: "pending", error: "receipt not indexed" }
        : { status: "confirmed", txHash: txHash("settle-ambiguous") };
    },
  });

  await runInjected(dependencies);
  assert.equal(store.snapshot().settleAttempt?.status, "submitted");
  assert.equal(store.snapshot().settleAttempt?.txHash, txHash("settle-ambiguous"));
  assert.ok((store.snapshot().settleAttempt?.submittedAt || 0) > 0);

  await runInjected(dependencies);
  const confirmed = await runInjected(dependencies);

  assert.equal(confirmed.chains[0]?.settleTxHash, txHash("settle-ambiguous"));
  assert.equal(executeCalls, 1, "an ambiguous broadcast must never be blindly repeated");
  assert.equal(reconcileCalls, 2);
  assert.equal(store.snapshot().settleAttempt, undefined);
});

test("a noncanonical execution hash blocks settlement without persisting false submission", async () => {
  const onlyChannel = channel("0xinvalid-execution-hash");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-before-invalid-execution-hash") },
  );
  const store = new MemoryOperationStore();
  let executeCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    executeSettlement: async () => {
      executeCalls += 1;
      return { status: "confirmed", txHash: "0xshort" };
    },
  });

  const first = await runInjected(dependencies);
  const second = await runInjected(dependencies);

  assert.match(first.chains[0]?.error || "", /confirmed settlement transaction hash/iu);
  assert.match(second.chains[0]?.error || "", /confirmed settlement transaction hash/iu);
  assert.equal(executeCalls, 1);
  assert.equal(store.snapshot().settleAttempt?.status, "blocked");
  assert.equal(store.snapshot().settleAttempt?.txHash, undefined);
  assert.deepEqual(Object.keys(store.snapshot().claims), [onlyChannel.channelId]);
});

test("a noncanonical reconciliation hash preserves the original submitted transaction", async () => {
  const onlyChannel = channel("0xinvalid-reconciliation-hash");
  const submittedHash = txHash("submitted-before-invalid-reconciliation-hash");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-before-invalid-reconciliation-hash") },
  );
  const store = new MemoryOperationStore();
  let executeCalls = 0;
  let reconcileCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    executeSettlement: async () => {
      executeCalls += 1;
      return { status: "ambiguous", txHash: submittedHash, error: "receipt unavailable" };
    },
    reconcileSettlement: async () => {
      reconcileCalls += 1;
      return { status: "confirmed", txHash: "0xshort" };
    },
  });

  await runInjected(dependencies);
  const result = await runInjected(dependencies);

  assert.match(result.chains[0]?.error || "", /reconciled settlement transaction hash/iu);
  assert.equal(executeCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(store.snapshot().settleAttempt?.status, "submitted");
  assert.equal(store.snapshot().settleAttempt?.txHash, submittedHash);
  assert.ok((store.snapshot().settleAttempt?.submittedAt || 0) > 0);
});

test("an ambiguous settle without a transaction identity fails closed and is never rebroadcast", async () => {
  const onlyChannel = channel("0xidentity-unavailable");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-identity-unavailable") },
  );
  const store = new MemoryOperationStore();
  let executeCalls = 0;
  let reconcileCalls = 0;
  const dependencies = baseDependencies({
    store,
    claims,
    executeSettlement: async () => {
      executeCalls += 1;
      return { status: "ambiguous", error: "receipt response lost after broadcast" };
    },
    reconcileSettlement: async () => {
      reconcileCalls += 1;
      return { status: "pending" };
    },
  });

  const first = await runInjected(dependencies);
  const second = await runInjected(dependencies);

  assert.match(first.chains[0]?.error || "", /does not expose the settle transaction identity/u);
  assert.match(second.chains[0]?.error || "", /does not expose the settle transaction identity/u);
  assert.equal(store.snapshot().settleAttempt?.status, "blocked");
  assert.equal(store.snapshot().settleAttempt?.txHash, undefined);
  assert.equal(executeCalls, 1);
  assert.equal(reconcileCalls, 0);
});

test("claim projection uses the cumulative selected by the manager's actual snapshot", async () => {
  const onlyChannel = channel("0xeee", "100");
  const claims = new ClaimHarness(
    [onlyChannel],
    { [onlyChannel.channelId]: txHash("claim-e") },
  );
  claims.beforeSelection = () => {
    onlyChannel.chargedCumulativeAmount = "175";
  };
  const store = new MemoryOperationStore();
  const receipts: Projection[] = [];
  const dependencies = baseDependencies({ store, claims, receiptProjections: receipts });

  await runInjected(dependencies);

  const claimed = receipts.find((entry) => !entry.settleTxHash);
  assert.equal(claimed?.claimedAmountWei, "175");
  assert.equal(claimed?.claimTxHash, txHash("claim-e"));
});

test("each claimed channel keeps the transaction hash from its own one-channel claim", async () => {
  const firstChannel = channel("0xfff", "30");
  const secondChannel = channel("0x111", "40");
  const claims = new ClaimHarness(
    [firstChannel, secondChannel],
    {
      [firstChannel.channelId]: txHash("claim-f"),
      [secondChannel.channelId]: txHash("claim-1"),
    },
  );
  const store = new MemoryOperationStore();
  const receipts: Projection[] = [];
  const evidence: Projection[] = [];
  const dependencies = baseDependencies({
    store,
    claims,
    receiptProjections: receipts,
    evidenceProjections: evidence,
    executeSettlement: async () => ({ status: "confirmed", txHash: txHash("settle-final") }),
  });

  await runInjected(dependencies);

  const settledReceipts = receipts.filter((entry) => entry.settleTxHash);
  const settledEvidence = evidence.filter((entry) => entry.settleTxHash);
  assert.deepEqual(
    settledReceipts.map((entry) => [entry.channelId, entry.claimTxHash, entry.settleTxHash]).sort(),
    [
      [firstChannel.channelId, txHash("claim-f"), txHash("settle-final")],
      [secondChannel.channelId, txHash("claim-1"), txHash("settle-final")],
    ].sort(),
  );
  assert.deepEqual(
    settledEvidence.map((entry) => [entry.channelId, entry.claimTxHash, entry.settleTxHash]).sort(),
    settledReceipts.map((entry) => [entry.channelId, entry.claimTxHash, entry.settleTxHash]).sort(),
  );
});
