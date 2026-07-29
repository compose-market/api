import { randomUUID } from "crypto";

import { extractKeyFromHeader, getKeyBudgetInfo, validateKey } from "./keys/middleware.js";
import { getKeyRecord, getKeyReservedBudget } from "./keys/storage.js";
import type { KeyPurpose } from "./keys/types.js";
import {
    quoteMeteredAuthorization,
    quoteMeteredSettlement,
    type MeteredAmountBreakdown,
    type MeteredAuthorizationInput,
    type MeteredQuotedLineItem,
    type MeteredSettlementInput,
} from "./metering.js";
import {
    cancelBudgetIntent,
    getBudgetInfo as getSessionBudgetInfo,
    lockBudget,
    markIntentsSettled,
    markSettled,
    unlockBudget,
} from "./session/budget.js";
import {
    valkeyCompareAndDelete,
    valkeyCommitReservedBudget,
    valkeyExpire,
    valkeyGet,
    valkeyHGetAll,
    valkeyHIncrByAmount,
    valkeyHSet,
    valkeyReleaseReservedBudget,
    valkeySetNXEX,
    valkeyTryReserveBudget,
} from "./keys/valkey.js";
import { merchantWalletAddress } from "./wallets.js";
import {
    createPaymentRequired,
    encodePaymentRequiredHeader,
} from "./facilitator.js";
import { isNetworkId, type NetworkId } from "./configs/chains.js";

const INTENT_PREFIX = "payment-intent:";
const INTENT_LOCK_PREFIX = "payment-intent-lock:";
const KEY_LOCK_PREFIX = "key-lock:";
const IDEMPOTENCY_PREFIX = "payment-intent-idem:";
const INTENT_TTL_SECONDS = 15 * 60;
const LOCK_TTL_SECONDS = 15;
const LOCK_ATTEMPTS = 80;
const LOCK_DELAY_MS = 25;

export type PaymentIntentStatus = "authorized" | "settling" | "settled" | "aborted" | "failed";

export interface AuthorizePaymentIntentInput {
    authorization: string;
    network: NetworkId;
    service: string;
    action: string;
    resource: string;
    method: string;
    maxAmountWei?: string;
    meter?: MeteredAuthorizationInput;
    useBudgetCap?: boolean;
    runId?: string;
    idempotencyKey?: string;
}

export interface SettlePaymentIntentInput {
    paymentIntentId: string;
    finalAmountWei?: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    meterSubject?: string;
    lineItems?: MeteredQuotedLineItem[];
    meter?: MeteredSettlementInput;
}

export interface AbortPaymentIntentInput {
    paymentIntentId: string;
    reason: string;
}

export interface PaymentIntentRecord {
    paymentIntentId: string;
    keyId: string;
    purpose: KeyPurpose;
    userAddress: string;
    network: NetworkId;
    service: string;
    action: string;
    resource: string;
    method: string;
    maxAmountWei: string;
    finalAmountWei?: string;
    status: PaymentIntentStatus;
    runId?: string;
    idempotencyKey?: string;
    meterSubject?: string;
    meterLineItems?: MeteredQuotedLineItem[];
    providerAmountWei?: string;
    platformFeeWei?: string;
    sessionBudgetIntentId?: string;
    useBudgetCap?: boolean;
    reservedAmountWei?: string;
    txHash?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    settledAt?: number;
    abortedAt?: number;
}

export interface PaymentIntentSuccess<TBody> {
    ok: true;
    status: number;
    body: TBody;
    headers: Record<string, string>;
}

export interface PaymentIntentFailure {
    ok: false;
    status: number;
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

export type PaymentIntentResult<TBody> = PaymentIntentSuccess<TBody> | PaymentIntentFailure;

export interface AuthorizedPaymentIntentBody {
    paymentIntentId: string;
    maxAmountWei: string;
    status: PaymentIntentStatus;
}

export interface SettledPaymentIntentBody {
    paymentIntentId: string;
    network: NetworkId;
    maxAmountWei: string;
    finalAmountWei: string;
    status: PaymentIntentStatus;
    meterSubject?: string;
    lineItems?: MeteredQuotedLineItem[];
    providerAmountWei?: string;
    platformFeeWei?: string;
    txHash?: string;
}

export interface AbortedPaymentIntentBody {
    paymentIntentId: string;
    status: PaymentIntentStatus;
    reason: string;
}

function paymentIntentKey(paymentIntentId: string): string {
    return `${INTENT_PREFIX}${paymentIntentId}`;
}

function paymentIntentLockKey(paymentIntentId: string): string {
    return `${INTENT_LOCK_PREFIX}${paymentIntentId}`;
}

function keyLockKey(keyId: string): string {
    return `${KEY_LOCK_PREFIX}${keyId}`;
}

function keyRecordKey(keyId: string): string {
    return `key:${keyId}`;
}

function idempotencyValkeyKey(keyId: string, idempotencyKey: string): string {
    return `${IDEMPOTENCY_PREFIX}${keyId}:${idempotencyKey}`;
}

async function settleKeyPaymentOnChain(
    userAddress: string,
    amountWei: string,
    network: NetworkId,
) {
    if (process.env.NODE_ENV === "test" && process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH) {
        return {
            success: true,
            txHash: process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH,
        };
    }

    const { settleKeyPaymentForNetwork } = await import("./settlement.js");
    return settleKeyPaymentForNetwork(userAddress, amountWei, network);
}

function failure(
    status: number,
    error: string,
    options: {
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
    } = {},
): PaymentIntentFailure {
    return {
        ok: false,
        status,
        body: options.body || { error },
        headers: options.headers || {},
    };
}

function buildPaymentRequiredFailure(input: {
    resourceUrl: string;
    network: NetworkId;
    amountWei: string;
    error: string;
}): PaymentIntentFailure {
    const paymentRequired = createPaymentRequired({
        amountWei: input.amountWei,
        network: input.network,
        scheme: "exact",
        resourceUrl: input.resourceUrl,
        description: "Compose.Market resource payment",
        mimeType: "application/json",
        error: input.error,
    });
    const encoded = encodePaymentRequiredHeader(paymentRequired);

    return failure(402, input.error, {
        body: paymentRequired as unknown as Record<string, unknown>,
        headers: {
            "PAYMENT-REQUIRED": encoded,
            "payment-required": encoded,
        },
    });
}

function parsePositiveIntegerString(value: string, fieldName: string): bigint {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${fieldName} must be a base-10 integer string`);
    }

    const parsed = BigInt(value);
    if (parsed <= 0n) {
        throw new Error(`${fieldName} must be greater than zero`);
    }

    return parsed;
}

function toOptionalString(value: string): string {
    return value || "";
}

function parseMeterLineItems(value: string | undefined): MeteredQuotedLineItem[] | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
        throw new Error("meterLineItems must be an array");
    }

    return parsed as MeteredQuotedLineItem[];
}

function meteringValkeyFields(metering?: MeteredAmountBreakdown): Record<string, string> {
    if (!metering) {
        return {
            meterSubject: "",
            meterLineItems: "",
            providerAmountWei: "",
            platformFeeWei: "",
        };
    }

    return {
        meterSubject: metering.subject,
        meterLineItems: JSON.stringify(metering.lineItems),
        providerAmountWei: metering.providerAmountWei,
        platformFeeWei: metering.platformFeeWei,
    };
}

function resolveAuthorizationAmount(input: AuthorizePaymentIntentInput): {
    maxAmountWei?: string;
    useBudgetCap?: true;
    metering?: MeteredAmountBreakdown;
} {
    const hasExplicitAmount = typeof input.maxAmountWei === "string";
    const hasMeter = Boolean(input.meter);
    const hasBudgetCap = input.useBudgetCap === true;

    if (Number(hasExplicitAmount) + Number(hasMeter) + Number(hasBudgetCap) !== 1) {
        throw new Error("Provide exactly one of maxAmountWei, meter, or useBudgetCap");
    }

    if (input.meter) {
        const metering = quoteMeteredAuthorization(input.meter);
        return {
            maxAmountWei: metering.finalAmountWei,
            metering,
        };
    }

    if (hasBudgetCap) {
        return {
            useBudgetCap: true,
        };
    }

    return {
        maxAmountWei: input.maxAmountWei!,
    };
}

function resolveSettlementAmount(input: SettlePaymentIntentInput): {
    finalAmountWei: string;
    metering?: MeteredAmountBreakdown;
    explicit?: {
        providerAmountWei?: string;
        platformFeeWei?: string;
        meterSubject?: string;
        lineItems?: MeteredQuotedLineItem[];
    };
} {
    const hasExplicitAmount = typeof input.finalAmountWei === "string";
    const hasMeter = Boolean(input.meter);

    if (hasExplicitAmount === hasMeter) {
        throw new Error("Provide exactly one of finalAmountWei or meter");
    }

    if (input.meter) {
        const metering = quoteMeteredSettlement(input.meter);
        return {
            finalAmountWei: metering.finalAmountWei,
            metering,
        };
    }

    return {
        finalAmountWei: input.finalAmountWei!,
        explicit: {
            providerAmountWei: input.providerAmountWei,
            platformFeeWei: input.platformFeeWei,
            meterSubject: input.meterSubject,
            lineItems: input.lineItems,
        },
    };
}

function validateAuthorizeInput(input: AuthorizePaymentIntentInput): void {
    if (!input.authorization) {
        throw new Error("authorization is required");
    }
    if (!isNetworkId(input.network)) {
        throw new Error("network must be a supported CAIP-2 network");
    }
    if (!input.service) {
        throw new Error("service is required");
    }
    if (!input.action) {
        throw new Error("action is required");
    }
    if (!input.resource) {
        throw new Error("resource is required");
    }
    if (!input.method) {
        throw new Error("method is required");
    }
    const modes = Number(typeof input.maxAmountWei === "string")
        + Number(Boolean(input.meter))
        + Number(input.useBudgetCap === true);
    if (modes !== 1) {
        throw new Error("Provide exactly one of maxAmountWei, meter, or useBudgetCap");
    }
}

function validateSettleInput(input: SettlePaymentIntentInput): void {
    if (!input.paymentIntentId) {
        throw new Error("paymentIntentId is required");
    }
    if ((typeof input.finalAmountWei === "string") === Boolean(input.meter)) {
        throw new Error("Provide exactly one of finalAmountWei or meter");
    }
    if (typeof input.finalAmountWei === "string") {
        parsePositiveIntegerString(input.finalAmountWei, "finalAmountWei");
        if (typeof input.providerAmountWei === "string") {
            parsePositiveIntegerString(input.providerAmountWei, "providerAmountWei");
        }
        if (typeof input.platformFeeWei === "string") {
            parsePositiveIntegerString(input.platformFeeWei, "platformFeeWei");
        }
    }
}

function validateAbortInput(input: AbortPaymentIntentInput): void {
    if (!input.paymentIntentId) {
        throw new Error("paymentIntentId is required");
    }
    if (!input.reason) {
        throw new Error("reason is required");
    }
}

async function withValkeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        acquired = await valkeySetNXEX(key, owner, LOCK_TTL_SECONDS);
        if (acquired) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_DELAY_MS + Math.floor(Math.random() * LOCK_DELAY_MS)));
    }

    if (!acquired) {
        throw Object.assign(new Error(`Lock busy: ${key}`), { statusCode: 429 });
    }

    try {
        return await fn();
    } finally {
        await valkeyCompareAndDelete(key, owner);
    }
}

async function readPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const data = await valkeyHGetAll(paymentIntentKey(paymentIntentId));
    if (!data || Object.keys(data).length === 0) {
        return null;
    }

    return {
        paymentIntentId: data.paymentIntentId,
        keyId: data.keyId,
        purpose: data.purpose === "session" ? "session" : "api",
        userAddress: data.userAddress,
        network: data.network as NetworkId,
        service: data.service,
        action: data.action,
        resource: data.resource,
        method: data.method,
        maxAmountWei: data.maxAmountWei,
        finalAmountWei: data.finalAmountWei || undefined,
        status: data.status as PaymentIntentStatus,
        runId: data.runId || undefined,
        idempotencyKey: data.idempotencyKey || undefined,
        meterSubject: data.meterSubject || undefined,
        meterLineItems: parseMeterLineItems(data.meterLineItems),
        providerAmountWei: data.providerAmountWei || undefined,
        platformFeeWei: data.platformFeeWei || undefined,
        sessionBudgetIntentId: data.sessionBudgetIntentId || undefined,
        useBudgetCap: data.useBudgetCap === "true",
        reservedAmountWei: data.reservedAmountWei || undefined,
        txHash: data.txHash || undefined,
        error: data.error || undefined,
        createdAt: parseInt(data.createdAt, 10),
        updatedAt: parseInt(data.updatedAt, 10),
        settledAt: data.settledAt ? parseInt(data.settledAt, 10) : undefined,
        abortedAt: data.abortedAt ? parseInt(data.abortedAt, 10) : undefined,
    };
}

async function buildBudgetHeaders(keyId: string): Promise<Record<string, string>> {
    const budgetInfo = await getKeyBudgetInfo(keyId);
    const reserved = await getKeyReservedBudget(keyId);

    if (!budgetInfo) {
        return {};
    }

    const budgetRemaining = Math.max(0, budgetInfo.budgetLimit - budgetInfo.budgetUsed - reserved);

    return {
        "x-key-budget-limit": String(budgetInfo.budgetLimit),
        "x-key-budget-used": String(budgetInfo.budgetUsed),
        "x-key-budget-reserved": String(reserved),
        "x-key-budget-remaining": String(budgetRemaining),
    };
}

async function buildSessionBudgetHeaders(
    userAddress: string,
    network: NetworkId,
): Promise<Record<string, string>> {
    const budgetInfo = await getSessionBudgetInfo(userAddress, network);
    if (!budgetInfo) {
        return {};
    }

    return {
        "x-session-budget-limit": budgetInfo.totalWei,
        "x-session-budget-used": budgetInfo.usedWei,
        "x-session-budget-locked": budgetInfo.lockedWei,
        "x-session-budget-remaining": budgetInfo.availableWei,
    };
}

async function buildPaymentBudgetHeaders(input: {
    keyId: string;
    purpose: KeyPurpose;
    userAddress: string;
    network: NetworkId;
}): Promise<Record<string, string>> {
    if (input.purpose === "session") {
        return buildSessionBudgetHeaders(input.userAddress, input.network);
    }

    return buildBudgetHeaders(input.keyId);
}

function appendSettlementAmountHeaders(
    headers: Record<string, string>,
    input: {
        finalAmountWei?: string;
        txHash?: string;
    },
): Record<string, string> {
    if (input.finalAmountWei) {
        headers["x-key-final-amount-wei"] = input.finalAmountWei;
    }
    if (input.txHash) {
        headers["x-key-tx-hash"] = input.txHash;
        headers["X-Transaction-Hash"] = input.txHash;
    }
    return headers;
}

export async function authorizePaymentIntent(
    input: AuthorizePaymentIntentInput,
): Promise<PaymentIntentResult<AuthorizedPaymentIntentBody>> {
    try {
        const token = extractKeyFromHeader(input.authorization);

        if (!token) {
            return failure(401, "Compose key authorization is required");
        }

        const validation = await validateKey(token, 0);
        if (!validation.valid || !validation.payload || !validation.record) {
            return failure(401, validation.error || "Invalid Compose key");
        }

        const network = input.network;

        if (validation.record.network !== network) {
            return failure(409, "Compose key network does not match request network");
        }

        // Idempotency: if the caller provided an X-Idempotency-Key, a second
        // authorize with the same (keyId, idempotencyKey) must return the
        // exact intent created by the first call instead of creating a new
        // reservation. We key the dedupe slot on (keyId, idempotencyKey) so
        // different keys with the same client-chosen idempotency key do not
        // collide across wallets.
        if (typeof input.idempotencyKey === "string" && input.idempotencyKey.trim().length > 0) {
            const idemKey = idempotencyValkeyKey(validation.payload.keyId, input.idempotencyKey.trim());
            const existingIntentId = await valkeyGet(idemKey);
            if (existingIntentId) {
                const existing = await readPaymentIntent(existingIntentId);
                if (existing) {
                    const headers = await buildPaymentBudgetHeaders(existing);
                    headers["x-payment-intent-id"] = existing.paymentIntentId;
                    headers["x-idempotent-replay"] = "true";
                    return {
                        ok: true,
                        status: 200,
                        body: {
                            paymentIntentId: existing.paymentIntentId,
                            maxAmountWei: existing.maxAmountWei,
                            status: "authorized",
                        },
                        headers,
                    };
                }
                // Stale slot — the intent expired before the replay arrived.
                // Fall through and create a fresh one; we rewrite the slot below.
            }
        }

        const normalizedInput = {
            ...input,
            network,
        };
        validateAuthorizeInput(normalizedInput);
        const authorizationAmount = resolveAuthorizationAmount(normalizedInput);
        const paymentIntentId = randomUUID();
        const recordKey = keyRecordKey(validation.payload.keyId);
        const purpose = validation.record.purpose;

        const authorizationLockKey = purpose === "api" && authorizationAmount.useBudgetCap
            ? paymentIntentLockKey(paymentIntentId)
            : keyLockKey(validation.payload.keyId);
        const budgetState = await withValkeyLock(authorizationLockKey, async () => {
            const record = await getKeyRecord(validation.payload!.keyId);
            if (!record) {
                throw new Error("Compose key record not found");
            }

            if (record.purpose === "session") {
                const requestedAmountWei = authorizationAmount.useBudgetCap
                    ? (await getSessionBudgetInfo(validation.payload!.sub, network))?.availableWei
                    : authorizationAmount.maxAmountWei;

                if (!requestedAmountWei) {
                    return {
                        ok: false as const,
                    };
                }

                if (BigInt(requestedAmountWei) <= 0n) {
                    return {
                        ok: false as const,
                    };
                }

                let resolvedSessionBudgetIntentId = "";
                if (!authorizationAmount.useBudgetCap) {
                    const reservation = await lockBudget(
                        validation.payload!.sub,
                        network,
                        requestedAmountWei,
                        merchantWalletAddress,
                        paymentIntentId,
                        authorizationAmount.metering?.subject,
                    );

                    if (!reservation.success) {
                        return {
                            ok: false as const,
                        };
                    }

                    resolvedSessionBudgetIntentId = reservation.intentId || "";
                }

                const now = Date.now();
                await valkeyHSet(paymentIntentKey(paymentIntentId), {
                    paymentIntentId,
                    keyId: validation.payload!.keyId,
                    purpose: "session",
                    userAddress: validation.payload!.sub.toLowerCase(),
                    network: String(network),
                    service: normalizedInput.service,
                    action: normalizedInput.action,
                    resource: normalizedInput.resource,
                    method: normalizedInput.method,
                    maxAmountWei: requestedAmountWei,
                    status: "authorized",
                    runId: toOptionalString(normalizedInput.runId || ""),
                    idempotencyKey: toOptionalString(normalizedInput.idempotencyKey || ""),
                    sessionBudgetIntentId: toOptionalString(resolvedSessionBudgetIntentId || ""),
                    useBudgetCap: authorizationAmount.useBudgetCap ? "true" : "false",
                    reservedAmountWei: authorizationAmount.useBudgetCap ? "0" : requestedAmountWei,
                    ...meteringValkeyFields(authorizationAmount.metering),
                    createdAt: String(now),
                    updatedAt: String(now),
                });
                await valkeyExpire(paymentIntentKey(paymentIntentId), INTENT_TTL_SECONDS);

                return {
                    ok: true as const,
                    reservedAmountWei: requestedAmountWei,
                };
            }

            const reserved = BigInt(await getKeyReservedBudget(validation.payload!.keyId));
            const available = BigInt(record.budgetLimit) - BigInt(record.budgetUsed) - reserved;
            if (available <= 0n) {
                return {
                    ok: false as const,
                    available,
                };
            }

            const maxAmountWei = authorizationAmount.useBudgetCap
                ? available.toString()
                : authorizationAmount.maxAmountWei!;
            const reservedAmountWei = authorizationAmount.useBudgetCap ? "0" : maxAmountWei;
            const reservedAmount = BigInt(reservedAmountWei);

            if (!authorizationAmount.useBudgetCap && reservedAmount > available) {
                return {
                    ok: false as const,
                    available,
                };
            }

            if (reservedAmount > 0n) {
                await valkeyHIncrByAmount(recordKey, "budgetReserved", reservedAmount);
            }

            const now = Date.now();
            await valkeyHSet(paymentIntentKey(paymentIntentId), {
                paymentIntentId,
                keyId: validation.payload!.keyId,
                purpose: "api",
                userAddress: validation.payload!.sub.toLowerCase(),
                network: String(network),
                service: normalizedInput.service,
                action: normalizedInput.action,
                resource: normalizedInput.resource,
                method: normalizedInput.method,
                maxAmountWei,
                status: "authorized",
                runId: toOptionalString(normalizedInput.runId || ""),
                idempotencyKey: toOptionalString(normalizedInput.idempotencyKey || ""),
                useBudgetCap: authorizationAmount.useBudgetCap ? "true" : "false",
                reservedAmountWei,
                ...meteringValkeyFields(authorizationAmount.metering),
                createdAt: String(now),
                updatedAt: String(now),
            });
            await valkeyExpire(paymentIntentKey(paymentIntentId), INTENT_TTL_SECONDS);

            return {
                ok: true as const,
                reservedAmountWei: maxAmountWei,
            };
        });

        if (!budgetState.ok) {
            const headers = await buildPaymentBudgetHeaders({
                keyId: validation.payload.keyId,
                purpose,
                userAddress: validation.payload.sub.toLowerCase(),
                network,
            });
            return {
                ok: false,
                status: 402,
                body: { error: "Compose key budget exhausted" },
                headers,
            };
        }

        const headers = await buildPaymentBudgetHeaders({
            keyId: validation.payload.keyId,
            purpose,
            userAddress: validation.payload.sub.toLowerCase(),
            network,
        });
        headers["x-payment-intent-id"] = paymentIntentId;

        // Record the idempotency slot so a retried authorize with the same
        // idempotency key resolves to this intent instead of creating a new one.
        if (typeof input.idempotencyKey === "string" && input.idempotencyKey.trim().length > 0) {
            await valkeySetNXEX(
                idempotencyValkeyKey(validation.payload.keyId, input.idempotencyKey.trim()),
                paymentIntentId,
                INTENT_TTL_SECONDS,
            );
        }

        return {
            ok: true,
            status: 200,
            body: {
                paymentIntentId,
                maxAmountWei: budgetState.reservedAmountWei,
                status: "authorized",
            },
            headers,
        };
    } catch (error) {
        const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
        const status = typeof record?.statusCode === "number" ? record.statusCode : 400;
        return failure(status, error instanceof Error ? error.message : "Invalid payment authorization request");
    }
}

export async function settlePaymentIntent(
    input: SettlePaymentIntentInput,
): Promise<PaymentIntentResult<SettledPaymentIntentBody>> {
    try {
        validateSettleInput(input);
        const settlementResolved = resolveSettlementAmount(input);
        const finalAmountStr = settlementResolved.finalAmountWei;
        const finalAmount = parsePositiveIntegerString(finalAmountStr, "finalAmountWei");

        return await withValkeyLock(paymentIntentLockKey(input.paymentIntentId), async () => {
            const intent = await readPaymentIntent(input.paymentIntentId);
            if (!intent) {
                return failure(404, "Payment intent not found");
            }

            if (intent.status === "settled") {
                const headers = appendSettlementAmountHeaders(
                    await buildPaymentBudgetHeaders(intent),
                    {
                        finalAmountWei: intent.finalAmountWei || intent.maxAmountWei,
                        txHash: intent.txHash,
                    },
                );
                return {
                    ok: true,
                    status: 200,
                    body: {
                        paymentIntentId: intent.paymentIntentId,
                        network: intent.network,
                        maxAmountWei: intent.maxAmountWei,
                        finalAmountWei: intent.finalAmountWei || intent.maxAmountWei,
                        status: intent.status,
                        meterSubject: intent.meterSubject,
                        lineItems: intent.meterLineItems,
                        providerAmountWei: intent.providerAmountWei,
                        platformFeeWei: intent.platformFeeWei,
                        txHash: intent.txHash,
                    },
                    headers,
                };
            }

            if (intent.status !== "authorized") {
                return failure(409, `Payment intent cannot be settled from status ${intent.status}`);
            }

            const maxAmount = parsePositiveIntegerString(intent.maxAmountWei, "maxAmountWei");
            if (finalAmount > maxAmount) {
                return failure(409, "finalAmountWei cannot exceed the reserved amount");
            }

            let sessionBudgetIntentId = intent.sessionBudgetIntentId;
            let reservedSessionAmount = maxAmount;
            if (intent.purpose === "session" && !sessionBudgetIntentId) {
                const exactReservation = await lockBudget(
                    intent.userAddress,
                    intent.network,
                    finalAmountStr,
                    merchantWalletAddress,
                    intent.paymentIntentId,
                    settlementResolved.metering?.subject || intent.meterSubject,
                );

                if (!exactReservation.success || !exactReservation.intentId) {
                    const headers = await buildPaymentBudgetHeaders(intent);
                    return {
                        ok: false,
                        status: 402,
                        body: { error: exactReservation.error || "Compose key budget exhausted" },
                        headers,
                    };
                }

                sessionBudgetIntentId = exactReservation.intentId;
                reservedSessionAmount = finalAmount;
                await valkeyHSet(paymentIntentKey(intent.paymentIntentId), {
                    sessionBudgetIntentId,
                });
            }

            let apiReservedAmount = intent.reservedAmountWei
                ? BigInt(intent.reservedAmountWei)
                : intent.useBudgetCap
                    ? 0n
                    : maxAmount;
            if (intent.purpose === "api" && intent.useBudgetCap && apiReservedAmount <= 0n) {
                const reserved = await valkeyTryReserveBudget({
                    budgetKey: keyRecordKey(intent.keyId),
                    intentKey: paymentIntentKey(intent.paymentIntentId),
                    amount: finalAmount,
                });

                if (!reserved) {
                    const headers = await buildPaymentBudgetHeaders(intent);
                    return {
                        ok: false,
                        status: 402,
                        body: { error: "Compose key budget exhausted" },
                        headers,
                    };
                }

                apiReservedAmount = finalAmount;
            }

            await valkeyHSet(paymentIntentKey(intent.paymentIntentId), {
                status: "settling",
                updatedAt: String(Date.now()),
                finalAmountWei: finalAmountStr,
                ...meteringValkeyFields(settlementResolved.metering ?? {
                    subject: settlementResolved.explicit?.meterSubject || intent.meterSubject || "",
                    lineItems: settlementResolved.explicit?.lineItems || intent.meterLineItems || [],
                    providerAmountWei: settlementResolved.explicit?.providerAmountWei || intent.providerAmountWei || "",
                    platformFeeWei: settlementResolved.explicit?.platformFeeWei || intent.platformFeeWei || "",
                    finalAmountWei: intent.finalAmountWei || intent.maxAmountWei,
                }),
            });

            const settlement = await settleKeyPaymentOnChain(intent.userAddress, finalAmountStr, intent.network);

            const settlementError = !settlement.success
                ? settlement.error || "Payment settlement failed"
                : !settlement.txHash
                    ? "Payment settlement did not return transaction hash"
                    : null;

            if (settlementError) {
                if (intent.purpose === "session") {
                    if (sessionBudgetIntentId) {
                        await cancelBudgetIntent(sessionBudgetIntentId, settlementError);
                    }
                } else if (apiReservedAmount > 0n) {
                    await valkeyReleaseReservedBudget({
                        budgetKey: keyRecordKey(intent.keyId),
                        intentKey: paymentIntentKey(intent.paymentIntentId),
                        reservedAmount: apiReservedAmount,
                        intentFields: {
                            status: "failed",
                            updatedAt: String(Date.now()),
                            error: settlementError,
                        },
                    });
                }

                if (intent.purpose === "session") {
                    await valkeyHSet(paymentIntentKey(intent.paymentIntentId), {
                        status: "failed",
                        updatedAt: String(Date.now()),
                        error: settlementError,
                    });
                }

                return buildPaymentRequiredFailure({
                    resourceUrl: intent.resource,
                    network: intent.network,
                    amountWei: finalAmountStr,
                    error: settlementError,
                });
            }

            if (intent.purpose === "session") {
                const unlockedAmount = reservedSessionAmount - finalAmount;
                if (unlockedAmount > 0n) {
                    await unlockBudget(intent.userAddress, intent.network, unlockedAmount.toString());
                }
                await markSettled(intent.userAddress, intent.network, finalAmountStr);
                if (sessionBudgetIntentId) {
                    await markIntentsSettled([sessionBudgetIntentId], settlement.txHash || "");
                }
                await valkeyHSet(keyRecordKey(intent.keyId), "lastUsedAt", String(Date.now()));
            }
            const settledAt = Date.now();
            const settledFields = {
                status: "settled",
                updatedAt: String(settledAt),
                settledAt: String(settledAt),
                finalAmountWei: finalAmountStr,
                txHash: settlement.txHash || "",
                error: "",
                ...meteringValkeyFields(settlementResolved.metering ?? {
                    subject: settlementResolved.explicit?.meterSubject || intent.meterSubject || "",
                    lineItems: settlementResolved.explicit?.lineItems || intent.meterLineItems || [],
                    providerAmountWei: settlementResolved.explicit?.providerAmountWei || intent.providerAmountWei || "",
                    platformFeeWei: settlementResolved.explicit?.platformFeeWei || intent.platformFeeWei || "",
                    finalAmountWei: finalAmountStr,
                }),
            };
            if (intent.purpose === "api") {
                await valkeyCommitReservedBudget({
                    budgetKey: keyRecordKey(intent.keyId),
                    intentKey: paymentIntentKey(intent.paymentIntentId),
                    reservedAmount: apiReservedAmount,
                    finalAmount,
                    lastUsedAt: settledAt,
                    intentFields: settledFields,
                });
            } else {
                await valkeyHSet(paymentIntentKey(intent.paymentIntentId), settledFields);
            }

            const headers = appendSettlementAmountHeaders(
                await buildPaymentBudgetHeaders(intent),
                {
                    finalAmountWei: finalAmountStr,
                    txHash: settlement.txHash,
                },
            );

            return {
                ok: true,
                status: 200,
                body: {
                    paymentIntentId: intent.paymentIntentId,
                    network: intent.network,
                    maxAmountWei: intent.maxAmountWei,
                    finalAmountWei: finalAmountStr,
                    status: "settled",
                    meterSubject: settlementResolved.metering?.subject || settlementResolved.explicit?.meterSubject || intent.meterSubject,
                    lineItems: settlementResolved.metering?.lineItems || settlementResolved.explicit?.lineItems || intent.meterLineItems,
                    providerAmountWei: settlementResolved.metering?.providerAmountWei || settlementResolved.explicit?.providerAmountWei || intent.providerAmountWei,
                    platformFeeWei: settlementResolved.metering?.platformFeeWei || settlementResolved.explicit?.platformFeeWei || intent.platformFeeWei,
                    txHash: settlement.txHash,
                },
                headers,
            };
        });
    } catch (error) {
        const status = error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 400;
        return failure(status, error instanceof Error ? error.message : "Invalid payment settlement request", {
            headers: status === 429 ? { "Retry-After": "1" } : {},
        });
    }
}

export async function abortPaymentIntent(
    input: AbortPaymentIntentInput,
): Promise<PaymentIntentResult<AbortedPaymentIntentBody>> {
    try {
        validateAbortInput(input);

        return await withValkeyLock(paymentIntentLockKey(input.paymentIntentId), async () => {
            const intent = await readPaymentIntent(input.paymentIntentId);
            if (!intent) {
                return failure(404, "Payment intent not found");
            }

            if (intent.status === "aborted") {
                const headers = await buildPaymentBudgetHeaders(intent);
                return {
                    ok: true,
                    status: 200,
                    body: {
                        paymentIntentId: intent.paymentIntentId,
                        status: "aborted",
                        reason: intent.error || input.reason,
                    },
                    headers,
                };
            }

            if (intent.status === "settled") {
                return failure(409, "Settled payment intents cannot be aborted");
            }

            if (intent.status === "settling") {
                return failure(409, "Settling payment intents cannot be aborted");
            }

            const reservedAmount = intent.reservedAmountWei
                ? BigInt(intent.reservedAmountWei)
                : intent.useBudgetCap
                    ? 0n
                    : parsePositiveIntegerString(intent.maxAmountWei, "maxAmountWei");

            if (intent.purpose === "session") {
                if (intent.sessionBudgetIntentId) {
                    await cancelBudgetIntent(intent.sessionBudgetIntentId, input.reason);
                }
            } else if (reservedAmount > 0n) {
                const abortedAt = Date.now();
                await valkeyReleaseReservedBudget({
                    budgetKey: keyRecordKey(intent.keyId),
                    intentKey: paymentIntentKey(intent.paymentIntentId),
                    reservedAmount,
                    intentFields: {
                        status: "aborted",
                        updatedAt: String(abortedAt),
                        abortedAt: String(abortedAt),
                        error: input.reason,
                    },
                });
            }

            const abortedAt = Date.now();
            if (intent.purpose === "session" || reservedAmount === 0n) {
                await valkeyHSet(paymentIntentKey(intent.paymentIntentId), {
                    status: "aborted",
                    updatedAt: String(abortedAt),
                    abortedAt: String(abortedAt),
                    error: input.reason,
                });
            }

            const headers = await buildPaymentBudgetHeaders(intent);
            return {
                ok: true,
                status: 200,
                body: {
                    paymentIntentId: intent.paymentIntentId,
                    status: "aborted",
                    reason: input.reason,
                },
                headers,
            };
        });
    } catch (error) {
        const status = error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 400;
        return failure(status, error instanceof Error ? error.message : "Invalid payment abort request", {
            headers: status === 429 ? { "Retry-After": "1" } : {},
        });
    }
}
