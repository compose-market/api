import type { Chain as ViemChain } from "viem";
import {
    arbitrum,
    // arbitrumSepolia,
    // arc,
    arcTestnet,
    avalanche,
    // avalancheFuji,
    sei,
    // seiTestnet,
} from "viem/chains";

export type EvmNetworkId = `eip155:${number}`;
export type SolanaNetworkId = `solana:${string}`;
export type NetworkId = EvmNetworkId | SolanaNetworkId;
export type NetworkNamespace = "eip155" | "solana";
export type NetworkEnvironment = "testnet" | "mainnet";
export type PaymentScheme = "exact" | "upto" | "batch-settlement";

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
        symbol: "USDC";
        name: "Circle USD";
        version: "2";
        decimals: 6;
    };
    schemes: readonly PaymentScheme[];
    enabled: boolean;
}

export const NETWORK_IDS = {
    // avalancheFuji: "eip155:43113",
    avalanche: "eip155:43114",
    // arbitrumSepolia: "eip155:421614",
    arbitrum: "eip155:42161",
    arcTestnet: "eip155:5042002",
    // arc: "eip155:5042",
    // seiTestnet: "eip155:1328",
    sei: "eip155:1329",
    // solanaDevnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
} as const satisfies Record<string, NetworkId>;

const ALL_SCHEMES = ["exact", "upto", "batch-settlement"] as const;

export const NETWORKS = [
    // network(NETWORK_IDS.avalancheFuji, "avalanche-fuji", "Avalanche Fuji", "Fuji", "eip155", "testnet", "https://testnet.snowtrace.io/", "AVALANCHE_FUJI_RPC", "0x5425890298aed601595a70AB815c96711a31Bc65"),
    network(NETWORK_IDS.avalanche, "avalanche", "Avalanche C-Chain", "Avalanche", "eip155", "mainnet", "https://snowtrace.io/", "AVALANCHE_MAINNET_RPC", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
    // network(NETWORK_IDS.arbitrumSepolia, "arbitrum-sepolia", "Arbitrum Sepolia", "Arb Sepolia", "eip155", "testnet", "https://sepolia.arbiscan.io", "ARBITRUM_SEPOLIA_RPC", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
    // network(NETWORK_IDS.arbitrum, "arbitrum", "Arbitrum One", "Arbitrum", "eip155", "mainnet", "https://arbiscan.io", "ARBITRUM_MAINNET_RPC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    network(NETWORK_IDS.arcTestnet, "arc-testnet", "Arc Testnet", "Arc Testnet", "eip155", "testnet", "https://testnet.arcscan.app", "ARC_TESTNET_RPC", "0x3600000000000000000000000000000000000000"),
    // network(NETWORK_IDS.arc, "arc", "Arc", "Arc", "eip155", "mainnet", "https://arcscan.app", "ARC_MAINNET_RPC", "0x3600000000000000000000000000000000000000"),
    // network(NETWORK_IDS.seiTestnet, "sei-testnet", "Sei Testnet", "Sei Testnet", "eip155", "testnet", "https://testnet.seiscan.io", "SEI_TESTNET_RPC", "0x4fCF1784B31630811181f670Aea7A7bEF803eaED"),
    network(NETWORK_IDS.sei, "sei", "Sei", "Sei", "eip155", "mainnet", "https://seiscan.io", "SEI_MAINNET_RPC", "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392"),
    // network(NETWORK_IDS.solanaDevnet, "solana-devnet", "Solana Devnet", "Solana Devnet", "solana", "testnet", "https://explorer.solana.com", "SOLANA_DEVNET_RPC", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "cluster=devnet"),
    network(NETWORK_IDS.solana, "solana", "Solana", "Solana", "solana", "mainnet", "https://explorer.solana.com", "SOLANA_MAINNET_RPC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
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
            symbol: "USDC",
            name: "Circle USD",
            version: "2",
            decimals: 6,
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

export function isEvmNetwork(id: NetworkId): id is EvmNetworkId {
    return id.startsWith("eip155:");
}

export function isSolanaNetwork(id: NetworkId): id is SolanaNetworkId {
    return id.startsWith("solana:");
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
    const value = process.env.DEFAULT_NETWORK || NETWORK_IDS.arcTestnet;
    if (!isNetworkId(value)) throw new Error(`Unsupported DEFAULT_NETWORK value: ${value}`);
    return value;
}

const VIEM_CHAIN_MAP: Record<EvmNetworkId, ViemChain> = {
    // [NETWORK_IDS.avalancheFuji]: avalancheFuji,
    [NETWORK_IDS.avalanche]: avalanche,
    // [NETWORK_IDS.arbitrumSepolia]: arbitrumSepolia,
    [NETWORK_IDS.arbitrum]: arbitrum,
    [NETWORK_IDS.arcTestnet]: arcTestnet,
    // [NETWORK_IDS.arc]: arc,
    // [NETWORK_IDS.seiTestnet]: seiTestnet,
    [NETWORK_IDS.sei]: sei,
};

export function getViemChain(id: EvmNetworkId): ViemChain {
    return VIEM_CHAIN_MAP[id];
}
