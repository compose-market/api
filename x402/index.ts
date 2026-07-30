/**
 * x402 Payment Module
 *
 * Single entry point for all x402 payment operations.
 * Handles payment verification, settlement, and Compose-specific extensions.
 */

import type { Request, Response } from "express";
import type { PaymentRequired } from "@x402/core/types";
import { publicResourceUrl } from "../http/public-origin.js";
import {
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
} from "./wallets.js";
import { getDefaultNetwork, isNetworkId, type NetworkId } from "./configs/chains.js";
import {
    createPaymentRequired,
    createPaymentRequirement,
    decodePaymentSignatureHeader,
    encodePaymentRequiredHeader,
    encodePaymentResponseHeader,
    getNetworkFromPaymentPayload,
    settlePayment,
    verifyPayment,
} from "./facilitator.js";

// Compose Keys integration (session record for UI/token)
import {
    extractKeyFromHeader,
    validateKey,
    getActiveSessionStatus,
} from "./keys/index.js";

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
    valkeyDel,
    valkeyGet,
    valkeySetNXEX,
} from "./keys/valkey.js";

// Re-export types
export type { X402SettlementResult, PaymentInfo, X402PaymentMethod, SkillPricing } from "./types.js";

type SettlementCycleResult = {
    reason: string;
    skipped?: boolean;
    native: Awaited<ReturnType<typeof import("./channels.js").runNativeBatchSettlement>> | null;
    svm: Awaited<ReturnType<typeof import("./batch.js").runSvmBatchSettlement>> | null;
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

async function runSettlementCycleStep<T>(
    label: "native" | "svm" | "intents",
    reason: string,
    fn: () => Promise<T>,
): Promise<{ succeeded: true; value: T } | { succeeded: false; value: null }> {
    try {
        return {
            succeeded: true,
            value: await fn(),
        };
    } catch (error) {
        console.error(`[batch-settlement] ${label} settlement cycle failed`, {
            reason,
            error: error instanceof Error ? error.message : String(error),
        });
        return {
            succeeded: false,
            value: null,
        };
    }
}

function settlementCycleStepValue<T>(
    step: PromiseSettledResult<T>,
): T | { succeeded: false; value: null } {
    if ("value" in step) return step.value;
    return { succeeded: false, value: null };
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
        || settlement.sessionBudgetIntentId
        || (settlement.paymentChannelId && settlement.paymentCumulativeAmountWei)
    );
}

export async function runBatchSettlementCycle(reason = "manual"): Promise<SettlementCycleResult> {
    if (activeSettlementCycle) return activeSettlementCycle;

    activeSettlementCycle = (async () => {
        const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let locked = false;
        try {
            locked = await valkeySetNXEX(SETTLEMENT_RUN_LOCK_KEY, owner, intEnv("SETTLEMENT_RUN_LOCK_SECONDS", 600));
            if (!locked) {
                console.log("[batch-settlement] skipped; another settlement cycle is active", { reason });
                return {
                    reason,
                    skipped: true,
                    native: null,
                    svm: null,
                    intents: null,
                };
            }

            console.log("[batch-settlement] cycle started", { reason });
            const [{ runNativeBatchSettlement }, { runSvmBatchSettlement }, { runBatchSettlement }] = await Promise.all([
                import("./channels.js"),
                import("./batch.js"),
                import("./accumulator/index.js"),
            ]);
            const [nativeStepResult, svmStepResult, intentsStepResult] = await Promise.allSettled([
                runSettlementCycleStep("native", reason, runNativeBatchSettlement),
                runSettlementCycleStep("svm", reason, runSvmBatchSettlement),
                runSettlementCycleStep("intents", reason, runBatchSettlement),
            ]);
            const nativeStep = settlementCycleStepValue(nativeStepResult);
            const svmStep = settlementCycleStepValue(svmStepResult);
            const intentsStep = settlementCycleStepValue(intentsStepResult);
            const native = nativeStep.succeeded ? nativeStep.value : null;
            const svm = svmStep.succeeded ? svmStep.value : null;
            const intents = intentsStep.succeeded ? intentsStep.value : null;
            console.log("[batch-settlement] cycle completed", {
                reason,
                nativeRunId: native?.runId,
                svmRunId: svm?.runId,
                intentRunId: intents?.runId,
            });
            return { reason, native, svm, intents };
        } finally {
            if (locked) {
                const current = await valkeyGet(SETTLEMENT_RUN_LOCK_KEY).catch(() => null);
                if (current === owner) {
                    await valkeyDel(SETTLEMENT_RUN_LOCK_KEY).catch(() => false);
                }
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

        const locked = await valkeySetNXEX(
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

function setSessionInvalidHeader(
    target: Pick<Response, "setHeader"> | Record<string, string>,
    reason: string,
): void {
    if (typeof (target as { setHeader?: unknown }).setHeader === "function") {
        (target as Pick<Response, "setHeader">).setHeader("x-session-invalid", reason);
        return;
    }

    (target as Record<string, string>)["x-session-invalid"] = reason;
}

function getSessionInvalidReason(error: string | undefined): string {
    const normalized = String(error || "").toLowerCase();
    if (normalized.includes("revoked")) return "revoked";
    if (normalized.includes("expired")) return "expired";
    if (normalized.includes("budget") || normalized.includes("insufficient")) return "budget_exhausted";
    return "invalid_key";
}

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
    network?: NetworkId;
}): PaymentRequired {
    const network = params.network || getDefaultNetwork();

    return createPaymentRequired({
        amountWei: params.amountWei,
        network,
        resourceUrl: params.resourceUrl || "",
        description: "Compose.Market AI Agent Inference",
        mimeType: "application/json",
        error: params.errorMessage || params.error || "payment_required",
    });
}

type PaymentScheme = "exact" | "upto" | "batch-settlement";

export type InferenceAuthorizationInput =
    | { useBudgetCap: true; scheme?: PaymentScheme }
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
    userAddress?: string;
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
    network?: NetworkId;
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

export function getNetworkFromRequest(req: Request): NetworkId | undefined {
    const networkHeader = req.get?.("x-network-id") || req.headers["x-network-id"];
    if (!networkHeader) {
        return undefined;
    }

    return isNetworkId(String(networkHeader)) ? String(networkHeader) as NetworkId : undefined;
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

function getRunIdFromRequest(req: Request): string | null {
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

function rawRuntimeHeaders(network: NetworkId, maxAmountWei: string): Record<string, string> {
    return {
        "x-session-active": "false",
        "x-session-budget-remaining": maxAmountWei,
        "x-network-id": network,
        "x-x402-max-amount-wei": maxAmountWei,
    };
}

function runtimeHeaders(input: {
    authorization: string;
    network: NetworkId;
    userAddress: string;
    maxAmountWei: string;
    sessionActive: boolean;
    paymentIntentId?: string | null;
    idempotencyKey?: string;
}): Record<string, string> {
    return {
        Authorization: input.authorization,
        "x-session-active": input.sessionActive ? "true" : "false",
        "x-session-user-address": input.userAddress,
        "x-session-budget-remaining": input.maxAmountWei,
        "x-network-id": input.network,
        "x-x402-max-amount-wei": input.maxAmountWei,
        ...(input.paymentIntentId ? { "x-payment-intent-id": input.paymentIntentId } : {}),
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
    };
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
export function getDefaultUptoEnvelopeWei(): string {
    const raw = process.env.INFERENCE_DEFAULT_UPTO_ENVELOPE_WEI?.trim();
    if (raw && /^\d+$/u.test(raw) && BigInt(raw) > 0n) {
        return raw;
    }
    return "1000000";
}

function resolveInferenceAuthorizationRequirement(
    req: Request,
    authorizationInput: InferenceAuthorizationInput,
): { scheme: PaymentScheme; maxAmountWei: string } {
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
    const requiredNetwork = getNetworkFromRequest(req);
    if (!requiredNetwork) {
        res.status(400).json({ error: "x-network-id header is required" });
        return null;
    }
    const resourceUrl = publicResourceUrl(req);
    const runId = getRunIdFromRequest(req);

    const buildPaymentRequired = (network: NetworkId, error?: string) => createPaymentRequired({
        amountWei: requirement.maxAmountWei,
        network,
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
        if (runId && inheritedExecutionId) {
            const inherited = await readRawEnvelope(runId);
            if (inherited && inherited.network !== requiredNetwork) {
                const paymentRequired = buildPaymentRequired(
                    requiredNetwork,
                    `Inherited x402 envelope network ${inherited.network} does not match required network ${requiredNetwork}`,
                );
                res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
                res.status(402).json(paymentRequired);
                return null;
            }
            if (inherited) {
                return {
                    maxAmountWei: inherited.maxAmountWei,
                    runtimeHeaders: rawRuntimeHeaders(requiredNetwork, inherited.maxAmountWei),
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

                        await reserveRawEnvelope(runId, finalAmountWei);
                        const inheritedBatchPayload = getBatchPayload(inherited.paymentPayload);
                        if (inheritedBatchPayload) {
                            try {
                                const batch = await commitBatchCharge(
                                    inherited.paymentPayload,
                                    finalAmountWei,
                                    createPaymentRequirement({
                                        amountWei: finalAmountWei,
                                        network: requiredNetwork,
                                        scheme: "batch-settlement",
                                    }),
                                );
                                return {
                                    success: true,
                                    finalAmountWei,
                                    providerAmountWei,
                                    platformFeeWei,
                                    meterSubject,
                                    lineItems,
                                    userAddress: inherited.payer,
                                    network: requiredNetwork,
                                    settledAt: Date.now(),
                                    settlementStatus: "queued",
                                    paymentChannelId: batch.channelId,
                                    paymentCumulativeAmountWei: batch.cumulativeAmountWei,
                                };
                            } catch (error) {
                                await releaseRawEnvelope(runId, finalAmountWei);
                                return {
                                    success: false,
                                    error: error instanceof Error ? error.message : "Batch settlement commit failed",
                                    statusCode: 402,
                                };
                            }
                        }
                        const settled = await settlePayment(
                            inherited.paymentPayload,
                            createPaymentRequirement({
                                amountWei: finalAmountWei,
                                network: requiredNetwork,
                                scheme: inherited.paymentPayload.accepted.scheme === "upto" ? "upto" : "exact",
                            }),
                        );
                        if (!settled.success) {
                            await releaseRawEnvelope(runId, finalAmountWei);
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
                            userAddress: inherited.payer,
                            network: requiredNetwork,
                            settledAt: Date.now(),
                            settlementStatus: settled.transaction ? "settled" : "queued",
                        };
                    },
                    abort: async () => undefined,
                    applyHeaders: () => undefined,
                };
            }
        }
        const paymentRequired = buildPaymentRequired(requiredNetwork);
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    let paymentPayload;
    let paymentNetwork: NetworkId;
    try {
        paymentPayload = decodePaymentSignatureHeader(paymentSignature);
        paymentNetwork = getNetworkFromPaymentPayload(paymentPayload);
    } catch (error) {
        const paymentRequired = buildPaymentRequired(
            requiredNetwork,
            error instanceof Error ? error.message : "Invalid payment payload",
        );
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    if (paymentNetwork !== requiredNetwork) {
        const paymentRequired = buildPaymentRequired(
            requiredNetwork,
            `Payment network ${paymentNetwork} does not match required network ${requiredNetwork}`,
        );
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    const verificationRequirement = createPaymentRequirement({
        amountWei: requirement.maxAmountWei,
        network: requiredNetwork,
        scheme: requirement.scheme,
    });
    const verifyResult = await verifyPayment(paymentPayload, verificationRequirement);
    if (!verifyResult.isValid) {
        const paymentRequired = buildPaymentRequired(
            requiredNetwork,
            verifyResult.invalidMessage || verifyResult.invalidReason || "Payment verification failed",
        );
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }
    const verifiedBatchPayload = getBatchPayload(paymentPayload);
    if (verifiedBatchPayload) {
        await rememberBatchChannel(paymentPayload, verificationRequirement, verifyResult);
    }

    if (runId) {
        await saveRawEnvelope({
            rootRunId: runId,
            maxAmountWei: requirement.maxAmountWei,
            network: requiredNetwork,
            paymentPayload,
            payer: verifyResult.payer,
        });
    }

    let currentHeaders: Record<string, string> = {};
    const rawPayer = verifyResult.payer || undefined;

    return {
        maxAmountWei: requirement.maxAmountWei,
        runtimeHeaders: rawRuntimeHeaders(requiredNetwork, requirement.maxAmountWei),
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
                    userAddress: rawPayer,
                    network: requiredNetwork,
                    settledAt: Date.now(),
                };
            }

            if (runId) {
                try {
                    await reserveRawEnvelope(runId, finalAmountWei);
                } catch (error) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : "Payment envelope budget exhausted",
                        statusCode: 402,
                    };
                }
            }

            const settlementRequirement = createPaymentRequirement({
                amountWei: finalAmountWei,
                network: requiredNetwork,
                scheme: requirement.scheme,
            });
            let settled;
            let batch;
            const batchPayload = getBatchPayload(paymentPayload);
            if (batchPayload?.type === "voucher") {
                try {
                    batch = await commitBatchCharge(paymentPayload, finalAmountWei, settlementRequirement);
                    settled = queuedBatchSettlement(finalAmountWei, settlementRequirement.network);
                } catch (error) {
                    if (runId) {
                        await releaseRawEnvelope(runId, finalAmountWei);
                    }
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : "Batch settlement commit failed",
                    };
                }
            } else {
                settled = await settlePayment(
                    paymentPayload,
                    settlementRequirement,
                );
                if (batchPayload && settled.success) {
                    batch = await commitBatchCharge(paymentPayload, finalAmountWei, settlementRequirement);
                }
            }

            currentHeaders = {
                "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled),
            };
            if (settled.transaction) {
                currentHeaders["X-Transaction-Hash"] = settled.transaction;
            }

            if (!settled.success) {
                if (runId) {
                    await releaseRawEnvelope(runId, finalAmountWei);
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
                userAddress: rawPayer,
                network: requiredNetwork,
                settledAt: Date.now(),
                settlementStatus: batch
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
    const keyToken = extractKeyFromHeader(authorization);
    if (!keyToken) {
        return prepareRawInferenceX402Payment(req, res, authorizationInput);
    }

    const validation = await validateKey(keyToken, 0);
    if (!validation.valid || !validation.payload || !validation.record) {
        setSessionInvalidHeader(res, getSessionInvalidReason(validation.error));
        res.status(401).json({ error: validation.error || "Invalid Compose key" });
        return null;
    }

    const network = getNetworkFromRequest(req);
    if (!network) {
        res.status(400).json({ error: "x-network-id header is required" });
        return null;
    }
    if (validation.record.network !== network) {
        setSessionInvalidHeader(res, "invalid_key");
        res.status(409).json({ error: "Compose key network does not match request network" });
        return null;
    }

    const userAddress = validation.payload.sub;
    const keyId = validation.payload.keyId;
    const purpose = validation.record.purpose;
    const requirement = resolveInferenceAuthorizationRequirement(req, authorizationInput);

    if (purpose === "session") {
        const sessionStatus = await getActiveSessionStatus(userAddress, network);
        const session = sessionStatus.session;
        if (!session || session.keyId !== keyId) {
            setSessionInvalidHeader(res, session ? "invalid_key" : sessionStatus.reason);
            res.status(401).json({ error: "The key session is inactive or expired." });
            return null;
        }
    }

    let currentHeaders: Record<string, string> = {};
    let paymentIntentId: string | null = null;
    let maxAmountWei = requirement.maxAmountWei;
    const idempotencyKey = getIdempotencyKeyFromRequest(req);
    let paymentSettled = false;

    const authorizationResult = await authorizePaymentIntent({
        authorization,
        network,
        service: "api",
        action: "inference",
        resource: publicResourceUrl(req),
        method: req.method || "POST",
        maxAmountWei: requirement.maxAmountWei,
        runId: getRunIdFromRequest(req) || undefined,
        idempotencyKey,
    });

    currentHeaders = {
        ...authorizationResult.headers,
    };

    if (!authorizationResult.ok) {
        for (const [key, value] of Object.entries(authorizationResult.headers)) {
            res.setHeader(key, value);
        }
        setSessionInvalidHeader(res, getSessionInvalidReason(String(authorizationResult.body.error || authorizationResult.status)));
        res.status(authorizationResult.status).json(authorizationResult.body);
        return null;
    }

    paymentIntentId = authorizationResult.body.paymentIntentId;
    maxAmountWei = authorizationResult.body.maxAmountWei;

    const resolvedRuntimeHeaders = runtimeHeaders({
        authorization,
        network,
        userAddress,
        maxAmountWei,
        sessionActive: purpose === "session",
        paymentIntentId,
        idempotencyKey,
    });

    return {
        maxAmountWei,
        runtimeHeaders: resolvedRuntimeHeaders,
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
                    network,
                    settledAt: Date.now(),
                    settlementStatus: "queued",
                    ...(paymentIntentId ? { paymentIntentId } : {}),
                };
            }

            if (!paymentIntentId) {
                return {
                    success: false,
                    error: "Payment intent is required for Compose key settlement",
                    statusCode: 402,
                };
            }

            if (paymentSettled) {
                return {
                    success: false,
                    error: "Payment intent has already been settled",
                    statusCode: 409,
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
                await abortPaymentIntent({
                    paymentIntentId,
                    reason: typeof intentSettlement.body.error === "string"
                        ? intentSettlement.body.error
                        : "Payment settlement failed",
                }).catch(() => undefined);
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
                network,
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
    userAddress?: string;
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
    network?: NetworkId;
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
    if (
        BigInt(settlement.finalAmountWei || "0") > 0n
        && settlement.paymentIntentId
        && !settlement.txHash
        && !settlement.sessionBudgetIntentId
        && !(settlement.paymentChannelId && settlement.paymentCumulativeAmountWei)
    ) {
        throw Object.assign(
            new Error("Nonzero direct Compose Key settlement is missing on-chain transaction backing"),
            { statusCode: 402 },
        );
    }

    return {
        finalAmountWei: settlement.finalAmountWei,
        userAddress: settlement.userAddress,
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
        network: settlement.network,
        settledAt: settlement.settledAt ?? Date.now(),
        evidenceOnly: settlement.evidenceOnly,
    };
}

// Re-export config for convenience
export {
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
};
