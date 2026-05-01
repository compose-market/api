import {
    createPublicClient,
    decodeEventLog,
    getAddress,
    getContractAddress,
    http,
    parseAbi,
    parseAbiItem,
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
} from "viem";
import { avalancheFuji } from "viem/chains";

import { loadMetricsConfig, type MetricsConfig } from "./config.js";
import {
    readMetricsState,
    recordFastReceiptAggregateMetric,
    recordAgentFactoryMetric,
    recordContractDeploymentMetric,
    recordTransferLogMetric,
    updateMetricsState,
} from "./redis.js";
import { refreshDownloadMetrics } from "./downloads.js";
import { getRoutescanLogs, paddedTopicAddress } from "./routescan.js";
import { FUJI_CHAIN_ID, type MetricsBackfillSummary } from "./types.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const CREATE2_DEPLOYED_EVENT = parseAbiItem("event Deployed(address indexed deployedAddress,address indexed deployer,bytes32 salt)");
const AGENT_FACTORY_ABI = parseAbi([
    "function totalAgents() view returns (uint256)",
]);

type MetricsPublicClient = PublicClient;

interface SnowtraceTx {
    blockNumber: string;
    timeStamp: string;
    hash: Hash;
    from: Address;
    to: Address | "";
    contractAddress: Address | "";
    input: Hex;
    txreceipt_status?: string;
    isError?: string;
}

interface SnowtraceTxListResponse {
    status: string;
    message: string;
    result: unknown[] | string;
}

export function createMetricsPublicClient(config = loadMetricsConfig()): MetricsPublicClient {
    return createPublicClient({
        chain: avalancheFuji,
        transport: http(config.rpcUrl, {
            retryCount: 2,
            retryDelay: 500,
            timeout: 30_000,
        }),
    });
}

export async function assertFujiRpc(client: MetricsPublicClient, config = loadMetricsConfig()): Promise<void> {
    const chainId = await client.getChainId();
    if (chainId !== FUJI_CHAIN_ID || chainId !== config.chainId) {
        throw new Error(`Metrics RPC must be Avalanche Fuji (${FUJI_CHAIN_ID}); got chain ${chainId}`);
    }
}

async function latestConfirmedBlock(client: MetricsPublicClient, config: MetricsConfig): Promise<bigint> {
    const latest = await client.getBlockNumber();
    const confirmations = BigInt(config.confirmations);
    return latest > confirmations ? latest - confirmations : latest;
}

export async function findBlockAtOrAfterTimestamp(
    client: MetricsPublicClient,
    unixSeconds: bigint,
): Promise<bigint> {
    const latest = await client.getBlockNumber();
    let low = 0n;
    let high = latest;
    while (low < high) {
        const mid = (low + high) / 2n;
        const block = await client.getBlock({ blockNumber: mid });
        if (block.timestamp < unixSeconds) {
            low = mid + 1n;
        } else {
            high = mid;
        }
    }
    return low;
}

async function readFactoryTotal(
    client: MetricsPublicClient,
    address: Address,
): Promise<bigint | null> {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return null;
    try {
        return await client.readContract({
            address,
            abi: AGENT_FACTORY_ABI,
            functionName: "totalAgents",
        });
    } catch {
        return null;
    }
}

export async function refreshConfiguredAgentFactories(
    client = createMetricsPublicClient(),
    config = loadMetricsConfig(),
): Promise<number> {
    let checked = 0;
    for (const address of config.agentFactoryAddresses) {
        const totalAgents = await readFactoryTotal(client, address);
        if (totalAgents === null) continue;
        checked++;
        await recordContractDeploymentMetric({
            address,
            deployer: config.deployerAddress,
            source: "configured-env",
            classifiedAs: "agent-factory",
            discoveredAt: Date.now(),
        }, config);
        await recordAgentFactoryMetric({
            address,
            totalAgents: totalAgents.toString(),
            confidence: "configured",
            lastCheckedAt: Date.now(),
        }, config);
    }
    return checked;
}

async function classifyContract(
    client: MetricsPublicClient,
    address: Address,
    input: {
        deployedAtBlock?: bigint;
        deploymentTxHash?: Hash;
        source: "direct-create" | "create2-event" | "create2-derived" | "configured-env";
    },
    config: MetricsConfig,
): Promise<boolean> {
    const totalAgents = await readFactoryTotal(client, address);
    await recordContractDeploymentMetric({
        address,
        deployer: config.deployerAddress,
        ...(input.deployedAtBlock !== undefined ? { deployedAtBlock: input.deployedAtBlock.toString() } : {}),
        ...(input.deploymentTxHash ? { deploymentTxHash: input.deploymentTxHash } : {}),
        source: input.source,
        classifiedAs: totalAgents === null ? "unknown" : "agent-factory",
        discoveredAt: Date.now(),
    }, config);

    if (totalAgents === null) return false;

    await recordAgentFactoryMetric({
        address,
        totalAgents: totalAgents.toString(),
        confidence: input.source === "configured-env" ? "configured" : "abi-probed",
        ...(input.deployedAtBlock !== undefined ? { deployedAtBlock: input.deployedAtBlock.toString() } : {}),
        ...(input.deploymentTxHash ? { deploymentTxHash: input.deploymentTxHash } : {}),
        lastCheckedAt: Date.now(),
    }, config);
    return true;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExplorerTx(raw: Record<string, unknown>): SnowtraceTx | null {
    const hash = typeof raw.hash === "string" && /^0x[a-fA-F0-9]{64}$/.test(raw.hash)
        ? raw.hash as Hash
        : null;
    const from = typeof raw.from === "string" && /^0x[a-fA-F0-9]{40}$/.test(raw.from)
        ? getAddress(raw.from)
        : null;
    const blockNumber = typeof raw.blockNumber === "string" ? raw.blockNumber : null;
    const timeStamp = typeof raw.timeStamp === "string" ? raw.timeStamp : "";
    if (!hash || !from || !blockNumber) return null;
    const to = typeof raw.to === "string" && /^0x[a-fA-F0-9]{40}$/.test(raw.to)
        ? getAddress(raw.to)
        : "";
    const contractAddress = typeof raw.contractAddress === "string" && /^0x[a-fA-F0-9]{40}$/.test(raw.contractAddress)
        ? getAddress(raw.contractAddress)
        : "";
    const input = typeof raw.input === "string" && /^0x[a-fA-F0-9]*$/.test(raw.input)
        ? raw.input as Hex
        : "0x";
    return {
        blockNumber,
        timeStamp,
        hash,
        from,
        to,
        contractAddress,
        input,
        txreceipt_status: typeof raw.txreceipt_status === "string" ? raw.txreceipt_status : undefined,
        isError: typeof raw.isError === "string" ? raw.isError : undefined,
    };
}

function deriveSingletonCreate2Address(tx: SnowtraceTx): Address | null {
    if (!tx.to || tx.input.length <= 66) return null;
    const salt = tx.input.slice(0, 66) as Hex;
    const bytecode = `0x${tx.input.slice(66)}` as Hex;
    if (bytecode === "0x") return null;
    return getContractAddress({
        opcode: "CREATE2",
        from: tx.to,
        salt,
        bytecode,
    });
}

async function fetchExplorerTxPage(
    config: MetricsConfig,
    page: number,
    startBlock: bigint,
    endBlock: bigint,
): Promise<SnowtraceTx[]> {
    const url = new URL(config.explorerApiUrl);
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "txlist");
    url.searchParams.set("address", config.deployerAddress);
    url.searchParams.set("startblock", startBlock.toString());
    url.searchParams.set("endblock", endBlock.toString());
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(config.explorerPageSize));
    url.searchParams.set("sort", "asc");

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
        throw new Error(`Snowtrace txlist failed with ${response.status}`);
    }
    const body = await response.json() as SnowtraceTxListResponse;
    if (!Array.isArray(body.result)) {
        if (body.status === "0" && /No transactions found/i.test(String(body.result))) {
            return [];
        }
        throw new Error(`Snowtrace txlist returned ${body.message}: ${String(body.result)}`);
    }
    return body.result
        .map((entry) => normalizeExplorerTx(entry as Record<string, unknown>))
        .filter((entry): entry is SnowtraceTx => Boolean(entry));
}

async function scanExplorerMerchantTransfers(
    client: MetricsPublicClient,
    startBlock: bigint,
    endBlock: bigint,
    config: MetricsConfig,
): Promise<{ pages: number; transfers: number; logs: number }> {
    void client;
    const result = await getRoutescanLogs({
        base: config.routescanApiUrl,
        address: config.usdcAddress,
        topic0: TRANSFER_TOPIC,
        topic2: paddedTopicAddress(config.merchantAddress),
        fromBlock: Number(startBlock),
        toBlock: Number(endBlock),
    });

    let transferLogs = 0;
    let selfTransfers = 0;
    let grossMerchantReceiptsWei = 0n;
    let lastSettlementTxHash: Hash | undefined;
    const txHashes = new Set<string>();

    for (const log of result.logs) {
        if (log.address.toLowerCase() !== config.usdcAddress.toLowerCase()) continue;
        if (log.topics.length < 3) continue;
        try {
            const from = getAddress(`0x${log.topics[1].slice(-40)}`);
            const to = getAddress(`0x${log.topics[2].slice(-40)}`);
            if (to.toLowerCase() !== config.merchantAddress.toLowerCase()) continue;
            const value = BigInt(log.data);
            grossMerchantReceiptsWei += value;
            transferLogs++;
            txHashes.add(log.transactionHash.toLowerCase());
            lastSettlementTxHash = log.transactionHash as Hash;
            if (from.toLowerCase() === config.merchantAddress.toLowerCase()) {
                selfTransfers++;
            }
        } catch {
            continue;
        }
    }
    await recordFastReceiptAggregateMetric({
        grossMerchantReceiptsWei,
        settlementTxCount: txHashes.size,
        transferLogCount: transferLogs,
        selfTransferCount: selfTransfers,
        lastSettlementTxHash,
        source: "routescan-log-aggregate",
    }, config);
    return { pages: result.pages, transfers: result.logs.length, logs: transferLogs };
}

async function scanExplorerDeployments(
    client: MetricsPublicClient,
    startBlock: bigint,
    endBlock: bigint,
    config: MetricsConfig,
): Promise<{ pages: number; deployments: number; factories: number }> {
    let page = 1;
    let pages = 0;
    let deployments = 0;
    let factories = 0;
    const create2Factories = new Set(config.create2FactoryAddresses.map((address) => address.toLowerCase()));

    while (true) {
        const txs = await fetchExplorerTxPage(config, page, startBlock, endBlock);
        if (txs.length === 0) break;
        pages++;

        for (const tx of txs) {
            if (tx.from.toLowerCase() !== config.deployerAddress.toLowerCase()) continue;
            if (tx.txreceipt_status === "0" || tx.isError === "1") continue;

            if (tx.contractAddress) {
                deployments++;
                if (await classifyContract(client, tx.contractAddress, {
                    source: "direct-create",
                    deployedAtBlock: BigInt(tx.blockNumber),
                    deploymentTxHash: tx.hash,
                }, config)) {
                    factories++;
                }
            }

            if (tx.to && create2Factories.has(tx.to.toLowerCase())) {
                const derived = deriveSingletonCreate2Address(tx);
                if (derived) {
                    deployments++;
                    if (await classifyContract(client, derived, {
                        source: "create2-derived",
                        deployedAtBlock: BigInt(tx.blockNumber),
                        deploymentTxHash: tx.hash,
                    }, config)) {
                        factories++;
                    }
                }
                const receipt = await client.getTransactionReceipt({ hash: tx.hash });
                for (const log of receipt.logs) {
                    const deployedAddress = decodeCreate2DeploymentFromReceiptLog({
                        topics: log.topics,
                        data: log.data,
                    }, config);
                    if (!deployedAddress) continue;
                    deployments++;
                    if (await classifyContract(client, deployedAddress, {
                        source: "create2-event",
                        deployedAtBlock: BigInt(tx.blockNumber),
                        deploymentTxHash: tx.hash,
                    }, config)) {
                        factories++;
                    }
                }
            }
        }

        if (txs.length < config.explorerPageSize) break;
        page++;
        await sleep(250);
    }

    return { pages, deployments, factories };
}

function nextRange(fromBlock: bigint, targetBlock: bigint, size: bigint): { fromBlock: bigint; toBlock: bigint } {
    const toBlock = fromBlock + size - 1n;
    return {
        fromBlock,
        toBlock: toBlock > targetBlock ? targetBlock : toBlock,
    };
}

async function scanMerchantTransfersRange(
    client: MetricsPublicClient,
    fromBlock: bigint,
    toBlock: bigint,
    config: MetricsConfig,
): Promise<number> {
    const logs = await client.getLogs({
        address: config.usdcAddress,
        event: TRANSFER_EVENT,
        args: { to: config.merchantAddress },
        fromBlock,
        toBlock,
    });

    for (const log of logs) {
        if (!log.args.from || !log.args.to || log.args.value === undefined || !log.blockNumber) {
            continue;
        }
        await recordTransferLogMetric({
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            from: getAddress(log.args.from),
            to: getAddress(log.args.to),
            value: log.args.value,
        }, config);
    }
    return logs.length;
}

async function scanCreate2DeploymentsRange(
    client: MetricsPublicClient,
    fromBlock: bigint,
    toBlock: bigint,
    config: MetricsConfig,
): Promise<number> {
    const logs = await client.getLogs({
        event: CREATE2_DEPLOYED_EVENT,
        args: { deployer: config.deployerAddress },
        fromBlock,
        toBlock,
    });
    let discovered = 0;
    for (const log of logs) {
        if (!log.args.deployedAddress) continue;
        const isFactory = await classifyContract(client, getAddress(log.args.deployedAddress), {
            source: "create2-event",
            deployedAtBlock: log.blockNumber,
            deploymentTxHash: log.transactionHash,
        }, config);
        discovered += isFactory ? 1 : 0;
    }
    return discovered;
}

function decodeCreate2DeploymentFromReceiptLog(
    log: { topics: readonly Hash[]; data: Hash },
    config: MetricsConfig,
): Address | null {
    try {
        const decoded = decodeEventLog({
            abi: [CREATE2_DEPLOYED_EVENT],
            data: log.data,
            topics: [...log.topics] as [Hash, ...Hash[]],
        });
        const args = decoded.args as { deployedAddress?: Address; deployer?: Address };
        return args.deployer?.toLowerCase() === config.deployerAddress.toLowerCase()
            && args.deployedAddress
            ? getAddress(args.deployedAddress)
            : null;
    } catch {
        return null;
    }
}

async function scanDirectDeploymentsRange(
    client: MetricsPublicClient,
    fromBlock: bigint,
    toBlock: bigint,
    config: MetricsConfig,
): Promise<number> {
    if (!config.scanFullBlocks) return 0;
    let discovered = 0;
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
        const block = await client.getBlock({ blockNumber, includeTransactions: true });
        for (const tx of block.transactions as Array<{ hash: Hash; from: Address; to: Address | null }>) {
            if (tx.from.toLowerCase() !== config.deployerAddress.toLowerCase()) continue;
            const receipt = await client.getTransactionReceipt({ hash: tx.hash });
            if (!tx.to && receipt.contractAddress) {
                const isFactory = await classifyContract(client, getAddress(receipt.contractAddress), {
                    source: "direct-create",
                    deployedAtBlock: blockNumber,
                    deploymentTxHash: tx.hash,
                }, config);
                discovered += isFactory ? 1 : 0;
            }
            for (const log of receipt.logs) {
                const deployedAddress = decodeCreate2DeploymentFromReceiptLog({
                    topics: log.topics,
                    data: log.data,
                }, config);
                if (!deployedAddress) continue;
                const isFactory = await classifyContract(client, deployedAddress, {
                    source: "create2-event",
                    deployedAtBlock: blockNumber,
                    deploymentTxHash: tx.hash,
                }, config);
                discovered += isFactory ? 1 : 0;
            }
        }
    }
    return discovered;
}

export async function runMetricsBackfill(options: {
    fromDate?: string;
    maxRanges?: number;
    targetBlock?: bigint;
    skipDeploymentDiscovery?: boolean;
} = {}): Promise<MetricsBackfillSummary> {
    const config = loadMetricsConfig();
    const client = createMetricsPublicClient(config);
    await assertFujiRpc(client, config);

    const factoriesChecked = await refreshConfiguredAgentFactories(client, config);
    for (const address of config.knownContractAddresses) {
        await classifyContract(client, address, { source: "configured-env" }, config);
    }

    const targetBlock = options.targetBlock ?? await latestConfirmedBlock(client, config);
    const fromDate = options.fromDate || config.fromDate;
    const startBlock = options.fromDate || process.env.METRICS_RESOLVE_FROM_DATE_BLOCK === "true"
        ? await findBlockAtOrAfterTimestamp(client, BigInt(Math.floor(Date.parse(fromDate) / 1000)))
        : config.fromBlock;
    const state = await readMetricsState(config);
    let receiptCursor = state.lastReceiptBlock ? BigInt(state.lastReceiptBlock) + 1n : startBlock;
    let deploymentCursor = state.lastDeploymentBlock ? BigInt(state.lastDeploymentBlock) + 1n : startBlock;
    const maxRanges = options.maxRanges ?? Number.parseInt(process.env.METRICS_BACKFILL_MAX_RANGES || "250", 10);

    let receiptRangesProcessed = 0;
    let deploymentRangesProcessed = 0;
    let transferLogsProcessed = 0;
    let deploymentsDiscovered = 0;

    let explorerPages = 0;
    let explorerReceiptPages = 0;
    const skipDeploymentDiscovery = options.skipDeploymentDiscovery
        || process.env.METRICS_SKIP_DEPLOYMENT_DISCOVERY === "true";

    if (!skipDeploymentDiscovery && process.env.METRICS_EXPLORER_DISCOVERY !== "false") {
        const explorer = await scanExplorerDeployments(client, startBlock, targetBlock, config);
        explorerPages = explorer.pages;
        deploymentsDiscovered += explorer.deployments;
        await updateMetricsState({
            lastExplorerDeploymentBlock: targetBlock,
            lastExplorerDeploymentAt: Date.now(),
        }, config);
    }

    if (process.env.METRICS_EXPLORER_RECEIPTS !== "false") {
        const explorerReceipts = await scanExplorerMerchantTransfers(client, startBlock, targetBlock, config);
        explorerReceiptPages = explorerReceipts.pages;
        transferLogsProcessed += explorerReceipts.logs;
        if (explorerReceipts.pages > 0) {
            await updateMetricsState({ lastReceiptBlock: targetBlock, latestBlock: targetBlock }, config);
            receiptCursor = targetBlock + 1n;
        }
    }

    while (receiptCursor <= targetBlock && receiptRangesProcessed < maxRanges) {
        const range = nextRange(receiptCursor, targetBlock, config.logBlockChunk);
        transferLogsProcessed += await scanMerchantTransfersRange(client, range.fromBlock, range.toBlock, config);
        await updateMetricsState({ lastReceiptBlock: range.toBlock, latestBlock: targetBlock }, config);
        receiptCursor = range.toBlock + 1n;
        receiptRangesProcessed++;
    }

    while (!skipDeploymentDiscovery && deploymentCursor <= targetBlock && deploymentRangesProcessed < maxRanges) {
        const range = nextRange(deploymentCursor, targetBlock, config.logBlockChunk);
        deploymentsDiscovered += await scanCreate2DeploymentsRange(client, range.fromBlock, range.toBlock, config);
        deploymentsDiscovered += await scanDirectDeploymentsRange(client, range.fromBlock, range.toBlock, config);
        await updateMetricsState({ lastDeploymentBlock: range.toBlock, latestBlock: targetBlock }, config);
        deploymentCursor = range.toBlock + 1n;
        deploymentRangesProcessed++;
    }

    await refreshConfiguredAgentFactories(client, config);
    await refreshDownloadMetrics({ config }).catch((error) => {
        console.warn(`[metrics] downloads refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    const finalState = await readMetricsState(config);
    return {
        dataset: config.dataset,
        chainId: config.chainId,
        fromBlock: startBlock.toString(),
        toBlock: targetBlock.toString(),
        receiptCursor: finalState.lastReceiptBlock || "0",
        deploymentCursor: finalState.lastDeploymentBlock || "0",
        receiptRangesProcessed,
        deploymentRangesProcessed,
        explorerDeploymentPages: explorerPages,
        explorerReceiptPages,
        transferLogsProcessed,
        deploymentsDiscovered,
        factoriesChecked,
        warnings: explorerPages > 0 || explorerReceiptPages > 0
            ? config.warnings
            : [...config.warnings, "Explorer deployer discovery returned no pages; RPC block scan fallback remains active."],
    };
}
