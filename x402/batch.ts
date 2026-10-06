import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { RedisChannelStorage as ValkeyChannelStorage } from "@x402/evm/batch-settlement/server/redis-storage";
import {
    address as solanaAddress,
    getBase58Encoder,
    getPublicKeyFromAddress,
    getUtf8Encoder,
    signatureBytes,
    verifySignature,
} from "@solana/kit";
import { createHash, randomUUID } from "node:crypto";
import { KeyType, PublicKey } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { base58 } from "@scure/base";

import {
    getNetwork,
    getNetworkRpcUrl,
    isEvmNetwork,
    isNearNetwork,
    isNetworkId,
    isSolanaNetwork,
    validateNearAddress,
    type EvmNetworkId,
    type NearNetworkId,
    type NetworkId,
    type SolanaNetworkId,
} from "./configs/chains.js";
import {
    broadcastPreparedKeyPaymentForNetwork,
    prepareKeyPaymentForNetwork,
    reconcileKeyPaymentForNetwork,
    type PreparedSettlementTransaction,
    type SettlementPreparationResult,
    type SettlementResult,
} from "./settlement.js";
import { markBatchEvidenceSettled } from "./evidence.js";
import { markBatchReceiptsSettled } from "./receipts.js";
import {
    commitRawBatchCheckpointTransition,
    resolveRawBatchBacking,
} from "./envelope.js";
import {
    getValkeyClient,
    valkeyExpire,
    valkeyHGetAll,
    valkeyHSet,
    valkeySAdd,
    valkeySMembers,
    valkeySRem,
} from "./keys/valkey.js";

const WITHDRAW_DELAY_SECONDS = 900;

type Erc3009DepositAuthorization = {
    erc3009Authorization: {
        validAfter: string;
        validBefore: string;
        salt: `0x${string}`;
        signature: `0x${string}`;
    };
    permit2Authorization?: never;
};

type Permit2DepositAuthorization = {
    erc3009Authorization?: never;
    permit2Authorization: {
        from: `0x${string}`;
        permitted: {
            token: `0x${string}`;
            amount: string;
        };
        spender: `0x${string}`;
        nonce: string;
        deadline: string;
        witness: {
            channelId: `0x${string}`;
        };
        signature: `0x${string}`;
    };
};

type BatchRaw = {
    type: "deposit" | "voucher";
    channelConfig: {
        payer: string;
        payerAuthorizer?: string;
        receiver: string;
        receiverAuthorizer?: string;
        token: string;
        network?: string;
        resource?: string;
        balance?: string;
        withdrawDelay?: number;
        salt: string;
    };
    voucher: {
        channelId: string;
        maxClaimableAmount: string;
        signature: string;
    };
    channelId?: string;
    maxClaimableAmount?: string;
    signature?: string;
    deposit?: {
        amount: string;
        authorization: Erc3009DepositAuthorization | Permit2DepositAuthorization;
    };
};

type StoredChannel = Channel & {
    channelId: string;
    channelConfig: BatchRaw["channelConfig"];
    chargedCumulativeAmount: string;
    signedMaxClaimable: string;
    signature: string;
    balance: string;
    totalClaimed: string;
    withdrawRequestedAt: number;
    refundNonce: number;
    onchainSyncedAt?: number;
    lastRequestTimestamp: number;
    network: NetworkId;
    payer: string;
    asset: string;
    receiver: string;
    resource: string;
    channelConfigFingerprint: string;
    backingFingerprint: string;
};

let storage: ValkeyChannelStorage | null = null;

export type BatchCommit = {
    channelId: string;
    cumulativeAmountWei: string;
};

export type RawBatchCheckpointCommit = BatchCommit & {
    checkpointSequence: number;
    replayed: boolean;
};

type SvmBatchValidation = {
    valid: true;
    payer: string;
    channelId: string;
    maxClaimableAmount: string;
    chargedCumulativeAmount: string;
} | {
    valid: false;
    invalidReason: string;
    payer?: string;
};

export type SvmBatchChannel = {
    channelId: string;
    payer: string;
    network: SolanaNetworkId;
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

export type SvmBatchSettlementAttempt = {
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

export type SvmBatchSettlementWork = {
    channel: SvmBatchChannel;
    attempt: SvmBatchSettlementAttempt;
};

export type SvmBatchSettlementAcquisition =
    | { outcome: "missing" | "settled" }
    | { outcome: "busy" | "failed" | "acquired"; work: SvmBatchSettlementWork };

export interface SvmBatchSettlementStore {
    listPendingChannelIds(): Promise<string[]>;
    acquireAttempt(input: {
        channelId: string;
        ownerToken: string;
        now: number;
        ownerExpiresAt: number;
    }): Promise<SvmBatchSettlementAcquisition>;
    persistPreparedAttempt(input: {
        channelId: string;
        ownerToken: string;
        prepared: PreparedSettlementTransaction;
        preparedAt: number;
    }): Promise<SvmBatchSettlementWork | null>;
    markAttemptSubmitted(input: {
        channelId: string;
        ownerToken: string;
        txHash: string;
        submittedAt: number;
        error?: string;
    }): Promise<SvmBatchSettlementWork | null>;
    releaseAttemptClaim(input: {
        channelId: string;
        ownerToken: string;
        expectedStatus: "prepared" | "submitted";
        checkedAt: number;
        error: string;
    }): Promise<boolean>;
    abandonPreparation(input: {
        channelId: string;
        ownerToken: string;
        error: string;
        abandonedAt: number;
    }): Promise<boolean>;
    markAttemptReconciled(input: {
        channelId: string;
        ownerToken: string;
        kind: "receipts" | "evidence";
        count: number;
        reconciledAt: number;
    }): Promise<SvmBatchSettlementWork | null>;
    markAttemptFailed(input: {
        channelId: string;
        ownerToken: string;
        txHash: string;
        failedAt: number;
        error: string;
    }): Promise<SvmBatchSettlementWork | null>;
    completeConfirmedAttempt(input: {
        channelId: string;
        ownerToken: string;
        txHash: string;
        completedAt: number;
    }): Promise<{ completed: boolean; hasMore: boolean }>;
}

export type SvmBatchSettlementResult = {
    channelId: string;
    payer: string;
    network: SolanaNetworkId;
    settledAmountWei: string;
    claimedAmountWei: string;
    txHash: string;
    reconciledReceipts: number;
    reconciledEvidence: number;
    error?: string;
};

export type SvmBatchSettlementSummary = {
    runId: string;
    startedAt: number;
    finishedAt: number;
    channels: SvmBatchSettlementResult[];
};

export type SvmBatchSettlementDependencies = {
    store: SvmBatchSettlementStore;
    prepareKeyPaymentForNetwork: (
        payer: string,
        amountWei: string,
        network: NetworkId,
    ) => Promise<SettlementPreparationResult>;
    broadcastPreparedKeyPaymentForNetwork: (
        prepared: PreparedSettlementTransaction,
    ) => Promise<SettlementResult>;
    reconcileKeyPaymentForNetwork: (
        txHash: string,
        network: NetworkId,
        options?: { wait?: boolean; userAddress?: string; preparedTxPayload?: string },
    ) => Promise<SettlementResult>;
    markBatchReceiptsSettled: typeof markBatchReceiptsSettled;
    markBatchEvidenceSettled: typeof markBatchEvidenceSettled;
    now: () => number;
    createOwnerToken: () => string;
};

export type EvmBatchDepositStatus = "prepared" | "broadcast" | "submitted" | "confirmed" | "failed";

export type EvmBatchDepositState = {
    key: string;
    status: EvmBatchDepositStatus;
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

export interface EvmBatchDepositStore {
    read(key: string): Promise<EvmBatchDepositState | null>;
    prepare(state: EvmBatchDepositState): Promise<EvmBatchDepositState>;
    claimBroadcast(input: {
        key: string;
        ownerToken: string;
        broadcastAt: number;
    }): Promise<{ acquired: boolean; state: EvmBatchDepositState }>;
    markSubmitted(input: {
        key: string;
        ownerToken: string;
        txHash: string;
        submittedAt: number;
    }): Promise<EvmBatchDepositState>;
    markConfirmed(input: {
        key: string;
        txHash: string;
        confirmedAt: number;
    }): Promise<EvmBatchDepositState>;
    markFailed(input: {
        key: string;
        ownerToken: string;
        txHash?: string;
        error: string;
        failedAt: number;
    }): Promise<EvmBatchDepositState>;
}

export type EvmBatchDepositExecutionResult =
    | { status: "submitted" | "confirmed"; txHash: string }
    | { status: "failed"; terminal: true; error: string; txHash?: string }
    | { status: "unknown"; error: string };

export type EvmBatchDepositDependencies = {
    store: EvmBatchDepositStore;
    broadcastDeposit(input: {
        paymentPayload: PaymentPayload;
        requirements: PaymentRequirements;
        onSubmitted(txHash: string): Promise<void>;
    }): Promise<EvmBatchDepositExecutionResult>;
    reconcileDeposit(txHash: string, network: EvmNetworkId): Promise<EvmBatchDepositExecutionResult>;
    now(): number;
    createOwnerToken(): string;
};

const EVM_BATCH_DEPOSIT_PREFIX = "x402:batch-settlement:evm-deposit";
const CANONICAL_EVM_TRANSACTION_HASH = /^0x[\da-f]{64}$/u;

function requireCanonicalEvmTransactionHash(txHash: string): string {
    if (!CANONICAL_EVM_TRANSACTION_HASH.test(txHash)) {
        throw new Error("EVM batch deposit transaction hash must be canonical 32-byte lowercase hex");
    }
    return txHash;
}

function requireEvmBatchDepositOwnerToken(ownerToken: string): void {
    if (!ownerToken) {
        throw new Error("EVM batch deposit transition requires its broadcast owner");
    }
}

function requireEvmBatchDepositTimestamp(timestamp: number, name: string): void {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error(`EVM batch deposit ${name} must be a nonnegative safe integer`);
    }
}

function decimalMetadata(value: unknown, fallback = "0"): string {
    const normalized = typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : typeof value === "string"
            ? value
            : fallback;
    return /^(?:0|[1-9]\d*)$/u.test(normalized) ? normalized : fallback;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireOnlyFields(
    value: Record<string, unknown>,
    fields: readonly string[],
    name: string,
): void {
    const allowed = new Set(fields);
    if (Object.keys(value).some((field) => !allowed.has(field))) {
        throw new Error(`${name} contains unsupported fields`);
    }
}

function canonicalUnsignedInteger(value: unknown, name: string, positive = false): string {
    if (typeof value !== "string" || !/^\d+$/u.test(value)) {
        throw new Error(`${name} must be an unsigned integer string`);
    }
    const normalized = BigInt(value).toString();
    if (positive && normalized === "0") {
        throw new Error(`${name} must be positive`);
    }
    return normalized;
}

function canonicalEvmAddress(value: unknown, name: string): string {
    if (typeof value !== "string" || !/^0x[\da-fA-F]{40}$/u.test(value)) {
        throw new Error(`${name} must be a 20-byte EVM address`);
    }
    return value.toLowerCase();
}

function canonicalHex(value: unknown, name: string, bytes?: number): string {
    if (
        typeof value !== "string"
        || !/^0x(?:[\da-fA-F]{2})+$/u.test(value)
        || (bytes !== undefined && value.length !== 2 + bytes * 2)
    ) {
        throw new Error(`${name} must be${bytes === undefined ? " non-empty" : ` a ${bytes}-byte`} hex value`);
    }
    return value.toLowerCase();
}

function resolveEvmBatchDepositAuthorization(input: {
    network: EvmNetworkId;
    channelId: string;
    deposit: BatchRaw["deposit"];
}): {
    channelId: string;
    authorizationFingerprint: string;
} {
    const deposit = requireRecord(input.deposit, "EVM batch deposit");
    const depositAmountWei = canonicalUnsignedInteger(deposit.amount, "EVM batch deposit amount", true);
    const authorization = requireRecord(deposit.authorization, "EVM batch deposit authorization");
    const hasErc3009 = Object.prototype.hasOwnProperty.call(authorization, "erc3009Authorization");
    const hasPermit2 = Object.prototype.hasOwnProperty.call(authorization, "permit2Authorization");
    if (!hasErc3009 && !hasPermit2 && Object.keys(authorization).length > 0) {
        throw new Error("EVM batch deposit uses an unsupported authorization form");
    }
    if (hasErc3009 === hasPermit2) {
        throw new Error("EVM batch deposit requires exactly one supported authorization");
    }

    const channelId = canonicalHex(input.channelId, "EVM batch deposit channel ID", 32);
    let canonicalAuthorization: Record<string, unknown>;
    if (hasErc3009) {
        requireOnlyFields(authorization, ["erc3009Authorization"], "EVM batch ERC-3009 authorization wrapper");
        const erc3009 = requireRecord(
            authorization.erc3009Authorization,
            "EVM batch ERC-3009 authorization",
        );
        requireOnlyFields(
            erc3009,
            ["validAfter", "validBefore", "salt", "signature"],
            "EVM batch ERC-3009 authorization",
        );
        canonicalAuthorization = {
            type: "erc3009",
            validAfter: canonicalUnsignedInteger(
                erc3009.validAfter,
                "EVM batch ERC-3009 validAfter",
            ),
            validBefore: canonicalUnsignedInteger(
                erc3009.validBefore,
                "EVM batch ERC-3009 validBefore",
            ),
            salt: canonicalHex(erc3009.salt, "EVM batch ERC-3009 salt", 32),
            signature: canonicalHex(erc3009.signature, "EVM batch ERC-3009 signature"),
        };
    } else {
        requireOnlyFields(authorization, ["permit2Authorization"], "EVM batch Permit2 authorization wrapper");
        const permit2 = requireRecord(
            authorization.permit2Authorization,
            "EVM batch Permit2 authorization",
        );
        requireOnlyFields(
            permit2,
            ["from", "permitted", "spender", "nonce", "deadline", "witness", "signature"],
            "EVM batch Permit2 authorization",
        );
        const permitted = requireRecord(permit2.permitted, "EVM batch Permit2 permitted value");
        requireOnlyFields(permitted, ["token", "amount"], "EVM batch Permit2 permitted value");
        const witness = requireRecord(permit2.witness, "EVM batch Permit2 witness");
        requireOnlyFields(witness, ["channelId"], "EVM batch Permit2 witness");
        canonicalAuthorization = {
            type: "permit2",
            from: canonicalEvmAddress(permit2.from, "EVM batch Permit2 from"),
            permitted: {
                token: canonicalEvmAddress(permitted.token, "EVM batch Permit2 token"),
                amount: canonicalUnsignedInteger(
                    permitted.amount,
                    "EVM batch Permit2 permitted amount",
                    true,
                ),
            },
            spender: canonicalEvmAddress(permit2.spender, "EVM batch Permit2 spender"),
            nonce: canonicalUnsignedInteger(permit2.nonce, "EVM batch Permit2 nonce"),
            deadline: canonicalUnsignedInteger(permit2.deadline, "EVM batch Permit2 deadline"),
            witness: {
                channelId: canonicalHex(
                    witness.channelId,
                    "EVM batch Permit2 witness channel ID",
                    32,
                ),
            },
            signature: canonicalHex(permit2.signature, "EVM batch Permit2 signature"),
        };
    }

    const authorizationFingerprint = createHash("sha256")
        .update(canonicalJson({
            version: 1,
            network: input.network,
            channelId,
            depositAmountWei,
            authorization: canonicalAuthorization,
        }))
        .digest("hex");
    return { channelId, authorizationFingerprint };
}

function evmBatchDepositStateKey(input: {
    network: EvmNetworkId;
    channelId: string;
    authorizationFingerprint: string;
}): string {
    return [
        EVM_BATCH_DEPOSIT_PREFIX,
        encodeURIComponent(input.network),
        input.channelId.toLowerCase(),
        input.authorizationFingerprint,
    ].join(":");
}

function parseEvmBatchDepositState(data: Record<string, string>): EvmBatchDepositState | null {
    const status = data.status as EvmBatchDepositStatus | undefined;
    const commonFields = [
        "key",
        "status",
        "network",
        "channelId",
        "authorizationFingerprint",
        "backingFingerprint",
        "payer",
        "asset",
        "receiver",
        "resource",
        "maxAmountWei",
        "verifiedBalanceWei",
        "verifiedTotalClaimedWei",
        "verifiedWithdrawRequestedAt",
        "verifiedRefundNonce",
        "preparedAt",
    ] as const;
    const hasExactFields = (fields: readonly string[]): boolean => {
        const expected = new Set(fields);
        return Object.keys(data).length === expected.size
            && Object.keys(data).every((field) => expected.has(field));
    };
    const timestamp = (name: string, positive = false): number | undefined => {
        const value = data[name];
        if (!value || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) && parsed >= (positive ? 1 : 0) ? parsed : undefined;
    };
    if (
        !data.key
        || !status
        || !["prepared", "broadcast", "submitted", "confirmed", "failed"].includes(status)
        || !data.network
        || !isNetworkId(data.network)
        || !isEvmNetwork(data.network)
        || !/^0x[\da-f]{64}$/u.test(data.channelId || "")
        || !/^[\da-f]{64}$/u.test(data.authorizationFingerprint || "")
        || !data.backingFingerprint
        || !data.payer
        || !data.asset
        || !data.receiver
        || !data.resource
        || !/^[1-9]\d*$/u.test(data.maxAmountWei || "")
        || !/^(?:0|[1-9]\d*)$/u.test(data.verifiedBalanceWei || "")
        || !/^(?:0|[1-9]\d*)$/u.test(data.verifiedTotalClaimedWei || "")
        || !/^(?:0|[1-9]\d*)$/u.test(data.verifiedWithdrawRequestedAt || "")
        || !/^(?:0|[1-9]\d*)$/u.test(data.verifiedRefundNonce || "")
        || timestamp("preparedAt", true) === undefined
    ) {
        return null;
    }
    const preparedAt = timestamp("preparedAt", true)!;
    const broadcastAt = timestamp("broadcastAt");
    const submittedAt = timestamp("submittedAt");
    const confirmedAt = timestamp("confirmedAt");
    const failedAt = timestamp("failedAt");
    const preparedShape = hasExactFields(commonFields);
    const broadcastFields = [...commonFields, "ownerToken", "broadcastAt"];
    const submittedFields = [...broadcastFields, "txHash", "submittedAt"];
    const confirmedFields = [...submittedFields, "confirmedAt"];
    const hashlessFailedFields = [...broadcastFields, "failedAt", "error"];
    const submittedFailedFields = [...submittedFields, "failedAt", "error"];
    const broadcastShape = hasExactFields(broadcastFields)
        && Boolean(data.ownerToken)
        && broadcastAt !== undefined
        && preparedAt <= broadcastAt;
    const submittedShape = hasExactFields(submittedFields)
        && Boolean(data.ownerToken)
        && broadcastAt !== undefined
        && submittedAt !== undefined
        && CANONICAL_EVM_TRANSACTION_HASH.test(data.txHash || "")
        && preparedAt <= broadcastAt
        && broadcastAt <= submittedAt;
    const confirmedShape = hasExactFields(confirmedFields)
        && Boolean(data.ownerToken)
        && broadcastAt !== undefined
        && submittedAt !== undefined
        && confirmedAt !== undefined
        && CANONICAL_EVM_TRANSACTION_HASH.test(data.txHash || "")
        && preparedAt <= broadcastAt
        && broadcastAt <= submittedAt
        && submittedAt <= confirmedAt;
    const failedShape = Boolean(data.ownerToken)
        && Boolean(data.error)
        && broadcastAt !== undefined
        && failedAt !== undefined
        && preparedAt <= broadcastAt
        && (
            (hasExactFields(hashlessFailedFields) && broadcastAt <= failedAt)
            || (
                hasExactFields(submittedFailedFields)
                && submittedAt !== undefined
                && CANONICAL_EVM_TRANSACTION_HASH.test(data.txHash || "")
                && broadcastAt <= submittedAt
                && submittedAt <= failedAt
            )
        );
    if (
        data.key !== evmBatchDepositStateKey({
            network: data.network,
            channelId: data.channelId,
            authorizationFingerprint: data.authorizationFingerprint,
        })
        || (status === "prepared" && !preparedShape)
        || (status === "broadcast" && !broadcastShape)
        || (status === "submitted" && !submittedShape)
        || (status === "confirmed" && !confirmedShape)
        || (status === "failed" && !failedShape)
    ) {
        return null;
    }
    return {
        key: data.key,
        status,
        network: data.network,
        channelId: data.channelId,
        authorizationFingerprint: data.authorizationFingerprint,
        backingFingerprint: data.backingFingerprint,
        payer: data.payer,
        asset: data.asset,
        receiver: data.receiver,
        resource: data.resource,
        maxAmountWei: data.maxAmountWei,
        verifiedBalanceWei: data.verifiedBalanceWei,
        verifiedTotalClaimedWei: data.verifiedTotalClaimedWei,
        verifiedWithdrawRequestedAt: data.verifiedWithdrawRequestedAt,
        verifiedRefundNonce: data.verifiedRefundNonce,
        preparedAt,
        ...(broadcastAt !== undefined ? { broadcastAt } : {}),
        ...(submittedAt !== undefined ? { submittedAt } : {}),
        ...(confirmedAt !== undefined ? { confirmedAt } : {}),
        ...(failedAt !== undefined ? { failedAt } : {}),
        ...(data.ownerToken ? { ownerToken: data.ownerToken } : {}),
        ...(data.txHash ? { txHash: data.txHash } : {}),
        ...(data.error ? { error: data.error } : {}),
    };
}

function evmBatchDepositFields(state: EvmBatchDepositState): Record<string, string> {
    return {
        key: state.key,
        status: state.status,
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
        preparedAt: String(state.preparedAt),
    };
}

async function requireStoredEvmBatchDepositState(key: string): Promise<EvmBatchDepositState> {
    const state = parseEvmBatchDepositState(await valkeyHGetAll(key));
    if (!state) {
        throw new Error("EVM batch deposit durable state is missing or corrupt");
    }
    return state;
}

// Authorization validity has no protocol upper bound. These records are durable
// no-rebroadcast tombstones; PERSIST also upgrades any earlier expiring record.
const valkeyEvmBatchDepositStore: EvmBatchDepositStore = {
    async read(key) {
        const valkey = await getValkeyClient();
        await valkey.persist(key);
        return parseEvmBatchDepositState(await valkeyHGetAll(key));
    },
    async prepare(state) {
        const valkey = await getValkeyClient();
        const fields = evmBatchDepositFields(state);
        // Wrapper and verification fields are first-writer audit metadata. Only
        // the canonical authorization identity participates in convergence.
        const result = await valkey.eval(
            `if redis.call("EXISTS", KEYS[1]) == 1 then
              if redis.call("HGET", KEYS[1], "network") ~= ARGV[1]
                or redis.call("HGET", KEYS[1], "channelId") ~= ARGV[2]
                or redis.call("HGET", KEYS[1], "authorizationFingerprint") ~= ARGV[3] then return -1 end
              redis.call("PERSIST", KEYS[1])
              return 0
            end
            redis.call("HSET", KEYS[1], unpack(ARGV, 4, #ARGV))
            return 1`,
            1,
            state.key,
            state.network,
            state.channelId,
            state.authorizationFingerprint,
            ...Object.entries(fields).flatMap(([field, value]) => [field, value]),
        );
        if (Number(result) === -1) {
            throw new Error("EVM batch deposit durable authorization identity mismatch");
        }
        return requireStoredEvmBatchDepositState(state.key);
    },
    async claimBroadcast(input) {
        requireEvmBatchDepositOwnerToken(input.ownerToken);
        requireEvmBatchDepositTimestamp(input.broadcastAt, "broadcastAt");
        const valkey = await getValkeyClient();
        const result = await valkey.eval(
            `redis.call("PERSIST", KEYS[1])
            if redis.call("HGET", KEYS[1], "status") ~= "prepared" then return 0 end
            local preparedAt = tonumber(redis.call("HGET", KEYS[1], "preparedAt"))
            local broadcastAt = tonumber(ARGV[2])
            if not preparedAt or not broadcastAt or broadcastAt < preparedAt then return -1 end
            redis.call("HSET", KEYS[1],
              "status", "broadcast",
              "ownerToken", ARGV[1],
              "broadcastAt", ARGV[2])
            return 1`,
            1,
            input.key,
            input.ownerToken,
            String(input.broadcastAt),
        );
        if (Number(result) === -1) {
            throw new Error("EVM batch deposit broadcast timestamp precedes preparation");
        }
        return {
            acquired: Number(result) === 1,
            state: await requireStoredEvmBatchDepositState(input.key),
        };
    },
    async markSubmitted(input) {
        requireEvmBatchDepositOwnerToken(input.ownerToken);
        requireCanonicalEvmTransactionHash(input.txHash);
        requireEvmBatchDepositTimestamp(input.submittedAt, "submittedAt");
        const valkey = await getValkeyClient();
        const result = await valkey.eval(
            `redis.call("PERSIST", KEYS[1])
            local status = redis.call("HGET", KEYS[1], "status")
            local txHash = redis.call("HGET", KEYS[1], "txHash")
            local ownerToken = redis.call("HGET", KEYS[1], "ownerToken")
            local broadcastAt = tonumber(redis.call("HGET", KEYS[1], "broadcastAt"))
            local submittedAt = tonumber(ARGV[3])
            if not broadcastAt or not submittedAt or submittedAt < broadcastAt then return -1 end
            if ((status == "submitted" and txHash == ARGV[2])
              or (status == "confirmed" and txHash == ARGV[2]))
              and ownerToken == ARGV[1] then return 0 end
            if status ~= "broadcast"
              or ownerToken ~= ARGV[1] then return -1 end
            redis.call("HSET", KEYS[1],
              "status", "submitted",
              "txHash", ARGV[2],
              "submittedAt", ARGV[3])
            return 1`,
            1,
            input.key,
            input.ownerToken,
            input.txHash,
            String(input.submittedAt),
        );
        if (Number(result) === -1) {
            throw new Error("EVM batch deposit submitted transition lost its broadcast ownership");
        }
        return requireStoredEvmBatchDepositState(input.key);
    },
    async markConfirmed(input) {
        requireCanonicalEvmTransactionHash(input.txHash);
        requireEvmBatchDepositTimestamp(input.confirmedAt, "confirmedAt");
        const valkey = await getValkeyClient();
        const result = await valkey.eval(
            `redis.call("PERSIST", KEYS[1])
            local status = redis.call("HGET", KEYS[1], "status")
            local txHash = redis.call("HGET", KEYS[1], "txHash")
            if status == "confirmed" and txHash == ARGV[1] then return 0 end
            local submittedAt = tonumber(redis.call("HGET", KEYS[1], "submittedAt"))
            local confirmedAt = tonumber(ARGV[2])
            if status ~= "submitted" or txHash ~= ARGV[1]
              or not submittedAt or not confirmedAt or confirmedAt < submittedAt then return -1 end
            redis.call("HSET", KEYS[1], "status", "confirmed", "confirmedAt", ARGV[2])
            return 1`,
            1,
            input.key,
            input.txHash,
            String(input.confirmedAt),
        );
        if (Number(result) === -1) {
            throw new Error("EVM batch deposit confirmation does not match its submitted transaction");
        }
        return requireStoredEvmBatchDepositState(input.key);
    },
    async markFailed(input) {
        requireEvmBatchDepositOwnerToken(input.ownerToken);
        if (input.txHash !== undefined) requireCanonicalEvmTransactionHash(input.txHash);
        requireEvmBatchDepositTimestamp(input.failedAt, "failedAt");
        if (!input.error) throw new Error("EVM batch deposit failure requires an error");
        const valkey = await getValkeyClient();
        const result = await valkey.eval(
            `redis.call("PERSIST", KEYS[1])
            local status = redis.call("HGET", KEYS[1], "status")
            local ownerToken = redis.call("HGET", KEYS[1], "ownerToken")
            local existingTx = redis.call("HGET", KEYS[1], "txHash")
            local submittedAt = redis.call("HGET", KEYS[1], "submittedAt")
            if status == "failed" then
              if ownerToken ~= ARGV[1] then return -1 end
              if existingTx and existingTx ~= "" then
                if existingTx ~= ARGV[2] or not submittedAt or submittedAt == "" then return -1 end
              elseif ARGV[2] ~= "" or (submittedAt and submittedAt ~= "") then return -1 end
              return 0
            end
            if ownerToken ~= ARGV[1] then return -1 end
            local failedAt = tonumber(ARGV[4])
            if status == "broadcast" then
              local broadcastAt = tonumber(redis.call("HGET", KEYS[1], "broadcastAt"))
              if ARGV[2] ~= "" or (existingTx and existingTx ~= "")
                or (submittedAt and submittedAt ~= "")
                or not broadcastAt or not failedAt or failedAt < broadcastAt then return -1 end
            elseif status == "submitted" then
              local durableSubmittedAt = tonumber(submittedAt)
              if ARGV[2] == "" or existingTx ~= ARGV[2]
                or not durableSubmittedAt or not failedAt or failedAt < durableSubmittedAt then return -1 end
            else
              return -1
            end
            redis.call("HSET", KEYS[1],
              "status", "failed",
              "error", ARGV[3],
              "failedAt", ARGV[4])
            return 1`,
            1,
            input.key,
            input.ownerToken,
            input.txHash || "",
            input.error,
            String(input.failedAt),
        );
        if (Number(result) === -1) {
            throw new Error("EVM batch deposit failure does not match its durable attempt");
        }
        return requireStoredEvmBatchDepositState(input.key);
    },
};

function resolveEvmBatchDeposit(input: {
    paymentPayload: PaymentPayload;
    requirements: PaymentRequirements;
}): {
    backing: ReturnType<typeof resolveRawBatchBacking>;
    channelId: string;
    authorizationFingerprint: string;
    key: string;
} {
    const raw = getBatchPayload(input.paymentPayload);
    if (!raw || raw.type !== "deposit") {
        throw new Error("EVM batch deposit durability requires a deposit payload");
    }
    if (!isNetworkId(input.requirements.network) || !isEvmNetwork(input.requirements.network)) {
        throw new Error("EVM batch deposit durability requires an EVM network");
    }
    const backing = resolveRawBatchBacking({
        network: input.requirements.network,
        maxAmountWei: input.paymentPayload.accepted.amount,
        paymentPayload: input.paymentPayload,
        payer: raw.channelConfig.payer,
    });
    if (
        input.requirements.scheme !== "batch-settlement"
        || input.requirements.network !== backing.network
        || input.requirements.amount !== input.paymentPayload.accepted.amount
        || !sameBinding(backing.network, input.requirements.asset, backing.asset)
        || !sameBinding(backing.network, input.requirements.payTo, backing.receiver)
    ) {
        throw new Error("EVM batch deposit requirements do not match immutable backing");
    }
    const authorization = resolveEvmBatchDepositAuthorization({
        network: input.requirements.network,
        channelId: backing.channelId,
        deposit: raw.deposit,
    });
    return {
        backing,
        ...authorization,
        key: evmBatchDepositStateKey({
            network: input.requirements.network,
            channelId: authorization.channelId,
            authorizationFingerprint: authorization.authorizationFingerprint,
        }),
    };
}

function preparedEvmBatchDepositState(input: {
    paymentPayload: PaymentPayload;
    requirements: PaymentRequirements;
    verifyResult: VerifyResponse;
    now: number;
}): EvmBatchDepositState {
    const {
        backing,
        channelId,
        authorizationFingerprint,
        key,
    } = resolveEvmBatchDeposit(input);
    if (!input.verifyResult.isValid || !input.verifyResult.payer) {
        throw new Error("Only a verified EVM batch deposit can enter durable preparation");
    }
    if (!sameBinding(backing.network, input.verifyResult.payer, backing.payer)) {
        throw new Error("Verified EVM batch deposit payer does not match immutable backing");
    }
    const extra = (input.verifyResult.extra || {}) as Record<string, unknown>;
    return {
        key,
        status: "prepared",
        network: backing.network as EvmNetworkId,
        channelId,
        authorizationFingerprint,
        backingFingerprint: backing.backingFingerprint,
        payer: backing.payer,
        asset: backing.asset,
        receiver: backing.receiver,
        resource: backing.resource,
        maxAmountWei: input.paymentPayload.accepted.amount,
        verifiedBalanceWei: decimalMetadata(extra.balance),
        verifiedTotalClaimedWei: decimalMetadata(extra.totalClaimed),
        verifiedWithdrawRequestedAt: decimalMetadata(extra.withdrawRequestedAt),
        verifiedRefundNonce: decimalMetadata(extra.refundNonce),
        preparedAt: input.now,
    };
}

function assertEvmBatchDepositStateMatches(
    state: EvmBatchDepositState,
    resolved: ReturnType<typeof resolveEvmBatchDeposit>,
): void {
    const {
        channelId,
        authorizationFingerprint,
        key,
    } = resolved;
    if (
        state.key !== key
        || state.network !== resolved.backing.network
        || state.channelId !== channelId
        || state.authorizationFingerprint !== authorizationFingerprint
    ) {
        throw new Error("EVM batch deposit durable state does not match its authorization identity");
    }
}

function unknownDepositResult(error: unknown): EvmBatchDepositExecutionResult {
    return {
        status: "unknown",
        error: error instanceof Error ? error.message : String(error),
    };
}

async function settleSubmittedEvmBatchDeposit(input: {
    state: EvmBatchDepositState;
    dependencies: EvmBatchDepositDependencies;
}): Promise<EvmBatchDepositState> {
    if (!input.state.txHash || !input.state.ownerToken) {
        throw new Error("Submitted EVM batch deposit is missing its transaction identity");
    }
    const txHash = requireCanonicalEvmTransactionHash(input.state.txHash);
    let reconciliation: EvmBatchDepositExecutionResult;
    try {
        reconciliation = await input.dependencies.reconcileDeposit(txHash, input.state.network);
    } catch (error) {
        reconciliation = unknownDepositResult(error);
    }
    if (reconciliation.status === "confirmed") {
        const reconciledTxHash = requireCanonicalEvmTransactionHash(reconciliation.txHash);
        if (reconciledTxHash !== txHash) {
            throw new Error("EVM batch deposit reconciliation returned a different transaction identity");
        }
        return input.dependencies.store.markConfirmed({
            key: input.state.key,
            txHash,
            confirmedAt: input.dependencies.now(),
        });
    }
    if (reconciliation.status === "failed" && reconciliation.terminal) {
        if (
            !reconciliation.txHash
            || !CANONICAL_EVM_TRANSACTION_HASH.test(reconciliation.txHash)
            || reconciliation.txHash !== txHash
        ) {
            return input.dependencies.store.read(input.state.key).then((state) => state || input.state);
        }
        return input.dependencies.store.markFailed({
            key: input.state.key,
            ownerToken: input.state.ownerToken,
            txHash,
            error: reconciliation.error,
            failedAt: input.dependencies.now(),
        });
    }
    return input.dependencies.store.read(input.state.key).then((state) => state || input.state);
}

export async function ensureEvmBatchDeposit(
    input: {
        paymentPayload: PaymentPayload;
        requirements: PaymentRequirements;
        verifyResult?: VerifyResponse;
    },
    dependencies: EvmBatchDepositDependencies,
): Promise<EvmBatchDepositState | null> {
    const resolved = resolveEvmBatchDeposit(input);
    let state = await dependencies.store.read(resolved.key);
    if (!state) {
        if (!input.verifyResult) return null;
        state = await dependencies.store.prepare(preparedEvmBatchDepositState({
            ...input,
            verifyResult: input.verifyResult,
            now: dependencies.now(),
        }));
    }
    assertEvmBatchDepositStateMatches(state, resolved);
    if (state.status === "confirmed" || state.status === "failed" || state.status === "broadcast") {
        return state;
    }
    if (state.status === "submitted") {
        return settleSubmittedEvmBatchDeposit({ state, dependencies });
    }

    const ownerToken = dependencies.createOwnerToken();
    const acquisition = await dependencies.store.claimBroadcast({
        key: state.key,
        ownerToken,
        broadcastAt: dependencies.now(),
    });
    if (!acquisition.acquired) {
        return acquisition.state.status === "submitted"
            ? settleSubmittedEvmBatchDeposit({ state: acquisition.state, dependencies })
            : acquisition.state;
    }

    const onSubmitted = async (txHash: string): Promise<void> => {
        requireCanonicalEvmTransactionHash(txHash);
        state = await dependencies.store.markSubmitted({
            key: acquisition.state.key,
            ownerToken,
            txHash,
            submittedAt: dependencies.now(),
        });
    };
    let broadcast: EvmBatchDepositExecutionResult;
    try {
        broadcast = await dependencies.broadcastDeposit({
            paymentPayload: input.paymentPayload,
            requirements: input.requirements,
            onSubmitted,
        });
    } catch (error) {
        broadcast = unknownDepositResult(error);
    }

    if (broadcast.status === "submitted" || broadcast.status === "confirmed") {
        const broadcastTxHash = requireCanonicalEvmTransactionHash(broadcast.txHash);
        const persisted = await dependencies.store.read(acquisition.state.key);
        if (persisted?.status !== "submitted" && persisted?.status !== "confirmed") {
            await onSubmitted(broadcastTxHash);
        } else if (persisted.txHash !== broadcastTxHash) {
            throw new Error("EVM batch deposit broadcast returned a different transaction identity");
        }
        if (broadcast.status === "confirmed") {
            return dependencies.store.markConfirmed({
                key: acquisition.state.key,
                txHash: broadcastTxHash,
                confirmedAt: dependencies.now(),
            });
        }
    } else if (broadcast.status === "failed" && broadcast.terminal) {
        const persisted = await dependencies.store.read(acquisition.state.key);
        if (broadcast.txHash) {
            const broadcastTxHash = requireCanonicalEvmTransactionHash(broadcast.txHash);
            if (persisted?.status !== "submitted" && persisted?.status !== "confirmed") {
                await onSubmitted(broadcastTxHash);
            } else if (persisted.txHash !== broadcastTxHash) {
                throw new Error("EVM batch deposit failure returned a different transaction identity");
            }
        } else if (persisted?.status === "submitted" || persisted?.status === "confirmed") {
            return persisted;
        }
        return dependencies.store.markFailed({
            key: acquisition.state.key,
            ownerToken,
            ...(broadcast.txHash ? { txHash: broadcast.txHash } : {}),
            error: broadcast.error,
            failedAt: dependencies.now(),
        });
    }
    return dependencies.store.read(acquisition.state.key).then((current) => current || acquisition.state);
}

export async function requireEvmBatchDepositConfirmed(
    input: {
        paymentPayload: PaymentPayload;
        requirements: PaymentRequirements;
    },
    dependencies: Pick<EvmBatchDepositDependencies, "store"> = { store: valkeyEvmBatchDepositStore },
): Promise<EvmBatchDepositState> {
    const resolved = resolveEvmBatchDeposit(input);
    const { key } = resolved;
    const state = await dependencies.store.read(key);
    if (!state) {
        throw new Error("EVM batch deposit is not durably confirmed");
    }
    if (state.status === "failed") {
        throw new Error(`EVM batch deposit failed: ${state.error || "definitive on-chain failure"}`);
    }
    if (state.status !== "confirmed") {
        throw new Error(`EVM batch deposit is ${state.status}, not confirmed`);
    }
    assertEvmBatchDepositStateMatches(state, resolved);
    return state;
}

function settlementResultForEvmDeposit(result: SettlementResult): EvmBatchDepositExecutionResult {
    if (result.status === "confirmed" && result.success && result.txHash) {
        return { status: "confirmed", txHash: result.txHash };
    }
    if (result.status === "failed" && result.terminal) {
        return {
            status: "failed",
            terminal: true,
            error: result.error || "EVM batch deposit failed on-chain",
            ...(result.txHash ? { txHash: result.txHash } : {}),
        };
    }
    if (result.status === "submitted" && result.txHash) {
        return { status: "submitted", txHash: result.txHash };
    }
    return { status: "unknown", error: result.error || "EVM batch deposit confirmation is pending" };
}

export function createEvmBatchDepositDependencies(
    broadcastDeposit: EvmBatchDepositDependencies["broadcastDeposit"],
): EvmBatchDepositDependencies {
    return {
        store: valkeyEvmBatchDepositStore,
        broadcastDeposit,
        reconcileDeposit: async (txHash, network) => settlementResultForEvmDeposit(
            await reconcileKeyPaymentForNetwork(txHash, network),
        ),
        now: Date.now,
        createOwnerToken: randomUUID,
    };
}

const SVM_BATCH_PREFIX = "x402:batch-settlement:svm";
const SVM_BATCH_PENDING_KEY = `${SVM_BATCH_PREFIX}:pending`;
const SVM_BATCH_TTL_SECONDS = 60 * 60 * 24;
const svmUtf8Encoder = getUtf8Encoder();
const svmBase58Encoder = getBase58Encoder();

function valkey() {
    return {
        get: async (key: string) => (await getValkeyClient()).get(key),
        set: async (key: string, value: string, options?: { NX?: true; PX?: number }) =>
            options?.NX
                ? (await getValkeyClient()).set(key, value, "PX", options.PX ?? 0, "NX") as Promise<string | null>
                : (await getValkeyClient()).set(key, value) as Promise<string | null>,
        del: async (key: string) => (await getValkeyClient()).del(key),
        eval: async (script: string, options: { keys: string[]; arguments: string[] }) =>
            (await getValkeyClient()).eval(script, options.keys.length, ...options.keys, ...options.arguments),
        scanIterator(options: { MATCH?: string; COUNT?: number }) {
            async function* iterate() {
                const client = await getValkeyClient();
                let cursor = "0";
                do {
                    const [nextCursor, keys] = await client.scan(cursor, "MATCH", options.MATCH ?? "*", "COUNT", options.COUNT ?? 100);
                    cursor = nextCursor;
                    yield keys as string | string[];
                } while (cursor !== "0");
            }
            return iterate();
        },
    };
}

export function getBatchChannelStorage(): ValkeyChannelStorage {
    if (!storage) {
        storage = new ValkeyChannelStorage({
            client: valkey(),
            keyPrefix: "x402:batch-settlement",
        });
    }
    return storage;
}

export function isBatchSettlementScheme(scheme: string | undefined): boolean {
    return scheme === "batch-settlement";
}

export function getBatchPayload(paymentPayload: PaymentPayload): BatchRaw | null {
    if (!isBatchSettlementScheme(paymentPayload.accepted.scheme)) {
        return null;
    }
    const raw = paymentPayload.payload as Partial<BatchRaw> | undefined;
    if (
        raw
        && (raw.type === "deposit" || raw.type === "voucher")
        && raw.channelConfig
        && raw.voucher
        && typeof raw.voucher.channelId === "string"
        && typeof raw.voucher.maxClaimableAmount === "string"
        && typeof raw.voucher.signature === "string"
    ) {
        return raw as BatchRaw;
    }
    return null;
}

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

function sameBinding(network: NetworkId, left: string, right: string): boolean {
    return isSolanaNetwork(network) || isNearNetwork(network)
        ? left === right
        : left.toLowerCase() === right.toLowerCase();
}

function utf8Bytes(value: string): Uint8Array {
    return new Uint8Array(svmUtf8Encoder.encode(value));
}

function signatureFromBase58(value: string) {
    return signatureBytes(new Uint8Array(svmBase58Encoder.encode(value)));
}

function positiveInteger(value: string): boolean {
    return /^\d+$/u.test(value) && BigInt(value) > 0n;
}

export function getBatchAsset(network: EvmNetworkId): {
    address: `0x${string}`;
    name: string;
    version: string;
    decimals: number;
    assetTransferMethod?: string;
} {
    const asset = getNetwork(network).asset;
    return {
        address: asset.address as `0x${string}`,
        name: asset.name,
        version: asset.version,
        decimals: asset.decimals,
        ...(asset.assetTransferMethod ? { assetTransferMethod: asset.assetTransferMethod } : {}),
    };
}

export function createBatchPaymentExtra(network: EvmNetworkId, receiverAuthorizer: `0x${string}`): Record<string, unknown> {
    const asset = getBatchAsset(network);
    return {
        receiverAuthorizer,
        withdrawDelay: WITHDRAW_DELAY_SECONDS,
        name: asset.name,
        version: asset.version,
        ...(asset.assetTransferMethod ? { assetTransferMethod: asset.assetTransferMethod } : {}),
    };
}

function stringExtra(extra: Record<string, unknown>, key: string, fallback: string): string {
    const value = extra[key];
    return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberExtra(extra: Record<string, unknown>, key: string, fallback: number): number {
    const value = extra[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function base(
    raw: BatchRaw,
    requirements: PaymentRequirements,
    backing: ReturnType<typeof resolveRawBatchBacking>,
    verifyResult?: VerifyResponse,
): StoredChannel {
    const extra = (verifyResult?.extra ?? {}) as Record<string, unknown>;
    const deposit = raw.type === "deposit" && raw.deposit?.amount ? BigInt(raw.deposit.amount) : 0n;
    const balance = BigInt(stringExtra(extra, "balance", "0")) + deposit;
    const signedMax = BigInt(raw.voucher.maxClaimableAmount);
    const requirementAmount = BigInt(requirements.amount || "0");
    const charged = signedMax >= requirementAmount ? signedMax - requirementAmount : 0n;
    return {
        channelId: backing.channelId,
        channelConfig: raw.channelConfig as StoredChannel["channelConfig"],
        chargedCumulativeAmount: charged.toString(),
        signedMaxClaimable: backing.signedMaxClaimable,
        signature: backing.voucherSignature,
        balance: balance > 0n ? balance.toString() : raw.voucher.maxClaimableAmount,
        totalClaimed: stringExtra(extra, "totalClaimed", "0"),
        withdrawRequestedAt: numberExtra(extra, "withdrawRequestedAt", 0),
        refundNonce: numberExtra(extra, "refundNonce", 0),
        onchainSyncedAt: verifyResult?.extra ? Date.now() : undefined,
        lastRequestTimestamp: Date.now(),
        network: backing.network,
        payer: backing.payer,
        asset: backing.asset,
        receiver: backing.receiver,
        resource: backing.resource,
        channelConfigFingerprint: backing.channelConfigFingerprint,
        backingFingerprint: backing.backingFingerprint,
    };
}

export async function rememberBatchChannel(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    verifyResult?: VerifyResponse,
): Promise<void> {
    const raw = getBatchPayload(paymentPayload);
    if (!raw) return;
    if (isNetworkId(requirements.network) && isSolanaNetwork(requirements.network)) {
        await rememberSvmBatchChannel(paymentPayload, requirements);
        return;
    }
    if (isNetworkId(requirements.network) && isNearNetwork(requirements.network)) {
        await rememberNearBatchChannel(paymentPayload, requirements);
        return;
    }

    if (!isNetworkId(requirements.network)) {
        throw new Error("Batch-settlement requirements use an unsupported network");
    }
    if (raw.type === "deposit" && isEvmNetwork(requirements.network)) {
        await requireEvmBatchDepositConfirmed({ paymentPayload, requirements });
    }
    const backing = resolveRawBatchBacking({
        network: requirements.network,
        maxAmountWei: paymentPayload.accepted.amount,
        paymentPayload,
        payer: verifyResult?.payer || raw.channelConfig.payer,
    });
    const verified = (verifyResult?.extra ?? {}) as Record<string, unknown>;

    await getBatchChannelStorage().updateChannel(raw.voucher.channelId, (current) => {
        const existing = current as StoredChannel | undefined;
        if (existing) {
            if (
                existing.network !== backing.network
                || existing.payer !== backing.payer
                || existing.asset !== backing.asset
                || existing.receiver !== backing.receiver
                || existing.resource !== backing.resource
                || existing.channelConfigFingerprint !== backing.channelConfigFingerprint
            ) {
                throw new Error("Batch-settlement channel immutable backing mismatch");
            }
            return {
                ...existing,
                signedMaxClaimable: backing.signedMaxClaimable,
                signature: backing.voucherSignature,
                backingFingerprint: backing.backingFingerprint,
                ...(verifyResult?.extra ? {
                    balance: stringExtra(verified, "balance", existing.balance),
                    totalClaimed: stringExtra(verified, "totalClaimed", existing.totalClaimed),
                    withdrawRequestedAt: numberExtra(verified, "withdrawRequestedAt", existing.withdrawRequestedAt),
                    refundNonce: numberExtra(verified, "refundNonce", existing.refundNonce),
                    onchainSyncedAt: Date.now(),
                } : {}),
                lastRequestTimestamp: Date.now(),
            };
        }
        return base(raw, requirements, backing, verifyResult);
    });
}

function evmBatchChannelKey(channelId: string): string {
    return `x402:batch-settlement:server:channel:${channelId.toLowerCase()}`;
}

export async function commitRawBatchCheckpoint(input: {
    paymentPayload: PaymentPayload;
    requirements: PaymentRequirements;
    amountWei: string;
    rootRunId: string;
    executionRunId: string;
    idempotencyKey?: string;
    sequence: number;
}): Promise<RawBatchCheckpointCommit> {
    const raw = getBatchPayload(input.paymentPayload);
    if (!raw) {
        throw new Error("Payment payload is not batch-settlement");
    }
    if (!isNetworkId(input.requirements.network)) {
        throw new Error("Batch-settlement requirements use an unsupported network");
    }
    const backing = resolveRawBatchBacking({
        network: input.requirements.network,
        maxAmountWei: input.paymentPayload.accepted.amount,
        paymentPayload: input.paymentPayload,
        payer: raw.channelConfig.payer,
    });
    if (
        input.requirements.scheme !== "batch-settlement"
        || input.requirements.network !== backing.network
        || !sameBinding(backing.network, input.requirements.asset, backing.asset)
        || !sameBinding(backing.network, input.requirements.payTo, backing.receiver)
    ) {
        throw new Error("Batch-settlement checkpoint requirements do not match immutable backing");
    }

    const committed = await commitRawBatchCheckpointTransition({
        backing,
        amountWei: input.amountWei,
        rootRunId: input.rootRunId,
        executionRunId: input.executionRunId,
        idempotencyKey: input.idempotencyKey,
        sequence: input.sequence,
        channelStorage: isSolanaNetwork(backing.network) || isNearNetwork(backing.network)
            ? "svm-hash"
            : "evm-json",
        channelKey: isSolanaNetwork(backing.network)
            ? svmBatchChannelKey(backing.channelId)
            : isNearNetwork(backing.network)
                ? nearBatchChannelKey(backing.channelId)
                : evmBatchChannelKey(backing.channelId),
        ...(isSolanaNetwork(backing.network)
            ? { pendingKey: SVM_BATCH_PENDING_KEY }
            : isNearNetwork(backing.network)
                ? { pendingKey: NEAR_BATCH_PENDING_KEY }
                : {}),
    });

    return {
        channelId: backing.channelId,
        cumulativeAmountWei: committed.cumulativeAmountWei,
        checkpointSequence: input.sequence,
        replayed: committed.replayed,
    };
}

function getSvmBatchPayload(paymentPayload: PaymentPayload): BatchRaw | null {
    const raw = getBatchPayload(paymentPayload);
    if (!raw) return null;
    if (paymentPayload.accepted.scheme !== "batch-settlement") {
        return null;
    }
    return raw;
}

function svmBatchChannelKey(channelId: string): string {
    return `${SVM_BATCH_PREFIX}:channel:${channelId}`;
}

function svmBatchChannelId(channelConfig: BatchRaw["channelConfig"]): string {
    const hash = createHash("sha256")
        .update(canonicalJson(channelConfig as Record<string, unknown>))
        .digest("hex");
    return `0x${hash}`;
}

function svmBatchVoucherFields(raw: BatchRaw): {
    channelId: string;
    maxClaimableAmount: string;
    signature: string;
} {
    return {
        channelId: raw.channelId || raw.voucher.channelId,
        maxClaimableAmount: raw.maxClaimableAmount || raw.voucher.maxClaimableAmount,
        signature: raw.signature || raw.voucher.signature,
    };
}

function svmBatchVoucherMessage(raw: BatchRaw): Uint8Array {
    const fields = svmBatchVoucherFields(raw);
    return utf8Bytes(canonicalJson({
        channelConfig: raw.channelConfig,
        type: raw.type,
        voucher: {
            channelId: fields.channelId,
            maxClaimableAmount: fields.maxClaimableAmount,
        },
    }));
}

function parseSvmBatchChannel(data: Record<string, string>): SvmBatchChannel | null {
    if (
        !data.channelId
        || !data.payer
        || !data.network
        || !data.asset
        || !data.payTo
        || !data.channelConfigFingerprint
        || !data.backingFingerprint
    ) {
        return null;
    }
    if (!isNetworkId(data.network) || !isSolanaNetwork(data.network)) {
        return null;
    }
    return {
        channelId: data.channelId,
        payer: data.payer,
        network: data.network,
        asset: data.asset,
        payTo: data.payTo,
        resource: data.resource || "",
        signedMaxClaimable: data.signedMaxClaimable || "0",
        chargedCumulativeAmount: data.chargedCumulativeAmount || "0",
        settledCumulativeAmount: data.settledCumulativeAmount || "0",
        balance: data.balance || data.signedMaxClaimable || "0",
        signature: data.signature || "",
        channelConfigFingerprint: data.channelConfigFingerprint,
        backingFingerprint: data.backingFingerprint,
        createdAt: Number.parseInt(data.createdAt || "0", 10) || Date.now(),
        lastRequestTimestamp: Number.parseInt(data.lastRequestTimestamp || "0", 10) || Date.now(),
        ...(data.lastTxHash ? { lastTxHash: data.lastTxHash } : {}),
    };
}

function parseSvmBatchSettlementAttempt(data: Record<string, string>): SvmBatchSettlementAttempt | null {
    const status = data.settlementAttemptStatus;
    if (!status) return null;
    if (status !== "preparing" && status !== "prepared" && status !== "submitted" && status !== "failed") {
        return null;
    }
    const settledCumulativeAmountWei = data.settlementAttemptSettledCumulativeAmount;
    const claimedCumulativeAmountWei = data.settlementAttemptClaimedCumulativeAmount;
    const deltaWei = data.settlementAttemptDelta;
    if (
        !/^\d+$/u.test(settledCumulativeAmountWei || "")
        || !/^\d+$/u.test(claimedCumulativeAmountWei || "")
        || !/^\d+$/u.test(deltaWei || "")
    ) {
        return null;
    }
    const numberField = (name: string): number | undefined => {
        const raw = data[name];
        if (!raw) return undefined;
        const parsed = Number.parseInt(raw, 10);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    };
    return {
        status,
        settledCumulativeAmountWei,
        claimedCumulativeAmountWei,
        deltaWei,
        ...(data.settlementAttemptTxHash ? { txHash: data.settlementAttemptTxHash } : {}),
        ...(data.settlementAttemptPayload ? { payload: data.settlementAttemptPayload } : {}),
        ...(data.settlementAttemptNonce ? { nonce: data.settlementAttemptNonce } : {}),
        ...(data.settlementAttemptError ? { error: data.settlementAttemptError } : {}),
        ...(numberField("settlementAttemptPreparedAt") !== undefined
            ? { preparedAt: numberField("settlementAttemptPreparedAt") }
            : {}),
        ...(numberField("settlementAttemptSubmittedAt") !== undefined
            ? { submittedAt: numberField("settlementAttemptSubmittedAt") }
            : {}),
        ...(numberField("settlementAttemptLastCheckedAt") !== undefined
            ? { lastCheckedAt: numberField("settlementAttemptLastCheckedAt") }
            : {}),
        ...(numberField("settlementAttemptFailedAt") !== undefined
            ? { failedAt: numberField("settlementAttemptFailedAt") }
            : {}),
        ...(numberField("settlementAttemptReceiptsReconciledAt") !== undefined
            ? { receiptsReconciledAt: numberField("settlementAttemptReceiptsReconciledAt") }
            : {}),
        ...(numberField("settlementAttemptReceiptsReconciledCount") !== undefined
            ? { receiptsReconciledCount: numberField("settlementAttemptReceiptsReconciledCount") }
            : {}),
        ...(numberField("settlementAttemptEvidenceReconciledAt") !== undefined
            ? { evidenceReconciledAt: numberField("settlementAttemptEvidenceReconciledAt") }
            : {}),
        ...(numberField("settlementAttemptEvidenceReconciledCount") !== undefined
            ? { evidenceReconciledCount: numberField("settlementAttemptEvidenceReconciledCount") }
            : {}),
    };
}

async function readSvmBatchSettlementWork(channelId: string): Promise<SvmBatchSettlementWork | null> {
    const data = await valkeyHGetAll(svmBatchChannelKey(channelId));
    const channel = parseSvmBatchChannel(data);
    const attempt = parseSvmBatchSettlementAttempt(data);
    return channel && attempt ? { channel, attempt } : null;
}

async function readSvmBatchChannel(channelId: string): Promise<SvmBatchChannel | null> {
    return parseSvmBatchChannel(await valkeyHGetAll(svmBatchChannelKey(channelId)));
}

async function writeSvmBatchChannel(channel: SvmBatchChannel): Promise<void> {
    await valkeyHSet(svmBatchChannelKey(channel.channelId), {
        channelId: channel.channelId,
        payer: channel.payer,
        network: channel.network,
        asset: channel.asset,
        payTo: channel.payTo,
        resource: channel.resource,
        signedMaxClaimable: channel.signedMaxClaimable,
        chargedCumulativeAmount: channel.chargedCumulativeAmount,
        settledCumulativeAmount: channel.settledCumulativeAmount,
        balance: channel.balance,
        signature: channel.signature,
        channelConfigFingerprint: channel.channelConfigFingerprint,
        backingFingerprint: channel.backingFingerprint,
        createdAt: String(channel.createdAt),
        lastRequestTimestamp: String(channel.lastRequestTimestamp),
        lastTxHash: channel.lastTxHash || "",
    });
    await valkeyExpire(svmBatchChannelKey(channel.channelId), SVM_BATCH_TTL_SECONDS);
    await valkeySAdd(SVM_BATCH_PENDING_KEY, channel.channelId);
    await valkeyExpire(SVM_BATCH_PENDING_KEY, SVM_BATCH_TTL_SECONDS);
}

export async function validateSvmBatchPayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
): Promise<SvmBatchValidation> {
    const raw = getSvmBatchPayload(paymentPayload);
    const payer = raw?.channelConfig.payer;
    if (!raw) {
        return { valid: false, invalidReason: "invalid_batch_settlement_payload" };
    }
    if (paymentPayload.accepted.scheme !== "batch-settlement" || requirements.scheme !== "batch-settlement") {
        return { valid: false, invalidReason: "unsupported_scheme", payer };
    }
    if (!isNetworkId(requirements.network) || !isSolanaNetwork(requirements.network)) {
        return { valid: false, invalidReason: "unsupported_network", payer };
    }
    if (paymentPayload.accepted.network !== requirements.network || raw.channelConfig.network !== requirements.network) {
        return { valid: false, invalidReason: "network_mismatch", payer };
    }
    if (paymentPayload.accepted.asset !== requirements.asset || raw.channelConfig.token !== requirements.asset) {
        return { valid: false, invalidReason: "asset_mismatch", payer };
    }
    if (paymentPayload.accepted.payTo !== requirements.payTo || raw.channelConfig.receiver !== requirements.payTo) {
        return { valid: false, invalidReason: "pay_to_mismatch", payer };
    }
    if (paymentPayload.resource?.url !== raw.channelConfig.resource) {
        return { valid: false, invalidReason: "resource_mismatch", payer };
    }
    if (!payer || !raw.channelConfig.salt) {
        return { valid: false, invalidReason: "invalid_channel_config", payer };
    }

    const { channelId, maxClaimableAmount, signature } = svmBatchVoucherFields(raw);
    if (!channelId || channelId !== svmBatchChannelId(raw.channelConfig)) {
        return { valid: false, invalidReason: "channel_id_mismatch", payer };
    }
    if (!positiveInteger(maxClaimableAmount) || !positiveInteger(requirements.amount)) {
        return { valid: false, invalidReason: "invalid_amount", payer };
    }

    const stored = await readSvmBatchChannel(channelId);
    const charged = BigInt(stored?.chargedCumulativeAmount || "0");
    const nextCharged = charged + BigInt(requirements.amount);
    const balance = BigInt(raw.channelConfig.balance || stored?.balance || maxClaimableAmount);
    if (BigInt(maxClaimableAmount) > balance || nextCharged > BigInt(maxClaimableAmount) || nextCharged > balance) {
        return { valid: false, invalidReason: "batch_settlement_channel_budget_exhausted", payer };
    }

    try {
        const valid = await verifySignature(
            await getPublicKeyFromAddress(solanaAddress(payer)),
            signatureFromBase58(signature),
            svmBatchVoucherMessage(raw),
        );
        if (!valid) {
            return { valid: false, invalidReason: "invalid_voucher_signature", payer };
        }
    } catch {
        return { valid: false, invalidReason: "invalid_voucher_signature", payer };
    }

    return {
        valid: true,
        payer,
        channelId,
        maxClaimableAmount,
        chargedCumulativeAmount: charged.toString(),
    };
}

export async function rememberSvmBatchChannel(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
): Promise<void> {
    const raw = getSvmBatchPayload(paymentPayload);
    if (!raw) return;
    if (!isNetworkId(requirements.network) || !isSolanaNetwork(requirements.network)) {
        throw new Error("SVM batch-settlement requirements use an unsupported network");
    }
    const backing = resolveRawBatchBacking({
        network: requirements.network,
        maxAmountWei: paymentPayload.accepted.amount,
        paymentPayload,
        payer: raw.channelConfig.payer,
    });

    const { channelId, maxClaimableAmount } = svmBatchVoucherFields(raw);
    const existing = await readSvmBatchChannel(channelId);
    if (existing && (
        existing.network !== backing.network
        || existing.payer !== backing.payer
        || existing.asset !== backing.asset
        || existing.payTo !== backing.receiver
        || existing.resource !== backing.resource
        || existing.channelConfigFingerprint !== backing.channelConfigFingerprint
    )) {
        throw new Error("SVM batch-settlement channel immutable backing mismatch");
    }
    const now = Date.now();
    await writeSvmBatchChannel({
        channelId: backing.channelId,
        payer: backing.payer,
        network: backing.network as SolanaNetworkId,
        asset: backing.asset,
        payTo: backing.receiver,
        resource: backing.resource,
        signedMaxClaimable: backing.signedMaxClaimable,
        chargedCumulativeAmount: existing?.chargedCumulativeAmount || "0",
        settledCumulativeAmount: existing?.settledCumulativeAmount || "0",
        balance: raw.channelConfig.balance || existing?.balance || maxClaimableAmount,
        signature: backing.voucherSignature,
        channelConfigFingerprint: backing.channelConfigFingerprint,
        backingFingerprint: backing.backingFingerprint,
        createdAt: existing?.createdAt || now,
        lastRequestTimestamp: now,
        ...(existing?.lastTxHash ? { lastTxHash: existing.lastTxHash } : {}),
    });
}

export async function commitSvmBatchCharge(
    paymentPayload: PaymentPayload,
    amountWei: string,
    requirements: PaymentRequirements,
): Promise<BatchCommit> {
    const raw = getSvmBatchPayload(paymentPayload);
    if (!raw) {
        throw new Error("Payment payload is not batch-settlement");
    }
    const validation = await validateSvmBatchPayment(paymentPayload, requirements);
    if (!validation.valid) {
        throw new Error(validation.invalidReason);
    }

    await rememberSvmBatchChannel(paymentPayload, requirements);
    const { channelId, maxClaimableAmount } = svmBatchVoucherFields(raw);
    const existing = await readSvmBatchChannel(channelId);
    if (!existing) {
        throw new Error("batch-settlement channel not found");
    }
    const current = BigInt(existing.chargedCumulativeAmount || "0");
    const amount = BigInt(amountWei);
    const next = amount === 0n ? current : current + amount;
    const balance = BigInt(existing.balance || maxClaimableAmount);
    if (next > BigInt(maxClaimableAmount) || next > balance) {
        throw new Error("batch-settlement channel budget exhausted");
    }
    await writeSvmBatchChannel({
        ...existing,
        signedMaxClaimable: maxClaimableAmount,
        chargedCumulativeAmount: next.toString(),
        lastRequestTimestamp: Date.now(),
    });
    return {
        channelId,
        cumulativeAmountWei: next.toString(),
    };
}

async function runSvmBatchStoreScript(
    script: string,
    keys: string[],
    args: string[],
): Promise<number> {
    const client = await getValkeyClient();
    return Number(await client.eval(script, keys.length, ...keys, ...args));
}

const ACQUIRE_SVM_BATCH_ATTEMPT_SCRIPT = `
local function normalize(value)
  if not value or not string.match(value, "^%d+$") then return nil end
  value = string.gsub(value, "^0+", "")
  if value == "" then return "0" end
  return value
end
local function compare(left, right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) < string.len(right) and -1 or 1
  end
  if left == right then return 0 end
  return left < right and -1 or 1
end
local function subtract(left, right)
  local carry = 0
  local output = {}
  local li = string.len(left)
  local ri = string.len(right)
  while li > 0 do
    local digit = tonumber(string.sub(left, li, li)) - carry
    local rightDigit = ri > 0 and tonumber(string.sub(right, ri, ri)) or 0
    if digit < rightDigit then
      digit = digit + 10
      carry = 1
    else
      carry = 0
    end
    table.insert(output, 1, tostring(digit - rightDigit))
    li = li - 1
    ri = ri - 1
  end
  local value = table.concat(output)
  value = string.gsub(value, "^0+", "")
  if value == "" then return "0" end
  return value
end

if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("SREM", KEYS[2], ARGV[4])
  return 0
end
local status = redis.call("HGET", KEYS[1], "settlementAttemptStatus") or ""
if status == "failed" then return 3 end
if status ~= "" and status ~= "preparing" and status ~= "prepared" and status ~= "submitted" then return -1 end
local owner = redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") or ""
local ownerExpiresAt = tonumber(redis.call("HGET", KEYS[1], "settlementAttemptOwnerExpiresAt") or "0")
if owner ~= "" and owner ~= ARGV[1] and ownerExpiresAt > tonumber(ARGV[2]) then return 2 end

if status == "" then
  local charged = normalize(redis.call("HGET", KEYS[1], "chargedCumulativeAmount") or "0")
  local settled = normalize(redis.call("HGET", KEYS[1], "settledCumulativeAmount") or "0")
  if not charged or not settled then return -2 end
  if compare(charged, settled) <= 0 then
    redis.call("SREM", KEYS[2], ARGV[4])
    return 1
  end
  redis.call("HSET", KEYS[1],
    "settlementAttemptStatus", "preparing",
    "settlementAttemptSettledCumulativeAmount", settled,
    "settlementAttemptClaimedCumulativeAmount", charged,
    "settlementAttemptDelta", subtract(charged, settled))
end
redis.call("HSET", KEYS[1],
  "settlementAttemptOwnerToken", ARGV[1],
  "settlementAttemptOwnerExpiresAt", ARGV[3])
redis.call("SADD", KEYS[2], ARGV[4])
redis.call("EXPIRE", KEYS[1], ARGV[5])
redis.call("EXPIRE", KEYS[2], ARGV[5])
return 4
`;

const PERSIST_PREPARED_SVM_BATCH_ATTEMPT_SCRIPT = `
if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= "preparing" then return 0 end
if redis.call("HGET", KEYS[1], "network") ~= ARGV[2] then return -1 end
if ARGV[3] == "" or ARGV[4] == "" then return -2 end
redis.call("HSET", KEYS[1],
  "settlementAttemptStatus", "prepared",
  "settlementAttemptTxHash", ARGV[3],
  "settlementAttemptPayload", ARGV[4],
  "settlementAttemptNonce", ARGV[5],
  "settlementAttemptPreparedAt", ARGV[6])
redis.call("HDEL", KEYS[1],
  "settlementAttemptError",
  "settlementAttemptSubmittedAt",
  "settlementAttemptLastCheckedAt",
  "settlementAttemptFailedAt",
  "settlementAttemptReceiptsReconciledAt",
  "settlementAttemptReceiptsReconciledCount",
  "settlementAttemptEvidenceReconciledAt",
  "settlementAttemptEvidenceReconciledCount")
redis.call("EXPIRE", KEYS[1], ARGV[7])
return 1
`;

const MARK_SUBMITTED_SVM_BATCH_ATTEMPT_SCRIPT = `
if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= "prepared" then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptTxHash") ~= ARGV[2] then return -1 end
if (redis.call("HGET", KEYS[1], "settlementAttemptPayload") or "") == "" then return -2 end
redis.call("HSET", KEYS[1],
  "settlementAttemptStatus", "submitted",
  "settlementAttemptSubmittedAt", ARGV[3])
if ARGV[4] == "" then
  redis.call("HDEL", KEYS[1], "settlementAttemptError")
else
  redis.call("HSET", KEYS[1], "settlementAttemptError", ARGV[4])
end
redis.call("EXPIRE", KEYS[1], ARGV[5])
return 1
`;

const RELEASE_SVM_BATCH_ATTEMPT_CLAIM_SCRIPT = `
if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= ARGV[2] then return 0 end
redis.call("HSET", KEYS[1],
  "settlementAttemptLastCheckedAt", ARGV[3],
  "settlementAttemptError", ARGV[4])
redis.call("HDEL", KEYS[1], "settlementAttemptOwnerToken", "settlementAttemptOwnerExpiresAt")
redis.call("SADD", KEYS[2], ARGV[5])
redis.call("EXPIRE", KEYS[1], ARGV[6])
redis.call("EXPIRE", KEYS[2], ARGV[6])
return 1
`;

const ABANDON_SVM_BATCH_PREPARATION_SCRIPT = `
if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= "preparing" then return 0 end
redis.call("HSET", KEYS[1],
  "settlementLastError", ARGV[2],
  "settlementLastCheckedAt", ARGV[3])
redis.call("HDEL", KEYS[1],
  "settlementAttemptStatus",
  "settlementAttemptSettledCumulativeAmount",
  "settlementAttemptClaimedCumulativeAmount",
  "settlementAttemptDelta",
  "settlementAttemptTxHash",
  "settlementAttemptPayload",
  "settlementAttemptNonce",
  "settlementAttemptError",
  "settlementAttemptPreparedAt",
  "settlementAttemptSubmittedAt",
  "settlementAttemptLastCheckedAt",
  "settlementAttemptFailedAt",
  "settlementAttemptReceiptsReconciledAt",
  "settlementAttemptReceiptsReconciledCount",
  "settlementAttemptEvidenceReconciledAt",
  "settlementAttemptEvidenceReconciledCount",
  "settlementAttemptOwnerToken",
  "settlementAttemptOwnerExpiresAt")
redis.call("SADD", KEYS[2], ARGV[4])
redis.call("EXPIRE", KEYS[1], ARGV[5])
redis.call("EXPIRE", KEYS[2], ARGV[5])
return 1
`;

const MARK_RECONCILED_SVM_BATCH_ATTEMPT_SCRIPT = `
if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= "submitted" then return 0 end
if ARGV[2] == "receipts" then
  redis.call("HSET", KEYS[1],
    "settlementAttemptReceiptsReconciledCount", ARGV[3],
    "settlementAttemptReceiptsReconciledAt", ARGV[4])
elseif ARGV[2] == "evidence" then
  redis.call("HSET", KEYS[1],
    "settlementAttemptEvidenceReconciledCount", ARGV[3],
    "settlementAttemptEvidenceReconciledAt", ARGV[4])
else
  return -1
end
redis.call("EXPIRE", KEYS[1], ARGV[5])
return 1
`;

const MARK_FAILED_SVM_BATCH_ATTEMPT_SCRIPT = `
if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= "submitted" then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptTxHash") ~= ARGV[2] then return -1 end
redis.call("HSET", KEYS[1],
  "settlementAttemptStatus", "failed",
  "settlementAttemptFailedAt", ARGV[3],
  "settlementAttemptLastCheckedAt", ARGV[3],
  "settlementAttemptError", ARGV[4])
redis.call("HDEL", KEYS[1], "settlementAttemptOwnerToken", "settlementAttemptOwnerExpiresAt")
redis.call("SADD", KEYS[2], ARGV[5])
redis.call("EXPIRE", KEYS[1], ARGV[6])
redis.call("EXPIRE", KEYS[2], ARGV[6])
return 1
`;

const COMPLETE_CONFIRMED_SVM_BATCH_ATTEMPT_SCRIPT = `
local function normalize(value)
  if not value or not string.match(value, "^%d+$") then return nil end
  value = string.gsub(value, "^0+", "")
  if value == "" then return "0" end
  return value
end
local function compare(left, right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) < string.len(right) and -1 or 1
  end
  if left == right then return 0 end
  return left < right and -1 or 1
end

if redis.call("HGET", KEYS[1], "settlementAttemptOwnerToken") ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptStatus") ~= "submitted" then return 0 end
if redis.call("HGET", KEYS[1], "settlementAttemptTxHash") ~= ARGV[2] then return -1 end
if (redis.call("HGET", KEYS[1], "settlementAttemptReceiptsReconciledAt") or "") == "" then return -2 end
if (redis.call("HGET", KEYS[1], "settlementAttemptEvidenceReconciledAt") or "") == "" then return -3 end
local settled = normalize(redis.call("HGET", KEYS[1], "settledCumulativeAmount") or "0")
local expectedSettled = normalize(redis.call("HGET", KEYS[1], "settlementAttemptSettledCumulativeAmount") or "")
local claimed = normalize(redis.call("HGET", KEYS[1], "settlementAttemptClaimedCumulativeAmount") or "")
local charged = normalize(redis.call("HGET", KEYS[1], "chargedCumulativeAmount") or "0")
if not settled or not expectedSettled or not claimed or not charged then return -4 end
if settled ~= expectedSettled or compare(claimed, settled) < 0 or compare(claimed, charged) > 0 then return -5 end
redis.call("HSET", KEYS[1],
  "settledCumulativeAmount", claimed,
  "lastTxHash", ARGV[2],
  "lastRequestTimestamp", ARGV[3])
redis.call("HDEL", KEYS[1],
  "settlementAttemptStatus",
  "settlementAttemptSettledCumulativeAmount",
  "settlementAttemptClaimedCumulativeAmount",
  "settlementAttemptDelta",
  "settlementAttemptTxHash",
  "settlementAttemptPayload",
  "settlementAttemptNonce",
  "settlementAttemptError",
  "settlementAttemptPreparedAt",
  "settlementAttemptSubmittedAt",
  "settlementAttemptLastCheckedAt",
  "settlementAttemptFailedAt",
  "settlementAttemptReceiptsReconciledAt",
  "settlementAttemptReceiptsReconciledCount",
  "settlementAttemptEvidenceReconciledAt",
  "settlementAttemptEvidenceReconciledCount",
  "settlementAttemptOwnerToken",
  "settlementAttemptOwnerExpiresAt")
redis.call("EXPIRE", KEYS[1], ARGV[5])
if compare(charged, claimed) > 0 then
  redis.call("SADD", KEYS[2], ARGV[4])
  redis.call("EXPIRE", KEYS[2], ARGV[5])
  return 2
end
redis.call("SREM", KEYS[2], ARGV[4])
return 1
`;

function requireSvmBatchStoreSuccess(code: number, operation: string): boolean {
    if (code === 1) return true;
    if (code === 0) return false;
    throw new Error(`SVM batch settlement ${operation} rejected inconsistent durable state (${code})`);
}

const valkeySvmBatchSettlementStore: SvmBatchSettlementStore = {
    listPendingChannelIds: () => valkeySMembers(SVM_BATCH_PENDING_KEY),
    async acquireAttempt(input) {
        const code = await runSvmBatchStoreScript(
            ACQUIRE_SVM_BATCH_ATTEMPT_SCRIPT,
            [svmBatchChannelKey(input.channelId), SVM_BATCH_PENDING_KEY],
            [
                input.ownerToken,
                String(input.now),
                String(input.ownerExpiresAt),
                input.channelId,
                String(SVM_BATCH_TTL_SECONDS),
            ],
        );
        if (code === 0) return { outcome: "missing" };
        if (code === 1) return { outcome: "settled" };
        const work = await readSvmBatchSettlementWork(input.channelId);
        if (!work) throw new Error(`SVM batch settlement channel ${input.channelId} has unreadable attempt state`);
        if (code === 2) return { outcome: "busy", work };
        if (code === 3) return { outcome: "failed", work };
        if (code === 4) return { outcome: "acquired", work };
        throw new Error(`SVM batch settlement acquisition rejected inconsistent durable state (${code})`);
    },
    async persistPreparedAttempt(input) {
        const code = await runSvmBatchStoreScript(
            PERSIST_PREPARED_SVM_BATCH_ATTEMPT_SCRIPT,
            [svmBatchChannelKey(input.channelId)],
            [
                input.ownerToken,
                input.prepared.network,
                input.prepared.txHash,
                input.prepared.payload,
                input.prepared.nonce || "",
                String(input.preparedAt),
                String(SVM_BATCH_TTL_SECONDS),
            ],
        );
        if (!requireSvmBatchStoreSuccess(code, "prepared transaction persistence")) return null;
        return readSvmBatchSettlementWork(input.channelId);
    },
    async markAttemptSubmitted(input) {
        const code = await runSvmBatchStoreScript(
            MARK_SUBMITTED_SVM_BATCH_ATTEMPT_SCRIPT,
            [svmBatchChannelKey(input.channelId)],
            [
                input.ownerToken,
                input.txHash,
                String(input.submittedAt),
                input.error || "",
                String(SVM_BATCH_TTL_SECONDS),
            ],
        );
        if (!requireSvmBatchStoreSuccess(code, "submitted transition")) return null;
        return readSvmBatchSettlementWork(input.channelId);
    },
    async releaseAttemptClaim(input) {
        return requireSvmBatchStoreSuccess(await runSvmBatchStoreScript(
            RELEASE_SVM_BATCH_ATTEMPT_CLAIM_SCRIPT,
            [svmBatchChannelKey(input.channelId), SVM_BATCH_PENDING_KEY],
            [
                input.ownerToken,
                input.expectedStatus,
                String(input.checkedAt),
                input.error,
                input.channelId,
                String(SVM_BATCH_TTL_SECONDS),
            ],
        ), "claim release");
    },
    async abandonPreparation(input) {
        return requireSvmBatchStoreSuccess(await runSvmBatchStoreScript(
            ABANDON_SVM_BATCH_PREPARATION_SCRIPT,
            [svmBatchChannelKey(input.channelId), SVM_BATCH_PENDING_KEY],
            [
                input.ownerToken,
                input.error,
                String(input.abandonedAt),
                input.channelId,
                String(SVM_BATCH_TTL_SECONDS),
            ],
        ), "preparation abandonment");
    },
    async markAttemptReconciled(input) {
        const code = await runSvmBatchStoreScript(
            MARK_RECONCILED_SVM_BATCH_ATTEMPT_SCRIPT,
            [svmBatchChannelKey(input.channelId)],
            [
                input.ownerToken,
                input.kind,
                String(input.count),
                String(input.reconciledAt),
                String(SVM_BATCH_TTL_SECONDS),
            ],
        );
        if (!requireSvmBatchStoreSuccess(code, `${input.kind} reconciliation`)) return null;
        return readSvmBatchSettlementWork(input.channelId);
    },
    async markAttemptFailed(input) {
        const code = await runSvmBatchStoreScript(
            MARK_FAILED_SVM_BATCH_ATTEMPT_SCRIPT,
            [svmBatchChannelKey(input.channelId), SVM_BATCH_PENDING_KEY],
            [
                input.ownerToken,
                input.txHash,
                String(input.failedAt),
                input.error,
                input.channelId,
                String(SVM_BATCH_TTL_SECONDS),
            ],
        );
        if (!requireSvmBatchStoreSuccess(code, "failed transition")) return null;
        return readSvmBatchSettlementWork(input.channelId);
    },
    async completeConfirmedAttempt(input) {
        const code = await runSvmBatchStoreScript(
            COMPLETE_CONFIRMED_SVM_BATCH_ATTEMPT_SCRIPT,
            [svmBatchChannelKey(input.channelId), SVM_BATCH_PENDING_KEY],
            [
                input.ownerToken,
                input.txHash,
                String(input.completedAt),
                input.channelId,
                String(SVM_BATCH_TTL_SECONDS),
            ],
        );
        if (code === 1) return { completed: true, hasMore: false };
        if (code === 2) return { completed: true, hasMore: true };
        if (code === 0) return { completed: false, hasMore: true };
        throw new Error(`SVM batch settlement atomic completion rejected inconsistent durable state (${code})`);
    },
};

const SVM_BATCH_ATTEMPT_CLAIM_MS = 60_000;

function svmBatchResult(
    work: SvmBatchSettlementWork,
    overrides: Partial<SvmBatchSettlementResult> = {},
): SvmBatchSettlementResult {
    return {
        channelId: work.channel.channelId,
        payer: work.channel.payer,
        network: work.channel.network,
        settledAmountWei: "0",
        claimedAmountWei: work.attempt.claimedCumulativeAmountWei,
        txHash: work.attempt.txHash || "",
        reconciledReceipts: work.attempt.receiptsReconciledCount || 0,
        reconciledEvidence: work.attempt.evidenceReconciledCount || 0,
        ...overrides,
    };
}

function preparedSvmBatchTransaction(work: SvmBatchSettlementWork): PreparedSettlementTransaction | null {
    const { attempt, channel } = work;
    if (!attempt.txHash || !attempt.payload) return null;
    return {
        network: channel.network,
        txHash: attempt.txHash,
        payload: attempt.payload,
        ...(attempt.nonce ? { nonce: attempt.nonce } : {}),
    };
}

async function runInjectedSvmBatchSettlement(
    dependencies: SvmBatchSettlementDependencies,
): Promise<SvmBatchSettlementSummary> {
    const startedAt = dependencies.now();
    const runId = `svm-batch-${startedAt}`;
    const channelIds = await dependencies.store.listPendingChannelIds();
    const channels: SvmBatchSettlementResult[] = [];

    for (const channelId of channelIds) {
        const ownerToken = dependencies.createOwnerToken();
        const acquiredAt = dependencies.now();
        const acquisition = await dependencies.store.acquireAttempt({
            channelId,
            ownerToken,
            now: acquiredAt,
            ownerExpiresAt: acquiredAt + SVM_BATCH_ATTEMPT_CLAIM_MS,
        });
        if (acquisition.outcome !== "acquired") {
            if (acquisition.outcome === "failed") {
                channels.push(svmBatchResult(acquisition.work, {
                    error: acquisition.work.attempt.error || "SVM batch settlement failed on-chain",
                }));
            }
            continue;
        }

        let work = acquisition.work;
        if (work.attempt.status === "preparing") {
            const preparation = await dependencies.prepareKeyPaymentForNetwork(
                work.channel.payer,
                work.attempt.deltaWei,
                work.channel.network,
            );
            if (!preparation.success) {
                const error = preparation.result.error || "SVM batch settlement preparation failed";
                await dependencies.store.abandonPreparation({
                    channelId,
                    ownerToken,
                    error,
                    abandonedAt: dependencies.now(),
                });
                channels.push(svmBatchResult(work, { error }));
                continue;
            }
            if (
                preparation.prepared.network !== work.channel.network
                || !preparation.prepared.txHash
                || !preparation.prepared.payload
            ) {
                const error = "Prepared SVM batch transaction identity does not match its channel";
                await dependencies.store.abandonPreparation({
                    channelId,
                    ownerToken,
                    error,
                    abandonedAt: dependencies.now(),
                });
                channels.push(svmBatchResult(work, { error }));
                continue;
            }
            const persisted = await dependencies.store.persistPreparedAttempt({
                channelId,
                ownerToken,
                prepared: preparation.prepared,
                preparedAt: dependencies.now(),
            });
            if (!persisted) continue;
            work = persisted;
        }

        if (work.attempt.status === "prepared") {
            const prepared = preparedSvmBatchTransaction(work);
            if (!prepared) {
                const error = "Prepared SVM batch attempt is missing its exact signed transaction identity";
                await dependencies.store.releaseAttemptClaim({
                    channelId,
                    ownerToken,
                    expectedStatus: "prepared",
                    checkedAt: dependencies.now(),
                    error,
                });
                channels.push(svmBatchResult(work, { error }));
                continue;
            }

            let broadcast: SettlementResult;
            try {
                broadcast = await dependencies.broadcastPreparedKeyPaymentForNetwork(prepared);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await dependencies.store.releaseAttemptClaim({
                    channelId,
                    ownerToken,
                    expectedStatus: "prepared",
                    checkedAt: dependencies.now(),
                    error: message,
                });
                channels.push(svmBatchResult(work, { txHash: prepared.txHash, error: message }));
                continue;
            }

            if (broadcast.status !== "submitted" || broadcast.txHash !== prepared.txHash) {
                const error = broadcast.txHash && broadcast.txHash !== prepared.txHash
                    ? `Broadcast returned transaction identity ${broadcast.txHash} for prepared identity ${prepared.txHash}`
                    : broadcast.error || "Prepared SVM batch transaction broadcast is not durably submitted";
                await dependencies.store.releaseAttemptClaim({
                    channelId,
                    ownerToken,
                    expectedStatus: "prepared",
                    checkedAt: dependencies.now(),
                    error,
                });
                channels.push(svmBatchResult(work, { txHash: prepared.txHash, error }));
                continue;
            }
            const submitted = await dependencies.store.markAttemptSubmitted({
                channelId,
                ownerToken,
                txHash: prepared.txHash,
                submittedAt: dependencies.now(),
                ...(broadcast.error ? { error: broadcast.error } : {}),
            });
            if (!submitted) continue;
            work = submitted;
        }

        if (work.attempt.status !== "submitted" || !work.attempt.txHash) {
            channels.push(svmBatchResult(work, {
                error: work.attempt.error || "SVM batch settlement attempt is not reconcilable",
            }));
            continue;
        }
        const submittedTxHash = work.attempt.txHash;

        let reconciliation: SettlementResult;
        try {
            reconciliation = await dependencies.reconcileKeyPaymentForNetwork(
                submittedTxHash,
                work.channel.network,
            );
        } catch (error) {
            reconciliation = {
                success: false,
                status: "submitted",
                txHash: submittedTxHash,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        if (reconciliation.txHash && reconciliation.txHash !== submittedTxHash) {
            const error = `Reconciliation returned transaction identity ${reconciliation.txHash} for submitted identity ${submittedTxHash}`;
            await dependencies.store.releaseAttemptClaim({
                channelId,
                ownerToken,
                expectedStatus: "submitted",
                checkedAt: dependencies.now(),
                error,
            });
            channels.push(svmBatchResult(work, { error }));
            continue;
        }
        if (!reconciliation.success && reconciliation.status === "failed" && reconciliation.terminal) {
            const error = reconciliation.error || "SVM batch settlement failed on-chain";
            const failed = await dependencies.store.markAttemptFailed({
                channelId,
                ownerToken,
                txHash: submittedTxHash,
                failedAt: dependencies.now(),
                error,
            });
            if (failed) {
                channels.push(svmBatchResult(failed, { error }));
            }
            continue;
        }
        if (!reconciliation.success || reconciliation.status !== "confirmed") {
            const error = reconciliation.error || "SVM batch settlement confirmation is pending";
            await dependencies.store.releaseAttemptClaim({
                channelId,
                ownerToken,
                expectedStatus: "submitted",
                checkedAt: dependencies.now(),
                error,
            });
            channels.push(svmBatchResult(work, { error }));
            continue;
        }

        try {
            if (!work.attempt.receiptsReconciledAt) {
                const count = await dependencies.markBatchReceiptsSettled({
                    channelId,
                    claimedAmountWei: work.attempt.claimedCumulativeAmountWei,
                    network: work.channel.network,
                    claimTxHash: submittedTxHash,
                    settleTxHash: submittedTxHash,
                });
                const reconciled = await dependencies.store.markAttemptReconciled({
                    channelId,
                    ownerToken,
                    kind: "receipts",
                    count,
                    reconciledAt: dependencies.now(),
                });
                if (!reconciled) continue;
                work = reconciled;
            }
            if (!work.attempt.evidenceReconciledAt) {
                const count = await dependencies.markBatchEvidenceSettled({
                    channelId,
                    claimedAmountWei: work.attempt.claimedCumulativeAmountWei,
                    claimTxHash: submittedTxHash,
                    settleTxHash: submittedTxHash,
                    network: work.channel.network,
                });
                const reconciled = await dependencies.store.markAttemptReconciled({
                    channelId,
                    ownerToken,
                    kind: "evidence",
                    count,
                    reconciledAt: dependencies.now(),
                });
                if (!reconciled) continue;
                work = reconciled;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await dependencies.store.releaseAttemptClaim({
                channelId,
                ownerToken,
                expectedStatus: "submitted",
                checkedAt: dependencies.now(),
                error: message,
            });
            channels.push(svmBatchResult(work, { error: message }));
            continue;
        }

        const completed = await dependencies.store.completeConfirmedAttempt({
            channelId,
            ownerToken,
            txHash: submittedTxHash,
            completedAt: dependencies.now(),
        });
        if (!completed.completed) {
            const error = "Confirmed SVM batch settlement lost its atomic completion claim";
            await dependencies.store.releaseAttemptClaim({
                channelId,
                ownerToken,
                expectedStatus: "submitted",
                checkedAt: dependencies.now(),
                error,
            });
            channels.push(svmBatchResult(work, { error }));
            continue;
        }
        channels.push(svmBatchResult(work, {
            settledAmountWei: work.attempt.deltaWei,
            txHash: submittedTxHash,
        }));
    }

    return {
        runId,
        startedAt,
        finishedAt: dependencies.now(),
        channels,
    };
}

const defaultSvmBatchSettlementDependencies: SvmBatchSettlementDependencies = {
    store: valkeySvmBatchSettlementStore,
    prepareKeyPaymentForNetwork,
    broadcastPreparedKeyPaymentForNetwork,
    reconcileKeyPaymentForNetwork,
    markBatchReceiptsSettled,
    markBatchEvidenceSettled,
    now: Date.now,
    createOwnerToken: randomUUID,
};

export async function runSvmBatchSettlement(
    dependencies?: SvmBatchSettlementDependencies,
): Promise<SvmBatchSettlementSummary> {
    const store = dependencies?.store || defaultSvmBatchSettlementDependencies.store;
    return runInjectedSvmBatchSettlement({
        ...defaultSvmBatchSettlementDependencies,
        ...dependencies,
        store,
    });
}

export function queuedBatchSettlement(
    amountWei: string,
    network: string,
    batch: BatchCommit,
    payer?: string,
): SettleResponse {
    return {
        success: true,
        transaction: "",
        network: network as `${string}:${string}`,
        amount: amountWei,
        ...(payer ? { payer } : {}),
        extra: {
            settlementStatus: "queued",
            batchSettlementAddress: BATCH_SETTLEMENT_ADDRESS,
            channelId: batch.channelId,
            cumulativeAmountWei: batch.cumulativeAmountWei,
        },
    };
}

export function supportsNativeBatchSettlement(network: EvmNetworkId): boolean {
    return Boolean(getNetwork(network).asset.address);
}

// =============================================================================
// NEAR Batch-Settlement
// =============================================================================

type NearBatchValidation = {
    valid: true;
    payer: string;
    channelId: string;
    maxClaimableAmount: string;
    chargedCumulativeAmount: string;
} | {
    valid: false;
    invalidReason: string;
    payer?: string;
};

export type NearBatchChannel = {
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

export type NearBatchSettlementAttempt = SvmBatchSettlementAttempt;

export type NearBatchSettlementWork = {
    channel: NearBatchChannel;
    attempt: NearBatchSettlementAttempt;
};

export type NearBatchSettlementAcquisition =
    | { outcome: "missing" | "settled" }
    | { outcome: "busy" | "failed" | "acquired"; work: NearBatchSettlementWork };

export interface NearBatchSettlementStore {
    listPendingChannelIds(): Promise<string[]>;
    acquireAttempt(input: {
        channelId: string;
        ownerToken: string;
        now: number;
        ownerExpiresAt: number;
    }): Promise<NearBatchSettlementAcquisition>;
    persistPreparedAttempt(input: {
        channelId: string;
        ownerToken: string;
        prepared: PreparedSettlementTransaction;
        preparedAt: number;
    }): Promise<NearBatchSettlementWork | null>;
    markAttemptSubmitted(input: {
        channelId: string;
        ownerToken: string;
        txHash: string;
        submittedAt: number;
        error?: string;
    }): Promise<NearBatchSettlementWork | null>;
    releaseAttemptClaim(input: {
        channelId: string;
        ownerToken: string;
        expectedStatus: "prepared" | "submitted";
        checkedAt: number;
        error: string;
    }): Promise<boolean>;
    abandonPreparation(input: {
        channelId: string;
        ownerToken: string;
        error: string;
        abandonedAt: number;
    }): Promise<boolean>;
    markAttemptReconciled(input: {
        channelId: string;
        ownerToken: string;
        kind: "receipts" | "evidence";
        count: number;
        reconciledAt: number;
    }): Promise<NearBatchSettlementWork | null>;
    markAttemptFailed(input: {
        channelId: string;
        ownerToken: string;
        txHash: string;
        failedAt: number;
        error: string;
    }): Promise<NearBatchSettlementWork | null>;
    completeConfirmedAttempt(input: {
        channelId: string;
        ownerToken: string;
        txHash: string;
        completedAt: number;
    }): Promise<{ completed: boolean; hasMore: boolean }>;
}

export type NearBatchSettlementResult = {
    channelId: string;
    payer: string;
    network: NearNetworkId;
    settledAmountWei: string;
    claimedAmountWei: string;
    txHash: string;
    reconciledReceipts: number;
    reconciledEvidence: number;
    error?: string;
};

export type NearBatchSettlementSummary = {
    runId: string;
    startedAt: number;
    finishedAt: number;
    channels: NearBatchSettlementResult[];
};

export type NearBatchSettlementDependencies = {
    store: NearBatchSettlementStore;
    prepareKeyPaymentForNetwork: (
        payer: string,
        amountWei: string,
        network: NetworkId,
    ) => Promise<SettlementPreparationResult>;
    broadcastPreparedKeyPaymentForNetwork: (
        prepared: PreparedSettlementTransaction,
    ) => Promise<SettlementResult>;
    reconcileKeyPaymentForNetwork: (
        txHash: string,
        network: NetworkId,
        options?: { wait?: boolean; userAddress?: string; preparedTxPayload?: string },
    ) => Promise<SettlementResult>;
    markBatchReceiptsSettled: typeof markBatchReceiptsSettled;
    markBatchEvidenceSettled: typeof markBatchEvidenceSettled;
    now: () => number;
    createOwnerToken: () => string;
};

const NEAR_BATCH_PREFIX = "x402:batch-settlement:near";
const NEAR_BATCH_PENDING_KEY = `${NEAR_BATCH_PREFIX}:pending`;
const NEAR_BATCH_TTL_SECONDS = 60 * 60 * 24;
const NEAR_BATCH_ATTEMPT_CLAIM_MS = 60_000;

function nearBatchChannelKey(channelId: string): string {
    return `${NEAR_BATCH_PREFIX}:channel:${channelId}`;
}

function decodeNearSignatureBytes(signature: string): Uint8Array | null {
    const trimmed = signature.trim();
    if (!trimmed) return null;
    const raw = trimmed.startsWith("ed25519:") ? trimmed.slice("ed25519:".length) : trimmed;
    try {
        const decoded = base58.decode(raw);
        if (decoded.length === 64) {
            return decoded;
        }
    } catch {
        // Fallback to base64
    }
    try {
        const decoded = Uint8Array.from(Buffer.from(raw, "base64"));
        if (decoded.length === 64) {
            return decoded;
        }
    } catch {
        // Invalid encoding
    }
    return null;
}

export async function verifyNearDetachedSignature(input: {
    network: NearNetworkId;
    payer: string;
    signature: string;
    message: Uint8Array;
    publicKeyHint?: string;
}): Promise<boolean> {
    const sigBytes = decodeNearSignatureBytes(input.signature);
    if (!sigBytes) {
        return false;
    }

    if (/^[0-9a-f]{64}$/.test(input.payer)) {
        try {
            const publicKey = new PublicKey({
                keyType: KeyType.ED25519,
                data: new Uint8Array(Buffer.from(input.payer, "hex")),
            });
            return publicKey.verify(input.message, sigBytes);
        } catch {
            return false;
        }
    }

    let hintedKey: PublicKey | null = null;
    if (input.publicKeyHint) {
        try {
            hintedKey = PublicKey.fromString(input.publicKeyHint);
            if (!hintedKey.verify(input.message, sigBytes)) {
                return false;
            }
        } catch {
            return false;
        }
    }

    try {
        const provider = new JsonRpcProvider({ url: getNetworkRpcUrl(input.network) });
        const keyList = await provider.viewAccessKeyList(input.payer, { finality: "final" });
        const hintedKeyStr = hintedKey?.toString();
        for (const entry of keyList.keys ?? []) {
            if (hintedKeyStr && entry.public_key !== hintedKeyStr) {
                continue;
            }
            try {
                const publicKey = PublicKey.fromString(entry.public_key);
                if (publicKey.verify(input.message, sigBytes)) {
                    return true;
                }
            } catch {
                // Continue checking remaining access keys
            }
        }
        return false;
    } catch {
        return false;
    }
}

function parseNearBatchChannel(data: Record<string, string>): NearBatchChannel | null {
    if (
        !data.channelId
        || !data.payer
        || !data.network
        || !data.asset
        || !data.payTo
        || !data.channelConfigFingerprint
        || !data.backingFingerprint
    ) {
        return null;
    }
    if (!isNetworkId(data.network) || !isNearNetwork(data.network)) {
        return null;
    }
    return {
        channelId: data.channelId,
        payer: data.payer,
        network: data.network,
        asset: data.asset,
        payTo: data.payTo,
        resource: data.resource || "",
        signedMaxClaimable: data.signedMaxClaimable || "0",
        chargedCumulativeAmount: data.chargedCumulativeAmount || "0",
        settledCumulativeAmount: data.settledCumulativeAmount || "0",
        balance: data.balance || data.signedMaxClaimable || "0",
        signature: data.signature || "",
        channelConfigFingerprint: data.channelConfigFingerprint,
        backingFingerprint: data.backingFingerprint,
        createdAt: Number.parseInt(data.createdAt || "0", 10) || Date.now(),
        lastRequestTimestamp: Number.parseInt(data.lastRequestTimestamp || "0", 10) || Date.now(),
        ...(data.lastTxHash ? { lastTxHash: data.lastTxHash } : {}),
    };
}

async function readNearBatchSettlementWork(channelId: string): Promise<NearBatchSettlementWork | null> {
    const data = await valkeyHGetAll(nearBatchChannelKey(channelId));
    const channel = parseNearBatchChannel(data);
    const attempt = parseSvmBatchSettlementAttempt(data);
    return channel && attempt ? { channel, attempt } : null;
}

async function readNearBatchChannel(channelId: string): Promise<NearBatchChannel | null> {
    return parseNearBatchChannel(await valkeyHGetAll(nearBatchChannelKey(channelId)));
}
