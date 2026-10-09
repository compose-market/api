/**
 * x402 Payment Module
 *
 * Single entry point for all x402 payment operations.
 * Handles payment verification, settlement, and Compose-specific extensions.
 */

import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { PaymentRequired, VerifyResponse } from "@x402/core/types";
import { publicResourceUrl } from "../http/public-origin.js";
import {
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
} from "./wallets.js";
import { getDefaultNetwork, isEvmNetwork, isNetworkId, isServiceBlockedNetwork, type NetworkId } from "./configs/chains.js";
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
    verifyActiveSessionKey,
} from "./keys/index.js";

import {
    quoteMeteredAuthorization,
    quoteMeteredSettlement,
    type MeteredAuthorizationInput,
    type MeteredSettlementInput,
} from "./metering.js";
import {
    readRawEnvelope,
    saveRawEnvelope,
    type RawEnvelope,
} from "./envelope.js";
import {
    commitRawBatchCheckpoint,
    createEvmBatchDepositDependencies,
    ensureEvmBatchDeposit,
    getBatchPayload,
    isBatchSettlementScheme,
    queuedBatchSettlement,
    rememberBatchChannel,
    requireEvmBatchDepositConfirmed,
    type EvmBatchDepositState,
} from "./batch.js";
import {
    abortPaymentIntent,
    authorizePaymentIntent,
    executeCanonicalPaymentIntent,
    settlePaymentIntent,
} from "./intents.js";
import {
    valkeyCompareAndDelete,
    valkeyCompareAndExpire,
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
    near?: Awaited<ReturnType<typeof import("./batch.js").runNearBatchSettlement>> | null;
    intents: Awaited<ReturnType<typeof import("./accumulator/index.js").runBatchSettlement>> | null;
};

const SETTLEMENT_RUN_LOCK_KEY = "x402:settlement:run-lock";
const SETTLEMENT_KICK_LOCK_KEY = "x402:settlement:kick-lock";

let activeSettlementCycle: Promise<SettlementCycleResult> | null = null;
const activeTargetedIntentKicks = new Map<string, Promise<void>>();

function positiveAmount(value: string | undefined): boolean {
    return Boolean(value && /^\d+$/u.test(value) && BigInt(value) > 0n);
}

function intEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function runSettlementCycleStep<T>(
    label: "native" | "svm" | "near" | "intents",
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
    settlementStatus?: "queued" | "submitted" | "claimed" | "settled" | "failed";
    txHash?: string;
    paymentIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
} | null | undefined): boolean {
    if (!settlement || !positiveAmount(settlement.finalAmountWei)) return false;
    if (
        settlement.settlementStatus !== "queued"
        && settlement.settlementStatus !== "submitted"
        && settlement.settlementStatus !== "claimed"
    ) return false;
    return Boolean(
        settlement.txHash
        || settlement.paymentIntentId
        || (settlement.paymentChannelId && settlement.paymentCumulativeAmountWei)
    );
}

export async function runBatchSettlementCycle(reason = "manual"): Promise<SettlementCycleResult> {
    if (activeSettlementCycle) return activeSettlementCycle;

    activeSettlementCycle = (async () => {
        const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        // Short TTL + heartbeat extension: if the process holding the lock
        // dies (or its Valkey release fails mid-outage), the lock frees in
        // ~TTL instead of freezing every settlement cycle for 10 minutes.
        const lockTtlSeconds = intEnv("SETTLEMENT_RUN_LOCK_SECONDS", 120);
        let locked = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        try {
            locked = await valkeySetNXEX(SETTLEMENT_RUN_LOCK_KEY, owner, lockTtlSeconds);
            if (!locked) {
                console.log("[batch-settlement] skipped; another settlement cycle is active", { reason });
                return {
                    reason,
                    skipped: true,
                    native: null,
                    svm: null,
                    near: null,
                    intents: null,
                };
            }
            heartbeat = setInterval(() => {
                void valkeyCompareAndExpire(SETTLEMENT_RUN_LOCK_KEY, owner, lockTtlSeconds)
                    .then((extended) => {
                        if (!extended) {
                            console.warn("[batch-settlement] run lock lost mid-cycle; a concurrent cycle may start", { reason });
                        }
                    })
                    .catch(() => {
                        // Transient Valkey failure; the TTL heartbeat retries next tick.
                    });
            }, Math.max(10_000, Math.floor((lockTtlSeconds * 1000) / 4)));
            heartbeat.unref?.();

            console.log("[batch-settlement] cycle started", { reason });
            const [{ runNativeBatchSettlement }, { runSvmBatchSettlement, runNearBatchSettlement }, { runBatchSettlement }] = await Promise.all([
                import("./channels.js"),
                import("./batch.js"),
                import("./accumulator/index.js"),
            ]);
            const [nativeStepResult, svmStepResult, nearStepResult, intentsStepResult] = await Promise.allSettled([
                runSettlementCycleStep("native", reason, runNativeBatchSettlement),
                runSettlementCycleStep("svm", reason, runSvmBatchSettlement),
                runSettlementCycleStep("near", reason, runNearBatchSettlement),
                runSettlementCycleStep("intents", reason, runBatchSettlement),
            ]);
            const nativeStep = settlementCycleStepValue(nativeStepResult);
            const svmStep = settlementCycleStepValue(svmStepResult);
            const nearStep = settlementCycleStepValue(nearStepResult);
            const intentsStep = settlementCycleStepValue(intentsStepResult);
            const native = nativeStep.succeeded ? nativeStep.value : null;
            const svm = svmStep.succeeded ? svmStep.value : null;
            const near = nearStep.succeeded ? nearStep.value : null;
            const intents = intentsStep.succeeded ? intentsStep.value : null;
            console.log("[batch-settlement] cycle completed", {
                reason,
                nativeRunId: native?.runId,
                svmRunId: svm?.runId,
                nearRunId: near?.runId,
                intentRunId: intents?.runId,
            });
            return { reason, native, svm, near, intents };
        } finally {
            if (locked) {
                if (heartbeat) {
                    clearInterval(heartbeat);
                }
                // Atomic compare-and-delete with retries: a single failed
                // release during a Valkey blip must not strand the lock.
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    const released = await valkeyCompareAndDelete(SETTLEMENT_RUN_LOCK_KEY, owner).catch(() => false);
                    if (released) break;
                    const current = await valkeyGet(SETTLEMENT_RUN_LOCK_KEY).catch(() => null);
                    if (current !== owner) break;
                    await delay(250);
                }
            }
            activeSettlementCycle = null;
        }
    })();

    return activeSettlementCycle;
}

function dispatchTargetedIntentSettlement(paymentIntentId: string, reason: string): Promise<void> {
    const existing = activeTargetedIntentKicks.get(paymentIntentId);
    if (existing) return existing;

    const execution = (async () => {
        try {
            await executeCanonicalPaymentIntent(paymentIntentId, { waitForConfirmation: true });
        } catch (error) {
            console.error("[batch-settlement] targeted intent settlement kick failed", {
                paymentIntentId,
                reason,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            activeTargetedIntentKicks.delete(paymentIntentId);
        }
    })();

    activeTargetedIntentKicks.set(paymentIntentId, execution);
    return execution;
}

export async function awaitTargetedIntentSettlement(paymentIntentId: string): Promise<void> {
    const pending = activeTargetedIntentKicks.get(paymentIntentId);
    if (pending) {
        await pending;
    }
}

export async function kickBatchSettlement(
    settlement: {
        finalAmountWei?: string;
        settlementStatus?: "queued" | "submitted" | "claimed" | "settled" | "failed";
        txHash?: string;
        paymentIntentId?: string;
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
    settlementStatus?: "queued" | "submitted" | "claimed" | "settled" | "failed";
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
    checkpointSequence?: number;
    rootRunId?: string;
    executionRunId?: string;
    parentExecutionRunId?: string;
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
    settlementMode: "single" | "continuous";
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

function verifiedResultFromEvmDepositState(state: EvmBatchDepositState) {
    return {
        isValid: true as const,
        payer: state.payer,
        extra: {
            balance: state.verifiedBalanceWei,
            totalClaimed: state.verifiedTotalClaimedWei,
            withdrawRequestedAt: Number.parseInt(state.verifiedWithdrawRequestedAt, 10),
            refundNonce: state.verifiedRefundNonce,
        },
    };
}

function durableEvmBatchDepositDependencies() {
    return createEvmBatchDepositDependencies(async ({ paymentPayload, requirements, onSubmitted }) => {
        // @x402/evm 2.23 exposes deposit as one settle() call: it broadcasts and
        // waits for a receipt before returning the hash. There is no prepared
        // transaction or post-broadcast callback to persist earlier. When the
        // receipt wait fails after broadcast, 2.23 returns a non-terminal
        // `settlement_pending` result that preserves the hash so callers can
        // reconcile it on-chain; we persist the hash as `submitted` and let the
        // durable state machine reconcile instead of rebroadcasting. If this
        // call disappears before any result, the durable state deliberately
        // remains `broadcast` and retries fail closed instead of rebroadcasting.
        let result;
        try {
            result = await settlePayment(paymentPayload, requirements);
        } catch (error) {
            return {
                status: "unknown" as const,
                error: error instanceof Error ? error.message : "EVM batch deposit settlement failed ambiguously",
            };
        }
        const txHash = result.transaction || "";
        if (txHash) {
            await onSubmitted(txHash);
        }
        if (result.success && txHash) {
            return { status: "confirmed" as const, txHash };
        }
        if (!result.success && txHash && result.errorReason !== "settlement_pending") {
            return {
                status: "failed" as const,
                terminal: true as const,
                txHash,
                error: result.errorMessage || result.errorReason || "EVM batch deposit transaction failed",
            };
        }
        return {
            status: "unknown" as const,
            error: result.errorMessage || result.errorReason || "EVM batch deposit settlement result is ambiguous",
        };
    });
}

function createPreparedRawBatchPayment(input: {
    envelope: RawEnvelope;
    requiredNetwork: NetworkId;
    rootRunId: string;
    executionRunId: string;
    parentExecutionRunId?: string;
    idempotencyKey?: string;
}): PreparedInferencePayment {
    let currentHeaders: Record<string, string> = {};
    let checkpointSequence = 0;
    let lane = Promise.resolve();

    const enqueue = (
        operation: () => Promise<InferencePaymentSettlementResult>,
    ): Promise<InferencePaymentSettlementResult> => {
        const result = lane.then(operation);
        lane = result.then(() => undefined, () => undefined);
        return result;
    };

    return {
        maxAmountWei: input.envelope.maxAmountWei,
        settlementMode: "continuous",
        runtimeHeaders: rawRuntimeHeaders(input.requiredNetwork, input.envelope.maxAmountWei),
        settle: (settlementInput) => enqueue(async () => {
            const {
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
            } = resolveInferenceSettlement(settlementInput);
            if (!/^(?:0|[1-9]\d*)$/u.test(finalAmountWei)) {
                return {
                    success: false,
                    error: "Invalid raw batch settlement amount",
                    statusCode: 400,
                };
            }
            if (BigInt(finalAmountWei) > BigInt(input.envelope.maxAmountWei)) {
                return {
                    success: false,
                    error: "finalAmountWei cannot exceed the inherited x402 authorized maximum",
                    statusCode: 402,
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
                    userAddress: input.envelope.payer,
                    network: input.requiredNetwork,
                    rootRunId: input.rootRunId,
                    executionRunId: input.executionRunId,
                    parentExecutionRunId: input.parentExecutionRunId,
                };
            }

            const settlementRequirement = createPaymentRequirement({
                amountWei: finalAmountWei,
                network: input.requiredNetwork,
                scheme: "batch-settlement",
            });
            const batchPayload = getBatchPayload(input.envelope.paymentPayload);
            if (batchPayload?.type === "deposit" && isEvmNetwork(input.requiredNetwork)) {
                try {
                    await requireEvmBatchDepositConfirmed({
                        paymentPayload: input.envelope.paymentPayload,
                        requirements: input.envelope.paymentPayload.accepted,
                    });
                } catch (error) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : "EVM batch deposit is not confirmed",
                        statusCode: 402,
                    };
                }
            }

            const sequence = checkpointSequence;
            let batch;
            try {
                batch = await commitRawBatchCheckpoint({
                    paymentPayload: input.envelope.paymentPayload,
                    requirements: settlementRequirement,
                    amountWei: finalAmountWei,
                    rootRunId: input.rootRunId,
                    executionRunId: input.executionRunId,
                    idempotencyKey: input.idempotencyKey,
                    sequence,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : "Raw batch checkpoint failed";
                const paymentRequired = createPaymentRequired({
                    amountWei: input.envelope.maxAmountWei,
                    network: input.requiredNetwork,
                    scheme: "batch-settlement",
                    resourceUrl: input.envelope.resource,
                    description: "Compose.Market Inference & Agents Marketplace",
                    mimeType: "application/json",
                    error: message,
                });
                return {
                    success: false,
                    error: message,
                    statusCode: 402,
                    paymentRequired,
                    paymentRequiredHeader: encodePaymentRequiredHeader(paymentRequired),
                };
            }
            checkpointSequence += 1;
            const queued = queuedBatchSettlement(
                finalAmountWei,
                input.requiredNetwork,
                batch,
                input.envelope.payer,
            );
            currentHeaders = {
                "PAYMENT-RESPONSE": encodePaymentResponseHeader(queued),
            };
            return {
                success: true,
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
                userAddress: input.envelope.payer,
                network: input.requiredNetwork,
                settlementStatus: "queued",
                paymentChannelId: batch.channelId,
                paymentCumulativeAmountWei: batch.cumulativeAmountWei,
                checkpointSequence: sequence,
                rootRunId: input.rootRunId,
                executionRunId: input.executionRunId,
                parentExecutionRunId: input.parentExecutionRunId,
            };
        }),
        abort: async () => undefined,
        applyHeaders: (response) => {
            if (response.headersSent) return;
            for (const [header, value] of Object.entries(currentHeaders)) {
                response.setHeader(header, value);
            }
        },
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
    const requestBody = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const modalities = Array.isArray(requestBody.modalities) ? requestBody.modalities : [];
    const requestPath = typeof req.path === "string" ? req.path : req.originalUrl || req.url || "";
    const videoAuthorization = requestPath.includes("/videos/")
        || requestBody.modality === "video"
        || modalities.includes("video");
    const maxTimeoutSeconds = videoAuthorization ? 3_600 : 300;
    const runId = getRunIdFromRequest(req);
    const requestIdempotencyKey = getIdempotencyKeyFromRequest(req);
    const executionHeader = req.get?.("x-execution-run-id") || req.headers["x-execution-run-id"];
    const parentHeader = req.get?.("x-parent-run-id") || req.headers["x-parent-run-id"];
    const explicitExecutionRunId = typeof executionHeader === "string" && executionHeader.trim()
        ? executionHeader.trim()
        : undefined;
    const parentExecutionRunId = typeof parentHeader === "string" && parentHeader.trim()
        ? parentHeader.trim()
        : undefined;
    const executionRunId = explicitExecutionRunId || runId || undefined;

    const buildPaymentRequired = (network: NetworkId, error?: string) => createPaymentRequired({
        amountWei: requirement.maxAmountWei,
        network,
        scheme: requirement.scheme,
        resourceUrl,
        description: "Compose.Market AI Agent Inference",
        mimeType: "application/json",
        maxTimeoutSeconds,
        ...(error ? { error } : {}),
    });

    // x402 v2 recovery: when the client's channel state has drifted from the
    // immutable pinned backing (e.g. a re-deposit that raises the ceiling, or a
    // voucher signed against a stale channel), do not fail with an opaque 400.
    // Return a corrective 402 carrying a fresh challenge so a compliant client
    // (wrapFetchWithPayment) re-signs against the pinned envelope and recovers.
    const rejectWithCorrectivePaymentRequired = (error: unknown): null => {
        const paymentRequired = buildPaymentRequired(
            requiredNetwork,
            error instanceof Error ? error.message : "Payment channel state requires a fresh signature",
        );
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    };

    const paymentSignature = getPaymentSignatureFromRequest(req);
    if (!paymentSignature) {
        if (runId && executionRunId && (explicitExecutionRunId || parentExecutionRunId)) {
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
                // The envelope is signed resource-bound to the root resource
                // (e.g. the agent stream). Same-execution redials (retry/resume)
                // must hit that exact resource; nested executions under the
                // same root run (runtime-forwarded model/search/etc. calls with
                // their own execution run id or a parent execution run id) are
                // covered by the root envelope budget and settle continuously
                // against it.
                const isNestedExecution = executionRunId !== runId || Boolean(parentExecutionRunId);
                if (inherited.resource !== resourceUrl && !isNestedExecution) {
                    const paymentRequired = buildPaymentRequired(
                        requiredNetwork,
                        "Inherited x402 envelope resource does not match the requested resource",
                    );
                    res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
                    res.status(402).json(paymentRequired);
                    return null;
                }
                const inheritedBatchPayload = getBatchPayload(inherited.paymentPayload);
                if (inheritedBatchPayload?.type === "deposit" && isEvmNetwork(requiredNetwork)) {
                    try {
                        await requireEvmBatchDepositConfirmed({
                            paymentPayload: inherited.paymentPayload,
                            requirements: inherited.paymentPayload.accepted,
                        });
                    } catch (error) {
                        const paymentRequired = buildPaymentRequired(
                            requiredNetwork,
                            error instanceof Error ? error.message : "EVM batch deposit is not confirmed",
                        );
                        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
                        res.status(402).json(paymentRequired);
                        return null;
                    }
                }
                return createPreparedRawBatchPayment({
                    envelope: inherited,
                    requiredNetwork,
                    rootRunId: runId,
                    executionRunId,
                    parentExecutionRunId,
                    idempotencyKey: requestIdempotencyKey,
                });
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
        maxTimeoutSeconds,
    });
    const decodedBatchPayload = getBatchPayload(paymentPayload);
    const evmDepositDependencies = decodedBatchPayload?.type === "deposit" && isEvmNetwork(requiredNetwork)
        ? durableEvmBatchDepositDependencies()
        : null;
    let resumedDeposit: EvmBatchDepositState | null = null;
    if (decodedBatchPayload?.type === "deposit" && evmDepositDependencies) {
        if (!runId || !executionRunId) {
            res.status(400).json({ error: "x-run-id header is required for batch-settlement" });
            return null;
        }
        if (paymentPayload.resource?.url !== resourceUrl) {
            const paymentRequired = buildPaymentRequired(
                requiredNetwork,
                "Batch-settlement payment resource does not match the requested resource",
            );
            res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
            res.status(402).json(paymentRequired);
            return null;
        }
        try {
            resumedDeposit = await ensureEvmBatchDeposit({
                paymentPayload,
                requirements: verificationRequirement,
            }, evmDepositDependencies);
        } catch (error) {
            return rejectWithCorrectivePaymentRequired(error);
        }
        if (resumedDeposit && resumedDeposit.status !== "confirmed") {
            const paymentRequired = buildPaymentRequired(
                requiredNetwork,
                resumedDeposit.status === "failed"
                    ? `EVM batch deposit failed: ${resumedDeposit.error || "definitive on-chain failure"}`
                    : `EVM batch deposit is ${resumedDeposit.status}, not confirmed`,
            );
            res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
            res.status(402).json(paymentRequired);
            return null;
        }
    }
    const resolveVerifyResult = async (): Promise<VerifyResponse> => {
        if (resumedDeposit) return verifiedResultFromEvmDepositState(resumedDeposit);
        const verifyResult = await verifyPayment(paymentPayload, verificationRequirement);
        return verifyResult;
    };
    const verifyResult = await resolveVerifyResult();
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
        if (!runId || !executionRunId) {
            res.status(400).json({ error: "x-run-id header is required for batch-settlement" });
            return null;
        }
        if (!verifyResult.payer) {
            const paymentRequired = buildPaymentRequired(requiredNetwork, "Verified batch-settlement payer is required");
            res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
            res.status(402).json(paymentRequired);
            return null;
        }
        if (paymentPayload.resource?.url !== resourceUrl) {
            const paymentRequired = buildPaymentRequired(
                requiredNetwork,
                "Batch-settlement payment resource does not match the requested resource",
            );
            res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
            res.status(402).json(paymentRequired);
            return null;
        }
        let depositState = resumedDeposit;
        try {
            if (verifiedBatchPayload.type === "deposit" && evmDepositDependencies) {
                depositState = depositState || await ensureEvmBatchDeposit({
                    paymentPayload,
                    requirements: verificationRequirement,
                    verifyResult,
                }, evmDepositDependencies);
                if (!depositState || depositState.status !== "confirmed") {
                    const paymentRequired = buildPaymentRequired(
                        requiredNetwork,
                        depositState?.status === "failed"
                            ? `EVM batch deposit failed: ${depositState.error || "definitive on-chain failure"}`
                            : `EVM batch deposit is ${depositState?.status || "unprepared"}, not confirmed`,
                    );
                    res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
                    res.status(402).json(paymentRequired);
                    return null;
                }
                await rememberBatchChannel(
                    paymentPayload,
                    verificationRequirement,
                    verifiedResultFromEvmDepositState(depositState),
                );
            }
            await saveRawEnvelope({
                rootRunId: runId,
                maxAmountWei: requirement.maxAmountWei,
                network: requiredNetwork,
                paymentPayload,
                payer: depositState?.payer || verifyResult.payer,
            });
            if (!(verifiedBatchPayload.type === "deposit" && evmDepositDependencies)) {
                await rememberBatchChannel(paymentPayload, verificationRequirement, verifyResult);
            }
        } catch (error) {
            return rejectWithCorrectivePaymentRequired(error);
        }
        const envelope = await readRawEnvelope(runId);
        if (!envelope) {
            throw Object.assign(new Error("Verified raw batch envelope could not be loaded"), { statusCode: 402 });
        }
        return createPreparedRawBatchPayment({
            envelope,
            requiredNetwork,
            rootRunId: runId,
            executionRunId,
            parentExecutionRunId,
            idempotencyKey: requestIdempotencyKey,
        });
    }
    if (isBatchSettlementScheme(paymentPayload.accepted.scheme)) {
        const paymentRequired = buildPaymentRequired(requiredNetwork, "Invalid batch-settlement payload backing");
        res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
        res.status(402).json(paymentRequired);
        return null;
    }

    let currentHeaders: Record<string, string> = {};
    const rawPayer = verifyResult.payer || undefined;
    let singleUseConsumed = false;
    let singleUseLane = Promise.resolve();
    const enqueueSingleUse = (
        operation: () => Promise<InferencePaymentSettlementResult>,
    ): Promise<InferencePaymentSettlementResult> => {
        const result = singleUseLane.then(operation);
        singleUseLane = result.then(() => undefined, () => undefined);
        return result;
    };

    return {
        maxAmountWei: requirement.maxAmountWei,
        settlementMode: "single",
        runtimeHeaders: rawRuntimeHeaders(requiredNetwork, requirement.maxAmountWei),
        settle: (settlementInput) => enqueueSingleUse(async () => {
            if (singleUseConsumed) {
                return {
                    success: false,
                    error: "Raw exact and upto payment payloads are request-scoped and single-use",
                    statusCode: 409,
                };
            }
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

            if (!/^(?:0|[1-9]\d*)$/u.test(finalAmountWei)) {
                return { success: false, error: "Invalid raw x402 settlement amount", statusCode: 400 };
            }
            if (requirement.scheme === "upto" && BigInt(finalAmountWei) > BigInt(requirement.maxAmountWei)) {
                return {
                    success: false,
                    error: "finalAmountWei cannot exceed the x402 authorized maximum",
                };
            }
            singleUseConsumed = true;

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
                };
            }

            const settlementRequirement = createPaymentRequirement({
                amountWei: finalAmountWei,
                network: requiredNetwork,
                scheme: requirement.scheme,
                maxTimeoutSeconds,
            });
            let settled;
            try {
                settled = await settlePayment(paymentPayload, settlementRequirement);
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : "Payment settlement failed",
                    statusCode: 402,
                };
            }

            currentHeaders = {
                "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled),
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
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
                userAddress: rawPayer,
                network: requiredNetwork,
                ...(settled.transaction ? { settledAt: Date.now() } : {}),
                settlementStatus: settled.transaction ? "settled" : "queued",
            };
        }),
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
    let maxAmountWei = "0";
    const idempotencyKey = getIdempotencyKeyFromRequest(req);
    const rootRunId = getRunIdFromRequest(req) || idempotencyKey || `inference-${randomUUID()}`;
    const executionHeader = req.get?.("x-execution-run-id") || req.headers["x-execution-run-id"];
    const parentHeader = req.get?.("x-parent-run-id") || req.headers["x-parent-run-id"];
    const executionRunId = typeof executionHeader === "string" && executionHeader.trim()
        ? executionHeader.trim()
        : rootRunId;
    const parentExecutionRunId = typeof parentHeader === "string" && parentHeader.trim()
        ? parentHeader.trim()
        : undefined;
    let paymentFinalized = false;
    let paymentIntentSequence = 0;

    const authorizationResult = await authorizePaymentIntent({
        authorization,
        network,
        service: "api",
        action: "inference",
        resource: publicResourceUrl(req),
        method: req.method || "POST",
        useBudgetCap: true,
        runId: rootRunId,
        idempotencyKey,
        rootRunId,
        executionRunId,
        parentExecutionRunId,
        sequence: paymentIntentSequence,
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
        settlementMode: "continuous",
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
                if (paymentIntentId && !paymentFinalized) {
                    await abortPaymentIntent({
                        paymentIntentId,
                        reason: "zero_amount_settlement",
                    });
                    paymentFinalized = true;
                }
                return {
                    success: true,
                    userAddress,
                    finalAmountWei,
                    providerAmountWei,
                    platformFeeWei,
                    meterSubject,
                    lineItems,
                    network,
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

            let activePaymentIntentId = paymentIntentId;
            if (paymentFinalized) {
                paymentIntentSequence += 1;
                const authorizationResult = await authorizePaymentIntent({
                    authorization,
                    network,
                    service: "api",
                    action: "inference",
                    resource: publicResourceUrl(req),
                    method: req.method || "POST",
                    useBudgetCap: true,
                    runId: rootRunId,
                    idempotencyKey,
                    rootRunId,
                    executionRunId,
                    parentExecutionRunId,
                    sequence: paymentIntentSequence,
                });

                currentHeaders = {
                    ...authorizationResult.headers,
                };

                if (!authorizationResult.ok) {
                    setSessionInvalidHeader(currentHeaders, getSessionInvalidReason(String(authorizationResult.body.error || authorizationResult.status)));
                    return {
                        success: false,
                        error: typeof authorizationResult.body.error === "string"
                            ? authorizationResult.body.error
                            : "Payment authorization failed",
                        statusCode: authorizationResult.status,
                        paymentRequired: authorizationResult.status === 402
                            ? authorizationResult.body as unknown as PaymentRequired
                            : undefined,
                        paymentRequiredHeader: authorizationResult.headers["PAYMENT-REQUIRED"]
                            || authorizationResult.headers["payment-required"]
                            || null,
                    };
                }

                activePaymentIntentId = authorizationResult.body.paymentIntentId;
                paymentIntentId = activePaymentIntentId;
                maxAmountWei = authorizationResult.body.maxAmountWei;
            }

            const intentSettlement = await settlePaymentIntent({
                paymentIntentId: activePaymentIntentId,
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
            });

            currentHeaders = {
                ...currentHeaders,
                ...intentSettlement.headers,
                "x-payment-intent-id": activePaymentIntentId,
            };

            if (!intentSettlement.ok) {
                await abortPaymentIntent({
                    paymentIntentId: activePaymentIntentId,
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

            paymentFinalized = true;
            const txHash = intentSettlement.body.txHash;
            const settlementStatus = intentSettlement.body.status === "confirmed"
                ? "settled"
                : intentSettlement.body.status === "submitted"
                    ? "submitted"
                    : intentSettlement.body.status === "failed"
                        ? "failed"
                        : "queued";
            return {
                success: true,
                userAddress,
                txHash,
                finalAmountWei,
                providerAmountWei,
                platformFeeWei,
                meterSubject,
                lineItems,
                network,
                settlementStatus,
                paymentIntentId: activePaymentIntentId,
                checkpointSequence: paymentIntentSequence,
                rootRunId,
                executionRunId,
                parentExecutionRunId,
                ...(settlementStatus === "settled" && intentSettlement.body.confirmedAt !== undefined
                    ? { settledAt: intentSettlement.body.confirmedAt }
                    : {}),
            };
        },
        abort: async (reason?: string) => {
            if (paymentIntentId && !paymentFinalized) {
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
    settlementStatus?: "queued" | "submitted" | "claimed" | "settled" | "failed";
    claimTxHash?: string;
    settleTxHash?: string;
    paymentIntentId?: string;
    paymentChannelId?: string;
    paymentCumulativeAmountWei?: string;
    checkpointSequence?: number;
    rootRunId?: string;
    executionRunId?: string;
    parentExecutionRunId?: string;
    network?: NetworkId;
    settledAt?: number;
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
        && !settlement.paymentIntentId
        && !settlement.txHash
        && !(settlement.paymentChannelId && settlement.paymentCumulativeAmountWei)
    ) {
        throw Object.assign(
            new Error("Nonzero settlement is missing durable payment backing"),
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
        settlementStatus: settlement.settlementStatus || (settlement.txHash ? "submitted" : "queued"),
        claimTxHash: settlement.claimTxHash,
        settleTxHash: settlement.settleTxHash,
        paymentIntentId: settlement.paymentIntentId,
        paymentChannelId: settlement.paymentChannelId,
        paymentCumulativeAmountWei: settlement.paymentCumulativeAmountWei,
        checkpointSequence: settlement.checkpointSequence,
        rootRunId: settlement.rootRunId,
        executionRunId: settlement.executionRunId,
        parentExecutionRunId: settlement.parentExecutionRunId,
        network: settlement.network,
        ...(settlement.settledAt !== undefined ? { settledAt: settlement.settledAt } : {}),
        evidenceOnly: settlement.evidenceOnly,
    };
}

// Re-export config for convenience
export {
    paymentAsset,
    merchantWalletAddress,
    serverWalletAddress,
};
