/**
 * Cronos x402 Facilitator Module
 * 
 * Uses @crypto.com/facilitator-client SDK for Cronos chain payments.
 * This module handles x402 payment verification and settlement for Cronos chains (338, 25).
 * 
 * For ThirdWeb-supported chains (Avalanche, etc.), use thirdweb.ts instead.
 * 
 * @see https://docs.cronos.org/cronos-x402-facilitator/api-reference
 * @see https://www.npmjs.com/package/@crypto.com/facilitator-client
 * 
 * @module shared/config/cronos
 */

import { Facilitator, CronosNetwork, Scheme, Contract, type PaymentRequirements } from "@crypto.com/facilitator-client";
import { CHAIN_IDS } from "./chains.js";

// =============================================================================
// Cronos Network Constants
// =============================================================================

/**
 * USDC.e contract addresses on Cronos chains
 * These are the ONLY tokens supported by the Cronos x402 facilitator
 */
export const CRONOS_USDC_ADDRESSES: Record<number, `0x${string}`> = {
    [CHAIN_IDS.cronosTestnet]: "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0", // devUSDC.e
    [CHAIN_IDS.cronos]: "0xf951eC28187D9E5Ca673Da8FE6757E6f0Be5F77C", // USDC.e mainnet
};

/**
 * EIP-712 domain configuration for Cronos USDC.e
 * Required for payment header generation
 */
export const CRONOS_EIP712_DOMAIN = {
    name: "Bridged USDC (Stargate)",
    version: "1",
} as const;

/**
 * Map chain IDs to Cronos SDK network enum
 */
export function getCronosNetwork(chainId: number): CronosNetwork {
    switch (chainId) {
        case CHAIN_IDS.cronosTestnet:
            return CronosNetwork.CronosTestnet;
        case CHAIN_IDS.cronos:
            return CronosNetwork.CronosMainnet;
        default:
            throw new Error(`Chain ${chainId} is not a Cronos chain`);
    }
}

/**
 * Get Cronos network string for x402 protocol
 */
export function getCronosNetworkString(chainId: number): "cronos-testnet" | "cronos-mainnet" {
    switch (chainId) {
        case CHAIN_IDS.cronosTestnet:
            return "cronos-testnet";
        case CHAIN_IDS.cronos:
            return "cronos-mainnet";
        default:
            throw new Error(`Chain ${chainId} is not a Cronos chain`);
    }
}

// =============================================================================
// Facilitator Client Factory
// =============================================================================

/**
 * Create a Cronos facilitator client for a specific network
 */
export function createCronosFacilitator(chainId: number): Facilitator {
    const network = getCronosNetwork(chainId);
    return new Facilitator({ network });
}

// Cached facilitator instances
const facilitatorCache: Map<number, Facilitator> = new Map();

/**
 * Get or create a Cronos facilitator client (cached)
 */
export function getCronosFacilitator(chainId: number): Facilitator {
    if (!facilitatorCache.has(chainId)) {
        facilitatorCache.set(chainId, createCronosFacilitator(chainId));
    }
    return facilitatorCache.get(chainId)!;
}

// =============================================================================
// x402 Payment Requirements Generation
// =============================================================================

/**
 * Generate Cronos x402 V1 payment requirements
 * This format is returned in 402 responses for Cronos chains
 * Uses SDK types for compatibility with facilitator.buildVerifyRequest()
 */
export function generateCronosPaymentRequirements(params: {
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
    description?: string;
    maxTimeoutSeconds?: number;
}): PaymentRequirements {
    const { payTo, amount, chainId, description, maxTimeoutSeconds } = params;

    // Get SDK enum values based on chain
    const network = chainId === CHAIN_IDS.cronos
        ? CronosNetwork.CronosMainnet
        : CronosNetwork.CronosTestnet;

    const asset = chainId === CHAIN_IDS.cronos
        ? Contract.USDCe
        : Contract.DevUSDCe;

    return {
        scheme: Scheme.Exact,
        network,
        payTo,
        asset,
        maxAmountRequired: amount,
        maxTimeoutSeconds: maxTimeoutSeconds || 300,
        description: description || "Compose.Market AI Agent Inference",
        mimeType: "application/json",
    };
}

/**
 * Cronos accepts entry type for 402 response
 * Matches @crypto.com/facilitator-client PaymentRequirements + extra for paymentId
 */
export interface CronosAccepts {
    scheme: typeof Scheme.Exact;
    network: CronosNetwork;
    payTo: `0x${string}`;
    asset: Contract;
    maxAmountRequired: string;
    maxTimeoutSeconds: number;
    description: string;
    mimeType: string;
    resource: string;
    extra?: { paymentId?: string };
}

/**
 * Create a Cronos x402 V1 402 response body
 * Uses `accepts` array format matching x402-examples and SDK expectations
 * 
 * @see x402-examples/paywall/resource-service/src/lib/middlewares/require.middleware.ts
 */
export function createCronos402Response(params: {
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
    description?: string;
    resource?: string;
    paymentId?: string;
}): {
    x402Version: 1;
    error: string;
    accepts: CronosAccepts[];
} {
    const { payTo, amount, chainId, description, resource, paymentId } = params;

    // Get SDK enum values based on chain
    const network = chainId === CHAIN_IDS.cronos
        ? CronosNetwork.CronosMainnet
        : CronosNetwork.CronosTestnet;

    const asset = chainId === CHAIN_IDS.cronos
        ? Contract.USDCe
        : Contract.DevUSDCe;

    return {
        x402Version: 1,
        error: "payment_required",
        accepts: [{
            scheme: Scheme.Exact,
            network,
            payTo,
            asset,
            maxAmountRequired: amount,
            maxTimeoutSeconds: 300,
            description: description || "Compose.Market AI Agent Inference",
            mimeType: "application/json",
            resource: resource || "",
            extra: paymentId ? { paymentId } : undefined,
        }],
    };
}

// =============================================================================
// Payment Verification and Settlement
// =============================================================================

export interface CronosSettlementResult {
    status: number;
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    error?: string;
}

/**
 * Verify a Cronos x402 payment header
 * Uses @crypto.com/facilitator-client SDK
 * 
 * @param paymentHeader - Base64-encoded X-PAYMENT header
 * @param payTo - Merchant wallet address
 * @param amount - Amount in USDC wei (6 decimals)
 * @param chainId - Cronos chain ID (338 or 25)
 */
export async function verifyCronosPayment(params: {
    paymentHeader: string;
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
}): Promise<{ isValid: boolean; invalidReason?: string }> {
    const { paymentHeader, payTo, amount, chainId } = params;

    console.log(`[cronos-x402] Verifying payment on chain ${chainId}`);

    try {
        const facilitator = getCronosFacilitator(chainId);
        const requirements = generateCronosPaymentRequirements({
            payTo,
            amount,
            chainId,
        });

        const body = facilitator.buildVerifyRequest(paymentHeader, requirements);
        const result = await facilitator.verifyPayment(body);

        console.log(`[cronos-x402] Verify result: isValid=${result.isValid}`);

        return {
            isValid: result.isValid,
            invalidReason: result.invalidReason || undefined,
        };
    } catch (error) {
        console.error(`[cronos-x402] Verify error:`, error);
        return {
            isValid: false,
            invalidReason: error instanceof Error ? error.message : "Unknown verification error",
        };
    }
}

/**
 * Settle a verified Cronos x402 payment
 * Uses @crypto.com/facilitator-client SDK
 * 
 * @param paymentHeader - Base64-encoded X-PAYMENT header (already verified)
 * @param payTo - Merchant wallet address
 * @param amount - Amount in USDC wei (6 decimals)
 * @param chainId - Cronos chain ID (338 or 25)
 */
export async function settleCronosPayment(params: {
    paymentHeader: string;
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
}): Promise<CronosSettlementResult> {
    const { paymentHeader, payTo, amount, chainId } = params;

    console.log(`[cronos-x402] Settling payment on chain ${chainId}`);
    console.log(`[cronos-x402] payTo: ${payTo}, amount: ${amount}`);

    try {
        const facilitator = getCronosFacilitator(chainId);
        const requirements = generateCronosPaymentRequirements({
            payTo,
            amount,
            chainId,
        });

        const body = facilitator.buildVerifyRequest(paymentHeader, requirements);
        const result = await facilitator.settlePayment(body);

        console.log(`[cronos-x402] Settle result:`, JSON.stringify(result));

        // Check for successful settlement
        if (result.event === "payment.settled" && result.txHash) {
            return {
                status: 200,
                success: true,
                txHash: result.txHash,
                blockNumber: result.blockNumber,
            };
        }

        // Settlement failed
        return {
            status: 402,
            success: false,
            error: result.error || "Settlement failed",
        };
    } catch (error) {
        console.error(`[cronos-x402] Settle error:`, error);
        return {
            status: 500,
            success: false,
            error: error instanceof Error ? error.message : "Unknown settlement error",
        };
    }
}

/**
 * Verify and settle a Cronos x402 payment in one call
 * Convenience function that combines verify + settle
 */
export async function verifyAndSettleCronosPayment(params: {
    paymentHeader: string;
    payTo: `0x${string}`;
    amount: string;
    chainId: number;
}): Promise<CronosSettlementResult> {
    // First verify
    const verifyResult = await verifyCronosPayment(params);

    if (!verifyResult.isValid) {
        return {
            status: 402,
            success: false,
            error: verifyResult.invalidReason || "Payment verification failed",
        };
    }

    // Then settle
    return settleCronosPayment(params);
}

// =============================================================================
// Payment Header Extraction
// =============================================================================

/**
 * Extract X-PAYMENT header from request headers (Cronos x402 V1 format)
 * Cronos uses X-PAYMENT while ThirdWeb uses PAYMENT-SIGNATURE
 */
export function extractCronosPaymentHeader(
    headers: Record<string, string | string[] | undefined>
): string | null {
    // Check both X-PAYMENT (Cronos standard) and x-payment (lowercase)
    const xPayment = headers["X-PAYMENT"] || headers["x-payment"];

    if (typeof xPayment === "string") {
        return xPayment;
    }

    if (Array.isArray(xPayment) && xPayment.length > 0) {
        return xPayment[0];
    }

    return null;
}

/**
 * Detect if a payment header is Cronos x402 V1 format
 * Cronos headers decode to JSON with x402Version: 1 and network: "cronos-*"
 */
export function isCronosPaymentHeader(paymentHeader: string): boolean {
    try {
        const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
        return (
            decoded.x402Version === 1 &&
            (decoded.network === "cronos-testnet" || decoded.network === "cronos-mainnet")
        );
    } catch {
        return false;
    }
}

/**
 * Extract chain ID from Cronos payment header
 */
export function getChainIdFromCronosHeader(paymentHeader: string): number | null {
    try {
        const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
        if (decoded.network === "cronos-testnet") return CHAIN_IDS.cronosTestnet;
        if (decoded.network === "cronos-mainnet") return CHAIN_IDS.cronos;
        return null;
    } catch {
        return null;
    }
}
