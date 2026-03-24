/**
 * Wallet addresses and payment chain configuration.
 *
 * Extracted from the former thirdweb.ts — now SDK-agnostic.
 * Only reads environment variables and exposes typed constants.
 *
 * @module shared/x402/wallets
 */

import {
    getActiveChainId,
    getUsdcAddress,
    VIEM_CHAIN_MAP,
} from "./configs/chains.js";
import { decodeComposePaymentSignatureHeader, getChainIdFromPaymentPayload } from "./facilitator.js";

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
 * Treasury wallet used for session-key settlements
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
 * Active payment chain object (viem)
 */
export const paymentChain = VIEM_CHAIN_MAP[paymentChainId];

/**
 * USDC token configuration for active chain
 */
export const paymentAsset = {
    address: getUsdcAddress(paymentChainId),
    symbol: "USDC",
    decimals: 6,
};

/**
 * Extract chain ID from x402 payment data header
 */
export function getChainIdFromPaymentData(paymentData: string | null): number {
    if (!paymentData) {
        return getActiveChainId();
    }

    try {
        const paymentPayload = decodeComposePaymentSignatureHeader(paymentData);
        return getChainIdFromPaymentPayload(paymentPayload);
    } catch {
        return getActiveChainId();
    }
}
