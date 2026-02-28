/**
 * Compose Agent Schema
 * 
 * A2A/ACP-compliant agent manifest with Compose Market extensions.
 * Single source of truth for agent metadata across the system.
 */

import { z } from "zod";
import type { AgentManifest, AgentMetadata, TaskType } from "./types.js";
import { taskTypeToContentTypes } from "./types.js";

// =============================================================================
// Compose Extensions
// =============================================================================

/**
 * Compose-specific agent data (on-chain + x402)
 */
export interface ComposeAgentExtensions {
    /** Primary identifier - derived wallet address */
    walletAddress: string;

    /** On-chain DNA hash */
    dnaHash: string;

    /** Chain ID where agent is deployed */
    chain: number;

    /** AI model used by the agent */
    model: string;

    /** Agent runtime framework (eliza, langchain, etc.) */
    framework?: string;

    /** License price in USDC (6 decimals, wei) */
    licensePrice: string;

    /** Total license supply (0 = unlimited) */
    licenses: number;

    /** Available licenses */
    licensesAvailable?: number;

    /** Whether agent can be cloned */
    cloneable: boolean;

    /** Whether agent is a clone */
    isClone?: boolean;

    /** Parent agent ID if clone */
    parentAgentId?: number;

    /** On-chain agent ID */
    agentId?: number;

    /** Creator wallet address */
    creator?: string;

    /** Agent avatar (IPFS CID or gateway URL) */
    avatar?: string;

    /** Bound plugins/MCPs */
    plugins?: Array<{
        registryId: string;
        name: string;
        origin: string;
    }>;

    /** Supported protocols */
    protocols?: Array<{
        name: string;
        version: string;
    }>;
}

// =============================================================================
// Compose Agent Manifest
// =============================================================================

/**
 * Full Compose Agent Manifest - ACP base + Compose extensions
 */
export interface ComposeAgentManifest extends AgentManifest {
    /** Compose-specific extensions */
    compose: ComposeAgentExtensions;

    /** v1/* endpoints for this agent */
    endpoints: {
        /** Chat endpoint: /v1/chat/completions */
        chat?: string;
        /** Image generation: /v1/images/generations */
        image?: string;
        /** Video generation: /v1/videos/generations */
        video?: string;
        /** Audio speech: /v1/audio/speech */
        audio?: string;
        /** Transcription: /v1/audio/transcriptions */
        transcription?: string;
        /** Embeddings: /v1/embeddings */
        embeddings?: string;
    };
}

// =============================================================================
// Zod Validation Schemas
// =============================================================================

export const ComposeAgentExtensionsSchema = z.object({
    walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
    dnaHash: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid DNA hash"),
    chain: z.number().int().positive(),
    model: z.string().min(1),
    framework: z.string().optional(),
    licensePrice: z.string(),
    licenses: z.number().int().min(0),
    licensesAvailable: z.number().int().min(0).optional(),
    cloneable: z.boolean(),
    isClone: z.boolean().optional(),
    parentAgentId: z.number().int().optional(),
    agentId: z.number().int().optional(),
    creator: z.string().optional(),
    avatar: z.string().optional(),
    plugins: z.array(z.object({
        registryId: z.string(),
        name: z.string(),
        origin: z.string(),
    })).optional(),
    protocols: z.array(z.object({
        name: z.string(),
        version: z.string(),
    })).optional(),
});

export const ComposeAgentManifestSchema = z.object({
    name: z.string().min(1),
    description: z.string(),
    input_content_types: z.array(z.string()).min(1),
    output_content_types: z.array(z.string()).min(1),
    metadata: z.object({
        capabilities: z.array(z.object({
            name: z.string(),
            description: z.string(),
        })).optional(),
        tags: z.array(z.string()).optional(),
        domains: z.array(z.string()).optional(),
        author: z.object({
            name: z.string(),
            email: z.string().optional(),
            url: z.string().optional(),
        }).optional(),
        framework: z.string().optional(),
        recommended_models: z.array(z.string()).optional(),
        created_at: z.string().optional(),
    }).optional(),
    compose: ComposeAgentExtensionsSchema,
    endpoints: z.object({
        chat: z.string().optional(),
        image: z.string().optional(),
        video: z.string().optional(),
        audio: z.string().optional(),
        transcription: z.string().optional(),
        embeddings: z.string().optional(),
    }),
});

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Build agent endpoints based on task type
 */
export function buildAgentEndpoints(
    walletAddress: string,
    task: TaskType,
    baseUrl = "https://manowar.compose.market"
): ComposeAgentManifest["endpoints"] {
    const agentPath = `/agent/${walletAddress}`;

    switch (task) {
        case "text-generation":
            return { chat: `${baseUrl}${agentPath}/chat` };
        case "text-to-image":
        case "image-to-image":
            return { image: `${baseUrl}${agentPath}/image` };
        case "text-to-video":
        case "image-to-video":
            return { video: `${baseUrl}${agentPath}/video` };
        case "text-to-speech":
        case "text-to-audio":
            return { audio: `${baseUrl}${agentPath}/audio` };
        case "automatic-speech-recognition":
            return { transcription: `${baseUrl}${agentPath}/transcribe` };
        case "feature-extraction":
            return { embeddings: `${baseUrl}${agentPath}/embed` };
        default:
            return { chat: `${baseUrl}${agentPath}/chat` };
    }
}

/**
 * Convert on-chain agent data to ComposeAgentManifest
 */
export function toAgentManifest(
    onchain: {
        id: number;
        dnaHash: string;
        walletAddress: string;
        licenses: number;
        licensesAvailable: number;
        licensePrice: string;
        creator: string;
        cloneable: boolean;
        isClone: boolean;
        parentAgentId: number;
        agentCardUri: string;
        metadata?: {
            name: string;
            description: string;
            skills: string[];
            image?: string;
            model: string;
            framework?: string;
            chain: number;
            plugins?: Array<{ registryId: string; name: string; origin: string }>;
            protocols?: Array<{ name: string; version: string }>;
        };
    },
    task: TaskType = "text-generation"
): ComposeAgentManifest {
    const contentTypes = taskTypeToContentTypes(task);
    const metadata = onchain.metadata;

    return {
        name: metadata?.name || `Agent-${onchain.id}`,
        description: metadata?.description || "",
        input_content_types: contentTypes.input,
        output_content_types: contentTypes.output,
        metadata: {
            capabilities: metadata?.skills?.map(s => ({ name: s, description: s })) || [],
            tags: metadata?.skills || [],
            framework: metadata?.framework,
            recommended_models: metadata?.model ? [metadata.model] : [],
            created_at: new Date().toISOString(),
        },
        compose: {
            walletAddress: onchain.walletAddress,
            dnaHash: onchain.dnaHash,
            chain: metadata?.chain || 43114,
            model: metadata?.model || "unknown",
            framework: metadata?.framework,
            licensePrice: onchain.licensePrice,
            licenses: onchain.licenses,
            licensesAvailable: onchain.licensesAvailable,
            cloneable: onchain.cloneable,
            isClone: onchain.isClone,
            parentAgentId: onchain.parentAgentId > 0 ? onchain.parentAgentId : undefined,
            agentId: onchain.id,
            creator: onchain.creator,
            avatar: metadata?.image,
            plugins: metadata?.plugins,
            protocols: metadata?.protocols,
        },
        endpoints: buildAgentEndpoints(onchain.walletAddress, task),
    };
}

// Type guard
export function isComposeAgentManifest(obj: unknown): obj is ComposeAgentManifest {
    return ComposeAgentManifestSchema.safeParse(obj).success;
}
