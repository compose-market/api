import { randomUUID } from "node:crypto";

import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { BatchSettlementChannelManager, BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import type { FacilitatorClient } from "@x402/core/server";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getBatchAsset, getBatchChannelStorage } from "./batch.js";
import {
  getNetwork,
  getNetworkRpcUrl,
  getSupportedNetworks,
  getViemChain,
  isEvmNetwork,
  isNetworkId,
  type EvmNetworkId,
} from "./configs/chains.js";
import { markBatchEvidenceSettled } from "./evidence.js";
import { getFacilitator } from "./facilitator.js";
import { getValkeyClient } from "./keys/valkey.js";
import { markBatchReceiptsSettled } from "./receipts.js";
import { merchantWalletAddress } from "./wallets.js";

const WITHDRAW_DELAY_SECONDS = 900;
const MAX_STATE_CAS_ATTEMPTS = 32;
const MAX_CLAIM_OPERATIONS_PER_RUN = 10_000;
const CLAIM_TRANSACTION_FAILED = "invalid_batch_settlement_evm_claim_transaction_failed";
const SETTLE_TRANSACTION_FAILED = "invalid_batch_settlement_evm_settle_transaction_failed";
const SETTLE_SIMULATION_FAILED = "invalid_batch_settlement_evm_settle_simulation_failed";
const RPC_READ_FAILED = "invalid_batch_settlement_evm_rpc_read_failed";
const NOTHING_TO_SETTLE = "invalid_batch_settlement_evm_nothing_to_settle";
const UNIDENTIFIED_SETTLE_LIMITATION =
  "@x402/evm 2.20.0 does not expose the settle transaction identity before broadcast and strips it when receipt waiting fails; settlement is blocked to prevent a blind rebroadcast";

type ChainResult = {
  network: EvmNetworkId;
  claimCount: number;
  claimTxHashes: string[];
  settleTxHash?: string;
  reconciledReceipts?: number;
  reconciledEvidence?: number;
  error?: string;
};

export type NativeEvmClaimRecord = {
  channelId: string;
  claimedAmountWei: string;
  claimTxHash: string;
  claimOperationId: string;
  confirmedAt: number;
};

export type NativeEvmClaimAttempt = {
  operationId: string;
  status: "prepared" | "blocked";
  channelId: string;
  claimedAmountWei: string;
  preparedAt: number;
  error?: string;
};

type NativeEvmSettleAttemptBase = {
  operationId: string;
  claims: NativeEvmClaimRecord[];
  preparedAt: number;
};

export type NativeEvmActiveSettleAttempt = NativeEvmSettleAttemptBase & {
  status: "prepared" | "submitted" | "blocked";
  txHash?: string;
  submittedAt?: number;
  error?: string;
};

export type NativeEvmFailedSettleAttempt = NativeEvmSettleAttemptBase & {
  status: "failed";
  txHash: string;
  submittedAt: number;
  error: string;
  failedAt: number;
};

export type NativeEvmSettleAttempt = NativeEvmActiveSettleAttempt | NativeEvmFailedSettleAttempt;

export type NativeEvmOperationState = {
  version: 1;
  revision: number;
  phase: "claiming" | "settling" | "blocked";
  claims: Record<string, NativeEvmClaimRecord>;
  claimAttempts: Record<string, NativeEvmClaimAttempt>;
  settledClaims?: Record<string, NativeEvmClaimRecord>;
  settleAttempt?: NativeEvmActiveSettleAttempt;
  failedSettleAttempts?: Record<string, NativeEvmFailedSettleAttempt>;
  blockedReason?: string;
};

export type NativeEvmOperationSnapshot = {
  state: NativeEvmOperationState;
  persisted: string | null;
};

export interface NativeEvmOperationStore {
  load(network: EvmNetworkId): Promise<NativeEvmOperationSnapshot>;
  compareAndSet(
    network: EvmNetworkId,
    expected: NativeEvmOperationSnapshot,
    next: NativeEvmOperationState,
  ): Promise<boolean>;
}

type NativeEvmClaimChannel = {
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

type NativeEvmClaimResult = {
  vouchers: number;
  transaction: string;
};

type NativeEvmClaimManager = {
  claim(options: {
    maxClaimsPerBatch: number;
    idleSecs: number;
    selectClaimChannels(
      channels: NativeEvmClaimChannel[],
    ): NativeEvmClaimChannel[] | Promise<NativeEvmClaimChannel[]>;
  }): Promise<NativeEvmClaimResult[]>;
};

type ConfirmedClaimObservation = {
  channelId: string;
  claimedAmountWei: string;
  claimTxHash: string;
  vouchers: number;
};

type SettlementExecutionResult =
  | { status: "confirmed"; txHash: string }
  | { status: "rejected"; error: string; txHash?: string }
  | { status: "submitted" | "ambiguous"; txHash?: string; error?: string };

type SettlementReconciliationResult =
  | { status: "confirmed"; txHash?: string }
  | { status: "failed"; error: string }
  | { status: "pending"; error?: string };

type BatchProjection = {
  channelId: string;
  claimedAmountWei: string;
  network: EvmNetworkId;
  claimTxHash?: string;
  settleTxHash?: string;
};

export type NativeEvmBatchSettlementDependencies = {
  networks(): EvmNetworkId[];
  claimBacking(network: EvmNetworkId): { asset: string; receiver: string };
  store: NativeEvmOperationStore;
  createClaimManager(input: {
    network: EvmNetworkId;
    onConfirmedClaim(observation: ConfirmedClaimObservation): Promise<void>;
  }): NativeEvmClaimManager;
  executeSettlement(input: {
    network: EvmNetworkId;
    operationId: string;
    claims: NativeEvmClaimRecord[];
  }): Promise<SettlementExecutionResult>;
  reconcileSettlement(input: {
    network: EvmNetworkId;
    operationId: string;
    txHash: string;
  }): Promise<SettlementReconciliationResult>;
  markBatchReceiptsSettled(input: BatchProjection): Promise<number>;
  markBatchEvidenceSettled(input: BatchProjection): Promise<number>;
  now(): number;
  createOperationId(): string;
  idleSecs: number;
  isDefinitiveClaimFailure(error: unknown): boolean;
};

export type NativeBatchSettlementSummary = {
  runId: string;
  startedAt: number;
  finishedAt: number;
  chains: ChainResult[];
};

class DefinitiveClaimFailure extends Error { }
class AmbiguousClaimFailure extends Error { }

let scheme: BatchSettlementEvmScheme | null = null;
let client: FacilitatorClient | null = null;

function receiverAuthorizer() {
  const privateKey = process.env.FACILITATOR_KEY;
  if (!privateKey) {
    throw new Error("FACILITATOR_KEY environment variable is required for native batch settlement");
  }

  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
  return {
    address: account.address,
    signTypedData: (params: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => account.signTypedData(params as never),
  };
}

function serverScheme(): BatchSettlementEvmScheme {
  if (!scheme) {
    scheme = new BatchSettlementEvmScheme(merchantWalletAddress, {
      storage: getBatchChannelStorage(),
      receiverAuthorizerSigner: receiverAuthorizer(),
      withdrawDelay: WITHDRAW_DELAY_SECONDS,
    });
  }
  return scheme;
}

function facilitatorClient(): FacilitatorClient {
  if (client) return client;

  client = {
    verify: (paymentPayload, paymentRequirements) =>
      getFacilitator().then((facilitator) => facilitator.verify(paymentPayload, paymentRequirements)),
    settle: (paymentPayload, paymentRequirements) =>
      getFacilitator().then((facilitator) => facilitator.settle(paymentPayload, paymentRequirements)),
    getSupported: async () =>
      (await getFacilitator()).getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
  };
  return client;
}

function configuredNetworks(): EvmNetworkId[] {
  const configured = (process.env.BATCH_SETTLEMENT_NETWORKS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is EvmNetworkId => isNetworkId(value) && isEvmNetwork(value));

  if (configured.length > 0) return configured;

  return getSupportedNetworks()
    .filter((definition): definition is typeof definition & { id: EvmNetworkId } => (
      isEvmNetwork(definition.id) && Boolean(process.env[definition.rpcEnvVar]?.trim())
    ))
    .map((definition) => definition.id);
}

function initialOperationState(): NativeEvmOperationState {
  return { version: 1, revision: 0, phase: "claiming", claims: {}, claimAttempts: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalWei(value: string): string {
  if (!/^\d+$/u.test(value)) throw new Error(`Invalid unsigned decimal amount: ${value}`);
  const canonical = value.replace(/^0+/u, "");
  return canonical || "0";
}

function parseCanonicalWei(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`Invalid native EVM ${context} amount`);
  const canonical = canonicalWei(value);
  if (canonical !== value) throw new Error(`Invalid native EVM ${context} canonical amount`);
  return canonical;
}

function canonicalTransactionHash(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`Invalid native EVM ${context} transaction hash`);
  }
  return value;
}

function positiveTimestamp(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid native EVM ${context} timestamp`);
  }
  return Number(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !permitted.has(key));
  if (unexpected) throw new Error(`Invalid native EVM ${context} field: ${unexpected}`);
}

function compareWei(left: string, right: string): number {
  const a = canonicalWei(left);
  const b = canonicalWei(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function channelStateKey(channelId: string): string {
  return channelId.toLowerCase();
}

function parseClaimRecord(value: unknown): NativeEvmClaimRecord {
  if (!isObject(value)
    || typeof value.channelId !== "string"
    || !value.channelId
    || typeof value.claimOperationId !== "string"
    || !value.claimOperationId) {
    throw new Error("Invalid native EVM claim operation record");
  }
  assertAllowedKeys(
    value,
    ["channelId", "claimedAmountWei", "claimTxHash", "claimOperationId", "confirmedAt"],
    "claim operation record",
  );
  return {
    channelId: value.channelId,
    claimedAmountWei: parseCanonicalWei(value.claimedAmountWei, "claim"),
    claimTxHash: canonicalTransactionHash(value.claimTxHash, "claim"),
    claimOperationId: value.claimOperationId,
    confirmedAt: positiveTimestamp(value.confirmedAt, "claim confirmation"),
  };
}

function parseClaimAttempt(value: unknown): NativeEvmClaimAttempt {
  if (!isObject(value)
    || typeof value.operationId !== "string"
    || !value.operationId
    || (value.status !== "prepared" && value.status !== "blocked")
    || typeof value.channelId !== "string"
    || !value.channelId) {
    throw new Error("Invalid native EVM claim attempt");
  }
  assertAllowedKeys(
    value,
    ["operationId", "status", "channelId", "claimedAmountWei", "preparedAt", "error"],
    "claim attempt",
  );
  if ((value.status === "blocked" && (typeof value.error !== "string" || !value.error.trim()))
    || (value.status === "prepared" && value.error !== undefined)) {
    throw new Error("Invalid native EVM claim attempt provenance");
  }
  return {
    operationId: value.operationId,
    status: value.status as NativeEvmClaimAttempt["status"],
    channelId: value.channelId,
    claimedAmountWei: parseCanonicalWei(value.claimedAmountWei, "claim attempt"),
    preparedAt: positiveTimestamp(value.preparedAt, "claim preparation"),
    ...(value.status === "blocked" ? { error: String(value.error) } : {}),
  };
}

function parseSettleAttempt(value: unknown, failedHistory: true): NativeEvmFailedSettleAttempt;
function parseSettleAttempt(value: unknown, failedHistory: false): NativeEvmActiveSettleAttempt;
function parseSettleAttempt(
  value: unknown,
  failedHistory: boolean,
): NativeEvmActiveSettleAttempt | NativeEvmFailedSettleAttempt {
  if (!isObject(value)
    || typeof value.operationId !== "string"
    || !value.operationId
    || !Array.isArray(value.claims)
    || value.claims.length === 0) {
    throw new Error("Invalid native EVM settle attempt");
  }
  assertAllowedKeys(
    value,
    failedHistory
      ? ["operationId", "status", "claims", "preparedAt", "txHash", "submittedAt", "error", "failedAt"]
      : ["operationId", "status", "claims", "preparedAt", "txHash", "submittedAt", "error"],
    failedHistory ? "failed settle attempt" : "active settle attempt",
  );
  const claims = value.claims.map(parseClaimRecord);
  const claimKeys = claims.map((claim) => channelStateKey(claim.channelId));
  if (new Set(claimKeys).size !== claimKeys.length) {
    throw new Error("Invalid native EVM settle attempt duplicate claim provenance");
  }
  const base: NativeEvmSettleAttemptBase = {
    operationId: value.operationId,
    claims,
    preparedAt: positiveTimestamp(value.preparedAt, "settlement preparation"),
  };
  if (claims.some((claim) => claim.confirmedAt > base.preparedAt)) {
    throw new Error("Invalid native EVM settlement prepared before claim confirmation");
  }
  if (failedHistory) {
    if (value.status !== "failed"
      || typeof value.error !== "string"
      || !value.error.trim()) {
      throw new Error("Invalid native EVM failed settle attempt provenance");
    }
    const submittedAt = positiveTimestamp(value.submittedAt, "settlement submission");
    const failedAt = positiveTimestamp(value.failedAt, "settlement failure");
    if (submittedAt < base.preparedAt || failedAt < submittedAt) {
      throw new Error("Invalid native EVM failed settle attempt chronology");
    }
    return {
      ...base,
      status: "failed",
      txHash: canonicalTransactionHash(value.txHash, "failed settlement"),
      submittedAt,
      error: value.error,
      failedAt,
    };
  }
  if (value.status !== "prepared" && value.status !== "submitted" && value.status !== "blocked") {
    throw new Error("Invalid native EVM active settle attempt status");
  }
  if (value.status === "prepared") {
    if (value.txHash !== undefined || value.submittedAt !== undefined || value.error !== undefined) {
      throw new Error("Invalid native EVM prepared settle attempt provenance");
    }
    return { ...base, status: "prepared" };
  }
  if (value.status === "submitted") {
    if (value.error !== undefined && (typeof value.error !== "string" || !value.error.trim())) {
      throw new Error("Invalid native EVM submitted settle attempt error");
    }
    const submittedAt = positiveTimestamp(value.submittedAt, "settlement submission");
    if (submittedAt < base.preparedAt) {
      throw new Error("Invalid native EVM submitted settle attempt chronology");
    }
    return {
      ...base,
      status: "submitted",
      txHash: canonicalTransactionHash(value.txHash, "submitted settlement"),
      submittedAt,
      ...(value.error !== undefined ? { error: String(value.error) } : {}),
    };
  }
  if (typeof value.error !== "string" || !value.error.trim()) {
    throw new Error("Invalid native EVM active settle attempt provenance");
  }
  const txHash = value.txHash === undefined
    ? undefined
    : canonicalTransactionHash(value.txHash, "blocked settlement");
  const submittedAt = value.submittedAt === undefined
    ? undefined
    : positiveTimestamp(value.submittedAt, "settlement submission");
  if ((txHash === undefined) !== (submittedAt === undefined)
    || (submittedAt !== undefined && submittedAt < base.preparedAt)) {
    throw new Error("Invalid native EVM blocked settle attempt provenance");
  }
  return {
    ...base,
    status: "blocked",
    ...(txHash !== undefined ? { txHash } : {}),
    ...(submittedAt !== undefined ? { submittedAt } : {}),
    error: value.error,
  };
}

function sameClaimRecord(left: NativeEvmClaimRecord, right: NativeEvmClaimRecord): boolean {
  return left.channelId === right.channelId
    && left.claimedAmountWei === right.claimedAmountWei
    && left.claimTxHash === right.claimTxHash
    && left.claimOperationId === right.claimOperationId
    && left.confirmedAt === right.confirmedAt;
}

function parseOperationState(raw: string | null): NativeEvmOperationState {
  if (raw === null) return initialOperationState();
  const value = JSON.parse(raw) as unknown;
  if (!isObject(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || (value.phase !== "claiming" && value.phase !== "settling" && value.phase !== "blocked")
    || !isObject(value.claims)) {
    throw new Error("Invalid native EVM operation state");
  }
  assertAllowedKeys(
    value,
    [
      "version",
      "revision",
      "phase",
      "claims",
      "claimAttempts",
      "settledClaims",
      "settleAttempt",
      "failedSettleAttempts",
      "blockedReason",
    ],
    "operation state",
  );
  if (!isObject(value.claimAttempts)) throw new Error("Invalid native EVM claim attempts");
  const claims: Record<string, NativeEvmClaimRecord> = {};
  for (const [key, record] of Object.entries(value.claims)) {
    const parsed = parseClaimRecord(record);
    if (key !== channelStateKey(parsed.channelId)) {
      throw new Error("Native EVM claim operation key does not match its channel");
    }
    claims[key] = parsed;
  }
  const claimAttempts: Record<string, NativeEvmClaimAttempt> = {};
  for (const [key, attempt] of Object.entries(value.claimAttempts)) {
    const parsed = parseClaimAttempt(attempt);
    if (key !== channelStateKey(parsed.channelId)) {
      throw new Error("Native EVM claim attempt key does not match its channel");
    }
    claimAttempts[key] = parsed;
  }
  const settledClaims: Record<string, NativeEvmClaimRecord> = {};
  if (value.settledClaims !== undefined) {
    if (!isObject(value.settledClaims)) throw new Error("Invalid native EVM settled claim watermarks");
    for (const [key, record] of Object.entries(value.settledClaims)) {
      const parsed = parseClaimRecord(record);
      if (key !== channelStateKey(parsed.channelId)) {
        throw new Error("Native EVM settled claim key does not match its channel");
      }
      settledClaims[key] = parsed;
    }
    if (Object.keys(settledClaims).length === 0) {
      throw new Error("Invalid native EVM empty settled claim watermarks");
    }
  }
  let settleAttempt: NativeEvmActiveSettleAttempt | undefined;
  if (value.settleAttempt !== undefined) {
    settleAttempt = parseSettleAttempt(value.settleAttempt, false);
  }
  const failedSettleAttempts: Record<string, NativeEvmFailedSettleAttempt> = {};
  if (value.failedSettleAttempts !== undefined) {
    if (!isObject(value.failedSettleAttempts)) {
      throw new Error("Invalid native EVM failed settle attempt history");
    }
    for (const [operationId, attempt] of Object.entries(value.failedSettleAttempts)) {
      const parsed = parseSettleAttempt(attempt, true);
      if (operationId !== parsed.operationId) {
        throw new Error("Native EVM failed settle attempt key does not match its operation");
      }
      failedSettleAttempts[operationId] = parsed;
    }
    if (Object.keys(failedSettleAttempts).length === 0) {
      throw new Error("Invalid native EVM empty failed settle attempt history");
    }
  }
  let blockedReason: string | undefined;
  if (value.blockedReason !== undefined) {
    if (typeof value.blockedReason !== "string" || !value.blockedReason.trim()) {
      throw new Error("Invalid native EVM blocked reason");
    }
    blockedReason = value.blockedReason;
  }
  if ((value.phase === "blocked") !== (blockedReason !== undefined)) {
    throw new Error("Invalid native EVM blocked phase provenance");
  }
  const claimOwners = Object.values(claimAttempts);
  for (const [key, owner] of Object.entries(claimAttempts)) {
    const pending = claims[key];
    const settled = settledClaims[key];
    if ((pending && compareWei(owner.claimedAmountWei, pending.claimedAmountWei) <= 0)
      || (settled && compareWei(owner.claimedAmountWei, settled.claimedAmountWei) <= 0)) {
      throw new Error("Invalid native EVM claim owner cumulative watermark");
    }
  }
  if (value.phase === "settling" && claimOwners.length > 0) {
    throw new Error("Invalid native EVM settlement state with claim owners");
  }
  if (value.phase === "blocked") {
    if (settleAttempt || !claimOwners.some((attempt) => attempt.status === "blocked")) {
      throw new Error("Invalid native EVM blocked operation state");
    }
  } else if (claimOwners.some((attempt) => attempt.status === "blocked")) {
    throw new Error("Invalid native EVM blocked claim owner outside blocked phase");
  }
  if (value.phase === "settling" && Object.keys(claims).length === 0) {
    throw new Error("Invalid native EVM settling state without claims");
  }
  if (settleAttempt) {
    if (value.phase !== "settling" || claimOwners.length > 0) {
      throw new Error("Invalid native EVM active settlement phase");
    }
    if (settleAttempt.claims.length !== Object.keys(claims).length
      || settleAttempt.claims.some((claim) => {
        const durable = claims[channelStateKey(claim.channelId)];
        return !durable || !sameClaimRecord(durable, claim);
      })) {
      throw new Error("Invalid native EVM settlement claim provenance");
    }
    if (failedSettleAttempts[settleAttempt.operationId]) {
      throw new Error("Invalid native EVM active settlement with terminal history");
    }
  }
  for (const [key, pending] of Object.entries(claims)) {
    const settled = settledClaims[key];
    if (settled && compareWei(pending.claimedAmountWei, settled.claimedAmountWei) <= 0) {
      throw new Error("Invalid native EVM pending claim watermark");
    }
  }
  for (const failed of Object.values(failedSettleAttempts)) {
    for (const failedClaim of failed.claims) {
      const key = channelStateKey(failedClaim.channelId);
      const candidates = value.phase === "settling"
        ? [claims[key], settledClaims[key]]
        : [settledClaims[key]];
      const validCandidates = candidates.filter(
        (candidate): candidate is NativeEvmClaimRecord => Boolean(candidate),
      );
      const hasExactProvenance = validCandidates.some(
        (candidate) => sameClaimRecord(candidate, failedClaim),
      );
      const hasLaterWatermark = validCandidates.some(
        (candidate) => compareWei(candidate.claimedAmountWei, failedClaim.claimedAmountWei) > 0,
      );
      if (!hasExactProvenance && !hasLaterWatermark) {
        throw new Error("Invalid native EVM failed settlement claim provenance");
      }
    }
  }
  return {
    version: 1,
    revision: Number(value.revision),
    phase: value.phase,
    claims,
    claimAttempts,
    ...(Object.keys(settledClaims).length > 0 ? { settledClaims } : {}),
    ...(settleAttempt ? { settleAttempt } : {}),
    ...(Object.keys(failedSettleAttempts).length > 0 ? { failedSettleAttempts } : {}),
    ...(blockedReason ? { blockedReason } : {}),
  };
}

const COMPARE_AND_SET_OPERATION_STATE_SCRIPT = `
  local current = redis.call("GET", KEYS[1])
  if ARGV[1] == "absent" then
    if current then return 0 end
  else
    if not current or current ~= ARGV[2] then return 0 end
  end
  local next = cjson.decode(ARGV[3])
  if tonumber(next.revision) ~= tonumber(ARGV[4]) then
    error("native EVM operation state revision must advance by one")
  end
  redis.call("SET", KEYS[1], ARGV[3])
  return 1
`;

export class ValkeyNativeEvmOperationStore implements NativeEvmOperationStore {
  constructor(
    private readonly keyPrefix = "x402:batch-settlement:evm:native-operation",
  ) { }

  private key(network: EvmNetworkId): string {
    return `${this.keyPrefix}:${network}`;
  }

  async load(network: EvmNetworkId): Promise<NativeEvmOperationSnapshot> {
    const valkey = await getValkeyClient();
    const persisted = await valkey.get(this.key(network));
    return { state: parseOperationState(persisted), persisted };
  }

  async compareAndSet(
    network: EvmNetworkId,
    expected: NativeEvmOperationSnapshot,
    next: NativeEvmOperationState,
  ): Promise<boolean> {
    const validatedExpected = parseOperationState(expected.persisted);
    if (JSON.stringify(validatedExpected) !== JSON.stringify(expected.state)) {
      throw new Error("Invalid native EVM operation snapshot");
    }
    const validatedNext = parseOperationState(JSON.stringify(next));
    if (validatedNext.revision !== expected.state.revision + 1) {
      throw new Error("Invalid native EVM operation state revision transition");
    }
    const serializedNext = JSON.stringify(validatedNext);
    const valkey = await getValkeyClient();
    const result = await valkey.eval(
      COMPARE_AND_SET_OPERATION_STATE_SCRIPT,
      1,
      this.key(network),
      expected.persisted === null ? "absent" : "present",
      expected.persisted || "",
      serializedNext,
      String(validatedNext.revision),
    );
    return Number(result) === 1;
  }
}

async function mutateOperationState(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  transition: (current: NativeEvmOperationState) => NativeEvmOperationState | null,
): Promise<NativeEvmOperationState> {
  for (let attempt = 0; attempt < MAX_STATE_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = await store.load(network);
    const current = snapshot.state;
    const proposed = transition(structuredClone(current));
    if (!proposed) return current;
    const next = parseOperationState(JSON.stringify({
      ...proposed,
      version: 1 as const,
      revision: current.revision + 1,
    }));
    if (await store.compareAndSet(network, snapshot, next)) return next;
  }
  throw new Error(`Native EVM operation state remained contended for ${network}`);
}

async function acquireClaimAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  attempt: NativeEvmClaimAttempt,
): Promise<NativeEvmOperationState> {
  const normalized: NativeEvmClaimAttempt = {
    ...attempt,
    claimedAmountWei: canonicalWei(attempt.claimedAmountWei),
  };
  return mutateOperationState(store, network, (state) => {
    if (state.phase !== "claiming" || state.settleAttempt) return null;
    const key = channelStateKey(normalized.channelId);
    if (state.claimAttempts[key]) return null;
    const pending = state.claims[key];
    const settled = state.settledClaims?.[key];
    const persisted = !pending
      ? settled
      : !settled || compareWei(pending.claimedAmountWei, settled.claimedAmountWei) >= 0
        ? pending
        : settled;
    if (persisted && compareWei(persisted.claimedAmountWei, normalized.claimedAmountWei) >= 0) {
      return null;
    }
    state.claimAttempts[key] = normalized;
    return state;
  });
}

async function confirmClaimAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  operationId: string,
  record: NativeEvmClaimRecord,
): Promise<NativeEvmOperationState> {
  const normalized: NativeEvmClaimRecord = {
    ...record,
    claimedAmountWei: canonicalWei(record.claimedAmountWei),
  };
  return mutateOperationState(store, network, (state) => {
    if (state.settleAttempt) throw new Error("Cannot confirm a claim while settlement reconciliation is pending");
    const key = channelStateKey(normalized.channelId);
    const attempt = state.claimAttempts[key];
    if (!attempt || attempt.operationId !== operationId) {
      throw new Error("Native EVM claim attempt ownership changed");
    }
    if (attempt.status !== "prepared") throw new Error(attempt.error || "Native EVM claim attempt is blocked");
    if (attempt.claimedAmountWei !== normalized.claimedAmountWei
      || normalized.claimOperationId !== operationId) {
      throw new Error("Native EVM confirmed claim does not match its durable attempt");
    }
    const pending = state.claims[key];
    const settled = state.settledClaims?.[key];
    if ((pending && compareWei(pending.claimedAmountWei, normalized.claimedAmountWei) >= 0)
      || (settled && compareWei(settled.claimedAmountWei, normalized.claimedAmountWei) >= 0)) {
      throw new Error("Native EVM claim attempt conflicts with an existing durable watermark");
    }
    state.claims[key] = normalized;
    delete state.claimAttempts[key];
    return state;
  });
}

async function releaseClaimAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  channelId: string,
  operationId: string,
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    const key = channelStateKey(channelId);
    const attempt = state.claimAttempts[key];
    if (!attempt) return null;
    if (attempt.operationId !== operationId) {
      throw new Error("Native EVM claim attempt ownership changed");
    }
    if (attempt.status === "blocked") throw new Error(attempt.error || "Native EVM claim attempt is blocked");
    delete state.claimAttempts[key];
    return state;
  });
}

async function blockClaimAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  channelId: string,
  operationId: string,
  reason: string,
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    const key = channelStateKey(channelId);
    const attempt = state.claimAttempts[key];
    if (!attempt || attempt.operationId !== operationId) {
      throw new Error("Native EVM claim attempt ownership changed");
    }
    state.claimAttempts[key] = { ...attempt, status: "blocked", error: reason };
    state.phase = "blocked";
    state.blockedReason = reason;
    return state;
  });
}

async function setOperationPhase(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  phase: "claiming" | "settling",
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    if (state.phase === phase) return null;
    if (state.phase === "blocked") return null;
    if (state.settleAttempt) throw new Error("Cannot change native EVM phase while settlement is pending");
    if (phase === "settling" && Object.keys(state.claimAttempts).length > 0) return null;
    state.phase = phase;
    return state;
  });
}

async function beginSettleAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  attempt: NativeEvmActiveSettleAttempt,
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    if (state.phase !== "settling") throw new Error("Native EVM settlement began outside settling phase");
    if (state.settleAttempt) return null;
    if (state.failedSettleAttempts?.[attempt.operationId]) {
      throw new Error("Native EVM settlement operation ID already has terminal failure provenance");
    }
    if (Object.keys(state.claimAttempts).length > 0) {
      throw new Error("Native EVM settlement cannot begin while claim attempts are pending");
    }
    if (Object.keys(state.claims).length === 0) throw new Error("Native EVM settlement has no durable claims");
    state.settleAttempt = {
      ...attempt,
      claims: Object.values(state.claims)
        .sort((left, right) => channelStateKey(left.channelId).localeCompare(channelStateKey(right.channelId))),
    };
    return state;
  });
}

async function updateSettleAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  operationId: string,
  update: (attempt: NativeEvmActiveSettleAttempt) => NativeEvmActiveSettleAttempt,
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    if (!state.settleAttempt || state.settleAttempt.operationId !== operationId) {
      throw new Error("Native EVM settle attempt ownership changed");
    }
    state.settleAttempt = update(state.settleAttempt);
    return state;
  });
}

async function clearRejectedSettleAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  operationId: string,
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    if (!state.settleAttempt || state.settleAttempt.operationId !== operationId) {
      throw new Error("Native EVM settle attempt ownership changed");
    }
    if (state.settleAttempt.status !== "prepared") {
      throw new Error("Native EVM submitted settlement cannot be cleared as pre-broadcast rejection");
    }
    delete state.settleAttempt;
    state.phase = "settling";
    return state;
  });
}

async function archiveFailedSettleAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  operationId: string,
  txHash: string,
  error: string,
  failedAt: number,
): Promise<NativeEvmOperationState> {
  const canonicalHash = canonicalTransactionHash(txHash, "failed settlement");
  if (!operationId || !error.trim()
    || !Number.isSafeInteger(failedAt) || failedAt <= 0) {
    throw new Error("Native EVM failed settlement provenance is incomplete");
  }
  return mutateOperationState(store, network, (state) => {
    const existing = state.failedSettleAttempts?.[operationId];
    if (!state.settleAttempt) {
      if (existing?.txHash === canonicalHash && existing.error === error) return null;
      throw new Error("Native EVM settle attempt ownership changed");
    }
    if (state.settleAttempt.operationId !== operationId) {
      throw new Error("Native EVM settle attempt ownership changed");
    }
    if (state.settleAttempt.status !== "submitted"
      || state.settleAttempt.txHash !== canonicalHash
      || !state.settleAttempt.submittedAt) {
      throw new Error("Native EVM failed settlement has no submitted transaction provenance");
    }
    if (existing) {
      throw new Error("Native EVM settlement operation ID already has terminal failure provenance");
    }
    if (state.settleAttempt.claims.length === 0) {
      throw new Error("Native EVM failed settlement has no durable claims");
    }
    const failed: NativeEvmFailedSettleAttempt = {
      ...state.settleAttempt,
      status: "failed",
      txHash: canonicalHash,
      submittedAt: state.settleAttempt.submittedAt,
      error,
      failedAt,
    };
    state.failedSettleAttempts = {
      ...(state.failedSettleAttempts || {}),
      [operationId]: failed,
    };
    delete state.settleAttempt;
    state.phase = "settling";
    return state;
  });
}

async function completeSettleAttempt(
  store: NativeEvmOperationStore,
  network: EvmNetworkId,
  operationId: string,
): Promise<NativeEvmOperationState> {
  return mutateOperationState(store, network, (state) => {
    const attempt = state.settleAttempt;
    if (!attempt || attempt.operationId !== operationId) {
      throw new Error("Native EVM settle attempt ownership changed");
    }
    if (attempt.status !== "submitted" || !attempt.txHash || !attempt.submittedAt) {
      throw new Error("Native EVM settlement cannot complete before durable submission");
    }
    for (const claimed of attempt.claims) {
      const key = channelStateKey(claimed.channelId);
      const current = state.claims[key];
      if (!current) continue;
      if (current.claimedAmountWei === claimed.claimedAmountWei
        && current.claimTxHash === claimed.claimTxHash
        && current.claimOperationId === claimed.claimOperationId) {
        const settled = state.settledClaims?.[key];
        if (!settled || compareWei(claimed.claimedAmountWei, settled.claimedAmountWei) > 0) {
          state.settledClaims = { ...(state.settledClaims || {}), [key]: claimed };
        }
        delete state.claims[key];
      } else if (compareWei(current.claimedAmountWei, claimed.claimedAmountWei) < 0) {
        throw new Error("Native EVM durable claim regressed during settlement completion");
      }
    }
    delete state.settleAttempt;
    state.phase = Object.keys(state.claims).length > 0 ? "settling" : "claiming";
    return state;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSettlementExecutionResult(value: unknown): SettlementExecutionResult {
  if (!isObject(value)
    || (value.status !== "confirmed"
      && value.status !== "rejected"
      && value.status !== "submitted"
      && value.status !== "ambiguous")) {
    throw new Error("Invalid native EVM settlement execution result");
  }
  assertAllowedKeys(value, ["status", "txHash", "error"], "settlement execution result");
  if (value.status === "confirmed") {
    if (value.error !== undefined) {
      throw new Error("Invalid native EVM confirmed settlement result");
    }
    return {
      status: "confirmed",
      txHash: canonicalTransactionHash(value.txHash, "confirmed settlement"),
    };
  }
  if (value.status === "rejected") {
    if (typeof value.error !== "string" || !value.error.trim()) {
      throw new Error("Invalid native EVM rejected settlement result");
    }
    return {
      status: "rejected",
      error: value.error,
      ...(value.txHash !== undefined
        ? { txHash: canonicalTransactionHash(value.txHash, "rejected settlement") }
        : {}),
    };
  }
  if (value.error !== undefined && (typeof value.error !== "string" || !value.error.trim())) {
    throw new Error("Invalid native EVM pending settlement result");
  }
  if (value.status === "submitted") {
    return {
      status: "submitted",
      txHash: canonicalTransactionHash(value.txHash, "submitted settlement"),
      ...(value.error !== undefined ? { error: String(value.error) } : {}),
    };
  }
  if (value.txHash === undefined && value.error === undefined) {
    throw new Error("Invalid native EVM ambiguous settlement result");
  }
  return {
    status: "ambiguous",
    ...(value.txHash !== undefined
      ? { txHash: canonicalTransactionHash(value.txHash, "ambiguous settlement") }
      : {}),
    ...(value.error !== undefined ? { error: String(value.error) } : {}),
  };
}

function parseSettlementReconciliationResult(value: unknown): SettlementReconciliationResult {
  if (!isObject(value)
    || (value.status !== "confirmed" && value.status !== "failed" && value.status !== "pending")) {
    throw new Error("Invalid native EVM settlement reconciliation result");
  }
  assertAllowedKeys(value, ["status", "txHash", "error"], "settlement reconciliation result");
  if (value.status === "confirmed") {
    if (value.error !== undefined) {
      throw new Error("Invalid native EVM confirmed settlement reconciliation");
    }
    return {
      status: "confirmed",
      ...(value.txHash !== undefined
        ? { txHash: canonicalTransactionHash(value.txHash, "reconciled settlement") }
        : {}),
    };
  }
  if (value.status === "failed") {
    if (value.txHash !== undefined || typeof value.error !== "string" || !value.error.trim()) {
      throw new Error("Invalid native EVM failed settlement reconciliation");
    }
    return { status: "failed", error: value.error };
  }
  if (value.txHash !== undefined
    || (value.error !== undefined && (typeof value.error !== "string" || !value.error.trim()))) {
    throw new Error("Invalid native EVM pending settlement reconciliation");
  }
  return {
    status: "pending",
    ...(value.error !== undefined ? { error: String(value.error) } : {}),
  };
}

async function projectClaim(
  dependencies: NativeEvmBatchSettlementDependencies,
  network: EvmNetworkId,
  claim: NativeEvmClaimRecord,
): Promise<{ receipts: number; evidence: number }> {
  const input = {
    channelId: claim.channelId,
    claimedAmountWei: claim.claimedAmountWei,
    network,
    claimTxHash: claim.claimTxHash,
  };
  return {
    receipts: await dependencies.markBatchReceiptsSettled(input),
    evidence: await dependencies.markBatchEvidenceSettled(input),
  };
}

async function projectSettlement(
  dependencies: NativeEvmBatchSettlementDependencies,
  network: EvmNetworkId,
  claims: NativeEvmClaimRecord[],
  settleTxHash: string,
): Promise<{ receipts: number; evidence: number }> {
  let receipts = 0;
  let evidence = 0;
  for (const claim of claims) {
    const input = {
      channelId: claim.channelId,
      claimedAmountWei: claim.claimedAmountWei,
      network,
      claimTxHash: claim.claimTxHash,
      settleTxHash,
    };
    receipts += await dependencies.markBatchReceiptsSettled(input);
    evidence += await dependencies.markBatchEvidenceSettled(input);
  }
  return { receipts, evidence };
}

function claimFromPayload(
  paymentPayload: unknown,
  network: EvmNetworkId,
): { channelId: string; claimedAmountWei: string; vouchers: number } {
  if (!isObject(paymentPayload) || !isObject(paymentPayload.payload)) {
    throw new Error("Native EVM claim payload is missing");
  }
  const payload = paymentPayload.payload;
  if (payload.type !== "claim" || !Array.isArray(payload.claims) || payload.claims.length !== 1) {
    throw new Error("Native EVM durable claims require exactly one voucher per manager operation");
  }
  const claim = payload.claims[0];
  if (!isObject(claim)
    || typeof claim.totalClaimed !== "string"
    || !isObject(claim.voucher)
    || !isObject(claim.voucher.channel)) {
    throw new Error("Native EVM claim payload has no cumulative amount");
  }
  return {
    channelId: computeChannelId(claim.voucher.channel as never, network),
    claimedAmountWei: canonicalWei(claim.totalClaimed),
    vouchers: 1,
  };
}

function productionClaimManager(input: {
  network: EvmNetworkId;
  onConfirmedClaim(observation: ConfirmedClaimObservation): Promise<void>;
}): NativeEvmClaimManager {
  const base = facilitatorClient();
  const observed: FacilitatorClient = {
    verify: (paymentPayload, paymentRequirements) => base.verify(paymentPayload, paymentRequirements),
    getSupported: () => base.getSupported(),
    settle: async (paymentPayload, paymentRequirements) => {
      const parsed = claimFromPayload(paymentPayload, input.network);
      let response: Awaited<ReturnType<FacilitatorClient["settle"]>>;
      try {
        response = await base.settle(paymentPayload, paymentRequirements);
      } catch (error) {
        throw new AmbiguousClaimFailure(
          `Native EVM claim response became ambiguous: ${errorMessage(error)}`,
        );
      }
      if (!response.success) {
        const reason = response.errorReason || "unknown";
        const message = response.errorMessage || "";
        if (reason === CLAIM_TRANSACTION_FAILED && !response.transaction) {
          throw new AmbiguousClaimFailure(
            `Native EVM claim may have been broadcast without a recoverable transaction identity: ${message}`,
          );
        }
        throw new DefinitiveClaimFailure(`Claim failed: ${reason} — ${message}`);
      }
      if (!response.transaction) throw new Error("Confirmed native EVM claim has no transaction hash");
      await input.onConfirmedClaim({
        ...parsed,
        claimTxHash: response.transaction,
      });
      return response;
    },
  };
  const asset = getBatchAsset(input.network);
  return new BatchSettlementChannelManager({
    scheme: serverScheme(),
    facilitator: observed,
    receiver: merchantWalletAddress,
    token: asset.address,
    network: input.network,
  }) as unknown as NativeEvmClaimManager;
}

function batchRequirements(network: EvmNetworkId) {
  const asset = getBatchAsset(network);
  return {
    scheme: "batch-settlement" as const,
    network,
    asset: asset.address,
    amount: "0",
    payTo: merchantWalletAddress,
    maxTimeoutSeconds: 0,
    extra: {},
  };
}

async function executeProductionSettlement(input: {
  network: EvmNetworkId;
}): Promise<SettlementExecutionResult> {
  const requirements = batchRequirements(input.network);
  let response: Awaited<ReturnType<FacilitatorClient["settle"]>>;
  try {
    response = await facilitatorClient().settle({
      x402Version: 2,
      accepted: requirements,
      payload: {
        type: "settle",
        receiver: merchantWalletAddress,
        token: requirements.asset,
      },
    }, requirements);
  } catch (error) {
    return { status: "ambiguous", error: errorMessage(error) };
  }
  if (response.success) {
    return response.transaction
      ? { status: "confirmed", txHash: response.transaction }
      : { status: "ambiguous", error: "Confirmed native EVM settlement has no transaction hash" };
  }
  const reason = response.errorReason || "unknown";
  const message = `${reason}${response.errorMessage ? ` — ${response.errorMessage}` : ""}`;
  if (reason === SETTLE_SIMULATION_FAILED || reason === RPC_READ_FAILED) {
    return { status: "rejected", error: message };
  }
  if (reason === SETTLE_TRANSACTION_FAILED && response.transaction) {
    return { status: "rejected", error: message, txHash: response.transaction };
  }
  if (reason === NOTHING_TO_SETTLE) {
    return { status: "ambiguous", error: `${message}; the confirming transaction identity is unavailable` };
  }
  return {
    status: "ambiguous",
    ...(response.transaction ? { txHash: response.transaction } : {}),
    error: message,
  };
}

async function reconcileProductionSettlement(input: {
  network: EvmNetworkId;
  txHash: string;
}): Promise<SettlementReconciliationResult> {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(input.txHash)) {
    return { status: "pending", error: "Persisted native EVM settlement hash is malformed" };
  }
  const publicClient = createPublicClient({
    chain: getViemChain(input.network),
    transport: http(getNetworkRpcUrl(input.network)),
  });
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: input.txHash as Hex });
    return receipt.status === "success"
      ? { status: "confirmed", txHash: input.txHash }
      : { status: "failed", error: `Native EVM settlement ${input.txHash} reverted` };
  } catch (error) {
    return { status: "pending", error: errorMessage(error) };
  }
}

const defaultOperationStore = new ValkeyNativeEvmOperationStore();

function defaultDependencies(): NativeEvmBatchSettlementDependencies {
  return {
    networks: configuredNetworks,
    claimBacking: (network) => ({
      asset: getBatchAsset(network).address,
      receiver: merchantWalletAddress,
    }),
    store: defaultOperationStore,
    createClaimManager: productionClaimManager,
    executeSettlement: executeProductionSettlement,
    reconcileSettlement: reconcileProductionSettlement,
    markBatchReceiptsSettled,
    markBatchEvidenceSettled,
    now: Date.now,
    createOperationId: () => randomUUID(),
    idleSecs: Number.parseInt(process.env.BATCH_SETTLEMENT_IDLE_SECONDS || "0", 10) || 0,
    isDefinitiveClaimFailure: (error) => error instanceof DefinitiveClaimFailure,
  };
}

async function settleConfirmedAttempt(
  network: EvmNetworkId,
  attempt: NativeEvmActiveSettleAttempt,
  settleTxHash: string,
  dependencies: NativeEvmBatchSettlementDependencies,
): Promise<{ receipts: number; evidence: number }> {
  const canonicalHash = canonicalTransactionHash(settleTxHash, "confirmed settlement");
  if (attempt.status !== "submitted" || attempt.txHash !== canonicalHash || !attempt.submittedAt) {
    throw new Error("Confirmed native EVM settlement lacks durable submitted provenance");
  }
  const projected = await projectSettlement(dependencies, network, attempt.claims, canonicalHash);
  await completeSettleAttempt(dependencies.store, network, attempt.operationId);
  return projected;
}

async function reconcileExistingAttempt(
  network: EvmNetworkId,
  attempt: NativeEvmActiveSettleAttempt,
  dependencies: NativeEvmBatchSettlementDependencies,
  result: ChainResult,
): Promise<ChainResult> {
  if (attempt.status === "prepared") {
    const error = `${UNIDENTIFIED_SETTLE_LIMITATION}; a prepared operation survived without an identity`;
    await updateSettleAttempt(dependencies.store, network, attempt.operationId, (current) => ({
      ...current,
      status: "blocked",
      error,
    }));
    return { ...result, error };
  }
  if (attempt.status === "blocked" || !attempt.txHash) {
    return { ...result, error: attempt.error || UNIDENTIFIED_SETTLE_LIMITATION };
  }

  let reconciliation: SettlementReconciliationResult;
  try {
    reconciliation = parseSettlementReconciliationResult(await dependencies.reconcileSettlement({
      network,
      operationId: attempt.operationId,
      txHash: attempt.txHash,
    }));
  } catch (error) {
    return { ...result, error: errorMessage(error) };
  }
  if (reconciliation.status === "pending") {
    if (reconciliation.error) {
      await updateSettleAttempt(dependencies.store, network, attempt.operationId, (current) => ({
        ...current,
        error: reconciliation.error,
      }));
    }
    return { ...result, error: reconciliation.error || "Native EVM settlement confirmation is pending" };
  }
  if (reconciliation.status === "failed") {
    await archiveFailedSettleAttempt(
      dependencies.store,
      network,
      attempt.operationId,
      attempt.txHash,
      reconciliation.error,
      positiveTimestamp(dependencies.now(), "settlement failure"),
    );
    return { ...result, error: reconciliation.error };
  }
  const confirmedHash = canonicalTransactionHash(
    reconciliation.txHash || attempt.txHash,
    "reconciled settlement",
  );
  if (confirmedHash !== attempt.txHash) {
    const error = "Native EVM settlement reconciliation changed the persisted transaction identity";
    await updateSettleAttempt(dependencies.store, network, attempt.operationId, (current) => ({
      ...current,
      status: "blocked",
      error,
    }));
    return { ...result, error };
  }
  const projected = await settleConfirmedAttempt(network, attempt, confirmedHash, dependencies);
  return {
    ...result,
    settleTxHash: confirmedHash,
    reconciledReceipts: (result.reconciledReceipts || 0) + projected.receipts,
    reconciledEvidence: (result.reconciledEvidence || 0) + projected.evidence,
  };
}

function sameEvmAddress(left: unknown, right: unknown): boolean {
  return typeof left === "string"
    && typeof right === "string"
    && left.length > 0
    && right.length > 0
    && left.toLowerCase() === right.toLowerCase();
}

function hasExactClaimBacking(
  channel: NativeEvmClaimChannel,
  network: EvmNetworkId,
  backing: { asset: string; receiver: string },
): boolean {
  return channel.network === network
    && sameEvmAddress(channel.asset, backing.asset)
    && sameEvmAddress(channel.receiver, backing.receiver)
    && sameEvmAddress(channel.channelConfig?.token, backing.asset)
    && sameEvmAddress(channel.channelConfig?.receiver, backing.receiver);
}

async function settleChain(
  network: EvmNetworkId,
  dependencies: NativeEvmBatchSettlementDependencies,
): Promise<ChainResult> {
  let result: ChainResult = {
    network,
    claimCount: 0,
    claimTxHashes: [],
    reconciledReceipts: 0,
    reconciledEvidence: 0,
  };

  let state = (await dependencies.store.load(network)).state;
  for (const claim of Object.values(state.claims)) {
    const projected = await projectClaim(dependencies, network, claim);
    result.reconciledReceipts = (result.reconciledReceipts || 0) + projected.receipts;
    result.reconciledEvidence = (result.reconciledEvidence || 0) + projected.evidence;
  }
  state = (await dependencies.store.load(network)).state;
  if (state.phase === "blocked") {
    return { ...result, error: state.blockedReason || "Native EVM operations are blocked" };
  }
  if (state.settleAttempt) {
    return reconcileExistingAttempt(network, state.settleAttempt, dependencies, result);
  }

  if (state.phase === "claiming") {
    const backing = dependencies.claimBacking(network);
    if (!backing.asset || !backing.receiver) {
      throw new Error(`Native EVM claim backing is incomplete for ${network}`);
    }
    let selectedSnapshot: NativeEvmClaimChannel | undefined;
    let selectedAttempt: NativeEvmClaimAttempt | undefined;
    let confirmedThisCall: NativeEvmClaimRecord | undefined;
    const attempted = new Set<string>();
    const manager = dependencies.createClaimManager({
      network,
      onConfirmedClaim: async (observation) => {
        if (!selectedSnapshot || !selectedAttempt) {
          throw new Error("Native EVM manager confirmed a claim without an owned channel attempt");
        }
        if (observation.vouchers !== 1) throw new Error("Native EVM durable claim operation included multiple vouchers");
        if (channelStateKey(observation.channelId) !== channelStateKey(selectedSnapshot.channelId)) {
          throw new Error("Native EVM manager claimed a different channel than its selected snapshot");
        }
        if (canonicalWei(observation.claimedAmountWei)
          !== canonicalWei(selectedSnapshot.chargedCumulativeAmount)) {
          throw new Error("Native EVM manager claim cumulative differs from its selected snapshot");
        }
        const claimTxHash = canonicalTransactionHash(observation.claimTxHash, "confirmed claim");
        const claim: NativeEvmClaimRecord = {
          channelId: selectedSnapshot.channelId,
          claimedAmountWei: canonicalWei(observation.claimedAmountWei),
          claimTxHash,
          claimOperationId: selectedAttempt.operationId,
          confirmedAt: positiveTimestamp(dependencies.now(), "claim confirmation"),
        };
        await confirmClaimAttempt(
          dependencies.store,
          network,
          selectedAttempt.operationId,
          claim,
        );
        confirmedThisCall = claim;
      },
    });

    for (let operation = 0; operation < MAX_CLAIM_OPERATIONS_PER_RUN; operation += 1) {
      const selectionNow = dependencies.now();
      selectedSnapshot = undefined;
      selectedAttempt = undefined;
      confirmedThisCall = undefined;
      try {
        const claims = await manager.claim({
          maxClaimsPerBatch: 1,
          idleSecs: dependencies.idleSecs,
          selectClaimChannels: async (channels) => {
            for (const candidate of channels) {
              const key = channelStateKey(candidate.channelId);
              if (attempted.has(key)) continue;
              if (!hasExactClaimBacking(candidate, network, backing)) continue;
              if (compareWei(candidate.chargedCumulativeAmount, candidate.totalClaimed) <= 0) continue;
              if (dependencies.idleSecs > 0
                && selectionNow - candidate.lastRequestTimestamp < dependencies.idleSecs * 1_000) continue;
              const snapshot: NativeEvmClaimChannel = {
                channelId: candidate.channelId,
                chargedCumulativeAmount: canonicalWei(candidate.chargedCumulativeAmount),
                totalClaimed: canonicalWei(candidate.totalClaimed),
                lastRequestTimestamp: candidate.lastRequestTimestamp,
                network: candidate.network,
                asset: candidate.asset,
                receiver: candidate.receiver,
                channelConfig: {
                  token: candidate.channelConfig.token,
                  receiver: candidate.channelConfig.receiver,
                },
              };
              const claimAttempt: NativeEvmClaimAttempt = {
                operationId: dependencies.createOperationId(),
                status: "prepared",
                channelId: snapshot.channelId,
                claimedAmountWei: snapshot.chargedCumulativeAmount,
                preparedAt: positiveTimestamp(dependencies.now(), "claim preparation"),
              };
              const acquired = await acquireClaimAttempt(
                dependencies.store,
                network,
                claimAttempt,
              );
              if (acquired.claimAttempts[key]?.operationId !== claimAttempt.operationId) continue;
              attempted.add(key);
              selectedSnapshot = snapshot;
              selectedAttempt = claimAttempt;
              return [candidate];
            }
            return [];
          },
        });
        const selected = selectedSnapshot as NativeEvmClaimChannel | undefined;
        const confirmed = confirmedThisCall as NativeEvmClaimRecord | undefined;
        if (!selected && claims.length === 0) break;
        if (!selected || claims.length !== 1 || claims[0].vouchers !== 1) {
          throw new Error("Native EVM manager returned a claim result that does not match its one-channel selection");
        }
        if (!confirmed || claims[0].transaction !== confirmed.claimTxHash) {
          throw new Error("Native EVM manager result does not match durable per-channel claim provenance");
        }
        const projected = await projectClaim(dependencies, network, confirmed);
        result.reconciledReceipts = (result.reconciledReceipts || 0) + projected.receipts;
        result.reconciledEvidence = (result.reconciledEvidence || 0) + projected.evidence;
        result.claimCount += claims[0].vouchers;
        result.claimTxHashes.push(claims[0].transaction);
      } catch (error) {
        const selected = selectedSnapshot as NativeEvmClaimChannel | undefined;
        const ownedAttempt = selectedAttempt as NativeEvmClaimAttempt | undefined;
        const confirmed = confirmedThisCall as NativeEvmClaimRecord | undefined;
        if (confirmed) {
          if (!result.claimTxHashes.includes(confirmed.claimTxHash)) {
            result.claimCount += 1;
            result.claimTxHashes.push(confirmed.claimTxHash);
          }
          return { ...result, error: errorMessage(error) };
        }
        if (!selected || !ownedAttempt) return { ...result, error: errorMessage(error) };
        const reason = errorMessage(error);
        if (dependencies.isDefinitiveClaimFailure(error)) {
          await releaseClaimAttempt(
            dependencies.store,
            network,
            selected.channelId,
            ownedAttempt.operationId,
          );
          return { ...result, error: reason };
        }
        await blockClaimAttempt(
          dependencies.store,
          network,
          selected.channelId,
          ownedAttempt.operationId,
          reason,
        );
        return { ...result, error: reason };
      }
      if (operation === MAX_CLAIM_OPERATIONS_PER_RUN - 1) {
        return { ...result, error: "Native EVM claim operation safety limit reached before settlement" };
      }
    }

    state = (await dependencies.store.load(network)).state;
    if (Object.keys(state.claimAttempts).length > 0) {
      return {
        ...result,
        error: "A durable claim attempt still owns its channel; rebroadcast is blocked until its exact outcome is resolved",
      };
    }
    if (Object.keys(state.claims).length === 0) return result;
    state = await setOperationPhase(dependencies.store, network, "settling");
  }

  if (state.phase !== "settling") return result;
  const pendingClaims = Object.values(state.claims)
    .sort((left, right) => channelStateKey(left.channelId).localeCompare(channelStateKey(right.channelId)));
  if (pendingClaims.length === 0) {
    await setOperationPhase(dependencies.store, network, "claiming");
    return result;
  }

  const attempt: NativeEvmActiveSettleAttempt = {
    operationId: dependencies.createOperationId(),
    status: "prepared",
    claims: pendingClaims,
    preparedAt: positiveTimestamp(dependencies.now(), "settlement preparation"),
  };
  const begun = await beginSettleAttempt(dependencies.store, network, attempt);
  const activeAttempt = begun.settleAttempt;
  if (!activeAttempt || activeAttempt.operationId !== attempt.operationId) {
    return { ...result, error: "Another native EVM settlement operation already owns reconciliation" };
  }

  let execution: SettlementExecutionResult;
  try {
    execution = parseSettlementExecutionResult(await dependencies.executeSettlement({
      network,
      operationId: activeAttempt.operationId,
      claims: activeAttempt.claims,
    }));
  } catch (error) {
    execution = parseSettlementExecutionResult({ status: "ambiguous", error: errorMessage(error) });
  }
  if (execution.status === "confirmed") {
    const submittedAt = positiveTimestamp(dependencies.now(), "settlement submission");
    const confirmedState = await updateSettleAttempt(
      dependencies.store,
      network,
      activeAttempt.operationId,
      (current) => ({
        ...current,
        status: "submitted",
        txHash: execution.txHash,
        submittedAt,
      }),
    );
    const confirmedAttempt = confirmedState.settleAttempt;
    if (!confirmedAttempt || confirmedAttempt.txHash !== execution.txHash) {
      throw new Error("Confirmed native EVM settlement transaction was not persisted");
    }
    const projected = await settleConfirmedAttempt(
      network,
      confirmedAttempt,
      execution.txHash,
      dependencies,
    );
    return {
      ...result,
      settleTxHash: execution.txHash,
      reconciledReceipts: (result.reconciledReceipts || 0) + projected.receipts,
      reconciledEvidence: (result.reconciledEvidence || 0) + projected.evidence,
    };
  }
  if (execution.status === "rejected") {
    if (execution.txHash) {
      const submittedAt = positiveTimestamp(dependencies.now(), "settlement submission");
      await updateSettleAttempt(
        dependencies.store,
        network,
        activeAttempt.operationId,
        (current) => ({
          ...current,
          status: "submitted",
          txHash: execution.txHash,
          submittedAt,
        }),
      );
      await archiveFailedSettleAttempt(
        dependencies.store,
        network,
        activeAttempt.operationId,
        execution.txHash,
        execution.error,
        positiveTimestamp(dependencies.now(), "settlement failure"),
      );
    } else {
      await clearRejectedSettleAttempt(dependencies.store, network, activeAttempt.operationId);
    }
    return { ...result, error: execution.error };
  }
  if (execution.txHash) {
    const submittedAt = positiveTimestamp(dependencies.now(), "settlement submission");
    await updateSettleAttempt(dependencies.store, network, activeAttempt.operationId, (current) => ({
      ...current,
      status: "submitted",
      txHash: execution.txHash,
      submittedAt,
      ...(execution.error ? { error: execution.error } : {}),
    }));
    return { ...result, error: execution.error || "Native EVM settlement confirmation is pending" };
  }
  const limitation = `${execution.error ? `${execution.error}; ` : ""}${UNIDENTIFIED_SETTLE_LIMITATION}`;
  await updateSettleAttempt(dependencies.store, network, activeAttempt.operationId, (current) => ({
    ...current,
    status: "blocked",
    error: limitation,
  }));
  return { ...result, error: limitation };
}

export async function runNativeBatchSettlement(
  dependencies?: NativeEvmBatchSettlementDependencies,
): Promise<NativeBatchSettlementSummary> {
  const resolved = dependencies || defaultDependencies();
  const startedAt = resolved.now();
  const runId = `native-batch-${startedAt}`;
  const results: ChainResult[] = [];

  for (const network of resolved.networks()) {
    try {
      results.push(await settleChain(network, resolved));
    } catch (error) {
      results.push({
        network,
        claimCount: 0,
        claimTxHashes: [],
        error: errorMessage(error),
      });
    }
  }

  return {
    runId,
    startedAt,
    finishedAt: resolved.now(),
    chains: results,
  };
}
