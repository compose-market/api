import type { Address, Hash } from "viem";

import { getRedisClient } from "../x402/keys/redis.js";
import { loadMetricsConfig, type MetricsConfig } from "./config.js";
import type {
    MetricsClientSource,
    MetricsContractDeployment,
    MetricsDownloadsSnapshot,
    MetricsFactorySnapshot,
    MetricsSnapshot,
} from "./types.js";

type RedisHash = Record<string, string>;

function key(config: MetricsConfig, suffix: string): string {
    return `${config.redisPrefix}:${suffix}`;
}

export function getMetricsChannel(config = loadMetricsConfig()): string {
    return key(config, "changed");
}

function assertIntegerString(value: string | number | bigint, name: string): string {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new Error(`${name} must be a safe integer`);
        }
        return String(value);
    }
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        throw new Error(`${name} must be a base-10 integer string`);
    }
    return trimmed.replace(/^-?0+(?=\d)/, (match) => match.startsWith("-") ? "-" : "");
}

async function hIncrByAmount(hashKey: string, field: string, amount: string | number | bigint): Promise<string> {
    const redis = await getRedisClient();
    const result = await (redis as unknown as { sendCommand(command: string[]): Promise<unknown> })
        .sendCommand(["HINCRBY", hashKey, field, assertIntegerString(amount, field)]);
    return String(result);
}

async function hGetAll(hashKey: string): Promise<RedisHash> {
    const redis = await getRedisClient();
    return redis.hGetAll(hashKey);
}

async function publishChanged(
    config: MetricsConfig,
    reason: string,
    fields: Record<string, unknown> = {},
): Promise<void> {
    const redis = await getRedisClient();
    await redis.publish(getMetricsChannel(config), JSON.stringify({
        type: "metrics.changed",
        dataset: config.dataset,
        reason,
        at: Date.now(),
        ...fields,
    }));
}

function asNumber(value: string | undefined): number {
    if (!value) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value: string | undefined): string {
    return value && /^-?\d+$/.test(value) ? value : "0";
}

function maxIntegerString(current: string | undefined, next: string | number | bigint): string {
    const currentValue = BigInt(asString(current));
    const nextValue = BigInt(assertIntegerString(next, "metric"));
    return nextValue > currentValue ? nextValue.toString() : currentValue.toString();
}

export async function updateMetricsState(
    fields: Record<string, string | number | bigint>,
    config = loadMetricsConfig(),
): Promise<void> {
    const redis = await getRedisClient();
    const data: Record<string, string> = { updatedAt: String(Date.now()) };
    for (const [field, value] of Object.entries(fields)) {
        data[field] = typeof value === "bigint" ? value.toString() : String(value);
    }
    await redis.hSet(key(config, "state"), data);
}

export async function readMetricsState(config = loadMetricsConfig()): Promise<RedisHash> {
    return hGetAll(key(config, "state"));
}

export async function recordSettlementTransactionMetric(input: {
    chainId: number;
    txHash?: string | null;
    amountWei: string | number | bigint;
    from?: string | null;
    to?: string | null;
    blockNumber?: string | number | bigint | null;
    source: string;
}, config = loadMetricsConfig()): Promise<boolean> {
    if (input.chainId !== config.chainId || !input.txHash) return false;
    if (input.to && input.to.toLowerCase() !== config.merchantAddress.toLowerCase()) return false;

    const redis = await getRedisClient();
    const txHash = input.txHash.toLowerCase() as Hash;
    const added = await redis.sAdd(key(config, "settlement-txs"), txHash);
    if (added === 0) return false;

    const amountWei = assertIntegerString(input.amountWei, "amountWei");
    await hIncrByAmount(key(config, "aggregate"), "grossMerchantReceiptsWei", amountWei);
    await hIncrByAmount(key(config, "aggregate"), "settlementTxCount", 1);
    if (input.from && input.from.toLowerCase() === config.merchantAddress.toLowerCase()) {
        await hIncrByAmount(key(config, "aggregate"), "selfTransferCount", 1);
    }
    await redis.hSet(key(config, `settlement-tx:${txHash}`), {
        txHash,
        amountWei,
        from: input.from || "",
        to: input.to || config.merchantAddress,
        blockNumber: input.blockNumber ? String(input.blockNumber) : "",
        source: input.source,
        recordedAt: String(Date.now()),
    });
    await redis.hSet(key(config, "aggregate"), {
        lastSettlementTxHash: txHash,
        updatedAt: String(Date.now()),
    });
    await publishChanged(config, "settlement-transaction", { txHash, amountWei });
    return true;
}

export async function recordTransferLogMetric(input: {
    txHash: Hash;
    blockNumber: bigint;
    logIndex: number | string;
    dedupSuffix?: string;
    from: Address;
    to: Address;
    value: bigint;
    source?: "rpc-transfer-log" | "explorer-token-transfer" | "routescan-log";
}, config = loadMetricsConfig()): Promise<boolean> {
    if (input.to.toLowerCase() !== config.merchantAddress.toLowerCase()) return false;
    const redis = await getRedisClient();
    const txHash = input.txHash.toLowerCase() as Hash;
    const aggregateKey = key(config, "aggregate");
    const txKey = key(config, `settlement-tx:${txHash}`);
    const existingTx = await redis.hGetAll(txKey);
    const source = input.source || "rpc-transfer-log";
    if (source === "routescan-log" && existingTx.exactReconciled === "true") {
        return false;
    }

    const receiptLogId = `${txHash}:${input.dedupSuffix || String(input.logIndex)}`;
    const addedLog = await redis.sAdd(key(config, "merchant-receipt-logs"), receiptLogId);
    if (addedLog === 0) return false;

    const exactSources = new Set(["rpc-transfer-log", "explorer-token-transfer"]);
    const hadProvisionalTx = Boolean(existingTx.txHash)
        && existingTx.exactReconciled !== "true"
        && (exactSources.has(source) || (source === "routescan-log" && existingTx.source !== "routescan-log"));

    if (hadProvisionalTx) {
        const previousAmount = asString(existingTx.amountWei);
        if (previousAmount !== "0") {
            await hIncrByAmount(aggregateKey, "grossMerchantReceiptsWei", `-${previousAmount}`);
        }
        if (existingTx.from && existingTx.from.toLowerCase() === config.merchantAddress.toLowerCase()) {
            await hIncrByAmount(aggregateKey, "selfTransferCount", -1);
        }
        await redis.hSet(txKey, {
            amountWei: "0",
            exactReconciled: "true",
        });
    }

    const addedTx = await redis.sAdd(key(config, "settlement-txs"), txHash);
    if (addedTx > 0) {
        await hIncrByAmount(aggregateKey, "settlementTxCount", 1);
    }

    await hIncrByAmount(aggregateKey, "grossMerchantReceiptsWei", input.value);
    await hIncrByAmount(aggregateKey, "transferLogCount", 1);
    if (input.from.toLowerCase() === config.merchantAddress.toLowerCase()) {
        await hIncrByAmount(aggregateKey, "selfTransferCount", 1);
    }

    if (hadProvisionalTx || !existingTx.txHash) {
        await redis.hSet(txKey, {
            txHash,
            amountWei: "0",
            from: input.from,
            to: input.to,
            blockNumber: input.blockNumber.toString(),
            source,
            exactReconciled: exactSources.has(source) ? "true" : "false",
            recordedAt: String(Date.now()),
        });
    }
    await hIncrByAmount(txKey, "amountWei", input.value);
    await redis.hSet(key(config, `merchant-receipt-log:${receiptLogId}`), {
        id: receiptLogId,
        txHash,
        logIndex: String(input.logIndex),
        amountWei: input.value.toString(),
        from: input.from,
        to: input.to,
        blockNumber: input.blockNumber.toString(),
        source,
        recordedAt: String(Date.now()),
    });
    await redis.hSet(aggregateKey, {
        lastSettlementTxHash: txHash,
        updatedAt: String(Date.now()),
    });
    await publishChanged(config, "merchant-receipt-log", { txHash, logIndex: input.logIndex, amountWei: input.value.toString() });
    return true;
}

export async function recordFastReceiptAggregateMetric(input: {
    grossMerchantReceiptsWei: string | number | bigint;
    settlementTxCount: string | number | bigint;
    transferLogCount: string | number | bigint;
    selfTransferCount: string | number | bigint;
    lastSettlementTxHash?: Hash;
    source: string;
}, config = loadMetricsConfig()): Promise<void> {
    const redis = await getRedisClient();
    const aggregateKey = key(config, "aggregate");
    const current = await redis.hGetAll(aggregateKey);
    const grossMerchantReceiptsWei = maxIntegerString(current.grossMerchantReceiptsWei, input.grossMerchantReceiptsWei);
    const settlementTxCount = maxIntegerString(current.settlementTxCount, input.settlementTxCount);
    const transferLogCount = maxIntegerString(current.transferLogCount, input.transferLogCount);
    const selfTransferCount = maxIntegerString(current.selfTransferCount, input.selfTransferCount);

    await redis.hSet(aggregateKey, {
        grossMerchantReceiptsWei,
        settlementTxCount,
        transferLogCount,
        selfTransferCount,
        ...(input.lastSettlementTxHash ? { lastSettlementTxHash: input.lastSettlementTxHash.toLowerCase() } : {}),
        fastReceiptSource: input.source,
        updatedAt: String(Date.now()),
    });
    await publishChanged(config, "fast-receipt-aggregate", {
        grossMerchantReceiptsWei,
        settlementTxCount,
        transferLogCount,
    });
}

export async function recordDownloadsSnapshotMetric(
    input: MetricsDownloadsSnapshot,
    config = loadMetricsConfig(),
): Promise<void> {
    const redis = await getRedisClient();
    await redis.set(key(config, "downloads"), JSON.stringify(input));
    await publishChanged(config, "downloads", {
        totalObserved: input.totalObserved,
        sdkLastMonth: input.sdk.downloads.lastMonth,
        meshReleaseAssetDownloads: input.mesh.releaseAssetDownloads,
    });
}

export async function readDownloadsSnapshot(config = loadMetricsConfig()): Promise<MetricsDownloadsSnapshot> {
    const redis = await getRedisClient();
    const raw = await redis.get(key(config, "downloads"));
    if (raw) {
        try {
            return JSON.parse(raw) as MetricsDownloadsSnapshot;
        } catch {
            // Fall through to the empty shape if cached JSON is corrupt.
        }
    }
    return {
        totalObserved: 0,
        sdk: {
            packageName: config.sdkPackageName,
            downloads: {
                lastDay: 0,
                lastWeek: 0,
                lastMonth: 0,
                lastYear: 0,
            },
            source: "npm",
        },
        mesh: {
            repository: `${config.meshRepoOwner}/${config.meshRepoName}`,
            releaseAssetDownloads: 0,
            releases: 0,
            assets: [],
            source: "github",
        },
        warnings: ["Download metrics have not been refreshed yet."],
    };
}

export async function recordSettledBillableCallMetric(input: {
    chainId: number;
    id: string;
    amountWei?: string | number | bigint;
    txHash?: string | null;
    source: string;
    userAddress?: string | null;
}, config = loadMetricsConfig()): Promise<boolean> {
    if (input.chainId !== config.chainId || !input.id) return false;
    const redis = await getRedisClient();
    const id = input.id.toLowerCase();
    const added = await redis.sAdd(key(config, "settled-call-ids"), id);
    if (added === 0) return false;

    await hIncrByAmount(key(config, "aggregate"), "settledBillableCalls", 1);
    await redis.hSet(key(config, `settled-call:${id}`), {
        id,
        amountWei: input.amountWei === undefined ? "" : assertIntegerString(input.amountWei, "amountWei"),
        txHash: input.txHash || "",
        source: input.source,
        userAddress: input.userAddress || "",
        recordedAt: String(Date.now()),
    });
    await redis.hSet(key(config, "aggregate"), "updatedAt", String(Date.now()));
    await publishChanged(config, "settled-billable-call", { id, txHash: input.txHash });
    return true;
}

export async function recordApiAttemptMetric(input: {
    source: MetricsClientSource;
    method: string;
    path: string;
    statusCode: number;
    requestId?: string | null;
}, config = loadMetricsConfig()): Promise<void> {
    const redis = await getRedisClient();
    const aggregateKey = key(config, "aggregate");
    await hIncrByAmount(aggregateKey, "totalAttempts", 1);
    await hIncrByAmount(aggregateKey, `attempts:${input.source}`, 1);
    await hIncrByAmount(aggregateKey, `status:${Math.floor(input.statusCode / 100)}xx`, 1);
    await redis.hSet(aggregateKey, "updatedAt", String(Date.now()));
    await redis.hSet(key(config, "last-attempt"), {
        source: input.source,
        method: input.method,
        path: input.path,
        statusCode: String(input.statusCode),
        requestId: input.requestId || "",
        recordedAt: String(Date.now()),
    });
    await publishChanged(config, "api-attempt", { source: input.source, path: input.path });
}

export async function recordContractDeploymentMetric(input: MetricsContractDeployment, config = loadMetricsConfig()): Promise<boolean> {
    const redis = await getRedisClient();
    const address = input.address.toLowerCase() as Address;
    const added = await redis.sAdd(key(config, "deployed-contracts"), address);
    const contractKey = key(config, `contract:${address}`);
    const existing = await redis.hGetAll(contractKey);
    const keepExistingDiscovery = input.source === "configured-env"
        && existing.source
        && existing.source !== "configured-env";
    await redis.hSet(key(config, `contract:${address}`), {
        address,
        deployer: input.deployer || existing.deployer || config.deployerAddress,
        deployedAtBlock: keepExistingDiscovery ? existing.deployedAtBlock || "" : input.deployedAtBlock || existing.deployedAtBlock || "",
        deploymentTxHash: keepExistingDiscovery ? existing.deploymentTxHash || "" : input.deploymentTxHash || existing.deploymentTxHash || "",
        source: keepExistingDiscovery ? existing.source : input.source,
        classifiedAs: input.classifiedAs || existing.classifiedAs || "unknown",
        discoveredAt: keepExistingDiscovery ? existing.discoveredAt || String(input.discoveredAt) : String(input.discoveredAt),
    });
    if (added > 0) {
        await publishChanged(config, "contract-deployment", { address });
    }
    return added > 0;
}

export async function recordAgentFactoryMetric(input: MetricsFactorySnapshot, config = loadMetricsConfig()): Promise<void> {
    const redis = await getRedisClient();
    const address = input.address.toLowerCase() as Address;
    const factoryKey = key(config, `factory:${address}`);
    const existing = await redis.hGetAll(factoryKey);
    const previousTotal = existing.totalAgents && /^\d+$/.test(existing.totalAgents) ? BigInt(existing.totalAgents) : 0n;
    const nextTotal = BigInt(assertIntegerString(input.totalAgents, "totalAgents"));
    const delta = nextTotal - previousTotal;

    await redis.sAdd(key(config, "agent-factories"), address);
    await redis.hSet(factoryKey, {
        address,
        totalAgents: nextTotal.toString(),
        confidence: input.confidence === "configured" && existing.confidence && existing.confidence !== "configured"
            ? existing.confidence
            : input.confidence,
        deployedAtBlock: input.deployedAtBlock || existing.deployedAtBlock || "",
        deploymentTxHash: input.deploymentTxHash || existing.deploymentTxHash || "",
        lastCheckedAt: String(input.lastCheckedAt),
    });
    if (delta !== 0n) {
        await hIncrByAmount(key(config, "aggregate"), "agentsMinted", delta);
        await redis.hSet(key(config, "aggregate"), "updatedAt", String(Date.now()));
        await publishChanged(config, "agent-factory", { address, totalAgents: nextTotal.toString() });
    }
}

async function readFactories(config: MetricsConfig): Promise<MetricsFactorySnapshot[]> {
    const redis = await getRedisClient();
    const addresses = await redis.sMembers(key(config, "agent-factories"));
    const factories = await Promise.all(addresses.map(async (address) => hGetAll(key(config, `factory:${address}`))));
    return factories
        .filter((factory) => factory.address)
        .map((factory) => ({
            address: factory.address as Address,
            totalAgents: asString(factory.totalAgents),
            confidence: (factory.confidence || "abi-probed") as MetricsFactorySnapshot["confidence"],
            ...(factory.deployedAtBlock ? { deployedAtBlock: factory.deployedAtBlock } : {}),
            ...(factory.deploymentTxHash ? { deploymentTxHash: factory.deploymentTxHash as Hash } : {}),
            lastCheckedAt: asNumber(factory.lastCheckedAt),
        }))
        .sort((a, b) => a.address.localeCompare(b.address));
}

async function readDeployments(config: MetricsConfig): Promise<MetricsContractDeployment[]> {
    const redis = await getRedisClient();
    const addresses = await redis.sMembers(key(config, "deployed-contracts"));
    const deployments = await Promise.all(addresses.map(async (address) => hGetAll(key(config, `contract:${address}`))));
    return deployments
        .filter((deployment) => deployment.address)
        .map((deployment) => ({
            address: deployment.address as Address,
            deployer: (deployment.deployer || config.deployerAddress) as Address,
            ...(deployment.deployedAtBlock ? { deployedAtBlock: deployment.deployedAtBlock } : {}),
            ...(deployment.deploymentTxHash ? { deploymentTxHash: deployment.deploymentTxHash as Hash } : {}),
            source: (deployment.source || "configured-env") as MetricsContractDeployment["source"],
            classifiedAs: (deployment.classifiedAs || "unknown") as MetricsContractDeployment["classifiedAs"],
            discoveredAt: asNumber(deployment.discoveredAt),
        }))
        .sort((a, b) => (b.discoveredAt || 0) - (a.discoveredAt || 0))
        .slice(0, 250);
}

export function formatUsdcAtomic(amountWei: string): string {
    const negative = amountWei.startsWith("-");
    const digits = negative ? amountWei.slice(1) : amountWei;
    const padded = digits.padStart(7, "0");
    const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
    const fraction = padded.slice(-6).replace(/0+$/g, "");
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export async function readMetricsSnapshot(config = loadMetricsConfig()): Promise<MetricsSnapshot> {
    const [aggregate, state, factories, deployments, downloads] = await Promise.all([
        hGetAll(key(config, "aggregate")),
        hGetAll(key(config, "state")),
        readFactories(config),
        readDeployments(config),
        readDownloadsSnapshot(config),
    ]);
    const sourceEntries = Object.entries(aggregate)
        .filter(([field]) => field.startsWith("attempts:"))
        .map(([field, value]) => [field.slice("attempts:".length), asNumber(value)] as const);
    const factoryTotal = factories.reduce((sum, factory) => sum + BigInt(factory.totalAgents), 0n);
    const aggregateAgents = BigInt(asString(aggregate.agentsMinted));
    const grossWei = asString(aggregate.grossMerchantReceiptsWei);
    const transferLogCount = asNumber(aggregate.transferLogCount);
    const settlementTxCount = asNumber(aggregate.settlementTxCount);
    const settledBillableCalls = Math.max(
        asNumber(aggregate.settledBillableCalls),
        transferLogCount,
        settlementTxCount,
    );

    return {
        dataset: config.dataset,
        chainId: config.chainId,
        fromDate: config.fromDate,
        lastIndexedBlock: state.lastReceiptBlock || "0",
        lastDeploymentIndexedBlock: state.lastDeploymentBlock || "0",
        merchantAddress: config.merchantAddress,
        deployerAddress: config.deployerAddress,
        usdcAddress: config.usdcAddress,
        grossMerchantReceiptsWei: grossWei,
        grossMerchantReceiptsUsdc: formatUsdcAtomic(grossWei),
        settlementTxCount,
        selfTransferCount: asNumber(aggregate.selfTransferCount),
        agentsMinted: Number(factoryTotal > aggregateAgents ? factoryTotal : aggregateAgents),
        agentFactories: factories,
        deployedContracts: deployments,
        calls: {
            settledBillable: settledBillableCalls,
            totalAttempts: asNumber(aggregate.totalAttempts),
            bySource: Object.fromEntries(sourceEntries),
        },
        downloads,
        evidence: {
            transferLogCount,
            ...(aggregate.lastSettlementTxHash ? { lastSettlementTxHash: aggregate.lastSettlementTxHash as Hash } : {}),
            warnings: config.warnings,
            ...(aggregate.updatedAt ? { updatedAt: asNumber(aggregate.updatedAt) } : {}),
        },
    };
}
