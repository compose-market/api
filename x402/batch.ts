import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS, DEFAULT_STABLECOINS, getDefaultAsset } from "@x402/evm";
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
import { createHash } from "node:crypto";

import {
    getNetwork,
    isNetworkId,
    isSolanaNetwork,
    type NetworkId,
    type SolanaNetworkId,
} from "./configs/chains.js";
import { settleKeyPaymentForNetwork } from "./settlement.js";
import { markBatchEvidenceSettled } from "./evidence.js";
import { markBatchReceiptsSettled } from "./receipts.js";
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
};

let storage: ValkeyChannelStorage | null = null;

export type BatchCommit = {
    channelId: string;
    cumulativeAmountWei: string;
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

type SvmBatchChannel = {
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
    createdAt: number;
    lastRequestTimestamp: number;
    lastTxHash?: string;
};

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

function utf8Bytes(value: string): Uint8Array {
    return new Uint8Array(svmUtf8Encoder.encode(value));
}

function signatureFromBase58(value: string) {
    return signatureBytes(new Uint8Array(svmBase58Encoder.encode(value)));
}

function positiveInteger(value: string): boolean {
    return /^\d+$/u.test(value) && BigInt(value) > 0n;
}

export function getBatchAsset(chainId: number): {
    address: `0x${string}`;
    name: string;
    version: string;
    decimals: number;
    assetTransferMethod?: string;
} {
    const network = `eip155:${chainId}`;
    try {
        const asset = getDefaultAsset(network as never);
        return {
            address: asset.address as `0x${string}`,
            name: asset.name,
            version: asset.version,
            decimals: asset.decimals,
            ...(asset.assetTransferMethod ? { assetTransferMethod: asset.assetTransferMethod } : {}),
        };
    } catch {
        return {
            address: getNetwork(`eip155:${chainId}`).asset.address as `0x${string}`,
            name: "USD Coin",
            version: "2",
            decimals: 6,
        };
    }
}

export function createBatchPaymentExtra(chainId: number, receiverAuthorizer: `0x${string}`): Record<string, unknown> {
    const asset = getBatchAsset(chainId);
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

function base(raw: BatchRaw, requirements: PaymentRequirements, verifyResult?: VerifyResponse): StoredChannel {
    const extra = (verifyResult?.extra ?? {}) as Record<string, unknown>;
    const deposit = raw.type === "deposit" && raw.deposit?.amount ? BigInt(raw.deposit.amount) : 0n;
    const balance = BigInt(stringExtra(extra, "balance", "0")) + deposit;
    const signedMax = BigInt(raw.voucher.maxClaimableAmount);
    const requirementAmount = BigInt(requirements.amount || "0");
    const charged = signedMax >= requirementAmount ? signedMax - requirementAmount : 0n;
    return {
        channelId: raw.voucher.channelId,
        channelConfig: raw.channelConfig as StoredChannel["channelConfig"],
        chargedCumulativeAmount: charged.toString(),
        signedMaxClaimable: raw.voucher.maxClaimableAmount,
        signature: raw.voucher.signature,
        balance: balance > 0n ? balance.toString() : raw.voucher.maxClaimableAmount,
        totalClaimed: stringExtra(extra, "totalClaimed", "0"),
        withdrawRequestedAt: numberExtra(extra, "withdrawRequestedAt", 0),
        refundNonce: numberExtra(extra, "refundNonce", 0),
        onchainSyncedAt: verifyResult?.extra ? Date.now() : undefined,
        lastRequestTimestamp: Date.now(),
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

    await getBatchChannelStorage().updateChannel(raw.voucher.channelId, (current) => {
        const existing = current as StoredChannel | undefined;
        if (existing) {
            return {
                ...existing,
                signedMaxClaimable: raw.voucher.maxClaimableAmount,
                signature: raw.voucher.signature,
                lastRequestTimestamp: Date.now(),
            };
        }
        return base(raw, requirements, verifyResult);
    });
}

export async function commitBatchCharge(
    paymentPayload: PaymentPayload,
    amountWei: string,
    requirements?: PaymentRequirements,
    verifyResult?: VerifyResponse,
): Promise<BatchCommit> {
    const raw = getBatchPayload(paymentPayload);
    if (!raw) {
        throw new Error("Payment payload is not batch-settlement");
    }
    const resolvedRequirements = requirements || paymentPayload.accepted;
    if (isNetworkId(resolvedRequirements.network) && isSolanaNetwork(resolvedRequirements.network)) {
        return commitSvmBatchCharge(paymentPayload, amountWei, resolvedRequirements);
    }

    const amount = BigInt(amountWei);
    if (amount === 0n) {
        await rememberBatchChannel(
            paymentPayload,
            resolvedRequirements,
            verifyResult,
        );
        return {
            channelId: raw.voucher.channelId,
            cumulativeAmountWei: raw.voucher.maxClaimableAmount,
        };
    }

    let cumulativeAmountWei = "0";
    await getBatchChannelStorage().updateChannel(raw.voucher.channelId, (current) => {
        const channel = (current as StoredChannel | undefined)
            ?? base(raw, resolvedRequirements, verifyResult);
        const charged = BigInt(channel.chargedCumulativeAmount || "0") + amount;
        const signedMax = BigInt(raw.voucher.maxClaimableAmount);
        const balance = BigInt(channel.balance || "0");
        if (charged > signedMax || charged > balance) {
            throw new Error("batch-settlement channel budget exhausted");
        }
        cumulativeAmountWei = charged.toString();
        return {
            ...channel,
            chargedCumulativeAmount: charged.toString(),
            signedMaxClaimable: raw.voucher.maxClaimableAmount,
            signature: raw.voucher.signature,
            lastRequestTimestamp: Date.now(),
        };
    });

    return {
        channelId: raw.voucher.channelId,
        cumulativeAmountWei,
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
    return `${SVM_BATCH_PREFIX}:channel:${channelId.toLowerCase()}`;
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
    if (!data.channelId || !data.payer || !data.network || !data.asset || !data.payTo) {
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
        createdAt: Number.parseInt(data.createdAt || "0", 10) || Date.now(),
        lastRequestTimestamp: Number.parseInt(data.lastRequestTimestamp || "0", 10) || Date.now(),
        ...(data.lastTxHash ? { lastTxHash: data.lastTxHash } : {}),
    };
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

    const { channelId, maxClaimableAmount, signature } = svmBatchVoucherFields(raw);
    const existing = await readSvmBatchChannel(channelId);
    const now = Date.now();
    await writeSvmBatchChannel({
        channelId,
        payer: raw.channelConfig.payer,
        network: requirements.network as SolanaNetworkId,
        asset: requirements.asset,
        payTo: requirements.payTo,
        resource: raw.channelConfig.resource || "",
        signedMaxClaimable: maxClaimableAmount,
        chargedCumulativeAmount: existing?.chargedCumulativeAmount || "0",
        settledCumulativeAmount: existing?.settledCumulativeAmount || "0",
        balance: raw.channelConfig.balance || existing?.balance || maxClaimableAmount,
        signature,
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

export async function runSvmBatchSettlement(): Promise<SvmBatchSettlementSummary> {
    const startedAt = Date.now();
    const runId = `svm-batch-${startedAt}`;
    const channelIds = await valkeySMembers(SVM_BATCH_PENDING_KEY);
    const channels: SvmBatchSettlementResult[] = [];

    for (const channelId of channelIds) {
        const channel = await readSvmBatchChannel(channelId);
        if (!channel) {
            await valkeySRem(SVM_BATCH_PENDING_KEY, channelId);
            continue;
        }

        const charged = BigInt(channel.chargedCumulativeAmount || "0");
        const settled = BigInt(channel.settledCumulativeAmount || "0");
        if (charged <= settled) {
            await valkeySRem(SVM_BATCH_PENDING_KEY, channelId);
            continue;
        }

        const delta = charged - settled;
        try {
            const settlement = await settleKeyPaymentForNetwork(
                channel.payer,
                delta.toString(),
                channel.network,
            );
            if (!settlement.success || !settlement.txHash) {
                channels.push({
                    channelId,
                    payer: channel.payer,
                    network: channel.network,
                    settledAmountWei: "0",
                    claimedAmountWei: charged.toString(),
                    txHash: "",
                    reconciledReceipts: 0,
                    reconciledEvidence: 0,
                    error: settlement.error || "SVM batch settlement did not return transaction hash",
                });
                continue;
            }

            const txHash = settlement.txHash;
            const reconciledReceipts = await markBatchReceiptsSettled({
                channelId,
                claimedAmountWei: charged.toString(),
                claimTxHash: txHash,
                settleTxHash: txHash,
            });
            const reconciledEvidence = await markBatchEvidenceSettled({
                channelId,
                claimedAmountWei: charged.toString(),
                claimTxHash: txHash,
                settleTxHash: txHash,
                network: channel.network,
            });
            await writeSvmBatchChannel({
                ...channel,
                settledCumulativeAmount: charged.toString(),
                lastTxHash: txHash,
                lastRequestTimestamp: Date.now(),
            });
            await valkeySRem(SVM_BATCH_PENDING_KEY, channelId);
            channels.push({
                channelId,
                payer: channel.payer,
                network: channel.network,
                settledAmountWei: delta.toString(),
                claimedAmountWei: charged.toString(),
                txHash,
                reconciledReceipts,
                reconciledEvidence,
            });
        } catch (error) {
            channels.push({
                channelId,
                payer: channel.payer,
                network: channel.network,
                settledAmountWei: "0",
                claimedAmountWei: charged.toString(),
                txHash: "",
                reconciledReceipts: 0,
                reconciledEvidence: 0,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return {
        runId,
        startedAt,
        finishedAt: Date.now(),
        channels,
    };
}

export function queuedBatchSettlement(amountWei: string, network: string, payer?: string): SettleResponse {
    return {
        success: true,
        transaction: "",
        network: network as `${string}:${string}`,
        amount: amountWei,
        ...(payer ? { payer } : {}),
        extra: {
            settlementStatus: "queued",
            batchSettlementAddress: BATCH_SETTLEMENT_ADDRESS,
        },
    };
}

export function supportsNativeBatchSettlement(chainId: number): boolean {
    return Boolean(DEFAULT_STABLECOINS[`eip155:${chainId}`] || getNetwork(`eip155:${chainId}`).asset.address);
}
