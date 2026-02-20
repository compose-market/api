import type { IndexDirection, ObjectId } from "mongodb";

export interface ProceduralPattern {
    _id?: ObjectId;
    patternId: string;
    agentWallet: string;
    patternType: "workflow" | "decision" | "response" | "tool_sequence";
    trigger: {
        type: "intent" | "keyword" | "context" | "state";
        value: string;
        conditions?: Record<string, unknown>;
    };
    steps: Array<{
        action: string;
        params?: Record<string, unknown>;
        expectedOutcome?: string;
        order: number;
    }>;
    summary: string;
    embedding?: number[];
    successRate: number;
    executionCount: number;
    lastExecuted: number;
    metadata?: {
        taskType?: string;
        tags?: string[];
        sourceRunId?: string;
    };
    createdAt: number;
    updatedAt?: number;
}

export interface MemoryArchive {
    _id?: ObjectId;
    archiveId: string;
    agentWallet: string;
    summary: string;
    summaryEmbedding?: number[];
    content: string;
    contentEmbedding?: number[];
    compressed: boolean;
    ipfsCid?: string;
    dateRange: {
        start: number;
        end: number;
    };
    metadata?: {
        entryCount?: number;
        originalSize?: number;
        compressedSize?: number;
        topics?: string[];
    };
    createdAt: number;
    expiresAt?: number;
}

export interface SkillDocument {
    _id?: ObjectId;
    skillId: string;
    name: string;
    description: string;
    descriptionEmbedding?: number[];
    category: string;
    trigger: {
        type: "intent" | "keyword" | "pattern";
        patterns: string[];
    };
    spawnConfig: {
        skillType: "learned" | "custom" | "builtin";
        systemPrompt?: string;
        tools?: string[];
        maxSteps?: number;
        conditions?: Record<string, unknown>;
    };
    successRate: number;
    usageCount: number;
    creator: string;
    agents: string[];
    tags?: string[];
    createdAt: number;
    updatedAt?: number;
}

export interface SessionMemory {
    _id?: ObjectId;
    sessionId: string;
    agentWallet: string;
    workingMemory: {
        context: string[];
        entities: Record<string, unknown>;
        state: Record<string, unknown>;
    };
    compressed: boolean;
    createdAt: number;
    expiresAt: number;
    lastAccessedAt: number;
}

export const PATTERN_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_agent_wallet" },
    { key: { patternId: 1 }, name: "idx_pattern_id" },
    { key: { agentWallet: 1, patternType: 1 }, name: "idx_wallet_type" },
    { key: { "trigger.type": 1, "trigger.value": 1 }, name: "idx_trigger_lookup" },
    { key: { successRate: -1 }, name: "idx_success_rate" },
    { key: { lastExecuted: -1 }, name: "idx_last_executed" },
    { key: { agentWallet: 1, successRate: -1 }, name: "idx_wallet_success" },
];

export const ARCHIVE_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_archive_wallet" },
    { key: { archiveId: 1 }, name: "idx_archive_id" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_wallet_created" },
    { key: { "dateRange.start": 1, "dateRange.end": 1 }, name: "idx_date_range" },
];

export const SKILL_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { skillId: 1 }, name: "idx_skill_id" },
    { key: { creator: 1 }, name: "idx_creator" },
    { key: { "trigger.type": 1 }, name: "idx_trigger_type" },
    { key: { successRate: -1, usageCount: -1 }, name: "idx_success_usage" },
    { key: { agents: 1 }, name: "idx_agents" },
    { key: { category: 1 }, name: "idx_category" },
];

export const SESSION_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { sessionId: 1 }, name: "idx_session_id" },
    { key: { agentWallet: 1 }, name: "idx_session_wallet" },
    { key: { expiresAt: 1 }, name: "idx_session_ttl" },
    { key: { lastAccessedAt: -1 }, name: "idx_last_accessed" },
];

export type PatternFilter = {
    agentWallet?: string;
    patternType?: ProceduralPattern["patternType"];
    minSuccessRate?: number;
    minExecutionCount?: number;
    triggerType?: ProceduralPattern["trigger"]["type"];
    tags?: string[];
};

export type ArchiveFilter = {
    agentWallet?: string;
    dateRange?: { start: number; end: number };
    topics?: string[];
    hasIpfs?: boolean;
};

export type SkillFilter = {
    creator?: string;
    agents?: string[];
    category?: string;
    tags?: string[];
    minSuccessRate?: number;
};

export type SessionQuery = {
    sessionId?: string;
    agentWallet?: string;
    active?: boolean;
};

export interface MemoryVector {
    _id?: ObjectId;
    vectorId: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    content: string;
    embedding: number[];
    source: "session" | "knowledge" | "pattern" | "archive" | "fact";
    decayScore: number;
    accessCount: number;
    lastAccessedAt: number;
    createdAt: number;
    updatedAt: number;
}

export interface SessionTranscript {
    _id?: ObjectId;
    sessionId: string;
    threadId: string;
    agentWallet: string;
    userId?: string;
    messages: Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        timestamp: number;
        toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    }>;
    summary?: string;
    summaryEmbedding?: number[];
    tokenCount: number;
    metadata: {
        modelUsed: string;
        totalTokens: number;
        contextWindow: number;
    };
    createdAt: number;
    expiresAt?: number;
}

export const MEMORY_VECTOR_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_vector_wallet" },
    { key: { vectorId: 1 }, name: "idx_vector_id" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_wallet_created" },
    { key: { agentWallet: 1, threadId: 1 }, name: "idx_wallet_thread" },
    { key: { userId: 1 }, name: "idx_user_id" },
    { key: { source: 1 }, name: "idx_source" },
    { key: { decayScore: -1 }, name: "idx_decay_score" },
    { key: { lastAccessedAt: -1 }, name: "idx_last_accessed" },
];

export const TRANSCRIPT_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { sessionId: 1 }, name: "idx_session_id" },
    { key: { threadId: 1 }, name: "idx_thread_id" },
    { key: { agentWallet: 1 }, name: "idx_transcript_wallet" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_wallet_created" },
    { key: { userId: 1 }, name: "idx_user_id" },
];

export const MEMORY_COLLECTION_NAME = "memory";
export const TRANSCRIPT_COLLECTION_NAME = "session_transcripts";

export const ATLAS_VECTOR_SEARCH_INDEX = {
    name: "vector_index",
    type: "vectorSearch",
    definition: {
        mappings: {
            dynamic: false,
            fields: {
                embedding: {
                    type: "knnVector",
                    dimensions: 1024,
                    similarity: "cosine",
                },
                agentWallet: { type: "token" },
                userId: { type: "token" },
                threadId: { type: "token" },
                source: { type: "token" },
                decayScore: { type: "number" },
                createdAt: { type: "date" },
            },
        },
    },
};

/**
 * MongoDB Atlas Vector Search Index Creation
 * 
 * Collection: 'memory'
 * 
 * full schema:
 * 
 * db.memory.createSearchIndex({
 *   "name": "vector_index",
 *   "type": "vectorSearch",
 *   "definition": {
 *     "mappings": {
 *       "dynamic": false,
 *       "fields": {
 *         "embedding": {
 *           "type": "knnVector",
 *           "dimensions": 1024,
 *           "similarity": "cosine"
 *         },
 *         "agentWallet": { "type": "token" },
 *         "userId": { "type": "token" },
 *         "threadId": { "type": "token" },
 *         "source": { "type": "token" },
 *         "decayScore": { "type": "number" },
 *         "createdAt": { "type": "date" }
 *       }
 *     }
 *   }
 * });
 * 
 * Atlas UI JSON Editor:
 * {
 *   "fields": [
 *     { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
 *     { "type": "filter", "path": "agentWallet" },
 *     { "type": "filter", "path": "userId" },
 *     { "type": "filter", "path": "threadId" },
 *     { "type": "filter", "path": "source" },
 *     { "type": "filter", "path": "decayScore" },
 *     { "type": "filter", "path": "createdAt" }
 *   ]
 * }
 */