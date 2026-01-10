/**
 * x402 Payment Module
 * 
 * Single entry point for all x402 payment operations.
 * Handles payment verification, settlement, and header management.
 * 
 * @module shared/x402
 */

import type { Request, Response } from "express";
import { settlePayment } from "thirdweb/x402";
import {
    paymentChain,
    paymentAsset,
    thirdwebFacilitator,
    merchantWalletAddress,
    serverWalletAddress,
} from "../config/thirdweb.js";
import { INFERENCE_PRICE_WEI, DEFAULT_PRICES, DYNAMIC_PRICES, getPriceForRequest } from "./pricing.js";
import type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";

// Compose Keys integration
import {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    getKeyBudgetInfo,
} from "../keys/index.js";

// Re-export types
export type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";

// Re-export pricing
export {
    DYNAMIC_PRICES,
    DEFAULT_PRICES,
    INFERENCE_PRICE_WEI,
    getToolPrice,
    getMultimodalPrice,
    calculateInferenceCost,
    calculateActionCost,
    calculateTotalCost,
    getPriceForRequest,
    formatPrice,
} from "./pricing.js";

// =============================================================================
// Payment Info Extraction
// =============================================================================

/**
 * Extract payment info from request headers
 */
export function extractPaymentInfo(headers: Record<string, string | string[] | undefined>): PaymentInfo {
    const paymentData = typeof headers["x-payment"] === "string" ? headers["x-payment"] : null;
    const sessionActive = headers["x-session-active"] === "true";
    const sessionBudgetRemaining = parseInt(
        typeof headers["x-session-budget-remaining"] === "string"
            ? headers["x-session-budget-remaining"]
            : "0",
        10
    );

    return {
        paymentData,
        sessionActive,
        sessionBudgetRemaining,
    };
}

/**
 * Validate payment data header format
 */
export function validatePaymentDataHeader(header: string | undefined | null): {
    valid: boolean;
    error?: string;
} {
    if (!header) {
        return { valid: false, error: "Missing x-payment header" };
    }

    // Basic format validation (should be base64-encoded JSON)
    try {
        if (typeof header !== "string" || header.length < 10) {
            return { valid: false, error: "Invalid payment data format" };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: "Invalid payment data encoding" };
    }
}

// =============================================================================
// x402 Payment Settlement
// =============================================================================

/**
 * Handle x402 payment verification and settlement
 * 
 * @param paymentData - Signed payment data from x-payment header
 * @param resourceUrl - URL of the resource being accessed
 * @param method - HTTP method
 * @param amountWei - Price in USDC wei (6 decimals)
 * @returns Settlement result with status, body, and headers
 */
export async function handleX402Payment(
    paymentData: string | null,
    resourceUrl: string,
    method: string,
    amountWei: string,
): Promise<X402SettlementResult> {
    console.log(`[x402] settlePayment for ${resourceUrl}`);
    console.log(`[x402] paymentData present: ${!!paymentData}`);
    console.log(`[x402] amount: ${amountWei}`);
    console.log(`[x402] payTo: ${merchantWalletAddress}`);
    console.log(`[x402] facilitator: ${serverWalletAddress}`);

    const result = await settlePayment({
        resourceUrl,
        method,
        paymentData,
        payTo: merchantWalletAddress,
        network: paymentChain,
        price: {
            amount: amountWei,
            asset: {
                address: paymentAsset.address,
            },
        },
        facilitator: thirdwebFacilitator,
    });

    console.log(`[x402] result status: ${result.status}`);

    // SettlePaymentResult is a union type:
    // - status 200: { paymentReceipt: {...} }
    // - status 402/500/etc: { responseBody: {...} }
    return {
        status: result.status,
        responseBody: result.status === 200
            ? { success: true, receipt: (result as { paymentReceipt: unknown }).paymentReceipt }
            : (result as { responseBody: unknown }).responseBody,
        responseHeaders: result.responseHeaders as Record<string, string>,
    };
}

// Universal Payment Wrapper
// =============================================================================

// Set in .env
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} environment variable is required`);
    }
    return value;
}

// Internal marker for Manowar nested calls - the secret IS the proof of payment
const MANOWAR_INTERNAL_MARKER = requireEnv("MANOWAR_INTERNAL_SECRET");

/**
 * Require x402 payment for any endpoint.
 * 
 * This is the single function all endpoints should use for payment verification.
 * 
 * Payment can be verified in two ways:
 * 1. x-payment header (standard x402 per-request settlement)
 * 2. x-manowar-internal + active session (for nested agent/manowar calls)
 * 
 * The session-based bypass ensures:
 * - Users still pay at the agent/manowar endpoint level
 * - Nested LLM/tool calls don't require individual x402 settlements
 * - Budget is still tracked client-side via session budget remaining
 * - Can't be abused: no session = no bypass
 * 
 * @param req - Express request
 * @param res - Express response
 * @param amountWei - Price in USDC wei (6 decimals). Defaults to INFERENCE_PRICE_WEI ($0.005)
 * @returns true if payment verified, false if 402 response sent
 */
export async function requirePayment(
    req: Request,
    res: Response,
    amountWei: number = INFERENCE_PRICE_WEI,
): Promise<boolean> {
    const { paymentData, sessionActive, sessionBudgetRemaining } = extractPaymentInfo(
        req.headers as Record<string, string | string[] | undefined>
    );

    // DEBUG: Log incoming headers for bypass check
    const internalMarker = req.headers["x-manowar-internal"] as string | undefined;
    const userAgent = req.headers["user-agent"] as string || "";
    console.log(`[x402-debug] Internal marker: ${internalMarker ? 'PRESENT' : 'MISSING'}, value: ${internalMarker?.substring(0, 20) || 'N/A'}`);
    console.log(`[x402-debug] Expected marker: ${MANOWAR_INTERNAL_MARKER.substring(0, 20)}`);
    console.log(`[x402-debug] User-Agent: ${userAgent.substring(0, 50)}`);
    console.log(`[x402-debug] sec-fetch-mode: ${req.headers["sec-fetch-mode"] || 'N/A'}`);
    console.log(`[x402-debug] Session: active=${sessionActive}, budget=${sessionBudgetRemaining}`);

    const hasValidSession = sessionActive && sessionBudgetRemaining > 0;

    // @dev: Security Note:
    // If internal marker matches, allow the request
    // The marker is the proof of payment because:
    // 1. Manowar only adds x-manowar-internal AFTER verifying x402 payment at /agent/{wallet}/chat|image|video|audio|...
    // 2. The secret is stored in MANOWAR_INTERNAL_SECRET .env
    // 3. If someone knows the secret, they're either Manowar or have access to our infrastructure

    if (internalMarker === MANOWAR_INTERNAL_MARKER) {
        console.log(`[x402] Internal bypass - Manowar verified payment upstream, session=${sessionActive}`);
        return true;
    }

    // ==========================================================================
    // Compose Key Flow (external clients like Cursor, VSCode)
    // Performs ACTUAL on-chain USDC settlement using session key authority
    // ==========================================================================
    const authHeader = req.headers["authorization"] as string | undefined;
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);

    if (composeKeyToken) {
        console.log(`[x402] Compose Key detected, validating...`);

        const validation = await validateComposeKey(composeKeyToken, amountWei);

        if (!validation.valid) {
            console.log(`[x402] Compose Key invalid: ${validation.error}`);
            res.status(401).json({
                error: "Invalid Compose Key",
                details: validation.error,
            });
            return false;
        }

        // Step 1: Redis fast-path budget check and deduction
        const newUsed = await consumeKeyBudget(validation.payload!.keyId, amountWei);

        if (newUsed < 0) {
            console.log(`[x402] Compose Key budget exhausted for ${validation.payload!.keyId}`);
            res.status(402).json({
                error: "Compose Key budget exhausted",
                budgetLimit: validation.record!.budgetLimit,
                budgetUsed: validation.record!.budgetUsed,
            });
            return false;
        }

        // Step 2: On-chain USDC settlement using session key
        // The server uses TREASURY_WALLET's session key authority to transfer USDC
        const { settleComposeKeyPayment } = await import("./settlement.js");
        const userAddress = validation.payload!.sub;

        console.log(`[x402] Initiating on-chain settlement for ${userAddress}, amount: ${amountWei} wei`);

        const settlementResult = await settleComposeKeyPayment(userAddress, amountWei);

        if (!settlementResult.success) {
            // Rollback Redis budget on settlement failure
            console.log(`[x402] On-chain settlement failed: ${settlementResult.error}`);
            const { rollbackKeyUsage } = await import("../keys/storage.js");
            await rollbackKeyUsage(validation.payload!.keyId, amountWei);

            res.status(402).json({
                error: "Payment settlement failed",
                details: settlementResult.error,
                hint: "Ensure your session is active and has sufficient USDC balance",
            });
            return false;
        }

        console.log(`[x402] On-chain settlement successful: ${settlementResult.txHash}`);

        // Add budget info to response headers
        const budgetInfo = await getKeyBudgetInfo(validation.payload!.keyId);
        if (budgetInfo) {
            res.setHeader("x-compose-key-budget-limit", String(budgetInfo.budgetLimit));
            res.setHeader("x-compose-key-budget-used", String(budgetInfo.budgetUsed));
            res.setHeader("x-compose-key-budget-remaining", String(budgetInfo.budgetRemaining));
        }
        // Add settlement tx hash for transparency
        if (settlementResult.txHash) {
            res.setHeader("x-compose-key-tx-hash", settlementResult.txHash);
        }

        console.log(`[x402] Compose Key payment verified: ${validation.payload!.keyId}, user: ${userAddress}, cost: ${amountWei} wei, tx: ${settlementResult.txHash}`);
        return true;
    }

    // Standard x402 flow: require payment data header
    const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
    const result = await handleX402Payment(
        paymentData,
        resourceUrl,
        req.method || "POST",
        amountWei.toString(),
    );

    if (result.status !== 200) {
        Object.entries(result.responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.status(result.status).json(result.responseBody);
        return false;
    }

    console.log(`[x402] Payment verified for ${resourceUrl}`);
    return true;
}

/**
 * Require payment with dynamic pricing based on model or tool
 */
export async function requireDynamicPayment(
    req: Request,
    res: Response,
    modelId?: string,
    toolSource?: "goat" | "mcp" | "eliza",
    toolName?: string,
): Promise<boolean> {
    const priceWei = getPriceForRequest({ modelId, toolSource, toolName });
    return requirePayment(req, res, parseInt(priceWei));
}

// =============================================================================
// Payment Header Builders
// =============================================================================

/**
 * Build x402 response headers for payment required (402)
 */
export function buildPaymentRequiredHeaders(
    paymentMethod: X402PaymentMethod,
    skill: { pricing?: SkillPricing }
): Record<string, string> {
    return {
        "X-Payment-Required": "true",
        "X-Payment-Network": paymentMethod.network,
        "X-Payment-Asset": paymentMethod.assetAddress,
        "X-Payment-Amount": skill.pricing?.amount || "0",
        "X-Payment-Scheme": paymentMethod.x402?.scheme || "exact",
        "X-Payment-Payee": paymentMethod.payee,
    };
}

/**
 * Get chain config for a payment method
 */
export function getPaymentChainConfig(paymentMethod: X402PaymentMethod): {
    chainId: number;
    name: string;
    isTestnet: boolean;
} {
    const chainId = parseInt(paymentMethod.network, 10);

    switch (chainId) {
        case 43113:
            return { chainId, name: "Avalanche Fuji", isTestnet: true };
        case 43114:
            return { chainId, name: "Avalanche", isTestnet: false };
        case 42161:
            return { chainId, name: "Arbitrum One", isTestnet: false };
        case 421614:
            return { chainId, name: "Arbitrum Sepolia", isTestnet: true };
        case 137:
            return { chainId, name: "Polygon", isTestnet: false };
        case 80002:
            return { chainId, name: "Polygon Amoy", isTestnet: true };
        case 1:
            return { chainId, name: "Ethereum", isTestnet: false };
        case 11155111:
            return { chainId, name: "Sepolia", isTestnet: true };
        case 8453:
            return { chainId, name: "Base", isTestnet: false };
        case 84532:
            return { chainId, name: "Base Sepolia", isTestnet: true };
        default:
            return { chainId, name: `Chain ${chainId}`, isTestnet: false };
    }
}

// =============================================================================
// USDC Amount Helpers
// =============================================================================

/**
 * Format USDC amount from wei to human-readable
 */
export function formatUsdcAmount(weiAmount: string | bigint): string {
    const wei = typeof weiAmount === "string" ? BigInt(weiAmount) : weiAmount;
    const usdc = Number(wei) / 1e6;
    return usdc.toFixed(6);
}

/**
 * Parse USDC amount from human-readable to wei
 */
export function parseUsdcAmount(usdcAmount: string | number): string {
    const usdc = typeof usdcAmount === "string" ? parseFloat(usdcAmount) : usdcAmount;
    const wei = Math.floor(usdc * 1e6);
    return wei.toString();
}

// Re-export config for convenience
export {
    paymentChain,
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
};
