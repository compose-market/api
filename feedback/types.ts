export const FEEDBACK_TARGET_TYPES = ["endpoint", "x402", "model", "agent", "workflow"] as const;
export type FeedbackTargetType = typeof FEEDBACK_TARGET_TYPES[number];

export const FEEDBACK_CATEGORIES = [
    "general",
    "bug",
    "latency",
    "quality",
    "pricing",
    "settlement",
    "model_capability",
    "safety",
    "docs",
    "integration",
] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

export type FeedbackVerificationKind = "anonymous" | "wallet_header" | "compose_key";

export interface FeedbackTarget {
    type: FeedbackTargetType;
    id: string;
}

export interface FeedbackContext {
    requestId?: string;
    paymentIntentId?: string;
    composeRunId?: string;
    chainId?: number;
    modelId?: string;
    provider?: string;
    agentId?: string;
    agentWallet?: string;
    workflowId?: string;
    endpoint?: {
        method?: string;
        path?: string;
        url?: string;
    };
    receipt?: {
        network?: string;
        txHash?: string;
        finalAmountWei?: string;
    };
    sdk?: {
        name?: string;
        version?: string;
    };
}

export interface FeedbackSubmitInput {
    target: FeedbackTarget;
    category?: FeedbackCategory;
    rating?: number;
    message?: string;
    labels?: string[];
    context?: FeedbackContext;
    metadata?: Record<string, unknown>;
}

export interface FeedbackReviewer {
    kind: FeedbackVerificationKind;
    address?: string;
    chainId?: number;
}

export interface FeedbackRecord {
    id: string;
    target: FeedbackTarget;
    category: FeedbackCategory;
    rating?: number;
    message?: string;
    labels: string[];
    context: FeedbackContext;
    metadata: Record<string, unknown>;
    reviewer: FeedbackReviewer;
    createdAt: number;
}

export interface FeedbackPublicRecord {
    id: string;
    target: FeedbackTarget;
    category: FeedbackCategory;
    rating?: number;
    message?: string;
    labels: string[];
    context: FeedbackContext;
    metadata: Record<string, unknown>;
    verification: FeedbackVerificationKind;
    createdAt: number;
}

export interface FeedbackSubmitResponse {
    feedbackId: string;
    target: FeedbackTarget;
    verification: FeedbackVerificationKind;
    createdAt: number;
}

export interface FeedbackSummary {
    target: FeedbackTarget;
    count: number;
    ratingCount: number;
    ratingAverage: number | null;
    ratings: Record<"1" | "2" | "3" | "4" | "5", number>;
    categories: Record<FeedbackCategory, number>;
    verification: Record<FeedbackVerificationKind, number>;
    recent: FeedbackPublicRecord[];
}
