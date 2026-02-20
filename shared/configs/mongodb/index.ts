import { MongoClient, MongoClientOptions, Db, Collection } from "mongodb";
import {
    PATTERN_INDEXES,
    ARCHIVE_INDEXES,
    SKILL_INDEXES,
    SESSION_INDEXES,
    ProceduralPattern,
    MemoryArchive,
    SkillDocument,
    SessionMemory,
} from "./schemas.js";

const MONGO_MEMORY_USER = process.env.MONGO_MEMORY_USER;
const MONGO_MEMORY_PASSWORD = process.env.MONGO_MEMORY_PASSWORD;
const MONGO_MEMORY_CLUSTER = process.env.MONGO_MEMORY_CLUSTER;

const DB_NAME = "compose-memory";

let client: MongoClient | null = null;
let db: Db | null = null;
let connectionPromise: Promise<MongoClient> | null = null;

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 5000;

function buildConnectionString(): string {
    if (!MONGO_MEMORY_USER || !MONGO_MEMORY_PASSWORD || !MONGO_MEMORY_CLUSTER) {
        throw new Error("MongoDB memory connection requires MONGO_MEMORY_USER, MONGO_MEMORY_PASSWORD, and MONGO_MEMORY_CLUSTER");
    }

    const encodedPassword = encodeURIComponent(MONGO_MEMORY_PASSWORD);
    return `mongodb+srv://${MONGO_MEMORY_USER}:${encodedPassword}@${MONGO_MEMORY_CLUSTER}.mongodb.net/?appName=memory&retryWrites=true&w=majority`;
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectWithRetry(retryCount = 0): Promise<MongoClient> {
    const connectionString = buildConnectionString();

    const options: MongoClientOptions = {
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 30000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 30000,
        serverSelectionTimeoutMS: 10000,
    };

    try {
        const newClient = new MongoClient(connectionString, options);
        await newClient.connect();
        console.log(`[mongodb] Connected to ${MONGO_MEMORY_CLUSTER}`);
        return newClient;
    } catch (error) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);

        if (retryCount < MAX_RETRIES) {
            console.warn(`[mongodb] Connection attempt ${retryCount + 1} failed, retrying in ${delay}ms:`, error);
            await sleep(delay);
            return connectWithRetry(retryCount + 1);
        }

        throw error;
    }
}

export async function getMongoClient(): Promise<MongoClient> {
    if (client) {
        try {
            await client.db().admin().ping();
            return client;
        } catch {
            client = null;
            db = null;
        }
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = (async () => {
        const newClient = await connectWithRetry();
        client = newClient;
        db = newClient.db(DB_NAME);

        await ensureIndexes();

        setupGracefulShutdown(newClient);

        connectionPromise = null;
        return newClient;
    })();

    return connectionPromise;
}

export async function getMongoDb(): Promise<Db> {
    if (db) {
        return db;
    }

    await getMongoClient();
    return db!;
}

export async function closeMongo(): Promise<void> {
    if (client) {
        await client.close();
        client = null;
        db = null;
        connectionPromise = null;
        console.log("[mongodb] Connection closed");
    }
}

function setupGracefulShutdown(mongoClient: MongoClient): void {
    const shutdown = async () => {
        try {
            await mongoClient.close();
            console.log("[mongodb] Graceful shutdown completed");
        } catch (error) {
            console.error("[mongodb] Error during shutdown:", error);
        }
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    process.on("beforeExit", shutdown);
}

async function ensureIndexes(): Promise<void> {
    if (!db) return;

    const collections = {
        patterns: PATTERN_INDEXES,
        archives: ARCHIVE_INDEXES,
        skills: SKILL_INDEXES,
        sessions: SESSION_INDEXES,
    };

    for (const [collectionName, indexes] of Object.entries(collections)) {
        const collection = db.collection(collectionName);
        try {
            await collection.createIndexes(indexes);
            console.log(`[mongodb] Created indexes for ${collectionName}`);
        } catch (error) {
            console.warn(`[mongodb] Index creation for ${collectionName}:`, error);
        }
    }
}

export async function getPatternsCollection(): Promise<Collection<ProceduralPattern>> {
    const database = await getMongoDb();
    return database.collection<ProceduralPattern>("patterns");
}

export async function getArchivesCollection(): Promise<Collection<MemoryArchive>> {
    const database = await getMongoDb();
    return database.collection<MemoryArchive>("archives");
}

export async function getSkillsCollection(): Promise<Collection<SkillDocument>> {
    const database = await getMongoDb();
    return database.collection<SkillDocument>("skills");
}

export async function getSessionsCollection(): Promise<Collection<SessionMemory>> {
    const database = await getMongoDb();
    return database.collection<SessionMemory>("sessions");
}

export {
    ProceduralPattern,
    MemoryArchive,
    SkillDocument,
    SessionMemory,
};