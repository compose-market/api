/**
 * Compose Workflow Schema
 * 
 * A2A/ACP-compliant workflow manifest for multi-agent orchestration.
 * Extends AgentManifest with workflow-specific fields.
 */

import { z } from "zod";
import type { AgentManifest, TaskType } from "./types.js";
import { taskTypeToContentTypes } from "./types.js";
import type { ComposeAgentManifest, ComposeAgentExtensions } from "./agentSchema.js";
import { ComposeAgentManifestSchema } from "./agentSchema.js";

// =============================================================================
// Workflow Extensions
// =============================================================================

/**
 * Compose-specific Workflow data
 */
export interface ComposeWorkflowExtensions {
    /** Primary identifier - derived wallet address */
    walletAddress: string;

    /** On-chain DNA hash */
    dnaHash?: string;

    /** On-chain token ID */
    tokenId?: number;

    /** Total price in USDC (formatted) */
    totalPrice: string;

    /** Creator wallet address */
    creator: string;

    /** Banner image (IPFS CID or gateway URL) */
    banner?: string;

    /** Lease configuration */
    lease?: {
        enabled: boolean;
        durationDays: number;
        creatorPercent: number;
    };

    /** RFA (Request-For-Agent) configuration */
    rfa?: {
        title: string;
        description: string;
        skills: string[];
        offerAmount: string;
    };
}

// =============================================================================
// Workflow Manifest
// =============================================================================

/**
 * Workflow edge connecting agents
 */
export interface WorkflowEdge {
    /** Source agent wallet address */
    source: string;

    /** Target agent wallet address */
    target: string;

    /** Optional edge label */
    label?: string;
}

/**
 * Coordinator configuration
 */
export interface Coordinator {
    /** Whether workflow has a coordinator */
    hasCoordinator: boolean;

    /** Coordinator model (if hasCoordinator is true) */
    model?: string;
}

/**
 * Full Compose Workflow Manifest - ACP base + workflow extensions
 */
export interface WorkflowManifest extends AgentManifest {
    /** Nested agent manifests */
    agents: ComposeAgentManifest[];

    /** Workflow edges (agent connections) */
    edges: WorkflowEdge[];

    /** Coordinator configuration */
    coordinator?: Coordinator;

    /** Compose-specific extensions */
    compose: ComposeWorkflowExtensions;

    /** Workflow execution endpoint */
    endpoint: string;
}

// =============================================================================
// Zod Validation Schemas
// =============================================================================

export const ComposeWorkflowExtensionsSchema = z.object({
    walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
    dnaHash: z.string().optional(),
    tokenId: z.number().int().optional(),
    totalPrice: z.string(),
    creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    banner: z.string().optional(),
    lease: z.object({
        enabled: z.boolean(),
        durationDays: z.number().int().min(0),
        creatorPercent: z.number().min(0).max(100),
    }).optional(),
    rfa: z.object({
        title: z.string(),
        description: z.string(),
        skills: z.array(z.string()),
        offerAmount: z.string(),
    }).optional(),
});

export const WorkflowEdgeSchema = z.object({
    source: z.string(),
    target: z.string(),
    label: z.string().optional(),
});

export const CoordinatorSchema = z.object({
    hasCoordinator: z.boolean(),
    model: z.string().optional(),
});

export const WorkflowManifestSchema = z.object({
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
        created_at: z.string().optional(),
    }).optional(),
    agents: z.array(ComposeAgentManifestSchema),
    edges: z.array(WorkflowEdgeSchema),
    coordinator: CoordinatorSchema.optional(),
    compose: ComposeWorkflowExtensionsSchema,
    endpoint: z.string(),
});

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Convert on-chain Workflow data to WorkflowManifest
 */
export function toWorkflowManifest(
    onchain: {
        id: number;
        title: string;
        description: string;
        image?: string;
        workflowCardUri: string;
        totalPrice: string;
        creator: string;
        leaseEnabled: boolean;
        leaseDuration: number;
        leasePercent: number;
        hasCoordinator: boolean;
        coordinatorModel: string;
        dnaHash?: string;
        walletAddress?: string;
        metadata?: {
            agents?: ComposeAgentManifest[];
            edges?: WorkflowEdge[];
        };
    },
    baseUrl = "https://api.compose.market"
): WorkflowManifest {
    // Determine content types from nested agents
    const inputTypes = new Set<string>(["text/plain", "application/json"]);
    const outputTypes = new Set<string>(["text/plain", "application/json"]);

    onchain.metadata?.agents?.forEach(agent => {
        agent.input_content_types.forEach(t => inputTypes.add(t));
        agent.output_content_types.forEach(t => outputTypes.add(t));
    });

    return {
        name: onchain.title,
        description: onchain.description,
        input_content_types: Array.from(inputTypes),
        output_content_types: Array.from(outputTypes),
        metadata: {
            created_at: new Date().toISOString(),
        },
        agents: onchain.metadata?.agents || [],
        edges: onchain.metadata?.edges || [],
        coordinator: onchain.hasCoordinator
            ? { hasCoordinator: true, model: onchain.coordinatorModel }
            : { hasCoordinator: false },
        compose: {
            walletAddress: onchain.walletAddress || "",
            dnaHash: onchain.dnaHash,
            tokenId: onchain.id,
            totalPrice: onchain.totalPrice,
            creator: onchain.creator,
            banner: onchain.image,
            lease: onchain.leaseEnabled
                ? {
                    enabled: true,
                    durationDays: onchain.leaseDuration,
                    creatorPercent: onchain.leasePercent,
                }
                : undefined,
        },
        endpoint: `${baseUrl}/workflow/${onchain.walletAddress}/run`,
    };
}

// Type guard
export function isWorkflowManifest(obj: unknown): obj is WorkflowManifest {
    return WorkflowManifestSchema.safeParse(obj).success;
}
