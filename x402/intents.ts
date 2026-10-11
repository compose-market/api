import { createHash, randomUUID } from "crypto";

import { extractKeyFromHeader, validateKey } from "./keys/middleware.js";
import { getKeyRecord } from "./keys/storage.js";
import type { KeyPurpose, KeyValidationResult } from "./keys/types.js";
import {
    quoteMeteredAuthorization,
    quoteMeteredSettlement,
    type MeteredAmountBreakdown,
    type MeteredAuthorizationInput,
    type MeteredQuotedLineItem,
    type MeteredSettlementInput,
} from "./metering.js";
import {
    valkeyCompareAndDelete,
    valkeyAcquireFencedLease,
    valkeyAuthorizePaymentIntent,
    valkeyClaimPaymentIntentExecution,
    valkeyCompletePaymentIntentProjection,
    valkeyCommitReservedBudget,
    valkeyGet,
    valkeyHGetAll,
    valkeyHSet,
    valkeyMarkClaimedPaymentIntentSubmitted,
    valkeyPersistPreparedPaymentIntent,
    valkeyReleaseReservedBudget,
    valkeyReleaseFencedLease,
    valkeyRenewFencedLease,
    valkeyResetClaimedPaymentIntentPreparation,
    valkeyRetainClaimedPaymentIntent,
    valkeyReserveAndQueuePaymentIntent,
    valkeySRandMembers,
    valkeySRem,
    valkeySetNXEX,
    valkeyZRangeLiveWorkByScore,
    valkeyZRem,
} from "./keys/valkey.js";
import {
    getNetwork,
    isAddressValidForNetwork,
    isEvmNetwork,
    isNearNetwork,
    isNetworkId,
    isSolanaNetwork,
    type NetworkId,
} from "./configs/chains.js";
import {
    createPaymentRequired,
    encodePaymentRequiredHeader,
} from "./facilitator.js";
import { publishInvalidationBestEffort } from "../data/shared/updates.js";

const INTENT_PREFIX = "payment-intent:";
const INTENT_LOCK_PREFIX = "payment-intent-lock:";
const IDEMPOTENCY_PREFIX = "payment-intent-idem:";
const KEY_INTENTS_PREFIX = "key-payment-intents:";
const QUEUED_INTENTS_KEY = "payment-intents:queued";
const SUBMITTED_INTENTS_KEY = "payment-intents:submitted";
const DUE_INTENTS_KEY = "payment-intents:due";
const PROJECTION_INTENTS_KEY = "payment-intents:projections";
const TERMINAL_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 15;
const LOCK_ATTEMPTS = 80;
const LOCK_DELAY_MS = 25;
const EXECUTION_CLAIM_TTL_MS = 60_000;
const SIGNER_LEASE_TTL_MS = 15_000;
const SIGNER_LEASE_RENEW_MS = 5_000;
const SIGNER_LEASE_ATTEMPTS = 80;
const DEFAULT_SUBMITTED_BLOCKHASH_EXPIRY_MS = 5 * 60_000;

function submittedBlockhashExpiryMs(): number {
    const raw = process.env.SUBMITTED_BLOCKHASH_EXPIRY_MS?.trim();
    if (raw && /^\d+$/.test(raw)) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_SUBMITTED_BLOCKHASH_EXPIRY_MS;
}

export type PaymentIntentStatus =
    | "authorized"
    | "queued"
    | "submitted"
    | "confirmed"
    | "failed"
    | "released";

export interface AuthorizePaymentIntentInput {
    authorization: string;
    validatedKey?: KeyValidationResult;
    network: NetworkId;
    service: string;
    action: string;
    resource: string;
    method: string;
    maxAmountWei?: string;
    meter?: MeteredAuthorizationInput;
    meterSubject?: string;
    lineItems?: MeteredQuotedLineItem[];
    useBudgetCap?: boolean;
    runId?: string;
    idempotencyKey?: string;
    rootRunId?: string;
    executionRunId?: string;
    parentExecutionRunId?: string;
    sequence?: number;
    payTo?: string;
    royalties?: {
        creator?: string;
        treasury?: string;
    };
}

export interface SettlePaymentIntentInput {
    paymentIntentId: string;
    finalAmountWei?: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    royalties?: {
        creator?: string;
        treasury?: string;
    };
    meterSubject?: string;
    lineItems?: MeteredQuotedLineItem[];
    meter?: MeteredSettlementInput;
    executeImmediately?: boolean;
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
    asset: string;
    service: string;
    action: string;
    resource: string;
    method: string;
    maxAmountWei: string;
    finalAmountWei?: string;
    status: PaymentIntentStatus;
    rootRunId: string;
    executionRunId: string;
    parentExecutionRunId?: string;
    sequence: number;
    runId?: string;
    idempotencyKey?: string;
    meterSubject?: string;
    meterLineItems?: MeteredQuotedLineItem[];
    providerAmountWei?: string;
    platformFeeWei?: string;
    useBudgetCap?: boolean;
    reservedAmountWei?: string;
    txHash?: string;
    attemptCount: number;
    lastAttemptAt?: number;
    nextAttemptAt?: number;
    lastError?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    submittedAt?: number;
    confirmedAt?: number;
    failedAt?: number;
    releasedAt?: number;
    executionClaimToken?: string;
    executionClaimedAt?: number;
    executionClaimExpiresAt?: number;
    credentialExpiresAt: number;
    requestFingerprint: string;
    settlementFingerprint?: string;
    preparedTxHash?: string;
    preparedTxPayload?: string;
    preparedTxNonce?: string;
    preparedSecondaryTxHash?: string;
    preparedSecondaryPayload?: string;
    preparedAt?: number;
    payTo?: string;
    royalties?: {
        creator?: string;
        treasury?: string;
    };
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
    confirmedAt?: number;
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

function keyRecordKey(keyId: string): string {
    return `key:${keyId}`;
}

function keyPaymentIntentsKey(keyId: string): string {
    return `${KEY_INTENTS_PREFIX}${keyId}`;
}

function idempotencyValkeyKey(input: {
    network: NetworkId;
    keyId: string;
    rootRunId: string;
    executionRunId: string;
    sequence: number;
    idempotencyKey?: string;
}): string {
    const parts = [
        IDEMPOTENCY_PREFIX.slice(0, -1),
        input.network,
        input.keyId,
        encodeURIComponent(input.rootRunId),
        encodeURIComponent(input.executionRunId),
        String(input.sequence),
    ];
    // One execution fans out into many nested billable requests that all share
    // (rootRunId, executionRunId) and restart sequence at 0 per request. Scoping
    // the replay identity by the request idempotency key keeps each settlement
    // request distinct while retries of the same request (which reuse the same
    // key) stay replay-protected. Mirrors the raw-batch checkpoint identity
    // (envelope.ts). Omitted when absent so legacy identities remain addressable.
    const explicitIdempotencyKey = input.idempotencyKey?.trim();
    if (explicitIdempotencyKey) {
        parts.push(encodeURIComponent(explicitIdempotencyKey));
    }
    return parts.join(":");
}

function stableJson(value: unknown): string {
    if (value === undefined) return "null";
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function authorizationRequestFingerprint(input: {
    keyId: string;
    purpose: KeyPurpose;
    request: AuthorizePaymentIntentInput;
    rootRunId: string;
    executionRunId: string;
    sequence: number;
}): string {
    return createHash("sha256").update(stableJson({
        keyId: input.keyId,
        purpose: input.purpose,
        network: input.request.network,
        service: input.request.service,
        action: input.request.action,
        resource: input.request.resource,
        method: input.request.method.toUpperCase(),
        amountMode: input.request.useBudgetCap === true
            ? { type: "budget_cap" }
            : input.request.meter
                ? { type: "meter", meter: input.request.meter }
                : { type: "exact", maxAmountWei: input.request.maxAmountWei },
        rootRunId: input.rootRunId,
        executionRunId: input.executionRunId,
        parentExecutionRunId: input.request.parentExecutionRunId || null,
        sequence: input.sequence,
    })).digest("hex");
}

function settlementRequestFingerprint(input: ReturnType<typeof resolveSettlementAmount>): string {
    const lineItems = input.metering?.lineItems || input.explicit?.lineItems || [];
    return createHash("sha256").update(stableJson({
        finalAmountWei: input.finalAmountWei,
        providerAmountWei: input.metering?.providerAmountWei || input.explicit?.providerAmountWei || null,
        platformFeeWei: input.metering?.platformFeeWei || input.explicit?.platformFeeWei || null,
        meterSubject: input.metering?.subject || input.explicit?.meterSubject || null,
        lineItems: [...lineItems].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    })).digest("hex");
}

export function deriveTestSettlementPreparation(input: {
    network: NetworkId;
    userAddress: string;
    amountWei: string;
    intentIdentity: string;
    evmNonce?: bigint;
    nearNonce?: bigint;
    nearDelegateNonce?: bigint;
    forcedTxHash?: string;
}): import("./settlement.js").PreparedSettlementTransaction {
    const nonce = (input.evmNonce ?? input.nearNonce)?.toString();
    const delegateNonce = input.nearDelegateNonce?.toString();
    const payload = `test-signed:${stableJson({
        network: input.network,
        userAddress: input.userAddress,
        amountWei: input.amountWei,
        intentIdentity: input.intentIdentity,
        nonce: nonce || null,
        ...(delegateNonce === undefined ? {} : { delegateNonce }),
    })}`;
    const forcedTxHash = input.forcedTxHash?.trim();
    if (forcedTxHash && !/^0x[0-9a-fA-F]{64}$/.test(forcedTxHash)) {
        throw new Error("COMPOSE_TEST_SETTLEMENT_TX_HASH must be a 32-byte hex transaction hash");
    }
    const txHash = forcedTxHash
        || `0x${createHash("sha256").update(payload).digest("hex")}`;
    return {
        network: input.network,
        txHash,
        payload,
        ...(nonce === undefined ? {} : { nonce }),
        ...(delegateNonce === undefined ? {} : { delegateNonce }),
    };
}

function testSettlementSeamEnabled(): boolean {
    return process.env.NODE_ENV === "test"
        && (process.env.COMPOSE_TEST_SETTLEMENT_MODE === "deterministic"
            || Boolean(process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH));
}

async function prepareKeyPaymentOnChain(
    userAddress: string,
    amountWei: string,
    network: NetworkId,
    options: {
        evmNonce?: bigint;
        nearNonce?: bigint;
        nearDelegateNonce?: bigint;
        intentIdentity: string;
        payTo?: string;
        royalties?: { creator?: string; treasury?: string };
        providerAmountWei?: string;
        platformFeeWei?: string;
        memo?: string;
        service?: string;
    },
): Promise<import("./settlement.js").SettlementPreparationResult> {
    if (testSettlementSeamEnabled()) {
        return {
            success: true,
            prepared: deriveTestSettlementPreparation({
                network,
                userAddress,
                amountWei,
                intentIdentity: options.intentIdentity,
                evmNonce: options.evmNonce,
                nearNonce: options.nearNonce,
                nearDelegateNonce: options.nearDelegateNonce,
                forcedTxHash: process.env.COMPOSE_TEST_SETTLEMENT_TX_HASH,
            }),
        };
    }

    const { prepareKeyPaymentForNetwork } = await import("./settlement.js");
    return prepareKeyPaymentForNetwork(userAddress, amountWei, network, {
        evmNonce: options.evmNonce,
        nearNonce: options.nearNonce,
        nearDelegateNonce: options.nearDelegateNonce,
        payTo: options.payTo,
        royalties: options.royalties,
        providerAmountWei: options.providerAmountWei,
        platformFeeWei: options.platformFeeWei,
        memo: options.memo,
        service: options.service,
    });
}

async function broadcastPreparedKeyPaymentOnChain(
    prepared: import("./settlement.js").PreparedSettlementTransaction,
) {
    if (testSettlementSeamEnabled()) {
        const status = process.env.COMPOSE_TEST_SETTLEMENT_STATUS || "confirmed";
        if (status === "throw") throw new Error("test ambiguous broadcast exception");
        if (status === "queued") {
            return { success: false, status: "queued" as const, error: "test transient pre-broadcast failure" };
        }
        if (status === "reset_queued") {
            return {
                success: false,
                status: "queued" as const,
                resetPreparation: true,
                error: "test stale blockhash or nonce reset",
            };
        }
        if (status === "submitted") {
            return { success: false, status: "submitted" as const, txHash: prepared.txHash, error: "test pending receipt" };
        }
        if (status === "failed") {
            return {
                success: false,
                status: "failed" as const,
                terminal: true,
                txHash: prepared.txHash,
                error: "test reverted receipt",
            };
        }
        return { success: true, txHash: prepared.txHash, status: "confirmed" as const };
    }
    const { broadcastPreparedKeyPaymentForNetwork } = await import("./settlement.js");
    return broadcastPreparedKeyPaymentForNetwork(prepared);
}

async function reconcileKeyPaymentOnChain(
    txHash: string,
    network: NetworkId,
    wait = false,
    context: { userAddress?: string; preparedTxPayload?: string } = {},
) {
    if (testSettlementSeamEnabled()) {
        const status = process.env.COMPOSE_TEST_SETTLEMENT_RECONCILE_STATUS
            || process.env.COMPOSE_TEST_SETTLEMENT_STATUS
            || "confirmed";
        if (status === "failed") {
            return { success: false, status: "failed" as const, terminal: true, txHash, error: "test reverted receipt" };
        }
        if (status === "not_observed") {
            return {
                success: false,
                status: "submitted" as const,
                notObserved: true,
                txHash,
                error: "test transaction not observed",
            };
        }
        if (status === "confirmed") return { success: true, status: "confirmed" as const, txHash };
        return { success: false, status: "submitted" as const, txHash, error: "test pending receipt" };
    }
    const { reconcileKeyPaymentForNetwork } = await import("./settlement.js");
    return reconcileKeyPaymentForNetwork(txHash, network, {
        wait,
        userAddress: context.userAddress,
        preparedTxPayload: context.preparedTxPayload,
    });
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

    const explicitMetering = input.meterSubject || input.lineItems?.length
        ? {
            subject: input.meterSubject || "",
            lineItems: input.lineItems || [],
            providerAmountWei: "",
            platformFeeWei: "",
            finalAmountWei: input.maxAmountWei || "1",
        }
        : undefined;

    if (hasBudgetCap) {
        return {
            useBudgetCap: true,
            ...(explicitMetering ? { metering: explicitMetering } : {}),
        };
    }

    return {
        maxAmountWei: input.maxAmountWei!,
        ...(explicitMetering ? { metering: explicitMetering } : {}),
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

function sanitizePaymentIntentRecipients(input: {
    network: NetworkId;
    payTo?: string;
    royalties?: {
        creator?: string;
        treasury?: string;
    };
}): {
    payTo?: string;
    royalties?: {
        creator?: string;
        treasury?: string;
    };
    creatorStripped: boolean;
} {
    const explicitPayTo = input.payTo?.trim() || undefined;
    if (explicitPayTo && !isAddressValidForNetwork(explicitPayTo, input.network)) {
        throw new Error(`payTo address is not valid for network ${input.network}`);
    }
    if (!input.royalties) {
        return { payTo: explicitPayTo, royalties: undefined, creatorStripped: false };
    }
    const explicitTreasury = input.royalties.treasury?.trim() || undefined;
    if (explicitTreasury && !isAddressValidForNetwork(explicitTreasury, input.network)) {
        throw new Error(`royalties.treasury address is not valid for network ${input.network}`);
    }
    const rawCreator = input.royalties.creator?.trim() || undefined;
    const validCreator = rawCreator && isAddressValidForNetwork(rawCreator, input.network)
        ? rawCreator
        : undefined;
    const creatorStripped = Boolean(rawCreator && !validCreator);
    const sanitizedRoyalties = (validCreator || explicitTreasury)
        ? {
            ...(validCreator ? { creator: validCreator } : {}),
            ...(explicitTreasury ? { treasury: explicitTreasury } : {}),
        }
        : undefined;
    return {
        payTo: explicitPayTo,
        royalties: sanitizedRoyalties,
        creatorStripped,
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
        asset: data.asset,
        service: data.service,
        action: data.action,
        resource: data.resource,
        method: data.method,
        maxAmountWei: data.maxAmountWei,
        finalAmountWei: data.finalAmountWei || undefined,
        status: data.status as PaymentIntentStatus,
        rootRunId: data.rootRunId,
        executionRunId: data.executionRunId,
        parentExecutionRunId: data.parentExecutionRunId || undefined,
        sequence: Number.parseInt(data.sequence || "0", 10),
        runId: data.runId || undefined,
        idempotencyKey: data.idempotencyKey || undefined,
        meterSubject: data.meterSubject || undefined,
        meterLineItems: parseMeterLineItems(data.meterLineItems),
        providerAmountWei: data.providerAmountWei || undefined,
        platformFeeWei: data.platformFeeWei || undefined,
        useBudgetCap: data.useBudgetCap === "true",
        reservedAmountWei: data.reservedAmountWei || undefined,
        txHash: data.txHash || undefined,
        attemptCount: Number.parseInt(data.attemptCount || "0", 10),
        lastAttemptAt: data.lastAttemptAt ? Number.parseInt(data.lastAttemptAt, 10) : undefined,
        nextAttemptAt: data.nextAttemptAt ? Number.parseInt(data.nextAttemptAt, 10) : undefined,
        lastError: data.lastError || undefined,
        error: data.error || undefined,
        createdAt: parseInt(data.createdAt, 10),
        updatedAt: parseInt(data.updatedAt, 10),
        submittedAt: data.submittedAt ? parseInt(data.submittedAt, 10) : undefined,
        confirmedAt: data.confirmedAt ? parseInt(data.confirmedAt, 10) : undefined,
        failedAt: data.failedAt ? parseInt(data.failedAt, 10) : undefined,
        releasedAt: data.releasedAt ? parseInt(data.releasedAt, 10) : undefined,
        executionClaimToken: data.executionClaimToken || undefined,
        executionClaimedAt: data.executionClaimedAt ? parseInt(data.executionClaimedAt, 10) : undefined,
        executionClaimExpiresAt: data.executionClaimExpiresAt ? parseInt(data.executionClaimExpiresAt, 10) : undefined,
        credentialExpiresAt: Number.parseInt(data.credentialExpiresAt || "0", 10),
        requestFingerprint: data.requestFingerprint || "",
        settlementFingerprint: data.settlementFingerprint || undefined,
        preparedTxHash: data.preparedTxHash || undefined,
        preparedTxPayload: data.preparedTxPayload || undefined,
        preparedTxNonce: data.preparedTxNonce || undefined,
        preparedSecondaryTxHash: data.preparedSecondaryTxHash || undefined,
        preparedSecondaryPayload: data.preparedSecondaryPayload || undefined,
        preparedAt: data.preparedAt ? parseInt(data.preparedAt, 10) : undefined,
        payTo: data.payTo || undefined,
        royalties: data.royalties ? JSON.parse(data.royalties) : undefined,
    };
}

export async function getCanonicalPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
    return readPaymentIntent(paymentIntentId);
}

export async function listCanonicalPaymentProjectionIds(limit = 100): Promise<string[]> {
    return valkeySRandMembers(PROJECTION_INTENTS_KEY, limit);
}

type CanonicalInferenceProjection =
    | {
        paymentIntentId: string;
        status: "confirmed";
        transactionHash: string;
        confirmedAt: number;
    }
    | {
        paymentIntentId: string;
        status: "failed";
        transactionHash?: string;
    };

type AnalyticsProjectionPublisher = NonNullable<
    NonNullable<Parameters<typeof publishInvalidationBestEffort>[3]>["publish"]
>;

export interface CanonicalInferenceProjectionDependencies {
    project?: (input: CanonicalInferenceProjection) => Promise<boolean>;
    publish?: AnalyticsProjectionPublisher;
    complete?: typeof valkeyCompletePaymentIntentProjection;
    logError?: (error: unknown) => void;
    now?: () => number;
}

function hasPositiveFinalAmount(intent: PaymentIntentRecord): boolean {
    return Boolean(intent.finalAmountWei && /^\d+$/.test(intent.finalAmountWei) && BigInt(intent.finalAmountWei) > 0n);
}

export async function projectCanonicalPaymentIntentAnalytics(
    intent: PaymentIntentRecord,
    dependencies: CanonicalInferenceProjectionDependencies = {},
): Promise<boolean> {
    let projection: CanonicalInferenceProjection;
    if (intent.status === "confirmed") {
        if (!intent.txHash || intent.confirmedAt === undefined) {
            throw new Error("Confirmed payment intent is missing canonical Analytics settlement data");
        }
        projection = {
            paymentIntentId: intent.paymentIntentId,
            status: "confirmed",
            transactionHash: intent.txHash,
            confirmedAt: intent.confirmedAt,
        };
    } else if (intent.status === "failed") {
        projection = {
            paymentIntentId: intent.paymentIntentId,
            status: "failed",
            ...(intent.txHash ? { transactionHash: intent.txHash } : {}),
        };
    } else {
        throw new Error(`Analytics projection payment intent is not terminal: ${intent.status}`);
    }
    const complete = dependencies.complete ?? valkeyCompletePaymentIntentProjection;
    const completeProjection = () => complete({
        projectionKey: PROJECTION_INTENTS_KEY,
        intentKey: paymentIntentKey(intent.paymentIntentId),
        idempotencyKey: idempotencyValkeyKey(intent),
        intentId: intent.paymentIntentId,
        terminalTtlSeconds: paymentIntentTerminalTtlSeconds(intent, (dependencies.now ?? Date.now)()),
    });
    if (!dependencies.project && !hasPositiveFinalAmount(intent)) {
        await completeProjection();
        return true;
    }
    const project = dependencies.project ?? (async (input) => {
        const analytics = await import("../data/analytics/inference/store.js");
        return analytics.projectCanonicalPaymentIntentSettlement(input, undefined, intent);
    });
    if (!await project(projection)) return false;

    await publishInvalidationBestEffort(
        "inference-analytics",
        intent.userAddress,
        "telemetry",
        {
            ...(dependencies.publish ? { publish: dependencies.publish } : {}),
            ...(dependencies.logError ? { logError: dependencies.logError } : {}),
        },
    );
    await completeProjection();
    return true;
}

export async function reconcileCanonicalPaymentIntentProjections(
    paymentIntentId: string,
    analyticsDependencies: CanonicalInferenceProjectionDependencies = {},
): Promise<boolean> {
    if (process.env.NODE_ENV === "test" && process.env.COMPOSE_TEST_PROJECTION_FAILURE === "true") {
        throw new Error("test projection failure");
    }
    const intent = await readPaymentIntent(paymentIntentId);
    if (!intent) {
        await valkeySRem(PROJECTION_INTENTS_KEY, paymentIntentId);
        return false;
    }

    if (intent.status === "confirmed") {
        if (!intent.txHash) throw new Error("Confirmed payment intent is missing its transaction identity");
        if (intent.confirmedAt === undefined) throw new Error("Confirmed payment intent is missing its confirmation time");
        const [{ markIntentEvidenceSettled }, { markIntentReceiptsSettled }] = await Promise.all([
            import("./evidence.js"),
            import("./receipts.js"),
        ]);
        await Promise.all([
            markIntentEvidenceSettled({ paymentIntentId, txHash: intent.txHash, network: intent.network }),
            markIntentReceiptsSettled({ paymentIntentId, txHash: intent.txHash }),
        ]);
        if (
            isEvmNetwork(intent.network)
            && process.env.NODE_ENV !== "test"
            && Boolean(process.env.METRICS_DATABASE_URL?.trim())
        ) {
            const confirmedNetwork = intent.network;
            const confirmedTxHashes = [intent.txHash, intent.preparedSecondaryTxHash].filter(
                (candidate): candidate is string => Boolean(candidate),
            );
            void import("../data/metrics/payments.js")
                .then(({ recordConfirmedPayment }) => Promise.allSettled(
                    confirmedTxHashes.map((txHash) => recordConfirmedPayment({
                        network: confirmedNetwork,
                        txHash,
                    })),
                ))
                .catch(() => undefined);
        }
    } else if (intent.status === "failed") {
        const [{ markIntentEvidenceFailed }, { markIntentReceiptsFailed }] = await Promise.all([
            import("./evidence.js"),
            import("./receipts.js"),
        ]);
        await Promise.all([
            markIntentEvidenceFailed({ paymentIntentId, txHash: intent.txHash, error: intent.error || intent.lastError }),
            markIntentReceiptsFailed({ paymentIntentId, txHash: intent.txHash, error: intent.error || intent.lastError }),
        ]);
    } else {
        throw new Error(`Projection payment intent is not terminal: ${intent.status}`);
    }

    return projectCanonicalPaymentIntentAnalytics(intent, analyticsDependencies);
}

function formatPaymentBudgetHeaders(input: {
    purpose: KeyPurpose;
    budgetLimit: number;
    budgetUsed: number;
    budgetReserved: number;
}): Record<string, string> {
    const budgetRemaining = Math.max(0, input.budgetLimit - input.budgetUsed - input.budgetReserved);
    const headers: Record<string, string> = {
        "x-key-budget-limit": String(input.budgetLimit),
        "x-key-budget-used": String(input.budgetUsed),
        "x-key-budget-reserved": String(input.budgetReserved),
        "x-key-budget-remaining": String(budgetRemaining),
    };
    if (input.purpose === "session") {
        headers["x-session-budget-limit"] = headers["x-key-budget-limit"] || "0";
        headers["x-session-budget-used"] = headers["x-key-budget-used"] || "0";
        headers["x-session-budget-locked"] = headers["x-key-budget-reserved"] || "0";
        headers["x-session-budget-remaining"] = headers["x-key-budget-remaining"] || "0";
    }
    return headers;
}

async function buildBudgetHeaders(keyId: string): Promise<Record<string, string>> {
    const record = await getKeyRecord(keyId);

    if (!record) {
        return {};
    }

    const reserved = record.budgetReserved || 0;
    const budgetRemaining = Math.max(0, record.budgetLimit - record.budgetUsed - reserved);

    return {
        "x-key-budget-limit": String(record.budgetLimit),
        "x-key-budget-used": String(record.budgetUsed),
        "x-key-budget-reserved": String(reserved),
        "x-key-budget-remaining": String(budgetRemaining),
    };
}

async function buildPaymentBudgetHeaders(input: {
    keyId: string;
    purpose: KeyPurpose;
    userAddress: string;
    network: NetworkId;
}): Promise<Record<string, string>> {
    const headers = await buildBudgetHeaders(input.keyId);
    if (input.purpose === "session") {
        headers["x-session-budget-limit"] = headers["x-key-budget-limit"] || "0";
        headers["x-session-budget-used"] = headers["x-key-budget-used"] || "0";
        headers["x-session-budget-locked"] = headers["x-key-budget-reserved"] || "0";
        headers["x-session-budget-remaining"] = headers["x-key-budget-remaining"] || "0";
    }
    return headers;
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

        const validation = input.validatedKey ?? await validateKey(token, 0);
        if (!validation.valid || !validation.payload || !validation.record) {
            return failure(401, validation.error || "Invalid Compose key");
        }

        const network = input.network;

        if (validation.record.network !== network) {
            return failure(409, "Compose key network does not match request network");
        }

        validateAuthorizeInput({
            ...input,
            network,
        });
        const sanitizedAuthorizeRecipients = sanitizePaymentIntentRecipients({
            network,
            payTo: input.payTo,
            royalties: input.royalties,
        });
        const normalizedInput = {
            ...input,
            network,
            payTo: sanitizedAuthorizeRecipients.payTo,
            royalties: sanitizedAuthorizeRecipients.royalties,
        };
        const authorizationAmount = resolveAuthorizationAmount(normalizedInput);
        const purpose = validation.record.purpose;
        const rootRunId = normalizedInput.rootRunId?.trim()
            || normalizedInput.runId?.trim()
            || normalizedInput.idempotencyKey?.trim()
            || randomUUID();
        const executionRunId = normalizedInput.executionRunId?.trim() || rootRunId;
        const sequence = normalizedInput.sequence ?? 0;
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
            throw new Error("sequence must be a non-negative safe integer");
        }
        const explicitIdempotencyKey = normalizedInput.idempotencyKey?.trim() || undefined;
        const idemKey = idempotencyValkeyKey({
            network,
            keyId: validation.payload.keyId,
            rootRunId,
            executionRunId,
            sequence,
            idempotencyKey: explicitIdempotencyKey,
        });
        const record = validation.record;
        const now = Date.now();
        if (record.revokedAt) return failure(401, "Compose key has been revoked");
        if (record.expiresAt <= now) return failure(401, "Compose key has expired");

        const reserved = authorizationAmount.useBudgetCap
            ? 0n
            : BigInt(record.budgetReserved || 0);
        const available = BigInt(record.budgetLimit) - BigInt(record.budgetUsed) - reserved;
        const maxAmountWei = authorizationAmount.useBudgetCap
            ? "1"
            : authorizationAmount.maxAmountWei!;
        if (!authorizationAmount.useBudgetCap
            && (available <= 0n || BigInt(maxAmountWei) <= 0n || BigInt(maxAmountWei) > available)) {
            return failure(402, "Compose key budget exhausted", {
                headers: formatPaymentBudgetHeaders({
                    purpose,
                    budgetLimit: record.budgetLimit,
                    budgetUsed: record.budgetUsed,
                    budgetReserved: record.budgetReserved || 0,
                }),
            });
        }

        const requestFingerprint = authorizationRequestFingerprint({
            keyId: record.keyId,
            purpose,
            request: normalizedInput,
            rootRunId,
            executionRunId,
            sequence,
        });
        const paymentIntentId = randomUUID();
        const authorizationTtlSeconds = Math.max(1, Math.ceil((record.expiresAt - now) / 1000));
        const authorization = await valkeyAuthorizePaymentIntent({
            budgetKey: keyRecordKey(record.keyId),
            intentKey: paymentIntentKey(paymentIntentId),
            keyIntentsKey: keyPaymentIntentsKey(record.keyId),
            idempotencyKey: idemKey,
            intentPrefix: INTENT_PREFIX,
            intentId: paymentIntentId,
            requestFingerprint,
            maxAmountWei,
            useBudgetCap: authorizationAmount.useBudgetCap === true,
            now,
            ttlSeconds: authorizationTtlSeconds,
            intentFields: {
                paymentIntentId,
                keyId: record.keyId,
                purpose,
                userAddress: record.userAddress,
                network,
                asset: getNetwork(network).asset.address,
                service: normalizedInput.service,
                action: normalizedInput.action,
                resource: normalizedInput.resource,
                method: normalizedInput.method,
                maxAmountWei,
                status: "authorized",
                rootRunId,
                executionRunId,
                parentExecutionRunId: toOptionalString(normalizedInput.parentExecutionRunId || ""),
                sequence: String(sequence),
                runId: toOptionalString(normalizedInput.runId || rootRunId),
                idempotencyKey: toOptionalString(explicitIdempotencyKey || ""),
                useBudgetCap: authorizationAmount.useBudgetCap ? "true" : "false",
                reservedAmountWei: "0",
                attemptCount: "0",
                credentialExpiresAt: String(record.expiresAt),
                ...meteringValkeyFields(authorizationAmount.metering),
                payTo: toOptionalString(normalizedInput.payTo || ""),
                ...(normalizedInput.royalties ? { royalties: JSON.stringify(normalizedInput.royalties) } : {}),
                createdAt: String(now),
                updatedAt: String(now),
            },
        });
        if (authorization.outcome === "fingerprint_mismatch") {
            return failure(409, "Idempotency key was already used for a different payment request");
        }
        if (authorization.outcome === "revoked") return failure(401, "Compose key has been revoked");
        if (authorization.outcome === "expired") return failure(401, "Compose key has expired");
        if (authorization.outcome === "exhausted") {
            return failure(402, "Compose key budget exhausted", {
                headers: authorization.snapshot
                    ? formatPaymentBudgetHeaders({
                        purpose,
                        budgetLimit: authorization.snapshot.budgetLimit,
                        budgetUsed: authorization.snapshot.budgetUsed,
                        budgetReserved: authorization.snapshot.budgetReserved,
                    })
                    : await buildPaymentBudgetHeaders({
                        keyId: record.keyId,
                        purpose,
                        userAddress: record.userAddress,
                        network,
                    }),
            });
        }
        if (authorization.outcome === "inconsistent") {
            return failure(500, "Payment authorization replay state is inconsistent");
        }

        if (authorization.outcome === "created" && authorization.snapshot) {
            const headers = formatPaymentBudgetHeaders({
                purpose,
                budgetLimit: authorization.snapshot.budgetLimit,
                budgetUsed: authorization.snapshot.budgetUsed,
                budgetReserved: authorization.snapshot.budgetReserved,
            });
            headers["x-payment-intent-id"] = authorization.paymentIntentId;
            return {
                ok: true,
                status: 200,
                body: {
                    paymentIntentId: authorization.paymentIntentId,
                    maxAmountWei: authorization.snapshot.maxAmountWei,
                    status: "authorized",
                },
                headers,
            };
        }

        const intent = authorization.outcome === "replayed"
            ? await readPaymentIntent(authorization.paymentIntentId)
            : await readPaymentIntent(paymentIntentId);
        if (!intent) return failure(500, "Authorized payment intent disappeared");
        const headers = await buildPaymentBudgetHeaders(intent);
        headers["x-payment-intent-id"] = intent.paymentIntentId;
        if (authorization.outcome === "replayed") headers["x-idempotent-replay"] = "true";
        return {
            ok: true,
            status: 200,
            body: {
                paymentIntentId: intent.paymentIntentId,
                maxAmountWei: intent.maxAmountWei,
                status: intent.status,
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
        const settlementFingerprint = settlementRequestFingerprint(settlementResolved);
        const finalAmountStr = settlementResolved.finalAmountWei;
        const finalAmount = parsePositiveIntegerString(finalAmountStr, "finalAmountWei");
        const prepared = await withValkeyLock(paymentIntentLockKey(input.paymentIntentId), async () => {
            const intent = await readPaymentIntent(input.paymentIntentId);
            if (!intent) {
                return failure(404, "Payment intent not found");
            }

            if (intent.status === "released" || intent.status === "failed") {
                return failure(409, `Payment intent cannot be finalized from status ${intent.status}`);
            }

            if (intent.status !== "authorized" && intent.settlementFingerprint !== settlementFingerprint) {
                return failure(409, "Checkpoint replay does not match the original settlement request");
            }

            if (intent.status === "confirmed") {
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
                        ...(intent.confirmedAt !== undefined ? { confirmedAt: intent.confirmedAt } : {}),
                    },
                    headers,
                };
            }

            if (intent.status === "queued" || intent.status === "submitted") {
                return { intent, execute: intent.purpose === "api" } as const;
            }
            if (intent.status !== "authorized") {
                return failure(409, `Payment intent cannot be finalized from status ${intent.status}`);
            }

            const maxAmount = parsePositiveIntegerString(intent.maxAmountWei, "maxAmountWei");
            if (finalAmount > maxAmount) {
                return failure(409, "finalAmountWei cannot exceed the authorized amount");
            }
            const updatedAt = Date.now();
            const sanitizedSettleRecipients = sanitizePaymentIntentRecipients({
                network: intent.network,
                payTo: intent.payTo,
                royalties: input.royalties || intent.royalties,
            });
            const effectiveRoyalties = sanitizedSettleRecipients.royalties;
            const rawProviderAmountWei = settlementResolved.explicit?.providerAmountWei || input.providerAmountWei || intent.providerAmountWei || "";
            const rawPlatformFeeWei = settlementResolved.explicit?.platformFeeWei || input.platformFeeWei || intent.platformFeeWei || "";
            const providerAmountWei = sanitizedSettleRecipients.creatorStripped ? "" : rawProviderAmountWei;
            const platformFeeWei = sanitizedSettleRecipients.creatorStripped ? finalAmountStr : rawPlatformFeeWei;
            const effectiveMetering = settlementResolved.metering
                ? (sanitizedSettleRecipients.creatorStripped
                    ? {
                        ...settlementResolved.metering,
                        providerAmountWei: "",
                        platformFeeWei: finalAmountStr,
                    }
                    : settlementResolved.metering)
                : {
                    subject: settlementResolved.explicit?.meterSubject || intent.meterSubject || "",
                    lineItems: settlementResolved.explicit?.lineItems || intent.meterLineItems || [],
                    providerAmountWei,
                    platformFeeWei,
                    finalAmountWei: finalAmountStr,
                };

            const reservation = await valkeyReserveAndQueuePaymentIntent({
                budgetKey: keyRecordKey(intent.keyId),
                intentKey: paymentIntentKey(intent.paymentIntentId),
                queueKey: QUEUED_INTENTS_KEY,
                dueKey: DUE_INTENTS_KEY,
                keyIntentsKey: keyPaymentIntentsKey(intent.keyId),
                idempotencyKey: idempotencyValkeyKey(intent),
                intentId: intent.paymentIntentId,
                amount: finalAmount,
                now: updatedAt,
                settlementFingerprint,
                intentFields: {
                    status: "queued",
                    updatedAt: String(updatedAt),
                    finalAmountWei: finalAmountStr,
                    settlementFingerprint,
                    ...meteringValkeyFields(effectiveMetering),
                    royalties: effectiveRoyalties ? JSON.stringify(effectiveRoyalties) : "",
                },
            });
            if (reservation === "exhausted") {
                return failure(402, "Compose key budget exhausted", {
                    headers: await buildPaymentBudgetHeaders(intent),
                });
            }
            if (reservation === "revoked") return failure(401, "Compose key has been revoked");
            if (reservation === "expired") return failure(401, "Compose key has expired");
            if (reservation === "invalid_state") return failure(409, "Payment intent reservation state changed");
            if (reservation === "reserved") {
                await publishInvalidationBestEffort("keys", intent.userAddress, "budget");
            }
            const queuedIntent = await readPaymentIntent(intent.paymentIntentId);
            if (!queuedIntent) throw new Error("Queued payment intent disappeared");
            const shouldExecute = input.executeImmediately !== undefined
                ? input.executeImmediately
                : intent.purpose === "api";
            return { intent: queuedIntent, execute: shouldExecute } as const;
        });

        if (!("intent" in prepared)) return prepared;
        const actionable = prepared as { intent: PaymentIntentRecord; execute: boolean };
        if (actionable.execute) {
            return executeCanonicalPaymentIntent(actionable.intent.paymentIntentId);
        }
        return paymentIntentSuccess(actionable.intent);
    } catch (error) {
        const status = error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 400;
        return failure(status, error instanceof Error ? error.message : "Invalid payment settlement request", {
            headers: status === 429 ? { "Retry-After": "1" } : {},
        });
    }
}

function paymentIntentSuccess(intent: PaymentIntentRecord): PaymentIntentSuccess<SettledPaymentIntentBody> {
    const headers: Record<string, string> = {
        "x-payment-intent-id": intent.paymentIntentId,
        "x-key-final-amount-wei": intent.finalAmountWei || "0",
        "x-settlement": intent.status,
    };
    if (intent.txHash) {
        headers["x-key-tx-hash"] = intent.txHash;
        headers["X-Transaction-Hash"] = intent.txHash;
    }
    return {
        ok: true,
        status: 200,
        body: {
            paymentIntentId: intent.paymentIntentId,
            network: intent.network,
            maxAmountWei: intent.maxAmountWei,
            finalAmountWei: intent.finalAmountWei || "0",
            status: intent.status,
            meterSubject: intent.meterSubject,
            lineItems: intent.meterLineItems,
            providerAmountWei: intent.providerAmountWei,
            platformFeeWei: intent.platformFeeWei,
            txHash: intent.txHash,
            ...(intent.status === "confirmed" && intent.confirmedAt !== undefined
                ? { confirmedAt: intent.confirmedAt }
                : {}),
        },
        headers,
    };
}

function retryDelayMs(attemptCount: number): number {
    return Math.min(5 * 60_000, 1_000 * (2 ** Math.min(attemptCount, 8)));
}

function signerStateKey(
    kind: "lease" | "fence" | "nonce",
    network: NetworkId,
    signerIdentity: string,
): string {
    const testPrefix = process.env.NODE_ENV === "test" ? "test:" : "";
    return `${testPrefix}payment-signer-${kind}:${network}:${signerIdentity.toLowerCase()}`;
}

async function withFencedSignerLease<T>(
    network: NetworkId,
    signerIdentity: string,
    fn: (lease: { leaseKey: string; leaseValue: string; fence: number }) => Promise<T>,
): Promise<T> {
    const leaseKey = signerStateKey("lease", network, signerIdentity);
    const fenceKey = signerStateKey("fence", network, signerIdentity);
    const owner = randomUUID();
    let acquired: Awaited<ReturnType<typeof valkeyAcquireFencedLease>> | undefined;
    for (let attempt = 0; attempt < SIGNER_LEASE_ATTEMPTS; attempt += 1) {
        acquired = await valkeyAcquireFencedLease({
            leaseKey,
            fenceKey,
            owner,
            ttlMs: SIGNER_LEASE_TTL_MS,
        });
        if (acquired.acquired) break;
        await new Promise((resolve) => setTimeout(resolve, LOCK_DELAY_MS + Math.floor(Math.random() * LOCK_DELAY_MS)));
    }
    if (!acquired?.acquired || !acquired.value || acquired.fence === undefined) {
        throw Object.assign(new Error(`Signer lease busy: ${network}`), { statusCode: 429 });
    }

    let lost = false;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
        renewal = renewal.then(async () => {
            if (!await valkeyRenewFencedLease(leaseKey, acquired!.value!, SIGNER_LEASE_TTL_MS)) lost = true;
        }).catch(() => {
            lost = true;
        });
    }, SIGNER_LEASE_RENEW_MS);
    timer.unref?.();

    try {
        const result = await fn({ leaseKey, leaseValue: acquired.value, fence: acquired.fence });
        await renewal;
        if (lost) throw new Error(`Signer lease lost: ${network}`);
        return result;
    } finally {
        clearInterval(timer);
        await renewal.catch(() => undefined);
        await valkeyReleaseFencedLease(leaseKey, acquired.value).catch(() => false);
    }
}

type PreparationOutcome =
    | { prepared: import("./settlement.js").PreparedSettlementTransaction }
    | { settlement: import("./settlement.js").SettlementResult };

async function prepareCanonicalPaymentIntent(
    intent: PaymentIntentRecord,
    claimToken: string,
): Promise<PreparationOutcome> {
    if (intent.preparedTxHash || intent.preparedTxPayload) {
        if (!intent.preparedTxHash || !intent.preparedTxPayload) {
            throw new Error("Payment intent has incomplete prepared transaction state");
        }
        return {
            prepared: {
                network: intent.network,
                txHash: intent.preparedTxHash,
                payload: intent.preparedTxPayload,
                ...(intent.preparedTxNonce ? { nonce: intent.preparedTxNonce } : {}),
            },
        };
    }
    const persist = async (
        prepared: import("./settlement.js").PreparedSettlementTransaction,
        options: {
            leaseKey?: string;
            leaseValue?: string;
            nonceKey?: string;
            nextNonce?: string;
        } = {},
    ): Promise<PreparationOutcome> => {
        const preparedAt = Date.now();
        const persisted = await valkeyPersistPreparedPaymentIntent({
            intentKey: paymentIntentKey(intent.paymentIntentId),
            claimToken,
            preparedTxHash: prepared.txHash,
            preparedTxPayload: prepared.payload,
            preparedTxNonce: prepared.nonce,
            preparedAt,
            ...options,
        });
        if (persisted !== "persisted" && persisted !== "replayed") {
            throw new Error(`Prepared transaction persistence rejected: ${persisted}`);
        }
        return { prepared };
    };

    if (isEvmNetwork(intent.network)) {
        const evmNetwork = intent.network;
        const settlementModule = await import("./settlement.js");
        const signerIdentity = process.env.NODE_ENV === "test"
            ? "test-signer"
            : settlementModule.getEvmSettlementSignerIdentity();
        return withFencedSignerLease(evmNetwork, signerIdentity, async (lease) => {
            const nonceKey = signerStateKey("nonce", evmNetwork, signerIdentity);
            const storedNonce = await valkeyGet(nonceKey);
            const pendingNonce = process.env.NODE_ENV === "test"
                ? 0n
                : await settlementModule.getEvmSettlementPendingNonce(evmNetwork);
            const allocatedNonce = storedNonce && BigInt(storedNonce) > pendingNonce
                ? BigInt(storedNonce)
                : pendingNonce;
            const preparation = await prepareKeyPaymentOnChain(
                intent.userAddress,
                intent.finalAmountWei!,
                evmNetwork,
                { evmNonce: allocatedNonce, intentIdentity: intent.paymentIntentId },
            );
            if (!preparation.success) return { settlement: preparation.result };
            return persist(preparation.prepared, {
                leaseKey: lease.leaseKey,
                leaseValue: lease.leaseValue,
                nonceKey,
                nextNonce: (allocatedNonce + 1n).toString(),
            });
        });
    }

    const preparation = await prepareKeyPaymentOnChain(
        intent.userAddress,
        intent.finalAmountWei!,
        intent.network,
        { intentIdentity: intent.paymentIntentId },
    );
    if (!preparation.success) return { settlement: preparation.result };
    return persist(preparation.prepared);
}

function paymentIntentTerminalTtlSeconds(intent: PaymentIntentRecord, now: number): number {
    const credentialRemaining = Math.max(0, Math.ceil((intent.credentialExpiresAt - now) / 1000));
    return Math.max(TERMINAL_RETENTION_SECONDS, credentialRemaining);
}

function isDefinitiveSettlement(result: import("./settlement.js").SettlementResult): boolean {
    return (result.success && result.status === "confirmed" && Boolean(result.txHash))
        || (result.status === "failed" && result.terminal === true && Boolean(result.txHash));
}

export interface ExecuteCanonicalPaymentIntentOptions {
    waitForConfirmation?: boolean;
}

export async function executeCanonicalPaymentIntent(
    paymentIntentId: string,
    options: ExecuteCanonicalPaymentIntentOptions = {},
): Promise<PaymentIntentResult<SettledPaymentIntentBody>> {
    let claimToken: string | undefined;
    try {
        claimToken = randomUUID();
        const lastAttemptAt = Date.now();
        const claim = await valkeyClaimPaymentIntentExecution({
            intentKey: paymentIntentKey(paymentIntentId),
            claimToken,
            now: lastAttemptAt,
            claimExpiresAt: lastAttemptAt + EXECUTION_CLAIM_TTL_MS,
        });
        let intent = await readPaymentIntent(paymentIntentId);
        if (!intent || claim.outcome === "missing") return failure(404, "Payment intent not found");
        if (claim.outcome !== "claimed") {
            if (claim.outcome === "invalid_state" && intent.status === "authorized") {
                return failure(409, `Payment intent cannot execute from status ${intent.status}`);
            }
            return paymentIntentSuccess(intent);
        }
        if (!intent.finalAmountWei || BigInt(intent.finalAmountWei) <= 0n) {
            throw Object.assign(new Error("Payment intent has no billable reservation"), { statusCode: 409 });
        }

        const attemptCount = claim.attemptCount;
        const finalAmountWei = intent.finalAmountWei;
        let settlement: import("./settlement.js").SettlementResult;
        if (intent.status === "submitted") {
            if (!intent.txHash) throw new Error("Submitted payment intent is missing its transaction identity");
            if (!intent.preparedTxHash || !intent.preparedTxPayload) {
                throw new Error("Submitted payment intent is missing its durable prepared transaction");
            }
            if (intent.preparedTxHash !== intent.txHash) {
                throw new Error("Submitted payment intent transaction identity does not match its durable preparation");
            }
            settlement = await reconcileKeyPaymentOnChain(intent.txHash, intent.network);
        } else {
            const recoveringPreparedIdentity = Boolean(intent.preparedTxHash && intent.preparedTxPayload);
            const preparation = await prepareCanonicalPaymentIntent(intent, claimToken);
            if ("settlement" in preparation) {
                settlement = preparation.settlement;
            } else {
                intent = {
                    ...intent,
                    preparedTxHash: preparation.prepared.txHash,
                    preparedTxPayload: preparation.prepared.payload,
                    preparedTxNonce: preparation.prepared.nonce,
                };
                const reconciledBeforeBroadcast = recoveringPreparedIdentity
                    ? await reconcileKeyPaymentOnChain(preparation.prepared.txHash, intent.network)
                    : null;
                if (reconciledBeforeBroadcast && isDefinitiveSettlement(reconciledBeforeBroadcast)) {
                    settlement = reconciledBeforeBroadcast;
                } else {
                    try {
                        settlement = await broadcastPreparedKeyPaymentOnChain(preparation.prepared);
                    } catch (error) {
                        const reconciledAfterError = await reconcileKeyPaymentOnChain(
                            preparation.prepared.txHash,
                            intent.network,
                        );
                        if (!isDefinitiveSettlement(reconciledAfterError)) throw error;
                        settlement = reconciledAfterError;
                    }
                    if (settlement.status === "queued") {
                        const reconciledAfterBroadcast = await reconcileKeyPaymentOnChain(
                            preparation.prepared.txHash,
                            intent.network,
                        );
                        if (isDefinitiveSettlement(reconciledAfterBroadcast)) {
                            settlement = reconciledAfterBroadcast;
                        }
                    }
                }
            }

            // The deterministic identity and signed payload are durable before
            // this branch can broadcast. Once a broadcast may have occurred,
            // transition to submitted before receipt reconciliation; all later
            // attempts reconcile this hash and never construct another one.
            if (settlement.status !== "queued" && settlement.txHash) {
                const submittedAt = Date.now();
                const submitted = await valkeyMarkClaimedPaymentIntentSubmitted({
                    intentKey: paymentIntentKey(intent.paymentIntentId),
                    queuedKey: QUEUED_INTENTS_KEY,
                    submittedKey: SUBMITTED_INTENTS_KEY,
                    intentId: intent.paymentIntentId,
                    claimToken,
                    txHash: settlement.txHash,
                    submittedAt,
                    intentFields: {
                        error: settlement.error || "",
                        lastError: settlement.error || "",
                    },
                });
                if (submitted !== "updated") {
                    const current = await readPaymentIntent(intent.paymentIntentId);
                    if (!current) return failure(404, "Payment intent not found");
                    return paymentIntentSuccess(current);
                }
                const submittedIntent = await readPaymentIntent(intent.paymentIntentId);
                if (!submittedIntent) throw new Error("Submitted payment intent disappeared");
                intent = submittedIntent;

                if (options.waitForConfirmation !== false
                    && settlement.status === "submitted"
                    && !(process.env.NODE_ENV === "test" && process.env.COMPOSE_TEST_SETTLEMENT_STATUS === "submitted")) {
                    settlement = await reconcileKeyPaymentOnChain(settlement.txHash, intent.network, true);
                }
            }
        }

        const settlementStatus = settlement.status
            || (settlement.success && settlement.txHash ? "confirmed" : settlement.txHash ? "submitted" : "queued");
        if (settlementStatus === "confirmed" && settlement.success && settlement.txHash) {
            const confirmedAt = Date.now();
            const committed = await valkeyCommitReservedBudget({
                budgetKey: keyRecordKey(intent.keyId),
                intentKey: paymentIntentKey(intent.paymentIntentId),
                queuedKey: QUEUED_INTENTS_KEY,
                submittedKey: SUBMITTED_INTENTS_KEY,
                keyIntentsKey: keyPaymentIntentsKey(intent.keyId),
                idempotencyKey: idempotencyValkeyKey(intent),
                projectionKey: PROJECTION_INTENTS_KEY,
                dueKey: DUE_INTENTS_KEY,
                intentId: intent.paymentIntentId,
                terminalTtlSeconds: paymentIntentTerminalTtlSeconds(intent, confirmedAt),
                reservedAmount: intent.reservedAmountWei || finalAmountWei,
                finalAmount: finalAmountWei,
                lastUsedAt: confirmedAt,
                claimToken,
                expectedStatuses: ["queued", "submitted"],
                intentFields: {
                    status: "confirmed",
                    txHash: settlement.txHash,
                    updatedAt: String(confirmedAt),
                    confirmedAt: String(confirmedAt),
                    error: "",
                    lastError: "",
                    nextAttemptAt: "",
                },
            });
            if (committed !== "committed") {
                const current = await readPaymentIntent(intent.paymentIntentId);
                if (!current) return failure(404, "Payment intent not found");
                if (committed === "inconsistent_reservation") {
                    throw new Error("Payment intent reservation is inconsistent with its key budget");
                }
                return paymentIntentSuccess(current);
            }
            await publishInvalidationBestEffort("keys", intent.userAddress, "budget");
            await reconcileCanonicalPaymentIntentProjections(intent.paymentIntentId).catch((error) => {
                console.error("[payment-intent] projection deferred", {
                    paymentIntentId: intent.paymentIntentId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
            const confirmed = await readPaymentIntent(intent.paymentIntentId);
            if (!confirmed) throw new Error("Confirmed payment intent disappeared");
            return paymentIntentSuccess(confirmed);
        }

        const errorMessage = settlement.error || "Payment settlement is pending";
        if (settlementStatus === "failed" && settlement.terminal === true) {
            const failedAt = Date.now();
            const retainedTxHash = settlement.txHash || intent.txHash;
            const released = await valkeyReleaseReservedBudget({
                budgetKey: keyRecordKey(intent.keyId),
                intentKey: paymentIntentKey(intent.paymentIntentId),
                queuedKey: QUEUED_INTENTS_KEY,
                submittedKey: SUBMITTED_INTENTS_KEY,
                keyIntentsKey: keyPaymentIntentsKey(intent.keyId),
                idempotencyKey: idempotencyValkeyKey(intent),
                projectionKey: PROJECTION_INTENTS_KEY,
                dueKey: DUE_INTENTS_KEY,
                intentId: intent.paymentIntentId,
                terminalTtlSeconds: paymentIntentTerminalTtlSeconds(intent, failedAt),
                reservedAmount: intent.reservedAmountWei || finalAmountWei,
                claimToken,
                expectedStatuses: ["queued", "submitted"],
                intentFields: {
                    status: "failed",
                    txHash: retainedTxHash || "",
                    updatedAt: String(failedAt),
                    failedAt: String(failedAt),
                    error: errorMessage,
                    lastError: errorMessage,
                },
            });
            if (released !== "released") {
                const current = await readPaymentIntent(intent.paymentIntentId);
                if (!current) return failure(404, "Payment intent not found");
                if (released === "inconsistent_reservation") {
                    throw new Error("Payment intent reservation is inconsistent with its key budget");
                }
                return paymentIntentSuccess(current);
            }
            await publishInvalidationBestEffort("keys", intent.userAddress, "budget");
            await reconcileCanonicalPaymentIntentProjections(intent.paymentIntentId).catch((error) => {
                console.error("[payment-intent] failed projection deferred", {
                    paymentIntentId: intent.paymentIntentId,
                    txHash: retainedTxHash,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
            return buildPaymentRequiredFailure({
                resourceUrl: intent.resource,
                network: intent.network,
                amountWei: finalAmountWei,
                error: errorMessage,
            });
        }

        const nextStatus: "queued" | "submitted" = intent.status === "submitted" || settlement.status === "submitted" || intent.txHash
            ? "submitted"
            : "queued";
        const txHash = settlement.txHash || intent.txHash;
        const updatedAt = Date.now();
        const retained = await valkeyRetainClaimedPaymentIntent({
            intentKey: paymentIntentKey(intent.paymentIntentId),
            queuedKey: QUEUED_INTENTS_KEY,
            submittedKey: SUBMITTED_INTENTS_KEY,
            dueKey: DUE_INTENTS_KEY,
            intentId: intent.paymentIntentId,
            claimToken,
            status: nextStatus,
            txHash,
            dueAt: updatedAt + retryDelayMs(attemptCount),
            intentFields: {
                nextAttemptAt: String(updatedAt + retryDelayMs(attemptCount)),
                updatedAt: String(updatedAt),
                lastError: errorMessage,
                error: errorMessage,
            },
        });
        const pending = await readPaymentIntent(intent.paymentIntentId);
        if (!pending) throw new Error("Pending payment intent disappeared");
        if (retained === "invalid_state") {
            throw new Error("Payment intent changed state while retaining its retry obligation");
        }
        return paymentIntentSuccess(pending);
    } catch (error) {
        let current = await readPaymentIntent(paymentIntentId).catch(() => null);
        if (current?.status === "confirmed") return paymentIntentSuccess(current);
        if (claimToken && current && (current.status === "queued" || current.status === "submitted")) {
            const errorMessage = error instanceof Error ? error.message : "Payment execution failed";
            const nextStatus: "queued" | "submitted" = current.status === "submitted" ? "submitted" : "queued";
            const updatedAt = Date.now();
            await valkeyRetainClaimedPaymentIntent({
                intentKey: paymentIntentKey(current.paymentIntentId),
                queuedKey: QUEUED_INTENTS_KEY,
                submittedKey: SUBMITTED_INTENTS_KEY,
                dueKey: DUE_INTENTS_KEY,
                intentId: current.paymentIntentId,
                claimToken,
                status: nextStatus,
                txHash: nextStatus === "submitted" ? (current.txHash || current.preparedTxHash) : current.txHash,
                dueAt: updatedAt + retryDelayMs(current.attemptCount),
                intentFields: {
                    nextAttemptAt: String(updatedAt + retryDelayMs(current.attemptCount)),
                    updatedAt: String(updatedAt),
                    lastError: errorMessage,
                    error: errorMessage,
                },
            }).catch(() => "stale_claim" as const);
            current = await readPaymentIntent(paymentIntentId).catch(() => current);
        }
        const status = error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        return failure(status, error instanceof Error ? error.message : "Payment execution failed", {
            headers: status === 429 ? { "Retry-After": "1" } : {},
        });
    }
}

export async function listCanonicalPaymentIntentIds(limit = 100): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    return valkeyZRangeLiveWorkByScore({
        dueKey: DUE_INTENTS_KEY,
        queuedKey: QUEUED_INTENTS_KEY,
        submittedKey: SUBMITTED_INTENTS_KEY,
        maxScore: Date.now(),
        limit,
    });
}

export async function removeCanonicalPaymentIntentWorkId(paymentIntentId: string): Promise<void> {
    await Promise.all([
        valkeySRem(QUEUED_INTENTS_KEY, paymentIntentId),
        valkeySRem(SUBMITTED_INTENTS_KEY, paymentIntentId),
        valkeyZRem(DUE_INTENTS_KEY, paymentIntentId),
    ]);
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

            if (intent.status === "released") {
                const headers = await buildPaymentBudgetHeaders(intent);
                return {
                    ok: true,
                    status: 200,
                    body: {
                        paymentIntentId: intent.paymentIntentId,
                        status: "released",
                        reason: intent.error || input.reason,
                    },
                    headers,
                };
            }

            if (intent.status === "confirmed") {
                return failure(409, "Confirmed payment intents cannot be released");
            }
            if (intent.status === "queued" || intent.status === "submitted") {
                return failure(409, `Delivered ${intent.status} payment intents cannot be released`);
            }
            if (intent.status === "failed") {
                return failure(409, "Failed payment intents cannot be released");
            }

            const reservedAmount = BigInt(intent.reservedAmountWei || "0");
            const releasedAt = Date.now();
            const released = await valkeyReleaseReservedBudget({
                budgetKey: keyRecordKey(intent.keyId),
                intentKey: paymentIntentKey(intent.paymentIntentId),
                queuedKey: QUEUED_INTENTS_KEY,
                submittedKey: SUBMITTED_INTENTS_KEY,
                keyIntentsKey: keyPaymentIntentsKey(intent.keyId),
                idempotencyKey: idempotencyValkeyKey(intent),
                projectionKey: PROJECTION_INTENTS_KEY,
                dueKey: DUE_INTENTS_KEY,
                intentId: intent.paymentIntentId,
                terminalTtlSeconds: paymentIntentTerminalTtlSeconds(intent, releasedAt),
                reservedAmount,
                expectedStatuses: ["authorized"],
                intentFields: {
                    status: "released",
                    updatedAt: String(releasedAt),
                    releasedAt: String(releasedAt),
                    error: input.reason,
                },
            });
            if (released === "inconsistent_reservation") {
                throw Object.assign(
                    new Error("Payment intent reservation is inconsistent with its key budget"),
                    { statusCode: 500 },
                );
            }
            if (released === "released") {
                await publishInvalidationBestEffort("keys", intent.userAddress, "budget");
            }
            const releasedIntent = await readPaymentIntent(intent.paymentIntentId);
            if (!releasedIntent) return failure(404, "Payment intent not found");
            if (released !== "released" && releasedIntent.status !== "released") {
                return failure(409, `Payment intent cannot be released from status ${releasedIntent.status}`);
            }

            const headers = await buildPaymentBudgetHeaders(releasedIntent);
            return {
                ok: true,
                status: 200,
                body: {
                    paymentIntentId: intent.paymentIntentId,
                    status: "released",
                    reason: releasedIntent.error || input.reason,
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
