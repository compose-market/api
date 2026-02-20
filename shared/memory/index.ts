import { MongoClient, type Collection, type ObjectId } from "mongodb";
import {
    type MemoryVector,
    type SessionTranscript,
    MEMORY_VECTOR_INDEXES,
    TRANSCRIPT_INDEXES,
} from "../configs/mongodb/schemas.js";

function buildMongoMemoryUri(): string {
    if (process.env.MONGO_MEMORY_URI) {
        return process.env.MONGO_MEMORY_URI;
    }
    
    const user = process.env.MONGO_MEMORY_USER;
    const password = process.env.MONGO_MEMORY_PASSWORD;
    const cluster = process.env.MONGO_MEMORY_CLUSTER;
    const appName = process.env.MONGO_MEMORY_APP_NAME;
    
    if (!user || !password || !cluster) {
        throw new Error("MONGO_MEMORY_USER, MONGO_MEMORY_PASSWORD, and MONGO_MEMORY_CLUSTER are required");
    }
    
    const encodedPassword = encodeURIComponent(password);
    const appNameParam = appName ? `?appName=${appName}` : "";
    
    return `mongodb+srv://${user}:${encodedPassword}@${cluster}${appNameParam}`;
}

const MONGO_MEMORY_URI = buildMongoMemoryUri();
const MONGO_MEMORY_DB = process.env.MONGO_MEMORY_DB || "compose_memory";

let mongoClient: MongoClient | null = null;
let vectorsCollection: Collection<MemoryVector> | null = null;
let transcriptsCollection: Collection<SessionTranscript> | null = null;

export async function getMemoryCollections(): Promise<{
    vectors: Collection<MemoryVector>;
    transcripts: Collection<SessionTranscript>;
}> {
    if (vectorsCollection && transcriptsCollection) {
        return { vectors: vectorsCollection, transcripts: transcriptsCollection };
    }

    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_MEMORY_URI);
        await mongoClient.connect();
    }

    const db = mongoClient.db(MONGO_MEMORY_DB);

    vectorsCollection = db.collection<MemoryVector>("memory");
    transcriptsCollection = db.collection<SessionTranscript>("session_transcripts");

    try {
        for (const indexSpec of MEMORY_VECTOR_INDEXES) {
            await vectorsCollection.createIndex(indexSpec.key, { name: indexSpec.name });
        }
        for (const indexSpec of TRANSCRIPT_INDEXES) {
            await transcriptsCollection.createIndex(indexSpec.key, { name: indexSpec.name, unique: indexSpec.name.includes("unique") });
        }
    } catch {
        // Indexes may already exist
    }

    return { vectors: vectorsCollection, transcripts: transcriptsCollection };
}

export async function closeMemoryConnection(): Promise<void> {
    if (mongoClient) {
        await mongoClient.close();
        mongoClient = null;
        vectorsCollection = null;
        transcriptsCollection = null;
    }
}

export interface VectorSearchResult {
    id: string;
    vectorId: string;
    content: string;
    score: number;
    source: MemoryVector["source"];
    agentWallet: string;
    userId?: string;
    threadId?: string;
    decayScore: number;
    accessCount: number;
    createdAt: number;
}

export interface HybridSearchParams {
    agentWallet: string;
    userId?: string;
    threadId?: string;
    query: string;
    queryEmbedding: number[];
    limit?: number;
    threshold?: number;
    applyDecay?: boolean;
    mmrLambda?: number;
}

export async function hybridVectorSearch(params: HybridSearchParams): Promise<VectorSearchResult[]> {
    const { vectors } = await getMemoryCollections();
    const limit = params.limit || 10;
    const threshold = params.threshold || 0.7;

    const filter: Record<string, unknown> = { agentWallet: params.agentWallet };
    if (params.userId) filter.userId = params.userId;
    if (params.threadId) filter.threadId = params.threadId;

    const pipeline: object[] = [
        {
            $vectorSearch: {
                index: "vector_index",
                path: "embedding",
                queryVector: params.queryEmbedding,
                numCandidates: limit * 10,
                limit: limit * 2,
                filter
            }
        },
        {
            $addFields: {
                rawScore: { $meta: "vectorSearchScore" }
            }
        }
    ];

    if (params.applyDecay !== false) {
        pipeline.push({
            $addFields: {
                adjustedScore: {
                    $multiply: ["$rawScore", "$decayScore"]
                }
            }
        });
    } else {
        pipeline.push({
            $addFields: {
                adjustedScore: "$rawScore"
            }
        });
    }

    pipeline.push({
        $match: {
            adjustedScore: { $gte: threshold }
        }
    });

    pipeline.push({
        $sort: { adjustedScore: -1 }
    });
    pipeline.push({ $limit: limit });

    const rawResults = await vectors.aggregate<{
        vectorId: string;
        content: string;
        rawScore: number;
        adjustedScore: number;
        source: MemoryVector["source"];
        agentWallet: string;
        userId?: string;
        threadId?: string;
        decayScore: number;
        accessCount: number;
        createdAt: number;
    }>(pipeline).toArray();

    const results: VectorSearchResult[] = rawResults.map(r => ({
        id: r.vectorId,
        vectorId: r.vectorId,
        content: r.content,
        score: r.adjustedScore,
        source: r.source,
        agentWallet: r.agentWallet,
        userId: r.userId,
        threadId: r.threadId,
        decayScore: r.decayScore,
        accessCount: r.accessCount,
        createdAt: r.createdAt,
    }));

    if (params.mmrLambda !== undefined && results.length > 1) {
        return applyMMR(results, params.mmrLambda, limit);
    }

    return results;
}

function applyMMR(results: VectorSearchResult[], lambda: number, limit: number): VectorSearchResult[] {
    const selected: VectorSearchResult[] = [];
    const remaining = [...results];

    while (selected.length < limit && remaining.length > 0) {
        let bestIdx = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].score;
            let maxOverlap = 0;

            for (const s of selected) {
                const overlap = textOverlap(remaining[i].content, s.content);
                if (overlap > maxOverlap) maxOverlap = overlap;
            }

            const mmrScore = lambda * relevance - (1 - lambda) * maxOverlap;
            if (mmrScore > bestScore) {
                bestScore = mmrScore;
                bestIdx = i;
            }
        }

        selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
}

function textOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    let overlap = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) overlap++;
    }
    return overlap / Math.max(wordsA.size, wordsB.size);
}

export interface VectorIndexParams {
    agentWallet: string;
    userId?: string;
    threadId?: string;
    content: string;
    embedding: number[];
    source: MemoryVector["source"];
    decayScore?: number;
    metadata?: Record<string, unknown>;
}

export async function indexVector(params: VectorIndexParams): Promise<{ vectorId: string }> {
    const { vectors } = await getMemoryCollections();
    const now = Date.now();

    const vectorId = `vec_${params.agentWallet.slice(0, 8)}_${now}`;

    const doc: MemoryVector = {
        vectorId,
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
        content: params.content,
        embedding: params.embedding,
        source: params.source,
        decayScore: params.decayScore ?? 1.0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        updatedAt: now,
    };

    await vectors.insertOne(doc);

    return { vectorId };
}

export interface TranscriptStoreParams {
    sessionId: string;
    threadId: string;
    agentWallet: string;
    messages: SessionTranscript["messages"];
    userId?: string;
    summary?: string;
    summaryEmbedding?: number[];
    tokenCount: number;
    metadata?: SessionTranscript["metadata"];
}

export async function storeTranscript(params: TranscriptStoreParams): Promise<{ success: boolean }> {
    const { transcripts } = await getMemoryCollections();

    const doc: SessionTranscript = {
        sessionId: params.sessionId,
        threadId: params.threadId,
        agentWallet: params.agentWallet,
        userId: params.userId,
        messages: params.messages,
        summary: params.summary,
        summaryEmbedding: params.summaryEmbedding,
        tokenCount: params.tokenCount,
        metadata: params.metadata || {
            modelUsed: "unknown",
            totalTokens: params.tokenCount,
            contextWindow: 128000,
        },
        createdAt: Date.now(),
    };

    await transcripts.updateOne(
        { sessionId: params.sessionId },
        { $set: doc },
        { upsert: true }
    );

    return { success: true };
}

export async function getTranscriptByThreadId(threadId: string): Promise<SessionTranscript | null> {
    const { transcripts } = await getMemoryCollections();
    return transcripts.findOne({ threadId });
}

export async function getTranscriptBySessionId(sessionId: string): Promise<SessionTranscript | null> {
    const { transcripts } = await getMemoryCollections();
    return transcripts.findOne({ sessionId });
}

export interface MemoryStats {
    totalVectors: number;
    totalTranscripts: number;
    avgDecayScore: number;
    oldestVector: number;
    newestVector: number;
    byType: Record<string, number>;
}

export async function getMemoryStats(agentWallet?: string): Promise<MemoryStats> {
    const { vectors, transcripts } = await getMemoryCollections();

    const vectorFilter = agentWallet ? { agentWallet } : {};

    const [totalVectors, totalTranscripts, avgDecay, oldest, newest, typeBreakdown] = await Promise.all([
        vectors.countDocuments(vectorFilter),
        transcripts.countDocuments(agentWallet ? { agentWallet } : {}),
        vectors.aggregate<{ avg: number }>([
            { $match: vectorFilter },
            { $group: { _id: null, avg: { $avg: "$decayScore" } } }
        ]).toArray(),
        vectors.find(vectorFilter).sort({ createdAt: 1 }).limit(1).toArray(),
        vectors.find(vectorFilter).sort({ createdAt: -1 }).limit(1).toArray(),
        vectors.aggregate<{ _id: string; count: number }>([
            { $match: vectorFilter },
            { $group: { _id: "$source", count: { $sum: 1 } } }
        ]).toArray(),
    ]);

    const byType: Record<string, number> = {};
    for (const t of typeBreakdown) {
        byType[t._id || "unknown"] = t.count;
    }

    return {
        totalVectors,
        totalTranscripts,
        avgDecayScore: avgDecay[0]?.avg || 0,
        oldestVector: oldest[0]?.createdAt || 0,
        newestVector: newest[0]?.createdAt || 0,
        byType,
    };
}

export async function updateDecayScores(halfLifeDays: number = 30): Promise<{ updated: number }> {
    const { vectors } = await getMemoryCollections();
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const allVectors = await vectors.find({}).toArray();
    let updated = 0;

    for (const vec of allVectors) {
        const ageMs = now - vec.createdAt;
        const decayScore = Math.pow(0.5, ageMs / halfLifeMs);

        await vectors.updateOne(
            { vectorId: vec.vectorId },
            { $set: { decayScore } }
        );
        updated++;
    }

    return { updated };
}

export interface RerankParams {
    query: string;
    documents: Array<{ content: string; score?: number }>;
    topK?: number;
}

export async function rerankDocuments(params: RerankParams): Promise<Array<{ content: string; score: number }>> {
    const documents = params.documents.map(d => ({
        content: d.content,
        score: d.score || 0,
        originalScore: d.score || 0,
    }));

    const queryLower = params.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/);

    for (const doc of documents) {
        const contentLower = doc.content.toLowerCase();
        let keywordBoost = 0;

        for (const term of queryTerms) {
            if (contentLower.includes(term)) {
                keywordBoost += 0.1;
            }
        }

        doc.score = doc.originalScore * 0.7 + keywordBoost * 0.3;
    }

    documents.sort((a, b) => b.score - a.score);

    const topK = params.topK || documents.length;
    return documents.slice(0, topK).map(d => ({ content: d.content, score: d.score }));
}