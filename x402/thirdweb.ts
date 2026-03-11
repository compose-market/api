/**
 * ThirdWeb Client Configuration
 * 
 * Server-side ThirdWeb client and x402 facilitator setup.
 * Chain objects are defined in chains.ts (single source of truth).
 * 
 * @module shared/config/thirdweb
 */

import { createThirdwebClient } from "thirdweb";
import { facilitator } from "thirdweb/x402";
import {
    CHAIN_IDS,
    getActiveChainId,
    getUsdcAddress,
    CHAIN_MAP,
    getChainObject,
} from "./configs/chains.js";

// Re-export chain utilities for backwards compatibility
export { CHAIN_MAP, getChainObject };

// =============================================================================
// ThirdWeb Client (Server-side)
// =============================================================================

/**
 * Server-side ThirdWeb client
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
 * Active payment chain ID (determined by DEFAULT_CHAIN and USE_MAINNET env)
 */
export const paymentChainId = getActiveChainId();

/**
 * Active payment chain object resolved from CHAIN_MAP
 */
export const paymentChain = CHAIN_MAP[paymentChainId];

/**
 * USDC token configuration for active chain
 */
export const paymentAsset = {
    address: getUsdcAddress(paymentChainId),
    symbol: "USDC",
    decimals: 6,
};

// =============================================================================
// x402 Facilitators (Chain-Specific)
// =============================================================================

/**
 * ThirdWeb x402 facilitator (for Avalanche and other ThirdWeb-supported chains)
 * Using "submitted" waitUntil to avoid Api timeout issues
 */
export const thirdwebFacilitator = facilitator({
    client: serverClient,
    serverWalletAddress,
    waitUntil: "submitted", // Don't wait for full confirmation - avoids timeout
});

/**
 * Extract chain ID from x402 payment data header
 * The payment header is base64-encoded JSON containing network info
 */
export function getChainIdFromPaymentData(paymentData: string | null): number {
    if (!paymentData) {
        return getActiveChainId();
    }
    try {
        const decoded = JSON.parse(Buffer.from(paymentData, "base64").toString());
        // x402 payment header may have chainId directly or in payload
        if (decoded.chainId) return decoded.chainId;
        if (decoded.payload?.chainId) return decoded.payload.chainId;
        if (decoded.network?.chainId) return decoded.network.chainId;
        // Fall back to default
        return getActiveChainId();
    } catch {
        return getActiveChainId();
    }
}

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

// Chain objects are now exported from chains.ts
