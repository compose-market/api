import { randomUUID } from "crypto";

import { extractComposeKeyFromHeader, getKeyBudgetInfo, validateComposeKey } from "./keys/middleware.js";
import { getKeyRecord, getKeyReservedBudget } from "./keys/storage.js";
import {
    quoteMeteredAuthorization,
    quoteMeteredSettlement,
    type MeteredAmountBreakdown,
    type MeteredAuthorizationInput,
    type MeteredQuotedLineItem,
    type MeteredSettlementInput,
} from "./metering.js";
import {
    redisDel,
    redisExpire,
    redisGet,
    redisHGetAll,
    redisHIncrBy,
    redisHSet,
    redisSetNXEX,
} from "./keys/redis.js";

const INTENT_PREFIX = "payment-intent:";
const INTENT_LOCK_PREFIX = "payment-intent-lock:";
const KEY_LOCK_PREFIX = "compose-key-lock:";
const INTENT_TTL_SECONDS = 15 * 60;
const LOCK_TTL_SECONDS = 15;

export type PaymentIntentStatus = "authorized" | "settling" | "settled" | "aborted" | "failed";

export interface AuthorizePaymentIntentInput {
    authorization: string;
    chainId: number;
    service: string;
    action: string;
    resource: string;
    method: string;
    maxAmountWei?: string;
    meter?: MeteredAuthorizationInput;
    useBudgetCap?: boolean;
    composeRunId?: string;
    idempotencyKey?: string;
}

export interface SettlePaymentIntentInput {
    paymentIntentId: string;
    finalAmountWei?: string;
    meter?: MeteredSettlementInput;
}

export interface AbortPaymentIntentInput {
    paymentIntentId: string;
    reason: string;
}

export interface PaymentIntentRecord {
    paymentIntentId: string;
    keyId: string;
    userAddress: string;
    chainId: number;
    service: string;
    action: string;
    resource: string;
    method: string;
    maxAmountWei: string;
    finalAmountWei?: string;
    status: PaymentIntentStatus;
    composeRunId?: string;
    idempotencyKey?: string;
    meterSubject?: string;
    meterLineItems?: MeteredQuotedLineItem[];
    providerAmountWei?: string;
    platformFeeWei?: string;
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

function composeKeyLockKey(keyId: string): string {
    return `${KEY_LOCK_PREFIX}${keyId}`;
}

function composeKeyRecordKey(keyId: string): string {
    return `compose-key:${keyId}`;
}

async function settleComposeKeyPaymentOnChain(
    userAddress: string,
    amountWei: string,
    chainId: number,
) {
    const { settleComposeKeyPayment } = await import("./settlement.js");
    return settleComposeKeyPayment(userAddress, amountWei, chainId);
}

function failure(status: number, error: string): PaymentIntentFailure {
    return {
        ok: false,
        status,
        body: { error },
        headers: {},
    };
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

function toRedisInteger(value: bigint, fieldName: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${fieldName} exceeds Redis safe integer range`);
    }

    return Number(value);
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

function meteringRedisFields(metering?: MeteredAmountBreakdown): Record<string, string> {
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
    };
}

function validateAuthorizeInput(input: AuthorizePaymentIntentInput): void {
    if (!input.authorization) {
        throw new Error("authorization is required");
    }
    if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
        throw new Error("chainId must be a positive integer");
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

async function withRedisLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const acquired = await redisSetNXEX(key, owner, LOCK_TTL_SECONDS);
    if (!acquired) {
        throw new Error(`Lock busy: ${key}`);
    }

    try {
        return await fn();
    } finally {
        const currentOwner = await redisGet(key);
        if (currentOwner === owner) {
            await redisDel(key);
        }
    }
}

async function readPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    const data = await redisHGetAll(paymentIntentKey(paymentIntentId));
    if (!data || Object.keys(data).length === 0) {
        return null;
    }

    return {
        paymentIntentId: data.paymentIntentId,
        keyId: data.keyId,
        userAddress: data.userAddress,
        chainId: parseInt(data.chainId, 10),
        service: data.service,
        action: data.action,
        resource: data.resource,
        method: data.method,
        maxAmountWei: data.maxAmountWei,
        finalAmountWei: data.finalAmountWei || undefined,
        status: data.status as PaymentIntentStatus,
        composeRunId: data.composeRunId || undefined,
        idempotencyKey: data.idempotencyKey || undefined,
        meterSubject: data.meterSubject || undefined,
        meterLineItems: parseMeterLineItems(data.meterLineItems),
        providerAmountWei: data.providerAmountWei || undefined,
        platformFeeWei: data.platformFeeWei || undefined,
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
        "x-compose-key-budget-limit": String(budgetInfo.budgetLimit),
        "x-compose-key-budget-used": String(budgetInfo.budgetUsed),
        "x-compose-key-budget-reserved": String(reserved),
        "x-compose-key-budget-remaining": String(budgetRemaining),
    };
}

export async function authorizePaymentIntent(
    input: AuthorizePaymentIntentInput,
): Promise<PaymentIntentResult<AuthorizedPaymentIntentBody>> {
    try {
        validateAuthorizeInput(input);
        const authorizationAmount = resolveAuthorizationAmount(input);
        const token = extractComposeKeyFromHeader(input.authorization);

        if (!token) {
            return failure(401, "Compose key authorization is required");
        }

        const validation = await validateComposeKey(token, 0);
        if (!validation.valid || !validation.payload || !validation.record) {
            return failure(401, validation.error || "Invalid Compose key");
        }

        if (validation.record.chainId && validation.record.chainId !== input.chainId) {
            return failure(409, "Compose key chainId does not match request chainId");
        }

        const paymentIntentId = randomUUID();
        const recordKey = composeKeyRecordKey(validation.payload.keyId);

        const budgetState = await withRedisLock(composeKeyLockKey(validation.payload.keyId), async () => {
            const record = await getKeyRecord(validation.payload!.keyId);
            if (!record) {
                throw new Error("Compose key record not found");
            }

            const reserved = BigInt(await getKeyReservedBudget(validation.payload!.keyId));
            const available = BigInt(record.budgetLimit) - BigInt(record.budgetUsed) - reserved;
            if (available <= 0n) {
                return {
                    ok: false as const,
                    available,
                };
            }

            const reservedAmountWei = authorizationAmount.useBudgetCap
                ? available.toString()
                : authorizationAmount.maxAmountWei!;
            const reservedAmount = parsePositiveIntegerString(reservedAmountWei, "maxAmountWei");

            if (reservedAmount > available) {
                return {
                    ok: false as const,
                    available,
                };
            }

            await redisHIncrBy(recordKey, "budgetReserved", toRedisInteger(reservedAmount, "maxAmountWei"));

            const now = Date.now();
            await redisHSet(paymentIntentKey(paymentIntentId), {
                paymentIntentId,
                keyId: validation.payload!.keyId,
                userAddress: validation.payload!.sub.toLowerCase(),
                chainId: String(input.chainId),
                service: input.service,
                action: input.action,
                resource: input.resource,
                method: input.method,
                maxAmountWei: reservedAmountWei,
                status: "authorized",
                composeRunId: toOptionalString(input.composeRunId || ""),
                idempotencyKey: toOptionalString(input.idempotencyKey || ""),
                ...meteringRedisFields(authorizationAmount.metering),
                createdAt: String(now),
                updatedAt: String(now),
            });
            await redisExpire(paymentIntentKey(paymentIntentId), INTENT_TTL_SECONDS);

            return {
                ok: true as const,
                reservedAmountWei,
            };
        });

        if (!budgetState.ok) {
            return failure(402, "Compose key budget exhausted");
        }

        const headers = await buildBudgetHeaders(validation.payload.keyId);
        headers["x-payment-intent-id"] = paymentIntentId;

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
        return failure(400, error instanceof Error ? error.message : "Invalid payment authorization request");
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

        return await withRedisLock(paymentIntentLockKey(input.paymentIntentId), async () => {
            const intent = await readPaymentIntent(input.paymentIntentId);
            if (!intent) {
                return failure(404, "Payment intent not found");
            }

            if (intent.status === "settled") {
                const headers = await buildBudgetHeaders(intent.keyId);
                if (intent.txHash) {
                    headers["x-compose-key-tx-hash"] = intent.txHash;
                    headers["X-Transaction-Hash"] = intent.txHash;
                }
                return {
                    ok: true,
                    status: 200,
                    body: {
                        paymentIntentId: intent.paymentIntentId,
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

            const reservedAmount = parsePositiveIntegerString(intent.maxAmountWei, "maxAmountWei");
            if (finalAmount > reservedAmount) {
                return failure(409, "finalAmountWei cannot exceed the reserved amount");
            }

            await redisHSet(paymentIntentKey(intent.paymentIntentId), {
                status: "settling",
                updatedAt: String(Date.now()),
                finalAmountWei: finalAmountStr,
                ...meteringRedisFields(settlementResolved.metering ?? {
                    subject: intent.meterSubject || "",
                    lineItems: intent.meterLineItems || [],
                    providerAmountWei: intent.providerAmountWei || "",
                    platformFeeWei: intent.platformFeeWei || "",
                    finalAmountWei: intent.finalAmountWei || intent.maxAmountWei,
                }),
            });

            const settlement = await settleComposeKeyPaymentOnChain(intent.userAddress, finalAmountStr, intent.chainId);

            if (!settlement.success) {
                await withRedisLock(composeKeyLockKey(intent.keyId), async () => {
                    await redisHIncrBy(
                        composeKeyRecordKey(intent.keyId),
                        "budgetReserved",
                        -toRedisInteger(reservedAmount, "maxAmountWei"),
                    );
                });

                await redisHSet(paymentIntentKey(intent.paymentIntentId), {
                    status: "failed",
                    updatedAt: String(Date.now()),
                    error: settlement.error || "Payment settlement failed",
                });

                return failure(402, settlement.error || "Payment settlement failed");
            }

            await withRedisLock(composeKeyLockKey(intent.keyId), async () => {
                const recordKey = composeKeyRecordKey(intent.keyId);
                await redisHIncrBy(recordKey, "budgetReserved", -toRedisInteger(reservedAmount, "maxAmountWei"));
                await redisHIncrBy(recordKey, "budgetUsed", toRedisInteger(finalAmount, "finalAmountWei"));
                await redisHSet(recordKey, "lastUsedAt", String(Date.now()));
            });

            const settledAt = Date.now();
            await redisHSet(paymentIntentKey(intent.paymentIntentId), {
                status: "settled",
                updatedAt: String(settledAt),
                settledAt: String(settledAt),
                finalAmountWei: finalAmountStr,
                txHash: settlement.txHash || "",
                error: "",
                ...meteringRedisFields(settlementResolved.metering ?? {
                    subject: intent.meterSubject || "",
                    lineItems: intent.meterLineItems || [],
                    providerAmountWei: intent.providerAmountWei || "",
                    platformFeeWei: intent.platformFeeWei || "",
                    finalAmountWei: finalAmountStr,
                }),
            });

            const headers = await buildBudgetHeaders(intent.keyId);
            if (settlement.txHash) {
                headers["x-compose-key-tx-hash"] = settlement.txHash;
                headers["X-Transaction-Hash"] = settlement.txHash;
            }

            return {
                ok: true,
                status: 200,
                body: {
                    paymentIntentId: intent.paymentIntentId,
                    maxAmountWei: intent.maxAmountWei,
                    finalAmountWei: finalAmountStr,
                    status: "settled",
                    meterSubject: settlementResolved.metering?.subject || intent.meterSubject,
                    lineItems: settlementResolved.metering?.lineItems || intent.meterLineItems,
                    providerAmountWei: settlementResolved.metering?.providerAmountWei || intent.providerAmountWei,
                    platformFeeWei: settlementResolved.metering?.platformFeeWei || intent.platformFeeWei,
                    txHash: settlement.txHash,
                },
                headers,
            };
        });
    } catch (error) {
        return failure(400, error instanceof Error ? error.message : "Invalid payment settlement request");
    }
}

export async function abortPaymentIntent(
    input: AbortPaymentIntentInput,
): Promise<PaymentIntentResult<AbortedPaymentIntentBody>> {
    try {
        validateAbortInput(input);

        return await withRedisLock(paymentIntentLockKey(input.paymentIntentId), async () => {
            const intent = await readPaymentIntent(input.paymentIntentId);
            if (!intent) {
                return failure(404, "Payment intent not found");
            }

            if (intent.status === "aborted") {
                const headers = await buildBudgetHeaders(intent.keyId);
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

            const reservedAmount = parsePositiveIntegerString(intent.maxAmountWei, "maxAmountWei");

            await withRedisLock(composeKeyLockKey(intent.keyId), async () => {
                await redisHIncrBy(
                    composeKeyRecordKey(intent.keyId),
                    "budgetReserved",
                    -toRedisInteger(reservedAmount, "maxAmountWei"),
                );
            });

            const abortedAt = Date.now();
            await redisHSet(paymentIntentKey(intent.paymentIntentId), {
                status: "aborted",
                updatedAt: String(abortedAt),
                abortedAt: String(abortedAt),
                error: input.reason,
            });

            const headers = await buildBudgetHeaders(intent.keyId);
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
        return failure(400, error instanceof Error ? error.message : "Invalid payment abort request");
    }
}
