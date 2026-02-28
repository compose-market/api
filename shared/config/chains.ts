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
 */
export const CHAIN_IDS = {
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
 * Get active chain ID based on USE_MAINNET environment variable
 */
export function getActiveChainId(): ChainId {
    return process.env.USE_MAINNET === "true"
        ? CHAIN_IDS.avalanche
        : CHAIN_IDS.avalancheFuji;
}

/**
 * Get USDC address for a chain
 */
export function getUsdcAddress(chainId: ChainId): `0x${string}` {
    return USDC_ADDRESSES[chainId];
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
