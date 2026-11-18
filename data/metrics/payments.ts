import {
    createPublicClient,
    decodeEventLog,
    http,
    parseAbiItem,
    type Hash,
    type Hex,
} from "viem";

import {
    getNetwork,
    getNetworkRpcUrl,
    getViemChain,
    type EvmNetworkId,
} from "../../x402/configs/chains.js";
import { merchantWalletAddress } from "../../x402/wallets.js";
import { ensure, rows, setState } from "./db.js";
import { normalizeAtomic } from "./format.js";

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const abi = [transfer] as const;

export interface PaymentRecord {
    network: EvmNetworkId;
    txHash: string;
    amountAtomic: string | number | bigint;
    source?: "history" | "settlement";
    settledAt?: Date;
}

export interface PaymentLog {
    transactionHash?: Hash | null;
    args?: {
        value?: bigint | string | number | null;
    };
}

export interface ReceiptLog {
    address?: string;
    data?: Hex;
    topics?: readonly Hex[];
}

export interface ConfirmedPaymentInput {
    network: EvmNetworkId;
    txHash: string;
}

function normalizedHash(value: string): string {
    const hash = value.trim().toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`Invalid transaction hash: ${value}`);
    }
    return hash;
}

function sameAddress(left: string | undefined, right: string): boolean {
    return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

export function aggregatePaymentLogs(logs: PaymentLog[]): Array<{ txHash: string; amountAtomic: string }> {
    const byTx = new Map<string, bigint>();
    for (const log of logs) {
        if (!log.transactionHash) continue;
        const txHash = normalizedHash(log.transactionHash);
        const raw = log.args?.value;
        if (raw === undefined || raw === null) continue;
        const amount = BigInt(normalizeAtomic(raw));
        byTx.set(txHash, (byTx.get(txHash) ?? 0n) + amount);
    }
    return [...byTx.entries()].map(([txHash, amount]) => ({
        txHash,
        amountAtomic: amount.toString(),
    }));
}

export function incomingAmountFromLogs(network: EvmNetworkId, logs: ReceiptLog[]): string {
    const usdc = getNetwork(network).asset.address;
    let total = 0n;

    for (const log of logs) {
        if (!sameAddress(log.address, usdc) || !log.data || !log.topics) continue;
        try {
            const topics = [...log.topics] as [Hex, ...Hex[]];
            const decoded = decodeEventLog({ abi, data: log.data, topics });
            if (decoded.eventName !== "Transfer") continue;
            const args = decoded.args as { to?: string; value?: bigint };
            if (sameAddress(args.to, merchantWalletAddress) && typeof args.value === "bigint") {
                total += args.value;
            }
        } catch {
            continue;
        }
    }

    return total.toString();
}

async function exists(network: EvmNetworkId, txHash: string): Promise<boolean> {
    await ensure();
    const result = await rows<{ found: number }>(
        `SELECT 1 AS found
         FROM payments
         WHERE network = $1 AND tx_hash = $2
         LIMIT 1`,
        [network, normalizedHash(txHash)],
    );
    return result.length > 0;
}

export async function recordPayment(input: PaymentRecord): Promise<boolean> {
    await ensure();
    const amount = normalizeAtomic(input.amountAtomic);
    if (BigInt(amount) <= 0n) return false;

    const result = await rows<{ inserted: number }>(
        `INSERT INTO payments (network, tx_hash, amount_atomic, source, settled_at)
         VALUES ($1, $2, $3::numeric, $4, $5)
         ON CONFLICT (network, tx_hash) DO NOTHING
         RETURNING 1 AS inserted`,
        [
            input.network,
            normalizedHash(input.txHash),
            amount,
            input.source ?? "settlement",
            input.settledAt?.toISOString() ?? null,
        ],
    );
    if (result.length > 0) {
        await setState("payments", new Date().toISOString());
        return true;
    }
    return false;
}

export async function recordConfirmedPayment(input: ConfirmedPaymentInput): Promise<{
    recorded: boolean;
    amountAtomic: string;
}> {
    const txHash = normalizedHash(input.txHash);
    if (await exists(input.network, txHash)) {
        return { recorded: false, amountAtomic: "0" };
    }

    const client = createPublicClient({
        chain: getViemChain(input.network),
        transport: http(getNetworkRpcUrl(input.network)),
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success") {
        throw new Error(`Settlement transaction failed: ${txHash}`);
    }

    const amountAtomic = incomingAmountFromLogs(input.network, receipt.logs);
    if (BigInt(amountAtomic) <= 0n) {
        throw new Error(`Settlement transaction has no incoming USDC transfer to merchant wallet: ${txHash}`);
    }

    return {
        recorded: await recordPayment({
            network: input.network,
            txHash,
            amountAtomic,
            source: "settlement",
            settledAt: new Date(),
        }),
        amountAtomic,
    };
}

export function triggerConfirmedPayment(input: ConfirmedPaymentInput, source: string): void {
    void recordConfirmedPayment(input).catch((error) => {
        console.error("[metrics] settled payment record failed", {
            source,
            network: input.network,
            txHash: input.txHash,
            error: error instanceof Error ? error.message : String(error),
        });
    });
}
