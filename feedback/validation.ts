import {
    FEEDBACK_CATEGORIES,
    FEEDBACK_TARGET_TYPES,
    type FeedbackCategory,
    type FeedbackContext,
    type FeedbackPublicRecord,
    type FeedbackRecord,
    type FeedbackSubmitInput,
    type FeedbackTarget,
    type FeedbackTargetType,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9_.:/@#?&=%+-]{1,512}$/;
const SAFE_LABEL = /^[A-Za-z0-9_.:/@#+-]{1,64}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
    if (depth > 4) return undefined;
    if (value === null) return null;
    if (typeof value === "string") return value.length > 2048 ? value.slice(0, 2048) : value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) {
        return value
            .slice(0, 50)
            .map((item) => sanitizeJsonValue(item, depth + 1))
            .filter((item) => item !== undefined);
    }
    if (isRecord(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value).slice(0, 50)) {
            const cleanKey = sanitizeString(key, 80);
            if (!cleanKey) continue;
            const cleanValue = sanitizeJsonValue(nested, depth + 1);
            if (cleanValue !== undefined) out[cleanKey] = cleanValue;
        }
        return out;
    }
    return undefined;
}

function readTarget(value: unknown): FeedbackTarget {
    if (!isRecord(value)) {
        throw new Error("target is required");
    }

    const type = sanitizeString(value.type, 32) as FeedbackTargetType | undefined;
    if (!type || !FEEDBACK_TARGET_TYPES.includes(type)) {
        throw new Error("target.type must be endpoint, x402, model, agent, or workflow");
    }

    const id = sanitizeString(value.id, 512);
    if (!id || !SAFE_ID.test(id)) {
        throw new Error("target.id must be a safe non-empty identifier");
    }

    return { type, id };
}

function readCategory(value: unknown): FeedbackCategory {
    const category = sanitizeString(value, 64) as FeedbackCategory | undefined;
    if (!category) return "general";
    if (!FEEDBACK_CATEGORIES.includes(category)) {
        throw new Error(`category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}`);
    }
    return category;
}

function readRating(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error("rating must be an integer from 1 to 5");
    }
    return value;
}

function readLabels(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error("labels must be an array");
    }

    const labels = new Set<string>();
    for (const item of value.slice(0, 20)) {
        const label = sanitizeString(item, 64);
        if (!label || !SAFE_LABEL.test(label)) {
            throw new Error("labels must contain safe strings up to 64 characters");
        }
        labels.add(label);
    }
    return [...labels];
}

function readPositiveInteger(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
    return value;
}

function readContext(value: unknown): FeedbackContext {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) {
        throw new Error("context must be an object");
    }

    const context: FeedbackContext = {};

    const requestId = sanitizeString(value.requestId, 128);
    if (requestId) {
        if (!SAFE_REQUEST_ID.test(requestId)) throw new Error("context.requestId is not safe");
        context.requestId = requestId;
    }

    const paymentIntentId = sanitizeString(value.paymentIntentId, 128);
    if (paymentIntentId) context.paymentIntentId = paymentIntentId;

    const composeRunId = sanitizeString(value.composeRunId, 160);
    if (composeRunId) context.composeRunId = composeRunId;

    const chainId = readPositiveInteger(value.chainId);
    if (chainId) context.chainId = chainId;

    const modelId = sanitizeString(value.modelId, 256);
    if (modelId) context.modelId = modelId;

    const provider = sanitizeString(value.provider, 128);
    if (provider) context.provider = provider;

    const agentId = sanitizeString(value.agentId, 256);
    if (agentId) context.agentId = agentId;

    const agentWallet = sanitizeString(value.agentWallet, 64);
    if (agentWallet) {
        if (!EVM_ADDRESS.test(agentWallet)) throw new Error("context.agentWallet must be an EVM address");
        context.agentWallet = agentWallet.toLowerCase();
    }

    const workflowId = sanitizeString(value.workflowId, 256);
    if (workflowId) context.workflowId = workflowId;

    if (isRecord(value.endpoint)) {
        const endpoint: NonNullable<FeedbackContext["endpoint"]> = {};
        const method = sanitizeString(value.endpoint.method, 16);
        if (method) endpoint.method = method.toUpperCase();
        const path = sanitizeString(value.endpoint.path, 512);
        if (path) endpoint.path = path;
        const url = sanitizeString(value.endpoint.url, 1024);
        if (url) endpoint.url = url;
        if (Object.keys(endpoint).length > 0) context.endpoint = endpoint;
    }

    if (isRecord(value.receipt)) {
        const receipt: NonNullable<FeedbackContext["receipt"]> = {};
        const network = sanitizeString(value.receipt.network, 64);
        if (network) receipt.network = network;
        const txHash = sanitizeString(value.receipt.txHash, 128);
        if (txHash) receipt.txHash = txHash;
        const finalAmountWei = sanitizeString(value.receipt.finalAmountWei, 80);
        if (finalAmountWei) receipt.finalAmountWei = finalAmountWei;
        if (Object.keys(receipt).length > 0) context.receipt = receipt;
    }

    if (isRecord(value.sdk)) {
        const sdk: NonNullable<FeedbackContext["sdk"]> = {};
        const name = sanitizeString(value.sdk.name, 80);
        if (name) sdk.name = name;
        const version = sanitizeString(value.sdk.version, 80);
        if (version) sdk.version = version;
        if (Object.keys(sdk).length > 0) context.sdk = sdk;
    }

    return context;
}

export function normalizeFeedbackInput(input: unknown): FeedbackSubmitInput {
    if (!isRecord(input)) {
        throw new Error("request body must be a JSON object");
    }

    const message = sanitizeString(input.message, 4000);
    const rating = readRating(input.rating);

    if (!message && rating === undefined) {
        throw new Error("provide at least one of message or rating");
    }

    const metadata = sanitizeJsonValue(input.metadata);

    return {
        target: readTarget(input.target),
        category: readCategory(input.category),
        ...(rating !== undefined ? { rating } : {}),
        ...(message ? { message } : {}),
        labels: readLabels(input.labels),
        context: readContext(input.context),
        metadata: isRecord(metadata) ? metadata : {},
    };
}

export function toPublicFeedback(record: FeedbackRecord): FeedbackPublicRecord {
    return {
        id: record.id,
        target: record.target,
        category: record.category,
        ...(record.rating !== undefined ? { rating: record.rating } : {}),
        ...(record.message ? { message: record.message } : {}),
        labels: record.labels,
        context: record.context,
        metadata: record.metadata,
        verification: record.reviewer.kind,
        createdAt: record.createdAt,
    };
}
