import { randomUUID } from "node:crypto";

import {
    redisHGetAll,
    redisHSet,
    redisSAdd,
    redisSMembers,
} from "../x402/keys/redis.js";
import {
    FEEDBACK_CATEGORIES,
    type FeedbackCategory,
    type FeedbackRecord,
    type FeedbackReviewer,
    type FeedbackSubmitInput,
    type FeedbackSummary,
    type FeedbackTarget,
    type FeedbackVerificationKind,
} from "./types.js";
import { toPublicFeedback } from "./validation.js";

const RECORD_PREFIX = "feedback:record:";
const TARGET_PREFIX = "feedback:target:";

function feedbackId(): string {
    return `fb_${randomUUID().replace(/-/g, "")}`;
}

function targetKey(target: FeedbackTarget): string {
    return `${TARGET_PREFIX}${target.type}:${Buffer.from(target.id, "utf-8").toString("base64url")}`;
}

function recordKey(id: string): string {
    return `${RECORD_PREFIX}${id}`;
}

function serializeRecord(record: FeedbackRecord): Record<string, string> {
    return {
        id: record.id,
        targetType: record.target.type,
        targetId: record.target.id,
        category: record.category,
        rating: record.rating === undefined ? "" : String(record.rating),
        message: record.message || "",
        labels: JSON.stringify(record.labels),
        context: JSON.stringify(record.context),
        metadata: JSON.stringify(record.metadata),
        reviewerKind: record.reviewer.kind,
        reviewerAddress: record.reviewer.address || "",
        reviewerChainId: record.reviewer.chainId === undefined ? "" : String(record.reviewer.chainId),
        createdAt: String(record.createdAt),
    };
}

function parseJson<T>(value: string | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function parseRecord(data: Record<string, string>): FeedbackRecord | null {
    if (!data.id || !data.targetType || !data.targetId || !data.category || !data.createdAt) {
        return null;
    }

    const reviewer: FeedbackReviewer = {
        kind: (data.reviewerKind || "anonymous") as FeedbackVerificationKind,
        ...(data.reviewerAddress ? { address: data.reviewerAddress } : {}),
        ...(data.reviewerChainId ? { chainId: parseInt(data.reviewerChainId, 10) } : {}),
    };

    return {
        id: data.id,
        target: {
            type: data.targetType as FeedbackRecord["target"]["type"],
            id: data.targetId,
        },
        category: data.category as FeedbackCategory,
        ...(data.rating ? { rating: parseInt(data.rating, 10) } : {}),
        ...(data.message ? { message: data.message } : {}),
        labels: parseJson<string[]>(data.labels, []),
        context: parseJson<Record<string, unknown>>(data.context, {}),
        metadata: parseJson<Record<string, unknown>>(data.metadata, {}),
        reviewer,
        createdAt: parseInt(data.createdAt, 10),
    };
}

async function readRecord(id: string): Promise<FeedbackRecord | null> {
    const data = await redisHGetAll(recordKey(id));
    if (!data || Object.keys(data).length === 0) {
        return null;
    }
    return parseRecord(data);
}

export async function createFeedbackRecord(
    input: FeedbackSubmitInput,
    reviewer: FeedbackReviewer,
): Promise<FeedbackRecord> {
    const now = Date.now();
    const record: FeedbackRecord = {
        id: feedbackId(),
        target: input.target,
        category: input.category || "general",
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.message ? { message: input.message } : {}),
        labels: input.labels || [],
        context: input.context || {},
        metadata: input.metadata || {},
        reviewer,
        createdAt: now,
    };

    await redisHSet(recordKey(record.id), serializeRecord(record));
    await redisSAdd(targetKey(record.target), record.id);
    return record;
}

export async function listFeedbackRecords(
    target: FeedbackTarget,
    limit: number,
): Promise<FeedbackRecord[]> {
    const ids = await redisSMembers(targetKey(target));
    const records = (await Promise.all(ids.map((id) => readRecord(id))))
        .filter((record): record is FeedbackRecord => Boolean(record))
        .sort((a, b) => b.createdAt - a.createdAt);

    return records.slice(0, limit);
}

export async function summarizeFeedback(
    target: FeedbackTarget,
    recentLimit: number,
): Promise<FeedbackSummary> {
    const ids = await redisSMembers(targetKey(target));
    const records = (await Promise.all(ids.map((id) => readRecord(id))))
        .filter((record): record is FeedbackRecord => Boolean(record))
        .sort((a, b) => b.createdAt - a.createdAt);

    const ratings: FeedbackSummary["ratings"] = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    const categories = Object.fromEntries(
        FEEDBACK_CATEGORIES.map((category) => [category, 0]),
    ) as Record<FeedbackCategory, number>;
    const verification: Record<FeedbackVerificationKind, number> = {
        anonymous: 0,
        wallet_header: 0,
        compose_key: 0,
    };

    let ratingCount = 0;
    let ratingSum = 0;
    for (const record of records) {
        categories[record.category] += 1;
        verification[record.reviewer.kind] += 1;
        if (record.rating !== undefined) {
            const key = String(record.rating) as keyof FeedbackSummary["ratings"];
            ratings[key] += 1;
            ratingCount += 1;
            ratingSum += record.rating;
        }
    }

    return {
        target,
        count: records.length,
        ratingCount,
        ratingAverage: ratingCount > 0 ? Number((ratingSum / ratingCount).toFixed(2)) : null,
        ratings,
        categories,
        verification,
        recent: records.slice(0, recentLimit).map(toPublicFeedback),
    };
}
