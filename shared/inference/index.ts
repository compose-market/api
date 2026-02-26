/**
 * Unified API Module
 * 
 * Single source of truth for ALL route handling.
 * Works for both Lambda (production) and Express (development).
 * 
 * All inference logic consolidated into gateway.ts:
 * - Smart routing based on model registry taskType (NOT heuristics)
 * - Unified invoke function for all modalities
 * - x402 payment integration with deferred settlement
 * 
 * Usage:
 *   Lambda: import { handler } from "./lambda/handler.js"
 *   Express: import { registerRoutes } from "./shared/api/index.js"
 *   Gateway: import { handleChatCompletions } from "./shared/api/gateway.js"
 * 
 * @module shared/api
 */

import type { Request, Response, Express, NextFunction } from "express";
import type { Server } from "http";

// Unified Inference Gateway (consolidates endpoints.ts + invoke.ts + adapter.ts)
import {
    INFERENCE_ROUTES,
    handleListModels,
    handleGetModel,
    handleChatCompletions,
    handleImageGeneration,
    handleImageEdit,
    handleAudioSpeech,
    handleAudioTranscription,
    handleEmbeddings,
    handleVideoGeneration,
    handleVideoStatus,
    setCorsHeaders,
    // Re-export unified invoke for direct use
    invokeUnified,
    invokeImage,
    invokeVideo,
    invokeTTS,
    invokeASR,
    invokeEmbedding,
    submitVideoJob,
    checkVideoJobStatus,
    // Types
    type ChatMessage,
    type ChatOptions,
    type ChatResult,
    type ImageOptions,
    type ImageResult,
    type VideoOptions,
    type VideoResult,
    type TTSOptions,
    type ASROptions,
    type ASRResult,
    type EmbeddingOptions,
    type EmbeddingResult,
    type VideoJobResult,
    type VideoJobStatus,
} from "./gateway.js";

// Model registry
import { getCompiledModels, getExtendedModels, getModelById } from "../models/registry.js";

// Pricing
import { DYNAMIC_PRICES } from "../x402/pricing.js";

// x402 middleware
import { extractPaymentInfo, buildPaymentRequiredHeaders } from "../x402/index.js";
import { THIRDWEB_CHAIN_IDS } from "../configs/chains.js";

// =============================================================================
// CORS Configuration
// =============================================================================

export const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": [
        "Content-Type",
        "PAYMENT-SIGNATURE",
        "payment-signature",
        "x-session-active",
        "x-session-budget-remaining",
        "x-manowar-internal",  // Internal bypass for Manowar agent LLM calls
        "Access-Control-Expose-Headers",
    ].join(", "),
    "Access-Control-Expose-Headers": "PAYMENT-RESPONSE, payment-response, *",
};

// =============================================================================
// Pinata Discovery Helpers
// =============================================================================

const PINATA_JWT = process.env.PINATA_JWT || "";
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "compose.mypinata.cloud";
const PINATA_API_URL = "https://api.pinata.cloud";

/**
 * AgentCard - match to app/src/lib/pinata.ts AgentCard
 * This is the single source of truth for agent metadata
 */
interface AgentCard {
    schemaVersion: string;
    name: string;
    description: string;
    skills: string[];
    image?: string; // Standard NFT metadata field (gateway URL)
    avatar?: string; // Legacy field for backward compatibility
    dnaHash: string;
    walletAddress: string; // Agent's derived wallet address - SINGLE SOURCE OF TRUTH
    walletTimestamp?: number; // Timestamp used in wallet derivation
    chain: number;
    model: string;
    framework?: "eliza" | "langchain" | string;
    licensePrice: string; // USDC in smallest unit (6 decimals)
    licenses: number;
    cloneable: boolean;
    endpoint?: string;
    protocols: Array<{ name: string; version: string }>;
    plugins?: Array<{
        registryId: string;
        name: string;
        origin: string;
    }>;
    createdAt: string;
    creator?: string;
    // Added for API response
    cid?: string;
}

/**
 * ManowarMetadata - match to app/src/lib/pinata.ts ManowarMetadata
 * This is the single source of truth for manowar metadata
 */
interface ManowarMetadata {
    schemaVersion: string;
    title: string;
    description: string;
    image?: string; // Standard NFT metadata field (gateway URL)
    // Identity - single source of truth derived at mint time
    dnaHash: string;
    walletAddress: string; // Derived wallet for x402 payments
    walletTimestamp: number; // Timestamp used in derivation
    // Nested agentCards - full agent metadata embedded
    agents: AgentCard[];
    // Workflow graph edges
    edges?: Array<{
        source: number;
        target: number;
        label?: string;
    }>;
    coordinator?: {
        hasCoordinator: boolean;
        model: string;
    };
    pricing: {
        totalAgentPrice: string;
    };
    lease?: {
        enabled: boolean;
        durationDays: number;
        creatorPercent: number;
    };
    rfa?: {
        title: string;
        description: string;
        skills: string[];
        offerAmount: string;
    };
    creator: string;
    createdAt: string;
    // Added for API response
    cid?: string;
}

/**
 * List pins by type (agent-card or manowar-metadata)
 */
async function listPinsByType(type: "agent-card" | "manowar-metadata"): Promise<(AgentCard | ManowarMetadata)[]> {
    if (!PINATA_JWT) {
        console.warn("[api] Pinata not configured");
        return [];
    }

    try {
        // Query Pinata for pins with matching metadata type
        const query = encodeURIComponent(JSON.stringify({ keyvalues: { type: { value: type, op: "eq" } } }));
        const response = await fetch(
            `${PINATA_API_URL}/data/pinList?status=pinned&metadata[keyvalues]=${query}&pageLimit=100`,
            {
                headers: { Authorization: `Bearer ${PINATA_JWT}` },
            }
        );

        if (!response.ok) {
            console.error(`[api] Pinata list failed: ${response.status}`);
            return [];
        }

        const data = await response.json() as { rows: Array<{ ipfs_pin_hash: string; metadata?: { name?: string } }> };

        // Fetch content from each CID
        const results: (AgentCard | ManowarMetadata)[] = [];
        for (const pin of data.rows.slice(0, 50)) { // Limit to 50 for performance
            try {
                const content = await fetchFromPinataGateway<AgentCard | ManowarMetadata>(pin.ipfs_pin_hash);
                if (content) {
                    results.push({ ...content, cid: pin.ipfs_pin_hash });
                }
            } catch {
                // Skip failed fetches
            }
        }
        return results;
    } catch (error) {
        console.error("[api] Error listing pins:", error);
        return [];
    }
}

/**
 * Fetch JSON from Pinata gateway
 */
async function fetchFromPinataGateway<T = unknown>(cid: string): Promise<T | null> {
    try {
        const response = await fetch(`https://${PINATA_GATEWAY}/ipfs/${cid}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return null;
        return await response.json() as T;
    } catch {
        return null;
    }
}

/**
 * Find agent by wallet address
 */
async function findAgentByWallet(walletAddress: string): Promise<AgentCard | null> {
    const agents = await listPinsByType("agent-card");
    const normalizedAddress = walletAddress.toLowerCase();
    return agents.find(a =>
        (a as AgentCard).walletAddress?.toLowerCase() === normalizedAddress
    ) as AgentCard || null;
}

/**
 * Find manowar by wallet address
 */
async function findManowarByWallet(walletAddress: string): Promise<ManowarMetadata | null> {
    const manowars = await listPinsByType("manowar-metadata");
    const normalizedAddress = walletAddress.toLowerCase();
    return manowars.find(m =>
        (m as ManowarMetadata).walletAddress?.toLowerCase() === normalizedAddress
    ) as ManowarMetadata || null;
}

// =============================================================================
// Route Definitions
// =============================================================================

export interface RouteHandler {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    handler: (req: Request, res: Response) => Promise<void>;
    description?: string;
}

/**
 * All API routes for Compose Market
 * Single source of truth - used by both Lambda and Express
 */
export const API_ROUTES: RouteHandler[] = [
    // ==========================================================================
    // Gateway-Owned /v1/* Routes
    // ==========================================================================
    ...INFERENCE_ROUTES,

    // ==========================================================================
    // API Routes (/api/*)
    // ==========================================================================

    // Registry
    {
        method: "GET",
        path: "/api/registry/models",
        handler: async (_req, res) => {
            const models = await getCompiledModels();
            res.json(models);
        },
        description: "Get model registry",
    },
    {
        method: "GET",
        path: "/api/models",
        handler: async (_req, res) => {
            const models = await getCompiledModels();
            res.json({
                object: "list",
                data: models.models.slice(0, 100).map((m) => ({
                    id: m.modelId,
                    object: "model",
                    created: Date.now(),
                    owned_by: m.ownedBy || m.provider,
                })),
            });
        },
        description: "List models (OpenAI format)",
    },

    // Pricing
    {
        method: "GET",
        path: "/api/pricing",
        handler: async (_req, res) => {
            res.json({ prices: DYNAMIC_PRICES, version: "1.0" });
        },
        description: "Get pricing table",
    },

    // Legacy inference endpoint
    { method: "POST", path: "/api/inference", handler: handleChatCompletions, description: "Legacy inference" },

    // Health check
    {
        method: "GET",
        path: "/health",
        handler: async (_req, res) => {
            res.json({ status: "ok", timestamp: new Date().toISOString() });
        },
        description: "Health check",
    },

    // ==========================================================================
    // Agent Discovery (ACP-compliant)
    // ==========================================================================

    // GET /agents - List all agents from Pinata IPFS
    {
        method: "GET",
        path: "/agents",
        handler: async (_req, res) => {
            try {
                const agents = await listPinsByType("agent-card") as AgentCard[];
                res.json({
                    // Return full AgentCard structure from Pinata (matches pinata.ts)
                    agents: agents,
                    total: agents.length,
                });
            } catch (error) {
                console.error("[api] Error listing agents:", error);
                res.status(500).json({ error: "Failed to list agents" });
            }
        },
        description: "ACP-compliant agent discovery",
    },

    // GET /agent/:walletAddress - Get agent manifest from Pinata
    {
        method: "GET",
        path: "/agent/:walletAddress",
        handler: async (req, res) => {
            const walletAddressParam = req.params.walletAddress;
            const walletAddress = Array.isArray(walletAddressParam) ? walletAddressParam[0] : walletAddressParam;
            if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
                res.status(400).json({ error: "Invalid wallet address format" });
                return;
            }

            try {
                const agent = await findAgentByWallet(walletAddress);
                if (!agent) {
                    res.status(404).json({ error: "Agent not found" });
                    return;
                }
                res.json(agent);
            } catch (error) {
                console.error("[api] Error fetching agent:", error);
                res.status(500).json({ error: "Failed to fetch agent" });
            }
        },
        description: "Get agent manifest by wallet address",
    },

    // ==========================================================================
    // Manowar Discovery (ACP-compliant)
    // ==========================================================================

    // GET /manowars - List all manowars from Pinata IPFS
    {
        method: "GET",
        path: "/manowars",
        handler: async (_req, res) => {
            try {
                const manowars = await listPinsByType("manowar-metadata") as ManowarMetadata[];
                res.json({
                    // Return full ManowarMetadata structure from Pinata (matches pinata.ts)
                    manowars: manowars,
                    total: manowars.length,
                });
            } catch (error) {
                console.error("[api] Error listing manowars:", error);
                res.status(500).json({ error: "Failed to list manowars" });
            }
        },
        description: "ACP-compliant manowar discovery",
    },

    // GET /manowar/:walletAddress - Get manowar manifest from Pinata
    {
        method: "GET",
        path: "/manowar/:walletAddress",
        handler: async (req, res) => {
            const walletAddressParam = req.params.walletAddress;
            const walletAddress = Array.isArray(walletAddressParam) ? walletAddressParam[0] : walletAddressParam;
            if (!walletAddress?.match(/^0x[a-fA-F0-9]{40}$/)) {
                res.status(400).json({ error: "Invalid wallet address format" });
                return;
            }

            try {
                const manowar = await findManowarByWallet(walletAddress);
                if (!manowar) {
                    res.status(404).json({ error: "Manowar not found" });
                    return;
                }
                res.json(manowar);
            } catch (error) {
                console.error("[api] Error fetching manowar:", error);
                res.status(500).json({ error: "Failed to fetch manowar" });
            }
        },
        description: "Get manowar manifest by wallet address",
    },
];

// =============================================================================
// Route Matching (for Lambda)
// =============================================================================

/**
 * Match a route from the route table
 */
export function matchRoute(
    method: string,
    path: string
): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of API_ROUTES) {
        if (route.method !== method) continue;

        // Convert Express path pattern to regex
        const pattern = route.path.replace(/:([^/]+)/g, "(?<$1>[^/]+)");
        const regex = new RegExp(`^${pattern}$`);
        const match = path.match(regex);

        if (match) {
            return {
                handler: route,
                params: match.groups || {},
            };
        }
    }
    return null;
}

// =============================================================================
// Express Integration
// =============================================================================

/**
 * Register all routes on an Express app
 * Used for local development
 */
export async function registerRoutes(
    httpServer: Server,
    app: Express,
    options?: {
        /**
         * Skip the built-in 404 middleware so callers can add their own fallback.
         */
        skipNotFoundHandler?: boolean;
    }
): Promise<Server> {
    // CORS middleware
    app.use((req, res, next) => {
        Object.entries(corsHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        if (req.method === "OPTIONS") {
            res.status(204).end();
            return;
        }
        next();
    });

    // Register all routes
    for (const route of API_ROUTES) {
        const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete";
        app[method](route.path, (req, res, next) => {
            route.handler(req, res).catch(next);
        });
    }

    // 404 handler
    if (!options?.skipNotFoundHandler) {
        app.use((_req, res) => {
            res.status(404).json({ error: "Not Found" });
        });
    }

    // Error handler
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        console.error("[API Error]", err);
        res.status(500).json({ error: "Internal Server Error", message: err.message });
    });

    return httpServer;
}

// =============================================================================
// x402 Middleware
// =============================================================================

/**
 * x402 payment middleware factory
 * Use in Express: app.use("/v1/*", x402Middleware({ ... }))
 */
export function x402Middleware(options: {
    serviceId: string;
    pricing?: {
        amount: string;
        tokenAddress: string;
        chainId: number;
    };
    excludePaths?: string[];
}) {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Skip OPTIONS (CORS preflight)
        if (req.method === "OPTIONS") return next();

        // Skip health checks
        if (req.path === "/health" || req.path === "/") return next();

        // Skip excluded paths
        if (options.excludePaths?.some(p => req.path.startsWith(p))) {
            return next();
        }

        const { paymentData } = extractPaymentInfo(req.headers as Record<string, string>);

        if (!paymentData) {
            return res.status(402).json({
                error: "Payment Required",
                message: "This endpoint requires x402 payment.",
                ...buildPaymentRequiredHeaders(
                    {
                        method: "x402",
                        id: "default",
                        network: String(options.pricing?.chainId || 43113),
                        assetAddress: options.pricing?.tokenAddress || "0x5425890298aed601595a70ab815c96711a31bc65",
                        assetSymbol: "USDC",
                        payee: process.env.MERCHANT_WALLET_ADDRESS || "",
                        x402: { scheme: "upto" },
                    },
                    { pricing: { unit: "call", amount: options.pricing?.amount || "5000" } }
                ),
            });
        }

        // Payment data exists - handler will verify via requirePayment()
        next();
    };
}

// =============================================================================
// Unified Gateway Exports
// =============================================================================

export {
    // Main handlers
    handleListModels,
    handleGetModel,
    handleChatCompletions,
    handleImageGeneration,
    handleImageEdit,
    handleAudioSpeech,
    handleAudioTranscription,
    handleEmbeddings,
    handleVideoGeneration,
    handleVideoStatus,
    setCorsHeaders,
    // Unified invoke functions
    invokeUnified,
    invokeImage,
    invokeVideo,
    invokeTTS,
    invokeASR,
    invokeEmbedding,
    submitVideoJob,
    checkVideoJobStatus,
};

// =============================================================================
// Types
// =============================================================================

export type {
    ChatMessage,
    ChatOptions,
    ChatResult,
    ImageOptions,
    ImageResult,
    VideoOptions,
    VideoResult,
    TTSOptions,
    ASROptions,
    ASRResult,
    EmbeddingOptions,
    EmbeddingResult,
    VideoJobResult,
    VideoJobStatus,
    TokenUsage,
} from "./gateway.js";
