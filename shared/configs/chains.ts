/**
 * Chain Configuration
 * 
 * Single source of truth for all EVM chain configuration.
 * Multi-chain ready - add new chains by extending the maps below.
 * 
 * @module shared/config/chains
 */

// =============================================================================
// Chain IDs
// =============================================================================

/**
 * Supported chain IDs (numeric)
 * Add new chains here to support them across the entire app
 * Cronos is the default chain for x402 payments
 */
export const CHAIN_IDS = {
    // Cronos (default for x402 payments)
    cronosTestnet: 338,
    cronos: 25,
    // Avalanche
    avalancheFuji: 43113,
    avalanche: 43114,
    // BNB Chain
    bscTestnet: 97,
    bsc: 56,
    // Arbitrum
    arbitrumSepolia: 421614,
    arbitrum: 42161,
    // Polygon
    polygonAmoy: 80002,
    polygon: 137,
    // Base
    baseSepolia: 84532,
    base: 8453,
    // Ethereum
    sepolia: 11155111,
    ethereum: 1,
} as const;

export type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

/**
 * Chain IDs as strings (for ThirdWeb/schema compatibility)
 */
export const CHAIN_ID_STRINGS = {
    // Cronos (DEFAULT)
    cronosTestnet: "338",
    cronos: "25",
    // Avalanche
    avalancheFuji: "43113",
    avalanche: "43114",
    bscTestnet: "97",
    bsc: "56",
    arbitrumSepolia: "421614",
    arbitrum: "42161",
    polygonAmoy: "80002",
    polygon: "137",
    baseSepolia: "84532",
    base: "8453",
    sepolia: "11155111",
    ethereum: "1",
} as const;

// Legacy alias
export const THIRDWEB_CHAIN_IDS = CHAIN_ID_STRINGS;

// =============================================================================
// USDC Addresses (ERC-3009 compatible for gasless x402)
// =============================================================================

/**
 * USDC contract addresses per chain
 * All addresses support ERC-3009 transferWithAuthorization
 */
export const USDC_ADDRESSES: Record<ChainId, `0x${string}`> = {
    // Cronos (DEFAULT) - devUSDC.e
    [CHAIN_IDS.cronosTestnet]: "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0",
    [CHAIN_IDS.cronos]: "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59",
    // Avalanche
    [CHAIN_IDS.avalancheFuji]: "0x5425890298aed601595a70AB815c96711a31Bc65",
    [CHAIN_IDS.avalanche]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    // BNB Chain
    [CHAIN_IDS.bscTestnet]: "0x64544969ed7EBf5f083679233325356EbE738930",
    [CHAIN_IDS.bsc]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    // Arbitrum
    [CHAIN_IDS.arbitrumSepolia]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    [CHAIN_IDS.arbitrum]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    // Polygon
    [CHAIN_IDS.polygonAmoy]: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    [CHAIN_IDS.polygon]: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    // Base
    [CHAIN_IDS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    [CHAIN_IDS.base]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Ethereum
    [CHAIN_IDS.sepolia]: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    [CHAIN_IDS.ethereum]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

// =============================================================================
// x402 Facilitator URLs
// =============================================================================

/**
 * Facilitator URLs per chain
 * - Cronos chains: Cronos Labs facilitator (gasless EIP-3009 transfers)
 * - Other chains: null = use ThirdWeb facilitator
 */
export const FACILITATOR_URLS: Partial<Record<ChainId, string | null>> = {
    // Cronos - use Cronos Labs facilitator
    [CHAIN_IDS.cronosTestnet]: "https://facilitator.cronoslabs.org",
    [CHAIN_IDS.cronos]: "https://facilitator.cronoslabs.org",
    // Avalanche - use ThirdWeb facilitator (null = SDK default)
    [CHAIN_IDS.avalancheFuji]: null,
    [CHAIN_IDS.avalanche]: null,
    // BNB - use ThirdWeb facilitator
    [CHAIN_IDS.bscTestnet]: null,
    [CHAIN_IDS.bsc]: null,
};

/**
 * Cronos network identifiers for facilitator API
 */
export const CRONOS_NETWORK_MAP: Partial<Record<ChainId, string>> = {
    [CHAIN_IDS.cronosTestnet]: "cronos-testnet",
    [CHAIN_IDS.cronos]: "cronos-mainnet",
};

/**
 * Check if chain uses Cronos facilitator
 */
export function isCronosChain(chainId: number): boolean {
    return chainId === CHAIN_IDS.cronosTestnet || chainId === CHAIN_IDS.cronos;
}

/**
 * Get facilitator URL for chain (null = use ThirdWeb default)
 */
export function getFacilitatorUrl(chainId: number): string | null {
    return FACILITATOR_URLS[chainId as ChainId] ?? null;
}

/**
 * Get Cronos network identifier for facilitator API
 */
export function getCronosNetwork(chainId: number): string | undefined {
    return CRONOS_NETWORK_MAP[chainId as ChainId];
}

// =============================================================================
// Chain Metadata
// =============================================================================

export interface ChainConfig {
    name: string;
    shortName: string;
    isTestnet: boolean;
    explorer: string;
    rpcEnvVar: string;
}

/**
 * Chain metadata for UI and configuration
 */
export const CHAIN_CONFIG: Record<ChainId, ChainConfig> = {
    // Cronos (DEFAULT for x402 payments)
    [CHAIN_IDS.cronosTestnet]: {
        name: "Cronos Testnet",
        shortName: "Cronos Testnet",
        isTestnet: true,
        explorer: "https://explorer.cronos.org/testnet",
        rpcEnvVar: "CRONOS_TESTNET_RPC",
    },
    [CHAIN_IDS.cronos]: {
        name: "Cronos",
        shortName: "Cronos",
        isTestnet: false,
        explorer: "https://explorer.cronos.org",
        rpcEnvVar: "CRONOS_MAINNET_RPC",
    },
    // Avalanche
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
    [CHAIN_IDS.bscTestnet]: {
        name: "BNB Smart Chain Testnet",
        shortName: "BSC Testnet",
        isTestnet: true,
        explorer: "https://testnet.bscscan.com",
        rpcEnvVar: "BSC_TESTNET_RPC",
    },
    [CHAIN_IDS.bsc]: {
        name: "BNB Smart Chain",
        shortName: "BSC",
        isTestnet: false,
        explorer: "https://bscscan.com",
        rpcEnvVar: "BSC_MAINNET_RPC",
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
    [CHAIN_IDS.polygonAmoy]: {
        name: "Polygon Amoy",
        shortName: "Amoy",
        isTestnet: true,
        explorer: "https://amoy.polygonscan.com",
        rpcEnvVar: "POLYGON_AMOY_RPC",
    },
    [CHAIN_IDS.polygon]: {
        name: "Polygon",
        shortName: "Polygon",
        isTestnet: false,
        explorer: "https://polygonscan.com",
        rpcEnvVar: "POLYGON_MAINNET_RPC",
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
    [CHAIN_IDS.sepolia]: {
        name: "Sepolia",
        shortName: "Sepolia",
        isTestnet: true,
        explorer: "https://sepolia.etherscan.io",
        rpcEnvVar: "SEPOLIA_RPC",
    },
    [CHAIN_IDS.ethereum]: {
        name: "Ethereum",
        shortName: "Ethereum",
        isTestnet: false,
        explorer: "https://etherscan.io",
        rpcEnvVar: "ETHEREUM_MAINNET_RPC",
    },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get active chain ID based on DEFAULT_CHAIN and USE_MAINNET environment variables
 * Defaults to Cronos Testnet/Mainnet for x402 payments
 */
export function getActiveChainId(): ChainId {
    const defaultChain = process.env.DEFAULT_CHAIN?.toLowerCase();

    // Support Avalanche if explicitly set
    if (defaultChain === "avalanche") {
        return process.env.USE_MAINNET === "true"
            ? CHAIN_IDS.avalanche
            : CHAIN_IDS.avalancheFuji;
    }

    // Default: Cronos Testnet
    return process.env.USE_MAINNET === "true"
        ? CHAIN_IDS.cronos
        : CHAIN_IDS.cronosTestnet;
}

/**
 * Get USDC address for a chain
 */
export function getUsdcAddress(chainId: number): `0x${string}` {
    const address = USDC_ADDRESSES[chainId as ChainId];
    return address || USDC_ADDRESSES[CHAIN_IDS.cronosTestnet];
}

/**
 * Get chain config by ID
 */
export function getChainConfig(chainId: ChainId): ChainConfig {
    return CHAIN_CONFIG[chainId];
}

/**
 * Check if chain is testnet
 */
export function isTestnet(chainId: ChainId): boolean {
    return CHAIN_CONFIG[chainId]?.isTestnet ?? false;
}

/**
 * Get all supported chain IDs
 */
export function getSupportedChainIds(): ChainId[] {
    return Object.values(CHAIN_IDS);
}

/**
 * Get testnet chain IDs only
 */
export function getTestnetChainIds(): ChainId[] {
    return getSupportedChainIds().filter(id => CHAIN_CONFIG[id]?.isTestnet);
}

/**
 * Get mainnet chain IDs only
 */
export function getMainnetChainIds(): ChainId[] {
    return getSupportedChainIds().filter(id => !CHAIN_CONFIG[id]?.isTestnet);
}

// =============================================================================
// ThirdWeb Chain Objects (Server-side)
// Imported by thirdweb.ts for ThirdWeb SDK operations
// =============================================================================

import { defineChain, avalancheFuji, avalanche, cronos } from "thirdweb/chains";

/**
 * Cronos Testnet chain object (not pre-exported from thirdweb/chains)
 */
export const cronosTestnet = defineChain({
    id: 338,
    name: "Cronos Testnet",
    nativeCurrency: { name: "Test CRO", symbol: "tCRO", decimals: 18 },
    rpc: process.env.CRONOS_TESTNET_RPC,
    blockExplorers: [{ name: "Cronos Explorer", url: "https://explorer.cronos.org/testnet" }],
});

/**
 * Chain lookup map for dynamic chain selection
 */
export const CHAIN_MAP: Record<number, ReturnType<typeof defineChain>> = {
    [CHAIN_IDS.cronosTestnet]: cronosTestnet,
    [CHAIN_IDS.cronos]: cronos,
    [CHAIN_IDS.avalancheFuji]: avalancheFuji,
    [CHAIN_IDS.avalanche]: avalanche,
};

/**
 * Get ThirdWeb chain object by ID
 */
export function getChainObject(chainId: number) {
    return CHAIN_MAP[chainId] || cronosTestnet;
}
