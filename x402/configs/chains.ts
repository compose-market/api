/**
 * Chain configuration for Compose payments and settlements.
 *
 * This is the single source of truth for:
 * - supported EVM payment chains
 * - USDC contract addresses
 * - RPC environment variable mapping
 * - viem chain objects
 */

import type { Chain as ViemChain } from "viem";
import {
    avalanche as viemAvalanche,
    avalancheFuji as viemAvalancheFuji,
    arbitrum as viemArbitrum,
    arbitrumSepolia as viemArbitrumSepolia,
    base as viemBase,
    baseSepolia as viemBaseSepolia,
} from "viem/chains";

export const CHAIN_IDS = {
    avalancheFuji: 43113,
    avalanche: 43114,
    arbitrumSepolia: 421614,
    arbitrum: 42161,
    baseSepolia: 84532,
    base: 8453,
} as const;

export type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export const CHAIN_ID_STRINGS = {
    avalancheFuji: "43113",
    avalanche: "43114",
    arbitrumSepolia: "421614",
    arbitrum: "42161",
    baseSepolia: "84532",
    base: "8453",
} as const;

export const USDC_ADDRESSES: Record<ChainId, `0x${string}`> = {
    [CHAIN_IDS.avalancheFuji]: "0x5425890298aed601595a70AB815c96711a31Bc65",
    [CHAIN_IDS.avalanche]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    [CHAIN_IDS.arbitrumSepolia]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    [CHAIN_IDS.arbitrum]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    [CHAIN_IDS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    [CHAIN_IDS.base]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export interface ChainConfig {
    name: string;
    shortName: string;
    isTestnet: boolean;
    explorer: string;
    rpcEnvVar: string;
}

export const CHAIN_CONFIG: Record<ChainId, ChainConfig> = {
    [CHAIN_IDS.avalancheFuji]: {
        name: "Avalanche Fuji",
        shortName: "Fuji",
        isTestnet: true,
        explorer: "https://testnet.avascan.info",
        rpcEnvVar: "AVALANCHE_FUJI_RPC",
    },
    [CHAIN_IDS.avalanche]: {
        name: "Avalanche C-Chain",
        shortName: "Avalanche",
        isTestnet: false,
        explorer: "https://avascan.info",
        rpcEnvVar: "AVALANCHE_MAINNET_RPC",
    },
    [CHAIN_IDS.arbitrumSepolia]: {
        name: "Arbitrum Sepolia",
        shortName: "Arb Sepolia",
        isTestnet: true,
        explorer: "https://sepolia.arbiscan.io",
        rpcEnvVar: "ARBITRUM_SEPOLIA_RPC",
    },
    [CHAIN_IDS.arbitrum]: {
        name: "Arbitrum One",
        shortName: "Arbitrum",
        isTestnet: false,
        explorer: "https://arbiscan.io",
        rpcEnvVar: "ARBITRUM_MAINNET_RPC",
    },
    [CHAIN_IDS.baseSepolia]: {
        name: "Base Sepolia",
        shortName: "Base Sepolia",
        isTestnet: true,
        explorer: "https://sepolia.basescan.org",
        rpcEnvVar: "BASE_SEPOLIA_RPC",
    },
    [CHAIN_IDS.base]: {
        name: "Base",
        shortName: "Base",
        isTestnet: false,
        explorer: "https://basescan.org",
        rpcEnvVar: "BASE_MAINNET_RPC",
    },
};

function resolveDefaultChainBase(defaultChain: string | undefined): "avalanche" | "arbitrum" | "base" {
    switch ((defaultChain || "").toLowerCase()) {
        case "arbitrum":
            return "arbitrum";
        case "base":
            return "base";
        case "avalanche":
        case "":
            return "avalanche";
        default:
            throw new Error(`Unsupported DEFAULT_CHAIN value: ${defaultChain}`);
    }
}

export function getActiveChainId(): ChainId {
    const base = resolveDefaultChainBase(process.env.DEFAULT_CHAIN);
    const useMainnet = process.env.USE_MAINNET === "true";

    switch (base) {
        case "avalanche":
            return useMainnet ? CHAIN_IDS.avalanche : CHAIN_IDS.avalancheFuji;
        case "arbitrum":
            return useMainnet ? CHAIN_IDS.arbitrum : CHAIN_IDS.arbitrumSepolia;
        case "base":
            return useMainnet ? CHAIN_IDS.base : CHAIN_IDS.baseSepolia;
    }
}

export function getUsdcAddress(chainId: number): `0x${string}` {
    const address = USDC_ADDRESSES[chainId as ChainId];
    if (!address) {
        throw new Error(`USDC address not configured for chain ${chainId}`);
    }
    return address;
}

export function getChainConfig(chainId: ChainId): ChainConfig {
    const config = CHAIN_CONFIG[chainId];
    if (!config) {
        throw new Error(`Unsupported chain ${chainId}`);
    }
    return config;
}

export function getRpcUrl(chainId: number): string {
    const config = CHAIN_CONFIG[chainId as ChainId];
    if (!config) {
        throw new Error(`Unsupported chain ${chainId}`);
    }

    const rpcUrl = process.env[config.rpcEnvVar];
    if (!rpcUrl) {
        throw new Error(`RPC URL for chain ${chainId} (${config.rpcEnvVar}) is missing`);
    }

    return rpcUrl;
}

export function isTestnet(chainId: ChainId): boolean {
    return getChainConfig(chainId).isTestnet;
}

export function getSupportedChainIds(): ChainId[] {
    return Object.values(CHAIN_IDS);
}

export function getTestnetChainIds(): ChainId[] {
    return getSupportedChainIds().filter((id) => CHAIN_CONFIG[id].isTestnet);
}

export function getMainnetChainIds(): ChainId[] {
    return getSupportedChainIds().filter((id) => !CHAIN_CONFIG[id].isTestnet);
}

export const VIEM_CHAIN_MAP: Record<ChainId, ViemChain> = {
    [CHAIN_IDS.avalancheFuji]: viemAvalancheFuji,
    [CHAIN_IDS.avalanche]: viemAvalanche,
    [CHAIN_IDS.arbitrumSepolia]: viemArbitrumSepolia,
    [CHAIN_IDS.arbitrum]: viemArbitrum,
    [CHAIN_IDS.baseSepolia]: viemBaseSepolia,
    [CHAIN_IDS.base]: viemBase,
};

export function getViemChain(chainId: number): ViemChain {
    const chain = VIEM_CHAIN_MAP[chainId as ChainId];
    if (!chain) {
        throw new Error(`Unsupported chain ${chainId}`);
    }
    return chain;
}
