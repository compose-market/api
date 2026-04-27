import type { Express, Request, Response } from "express";

import { buildError } from "../http/errors.js";
import { extractComposeKeyFromHeader, validateComposeKey } from "../x402/keys/middleware.js";
import {
    FEEDBACK_TARGET_TYPES,
    type FeedbackReviewer,
    type FeedbackTarget,
    type FeedbackTargetType,
} from "./types.js";
import { createFeedbackRecord, listFeedbackRecords, summarizeFeedback } from "./storage.js";
import { normalizeFeedbackInput, toPublicFeedback } from "./validation.js";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function getHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    if (typeof value === "string") return value;
    return undefined;
}

function parseLimit(value: unknown, fallback: number): number {
    const parsed = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 1), 100);
}

function parseTargetFromQuery(req: Request): FeedbackTarget {
    const type = String(req.query.targetType || "").trim() as FeedbackTargetType;
    const id = String(req.query.targetId || "").trim();
    if (!type || !FEEDBACK_TARGET_TYPES.includes(type)) {
        throw new Error("targetType query parameter is required");
    }
    if (!id) {
        throw new Error("targetId query parameter is required");
    }
    return { type, id };
}

async function resolveReviewer(req: Request): Promise<FeedbackReviewer> {
    const authorization = getHeader(req, "authorization") || "";
    const token = extractComposeKeyFromHeader(authorization);
    if (token) {
        const validation = await validateComposeKey(token, 0);
        if (validation.valid && validation.payload) {
            return {
                kind: "compose_key",
                address: validation.payload.sub.toLowerCase(),
                ...(validation.record?.chainId ? { chainId: validation.record.chainId } : {}),
            };
        }
    }

    const address = getHeader(req, "x-session-user-address");
    const chainIdRaw = getHeader(req, "x-chain-id");
    const chainId = chainIdRaw ? parseInt(chainIdRaw, 10) : undefined;
    if (address && EVM_ADDRESS.test(address)) {
        const hasValidChainId = typeof chainId === "number" && Number.isInteger(chainId) && chainId > 0;
        return {
            kind: "wallet_header",
            address: address.toLowerCase(),
            ...(hasValidChainId ? { chainId } : {}),
        };
    }

    return { kind: "anonymous" };
}

async function handleSubmitFeedback(req: Request, res: Response): Promise<void> {
    try {
        const input = normalizeFeedbackInput(req.body);
        const reviewer = await resolveReviewer(req);
        const record = await createFeedbackRecord(input, reviewer);

        res.status(201).json({
            feedbackId: record.id,
            target: record.target,
            verification: record.reviewer.kind,
            createdAt: record.createdAt,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid feedback request";
        res.status(400).json(buildError("validation_error", message));
    }
}

async function handleListFeedback(req: Request, res: Response): Promise<void> {
    try {
        const target = parseTargetFromQuery(req);
        const limit = parseLimit(req.query.limit, 50);
        const records = await listFeedbackRecords(target, limit);
        res.status(200).json({
            object: "list",
            data: records.map(toPublicFeedback),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid feedback query";
        res.status(400).json(buildError("validation_error", message));
    }
}

async function handleFeedbackSummary(req: Request, res: Response): Promise<void> {
    try {
        const target = parseTargetFromQuery(req);
        const recentLimit = parseLimit(req.query.recentLimit, 10);
        res.status(200).json(await summarizeFeedback(target, recentLimit));
    } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid feedback query";
        res.status(400).json(buildError("validation_error", message));
    }
}

export function registerFeedbackRoutes(app: Express): void {
    app.post("/v1/feedback", (req, res, next) => {
        void handleSubmitFeedback(req, res).catch(next);
    });
    app.get("/v1/feedback", (req, res, next) => {
        void handleListFeedback(req, res).catch(next);
    });
    app.get("/v1/feedback/summary", (req, res, next) => {
        void handleFeedbackSummary(req, res).catch(next);
    });
}
