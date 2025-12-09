/**
 * Mem0 Shared Integration
 * 
 * Provides unified access to Mem0 for long-term agent memory.
 * Uses Pinata as storage backend if configured.
 * 
 * Env dependencies:
 * - MEM0_API_KEY: Required
 */

import Mem0 from "mem0ai";

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

let mem0Client: Mem0 | null = null;

export function getMem0Client(): Mem0 | null {
    if (mem0Client) return mem0Client;

    if (!MEM0_API_KEY) return null;

    try {
        mem0Client = new Mem0({
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
}

export interface MemorySearchParams {
    query: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
}

export interface MemoryAddParams {
    messages: Array<{ role: string; content: string }>;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Add memory (messages)
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
        });
        return result as unknown as MemoryItem[]; // Cast result to our type
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

/**
 * Search memories
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
        });
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return [];
    }
}

/**
 * Get all memories
 */
export async function getAllMemories(options?: { user_id?: string; agent_id?: string; run_id?: string; limit?: number }): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        const result = await client.getAll({
            user_id: options?.user_id,
            agent_id: options?.agent_id,
            run_id: options?.run_id,
            limit: options?.limit,
        });
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to get all memories:", error);
        return [];
    }
}
