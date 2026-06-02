import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS, DEFAULT_STABLECOINS, getDefaultAsset } from "@x402/evm";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { RedisChannelStorage } from "@x402/evm/batch-settlement/server/redis-storage";

import { getUsdcAddress } from "./configs/chains.js";
import { getRedisClient } from "./keys/redis.js";

const WITHDRAW_DELAY_SECONDS = 900;

type BatchRaw = {
    type: "deposit" | "voucher";
    channelConfig: {
        payer: `0x${string}`;
        payerAuthorizer: `0x${string}`;
        receiver: `0x${string}`;
        receiverAuthorizer: `0x${string}`;
        token: `0x${string}`;
        withdrawDelay: number;
        salt: `0x${string}`;
    };
    voucher: {
        channelId: `0x${string}`;
        maxClaimableAmount: string;
        signature: `0x${string}`;
    };
    deposit?: {
        amount: string;
    };
};

type StoredChannel = Channel & {
    channelId: string;
    channelConfig: BatchRaw["channelConfig"];
    chargedCumulativeAmount: string;
    signedMaxClaimable: string;
    signature: `0x${string}`;
    balance: string;
    totalClaimed: string;
    withdrawRequestedAt: number;
    refundNonce: number;
    onchainSyncedAt?: number;
    lastRequestTimestamp: number;
};

let storage: RedisChannelStorage | null = null;

export type BatchCommit = {
    channelId: string;
    cumulativeAmountWei: string;
};

function redis() {
    return {
        get: async (key: string) => (await getRedisClient()).get(key),
        set: async (key: string, value: string, options?: { NX?: true; PX?: number }) =>
            (await getRedisClient()).set(key, value, options as never) as Promise<string | null>,
        del: async (key: string) => (await getRedisClient()).del(key),
        eval: async (script: string, options: { keys: string[]; arguments: string[] }) =>
            (await getRedisClient()).eval(script, options as never),
        scanIterator(options: { MATCH?: string; COUNT?: number }) {
            async function* iterate() {
                const client = await getRedisClient();
                for await (const key of client.scanIterator(options as never)) {
                    yield key as string | string[];
                }
            }
            return iterate();
        },
    };
}

export function getBatchChannelStorage(): RedisChannelStorage {
    if (!storage) {
        storage = new RedisChannelStorage({
            client: redis(),
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
            address: getUsdcAddress(chainId),
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
        channelConfig: raw.channelConfig,
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

    const amount = BigInt(amountWei);
    if (amount === 0n) {
        await rememberBatchChannel(
            paymentPayload,
            requirements || paymentPayload.accepted,
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
            ?? base(raw, requirements || paymentPayload.accepted, verifyResult);
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
    return Boolean(DEFAULT_STABLECOINS[`eip155:${chainId}`] || getUsdcAddress(chainId));
}
