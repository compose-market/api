import { base58 } from "@scure/base";
import { defineChain, type Chain as ViemChain } from "viem";
import {
    arbitrum,
    arbitrumSepolia,
    arc,
    arcTestnet,
    base,
    baseSepolia,
    avalanche,
    avalancheFuji,
    sei,
    seiTestnet,
    tempoModerato
} from "viem/chains";

export type EvmNetworkId = `eip155:${number}`;
export type SolanaNetworkId = `solana:${string}`;
export type NearNetworkId = `near:${string}`;
export type NetworkId = EvmNetworkId | SolanaNetworkId | NearNetworkId;
export type NetworkNamespace = "eip155" | "solana" | "near";
export type NetworkEnvironment = "testnet" | "mainnet";
export type PaymentScheme = "exact" | "upto" | "batch-settlement";
export type AssetSymbol = "USDC" | "USDT" | "OUSD";
export type AssetTransferMethod = "transferFrom" | "permit2";

export interface NetworkDefinition {
    id: NetworkId;
    key: string;
    name: string;
    shortName: string;
    namespace: NetworkNamespace;
    environment: NetworkEnvironment;
    explorer: string;
    explorerQuery?: string;
    rpcEnvVar: string;
    asset: {
        address: string;
        symbol: AssetSymbol;
        name: string;
        version: string;
        decimals: 6;
        /**
         * Transfer method used by signed x402 deposits for assets without
         * EIP-3009/EIP-2612 support (e.g. USDT). Omitted for EIP-3009 assets.
         */
        assetTransferMethod?: AssetTransferMethod;
    };
    schemes: readonly PaymentScheme[];
    enabled: boolean;
}

export const NETWORK_IDS = {
    avalancheFuji: "eip155:43113",
    avalanche: "eip155:43114",
    arbitrumSepolia: "eip155:421614",
    arbitrum: "eip155:42161",
    baseSepolia: "eip155:84532",
    base: "eip155:8453",
    arcTestnet: "eip155:5042002",
    arc: "eip155:5042",
    seiTestnet: "eip155:1328",
    sei: "eip155:1329",
    // botchain: "eip155:677",
    tempoModerato: "eip155:42431",
    solanaDevnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    nearTestnet: "near:testnet",
    near: "near:mainnet",
} as const satisfies Record<string, NetworkId>;

const ALL_SCHEMES = ["exact", "upto", "batch-settlement"] as const;

export const NETWORKS = [
    network(NETWORK_IDS.avalancheFuji, "avalanche-fuji", "Avalanche Fuji", "Fuji", "eip155", "testnet", "https://testnet.snowtrace.io/", "AVALANCHE_FUJI_RPC", "0x5425890298aed601595a70AB815c96711a31Bc65", undefined, "USD Coin"),
    network(NETWORK_IDS.avalanche, "avalanche", "Avalanche", "Avalanche", "eip155", "mainnet", "https://snowtrace.io/", "AVALANCHE_MAINNET_RPC", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", undefined, "USD Coin"),
    network(NETWORK_IDS.arbitrumSepolia, "arbitrum-sepolia", "Arbitrum Sepolia", "Arb Sepolia", "eip155", "testnet", "https://sepolia.arbiscan.io", "ARBITRUM_SEPOLIA_RPC", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", undefined, "USDC"),
    network(NETWORK_IDS.arbitrum, "arbitrum", "Arbitrum One", "Arbitrum", "eip155", "mainnet", "https://arbiscan.io", "ARBITRUM_MAINNET_RPC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", undefined, "USDC"),
    network(NETWORK_IDS.baseSepolia, "base-sepolia", "Base Sepolia", "Base Sepolia", "eip155", "testnet", "https://sepolia.basescan.org", "BASE_SEPOLIA_RPC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", undefined, "USDC"),
    network(NETWORK_IDS.base, "base", "Base", "Base", "eip155", "mainnet", "https://basescan.org", "BASE_MAINNET_RPC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", undefined, "USDC"),
    network(NETWORK_IDS.arcTestnet, "arc-testnet", "Arc Testnet", "Arc Testnet", "eip155", "testnet", "https://testnet.arcscan.app", "ARC_TESTNET_RPC", "0x3600000000000000000000000000000000000000", undefined, "USDC"),
    network(NETWORK_IDS.arc, "arc", "Arc", "Arc", "eip155", "mainnet", "https://arcexplorer.org", "ARC_MAINNET_RPC", "0x3600000000000000000000000000000000000000", undefined, "USDC"),
    network(NETWORK_IDS.seiTestnet, "sei-testnet", "Sei Testnet", "Sei Testnet", "eip155", "testnet", "https://testnet.seiscan.io", "SEI_TESTNET_RPC", "0x4fCF1784B31630811181f670Aea7A7bEF803eaED", undefined, "USDC"),
    network(NETWORK_IDS.sei, "sei", "Sei", "Sei", "eip155", "mainnet", "https://seiscan.io", "SEI_MAINNET_RPC", "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", undefined, "USDC"),
    network(NETWORK_IDS.tempoModerato, "tempo-moderato", "Tempo Moderato", "Tempo Moderato", "eip155", "testnet", "https://explore.testnet.tempo.xyz", "TEMPO_MODERATO_RPC", "0x20c0000000000000000000006a37DA5C996874BE", undefined, "OpenUSD", "2", "OUSD"),

    // USDT on Botchain has no EIP-3009/EIP-2612 support, so signed x402
    // deposits route through Permit2 instead.
    // network(NETWORK_IDS.botchain, "botchain", "Botchain", "Botchain", "eip155", "mainnet", "https://scan.botchain.ai", "BOTCHAIN_MAINNET_RPC", "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C", undefined, "Tether USD", "1", "USDT", "permit2"),

    network(NETWORK_IDS.solanaDevnet, "solana-devnet", "Solana Devnet", "Solana Devnet", "solana", "testnet", "https://explorer.solana.com", "SOLANA_DEVNET_RPC", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "cluster=devnet"),
    network(NETWORK_IDS.solana, "solana", "Solana", "Solana", "solana", "mainnet", "https://explorer.solana.com", "SOLANA_MAINNET_RPC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", undefined, "USD Coin"),
    network(NETWORK_IDS.nearTestnet, "near-testnet", "NEAR Testnet", "NEAR Testnet", "near", "testnet", "https://testnet.nearblocks.io", "NEAR_TESTNET_RPC", process.env.NEAR_TESTNET_USDC_ADDRESS?.trim() || "usdc.tidepool-sandbox.testnet", undefined, "USDC"),
    network(NETWORK_IDS.near, "near", "NEAR", "NEAR", "near", "mainnet", "https://nearblocks.io", "NEAR_MAINNET_RPC", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", undefined, "USDC"),
] as const satisfies readonly NetworkDefinition[];

function network(
    id: NetworkId,
    key: string,
    name: string,
    shortName: string,
    namespace: NetworkNamespace,
    environment: NetworkEnvironment,
    explorer: string,
    rpcEnvVar: string,
    assetAddress: string,
    explorerQuery?: string,
    // EIP-712 domain name/version of the on-chain USDC token. Circle
    // deployments differ per chain ("USD Coin" on Avalanche, "USDC" on
    // Arc/Sei); EIP-3009 deposit signatures fail closed on any mismatch.
    assetName = "USD Coin",
    assetVersion = "2",
    assetSymbol: AssetSymbol = "USDC",
    assetTransferMethod?: AssetTransferMethod,
): NetworkDefinition {
    return {
        id,
        key,
        name,
        shortName,
        namespace,
        environment,
        explorer,
        explorerQuery,
        rpcEnvVar,
        asset: {
            address: assetAddress,
            symbol: assetSymbol,
            name: assetName,
            version: assetVersion,
            decimals: 6,
            ...(assetTransferMethod ? { assetTransferMethod } : {}),
        },
        schemes: ALL_SCHEMES,
        enabled: true,
    };
}

const NETWORK_BY_ID = new Map<NetworkId, NetworkDefinition>(NETWORKS.map((entry) => [entry.id, entry]));

export function isNetworkId(value: string): value is NetworkId {
    return NETWORK_BY_ID.has(value as NetworkId);
}

export function getNetwork(id: NetworkId): NetworkDefinition {
    const value = NETWORK_BY_ID.get(id);
    if (!value) throw new Error(`Unsupported network: ${id}`);
    return value;
}

export function getSupportedNetworks(): NetworkDefinition[] {
    return NETWORKS.filter((entry) => entry.enabled);
}

export function isTestnetNetwork(id: NetworkId): boolean {
    const value = NETWORK_BY_ID.get(id);
    return value ? value.environment === "testnet" : false;
}

/**
 * Returns true if the network is allowed for Compose Market internal services
 * (inference, agents, session keys, payment intents).
 *
 * All mainnets are supported. For testing purposes, Base Sepolia is also supported.
 * All other testnets are blocked from our services.
 */
export function isServiceAllowedNetwork(id: NetworkId): boolean {
    const def = NETWORK_BY_ID.get(id);
    if (!def || !def.enabled) return false;
    // TEMP(near:testnet): temporary E2E exception alongside Base Sepolia; remove `|| id === NETWORK_IDS.nearTestnet` to enforce near:mainnet only.
    return def.environment === "mainnet" || id === NETWORK_IDS.baseSepolia || id === NETWORK_IDS.nearTestnet;
}

export function isServiceBlockedNetwork(id: NetworkId): boolean {
    return !isServiceAllowedNetwork(id);
}

export function getServiceSupportedNetworks(): NetworkDefinition[] {
    return NETWORKS.filter((entry) => entry.enabled && isServiceAllowedNetwork(entry.id));
}

export function isEvmNetwork(id: NetworkId): id is EvmNetworkId {
    return id.startsWith("eip155:");
}

export function isSolanaNetwork(id: NetworkId): id is SolanaNetworkId {
    return id.startsWith("solana:");
}

export function isNearNetwork(id: NetworkId): id is NearNetworkId {
    return id.startsWith("near:");
}

export function validateSolanaAddress(value: string): boolean {
    const normalized = value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized)) return false;
    try {
        return base58.decode(normalized).length === 32;
    } catch {
        return false;
    }
}

export function evmChainId(id: EvmNetworkId): number {
    const value = Number.parseInt(id.slice("eip155:".length), 10);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid EVM network: ${id}`);
    return value;
}

export function getNetworkRpcUrl(id: NetworkId): string {
    const definition = getNetwork(id);
    const value = process.env[definition.rpcEnvVar];
    if (!value) throw new Error(`RPC URL for ${id} (${definition.rpcEnvVar}) is missing`);
    return value;
}

export type ExplorerItemType = "tx" | "address" | "block" | "token";

export function getExplorerUrl(id: NetworkId, type: ExplorerItemType, value: string): string {
    const definition = getNetwork(id);
    const base = definition.explorer.replace(/\/$/, "");
    const path = `${base}/${type}/${value}`;
    return definition.explorerQuery ? `${path}?${definition.explorerQuery}` : path;
}

export function getDefaultNetwork(): NetworkId {
    const value = process.env.DEFAULT_NETWORK || NETWORK_IDS.arc;
    if (!isNetworkId(value)) throw new Error(`Unsupported DEFAULT_NETWORK value: ${value}`);
    return value;
}

// const botchain = defineChain({
//     id: 677,
//     name: "Botchain",
//     nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
//     rpcUrls: { default: { http: ["https://rpc.botchain.ai"] } },
//     blockExplorers: { default: { name: "Botchain Explorer", url: "https://scan.botchain.ai" } },
// });

const VIEM_CHAIN_MAP: Record<EvmNetworkId, ViemChain> = {
    // [NETWORK_IDS.avalancheFuji]: avalancheFuji,
    [NETWORK_IDS.avalanche]: avalanche,
    // [NETWORK_IDS.arbitrumSepolia]: arbitrumSepolia,
    [NETWORK_IDS.arbitrum]: arbitrum,
    // [NETWORK_IDS.arcTestnet]: arcTestnet,
    [NETWORK_IDS.arc]: arc,
    // [NETWORK_IDS.seiTestnet]: seiTestnet,
    [NETWORK_IDS.sei]: sei,
    // [NETWORK_IDS.botchain]: botchain,
};

export function getViemChain(id: EvmNetworkId): ViemChain {
    return VIEM_CHAIN_MAP[id];
}
