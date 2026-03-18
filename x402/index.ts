/**
 * x402 Payment Module
 * 
 * Single entry point for all x402 payment operations.
 * Handles payment verification, settlement, and header management.
 * Multichain Support: Cronos (via Cronos Labs facilitator) + Avalanche (via ThirdWeb)
 * 
 * @module shared/x402
 */

import type { Request, Response } from "express";
import { settlePayment } from "thirdweb/x402";
import {
    paymentChain,
    paymentChainId,
    paymentAsset,
    thirdwebFacilitator,
    merchantWalletAddress,
    serverWalletAddress,
    getChainIdFromPaymentData,
    getChainObject,
} from "./thirdweb.js";
import { CHAIN_IDS, isCronosChain, getUsdcAddress, getActiveChainId } from "./configs/chains.js";
import {
    createCronos402Response,
    verifyAndSettleCronosPayment,
    extractCronosPaymentHeader,
    isCronosPaymentHeader,
    getChainIdFromCronosHeader,
    getCronosNetworkString,
} from "./configs/cronos.js";
import { INFERENCE_PRICE_WEI, DEFAULT_PRICES, DYNAMIC_PRICES, getPriceForRequest } from "./pricing.js";
import type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";

// Compose Keys integration (session record for UI/token)
import {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    getKeyBudgetInfo,
} from "./keys/index.js";

// Session Budget - Deferred Payment (locked/used tracking for batch settlement)
import {
    getSessionBudget,
    lockBudget,
    cancelBudgetIntent,
    getSessionStatus,
    shouldTriggerImmediateSettlement,
} from "./session-budget.js";

// Re-export types
export type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";

function setComposeSessionInvalidHeader(
    target: Pick<Response, "setHeader"> | Record<string, string>,
    reason: string,
): void {
    if (typeof (target as { setHeader?: unknown }).setHeader === "function") {
        (target as Pick<Response, "setHeader">).setHeader("x-compose-session-invalid", reason);
        return;
    }

    (target as Record<string, string>)["x-compose-session-invalid"] = reason;
}

function getComposeSessionInvalidReason(error: string | undefined): string {
    const normalized = String(error || "").toLowerCase();
    if (normalized.includes("revoked")) return "revoked";
    if (normalized.includes("expired")) return "expired";
    if (normalized.includes("budget") || normalized.includes("insufficient")) return "budget_exhausted";
    return "invalid_key";
}

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

// getActiveChainId imported from chains.js above

// =============================================================================
// x402-compatible 402 Response Helper
// =============================================================================

/**
 * Create a proper x402-compatible 402 response body
 * ThirdWeb client expects: { x402Version, error, accepts: [...] }
 * Network must be in CAIP-2 format: eip155:{chainId}
 */
export function createPaymentRequired402Response(params: {
    error?: string;
    errorMessage?: string;
    amountWei?: number;
    resourceUrl?: string;
    chainId?: number;
}): {
    x402Version: number;
    error: string;
    errorMessage?: string;
    accepts: Array<{
        scheme: "exact";
        network: string;
        maxAmountRequired: string;
        resource: string;
        description: string;
        mimeType: string;
        payTo: string;
        maxTimeoutSeconds: number;
        asset: string;
    }>;
} {
    const chainId = params.chainId || getActiveChainId();
    const usdcAddress = getUsdcAddress(chainId);

    return {
        x402Version: 2,
        error: params.error || "payment_required",
        errorMessage: params.errorMessage,
        accepts: [{
            scheme: "exact",
            network: `eip155:${chainId}`, // CAIP-2 format required by ThirdWeb
            maxAmountRequired: String(params.amountWei || INFERENCE_PRICE_WEI),
            resource: params.resourceUrl || "",
            description: "Compose.Market AI Agent Inference",
            mimeType: "application/json",
            payTo: merchantWalletAddress,
            maxTimeoutSeconds: 300,
            asset: usdcAddress,
        }],
    };
}

// =============================================================================
// Payment Info Extraction
// =============================================================================

/**
 * Extract payment-related info from request headers
 * Supports both ThirdWeb (PAYMENT-SIGNATURE) and Cronos (X-PAYMENT) formats
 */
export function extractPaymentInfo(headers: Record<string, string | string[] | undefined>): PaymentInfo {
    // Check ThirdWeb format first (PAYMENT-SIGNATURE)
    let paymentData = typeof headers["payment-signature"] === "string" ? headers["payment-signature"] :
        (typeof headers["PAYMENT-SIGNATURE"] === "string" ? headers["PAYMENT-SIGNATURE"] : null);

    // If no ThirdWeb header, check Cronos format (X-PAYMENT)
    if (!paymentData) {
        paymentData = typeof headers["x-payment"] === "string" ? headers["x-payment"] :
            (typeof headers["X-PAYMENT"] === "string" ? headers["X-PAYMENT"] : null);
    }

    const sessionActive = headers["x-session-active"] === "true";
    const sessionBudgetRemaining = parseInt(
        typeof headers["x-session-budget-remaining"] === "string"
            ? headers["x-session-budget-remaining"]
            : "0",
        10
    );

    // Extract user wallet for session bypass
    const sessionUserAddress = typeof headers["x-session-user-address"] === "string"
        ? headers["x-session-user-address"]
        : null;

    return {
        paymentData,
        sessionActive,
        sessionBudgetRemaining,
        sessionUserAddress,
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
        return { valid: false, error: "Missing PAYMENT-SIGNATURE header" };
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
 * MULTICHAIN SUPPORT:
 * - Cronos chains (338, 25): Use Cronos Labs REST API facilitator (@crypto.com/facilitator-client)
 * - Other EVM chains (Avalanche, Base, etc.): Use ThirdWeb on-chain facilitator
 * 
 * @param paymentData - Signed payment data from PAYMENT-SIGNATURE or X-PAYMENT header
 * @param resourceUrl - URL of the resource being accessed
 * @param method - HTTP method
 * @param amountWei - Price in USDC wei (6 decimals)
 * @param chainId - Optional explicit chain ID (defaults to detecting from paymentData or env)
 * @returns Settlement result with status, body, and headers
 */
export async function handleX402Payment(
    paymentData: string | null,
    resourceUrl: string,
    method: string,
    amountWei: string,
    chainId?: number,
): Promise<X402SettlementResult> {
    console.log(`[x402] handleX402Payment for ${resourceUrl}`);
    console.log(`[x402] paymentData present: ${!!paymentData}`);
    console.log(`[x402] amount: ${amountWei}`);
    console.log(`[x402] payTo: ${merchantWalletAddress}`);

    // Determine target chain
    // Priority: explicit chainId > detected from payment header > env default
    let resolvedChainId = chainId ?? getActiveChainId();

    if (paymentData) {
        // Try to detect chain from payment header
        const cronosChainId = getChainIdFromCronosHeader(paymentData);
        if (cronosChainId) {
            resolvedChainId = cronosChainId;
        } else {
            // Try ThirdWeb format
            resolvedChainId = chainId ?? getChainIdFromPaymentData(paymentData);
        }
    }

    const useCronosFacilitator = isCronosChain(resolvedChainId);
    console.log(`[x402] chainId: ${resolvedChainId}`);
    console.log(`[x402] facilitator: ${useCronosFacilitator ? "CRONOS_LABS" : "THIRDWEB"}`);

    // =========================================================================
    // CASE 1: No payment data - return 402 response with payment requirements
    // =========================================================================
    if (!paymentData) {
        if (useCronosFacilitator) {
            // Return Cronos x402 V1 format 402 response
            console.log(`[x402] No payment - returning Cronos x402 V1 402 response`);
            const cronosResponse = createCronos402Response({
                payTo: merchantWalletAddress,
                amount: amountWei,
                chainId: resolvedChainId,
                description: "Compose.Market AI Agent Inference",
                resource: resourceUrl,
            });
            return {
                status: 402,
                responseBody: cronosResponse,
                responseHeaders: {
                    "X402-Version": "1",
                },
            };
        } else {
            // Use ThirdWeb to generate 402 response
            console.log(`[x402] No payment - using ThirdWeb for 402 response`);
            const chainObject = getChainObject(resolvedChainId);
            const usdcAddress = getUsdcAddress(resolvedChainId);

            const result = await settlePayment({
                resourceUrl,
                method,
                paymentData: null,
                payTo: merchantWalletAddress,
                network: chainObject,
                price: {
                    amount: amountWei,
                    asset: {
                        address: usdcAddress,
                    },
                },
                facilitator: thirdwebFacilitator,
            });

            return {
                status: result.status,
                responseBody: (result as { responseBody: unknown }).responseBody,
                responseHeaders: result.responseHeaders as Record<string, string>,
            };
        }
    }

    // =========================================================================
    // CASE 2: Payment data present - verify and settle
    // =========================================================================
    if (useCronosFacilitator) {
        // Use Cronos Labs facilitator (@crypto.com/facilitator-client)
        console.log(`[x402] Settling via Cronos Labs facilitator`);

        const result = await verifyAndSettleCronosPayment({
            paymentHeader: paymentData,
            payTo: merchantWalletAddress,
            amount: amountWei,
            chainId: resolvedChainId,
        });

        console.log(`[x402] Cronos result: status=${result.status}, success=${result.success}`);

        return {
            status: result.status,
            responseBody: result.success
                ? { success: true, txHash: result.txHash, blockNumber: result.blockNumber }
                : { error: result.error },
            responseHeaders: result.txHash
                ? { "X-Transaction-Hash": result.txHash, "X-PAYMENT-RESPONSE": result.txHash }
                : {},
        };
    } else {
        // Use ThirdWeb facilitator for non-Cronos chains
        console.log(`[x402] Settling via ThirdWeb facilitator`);

        const chainObject = getChainObject(resolvedChainId);
        const usdcAddress = getUsdcAddress(resolvedChainId);

        const result = await settlePayment({
            resourceUrl,
            method,
            paymentData,
            payTo: merchantWalletAddress,
            network: chainObject,
            price: {
                amount: amountWei,
                asset: {
                    address: usdcAddress,
                },
            },
            facilitator: thirdwebFacilitator,
        });

        console.log(`[x402] ThirdWeb result status: ${result.status}`);

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

// Internal marker for Workflow nested calls - the secret IS the proof of payment
// =============================================================================
// Deferred Payment Settlement (charge after response starts)
// =============================================================================

/**
 * Result of deferred payment preparation.
 */
export interface PreparedPayment {
    valid: boolean;
    error?: string;
    method?: "internal" | "session" | "compose-key" | "x402";
    metadata?: {
        amountWei: number;
        chainId: number;
        intentId?: string;
        userAddress?: string;
        keyId?: string;
    };
    /** Call this AFTER first response token to actually charge. Only call once! */
    settle: () => Promise<{ success: boolean; txHash?: string; error?: string }>;
    /** Abort deferred payment and rollback any locked budget */
    abort: (reason?: string) => Promise<void>;
    /** For setting response headers */
    getHeaders: () => Record<string, string>;
}

/**
 * Prepare payment without charging immediately.
 * Use settle() when first output is emitted, and abort() on failures before settlement.
 */
export async function prepareDeferredPayment(
    req: Request,
    amountWei: number = INFERENCE_PRICE_WEI,
): Promise<PreparedPayment> {
    const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
    const explicitChainId = chainIdHeader ? parseInt(String(chainIdHeader), 10) : getActiveChainId();
    const authHeader = req.headers["authorization"] as string | undefined;
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);
    const { paymentData, sessionActive, sessionBudgetRemaining, sessionUserAddress } = extractPaymentInfo(
        req.headers as Record<string, string | string[] | undefined>,
    );

    // Check for internal Workflow bypass first
    const internalMarker = req.headers["x-workflow-internal"] as string | undefined;
    if (internalMarker === RUNTIME_INTERNAL_MARKER) {
        console.log(`[x402] preparePayment: Internal bypass - Workflow verified payment upstream`);
        return {
            valid: true,
            method: "internal",
            metadata: { amountWei, chainId: explicitChainId },
            settle: async () => ({ success: true }),
            abort: async () => { },
            getHeaders: () => ({}),
        };
    }

    // ==========================================================================
    // Session bypass flow (deferred settlement with lock/abort lifecycle)
    // ==========================================================================
    if (sessionActive && sessionBudgetRemaining > 0 && sessionUserAddress) {
        const sessionBudget = await getSessionBudget(sessionUserAddress, explicitChainId);
        if (!sessionBudget) {
            return {
                valid: false,
                error: "Active session budget not found. Recreate the session.",
                method: "session",
                metadata: { amountWei, chainId: explicitChainId, userAddress: sessionUserAddress },
                settle: async () => ({ success: false, error: "Session budget missing" }),
                abort: async () => { },
                getHeaders: () => ({ "x-compose-session-invalid": "missing_budget_state" }),
            };
        }

        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const lockResult = await lockBudget(
            sessionUserAddress,
            explicitChainId,
            String(amountWei),
            merchantWalletAddress,
            requestId,
            req.body?.model,
        );

        if (lockResult.success) {
            let committed = false;
            let aborted = false;

            return {
                valid: true,
                method: "session",
                metadata: {
                    amountWei,
                    chainId: explicitChainId,
                    intentId: lockResult.intentId,
                    userAddress: sessionUserAddress,
                },
                // Commit means "keep intent locked for batch settlement".
                settle: async () => {
                    if (aborted) {
                        return { success: false, error: "payment_aborted" };
                    }
                    if (committed) {
                        return { success: true };
                    }
                    committed = true;
                    return { success: true };
                },
                abort: async (reason?: string) => {
                    if (aborted || committed) {
                        return;
                    }
                    aborted = true;
                    if (lockResult.intentId) {
                        await cancelBudgetIntent(lockResult.intentId, reason || "Inference failed before settlement");
                    }
                },
                getHeaders: () => ({
                    "x-payment-method": "session-bypass",
                    "x-budget-remaining": lockResult.availableWei,
                    "x-settlement": "deferred",
                    ...(lockResult.intentId ? { "x-payment-intent-id": lockResult.intentId } : {}),
                }),
            };
        }
    }

    // ==========================================================================
    // Compose Key flow
    // ==========================================================================
    if (composeKeyToken) {
        console.log(`[x402] preparePayment: Compose Key detected, validating...`);

        const validation = await validateComposeKey(composeKeyToken, amountWei);

        if (!validation.valid) {
            console.log(`[x402] preparePayment: Compose Key invalid: ${validation.error}`);
            const reason = getComposeSessionInvalidReason(validation.error);
            return {
                valid: false,
                error: validation.error,
                method: "compose-key",
                metadata: { amountWei, chainId: explicitChainId },
                settle: async () => ({ success: false, error: "Invalid key" }),
                abort: async () => { },
                getHeaders: () => ({ "x-compose-session-invalid": reason }),
            };
        }

        // Pre-flight budget check only
        const budgetRemaining = validation.record!.budgetLimit - validation.record!.budgetUsed;
        if (budgetRemaining < amountWei) {
            console.log(`[x402] preparePayment: Budget exhausted: ${budgetRemaining} < ${amountWei}`);
            return {
                valid: false,
                error: "Budget exhausted",
                method: "compose-key",
                metadata: { amountWei, chainId: explicitChainId, keyId: validation.payload?.keyId },
                settle: async () => ({ success: false, error: "Budget exhausted" }),
                abort: async () => { },
                getHeaders: () => ({ "x-compose-session-invalid": "budget_exhausted" }),
            };
        }

        // Return valid with deferred settlement
        let settled = false;
        let aborted = false;
        let settlementTxHash: string | undefined;

        return {
            valid: true,
            method: "compose-key",
            metadata: {
                amountWei,
                chainId: explicitChainId,
                keyId: validation.payload?.keyId,
                userAddress: validation.payload?.sub,
            },
            settle: async () => {
                if (aborted) {
                    return { success: false, error: "payment_aborted" };
                }
                if (settled) {
                    console.log(`[x402] preparePayment: Already settled, skipping`);
                    return { success: true, txHash: settlementTxHash };
                }
                settled = true;

                console.log(`[x402] preparePayment: Executing deferred settlement for ${validation.payload!.sub}`);
                const { settleComposeKeyPayment } = await import("./settlement.js");
                const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
                const chainId = chainIdHeader ? parseInt(String(chainIdHeader)) : getActiveChainId();
                const result = await settleComposeKeyPayment(validation.payload!.sub, amountWei, chainId);

                if (result.success) {
                    settlementTxHash = result.txHash;
                    // Update Redis cache
                    try {
                        await consumeKeyBudget(validation.payload!.keyId, amountWei);
                    } catch (e) {
                        console.warn(`[x402] preparePayment: Redis update failed but on-chain succeeded`);
                    }
                }

                return result;
            },
            abort: async () => {
                aborted = true;
            },
            getHeaders: () => {
                const headers: Record<string, string> = {
                    "x-compose-key-budget-limit": String(validation.record!.budgetLimit),
                    "x-compose-key-budget-used": String(validation.record!.budgetUsed),
                    "x-compose-key-budget-remaining": String(budgetRemaining),
                };
                if (settlementTxHash) {
                    headers["x-compose-key-tx-hash"] = settlementTxHash;
                }
                return headers;
            },
        };
    }

    // ==========================================================================
    // x402 PAYMENT-SIGNATURE Flow (standard x402 v2 per-request settlement)
    // ==========================================================================
    if (paymentData) {
        console.log(`[x402] preparePayment: PAYMENT-SIGNATURE detected, using x402 flow`);

        // x402 flow: deferred settlement
        let settled = false;
        let aborted = false;
        let settleResult: { success: boolean; txHash?: string; error?: string } | null = null;

        return {
            valid: true,
            method: "x402",
            metadata: { amountWei, chainId: explicitChainId },
            settle: async () => {
                if (aborted) {
                    return { success: false, error: "payment_aborted" };
                }
                if (settled && settleResult) {
                    console.log(`[x402] preparePayment: Already settled, returning cached result`);
                    return settleResult;
                }
                settled = true;

                const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;

                // Read X-CHAIN-ID header for consistent chain routing
                const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
                const explicitChainId = chainIdHeader ? parseInt(String(chainIdHeader)) : undefined;

                const result = await handleX402Payment(
                    paymentData,
                    resourceUrl,
                    req.method || "POST",
                    amountWei.toString(),
                    explicitChainId,
                );

                if (result.status === 200) {
                    // Extract txHash from response - handle both Cronos and ThirdWeb formats
                    // Cronos: { success: true, txHash: "0x..." }
                    // ThirdWeb: { success: true, receipt: { transaction: "0x..." } }
                    const responseBody = result.responseBody as any;
                    const txHash = responseBody?.txHash || responseBody?.receipt?.transaction;
                    settleResult = { success: true, txHash };
                    console.log(`[x402] preparePayment: x402 settlement success, tx: ${txHash}`);
                } else {
                    settleResult = { success: false, error: (result.responseBody as any)?.error || "Settlement failed" };
                    console.log(`[x402] preparePayment: x402 settlement failed: ${settleResult.error}`);
                }

                return settleResult;
            },
            abort: async () => {
                aborted = true;
            },
            getHeaders: () => ({}),
        };
    }

    // No valid payment method - return helpful error with payment requirements
    return {
        valid: false,
        error: "No valid payment method - use Compose Key or PAYMENT-SIGNATURE header",
        metadata: { amountWei, chainId: explicitChainId },
        settle: async () => ({ success: false, error: "No payment" }),
        abort: async () => { },
        getHeaders: () => ({}),
    };
}

const RUNTIME_INTERNAL_MARKER = requireEnv("RUNTIME_INTERNAL_SECRET");

/**
 * Require x402 payment for any endpoint.
 * 
 * This is the single function all endpoints should use for payment verification.
 * 
 * Payment can be verified in two ways:
 * 1. PAYMENT-SIGNATURE header (standard x402 v2 per-request settlement)
 * 2. x-workflow-internal + active session (for nested agent/workflow calls)
 * 
 * The session-based bypass ensures:
 * - Users still pay at the agent/workflow endpoint level
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
    const { paymentData, sessionActive, sessionBudgetRemaining, sessionUserAddress } = extractPaymentInfo(
        req.headers as Record<string, string | string[] | undefined>
    );

    // DEBUG: Log incoming headers for bypass check
    const internalMarker = req.headers["x-workflow-internal"] as string | undefined;
    const userAgent = req.headers["user-agent"] as string || "";
    console.log(`[x402-debug] Internal marker: ${internalMarker ? 'PRESENT' : 'MISSING'}, value: ${internalMarker?.substring(0, 20) || 'N/A'}`);
    console.log(`[x402-debug] Expected marker: ${RUNTIME_INTERNAL_MARKER.substring(0, 20)}`);
    console.log(`[x402-debug] User-Agent: ${userAgent.substring(0, 50)}`);
    console.log(`[x402-debug] sec-fetch-mode: ${req.headers["sec-fetch-mode"] || 'N/A'}`);
    console.log(`[x402-debug] Session: active=${sessionActive}, budget=${sessionBudgetRemaining}`);

    const hasValidSession = sessionActive && sessionBudgetRemaining > 0;

    // @dev: Security Note:
    // If internal marker matches, allow the request
    // The marker is the proof of payment because:
    // 1. Workflow only adds x-workflow-internal AFTER verifying x402 payment at /agent/{wallet}/chat|image|video|audio|...
    // 2. The secret is stored in RUNTIME_INTERNAL_SECRET .env
    // 3. If someone knows the secret, they're either Workflow or have access to our infrastructure

    if (internalMarker === RUNTIME_INTERNAL_MARKER) {
        console.log(`[x402] Internal bypass - Workflow verified payment upstream, session=${sessionActive}`);
        return true;
    }

    // ==========================================================================
    // TIER 1: Session Budget Bypass - Deferred Settlement
    // Lock budget in Redis, skip on-chain settlement (batch settles every 2 min)
    // ==========================================================================
    const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
    const explicitChainId = chainIdHeader ? parseInt(String(chainIdHeader)) : getActiveChainId();
    const authHeader = req.headers["authorization"] as string | undefined;
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);

    if (hasValidSession && sessionUserAddress && composeKeyToken) {
        console.log(`[x402] Session bypass attempt: ${sessionUserAddress}, chain=${explicitChainId}, amount=${amountWei}`);

        const validation = await validateComposeKey(composeKeyToken, amountWei);
        if (!validation.valid || !validation.payload || !validation.record) {
            setComposeSessionInvalidHeader(res, getComposeSessionInvalidReason(validation.error));
            res.status(401).json({
                error: "Invalid Compose Key",
                details: validation.error,
            });
            return false;
        }
        if (validation.payload.sub.toLowerCase() !== sessionUserAddress.toLowerCase()) {
            setComposeSessionInvalidHeader(res, "invalid_key");
            res.status(401).json({
                error: "Invalid Compose Key",
                details: "Compose Key user does not match session user",
            });
            return false;
        }
        if (validation.record.chainId && validation.record.chainId !== explicitChainId) {
            setComposeSessionInvalidHeader(res, "invalid_key");
            res.status(401).json({
                error: "Invalid Compose Key",
                details: "Compose Key chain does not match request chain",
            });
            return false;
        }

        const sessionBudget = await getSessionBudget(sessionUserAddress, explicitChainId);
        if (!sessionBudget) {
            res.setHeader("x-compose-session-invalid", "missing_budget_state");
            res.status(401).json({
                error: "Active session budget not found",
                hint: "Recreate the session and try again",
            });
            return false;
        }

        // Generate unique request ID
        const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

        // Attempt to lock budget atomically in session-budget.ts (deferred payment ledger)
        const lockResult = await lockBudget(
            sessionUserAddress,
            explicitChainId,
            String(amountWei),
            merchantWalletAddress,
            requestId,
            req.body?.model,
        );

        if (lockResult.success) {
            console.log(`[x402] Session bypass SUCCESS: locked ${amountWei} wei, available: ${lockResult.availableWei}`);

            // Check if we need to trigger immediate settlement ($1 threshold)
            const shouldSettle = await shouldTriggerImmediateSettlement(sessionUserAddress, explicitChainId);
            if (shouldSettle) {
                console.log(`[x402] Threshold reached - triggering immediate settlement for ${sessionUserAddress}`);
            }

            // Get session status for notifications
            const sessionStatus = await getSessionStatus(sessionUserAddress, explicitChainId);

            // Set response headers for client tracking
            res.setHeader("x-payment-method", "session-bypass");
            res.setHeader("x-budget-remaining", lockResult.availableWei);
            res.setHeader("x-session-budget-remaining", lockResult.availableWei);
            res.setHeader("x-settlement", "deferred");

            // Add session notification headers for frontend
            if (sessionStatus) {
                res.setHeader("x-session-budget-limit", sessionStatus.totalBudget);
                res.setHeader("x-session-budget-used", sessionStatus.usedBudget);
                // Budget warnings
                if (sessionStatus.warnings.budgetDepleted) {
                    res.setHeader("x-session-status", "budget-depleted");
                } else if (sessionStatus.warnings.budgetLow) {
                    res.setHeader("x-session-status", "budget-low");
                } else if (sessionStatus.warnings.expiringSoon) {
                    res.setHeader("x-session-status", "expiring-soon");
                }

                // Additional metadata
                res.setHeader("x-session-expires-in", String(sessionStatus.expiresInSeconds));
                res.setHeader("x-session-budget-percent", String(Math.floor(sessionStatus.budgetPercentRemaining)));
            }

            return true;
        } else {
            // Budget insufficient or no session - fall through to standard flows
            console.log(`[x402] Session bypass FAILED: ${lockResult.error}`);
        }
    }

    // ==========================================================================
    // Compose Key Flow (external clients like Cursor, OpenClaw, OpenCode, ...)
    // Performs ACTUAL on-chain USDC settlement using session key authority
    // ==========================================================================
    if (composeKeyToken) {
        console.log(`[x402] Compose Key detected, validating...`);

        const validation = await validateComposeKey(composeKeyToken, amountWei);

        if (!validation.valid) {
            console.log(`[x402] Compose Key invalid: ${validation.error}`);
            setComposeSessionInvalidHeader(res, getComposeSessionInvalidReason(validation.error));
            res.status(401).json({
                error: "Invalid Compose Key",
                details: validation.error,
            });
            return false;
        }

        // Step 1: Pre-flight budget check (no deduction yet - just validation)
        // Redis is a CACHE, blockchain is source of truth
        const budgetRemaining = validation.record!.budgetLimit - validation.record!.budgetUsed;
        if (budgetRemaining < amountWei) {
            console.log(`[x402] Compose Key budget exhausted for ${validation.payload!.keyId}: ${budgetRemaining} < ${amountWei}`);
            setComposeSessionInvalidHeader(res, "budget_exhausted");
            res.status(402).json({
                error: "Compose Key budget exhausted",
                budgetLimit: validation.record!.budgetLimit,
                budgetUsed: validation.record!.budgetUsed,
                budgetRemaining,
            });
            return false;
        }

        // Step 2: On-chain USDC settlement FIRST (blockchain is source of truth)
        // The server uses TREASURY_WALLET's session key authority to transfer USDC
        const { settleComposeKeyPayment } = await import("./settlement.js");
        const userAddress = validation.payload!.sub;

        console.log(`[x402] Initiating on-chain settlement for ${userAddress}, amount: ${amountWei} wei`);

        const settlementResult = await settleComposeKeyPayment(userAddress, amountWei, explicitChainId);

        if (!settlementResult.success) {
            // On-chain payment failed - no money transferred, no Redis update needed
            console.log(`[x402] On-chain settlement failed: ${settlementResult.error}`);
            res.status(402).json({
                error: "Payment settlement failed",
                details: settlementResult.error,
                hint: "Ensure your session is active and has sufficient USDC balance",
            });
            return false;
        }

        console.log(`[x402] On-chain settlement successful: ${settlementResult.txHash}`);

        // Step 3: On-chain succeeded! Now update Redis cache (best-effort)
        // Even if Redis fails, payment was collected on-chain
        try {
            const newUsed = await consumeKeyBudget(validation.payload!.keyId, amountWei);
            if (newUsed < 0) {
                // Race condition: another request consumed budget concurrently
                // On-chain payment already collected, log for reconciliation
                console.warn(`[x402] Redis budget sync issue for ${validation.payload!.keyId} - on-chain payment collected, Redis shows exhausted`);
            }
        } catch (redisError) {
            // Redis failed but on-chain payment succeeded - log for reconciliation
            console.error(`[x402] Redis update failed for ${validation.payload!.keyId}:`, redisError);
            console.warn(`[x402] Payment collected on-chain (tx: ${settlementResult.txHash}) but Redis not updated`);
        }

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

    // Note: explicitChainId already extracted above for session bypass
    const result = await handleX402Payment(
        paymentData,
        resourceUrl,
        req.method || "POST",
        amountWei.toString(),
        explicitChainId, // Pass client-specified chain ID
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
        "Payment-Required": "true",
        "Payment-Network": paymentMethod.network,
        "Payment-Asset": paymentMethod.assetAddress,
        "Payment-Amount": skill.pricing?.amount || "0",
        "Payment-Scheme": paymentMethod.x402?.scheme || "exact",
        "Payment-Payee": paymentMethod.payee,
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
        // Cronos (DEFAULT for x402 payments)
        case 338:
            return { chainId, name: "Cronos Testnet", isTestnet: true };
        case 25:
            return { chainId, name: "Cronos", isTestnet: false };
        // Avalanche
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
