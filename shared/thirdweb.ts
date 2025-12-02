/**
 * Shared ThirdWeb configuration constants
 * Used by both frontend (app/) and backend (backend/)
 * 
 * Chain configuration is centralized - add new chains in the CHAIN_IDS section below.
 */

import { avalancheFuji, avalanche } from "thirdweb/chains";

// =============================================================================
// Chain Configuration (Centralized - add new chains here)
// =============================================================================

export const CHAIN_IDS = {
  // Avalanche (primary for Compose Market)
  avalancheFuji: 43113,
  avalanche: 43114,
  // BNB Chain (future support)
  bscTestnet: 97,
  bsc: 56,
  // Other chains can be added here
} as const;

// USDC addresses per chain (supports ERC-3009 for x402)
export const USDC_ADDRESSES: Record<number, `0x${string}`> = {
  // Avalanche
  [CHAIN_IDS.avalancheFuji]: "0x5425890298aed601595a70AB815c96711a31Bc65",
  [CHAIN_IDS.avalanche]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  // BNB Chain
  [CHAIN_IDS.bscTestnet]: "0x64544969ed7EBf5f083679233325356EbE738930",
  [CHAIN_IDS.bsc]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};

// Chain metadata for reference
export const CHAIN_CONFIG: Record<number, {
  name: string;
  isTestnet: boolean;
  explorer: string;
}> = {
  [CHAIN_IDS.avalancheFuji]: {
    name: "Avalanche Fuji",
    isTestnet: true,
    explorer: "https://testnet.avascan.info",
  },
  [CHAIN_IDS.avalanche]: {
    name: "Avalanche C-Chain",
    isTestnet: false,
    explorer: "https://avascan.info",
  },
  [CHAIN_IDS.bscTestnet]: {
    name: "BNB Smart Chain Testnet",
    isTestnet: true,
    explorer: "https://testnet.bscscan.com",
  },
  [CHAIN_IDS.bsc]: {
    name: "BNB Smart Chain",
    isTestnet: false,
    explorer: "https://bscscan.com",
  },
};

// =============================================================================
// Pricing Configuration
// =============================================================================

export const PRICE_PER_TOKEN_WEI = 1; // 0.000001 USDC per inference token
export const MAX_TOKENS_PER_CALL = 100000; // 100k tokens max per call

// Session budget presets (in USDC wei - 6 decimals)
export const SESSION_BUDGET_PRESETS = [
  { label: "$1", value: 1_000_000 },
  { label: "$5", value: 5_000_000 },
  { label: "$10", value: 10_000_000 },
  { label: "$25", value: 25_000_000 },
  { label: "$50", value: 50_000_000 },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate cost in human-readable USDC format
 */
export function calculateCostUSDC(tokens: number): string {
  const cost = (PRICE_PER_TOKEN_WEI * tokens) / 10 ** 6;
  return cost.toFixed(6);
}

/**
 * Get USDC address for a given chain ID
 */
export function getUsdcAddress(chainId: number): `0x${string}` | undefined {
  return USDC_ADDRESSES[chainId];
}

/**
 * Get the active chain based on environment variable
 */
export function getActiveChainId(): number {
  return process.env.USE_MAINNET === "true" 
    ? CHAIN_IDS.avalanche 
    : CHAIN_IDS.avalancheFuji;
}

// Re-export chains for convenience
export { avalancheFuji, avalanche };

