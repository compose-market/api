/**
 * ThirdWeb Client Configuration
 * 
 * Server-side ThirdWeb client and x402 facilitator setup.
 * Uses environment variables from backend/lambda/.env
 * 
 * @module shared/config/thirdweb
 */

import { createThirdwebClient } from "thirdweb";
import { facilitator } from "thirdweb/x402";
import { avalancheFuji, avalanche } from "thirdweb/chains";
import { CHAIN_IDS, getActiveChainId, getUsdcAddress } from "./chains.js";

// =============================================================================
// ThirdWeb Client (Server-side)
// =============================================================================

/**
 * Server-side ThirdWeb client
 * Uses THIRDWEB_SECRET_KEY from .env - NEVER expose to client
 */
export const serverClient = createThirdwebClient({
    secretKey: process.env.THIRDWEB_SECRET_KEY!,
});

// =============================================================================
// Wallet Addresses
// =============================================================================

/**
 * Server wallet address (facilitator for x402)
 */
export const serverWalletAddress = process.env.THIRDWEB_SERVER_WALLET_ADDRESS as `0x${string}`;

/**
 * Merchant wallet that receives payments
 */
export const merchantWalletAddress = process.env.MERCHANT_WALLET_ADDRESS as `0x${string}`;

/**
 * Treasury wallet (legacy alias)
 */
export const treasuryWalletAddress = process.env.TREASURY_SERVER_WALLET_PUBLIC as `0x${string}`;

// =============================================================================
// Payment Chain Configuration
// =============================================================================

/**
 * Active payment chain based on USE_MAINNET environment variable
 */
export const paymentChain = process.env.USE_MAINNET === "true"
    ? avalanche
    : avalancheFuji;

/**
 * Active payment chain ID
 */
export const paymentChainId = getActiveChainId();

/**
 * USDC token configuration for active chain
 */
export const paymentAsset = {
    address: getUsdcAddress(paymentChainId),
    symbol: "USDC",
    decimals: 6,
};

// =============================================================================
// x402 Facilitator
// =============================================================================

/**
 * ThirdWeb x402 facilitator
 * Using "submitted" waitUntil to avoid Lambda timeout issues
 */
export const thirdwebFacilitator = facilitator({
    client: serverClient,
    serverWalletAddress,
    waitUntil: "submitted", // Don't wait for full confirmation - avoids timeout
});

// =============================================================================
// Pricing Constants
// =============================================================================

/**
 * Fixed price per inference call in USDC wei (6 decimals)
 * $0.005 USDC = 5000 wei
 */
export const INFERENCE_PRICE_WEI = 5_000;

/**
 * Price per token in USDC wei (legacy)
 * 0.000001 USDC per token
 */
export const PRICE_PER_TOKEN_WEI = 1;

/**
 * Maximum tokens per call
 */
export const MAX_TOKENS_PER_CALL = 100_000;

/**
 * Session budget presets (in USDC wei - 6 decimals)
 */
export const SESSION_BUDGET_PRESETS = [
    { label: "$1", value: 1_000_000 },
    { label: "$5", value: 5_000_000 },
    { label: "$10", value: 10_000_000 },
    { label: "$25", value: 25_000_000 },
    { label: "$50", value: 50_000_000 },
] as const;

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
 * Format wei amount to USDC string
 */
export function formatUsdcAmount(weiAmount: string | bigint): string {
    const wei = typeof weiAmount === "string" ? BigInt(weiAmount) : weiAmount;
    const usdc = Number(wei) / 1e6;
    return usdc.toFixed(6);
}

/**
 * Parse USDC amount to wei string
 */
export function parseUsdcAmount(usdcAmount: string | number): string {
    const usdc = typeof usdcAmount === "string" ? parseFloat(usdcAmount) : usdcAmount;
    const wei = Math.floor(usdc * 1e6);
    return wei.toString();
}

// Re-export chain objects for convenience
export { avalancheFuji, avalanche };
