/**
 * x402 Payment Module
 *
 * Single entry point for all x402 payment operations.
 * Handles payment verification, settlement, and Compose-specific extensions.
 */

import type { Request, Response } from "express";
import type { PaymentRequired } from "@x402/core/types";
import {
    paymentChain,
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
} from "./wallets.js";
import {
    getActiveChainId,
} from "./configs/chains.js";
import type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";
import {
    createComposePaymentRequired,
    createComposePaymentRequirement,
    decodeComposePaymentSignatureHeader,
    encodeComposePaymentRequiredHeader,
    encodeComposePaymentResponseHeader,
    getChainIdFromPaymentPayload,
    settleComposePayment,
    verifyComposePayment,
} from "./facilitator.js";

// Compose Keys integration (session record for UI/token)
import {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    getKeyBudgetInfo,
    getActiveSessionStatus,
} from "./keys/index.js";

// Session Budget - Deferred Payment (locked/used tracking for batch settlement)
import {
    getSessionBudget,
    lockBudget,
    cancelBudgetIntent,
    getSessionStatus,
    shouldTriggerImmediateSettlement,
} from "./session-budget.js";
import {
    quoteMeteredAuthorization,
    quoteMeteredSettlement,
    type MeteredAuthorizationInput,
    type MeteredSettlementInput,
} from "./metering.js";
import {
    authorizePaymentIntent,
    abortPaymentIntent,
    settlePaymentIntent,
} from "./intents.js";

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

// getActiveChainId imported from chains.js above

// =============================================================================
// x402-compatible 402 Response Helper
// =============================================================================

/**
 * Create a spec-compliant x402 v2 402 body enriched with Compose extensions.
 */
export function createPaymentRequired402Response(params: {
    error?: string;
    errorMessage?: string;
    amountWei: number;
    resourceUrl?: string;
    chainId?: number;
}): PaymentRequired {
    const chainId = params.chainId || getActiveChainId();

    return createComposePaymentRequired({
        amountWei: params.amountWei,
        chainId,
        resourceUrl: params.resourceUrl || "",
        description: "Compose.Market AI Agent Inference",
        mimeType: "application/json",
        error: params.errorMessage || params.error || "payment_required",
    });
}

// =============================================================================
// Payment Info Extraction
// =============================================================================

/**
 * Extract payment-related info from request headers.
 */
export function extractPaymentInfo(headers: Record<string, string | string[] | undefined>): PaymentInfo {
    let paymentData = typeof headers["payment-signature"] === "string" ? headers["payment-signature"] :
        (typeof headers["PAYMENT-SIGNATURE"] === "string" ? headers["PAYMENT-SIGNATURE"] : null);

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

async function resolveComposeSessionContext(
    headers: Record<string, string | string[] | undefined>,
    explicitChainId: number,
): Promise<{
    paymentData: string | null;
    composeKeyToken: string | null;
    composeKeyValidation: Awaited<ReturnType<typeof validateComposeKey>> | null;
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    sessionUserAddress: string | null;
    sessionInvalidReason: string | null;
}> {
    const { paymentData } = extractPaymentInfo(headers);
    const authHeader = typeof headers["authorization"] === "string" ? headers["authorization"] : undefined;
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);

    if (!composeKeyToken) {
        return {
            paymentData,
            composeKeyToken: null,
            composeKeyValidation: null,
            sessionActive: false,
            sessionBudgetRemaining: 0,
            sessionUserAddress: null,
            sessionInvalidReason: null,
        };
    }

    const composeKeyValidation = await validateComposeKey(composeKeyToken, 0);
    if (!composeKeyValidation.valid || !composeKeyValidation.payload || !composeKeyValidation.record) {
        return {
            paymentData,
            composeKeyToken,
            composeKeyValidation,
            sessionActive: false,
            sessionBudgetRemaining: 0,
            sessionUserAddress: null,
            sessionInvalidReason: getComposeSessionInvalidReason(composeKeyValidation.error),
        };
    }

    const sessionUserAddress = composeKeyValidation.payload.sub;
    if (composeKeyValidation.record.chainId && composeKeyValidation.record.chainId !== explicitChainId) {
        return {
            paymentData,
            composeKeyToken,
            composeKeyValidation,
            sessionActive: false,
            sessionBudgetRemaining: 0,
            sessionUserAddress,
            sessionInvalidReason: "invalid_key",
        };
    }

    if (composeKeyValidation.record.purpose !== "session") {
        return {
            paymentData,
            composeKeyToken,
            composeKeyValidation,
            sessionActive: false,
            sessionBudgetRemaining: 0,
            sessionUserAddress,
            sessionInvalidReason: null,
        };
    }

    const sessionStatus = await getActiveSessionStatus(sessionUserAddress, explicitChainId);
    const activeSession = sessionStatus.session;
    if (!activeSession || activeSession.keyId !== composeKeyValidation.record.keyId) {
        return {
            paymentData,
            composeKeyToken,
            composeKeyValidation,
            sessionActive: false,
            sessionBudgetRemaining: 0,
            sessionUserAddress,
            sessionInvalidReason: activeSession ? "invalid_key" : sessionStatus.reason,
        };
    }

    return {
        paymentData,
        composeKeyToken,
        composeKeyValidation,
        sessionActive: true,
        sessionBudgetRemaining: activeSession.budgetRemaining,
        sessionUserAddress,
        sessionInvalidReason: null,
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

    try {
        if (typeof header !== "string" || header.length < 10) {
            return { valid: false, error: "Invalid payment data format" };
        }
        decodeComposePaymentSignatureHeader(header);
        return { valid: true };
    } catch (error) {
        return { valid: false, error: "Invalid payment data encoding" };
    }
}

// =============================================================================
// x402 Payment Settlement
// =============================================================================

/**
 * Handle x402 payment verification and settlement.
 * @param paymentData - Signed payment data from the PAYMENT-SIGNATURE header
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

    let resolvedChainId = chainId ?? getActiveChainId();
    if (!paymentData) {
        const paymentRequired = createPaymentRequired402Response({
            amountWei: Number.parseInt(amountWei, 10),
            resourceUrl,
            chainId: resolvedChainId,
        });

        return {
            status: 402,
            responseBody: paymentRequired,
            responseHeaders: {
                "PAYMENT-REQUIRED": encodeComposePaymentRequiredHeader(paymentRequired),
            },
        };
    }

    let paymentPayload;
    try {
        paymentPayload = decodeComposePaymentSignatureHeader(paymentData);
        resolvedChainId = getChainIdFromPaymentPayload(paymentPayload);
    } catch (error) {
        const paymentRequired = createPaymentRequired402Response({
            amountWei: Number.parseInt(amountWei, 10),
            resourceUrl,
            chainId: resolvedChainId,
            errorMessage: error instanceof Error ? error.message : "Invalid payment payload",
        });

        return {
            status: 402,
            responseBody: paymentRequired,
            responseHeaders: {
                "PAYMENT-REQUIRED": encodeComposePaymentRequiredHeader(paymentRequired),
            },
        };
    }

    const paymentRequirements = createComposePaymentRequirement({
        amountWei,
        chainId: resolvedChainId,
    });

    try {
        const verifyResult = await verifyComposePayment(paymentPayload, paymentRequirements);
        if (!verifyResult.isValid) {
            const paymentRequired = createPaymentRequired402Response({
                amountWei: Number.parseInt(amountWei, 10),
                resourceUrl,
                chainId: resolvedChainId,
                errorMessage: verifyResult.invalidMessage || verifyResult.invalidReason || "Payment verification failed",
            });

            return {
                status: 402,
                responseBody: paymentRequired,
                responseHeaders: {
                    "PAYMENT-REQUIRED": encodeComposePaymentRequiredHeader(paymentRequired),
                },
            };
        }

        const settleResult = await settleComposePayment(paymentPayload, paymentRequirements);
        const settlementHeaders: Record<string, string> = {
            "PAYMENT-RESPONSE": encodeComposePaymentResponseHeader(settleResult),
        };
        if (settleResult.transaction) {
            settlementHeaders["X-Transaction-Hash"] = settleResult.transaction;
        }

        if (!settleResult.success) {
            const paymentRequired = createPaymentRequired402Response({
                amountWei: Number.parseInt(amountWei, 10),
                resourceUrl,
                chainId: resolvedChainId,
                errorMessage: settleResult.errorMessage || settleResult.errorReason || "Payment settlement failed",
            });

            return {
                status: 402,
                responseBody: paymentRequired,
                responseHeaders: {
                    ...settlementHeaders,
                    "PAYMENT-REQUIRED": encodeComposePaymentRequiredHeader(paymentRequired),
                },
            };
        }

        return {
            status: 200,
            responseBody: {
                success: true,
                receipt: settleResult,
            },
            responseHeaders: settlementHeaders,
        };
    } catch (error) {
        return {
            status: 500,
            responseBody: {
                error: error instanceof Error ? error.message : "Compose facilitator settlement failed",
            },
            responseHeaders: {},
        };
    }
}

// Universal Payment Wrapper
// =============================================================================

function getRuntimeInternalMarker(): string | null {
    const value = process.env.RUNTIME_INTERNAL_SECRET;
    return typeof value === "string" && value.length > 0 ? value : null;
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

export type InferenceAuthorizationInput =
    | { useBudgetCap: true }
    | { maxAmountWei: string }
    | { meter: MeteredAuthorizationInput };

export type InferenceSettlementInput =
    | { finalAmountWei: string }
    | { meter: MeteredSettlementInput };

interface InferencePaymentSettlementResult {
    success: boolean;
    txHash?: string;
    finalAmountWei?: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    meterSubject?: string;
    lineItems?: Array<{
        key: string;
        unit: string;
        quantity: number;
        unitPriceUsd: number;
        amountWei: string;
    }>;
    chainId?: number;
    settledAt?: number;
    error?: string;
    statusCode?: number;
    paymentRequired?: PaymentRequired;
    paymentRequiredHeader?: string | null;
}

export interface PreparedInferencePayment {
    maxAmountWei: string;
    settle: (settlement: InferenceSettlementInput) => Promise<InferencePaymentSettlementResult>;
    abort: (reason?: string) => Promise<void>;
    applyHeaders: (res: Response, settlement?: InferencePaymentSettlementResult) => void;
}

export function getChainIdFromRequest(req: Request): number | undefined {
    const chainIdHeader = req.get?.("x-chain-id") || req.headers["x-chain-id"];
    if (!chainIdHeader) {
        return undefined;
    }

    const parsed = parseInt(String(chainIdHeader), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function getPaymentSignatureFromRequest(req: Request): string | null {
    const paymentHeader = req.get?.("payment-signature")
        || req.get?.("PAYMENT-SIGNATURE")
        || req.headers["payment-signature"]
        || req.headers["PAYMENT-SIGNATURE"];

    return typeof paymentHeader === "string" && paymentHeader.trim().length > 0
        ? paymentHeader.trim()
        : null;
}

export function parsePositiveIntegerHeader(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) {
        return null;
    }

    return BigInt(trimmed) > 0n ? trimmed : null;
}

export function getRawInferenceMaxAmount(req: Request): string | null {
    const headerValue = req.get?.("x-x402-max-amount-wei")
        || req.get?.("X-X402-Max-Amount-Wei")
        || req.headers["x-x402-max-amount-wei"]
        || req.headers["X-X402-Max-Amount-Wei"];

    const parsedHeader = parsePositiveIntegerHeader(headerValue);
    if (parsedHeader) {
        return parsedHeader;
    }

    const bodyValue = req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>).max_payment_amount_wei
        : undefined;
    return parsePositiveIntegerHeader(bodyValue);
}

function resolveInferenceAuthorizationRequirement(
    req: Request,
    authorizationInput: InferenceAuthorizationInput,
): { scheme: "exact" | "upto"; maxAmountWei: string } {
    if ("maxAmountWei" in authorizationInput) {
        return {
            scheme: "exact",
            maxAmountWei: authorizationInput.maxAmountWei,
        };
    }

    if ("meter" in authorizationInput) {
        return {
            scheme: "exact",
            maxAmountWei: quoteMeteredAuthorization(authorizationInput.meter).finalAmountWei,
        };
    }

    const maxAmountWei = getRawInferenceMaxAmount(req);
    if (!maxAmountWei) {
        throw Object.assign(
            new Error("x-x402-max-amount-wei is required for usage-priced x402 inference requests"),
            { statusCode: 400 },
        );
    }

    return {
        scheme: "upto",
        maxAmountWei,
    };
}

function isInternalInferenceRequest(authorization: string): boolean {
    if (!authorization) {
        return false;
    }

    const internalToken = process.env.RUNTIME_INTERNAL_SECRET;
    if (!internalToken) {
        return false;
    }

    return authorization === `Bearer ${internalToken}`;
}

async function prepareRawInferenceX402Payment(
    req: Request,
    res: Response,
    authorizationInput: InferenceAuthorizationInput,
): Promise<PreparedInferencePayment | null> {
    const requirement = resolveInferenceAuthorizationRequirement(req, authorizationInput);
    const fallbackChainId = getChainIdFromRequest(req) ?? getActiveChainId();
    const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;

    const buildPaymentRequired = (chainId: number, error?: string) => createComposePaymentRequired({
        amountWei: requirement.maxAmountWei,
        chainId,
        scheme: requirement.scheme,
        resourceUrl,
        description: "Compose.Market AI Agent Inference",
        mimeType: "application/json",
        ...(error ? { error } : {}),
    });

    const paymentSignature = getPaymentSignatureFromRequest(req);
    if (!paymentSignature) {
        const paymentRequired = buildPaymentRequired(fallbackChainId);
        res.setHeader("PAYMENT-REQUIRED", encodeComposePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    let paymentPayload;
    let paymentChainId = fallbackChainId;
    try {
        paymentPayload = decodeComposePaymentSignatureHeader(paymentSignature);
        paymentChainId = getChainIdFromPaymentPayload(paymentPayload);
    } catch (error) {
        const paymentRequired = buildPaymentRequired(
            fallbackChainId,
            error instanceof Error ? error.message : "Invalid payment payload",
        );
        res.setHeader("PAYMENT-REQUIRED", encodeComposePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    const verificationRequirement = createComposePaymentRequirement({
        amountWei: requirement.maxAmountWei,
        chainId: paymentChainId,
        scheme: requirement.scheme,
    });
    const verifyResult = await verifyComposePayment(paymentPayload, verificationRequirement);
    if (!verifyResult.isValid) {
        const paymentRequired = buildPaymentRequired(
            paymentChainId,
            verifyResult.invalidMessage || verifyResult.invalidReason || "Payment verification failed",
        );
        res.setHeader("PAYMENT-REQUIRED", encodeComposePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    let currentHeaders: Record<string, string> = {};

    return {
        maxAmountWei: requirement.maxAmountWei,
        settle: async (settlementInput) => {
            const finalAmountWei = requirement.scheme === "exact"
                ? requirement.maxAmountWei
                : ("finalAmountWei" in settlementInput
                    ? settlementInput.finalAmountWei
                    : quoteMeteredSettlement(settlementInput.meter).finalAmountWei);

            if (requirement.scheme === "upto" && BigInt(finalAmountWei) > BigInt(requirement.maxAmountWei)) {
                return {
                    success: false,
                    error: "finalAmountWei cannot exceed the x402 authorized maximum",
                };
            }

            const settled = await settleComposePayment(
                paymentPayload,
                createComposePaymentRequirement({
                    amountWei: finalAmountWei,
                    chainId: paymentChainId,
                    scheme: requirement.scheme,
                }),
            );

            currentHeaders = {
                "PAYMENT-RESPONSE": encodeComposePaymentResponseHeader(settled),
            };
            if (settled.transaction) {
                currentHeaders["X-Transaction-Hash"] = settled.transaction;
            }

            if (!settled.success) {
                return {
                    success: false,
                    error: settled.errorMessage || settled.errorReason || "Payment settlement failed",
                };
            }

            return {
                success: true,
                txHash: settled.transaction || undefined,
                finalAmountWei,
            };
        },
        abort: async () => undefined,
        applyHeaders: (response) => {
            if (response.headersSent) {
                return;
            }
            for (const [key, value] of Object.entries(currentHeaders)) {
                response.setHeader(key, value);
            }
        },
    };
}

export async function prepareInferencePayment(
    req: Request,
    res: Response,
    authorizationInput: InferenceAuthorizationInput,
): Promise<PreparedInferencePayment | null> {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (isInternalInferenceRequest(authorization)) {
        return {
            maxAmountWei: "0",
            settle: async () => ({ success: true, finalAmountWei: "0" }),
            abort: async () => { },
            applyHeaders: () => { },
        };
    }

    const composeKeyToken = extractComposeKeyFromHeader(authorization);
    if (!composeKeyToken) {
        return prepareRawInferenceX402Payment(req, res, authorizationInput);
    }

    const chainId = getChainIdFromRequest(req);
    const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
    const prepared = await authorizePaymentIntent({
        authorization,
        chainId: chainId ?? Number.NaN,
        service: "api",
        action: "inference",
        resource: resourceUrl,
        method: req.method || "POST",
        ...authorizationInput,
        composeRunId: typeof req.headers["x-compose-run-id"] === "string" ? req.headers["x-compose-run-id"] : undefined,
        idempotencyKey: typeof req.headers["x-idempotency-key"] === "string" ? req.headers["x-idempotency-key"] : undefined,
    });

    if (!prepared.ok) {
        for (const [key, value] of Object.entries(prepared.headers)) {
            res.setHeader(key, value);
        }
        res.status(prepared.status).json(prepared.body);
        return null;
    }

    let currentHeaders = { ...prepared.headers };

    return {
        maxAmountWei: prepared.body.maxAmountWei,
        settle: async (settlementInput) => {
            const settled = await settlePaymentIntent({
                paymentIntentId: prepared.body.paymentIntentId,
                ...settlementInput,
            });

            if (!settled.ok) {
                const paymentRequiredHeader = settled.headers["PAYMENT-REQUIRED"]
                    || settled.headers["payment-required"]
                    || null;
                const paymentRequired = settled.body && typeof settled.body === "object"
                    && "x402Version" in settled.body
                    && Array.isArray((settled.body as PaymentRequired).accepts)
                    ? settled.body as PaymentRequired
                    : undefined;
                return {
                    success: false,
                    error: typeof settled.body.error === "string" ? settled.body.error : "Payment settlement failed",
                    statusCode: settled.status,
                    paymentRequired,
                    paymentRequiredHeader,
                };
            }

            currentHeaders = { ...settled.headers };
            return {
                success: true,
                txHash: settled.body.txHash,
                finalAmountWei: settled.body.finalAmountWei,
                providerAmountWei: settled.body.providerAmountWei,
                platformFeeWei: settled.body.platformFeeWei,
                meterSubject: settled.body.meterSubject,
                lineItems: settled.body.lineItems,
                chainId,
                settledAt: Date.now(),
            };
        },
        abort: async (reason?: string) => {
            await abortPaymentIntent({
                paymentIntentId: prepared.body.paymentIntentId,
                reason: reason || "inference_failed",
            });
        },
        applyHeaders: (response, settlement) => {
            if (response.headersSent) {
                return;
            }

            for (const [key, value] of Object.entries(currentHeaders)) {
                response.setHeader(key, value);
            }

            if (settlement?.finalAmountWei) {
                response.setHeader("x-compose-key-final-amount-wei", settlement.finalAmountWei);
            }

            if (settlement?.txHash) {
                response.setHeader("X-Transaction-Hash", settlement.txHash);
                response.setHeader("x-compose-key-tx-hash", settlement.txHash);
            }
        },
    };
}

export interface InferenceSettlementReceipt {
    finalAmountWei: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    meterSubject?: string;
    lineItems?: Array<{
        key: string;
        unit: string;
        quantity: number;
        unitPriceUsd: number;
        amountWei: string;
    }>;
    txHash?: string;
    chainId?: number;
    settledAt: number;
}

export async function settlePreparedInferencePayment(
    payment: PreparedInferencePayment,
    res: Response,
    settlementInput: InferenceSettlementInput = {
        finalAmountWei: payment.maxAmountWei,
    },
): Promise<InferenceSettlementReceipt | null> {
    const settlement = await payment.settle(settlementInput);
    if (!settlement.success) {
        const error = new Error(settlement.error || "Payment settlement failed") as Error & {
            statusCode?: number;
            paymentRequired?: PaymentRequired;
            paymentRequiredHeader?: string | null;
        };
        if (settlement.statusCode) {
            error.statusCode = settlement.statusCode;
        }
        if (settlement.paymentRequired) {
            error.paymentRequired = settlement.paymentRequired;
        }
        if (settlement.paymentRequiredHeader) {
            error.paymentRequiredHeader = settlement.paymentRequiredHeader;
        }
        throw error;
    }

    payment.applyHeaders(res, settlement);

    if (!settlement.finalAmountWei) {
        return null;
    }

    return {
        finalAmountWei: settlement.finalAmountWei,
        providerAmountWei: settlement.providerAmountWei,
        platformFeeWei: settlement.platformFeeWei,
        meterSubject: settlement.meterSubject,
        lineItems: settlement.lineItems,
        txHash: settlement.txHash,
        chainId: settlement.chainId,
        settledAt: settlement.settledAt ?? Date.now(),
    };
}

/**
 * Prepare payment without charging immediately.
 * Use settle() when first output is emitted, and abort() on failures before settlement.
 */
export async function prepareDeferredPayment(
    req: Request,
    amountWei: number,
): Promise<PreparedPayment> {
    const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
    const explicitChainId = chainIdHeader ? parseInt(String(chainIdHeader), 10) : getActiveChainId();
    const {
        paymentData,
        composeKeyToken,
        composeKeyValidation,
        sessionActive,
        sessionUserAddress,
        sessionInvalidReason,
    } = await resolveComposeSessionContext(
        req.headers as Record<string, string | string[] | undefined>,
        explicitChainId,
    );

    // Check for internal Workflow bypass first
    const internalMarker = req.headers["x-workflow-internal"] as string | undefined;
    const runtimeInternalMarker = getRuntimeInternalMarker();
    if (internalMarker && runtimeInternalMarker && internalMarker === runtimeInternalMarker) {
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
    if (sessionActive && sessionUserAddress) {
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

        return {
            valid: false,
            error: lockResult.error || "Session budget exhausted",
            method: "session",
            metadata: { amountWei, chainId: explicitChainId, userAddress: sessionUserAddress },
            settle: async () => ({
                success: false,
                error: lockResult.error || "Session budget exhausted",
            }),
            abort: async () => { },
            getHeaders: () => ({ "x-compose-session-invalid": "budget_exhausted" }),
        };
    }

    if (composeKeyValidation?.record?.purpose === "session") {
        const reason = sessionInvalidReason || "invalid_key";
        return {
            valid: false,
            error: "The compose-key session is inactive or expired.",
            method: "session",
            metadata: { amountWei, chainId: explicitChainId, userAddress: sessionUserAddress || undefined },
            settle: async () => ({ success: false, error: "Inactive session" }),
            abort: async () => { },
            getHeaders: () => ({ "x-compose-session-invalid": reason }),
        };
    }

    // ==========================================================================
    // Compose Key flow
    // ==========================================================================
    if (composeKeyToken) {
        console.log(`[x402] preparePayment: Compose Key detected, validating...`);

        const validation = composeKeyValidation;

        if (!validation || !validation.valid || !validation.payload || !validation.record) {
            console.log(`[x402] preparePayment: Compose Key invalid: ${validation?.error}`);
            const reason = getComposeSessionInvalidReason(validation?.error);
            return {
                valid: false,
                error: validation?.error,
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
                    // The facilitator returns the settled transaction on the receipt.
                    // Keep a shallow fallback in case callers flatten it upstream.
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
 * - Session validity comes from the compose key plus Redis-backed session state
 * - Can't be abused: no active server-side session = no bypass
 * 
 * @param req - Express request
 * @param res - Express response
 * @param amountWei - Price in USDC wei (6 decimals)
 * @returns true if payment verified, false if 402 response sent
 */
export async function requirePayment(
    req: Request,
    res: Response,
    amountWei: number,
): Promise<boolean> {
    const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
    const explicitChainId = chainIdHeader ? parseInt(String(chainIdHeader)) : getActiveChainId();
    const {
        paymentData,
        composeKeyToken,
        composeKeyValidation,
        sessionActive,
        sessionBudgetRemaining,
        sessionUserAddress,
        sessionInvalidReason,
    } = await resolveComposeSessionContext(
        req.headers as Record<string, string | string[] | undefined>,
        explicitChainId,
    );

    // DEBUG: Log incoming headers for bypass check
    const internalMarker = req.headers["x-workflow-internal"] as string | undefined;
    const runtimeInternalMarker = getRuntimeInternalMarker();
    const userAgent = req.headers["user-agent"] as string || "";
    console.log(`[x402-debug] Internal marker: ${internalMarker ? 'PRESENT' : 'MISSING'}, value: ${internalMarker?.substring(0, 20) || 'N/A'}`);
    console.log(`[x402-debug] Expected marker: ${runtimeInternalMarker?.substring(0, 20) || 'UNSET'}`);
    console.log(`[x402-debug] User-Agent: ${userAgent.substring(0, 50)}`);
    console.log(`[x402-debug] sec-fetch-mode: ${req.headers["sec-fetch-mode"] || 'N/A'}`);
    console.log(`[x402-debug] Session: active=${sessionActive}, budget=${sessionBudgetRemaining}`);

    // @dev: Security Note:
    // If internal marker matches, allow the request
    // The marker is the proof of payment because:
    // 1. Workflow only adds x-workflow-internal AFTER verifying x402 payment at /agent/{wallet}/chat|image|video|audio|...
    // 2. The secret is stored in RUNTIME_INTERNAL_SECRET .env
    // 3. If someone knows the secret, they're either Workflow or have access to our infrastructure

    if (internalMarker && runtimeInternalMarker && internalMarker === runtimeInternalMarker) {
        console.log(`[x402] Internal bypass - Workflow verified payment upstream, session=${sessionActive}`);
        return true;
    }

    // ==========================================================================
    // TIER 1: Session Budget Bypass - Deferred Settlement
    // Lock budget in Redis, skip on-chain settlement (batch settles every 2 min)
    // ==========================================================================
    if (sessionActive && sessionUserAddress && composeKeyValidation?.record?.purpose === "session") {
        console.log(`[x402] Session bypass attempt: ${sessionUserAddress}, chain=${explicitChainId}, amount=${amountWei}`);

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
                res.setHeader("x-session-budget-locked", sessionStatus.lockedBudget);
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
        }

        console.log(`[x402] Session bypass FAILED: ${lockResult.error}`);
        setComposeSessionInvalidHeader(res, "budget_exhausted");
        res.status(402).json({
            error: "Compose session budget exhausted",
            details: lockResult.error || "Insufficient available session budget",
        });
        return false;
    }

    if (composeKeyValidation?.record?.purpose === "session") {
        const reason = sessionInvalidReason || "invalid_key";
        setComposeSessionInvalidHeader(res, reason);
        res.status(401).json({
            error: "Inactive Compose session",
            details: "The compose-key session is inactive or expired.",
        });
        return false;
    }

    // ==========================================================================
    // Compose Key Flow (external clients like Cursor, OpenClaw, OpenCode, ...)
    // Performs ACTUAL on-chain USDC settlement using session key authority
    // ==========================================================================
    if (composeKeyToken) {
        console.log(`[x402] Compose Key detected, validating...`);

        const validation = composeKeyValidation;

        if (!validation || !validation.valid || !validation.payload || !validation.record) {
            console.log(`[x402] Compose Key invalid: ${validation?.error}`);
            setComposeSessionInvalidHeader(res, getComposeSessionInvalidReason(validation?.error));
            res.status(401).json({
                error: "Invalid Compose Key",
                details: validation?.error,
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
