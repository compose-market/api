import {
    createPublicClient,
    decodeEventLog,
    http,
    parseAbiItem,
    type Address,
    type Hash,
    type Hex,
} from "viem";

import {
    getNetwork,
    getNetworkRpcUrl,
    getSupportedNetworks,
    getViemChain,
    isEvmNetwork,
    type EvmNetworkId,
} from "../../x402/configs/chains.js";
import { merchantWalletAddress } from "../../x402/wallets.js";
import { bumpPaymentSnapshot } from "./cache.js";
import { ensure, getState, rows, setState, stateUpdatedAt } from "./db.js";
import { formatUsdcAtomic, normalizeAtomic } from "./format.js";

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const abi = [transfer] as const;
const MIN_CHUNK = 10n;
const START_CHUNK = 50_000n;
const MAX_CHUNK = 500_000n;
const LIVE_CHUNK = 10_000n;
const ALCHEMY_PAGE_SIZE = "0x3e8";

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

export interface PaymentSyncOptions {
    maxRanges?: number;
}

interface AlchemyTransfer {
    to?: string | null;
    hash?: string;
    rawContract?: {
        address?: string | null;
        value?: string | null;
    } | null;
}

interface AlchemyResult {
    transfers?: AlchemyTransfer[];
    pageKey?: string;
}

interface AlchemyResponse {
    result?: AlchemyResult;
    error?: {
        code?: number;
        message?: string;
    };
}

function supportedConfiguredChains(): EvmNetworkId[] {
    return getSupportedNetworks().filter((definition): definition is typeof definition & { id: EvmNetworkId } => {
        return isEvmNetwork(definition.id) && Boolean(process.env[definition.rpcEnvVar]);
    }).map((definition) => definition.id);
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

function blockHex(value: bigint): Hex {
    return `0x${value.toString(16)}` as Hex;
}

function isAlchemyRpc(url: string): boolean {
    try {
        return new URL(url).hostname.endsWith("alchemy.com");
    } catch {
        return false;
    }
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
        if ((input.source ?? "settlement") === "settlement") {
            await bumpPaymentSnapshot(amount);
        }
        return true;
    }
    return false;
}

async function recordPayments(network: EvmNetworkId, payments: Array<{ txHash: string; amountAtomic: string }>): Promise<number> {
    const clean = payments
        .map((payment) => ({
            txHash: normalizedHash(payment.txHash),
            amountAtomic: normalizeAtomic(payment.amountAtomic),
        }))
        .filter((payment) => BigInt(payment.amountAtomic) > 0n);
    if (clean.length === 0) {
        return 0;
    }

    await ensure();
    const values: string[] = [];
    const params: unknown[] = [];
    clean.forEach((payment, index) => {
        const base = index * 5;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}::numeric, $${base + 4}, $${base + 5})`);
        params.push(network, payment.txHash, payment.amountAtomic, "history", null);
    });

    const result = await rows<{ inserted: number }>(
        `INSERT INTO payments (network, tx_hash, amount_atomic, source, settled_at)
         VALUES ${values.join(", ")}
         ON CONFLICT (network, tx_hash) DO NOTHING
         RETURNING 1 AS inserted`,
        params,
    );
    if (result.length > 0) {
        await setState("payments", new Date().toISOString());
    }
    return result.length;
}

async function targetFor(network: EvmNetworkId): Promise<bigint> {
    const existing = await getState(`payments:target:${network}`);
    if (existing) {
        return BigInt(existing);
    }

    const client = createPublicClient({
        chain: getViemChain(network),
        transport: http(getNetworkRpcUrl(network)),
    });
    const latest = await client.getBlockNumber();
    await setState(`payments:target:${network}`, latest.toString());
    return latest;
}

async function ensureCutoff(chains: EvmNetworkId[]): Promise<void> {
    if (await getState("payments:cutoff")) return;
    await setState("payments:cutoff", new Date().toISOString());
    for (const network of chains) {
        await targetFor(network);
    }
}

async function markHistoryComplete(chains: EvmNetworkId[]): Promise<boolean> {
    for (const network of chains) {
        const target = await targetFor(network);
        const cursor = BigInt(await getState(`payments:cursor:${network}`) ?? "-1");
        if (cursor < target) {
            return false;
        }
    }
    await setState("payments:history:complete", "true");
    return true;
}

async function scanAlchemyTransfers(network: EvmNetworkId, target: bigint, maxPages: number): Promise<{
    pages: number;
    transfers: number;
    transactions: number;
}> {
    const rpcUrl = getNetworkRpcUrl(network);
    const pageState = `payments:alchemy:page:${network}`;
    let pageKey = await getState(pageState);
    let pages = 0;
    let transfers = 0;
    let transactions = 0;

    while (pages < maxPages) {
        const params: Record<string, unknown> = {
            fromBlock: "0x0",
            toBlock: blockHex(target),
            toAddress: merchantWalletAddress,
            contractAddresses: [getNetwork(network).asset.address],
            category: ["erc20"],
            excludeZeroValue: true,
            withMetadata: false,
            maxCount: ALCHEMY_PAGE_SIZE,
        };
        if (pageKey) {
            params.pageKey = pageKey;
        }

        const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "alchemy_getAssetTransfers",
                params: [params],
            }),
            signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json().catch(() => null) as AlchemyResponse | null;
        if (!response.ok || body?.error) {
            throw new Error(body?.error?.message || `alchemy_getAssetTransfers failed with status ${response.status}`);
        }

        const rows = aggregatePaymentLogs((body?.result?.transfers || [])
            .filter((transfer) =>
                sameAddress(transfer.to || undefined, merchantWalletAddress)
                && sameAddress(transfer.rawContract?.address || undefined, getNetwork(network).asset.address))
            .map((transfer) => ({
                transactionHash: transfer.hash as Hash | undefined,
                args: {
                    value: transfer.rawContract?.value ? BigInt(transfer.rawContract.value) : 0n,
                },
            })));
        transactions += await recordPayments(network, rows);
        transfers += body?.result?.transfers?.length || 0;
        pages += 1;

        pageKey = body?.result?.pageKey;
        if (pageKey) {
            await setState(pageState, pageKey);
        } else {
            await setState(`payments:cursor:${network}`, target.toString());
            break;
        }
    }

    return { pages, transfers, transactions };
}

async function scanLogs(network: EvmNetworkId, target: bigint, maxRanges: number, startChunk?: bigint): Promise<{
    ranges: number;
    transfers: number;
    transactions: number;
}> {
    const client = createPublicClient({
        chain: getViemChain(network),
        transport: http(getNetworkRpcUrl(network)),
    });
    let cursor = BigInt(await getState(`payments:cursor:${network}`) ?? "-1");
    let from = cursor + 1n;
    let chunk = startChunk ?? START_CHUNK;
    let ranges = 0;
    let transfers = 0;
    let transactions = 0;

    while (from <= target && ranges < maxRanges) {
        const to = from + chunk - 1n > target ? target : from + chunk - 1n;
        try {
            const logs = await client.getLogs({
                address: getNetwork(network).asset.address as Address,
                event: transfer,
                args: { to: merchantWalletAddress },
                fromBlock: from,
                toBlock: to,
            });
            const grouped = aggregatePaymentLogs(logs);
            transactions += await recordPayments(network, grouped);
            transfers += logs.length;
            ranges += 1;
            cursor = to;
            await setState(`payments:cursor:${network}`, cursor.toString());
            from = to + 1n;
            chunk = chunk * 2n > MAX_CHUNK ? MAX_CHUNK : chunk * 2n;
        } catch (error) {
            if (chunk <= MIN_CHUNK) {
                throw error;
            }
            chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        }
    }

    return { ranges, transfers, transactions };
}

async function getLatestBlockNumber(network: EvmNetworkId): Promise<bigint> {
    const client = createPublicClient({
        chain: getViemChain(network),
        transport: http(getNetworkRpcUrl(network)),
    });
    return await client.getBlockNumber();
}

async function syncLivePayments(chains: EvmNetworkId[], maxRanges: number): Promise<{
    chains: number;
    ranges: number;
    transfers: number;
    transactions: number;
    complete: boolean;
    cutoff?: string;
}> {
    let ranges = 0;
    let transfers = 0;
    let transactions = 0;

    for (const network of chains) {
        if (ranges >= maxRanges) break;

        const latest = await getLatestBlockNumber(network);
        const cursor = BigInt(await getState(`payments:cursor:${network}`) ?? "0");
        if (cursor >= latest) continue;

        let scanned = false;
        if (isAlchemyRpc(getNetworkRpcUrl(network))) {
            try {
                const result = await scanAlchemyTransfers(network, latest, maxRanges - ranges);
                ranges += result.pages;
                transfers += result.transfers;
                transactions += result.transactions;
                scanned = true;
            } catch {
                // Fall back to standard log scanning if Alchemy EAPIs are unsupported or fail on this network
            }
        }
        if (!scanned) {
            const result = await scanLogs(network, latest, maxRanges - ranges, LIVE_CHUNK);
            ranges += result.ranges;
            transfers += result.transfers;
            transactions += result.transactions;
        }
    }

    await setState("payments", new Date().toISOString());
    return {
        chains: chains.length,
        ranges,
        transfers,
        transactions,
        complete: true,
        cutoff: await getState("payments:cutoff"),
    };
}

export async function syncPayments(options: PaymentSyncOptions = {}): Promise<{
    chains: number;
    ranges: number;
    transfers: number;
    transactions: number;
    complete: boolean;
    cutoff?: string;
}> {
    await ensure();
    const chains = supportedConfiguredChains();
    await ensureCutoff(chains);

    if (await getState("payments:history:complete") === "true") {
        return await syncLivePayments(chains, options.maxRanges ?? 200);
    }

    let ranges = 0;
    let transfers = 0;
    let transactions = 0;
    const maxRanges = options.maxRanges ?? Number.POSITIVE_INFINITY;

    for (const network of chains) {
        if (ranges >= maxRanges) break;

        const target = await targetFor(network);
        let scanned = false;
        if (isAlchemyRpc(getNetworkRpcUrl(network))) {
            try {
                const result = await scanAlchemyTransfers(network, target, maxRanges - ranges);
                ranges += result.pages;
                transfers += result.transfers;
                transactions += result.transactions;
                scanned = true;
            } catch {
                // Fall back to standard log scanning if Alchemy EAPIs are unsupported or fail on this network
            }
        }
        if (!scanned) {
            const result = await scanLogs(network, target, maxRanges - ranges);
            ranges += result.ranges;
            transfers += result.transfers;
            transactions += result.transactions;
        }
    }

    await setState("payments", new Date().toISOString());
    const complete = await markHistoryComplete(chains);
    return {
        chains: chains.length,
        ranges,
        transfers,
        transactions,
        complete,
        cutoff: await getState("payments:cutoff"),
    };
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

export async function paymentTotals(): Promise<{
    transactions: number;
    amountAtomic: string;
    amountUsdc: string;
    dailyTransactions: number;
    dailyAmountAtomic: string;
    cutoff?: string;
    updatedAt?: string;
}> {
    await ensure();
    const [result, daily] = await Promise.all([
        rows<{ transactions?: string | number; amount_atomic?: string }>(
            `SELECT count(*) AS transactions,
                    COALESCE(sum(amount_atomic), 0)::text AS amount_atomic
             FROM payments`,
        ),
        rows<{ transactions?: string | number; amount_atomic?: string }>(
            `SELECT count(*) AS transactions,
                    COALESCE(sum(amount_atomic), 0)::text AS amount_atomic
             FROM payments
             WHERE settled_at >= date_trunc('day', now())`,
        ),
    ]);
    const amountAtomic = result[0]?.amount_atomic ?? "0";
    const dailyAmountAtomic = daily[0]?.amount_atomic ?? "0";
    return {
        transactions: Number(result[0]?.transactions ?? 0),
        amountAtomic,
        amountUsdc: formatUsdcAtomic(amountAtomic),
        dailyTransactions: Number(daily[0]?.transactions ?? 0),
        dailyAmountAtomic,
        cutoff: await getState("payments:cutoff"),
        updatedAt: await stateUpdatedAt("payments"),
    };
}
