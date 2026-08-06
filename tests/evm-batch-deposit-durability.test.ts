import "dotenv/config";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { ChannelConfig, FacilitatorEvmSigner } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { BatchSettlementEvmScheme as BatchSettlementFacilitatorEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import type { Request, Response } from "express";
import { encodeAbiParameters } from "viem";

import * as batchModule from "../x402/batch.js";
import { getNetwork, NETWORK_IDS, type EvmNetworkId } from "../x402/configs/chains.js";
import { resolveRawBatchBacking } from "../x402/envelope.js";
import { createPaymentRequirement, getFacilitator } from "../x402/facilitator.js";
import { prepareInferencePayment } from "../x402/index.js";
import {
  closeValkey,
  valkeyDel,
  valkeyExpire,
  valkeyExists,
  valkeyHGetAll,
  valkeyHSet,
  valkeyTTL,
} from "../x402/keys/valkey.js";

const NETWORK = NETWORK_IDS.arcTestnet;
const PAYER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const CHANNEL_ID = `0x${"33".repeat(32)}`;
const TX_HASH = `0x${"44".repeat(32)}`;

type DepositStatus = "prepared" | "broadcast" | "submitted" | "confirmed" | "failed";

type DepositState = {
  key: string;
  status: DepositStatus;
  network: EvmNetworkId;
  channelId: string;
  authorizationFingerprint: string;
  backingFingerprint: string;
  payer: string;
  asset: string;
  receiver: string;
  resource: string;
  maxAmountWei: string;
  verifiedBalanceWei: string;
  verifiedTotalClaimedWei: string;
  verifiedWithdrawRequestedAt: string;
  verifiedRefundNonce: string;
  preparedAt: number;
  broadcastAt?: number;
  submittedAt?: number;
  confirmedAt?: number;
  failedAt?: number;
  ownerToken?: string;
  txHash?: string;
  error?: string;
};

type DepositStore = {
  read(key: string): Promise<DepositState | null>;
  prepare(state: DepositState): Promise<DepositState>;
  claimBroadcast(input: {
    key: string;
    ownerToken: string;
    broadcastAt: number;
  }): Promise<{ acquired: boolean; state: DepositState }>;
  markSubmitted(input: {
    key: string;
    ownerToken: string;
    txHash: string;
    submittedAt: number;
  }): Promise<DepositState>;
  markConfirmed(input: {
    key: string;
    txHash: string;
    confirmedAt: number;
  }): Promise<DepositState>;
  markFailed(input: {
    key: string;
    ownerToken: string;
    txHash?: string;
    error: string;
    failedAt: number;
  }): Promise<DepositState>;
};

type BroadcastResult =
  | { status: "submitted" | "confirmed"; txHash: string }
  | { status: "failed"; terminal: true; error: string; txHash?: string }
  | { status: "unknown"; error: string };

type DepositDependencies = {
  store: DepositStore;
  broadcastDeposit(input: {
    paymentPayload: PaymentPayload;
    requirements: PaymentRequirements;
    onSubmitted(txHash: string): Promise<void>;
  }): Promise<BroadcastResult>;
  reconcileDeposit(txHash: string, network: EvmNetworkId): Promise<BroadcastResult>;
  now(): number;
  createOwnerToken(): string;
};

type EnsureDeposit = (
  input: {
    paymentPayload: PaymentPayload;
    requirements: PaymentRequirements;
    verifyResult?: VerifyResponse;
  },
  dependencies: DepositDependencies,
) => Promise<DepositState | null>;

type CreateDepositDependencies = (
  broadcastDeposit: DepositDependencies["broadcastDeposit"],
) => DepositDependencies;

type RequireConfirmedDeposit = (
  input: {
    paymentPayload: PaymentPayload;
    requirements: PaymentRequirements;
  },
  dependencies: Pick<DepositDependencies, "store">,
) => Promise<DepositState>;

type DepositAuthorizationKind = "erc3009" | "permit2";

function hexBytes(byte: string, length: number): `0x${string}` {
  return `0x${byte.repeat(length)}`;
}

function depositPayment(input: {
  authorization?: DepositAuthorizationKind;
  authorizationVariant?: number;
  unsignedExtension?: string;
} = {}): { paymentPayload: PaymentPayload; requirements: PaymentRequirements; verifyResult: VerifyResponse } {
  const authorization = input.authorization || "permit2";
  const variant = input.authorizationVariant || 0;
  const asset = getNetwork(NETWORK).asset.address;
  const requirements: PaymentRequirements = {
    scheme: "batch-settlement",
    network: NETWORK,
    asset,
    amount: "1000",
    payTo: RECEIVER,
    maxTimeoutSeconds: 300,
    extra: authorization === "erc3009"
      ? { assetTransferMethod: "eip3009", name: "Circle USD", version: "2" }
      : { assetTransferMethod: "permit2" },
  };
  const depositAuthorization = authorization === "erc3009"
    ? {
      erc3009Authorization: {
        validAfter: "0",
        validBefore: String(2_000_000_000 + variant),
        salt: hexBytes(variant === 0 ? "77" : "78", 32),
        signature: hexBytes(variant === 0 ? "88" : "89", 65),
      },
    }
    : {
      permit2Authorization: {
        from: PAYER,
        permitted: { token: asset, amount: "5000" },
        spender: "0x4020425FAf3B746C082C2f942b4E5159887B0005",
        nonce: String(700 + variant),
        deadline: String(2_000_000_000 + variant),
        witness: { channelId: CHANNEL_ID },
        signature: hexBytes(variant === 0 ? "99" : "9a", 65),
      },
    };
  const paymentPayload = {
    x402Version: 2,
    resource: { url: "https://api.compose.market/agent/test/stream" },
    accepted: requirements,
    ...(input.unsignedExtension
      ? { extensions: { "test-unsigned-extension": { value: input.unsignedExtension } } }
      : {}),
    payload: {
      type: "deposit",
      channelConfig: {
        payer: PAYER,
        payerAuthorizer: PAYER,
        receiver: RECEIVER,
        receiverAuthorizer: RECEIVER,
        token: asset,
        network: NETWORK,
        resource: "https://api.compose.market/agent/test/stream",
        balance: "5000",
        withdrawDelay: 900,
        salt: `0x${"55".repeat(32)}`,
      },
      voucher: {
        channelId: CHANNEL_ID,
        maxClaimableAmount: String(6000 + variant * 1000),
        signature: hexBytes(variant === 0 ? "66" : "67", 65),
      },
      deposit: {
        amount: "5000",
        authorization: depositAuthorization,
      },
    },
  } as PaymentPayload;
  return {
    paymentPayload,
    requirements,
    verifyResult: {
      isValid: true,
      payer: PAYER,
      extra: {
        balance: "0",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
      },
    },
  };
}

function backingFingerprint(payment: ReturnType<typeof depositPayment>): string {
  return resolveRawBatchBacking({
    network: NETWORK,
    maxAmountWei: payment.paymentPayload.accepted.amount,
    paymentPayload: payment.paymentPayload,
    payer: PAYER,
  }).backingFingerprint;
}

function depositAuthorization(payment: ReturnType<typeof depositPayment>): Record<string, unknown> {
  const payload = payment.paymentPayload.payload as {
    deposit?: { authorization?: Record<string, unknown> };
  };
  assert.ok(payload.deposit?.authorization, "deposit authorization must exist in the test fixture");
  return payload.deposit.authorization;
}

function uniqueDepositAuthorization(payment: ReturnType<typeof depositPayment>): void {
  const authorization = depositAuthorization(payment);
  if (authorization.erc3009Authorization) {
    Object.assign(authorization.erc3009Authorization as Record<string, unknown>, {
      salt: `0x${randomBytes(32).toString("hex")}`,
      signature: `0x${randomBytes(65).toString("hex")}`,
    });
    return;
  }
  Object.assign(authorization.permit2Authorization as Record<string, unknown>, {
    nonce: BigInt(`0x${randomBytes(16).toString("hex")}`).toString(),
    signature: `0x${randomBytes(65).toString("hex")}`,
  });
}

function mutateAuditMetadata(
  payment: ReturnType<typeof depositPayment>,
  input: {
    label: string;
    maxAmountWei: string;
    balance: string;
    totalClaimed: string;
    withdrawRequestedAt: string;
    refundNonce: string;
  },
): void {
  const resource = `https://api.compose.market/agent/${input.label}/stream`;
  payment.requirements.amount = input.maxAmountWei;
  payment.paymentPayload.accepted.amount = input.maxAmountWei;
  payment.paymentPayload.resource = { url: resource };
  const payload = payment.paymentPayload.payload as {
    channelConfig: { resource?: string };
  };
  payload.channelConfig.resource = resource;
  payment.paymentPayload.extensions = {
    "test-unsigned-extension": { value: input.label },
  };
  payment.verifyResult.extra = {
    balance: input.balance,
    totalClaimed: input.totalClaimed,
    withdrawRequestedAt: input.withdrawRequestedAt,
    refundNonce: input.refundNonce,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function preparedStateFrom(state: DepositState): DepositState {
  return {
    key: state.key,
    status: "prepared",
    network: state.network,
    channelId: state.channelId,
    authorizationFingerprint: state.authorizationFingerprint,
    backingFingerprint: state.backingFingerprint,
    payer: state.payer,
    asset: state.asset,
    receiver: state.receiver,
    resource: state.resource,
    maxAmountWei: state.maxAmountWei,
    verifiedBalanceWei: state.verifiedBalanceWei,
    verifiedTotalClaimedWei: state.verifiedTotalClaimedWei,
    verifiedWithdrawRequestedAt: state.verifiedWithdrawRequestedAt,
    verifiedRefundNonce: state.verifiedRefundNonce,
    preparedAt: state.preparedAt,
  };
}

function stateRecord(state: DepositState): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state)
      .filter((entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number")
      .map(([field, value]) => [field, String(value)]),
  );
}

async function preparedFixture(
  authorization: DepositAuthorizationKind = "permit2",
): Promise<{
  payment: ReturnType<typeof depositPayment>;
  state: DepositState;
}> {
  const payment = depositPayment({ authorization });
  uniqueDepositAuthorization(payment);
  const store = new MemoryDepositStore();
  const confirmed = await coordinator().ensure(payment, confirmingHarness(store).dependencies);
  assert.ok(confirmed);
  return { payment, state: preparedStateFrom(confirmed) };
}

function rawRequest(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    headers: normalized,
    protocol: "https",
    method: "POST",
    originalUrl: "/agent/test/stream",
    url: "/agent/test/stream",
    body: {},
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

function responseRecorder(): {
  response: Response;
  statusCode(): number | null;
} {
  let statusCode: number | null = null;
  const response = {
    setHeader() {
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  return { response, statusCode: () => statusCode };
}

class MemoryDepositStore implements DepositStore {
  readonly records = new Map<string, DepositState>();

  async read(key: string): Promise<DepositState | null> {
    const state = this.records.get(key);
    return state ? clone(state) : null;
  }

  async prepare(state: DepositState): Promise<DepositState> {
    const existing = this.records.get(state.key);
    if (existing) return clone(existing);
    this.records.set(state.key, clone(state));
    return clone(state);
  }

  async claimBroadcast(input: {
    key: string;
    ownerToken: string;
    broadcastAt: number;
  }): Promise<{ acquired: boolean; state: DepositState }> {
    const current = this.require(input.key);
    if (current.status !== "prepared") {
      return { acquired: false, state: clone(current) };
    }
    const next: DepositState = {
      ...current,
      status: "broadcast",
      ownerToken: input.ownerToken,
      broadcastAt: input.broadcastAt,
    };
    this.records.set(input.key, next);
    return { acquired: true, state: clone(next) };
  }

  async markSubmitted(input: {
    key: string;
    ownerToken: string;
    txHash: string;
    submittedAt: number;
  }): Promise<DepositState> {
    const current = this.require(input.key);
    if (current.status === "submitted" && current.txHash === input.txHash) return clone(current);
    assert.equal(current.status, "broadcast");
    assert.equal(current.ownerToken, input.ownerToken);
    const next: DepositState = {
      ...current,
      status: "submitted",
      txHash: input.txHash,
      submittedAt: input.submittedAt,
    };
    this.records.set(input.key, next);
    return clone(next);
  }

  async markConfirmed(input: {
    key: string;
    txHash: string;
    confirmedAt: number;
  }): Promise<DepositState> {
    const current = this.require(input.key);
    assert.equal(current.status, "submitted");
    assert.equal(current.txHash, input.txHash);
    const next: DepositState = {
      ...current,
      status: "confirmed",
      confirmedAt: input.confirmedAt,
    };
    this.records.set(input.key, next);
    return clone(next);
  }

  async markFailed(input: {
    key: string;
    ownerToken: string;
    txHash?: string;
    error: string;
    failedAt: number;
  }): Promise<DepositState> {
    const current = this.require(input.key);
    assert.equal(current.ownerToken, input.ownerToken);
    if (current.status === "failed") {
      assert.equal(current.txHash, input.txHash);
      return clone(current);
    }
    if (current.status === "broadcast") {
      assert.equal(input.txHash, undefined);
    } else {
      assert.equal(current.status, "submitted");
      assert.equal(current.txHash, input.txHash);
    }
    const next: DepositState = {
      ...current,
      status: "failed",
      error: input.error,
      failedAt: input.failedAt,
      ...(input.txHash ? { txHash: input.txHash } : {}),
    };
    this.records.set(input.key, next);
    return clone(next);
  }

  private require(key: string): DepositState {
    const state = this.records.get(key);
    assert.ok(state, `missing deposit state ${key}`);
    return state;
  }
}

function coordinator(): { ensure: EnsureDeposit; requireConfirmed: RequireConfirmedDeposit } {
  const ensure = (batchModule as unknown as { ensureEvmBatchDeposit?: EnsureDeposit }).ensureEvmBatchDeposit;
  const requireConfirmed = (batchModule as unknown as {
    requireEvmBatchDepositConfirmed?: RequireConfirmedDeposit;
  }).requireEvmBatchDepositConfirmed;
  assert.equal(typeof ensure, "function", "EVM deposit durability coordinator must be exported");
  assert.equal(typeof requireConfirmed, "function", "EVM inherited backing gate must be exported");
  return { ensure: ensure!, requireConfirmed: requireConfirmed! };
}

function productionDependencies(
  broadcastDeposit: DepositDependencies["broadcastDeposit"],
): DepositDependencies {
  const create = (batchModule as unknown as {
    createEvmBatchDepositDependencies?: CreateDepositDependencies;
  }).createEvmBatchDepositDependencies;
  assert.equal(typeof create, "function", "production EVM deposit dependencies must be exported");
  return create!(broadcastDeposit);
}

after(async () => {
  await closeValkey();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function confirmingHarness(store: MemoryDepositStore): {
  dependencies: DepositDependencies;
  broadcasts(): number;
} {
  let broadcastCount = 0;
  let now = 50;
  return {
    dependencies: {
      store,
      broadcastDeposit: async () => {
        broadcastCount += 1;
        return {
          status: "confirmed",
          txHash: `0x${broadcastCount.toString(16).padStart(64, "0")}`,
        };
      },
      reconcileDeposit: async (txHash) => ({ status: "confirmed", txHash }),
      now: () => ++now,
      createOwnerToken: () => `identity-owner-${now}`,
    },
    broadcasts: () => broadcastCount,
  };
}

for (const authorization of ["erc3009", "permit2"] as const) {
  test(`an exact ${authorization} deposit authorization replay resolves to the original durable state`, async () => {
    const { ensure } = coordinator();
    const payment = depositPayment({ authorization });
    const store = new MemoryDepositStore();
    const harness = confirmingHarness(store);

    const original = await ensure(payment, harness.dependencies);
    const replay = await ensure(payment, harness.dependencies);

    assert.equal(replay?.key, original?.key);
    assert.equal(replay?.backingFingerprint, original?.backingFingerprint);
    assert.equal(harness.broadcasts(), 1);
    assert.equal(store.records.size, 1);
  });

  test(`${authorization} wrappers differing only by unsigned extensions share one authorization state and broadcast`, async () => {
    const { ensure } = coordinator();
    const originalPayment = depositPayment({ authorization, unsignedExtension: "first" });
    const equivalentPayment = depositPayment({ authorization, unsignedExtension: "second" });
    const store = new MemoryDepositStore();
    const harness = confirmingHarness(store);
    assert.notEqual(backingFingerprint(originalPayment), backingFingerprint(equivalentPayment),
      "the reproduced wrappers must retain distinct full backing fingerprints");

    const original = await ensure(originalPayment, harness.dependencies);
    const equivalent = await ensure(equivalentPayment, harness.dependencies);

    assert.equal(equivalent?.key, original?.key);
    assert.equal(equivalent?.authorizationFingerprint, original?.authorizationFingerprint);
    assert.equal(equivalent?.backingFingerprint, backingFingerprint(originalPayment),
      "the converged state must retain its original full wrapper fingerprint separately");
    assert.equal(harness.broadcasts(), 1);
    assert.equal(store.records.size, 1);
  });

  test(`a newly signed ${authorization} top-up on the same channel gets a new durable authorization identity`, async () => {
    const { ensure } = coordinator();
    const initialPayment = depositPayment({ authorization });
    const topUpPayment = depositPayment({ authorization, authorizationVariant: 1 });
    const store = new MemoryDepositStore();
    const harness = confirmingHarness(store);

    const initial = await ensure(initialPayment, harness.dependencies);
    const topUp = await ensure(topUpPayment, harness.dependencies);

    assert.notEqual(topUp?.authorizationFingerprint, initial?.authorizationFingerprint);
    assert.notEqual(topUp?.key, initial?.key);
    assert.equal(harness.broadcasts(), 2);
    assert.equal(store.records.size, 2);
  });

  test(`${authorization} authorization identity canonicalizes equivalent integer, address, and hex encodings`, async () => {
    const { ensure } = coordinator();
    const originalPayment = depositPayment({ authorization });
    const equivalentPayment = depositPayment({ authorization });
    const originalAuthorization = depositAuthorization(originalPayment);
    const equivalentAuthorization = depositAuthorization(equivalentPayment);
    if (authorization === "erc3009") {
      Object.assign(originalAuthorization.erc3009Authorization as Record<string, unknown>, {
        salt: hexBytes("ab", 32),
        signature: hexBytes("cd", 65),
      });
      Object.assign(equivalentAuthorization.erc3009Authorization as Record<string, unknown>, {
        validAfter: "000",
        validBefore: "02000000000",
        salt: `0x${"AB".repeat(32)}`,
        signature: `0x${"CD".repeat(65)}`,
      });
    } else {
      const originalPermit = originalAuthorization.permit2Authorization as Record<string, unknown>;
      const equivalentPermit = equivalentAuthorization.permit2Authorization as Record<string, unknown>;
      const originalPermitted = originalPermit.permitted as Record<string, unknown>;
      const equivalentPermitted = equivalentPermit.permitted as Record<string, unknown>;
      Object.assign(originalPermit, { signature: hexBytes("ab", 65) });
      Object.assign(equivalentPermit, {
        from: String(originalPermit.from).toUpperCase().replace(/^0X/u, "0x"),
        spender: String(originalPermit.spender).toUpperCase().replace(/^0X/u, "0x"),
        nonce: "0700",
        deadline: "02000000000",
        signature: `0x${"AB".repeat(65)}`,
      });
      equivalentPermitted.token = String(originalPermitted.token).toUpperCase().replace(/^0X/u, "0x");
      equivalentPermitted.amount = "05000";
    }
    const store = new MemoryDepositStore();
    const harness = confirmingHarness(store);
    assert.notEqual(backingFingerprint(originalPayment), backingFingerprint(equivalentPayment));

    const original = await ensure(originalPayment, harness.dependencies);
    const equivalent = await ensure(equivalentPayment, harness.dependencies);

    assert.equal(equivalent?.key, original?.key);
    assert.equal(equivalent?.authorizationFingerprint, original?.authorizationFingerprint);
    assert.equal(harness.broadcasts(), 1);
    assert.equal(store.records.size, 1);
  });

  test(`${authorization} authorization identity is independent of direct object key order`, async () => {
    const { ensure } = coordinator();
    const originalPayment = depositPayment({ authorization });
    const reorderedPayment = clone(originalPayment);
    const originalAuthorization = depositAuthorization(originalPayment);
    const reorderedPayload = reorderedPayment.paymentPayload.payload as {
      deposit: { authorization: Record<string, unknown> };
    };
    if (authorization === "erc3009") {
      const erc3009 = originalAuthorization.erc3009Authorization as Record<string, unknown>;
      reorderedPayload.deposit.authorization = {
        erc3009Authorization: {
          signature: erc3009.signature,
          salt: erc3009.salt,
          validBefore: erc3009.validBefore,
          validAfter: erc3009.validAfter,
        },
      };
    } else {
      const permit2 = originalAuthorization.permit2Authorization as Record<string, unknown>;
      const permitted = permit2.permitted as Record<string, unknown>;
      const witness = permit2.witness as Record<string, unknown>;
      reorderedPayload.deposit.authorization = {
        permit2Authorization: {
          signature: permit2.signature,
          witness: { channelId: witness.channelId },
          deadline: permit2.deadline,
          nonce: permit2.nonce,
          spender: permit2.spender,
          permitted: { amount: permitted.amount, token: permitted.token },
          from: permit2.from,
        },
      };
    }
    const store = new MemoryDepositStore();
    const harness = confirmingHarness(store);

    const original = await ensure(originalPayment, harness.dependencies);
    const reordered = await ensure(reorderedPayment, harness.dependencies);

    assert.equal(reordered?.authorizationFingerprint, original?.authorizationFingerprint);
    assert.equal(reordered?.key, original?.key);
    assert.equal(
      reordered?.key,
      `x402:batch-settlement:evm-deposit:${encodeURIComponent(NETWORK)}:${CHANNEL_ID.toLowerCase()}:${original?.authorizationFingerprint}`,
      "the durable key order must be network, canonical channel, then authorization identity",
    );
    assert.equal(harness.broadcasts(), 1);
    assert.equal(store.records.size, 1);
  });

  test(`production Valkey converges concurrent and sequential ${authorization} wrapper audit metadata`, async () => {
    const { ensure } = coordinator();
    const seed = depositPayment({ authorization });
    uniqueDepositAuthorization(seed);
    const firstPayment = clone(seed);
    const concurrentPayment = clone(seed);
    const sequentialPayment = clone(seed);
    mutateAuditMetadata(firstPayment, {
      label: `first-${authorization}`,
      maxAmountWei: "1000",
      balance: "0",
      totalClaimed: "0",
      withdrawRequestedAt: "0",
      refundNonce: "0",
    });
    mutateAuditMetadata(concurrentPayment, {
      label: `concurrent-${authorization}`,
      maxAmountWei: "900",
      balance: "5000",
      totalClaimed: "40",
      withdrawRequestedAt: "20",
      refundNonce: "3",
    });
    mutateAuditMetadata(sequentialPayment, {
      label: `sequential-${authorization}`,
      maxAmountWei: "800",
      balance: "4800",
      totalClaimed: "80",
      withdrawRequestedAt: "30",
      refundNonce: "4",
    });
    const wrapperFingerprints = [
      backingFingerprint(firstPayment),
      backingFingerprint(concurrentPayment),
      backingFingerprint(sequentialPayment),
    ];
    assert.equal(new Set(wrapperFingerprints).size, 3);
    let broadcasts = 0;
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    const dependencies = productionDependencies(async () => {
      broadcasts += 1;
      return { status: "confirmed", txHash };
    });
    const cleanupKeys = new Set<string>();

    try {
      const concurrentResults = await Promise.allSettled([
        ensure(firstPayment, dependencies),
        ensure(concurrentPayment, dependencies),
      ]);
      for (const result of concurrentResults) {
        if (result.status === "fulfilled" && result.value) cleanupKeys.add(result.value.key);
      }
      assert.ok(
        concurrentResults.every((result) => result.status === "fulfilled"),
        "equivalent concurrent wrappers must both converge on the production record",
      );
      const concurrentStates = concurrentResults.map((result) => {
        assert.equal(result.status, "fulfilled");
        assert.ok(result.value);
        return result.value;
      });
      assert.equal(concurrentStates[0].key, concurrentStates[1].key);
      assert.equal(concurrentStates[0].authorizationFingerprint, concurrentStates[1].authorizationFingerprint);
      assert.ok(wrapperFingerprints.slice(0, 2).includes(concurrentStates[0].backingFingerprint));
      const beforeSequentialReplay = await valkeyHGetAll(concurrentStates[0].key);

      const sequentialState = await ensure(sequentialPayment, dependencies);
      assert.ok(sequentialState);
      cleanupKeys.add(sequentialState.key);
      assert.equal(sequentialState.key, concurrentStates[0].key);
      assert.equal(sequentialState.authorizationFingerprint, concurrentStates[0].authorizationFingerprint);
      assert.equal(sequentialState.backingFingerprint, concurrentStates[0].backingFingerprint);
      assert.deepEqual(await valkeyHGetAll(sequentialState.key), beforeSequentialReplay,
        "first-writer audit metadata must remain unchanged on equivalent replay");
      assert.equal(broadcasts, 1);
      assert.equal(await valkeyTTL(sequentialState.key), -1,
        "confirmed authorization ownership must be a durable no-rebroadcast record");
      assert.equal(
        sequentialState.key,
        `x402:batch-settlement:evm-deposit:${encodeURIComponent(NETWORK)}:${CHANNEL_ID.toLowerCase()}:${sequentialState.authorizationFingerprint}`,
      );
      for (const wrapperFingerprint of wrapperFingerprints) {
        const wrapperKey = [
          "x402:batch-settlement:evm-deposit",
          encodeURIComponent(NETWORK),
          CHANNEL_ID.toLowerCase(),
          wrapperFingerprint,
        ].join(":");
        assert.equal(await valkeyExists(wrapperKey), false,
          "full wrapper fingerprints must not create fallback deposit keys");
      }
    } finally {
      await Promise.all([...cleanupKeys].map((key) => valkeyDel(key)));
    }
  });

  test(`production Valkey retains an ambiguous ${authorization} broadcast beyond any fixed TTL`, async () => {
    const { ensure } = coordinator();
    const payment = depositPayment({ authorization });
    uniqueDepositAuthorization(payment);
    const rawAuthorization = depositAuthorization(payment);
    if (authorization === "erc3009") {
      (rawAuthorization.erc3009Authorization as Record<string, unknown>).validBefore =
        "999999999999999999999999999999";
    } else {
      (rawAuthorization.permit2Authorization as Record<string, unknown>).deadline =
        "999999999999999999999999999999";
    }
    let broadcasts = 0;
    const dependencies = productionDependencies(async () => {
      broadcasts += 1;
      return { status: "unknown", error: "broadcast result lost after submission" };
    });
    let state: DepositState | null = null;

    try {
      state = await ensure(payment, dependencies);
      assert.ok(state);
      assert.equal(state.status, "broadcast");
      assert.equal(state.txHash, undefined);
      assert.equal(await valkeyTTL(state.key), -1,
        "a hashless broadcast tombstone must not expire while replay remains possible");

      const replay = await ensure(payment, dependencies);
      assert.equal(replay?.key, state.key);
      assert.equal(replay?.status, "broadcast");
      assert.equal(broadcasts, 1);
    } finally {
      if (state) await valkeyDel(state.key);
    }
  });
}

test("production Valkey rejects malformed and causally impossible EVM deposit records", async (t) => {
  const { state } = await preparedFixture();
  const ownerToken = "strict-shape-owner";
  const broadcastAt = state.preparedAt + 1;
  const submittedAt = broadcastAt + 1;
  const confirmedAt = submittedAt + 1;
  const failedAt = submittedAt + 2;
  const base = stateRecord(state);
  const cases: Array<{ name: string; record: Record<string, string> }> = [
    {
      name: "prepared state with an owner",
      record: { ...base, ownerToken },
    },
    {
      name: "broadcast state with a transaction hash",
      record: {
        ...base,
        status: "broadcast",
        ownerToken,
        broadcastAt: String(broadcastAt),
        txHash: TX_HASH,
      },
    },
    {
      name: "submitted state without its broadcast owner",
      record: {
        ...base,
        status: "submitted",
        broadcastAt: String(broadcastAt),
        txHash: TX_HASH,
        submittedAt: String(submittedAt),
      },
    },
    {
      name: "submitted state with confirmation fields",
      record: {
        ...base,
        status: "submitted",
        ownerToken,
        broadcastAt: String(broadcastAt),
        txHash: TX_HASH,
        submittedAt: String(submittedAt),
        confirmedAt: String(confirmedAt),
      },
    },
    {
      name: "confirmed state with a noncanonical transaction hash",
      record: {
        ...base,
        status: "confirmed",
        ownerToken,
        broadcastAt: String(broadcastAt),
        txHash: `0x${"AA".repeat(32)}`,
        submittedAt: String(submittedAt),
        confirmedAt: String(confirmedAt),
      },
    },
    {
      name: "confirmed state whose timestamps run backwards",
      record: {
        ...base,
        status: "confirmed",
        ownerToken,
        broadcastAt: String(broadcastAt),
        txHash: TX_HASH,
        submittedAt: String(submittedAt),
        confirmedAt: String(submittedAt - 1),
      },
    },
    {
      name: "failed state with a transaction but no submitted provenance",
      record: {
        ...base,
        status: "failed",
        ownerToken,
        broadcastAt: String(broadcastAt),
        txHash: TX_HASH,
        error: "reverted",
        failedAt: String(failedAt),
      },
    },
    {
      name: "hashless failed state with submitted provenance",
      record: {
        ...base,
        status: "failed",
        ownerToken,
        broadcastAt: String(broadcastAt),
        submittedAt: String(submittedAt),
        error: "reverted",
        failedAt: String(failedAt),
      },
    },
    {
      name: "failed state with confirmation fields",
      record: {
        ...base,
        status: "failed",
        ownerToken,
        broadcastAt: String(broadcastAt),
        txHash: TX_HASH,
        submittedAt: String(submittedAt),
        confirmedAt: String(confirmedAt),
        error: "reverted",
        failedAt: String(failedAt),
      },
    },
    {
      name: "record with an unknown legacy field",
      record: { ...base, legacyAttemptId: "legacy" },
    },
  ];
  const dependencies = productionDependencies(async () => ({
    status: "unknown",
    error: "not used",
  }));

  for (const malformed of cases) {
    await t.test(malformed.name, async () => {
      try {
        await valkeyHSet(state.key, malformed.record);
        assert.equal(await dependencies.store.read(state.key), null);
      } finally {
        await valkeyDel(state.key);
      }
    });
  }
});

test("every production EVM deposit store operation removes an inherited TTL", async () => {
  const first = await preparedFixture("permit2");
  const second = await preparedFixture("erc3009");
  const dependencies = productionDependencies(async () => ({
    status: "unknown",
    error: "not used",
  }));
  const ownerToken = "ttl-owner";
  const failureOwner = "ttl-failure-owner";

  try {
    await valkeyHSet(first.state.key, stateRecord(first.state));
    await valkeyExpire(first.state.key, 60);
    await dependencies.store.prepare(first.state);
    assert.equal(await valkeyTTL(first.state.key), -1, "prepare must PERSIST an existing record");

    await valkeyExpire(first.state.key, 60);
    assert.ok(await dependencies.store.read(first.state.key));
    assert.equal(await valkeyTTL(first.state.key), -1, "read must PERSIST the record");

    await valkeyExpire(first.state.key, 60);
    const claimed = await dependencies.store.claimBroadcast({
      key: first.state.key,
      ownerToken,
      broadcastAt: first.state.preparedAt + 1,
    });
    assert.equal(claimed.acquired, true);
    assert.equal(await valkeyTTL(first.state.key), -1, "claimBroadcast must PERSIST the record");

    await valkeyExpire(first.state.key, 60);
    await dependencies.store.markSubmitted({
      key: first.state.key,
      ownerToken,
      txHash: TX_HASH,
      submittedAt: first.state.preparedAt + 2,
    });
    assert.equal(await valkeyTTL(first.state.key), -1, "markSubmitted must PERSIST the record");

    await valkeyExpire(first.state.key, 60);
    await dependencies.store.markConfirmed({
      key: first.state.key,
      txHash: TX_HASH,
      confirmedAt: first.state.preparedAt + 3,
    });
    assert.equal(await valkeyTTL(first.state.key), -1, "markConfirmed must PERSIST the record");

    await valkeyHSet(second.state.key, stateRecord(second.state));
    await dependencies.store.claimBroadcast({
      key: second.state.key,
      ownerToken: failureOwner,
      broadcastAt: second.state.preparedAt + 1,
    });
    await valkeyExpire(second.state.key, 60);
    await dependencies.store.markFailed({
      key: second.state.key,
      ownerToken: failureOwner,
      error: "definitive pre-submission failure",
      failedAt: second.state.preparedAt + 2,
    });
    assert.equal(await valkeyTTL(second.state.key), -1, "markFailed must PERSIST the record");
  } finally {
    await Promise.all([valkeyDel(first.state.key), valkeyDel(second.state.key)]);
  }
});

test("production failure CAS preserves exact owner and transaction provenance", async () => {
  const { state } = await preparedFixture();
  const { state: hashlessState } = await preparedFixture("erc3009");
  const dependencies = productionDependencies(async () => ({
    status: "unknown",
    error: "not used",
  }));
  const ownerToken = "failure-cas-owner";
  const broadcastAt = state.preparedAt + 10;
  const submittedAt = broadcastAt + 10;
  const failedAt = submittedAt + 10;
  const staleTxHash = `0x${"55".repeat(32)}`;

  try {
    await dependencies.store.prepare(state);
    await dependencies.store.claimBroadcast({ key: state.key, ownerToken, broadcastAt });

    await assert.rejects(dependencies.store.markSubmitted({
      key: state.key,
      ownerToken,
      txHash: "0x1234",
      submittedAt,
    }), /transaction|hash|submitted transition/i);
    await assert.rejects(dependencies.store.markSubmitted({
      key: state.key,
      ownerToken,
      txHash: TX_HASH,
      submittedAt: broadcastAt - 1,
    }), /timestamp|submitted transition/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      txHash: "0x1234",
      error: "malformed transaction identity",
      failedAt,
    }), /transaction|hash|failure/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken: "wrong-owner",
      error: "wrong owner",
      failedAt,
    }), /ownership|attempt|failure/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      txHash: TX_HASH,
      error: "broadcast has no submitted transaction provenance",
      failedAt,
    }), /transaction|attempt|failure/i);
    assert.equal((await dependencies.store.read(state.key))?.status, "broadcast");

    await dependencies.store.markSubmitted({
      key: state.key,
      ownerToken,
      txHash: TX_HASH,
      submittedAt,
    });
    await assert.rejects(dependencies.store.markConfirmed({
      key: state.key,
      txHash: "0x1234",
      confirmedAt: failedAt,
    }), /transaction|hash|confirmation/i);
    await assert.rejects(dependencies.store.markConfirmed({
      key: state.key,
      txHash: TX_HASH,
      confirmedAt: submittedAt - 1,
    }), /timestamp|confirmation/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      error: "missing transaction identity",
      failedAt,
    }), /transaction|attempt|failure/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      txHash: staleTxHash,
      error: "stale transaction identity",
      failedAt,
    }), /transaction|attempt|failure/i);
    assert.equal((await dependencies.store.read(state.key))?.status, "submitted");

    const failed = await dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      txHash: TX_HASH,
      error: "matching transaction reverted",
      failedAt,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.txHash, TX_HASH);
    assert.equal(failed.submittedAt, submittedAt);

    const replay = await dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      txHash: TX_HASH,
      error: "matching transaction reverted again",
      failedAt: failedAt + 1,
    });
    assert.deepEqual(replay, failed, "an exact failed replay must be idempotent");
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken: "wrong-owner",
      txHash: TX_HASH,
      error: "wrong failed owner",
      failedAt: failedAt + 1,
    }), /ownership|attempt|failure/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      error: "lost failed transaction identity",
      failedAt: failedAt + 1,
    }), /transaction|attempt|failure/i);
    await assert.rejects(dependencies.store.markFailed({
      key: state.key,
      ownerToken,
      txHash: staleTxHash,
      error: "changed failed transaction identity",
      failedAt: failedAt + 1,
    }), /transaction|attempt|failure/i);

    const hashlessOwner = "hashless-failure-owner";
    await dependencies.store.prepare(hashlessState);
    await dependencies.store.claimBroadcast({
      key: hashlessState.key,
      ownerToken: hashlessOwner,
      broadcastAt: hashlessState.preparedAt + 1,
    });
    const hashlessFailed = await dependencies.store.markFailed({
      key: hashlessState.key,
      ownerToken: hashlessOwner,
      error: "broadcast failed before submission",
      failedAt: hashlessState.preparedAt + 2,
    });
    const hashlessReplay = await dependencies.store.markFailed({
      key: hashlessState.key,
      ownerToken: hashlessOwner,
      error: "broadcast failed before submission again",
      failedAt: hashlessState.preparedAt + 3,
    });
    assert.deepEqual(hashlessReplay, hashlessFailed, "an exact hashless failed replay must be idempotent");
    await assert.rejects(dependencies.store.markFailed({
      key: hashlessState.key,
      ownerToken: "wrong-owner",
      error: "wrong hashless failed owner",
      failedAt: hashlessState.preparedAt + 3,
    }), /ownership|attempt|failure/i);
    await assert.rejects(dependencies.store.markFailed({
      key: hashlessState.key,
      ownerToken: hashlessOwner,
      txHash: TX_HASH,
      error: "invented failed transaction identity",
      failedAt: hashlessState.preparedAt + 3,
    }), /transaction|attempt|failure/i);
  } finally {
    await Promise.all([valkeyDel(state.key), valkeyDel(hashlessState.key)]);
  }
});

test("submitted reconciliation terminalizes only the exact durable transaction", async () => {
  const { ensure } = coordinator();
  const payment = depositPayment();
  uniqueDepositAuthorization(payment);
  let broadcasts = 0;
  let reconciliation: BroadcastResult = {
    status: "failed",
    terminal: true,
    error: "hashless terminal response",
  };
  const dependencies = productionDependencies(async ({ onSubmitted }) => {
    broadcasts += 1;
    await onSubmitted(TX_HASH);
    return { status: "submitted", txHash: TX_HASH };
  });
  dependencies.reconcileDeposit = async () => reconciliation;
  let key: string | undefined;

  try {
    const submitted = await ensure(payment, dependencies);
    assert.ok(submitted);
    key = submitted.key;
    assert.equal(submitted.status, "submitted");

    const afterHashless = await ensure({
      paymentPayload: payment.paymentPayload,
      requirements: payment.requirements,
    }, dependencies);
    assert.equal(afterHashless?.status, "submitted");

    reconciliation = {
      status: "failed",
      terminal: true,
      txHash: `0x${"55".repeat(32)}`,
      error: "stale transaction terminal response",
    };
    const afterStale = await ensure({
      paymentPayload: payment.paymentPayload,
      requirements: payment.requirements,
    }, dependencies);
    assert.equal(afterStale?.status, "submitted");

    reconciliation = {
      status: "failed",
      terminal: true,
      txHash: TX_HASH,
      error: "exact transaction reverted",
    };
    const failed = await ensure({
      paymentPayload: payment.paymentPayload,
      requirements: payment.requirements,
    }, dependencies);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.txHash, TX_HASH);
    assert.equal(broadcasts, 1);
  } finally {
    if (key) await valkeyDel(key);
  }
});

test("missing or dual EVM deposit authorization forms fail closed before broadcast", async () => {
  const { ensure } = coordinator();
  const missing = depositPayment();
  const missingAuthorization = depositAuthorization(missing);
  for (const key of Object.keys(missingAuthorization)) delete missingAuthorization[key];
  const missingStore = new MemoryDepositStore();
  const missingHarness = confirmingHarness(missingStore);
  await assert.rejects(
    ensure(missing, missingHarness.dependencies),
    /requires exactly one supported authorization/u,
  );
  assert.equal(missingHarness.broadcasts(), 0);
  assert.equal(missingStore.records.size, 0);

  const dual = depositPayment({ authorization: "permit2" });
  const erc3009 = depositPayment({ authorization: "erc3009" });
  depositAuthorization(dual).erc3009Authorization =
    depositAuthorization(erc3009).erc3009Authorization;
  const dualStore = new MemoryDepositStore();
  const dualHarness = confirmingHarness(dualStore);
  await assert.rejects(
    ensure(dual, dualHarness.dependencies),
    /requires exactly one supported authorization/u,
  );
  assert.equal(dualHarness.broadcasts(), 0);
  assert.equal(dualStore.records.size, 0);
});

test("unsupported EVM deposit authorization forms fail closed before state creation", async () => {
  const { ensure } = coordinator();
  const payment = depositPayment();
  const payload = payment.paymentPayload.payload as {
    deposit: { authorization: Record<string, unknown> };
  };
  payload.deposit.authorization = {
    eip2612Authorization: {
      owner: PAYER,
      deadline: "2000000000",
      signature: hexBytes("aa", 65),
    },
  };
  const store = new MemoryDepositStore();
  const harness = confirmingHarness(store);

  await assert.rejects(
    ensure(payment, harness.dependencies),
    /unsupported authorization form/u,
  );
  assert.equal(harness.broadcasts(), 0);
  assert.equal(store.records.size, 0);
});

for (const authorization of ["erc3009", "permit2"] as const) {
  test(`malformed ${authorization} authorization fields fail closed before state creation`, async () => {
    const { ensure } = coordinator();
    const payment = depositPayment({ authorization });
    const rawAuthorization = depositAuthorization(payment);
    if (authorization === "erc3009") {
      (rawAuthorization.erc3009Authorization as Record<string, unknown>).salt = "0x12";
    } else {
      (rawAuthorization.permit2Authorization as Record<string, unknown>).nonce = "-1";
    }
    const store = new MemoryDepositStore();
    const harness = confirmingHarness(store);

    await assert.rejects(ensure(payment, harness.dependencies));
    assert.equal(harness.broadcasts(), 0);
    assert.equal(store.records.size, 0);
  });
}

test("an inherited lane cannot obtain billable backing while the root EVM deposit is unconfirmed", async () => {
  const { ensure, requireConfirmed } = coordinator();
  const payment = depositPayment();
  const store = new MemoryDepositStore();
  const broadcastStarted = deferred();
  const confirmBroadcast = deferred();
  let broadcasts = 0;
  let inheritedCommits = 0;
  let now = 100;
  const dependencies: DepositDependencies = {
    store,
    broadcastDeposit: async ({ onSubmitted }) => {
      broadcasts += 1;
      broadcastStarted.resolve();
      await confirmBroadcast.promise;
      await onSubmitted(TX_HASH);
      return { status: "confirmed", txHash: TX_HASH };
    },
    reconcileDeposit: async (txHash) => ({ status: "confirmed", txHash }),
    now: () => ++now,
    createOwnerToken: () => "root-owner",
  };

  const root = ensure(payment, dependencies);
  await broadcastStarted.promise;

  await assert.rejects(
    async () => {
      await requireConfirmed(payment, { store });
      inheritedCommits += 1;
    },
    /deposit.*(?:broadcast|confirmed)|not confirmed/i,
  );
  assert.equal(inheritedCommits, 0);
  assert.equal(broadcasts, 1);

  confirmBroadcast.resolve();
  const confirmed = await root;
  assert.equal(confirmed?.status, "confirmed");
  await requireConfirmed(payment, { store });
  inheritedCommits += 1;
  assert.equal(inheritedCommits, 1);
});

test("a recreated preparation reconciles the persisted original EVM deposit transaction without rebroadcast", async () => {
  const { ensure } = coordinator();
  const payment = depositPayment();
  const store = new MemoryDepositStore();
  let broadcasts = 0;
  let reconciliations = 0;
  let now = 200;
  const dependencies: DepositDependencies = {
    store,
    broadcastDeposit: async ({ onSubmitted }) => {
      broadcasts += 1;
      await onSubmitted(TX_HASH);
      throw new Error("response lost after successful broadcast");
    },
    reconcileDeposit: async (txHash, network) => {
      reconciliations += 1;
      assert.equal(txHash, TX_HASH);
      assert.equal(network, NETWORK);
      return { status: "confirmed", txHash };
    },
    now: () => ++now,
    createOwnerToken: () => `owner-${now}`,
  };

  const afterLoss = await ensure(payment, dependencies);
  assert.equal(afterLoss?.status, "submitted");
  assert.equal(afterLoss?.txHash, TX_HASH);

  const recreated = await ensure({
    paymentPayload: payment.paymentPayload,
    requirements: payment.requirements,
  }, dependencies);
  assert.equal(recreated?.status, "confirmed");
  assert.equal(recreated?.txHash, TX_HASH);
  assert.equal(broadcasts, 1, "the immutable deposit authorization must never be broadcast twice");
  assert.equal(reconciliations, 1);
});

test("a hashless terminal broadcast result cannot erase an onSubmitted transaction identity", async () => {
  const { ensure } = coordinator();
  const payment = depositPayment();
  const store = new MemoryDepositStore();
  let now = 225;
  const dependencies: DepositDependencies = {
    store,
    broadcastDeposit: async ({ onSubmitted }) => {
      await onSubmitted(TX_HASH);
      return {
        status: "failed",
        terminal: true,
        error: "terminal response omitted its already-published transaction hash",
      };
    },
    reconcileDeposit: async () => ({ status: "unknown", error: "pending reconciliation" }),
    now: () => ++now,
    createOwnerToken: () => "hashless-after-submitted-owner",
  };

  const submitted = await ensure(payment, dependencies);
  assert.equal(submitted?.status, "submitted");
  assert.equal(submitted?.txHash, TX_HASH);
});

test("an ambiguous EVM deposit broadcast without a transaction identity fails closed without rebroadcast", async () => {
  const { ensure, requireConfirmed } = coordinator();
  const payment = depositPayment();
  const store = new MemoryDepositStore();
  let broadcasts = 0;
  let reconciliations = 0;
  let now = 250;
  const dependencies: DepositDependencies = {
    store,
    broadcastDeposit: async () => {
      broadcasts += 1;
      return { status: "unknown", error: "RPC response lost after possible broadcast" };
    },
    reconcileDeposit: async () => {
      reconciliations += 1;
      assert.fail("a transaction-less broadcast record has no honest reconciliation identity");
    },
    now: () => ++now,
    createOwnerToken: () => `ambiguous-owner-${now}`,
  };

  const ambiguous = await ensure(payment, dependencies);
  assert.equal(ambiguous?.status, "broadcast");
  assert.equal(ambiguous?.txHash, undefined);

  const recreated = await ensure({
    paymentPayload: payment.paymentPayload,
    requirements: payment.requirements,
  }, dependencies);
  assert.equal(recreated?.status, "broadcast");
  await assert.rejects(requireConfirmed(payment, { store }), /broadcast, not confirmed/i);
  assert.equal(broadcasts, 1, "an ambiguous immutable authorization must never be broadcast blindly again");
  assert.equal(reconciliations, 0, "reconciliation must not invent a missing transaction identity");
});

test("a definitively failed EVM deposit permanently rejects inherited checkpoints", async () => {
  const { ensure, requireConfirmed } = coordinator();
  const payment = depositPayment();
  const store = new MemoryDepositStore();
  let broadcasts = 0;
  let inheritedCommits = 0;
  let now = 300;
  const dependencies: DepositDependencies = {
    store,
    broadcastDeposit: async () => {
      broadcasts += 1;
      return {
        status: "failed",
        terminal: true,
        txHash: TX_HASH,
        error: "deposit transaction reverted",
      };
    },
    reconcileDeposit: async () => {
      assert.fail("a definitive failure must not be reconciled or retried");
    },
    now: () => ++now,
    createOwnerToken: () => "failed-owner",
  };

  const failed = await ensure(payment, dependencies);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.txHash, TX_HASH);
  assert.ok(failed?.submittedAt, "a transaction-bearing failure must retain submitted provenance");
  assert.match(failed?.error || "", /reverted/);

  await assert.rejects(
    async () => {
      await requireConfirmed(payment, { store });
      inheritedCommits += 1;
    },
    /deposit.*failed|reverted/i,
  );
  const replay = await ensure(payment, dependencies);
  assert.equal(replay?.status, "failed");
  assert.equal(inheritedCommits, 0);
  assert.equal(broadcasts, 1, "failed immutable deposit backing must stay unusable");
});

test("the production @x402/evm 2.20 adapter maps a hashless settle result to one permanent tombstone", async () => {
  const { ensure, requireConfirmed } = coordinator();
  const requirement = createPaymentRequirement({
    amountWei: "1000",
    network: NETWORK,
    scheme: "batch-settlement",
  });
  const payment = depositPayment({ authorization: "erc3009" });
  uniqueDepositAuthorization(payment);
  const raw = payment.paymentPayload.payload as {
    channelConfig: ChannelConfig;
    voucher: { channelId: `0x${string}`; maxClaimableAmount: string };
  };
  raw.channelConfig.payerAuthorizer = "0x0000000000000000000000000000000000000000";
  raw.channelConfig.receiver = requirement.payTo as `0x${string}`;
  raw.channelConfig.receiverAuthorizer = requirement.payTo as `0x${string}`;
  raw.channelConfig.token = requirement.asset as `0x${string}`;
  const channelId = computeChannelId(raw.channelConfig, NETWORK);
  raw.voucher.channelId = channelId;
  raw.voucher.maxClaimableAmount = requirement.amount;
  payment.requirements = requirement;
  payment.paymentPayload.accepted = requirement;

  const installedTxHash = `0x${"ab".repeat(32)}` as const;
  let installedWriteContractCalls = 0;
  let installedReceiptWaitCalls = 0;
  let waitedForHash: `0x${string}` | undefined;
  const installedSigner: FacilitatorEvmSigner = {
    getAddresses: () => [RECEIVER],
    async readContract({ functionName }) {
      if (functionName === "isValidSignature") return "0x1626ba7e";
      if (functionName === "deposit") return undefined;
      if (functionName === "tryAggregate") {
        return [
          {
            success: true,
            returnData: encodeAbiParameters(
              [{ type: "uint128" }, { type: "uint128" }],
              [0n, 0n],
            ),
          },
          {
            success: true,
            returnData: encodeAbiParameters([{ type: "uint256" }], [10_000n]),
          },
          {
            success: true,
            returnData: encodeAbiParameters(
              [{ type: "uint128" }, { type: "uint40" }],
              [0n, 0],
            ),
          },
          {
            success: true,
            returnData: encodeAbiParameters([{ type: "uint256" }], [0n]),
          },
        ];
      }
      assert.fail(`unexpected installed facilitator readContract call: ${functionName}`);
    },
    async verifyTypedData() {
      return true;
    },
    async writeContract({ functionName }) {
      assert.equal(functionName, "deposit");
      installedWriteContractCalls += 1;
      return installedTxHash;
    },
    async sendTransaction() {
      assert.fail("the direct ERC-3009 deposit path must not send a standalone transaction");
    },
    async waitForTransactionReceipt({ hash }) {
      installedReceiptWaitCalls += 1;
      waitedForHash = hash;
      throw new Error("installed receipt wait failed after broadcast");
    },
    async getCode() {
      return "0x01";
    },
  };
  const installedFacilitatorScheme = new BatchSettlementFacilitatorEvmScheme(installedSigner);

  const facilitator = await getFacilitator();
  const mutableFacilitator = facilitator as unknown as {
    verify(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
    settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  };
  const originalVerify = mutableFacilitator.verify;
  const originalSettle = mutableFacilitator.settle;
  let settleCalls = 0;
  let installedSettleResult: SettleResponse | undefined;
  mutableFacilitator.verify = async () => payment.verifyResult;
  mutableFacilitator.settle = async (paymentPayload, requirements) => {
    settleCalls += 1;
    installedSettleResult = await installedFacilitatorScheme.settle(paymentPayload, requirements);
    return installedSettleResult;
  };
  const runId = `adapter-${randomBytes(12).toString("hex")}`;
  const paymentHeader = encodePaymentSignatureHeader(payment.paymentPayload);
  const headers = {
    host: "api.compose.market",
    "x-network-id": NETWORK,
    "x-run-id": runId,
    "x-execution-run-id": runId,
    "x-x402-max-amount-wei": "1000",
    "payment-signature": paymentHeader,
  };
  const readDependencies = productionDependencies(async () => {
    assert.fail("the production adapter must own the only settle attempt");
  });
  let state: DepositState | null = null;

  try {
    const firstResponse = responseRecorder();
    assert.equal(await prepareInferencePayment(
      rawRequest(headers),
      firstResponse.response,
      { useBudgetCap: true, scheme: "batch-settlement" },
    ), null);
    assert.equal(firstResponse.statusCode(), 402);
    assert.equal(installedWriteContractCalls, 1,
      "the installed facilitator scheme must execute the deposit writeContract path");
    assert.equal(installedReceiptWaitCalls, 1);
    assert.equal(waitedForHash, installedTxHash,
      "the installed scheme must lose the exact hash only after submitting it");
    assert.equal(installedSettleResult?.success, false);
    assert.equal(installedSettleResult?.transaction, "",
      "@x402/evm 2.20 drops the submitted hash when receipt waiting throws");
    assert.match(installedSettleResult?.errorMessage || "", /receipt wait failed after broadcast/u);

    state = await ensure({
      paymentPayload: payment.paymentPayload,
      requirements: requirement,
    }, readDependencies);
    assert.ok(state);
    assert.equal(state.status, "broadcast");
    assert.equal(state.txHash, undefined);
    assert.equal(await valkeyTTL(state.key), -1);
    await assert.rejects(requireConfirmed(payment, { store: readDependencies.store }), /broadcast, not confirmed/u);
    assert.equal(await valkeyExists(`x402:envelope:${runId}`), false,
      "unconfirmed adapter results must not publish an inheritable envelope");
    assert.equal(await batchModule.getBatchChannelStorage().get(channelId), undefined,
      "unconfirmed adapter results must not publish a billable channel");

    const replayResponse = responseRecorder();
    assert.equal(await prepareInferencePayment(
      rawRequest(headers),
      replayResponse.response,
      { useBudgetCap: true, scheme: "batch-settlement" },
    ), null);
    assert.equal(replayResponse.statusCode(), 402);
    assert.equal(settleCalls, 1, "the installed-style hashless result must never be blindly rebroadcast");
    assert.equal(installedWriteContractCalls, 1, "replay must not submit a second on-chain deposit");
    assert.equal(installedReceiptWaitCalls, 1, "replay must not re-enter installed settlement");
  } finally {
    mutableFacilitator.verify = originalVerify;
    mutableFacilitator.settle = originalSettle;
    if (state) await valkeyDel(state.key);
    await valkeyDel(`x402:envelope:${runId}`);
    await batchModule.getBatchChannelStorage().updateChannel(channelId, () => undefined);
  }
});
