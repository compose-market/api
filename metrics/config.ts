import { getAddress, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { FUJI_CHAIN_ID, FUJI_USDC_ADDRESS } from "./types.js";

export interface MetricsConfig {
    dataset: string;
    redisPrefix: string;
    chainId: typeof FUJI_CHAIN_ID;
    rpcUrl: string;
    merchantAddress: Address;
    deployerAddress: Address;
    usdcAddress: Address;
    agentFactoryAddresses: Address[];
    knownContractAddresses: Address[];
    create2FactoryAddresses: Address[];
    explorerApiUrl: string;
    routescanApiUrl: string;
    explorerPageSize: number;
    sdkPackageName: string;
    meshRepoOwner: string;
    meshRepoName: string;
    githubToken?: string;
    downloadsRefreshMs: number;
    fromDate: string;
    fromBlock: bigint;
    pollIntervalMs: number;
    confirmations: number;
    logBlockChunk: bigint;
    scanFullBlocks: boolean;
    warnings: string[];
}

const KNOWN_CONTRACT_ENV_KEYS = [
    "AGENT_FACTORY_CONTRACT",
    "CLONE_CONTRACT",
    "WARP_CONTRACT",
    "WORKFLOW_CONTRACT",
    "RFA_CONTRACT",
    "LEASE_CONTRACT",
    "ROYALTIES_CONTRACT",
    "DISTRIBUTOR_CONTRACT",
    "DELEGATION_CONTRACT",
    "AGENT_MANAGER_CONTRACT",
    "UTILS_CONTRACT",
    "DISPENSER_CONTRACT",
];

function normalizeDataset(value: string | undefined): string {
    const dataset = (value || "fuji").trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-");
    if (!dataset || dataset === "-" || dataset.length > 64) {
        throw new Error("METRICS_DATASET must resolve to a 1-64 character key-safe name");
    }
    return dataset;
}

function normalizeAddress(value: string | undefined, name: string): Address {
    if (!value || !isAddress(value.trim())) {
        throw new Error(`${name} must be a valid EVM address`);
    }
    return getAddress(value.trim());
}

function optionalAddress(value: string | undefined): Address | null {
    if (!value || !isAddress(value.trim())) {
        return null;
    }
    return getAddress(value.trim());
}

function parseAddressList(value: string | undefined): Address[] {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => optionalAddress(entry))
        .filter((entry): entry is Address => Boolean(entry));
}

function uniqueAddresses(addresses: Address[]): Address[] {
    const seen = new Set<string>();
    const result: Address[] = [];
    for (const address of addresses) {
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(address);
    }
    return result;
}

function deriveDeployerAddress(): Address | null {
    const privateKey = process.env.DEPLOYER_KEY;
    if (!privateKey) return null;
    const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return privateKeyToAccount(normalized as `0x${string}`).address;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function parsePositiveBigIntEnv(name: string, fallback: bigint): bigint {
    const raw = process.env[name];
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw.trim())) {
        throw new Error(`${name} must be a positive integer`);
    }
    const parsed = BigInt(raw.trim());
    if (parsed <= 0n) {
        throw new Error(`${name} must be greater than zero`);
    }
    return parsed;
}

export function loadMetricsConfig(): MetricsConfig {
    const warnings: string[] = [];
    const dataset = normalizeDataset(process.env.METRICS_DATASET);
    const redisPrefix = (process.env.METRICS_REDIS_PREFIX || `metrics:${dataset}:v1`).replace(/:+$/g, "");

    const envFujiChainId = process.env.AVALANCHE_FUJI_CHAIN_ID;
    if (envFujiChainId && envFujiChainId !== String(FUJI_CHAIN_ID)) {
        warnings.push(`AVALANCHE_FUJI_CHAIN_ID is ${envFujiChainId}; metrics pins Fuji to ${FUJI_CHAIN_ID}.`);
    }

    const explorer = process.env.AVALANCHE_FUJI_EXPLORER;
    if (explorer && !/testnet|fuji/i.test(explorer)) {
        warnings.push("AVALANCHE_FUJI_EXPLORER does not look like a Fuji/testnet explorer; metrics ignores explorer HTML.");
    }

    const rpcUrl = process.env.METRICS_FUJI_RPC || process.env.AVALANCHE_FUJI_RPC;
    if (!rpcUrl) {
        throw new Error("AVALANCHE_FUJI_RPC or METRICS_FUJI_RPC is required");
    }

    const merchantAddress = normalizeAddress(
        process.env.METRICS_MERCHANT_ADDRESS || process.env.MERCHANT_WALLET_ADDRESS,
        "METRICS_MERCHANT_ADDRESS or MERCHANT_WALLET_ADDRESS",
    );

    const deployerAddress = optionalAddress(process.env.METRICS_DEPLOYER_ADDRESS)
        || deriveDeployerAddress();
    if (!deployerAddress) {
        throw new Error("METRICS_DEPLOYER_ADDRESS or DEPLOYER_KEY is required to resolve the deployer address");
    }

    const agentFactoryAddresses = uniqueAddresses([
        ...parseAddressList(process.env.METRICS_AGENT_FACTORY_CONTRACTS),
        ...parseAddressList(process.env.AGENT_FACTORY_CONTRACT),
    ]);

    const create2FactoryAddresses = uniqueAddresses([
        "0x4e59b44847b379578588920cA78FbF26c0B4956C" as Address,
        ...parseAddressList(process.env.METRICS_CREATE2_FACTORY_ADDRESSES),
    ]);

    const knownContractAddresses = uniqueAddresses([
        ...KNOWN_CONTRACT_ENV_KEYS.flatMap((key) => parseAddressList(process.env[key])),
        ...agentFactoryAddresses,
    ]);

    const fromDate = process.env.METRICS_FROM_DATE || "2025-12-01T00:00:00.000Z";
    if (Number.isNaN(Date.parse(fromDate))) {
        throw new Error("METRICS_FROM_DATE must be parseable by Date.parse");
    }

    return {
        dataset,
        redisPrefix,
        chainId: FUJI_CHAIN_ID,
        rpcUrl,
        merchantAddress,
        deployerAddress,
        usdcAddress: normalizeAddress(process.env.METRICS_USDC_ADDRESS || FUJI_USDC_ADDRESS, "METRICS_USDC_ADDRESS"),
        agentFactoryAddresses,
        knownContractAddresses,
        create2FactoryAddresses,
        explorerApiUrl: process.env.METRICS_EXPLORER_API_URL || "https://api-testnet.snowtrace.io/api",
        routescanApiUrl: process.env.METRICS_ROUTESCAN_API_URL || "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api",
        explorerPageSize: parsePositiveIntegerEnv("METRICS_EXPLORER_PAGE_SIZE", 1000),
        sdkPackageName: process.env.METRICS_SDK_PACKAGE || "@compose-market/sdk",
        meshRepoOwner: process.env.METRICS_MESH_REPO_OWNER || "compose-market",
        meshRepoName: process.env.METRICS_MESH_REPO_NAME || "mesh",
        githubToken: process.env.METRICS_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
        downloadsRefreshMs: parsePositiveIntegerEnv(
            "METRICS_DOWNLOADS_REFRESH_MS",
            process.env.METRICS_ADOPTION_REFRESH_MS
                ? parsePositiveIntegerEnv("METRICS_ADOPTION_REFRESH_MS", 15 * 60_000)
                : 15 * 60_000,
        ),
        fromDate: new Date(fromDate).toISOString(),
        fromBlock: parsePositiveBigIntEnv("METRICS_FROM_BLOCK", 48_000_000n),
        pollIntervalMs: parsePositiveIntegerEnv("METRICS_POLL_INTERVAL_MS", 15_000),
        confirmations: parsePositiveIntegerEnv("METRICS_CONFIRMATIONS", 1),
        logBlockChunk: parsePositiveBigIntEnv("METRICS_LOG_BLOCK_CHUNK", 10n),
        scanFullBlocks: process.env.METRICS_SCAN_FULL_BLOCKS !== "false",
        warnings,
    };
}
