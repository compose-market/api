/**
 * Mem0 Shared Integration
 * 
 * Provides unified access to Mem0 for long-term agent memory.
 * Uses Pinata as storage backend if configured.
 * 
 * Env dependencies:
 * - MEM0_API_KEY: Required
 */

import * as mem0ai from "mem0ai";

// =============================================================================
// Configuration
// =============================================================================

const MEM0_API_KEY = process.env.MEM0_API_KEY;

if (!MEM0_API_KEY) {
    console.warn("[mem0] MEM0_API_KEY not found. Memory features will be disabled.");
}

// =============================================================================
// Client
// =============================================================================

// Define a type alias if possible, or use 'any' if types are broken
type Mem0Client = any;

let mem0Client: Mem0Client | null = null;

export function getMem0Client(): Mem0Client | null {
    if (mem0Client) return mem0Client;

    if (!MEM0_API_KEY) return null;

    try {
        // exports MemoryClient
        const MemoryClass = (mem0ai as any).MemoryClient || (mem0ai as any).default?.MemoryClient;

        if (typeof MemoryClass !== "function") {
            console.error("[mem0] MemoryClient class not found in import. Available exports:", Object.keys(mem0ai));
            return null;
        }

        mem0Client = new MemoryClass({
            apiKey: MEM0_API_KEY,
        });
        console.log("[mem0] Client initialized");
        return mem0Client;
    } catch (error) {
        console.error("[mem0] Failed to initialize client:", error);
        return null;
    }
}

// =============================================================================
// Types
// =============================================================================

export interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    relations?: Array<{ source: string; target: string; relation: string }>; // Graph relations
}

export interface MemorySearchParams {
    query: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
    enable_graph?: boolean; // Pro feature: include graph relations
}

export interface MemoryAddParams {
    messages: Array<{ role: string; content: string }>;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
    enable_graph?: boolean; // Pro feature: extract entities and relationships
}

// Knowledge-specific params (for documents/URLs)
export interface KnowledgeAddParams {
    content: string;
    agent_id: string;
    user_id?: string;
    key?: string;
    source?: "file" | "url" | "paste";
    enable_graph?: boolean;
    metadata?: Record<string, unknown>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Add memory (messages) with optional graph extraction
 */
export async function addMemory(params: MemoryAddParams): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        const result = await client.add(params.messages, {
            user_id: params.user_id,
            agent_id: params.agent_id,
            run_id: params.run_id,
            metadata: params.metadata,
            enable_graph: params.enable_graph ?? false,
        });
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

/**
 * Add knowledge document to agent's memory with graph extraction
 * Uses contextual add for better memory consolidation
 */
export async function addKnowledge(params: KnowledgeAddParams): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        // Convert knowledge to message format for mem0
        const messages = [
            { role: "user", content: `Store this knowledge document (key: ${params.key || "unknown"}): ${params.content}` },
            { role: "assistant", content: "I've stored this document in my knowledge base." }
        ];

        const result = await client.add(messages, {
            agent_id: params.agent_id,
            user_id: params.user_id,
            metadata: {
                type: "knowledge",
                key: params.key,
                source: params.source || "paste",
                ...params.metadata,
            },
            enable_graph: params.enable_graph ?? true, // Default enable graph for knowledge
        });

        console.log(`[mem0] Added knowledge "${params.key}" for agent ${params.agent_id} with graph=${params.enable_graph ?? true}`);
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to add knowledge:", error);
        return [];
    }
}

/**
 * Search memories with optional graph relations
 */
export async function searchMemory(params: MemorySearchParams): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        const result = await client.search(params.query, {
            user_id: params.user_id,
            agent_id: params.agent_id,
            run_id: params.run_id,
            limit: params.limit,
            filters: params.filters,
            enable_graph: params.enable_graph ?? false,
        });
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return [];
    }
}

/**
 * Get all memories with optional graph context
 */
export async function getAllMemories(options?: {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    enable_graph?: boolean;
}): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        const result = await client.getAll({
            user_id: options?.user_id,
            agent_id: options?.agent_id,
            run_id: options?.run_id,
            limit: options?.limit,
            enable_graph: options?.enable_graph ?? false,
        });
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to get all memories:", error);
        return [];
    }
}
