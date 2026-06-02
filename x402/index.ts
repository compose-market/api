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
    getActiveSessionStatus,
} from "./keys/index.js";

// Compose Session Budget (locked/used tracking for settlement)
import {
    lockBudget,
} from "./session-budget.js";
import {
    quoteMeteredAuthorization,
    quoteMeteredSettlement,
    type MeteredAuthorizationInput,
    type MeteredSettlementInput,
} from "./metering.js";
import {
    readRawEnvelope,
    releaseRawEnvelope,
    reserveRawEnvelope,
    saveRawEnvelope,
} from "./envelope.js";
import {
    commitBatchCharge,
    getBatchPayload,
    isBatchSettlementScheme,
    queuedBatchSettlement,
    rememberBatchChannel,
} from "./batch.js";
import {
    abortPaymentIntent,
    authorizePaymentIntent,
    settlePaymentIntent,
} from "./intents.js";
import {
    redisDel,
    redisGet,
    redisSetNXEX,
} from "./keys/redis.js";

// Re-export types
export type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";

type SettlementCycleResult = {
    reason: string;
    skipped?: boolean;
    native: Awaited<ReturnType<typeof import("./channels.js").runNativeBatchSettlement>> | null;
    intents: Awaited<ReturnType<typeof import("./accumulator/index.js").runBatchSettlement>> | null;
};

const SETTLEMENT_RUN_LOCK_KEY = "x402:settlement:run-lock";
const SETTLEMENT_KICK_LOCK_KEY = "x402:settlement:kick-lock";

let activeSettlementCycle: Promise<SettlementCycleResult> | null = null;

function positiveAmount(value: string | undefined): boolean {
    return Boolean(value && /^\d+$/u.test(value) && BigInt(value) > 0n);
}

function intEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldKickSettlement(settlement: {
    finalAmountWei?: string;
    settlementStatus?: "queued" | "claimed" | "settled" | "failed";
    txHash?: string;
    paymentIntentId?: string;
    sessionBudgetIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
} | null | undefined): boolean {
    if (!settlement || !positiveAmount(settlement.finalAmountWei)) return false;
    if (settlement.settlementStatus !== "queued" && settlement.settlementStatus !== "claimed") return false;
    return Boolean(
        settlement.txHash
        || settlement.paymentIntentId
        || settlement.sessionBudgetIntentId
        || (settlement.paymentChannelId && settlement.paymentCumulativeAmountWei)
    );
}

export async function runBatchSettlementCycle(reason = "manual"): Promise<SettlementCycleResult> {
    if (activeSettlementCycle) return activeSettlementCycle;

    activeSettlementCycle = (async () => {
        const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const locked = await redisSetNXEX(SETTLEMENT_RUN_LOCK_KEY, owner, intEnv("SETTLEMENT_RUN_LOCK_SECONDS", 600));
        if (!locked) {
            console.log("[batch-settlement] skipped; another settlement cycle is active", { reason });
            return {
                reason,
                skipped: true,
                native: null,
                intents: null,
            };
        }

        try {
            console.log("[batch-settlement] cycle started", { reason });
            const [{ runNativeBatchSettlement }, { runBatchSettlement }] = await Promise.all([
                import("./channels.js"),
                import("./accumulator/index.js"),
            ]);
            const native = await runNativeBatchSettlement();
            const intents = await runBatchSettlement();
            console.log("[batch-settlement] cycle completed", {
                reason,
                nativeRunId: native.runId,
                intentRunId: intents.runId,
            });
            return { reason, native, intents };
        } finally {
            const current = await redisGet(SETTLEMENT_RUN_LOCK_KEY).catch(() => null);
            if (current === owner) {
                await redisDel(SETTLEMENT_RUN_LOCK_KEY).catch(() => false);
            }
            activeSettlementCycle = null;
        }
    })();

    return activeSettlementCycle;
}

export async function kickBatchSettlement(
    settlement: {
        finalAmountWei?: string;
        settlementStatus?: "queued" | "claimed" | "settled" | "failed";
        txHash?: string;
        paymentIntentId?: string;
        sessionBudgetIntentId?: string;
        paymentChannelId?: string;
        paymentCumulativeAmountWei?: string;
    } | null | undefined,
    reason = "terminal",
): Promise<void> {
    if (!shouldKickSettlement(settlement)) return;

    try {
        const run = async (attemptReason: string): Promise<void> => {
            const attempts = intEnv("SETTLEMENT_KICK_RETRY_ATTEMPTS", 6);
            const delayMs = intEnv("SETTLEMENT_KICK_RETRY_MS", 2500);
            let followUp = true;

            for (let attempt = 0; attempt < attempts; attempt += 1) {
                const joined = Boolean(activeSettlementCycle);
                const nextReason = attempt === 0 ? attemptReason : `${attemptReason}:retry:${attempt}`;
                const result = await runBatchSettlementCycle(nextReason);
                if (!result.skipped && !joined && !followUp) {
                    return;
                }
                followUp = false;
                await delay(delayMs);
            }

            console.warn("[batch-settlement] terminal kick exhausted retries", {
                reason: attemptReason,
                attempts,
            });
        };

        const locked = await redisSetNXEX(
            SETTLEMENT_KICK_LOCK_KEY,
            `${reason}:${Date.now()}`,
            intEnv("SETTLEMENT_KICK_DEDUPE_SECONDS", 2),
        );
        if (!locked) {
            void (async () => {
                await delay(intEnv("SETTLEMENT_KICK_RETRY_MS", 2500));
                await run(`${reason}:deduped`);
            })().catch((error) => {
                console.error("[batch-settlement] deduped terminal kick failed", {
                    reason,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
            return;
        }

        void (async () => {
            await run(reason);
        })().catch((error) => {
            console.error("[batch-settlement] local terminal kick failed", {
                reason,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    } catch (error) {
        console.error("[batch-settlement] terminal kick failed", {
            reason,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function setComposeSessionInvalidHeader(
    target: Pick<Response, "setHeader"> | Record<string, string>,
    reason: string,
): void {
    if (typeof (target as { setHeader?: unknown }).setHeader === "function") {
        (target as Pick<Response, "setHeader">).setHeader("x-session-invalid", reason);
        return;
    }

    (target as Record<string, string>)["x-session-invalid"] = reason;
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

type ComposePaymentScheme = "exact" | "upto" | "batch-settlement";

export type InferenceAuthorizationInput =
    | { useBudgetCap: true; scheme?: ComposePaymentScheme }
    | { maxAmountWei: string }
    | { meter: MeteredAuthorizationInput };

export type InferenceSettlementInput =
    | {
        finalAmountWei: string;
        providerAmountWei?: string;
        platformFeeWei?: string;
        meterSubject?: string;
        lineItems?: InferencePaymentSettlementResult["lineItems"];
    }
    | { meter: MeteredSettlementInput };

interface InferencePaymentSettlementResult {
    success: boolean;
    txHash?: string;
    settlementStatus?: "queued" | "claimed" | "settled" | "failed";
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    sessionBudgetIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
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
    evidenceOnly?: boolean;
    error?: string;
    statusCode?: number;
    paymentRequired?: PaymentRequired;
    paymentRequiredHeader?: string | null;
}

export interface PreparedInferencePayment {
    maxAmountWei: string;
    runtimeHeaders: Record<string, string>;
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

function getComposeRunIdFromRequest(req: Request): string | null {
    const value = req.get?.("x-run-id")
        || req.get?.("X-Run-Id")
        || req.headers["x-run-id"]
        || req.headers["X-Run-Id"];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getIdempotencyKeyFromRequest(req: Request): string | undefined {
    const value = req.get?.("x-idempotency-key")
        || req.get?.("X-Idempotency-Key")
        || req.headers["x-idempotency-key"]
        || req.headers["X-Idempotency-Key"];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rawRuntimeHeaders(chainId: number, maxAmountWei: string): Record<string, string> {
    return {
        "x-session-active": "false",
        "x-session-budget-remaining": maxAmountWei,
        "x-chain-id": String(chainId),
        "x-x402-max-amount-wei": maxAmountWei,
    };
}

function composeRuntimeHeaders(input: {
    authorization: string;
    chainId: number;
    userAddress: string;
    maxAmountWei: string;
    sessionActive: boolean;
    paymentIntentId?: string | null;
    idempotencyKey?: string;
}): Record<string, string> {
    return {
        Authorization: input.authorization,
        "x-session-active": input.sessionActive ? "true" : "false",
        "x-session-user-address": input.userAddress.toLowerCase(),
        "x-session-budget-remaining": input.maxAmountWei,
        "x-chain-id": String(input.chainId),
        "x-x402-max-amount-wei": input.maxAmountWei,
        ...(input.paymentIntentId ? { "x-payment-intent-id": input.paymentIntentId } : {}),
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
    };
}

function publicResourceUrl(req: Request): string {
    return `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
}

function resolveInferenceSettlement(
    settlementInput: InferenceSettlementInput,
): {
    finalAmountWei: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    meterSubject?: string;
    lineItems?: InferencePaymentSettlementResult["lineItems"];
} {
    if ("meter" in settlementInput) {
        const metering = quoteMeteredSettlement(settlementInput.meter);
        return {
            finalAmountWei: metering.finalAmountWei,
            providerAmountWei: metering.providerAmountWei,
            platformFeeWei: metering.platformFeeWei,
            meterSubject: metering.subject,
            lineItems: metering.lineItems,
        };
    }

    return {
        finalAmountWei: settlementInput.finalAmountWei,
        providerAmountWei: settlementInput.providerAmountWei,
        platformFeeWei: settlementInput.platformFeeWei,
        meterSubject: settlementInput.meterSubject,
        lineItems: settlementInput.lineItems,
    };
}

/**
 * Default per-request envelope (atomic units) when a client dials a usage-priced
 * x402 inference endpoint without sending an explicit `x-x402-max-amount-wei`.
 *
 * x402 v2 `upto` semantics: this is the MAX the client authorizes via Permit2
 * for one request. Authoritative metering inside the server determines the
 * ACTUAL settled amount (which is `<=` this envelope).
 *
 * The client's wallet allowance to the Permit2 facilitator is the real safety
 * cap; this default just lets `accepts.amount` be a finite number in the 402
 * challenge so the negotiation handshake can fire without an upfront client
 * quote. Tune via `INFERENCE_DEFAULT_UPTO_ENVELOPE_WEI`.
 *
 * Default: 1 USDC (10^6 atomic units on USDC's 6-decimal layout). Generous for
 * a single chat turn including a multi-tool loop, while still bounding the
 * blast radius of a misbehaving server.
 */
function getDefaultUptoEnvelopeWei(): string {
    const raw = process.env.INFERENCE_DEFAULT_UPTO_ENVELOPE_WEI?.trim();
    if (raw && /^\d+$/u.test(raw) && BigInt(raw) > 0n) {
        return raw;
    }
    return "1000000";
}

function resolveInferenceAuthorizationRequirement(
    req: Request,
    authorizationInput: InferenceAuthorizationInput,
): { scheme: ComposePaymentScheme; maxAmountWei: string } {
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

    // Pure pay-per-usage path. The client may dial blind: no Compose Key,
    // no `x-x402-max-amount-wei`, no payment-intent. The x402 v2 spec
    // requires the server to advertise a finite `accepts.amount` in the 402
    // challenge so the client can sign Permit2 and retry. We default to a
    // conservative envelope; authoritative metering during inference
    // determines the actual settled amount, which is always `<=` the
    // envelope. This is the standard `upto` shape — never 400 for a missing
    // upfront cap.
    const explicitMaxAmountWei = getRawInferenceMaxAmount(req);
    return {
        scheme: "scheme" in authorizationInput && authorizationInput.scheme
            ? authorizationInput.scheme
            : "upto",
        maxAmountWei: explicitMaxAmountWei || getDefaultUptoEnvelopeWei(),
    };
}

async function prepareRawInferenceX402Payment(
    req: Request,
    res: Response,
    authorizationInput: InferenceAuthorizationInput,
): Promise<PreparedInferencePayment | null> {
    const requirement = resolveInferenceAuthorizationRequirement(req, authorizationInput);
    const fallbackChainId = getChainIdFromRequest(req) ?? getActiveChainId();
    const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
    const composeRunId = getComposeRunIdFromRequest(req);

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
        const inheritedExecutionId = req.get?.("x-execution-run-id")
            || req.headers["x-execution-run-id"]
            || req.get?.("x-parent-run-id")
            || req.headers["x-parent-run-id"];
        if (composeRunId && inheritedExecutionId) {
            const inherited = await readRawEnvelope(composeRunId);
            if (inherited) {
                return {
                    maxAmountWei: inherited.maxAmountWei,
                    runtimeHeaders: rawRuntimeHeaders(inherited.chainId, inherited.maxAmountWei),
                    settle: async (settlementInput) => {
                        let metering: ReturnType<typeof quoteMeteredSettlement> | undefined;
                        let finalAmountWei: string;
                        let providerAmountWei: string | undefined;
                        let platformFeeWei: string | undefined;
                        let meterSubject: string | undefined;
                        let lineItems: InferencePaymentSettlementResult["lineItems"] | undefined;
                        if ("meter" in settlementInput) {
                            metering = quoteMeteredSettlement(settlementInput.meter);
                            finalAmountWei = metering.finalAmountWei;
                            providerAmountWei = metering.providerAmountWei;
                            platformFeeWei = metering.platformFeeWei;
                            meterSubject = metering.subject;
                            lineItems = metering.lineItems;
                        } else {
                            finalAmountWei = settlementInput.finalAmountWei;
                            providerAmountWei = settlementInput.providerAmountWei;
                            platformFeeWei = settlementInput.platformFeeWei;
                            meterSubject = settlementInput.meterSubject;
                            lineItems = settlementInput.lineItems;
                        }

                        if (BigInt(finalAmountWei) > BigInt(inherited.maxAmountWei)) {
                            return {
                                success: false,
                                error: "finalAmountWei cannot exceed the inherited x402 authorized maximum",
                                statusCode: 402,
                            };
                        }

                        await reserveRawEnvelope(composeRunId, finalAmountWei);
                        if (isBatchSettlementScheme(inherited.paymentPayload.accepted.scheme)) {
                            try {
                                const batch = await commitBatchCharge(inherited.paymentPayload, finalAmountWei);
                                return {
                                    success: true,
                                    finalAmountWei,
                                    providerAmountWei,
                                    platformFeeWei,
                                    meterSubject,
                                    lineItems,
                                    chainId: inherited.chainId,
                                    settledAt: Date.now(),
                                    settlementStatus: "queued",
                                    paymentChannelId: batch.channelId,
                                    paymentCumulativeAmountWei: batch.cumulativeAmountWei,
                                };
                            } catch (error) {
                                await releaseRawEnvelope(composeRunId, finalAmountWei);
                                return {
                                    success: false,
                                    error: error instanceof Error ? error.message : "Batch settlement commit failed",
                                    statusCode: 402,
                                };
                            }
                        }
                        const settled = await settleComposePayment(
                            inherited.paymentPayload,
                            createComposePaymentRequirement({
                                amountWei: finalAmountWei,
                                chainId: inherited.chainId,
                                scheme: inherited.paymentPayload.accepted.scheme === "upto" ? "upto" : "exact",
                            }),
                        );
                        if (!settled.success) {
                            await releaseRawEnvelope(composeRunId, finalAmountWei);
                            return {
                                success: false,
                                error: settled.errorMessage || settled.errorReason || "Payment settlement failed",
                                statusCode: 402,
                            };
                        }
                        return {
                            success: true,
                            txHash: settled.transaction || undefined,
                            finalAmountWei,
                            providerAmountWei,
                            platformFeeWei,
                            meterSubject,
                            lineItems,
                            chainId: inherited.chainId,
                            settledAt: Date.now(),
                            settlementStatus: settled.transaction ? "settled" : "queued",
                        };
                    },
                    abort: async () => undefined,
                    applyHeaders: () => undefined,
                };
            }
        }
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
    if (isBatchSettlementScheme(paymentPayload.accepted.scheme)) {
        await rememberBatchChannel(paymentPayload, verificationRequirement, verifyResult);
    }

    if (composeRunId) {
        await saveRawEnvelope({
            rootRunId: composeRunId,
            maxAmountWei: requirement.maxAmountWei,
            chainId: paymentChainId,
            paymentPayload,
        });
    }

    let currentHeaders: Record<string, string> = {};

    return {
        maxAmountWei: requirement.maxAmountWei,
        runtimeHeaders: rawRuntimeHeaders(paymentChainId, requirement.maxAmountWei),
        settle: async (settlementInput) => {
            let metering: ReturnType<typeof quoteMeteredSettlement> | undefined;
            let finalAmountWei: string;
            let providerAmountWei: string | undefined;
            let platformFeeWei: string | undefined;
            let meterSubject: string | undefined;
            let lineItems: InferencePaymentSettlementResult["lineItems"] | undefined;
            if ("meter" in settlementInput) {
                metering = quoteMeteredSettlement(settlementInput.meter);
                providerAmountWei = metering.providerAmountWei;
                platformFeeWei = metering.platformFeeWei;
                meterSubject = metering.subject;
                lineItems = metering.lineItems;
            }
            if (requirement.scheme === "exact") {
                finalAmountWei = requirement.maxAmountWei;
            } else if ("finalAmountWei" in settlementInput) {
                finalAmountWei = settlementInput.finalAmountWei;
                providerAmountWei = settlementInput.providerAmountWei;
                platformFeeWei = settlementInput.platformFeeWei;
                meterSubject = settlementInput.meterSubject;
                lineItems = settlementInput.lineItems;
            } else {
                metering ??= quoteMeteredSettlement(settlementInput.meter);
                finalAmountWei = metering.finalAmountWei;
                providerAmountWei = metering.providerAmountWei;
                platformFeeWei = metering.platformFeeWei;
                meterSubject = metering.subject;
                lineItems = metering.lineItems;
            }

            if (requirement.scheme === "upto" && BigInt(finalAmountWei) > BigInt(requirement.maxAmountWei)) {
                return {
                    success: false,
                    error: "finalAmountWei cannot exceed the x402 authorized maximum",
                };
            }

            if (BigInt(finalAmountWei) === 0n) {
                return {
                    success: true,
                    finalAmountWei,
                    providerAmountWei,
                    platformFeeWei,
                    meterSubject,
                    lineItems,
                    chainId: paymentChainId,
                    settledAt: Date.now(),
                };
            }

            if (composeRunId) {
                try {
                    await reserveRawEnvelope(composeRunId, finalAmountWei);
                } catch (error) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : "Payment envelope budget exhausted",
                        statusCode: 402,
                    };
                }
            }

            const settlementRequirement = createComposePaymentRequirement({
                amountWei: finalAmountWei,
                chainId: paymentChainId,
                scheme: requirement.scheme,
            });
            let settled;
            let batch;
            if (isBatchSettlementScheme(paymentPayload.accepted.scheme) && getBatchPayload(paymentPayload)?.type === "voucher") {
                try {
                    batch = await commitBatchCharge(paymentPayload, finalAmountWei, settlementRequirement);
                    settled = queuedBatchSettlement(finalAmountWei, settlementRequirement.network);
                } catch (error) {
                    if (composeRunId) {
                        await releaseRawEnvelope(composeRunId, finalAmountWei);
                    }
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : "Batch settlement commit failed",
                    };
                }
            } else {
                settled = await settleComposePayment(
                    paymentPayload,
                    settlementRequirement,
                );
                if (isBatchSettlementScheme(paymentPayload.accepted.scheme) && settled.success) {
                    batch = await commitBatchCharge(paymentPayload, finalAmountWei, settlementRequirement);
                }
            }

            currentHeaders = {
                "PAYMENT-RESPONSE": encodeComposePaymentResponseHeader(settled),
            };
            if (settled.transaction) {
                currentHeaders["X-Transaction-Hash"] = settled.transaction;
            }

            if (!settled.success) {
                if (composeRunId) {
                    await releaseRawEnvelope(composeRunId, finalAmountWei);
                }
                return {
                    success: false,
                    error: settled.errorMessage || settled.errorReason || "Payment settlement failed",
                };
            }

            return {
                success: true,
                txHash: settled.transaction || undefined,
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
                chainId: paymentChainId,
                settledAt: Date.now(),
                settlementStatus: isBatchSettlementScheme(paymentPayload.accepted.scheme)
                    ? "queued"
                    : (settled.transaction ? "settled" : "queued"),
                paymentChannelId: batch?.channelId,
                paymentCumulativeAmountWei: batch?.cumulativeAmountWei,
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
    const composeKeyToken = extractComposeKeyFromHeader(authorization);
    if (!composeKeyToken) {
        return prepareRawInferenceX402Payment(req, res, authorizationInput);
    }

    const validation = await validateComposeKey(composeKeyToken, 0);
    if (!validation.valid || !validation.payload || !validation.record) {
        setComposeSessionInvalidHeader(res, getComposeSessionInvalidReason(validation.error));
        res.status(401).json({ error: validation.error || "Invalid Compose key" });
        return null;
    }

    const chainId = getChainIdFromRequest(req) ?? validation.record.chainId ?? getActiveChainId();
    if (validation.record.chainId && validation.record.chainId !== chainId) {
        setComposeSessionInvalidHeader(res, "invalid_key");
        res.status(409).json({ error: "Compose key chainId does not match request chainId" });
        return null;
    }

    const userAddress = validation.payload.sub;
    const keyId = validation.payload.keyId;
    const purpose = validation.record.purpose;
    let sessionMaxAmountWei: string | null = null;

    if (purpose === "session") {
        const sessionStatus = await getActiveSessionStatus(userAddress, chainId);
        const session = sessionStatus.session;
        if (!session || session.keyId !== keyId) {
            setComposeSessionInvalidHeader(res, session ? "invalid_key" : sessionStatus.reason);
            res.status(401).json({ error: "The compose-key session is inactive or expired." });
            return null;
        }
        sessionMaxAmountWei = String(Math.max(0, session.budgetRemaining));
    }

    let currentHeaders: Record<string, string> = {};
    let paymentIntentId: string | null = null;
    let maxAmountWei = sessionMaxAmountWei || "0";
    const idempotencyKey = getIdempotencyKeyFromRequest(req);
    let paymentSettled = false;

    if (purpose !== "session") {
        const authorizationResult = await authorizePaymentIntent({
            authorization,
            chainId,
            service: "api",
            action: "inference",
            resource: publicResourceUrl(req),
            method: req.method || "POST",
            useBudgetCap: true,
            composeRunId: getComposeRunIdFromRequest(req) || undefined,
            idempotencyKey,
        });

        currentHeaders = {
            ...authorizationResult.headers,
        };

        if (!authorizationResult.ok) {
            for (const [key, value] of Object.entries(authorizationResult.headers)) {
                res.setHeader(key, value);
            }
            setComposeSessionInvalidHeader(res, getComposeSessionInvalidReason(String(authorizationResult.body.error || authorizationResult.status)));
            res.status(authorizationResult.status).json(authorizationResult.body);
            return null;
        }

        paymentIntentId = authorizationResult.body.paymentIntentId;
        maxAmountWei = authorizationResult.body.maxAmountWei;
    }

    const runtimeHeaders = composeRuntimeHeaders({
        authorization,
        chainId,
        userAddress,
        maxAmountWei,
        sessionActive: purpose === "session",
        paymentIntentId,
        idempotencyKey,
    });

    return {
        maxAmountWei,
        runtimeHeaders,
        settle: async (settlementInput) => {
            const {
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
            } = resolveInferenceSettlement(settlementInput);

            if (!/^\d+$/u.test(finalAmountWei)) {
                return {
                    success: false,
                    error: "Invalid settlement amount",
                    statusCode: 400,
                };
            }
            const finalAmount = BigInt(finalAmountWei);

            if (finalAmount === 0n) {
                if (paymentIntentId && !paymentSettled) {
                    await abortPaymentIntent({
                        paymentIntentId,
                        reason: "zero_amount_settlement",
                    });
                }
                return {
                    success: true,
                    finalAmountWei,
                    providerAmountWei,
                    platformFeeWei,
                    meterSubject,
                    lineItems,
                    chainId,
                    settledAt: Date.now(),
                    settlementStatus: "queued",
                    ...(paymentIntentId ? { paymentIntentId } : {}),
                };
            }

            if (purpose === "session") {
                const requestId = typeof req.headers["x-run-id"] === "string"
                    ? req.headers["x-run-id"]
                    : `inference-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                const lock = await lockBudget(
                    userAddress,
                    chainId,
                    finalAmountWei,
                    merchantWalletAddress,
                    requestId,
                    meterSubject || (typeof req.body?.model === "string" ? req.body.model : undefined),
                );

                if (!lock.success || !lock.intentId) {
                    setComposeSessionInvalidHeader(currentHeaders, "budget_exhausted");
                    return {
                        success: false,
                        error: lock.error || "Session budget exhausted",
                        statusCode: 402,
                    };
                }

                currentHeaders = {
                    "x-payment-method": "session",
                    "x-settlement": "queued",
                    "x-payment-intent-id": lock.intentId,
                    "x-session-budget-intent-id": lock.intentId,
                    "x-key-final-amount-wei": finalAmountWei,
                    "x-budget-remaining": lock.availableWei,
                };
                return {
                    success: true,
                    finalAmountWei,
                    providerAmountWei,
                    platformFeeWei,
                    meterSubject,
                    lineItems,
                    chainId,
                    settledAt: Date.now(),
                    settlementStatus: "queued",
                    sessionBudgetIntentId: lock.intentId,
                };
            }

            if (!paymentIntentId) {
                return {
                    success: false,
                    error: "Payment intent is required for non-session Compose key settlement",
                    statusCode: 402,
                };
            }

            const intentSettlement = await settlePaymentIntent({
                paymentIntentId,
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
            });

            currentHeaders = {
                ...currentHeaders,
                ...intentSettlement.headers,
                "x-payment-intent-id": paymentIntentId,
            };

            if (!intentSettlement.ok) {
                return {
                    success: false,
                    error: typeof intentSettlement.body.error === "string"
                        ? intentSettlement.body.error
                        : "Payment settlement failed",
                    statusCode: intentSettlement.status,
                    paymentRequired: intentSettlement.status === 402
                        ? intentSettlement.body as unknown as PaymentRequired
                        : undefined,
                    paymentRequiredHeader: intentSettlement.headers["PAYMENT-REQUIRED"]
                        || intentSettlement.headers["payment-required"]
                        || null,
                };
            }

            paymentSettled = true;
            const txHash = intentSettlement.body.txHash;
            return {
                success: true,
                txHash,
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
                chainId,
                settledAt: Date.now(),
                settlementStatus: txHash ? "settled" : "queued",
                paymentIntentId,
            };
        },
        abort: async (reason?: string) => {
            if (paymentIntentId && !paymentSettled) {
                await abortPaymentIntent({
                    paymentIntentId,
                    reason: reason || "Inference failed before settlement",
                });
            }
        },
        applyHeaders: (response, settlement) => {
            if (response.headersSent) {
                return;
            }

            for (const [key, value] of Object.entries(currentHeaders)) {
                response.setHeader(key, value);
            }

            if (settlement?.finalAmountWei) {
                response.setHeader("x-key-final-amount-wei", settlement.finalAmountWei);
            }

            if (settlement?.txHash) {
                response.setHeader("X-Transaction-Hash", settlement.txHash);
                response.setHeader("x-key-tx-hash", settlement.txHash);
            }
            if (settlement?.settlementStatus) {
                response.setHeader("x-settlement", settlement.settlementStatus);
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
    settlementStatus?: "queued" | "claimed" | "settled" | "failed";
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    sessionBudgetIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
    chainId?: number;
    settledAt: number;
    evidenceOnly?: boolean;
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
        settlementStatus: settlement.settlementStatus || (settlement.txHash ? "settled" : "queued"),
        claimTxHash: settlement.claimTxHash,
        settleTxHash: settlement.settleTxHash,
        paymentIntentId: settlement.paymentIntentId,
        sessionBudgetIntentId: settlement.sessionBudgetIntentId,
        paymentChannelId: settlement.paymentChannelId,
        paymentCumulativeAmountWei: settlement.paymentCumulativeAmountWei,
        chainId: settlement.chainId,
        settledAt: settlement.settledAt ?? Date.now(),
        evidenceOnly: settlement.evidenceOnly,
    };
}

// Re-export config for convenience
export {
    paymentChain,
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
};
