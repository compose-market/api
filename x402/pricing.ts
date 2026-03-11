/**
 * x402 Dynamic Pricing
 * 
 * Centralized pricing for all x402-enabled services.
 * Supports model-aware pricing for 43k+ models.
 * 
 * This module must stay side-effect free so inference route registration
 * does not bootstrap payment facilitators at import time.
 * 
 * @module shared/x402/pricing
 */

import type { PriceResult, PriceLookupParams } from "./types.js";
import { resolveBillingPrice } from "../inference/telemetry.js";

/**
 * Fixed price per inference call in USDC wei (6 decimals)
 * $0.005 USDC = 5000 wei
 */
export const INFERENCE_PRICE_WEI = 5_000;

// =============================================================================
// Dynamic Pricing Table (in USDC wei - 6 decimals)
// =============================================================================

export const DYNAMIC_PRICES = {
    // Agent Inference
    AGENT_CHAT: "15000",              // $0.015 per message

    // Tool Execution - Simple (read-only operations)
    GOAT_SIMPLE: "5000",             // $0.005 - price check, balance query
    MCP_TOOL_READ: "5000",           // $0.005 - read operations

    // Tool Execution - Transactions (on-chain writes)
    GOAT_TRANSACTION: "10000",        // $0.01 - swap, transfer, approve
    GOAT_COMPLEX: "10000",           // $0.01 - multi-step operations

    // MCP Server Tools
    MCP_TOOL_CALL: "5000",           // $0.005 - default MCP tool

    // Workflow Orchestration
    WORKFLOW_ORCHESTRATION: "20000",  // $0.02 - coordinator fee
    WORKFLOW_DELEGATION: "20000",      // $0.02 - per agent delegation

    // Multimodal Generation
    IMAGE_GEN_SDXL: "50000",         // $0.05 - Stable Diffusion XL
    IMAGE_GEN_FLUX: "100000",        // $0.10 - Flux Pro
    AUDIO_TTS: "20000",              // $0.02 - Text-to-Speech
    AUDIO_STT: "15000",              // $0.015 - Speech-to-Text
    VIDEO_GEN: "500000",             // $0.50 - Video generation

    // Embedding utilities
    EMBEDDING_SEARCH: "500",         // $0.0005 - embedding retrieval/search
    EMBEDDING_ADD: "1000",           // $0.001 - embedding index add

    // ElizaOS Actions
    ELIZA_MESSAGE: "10000",           // $0.01 - message processing
    ELIZA_ACTION: "10000",            // $0.01 - action execution
} as const;

/**
 * Default prices for backward compatibility
 */
export const DEFAULT_PRICES = {
    MCP_TOOL_CALL: DYNAMIC_PRICES.MCP_TOOL_CALL,
    GOAT_EXECUTE: DYNAMIC_PRICES.GOAT_SIMPLE,
    ELIZA_MESSAGE: DYNAMIC_PRICES.ELIZA_MESSAGE,
    ELIZA_ACTION: DYNAMIC_PRICES.ELIZA_ACTION,
    WORKFLOW_RUN: DYNAMIC_PRICES.WORKFLOW_ORCHESTRATION,
    AGENT_CHAT: DYNAMIC_PRICES.AGENT_CHAT,
} as const;

// Platform fee per million tokens
const PLATFORM_FEE_PER_MILLION = 0.01; // $0.01

// =============================================================================
// Pricing Functions
// =============================================================================

/**
 * Get price for a tool based on its characteristics
 */
export function getToolPrice(params: {
    source: "goat" | "mcp" | "eliza";
    toolName: string;
    isTransaction?: boolean;
    complexity?: "simple" | "complex";
}): string {
    const { source, toolName, isTransaction, complexity } = params;

    // GOAT tools
    if (source === "goat") {
        if (isTransaction) {
            return complexity === "complex"
                ? DYNAMIC_PRICES.GOAT_COMPLEX
                : DYNAMIC_PRICES.GOAT_TRANSACTION;
        }
        return DYNAMIC_PRICES.GOAT_SIMPLE;
    }

    // MCP tools
    if (source === "mcp") {
        return DYNAMIC_PRICES.MCP_TOOL_CALL;
    }

    // ElizaOS actions
    if (source === "eliza") {
        return toolName.includes("message")
            ? DYNAMIC_PRICES.ELIZA_MESSAGE
            : DYNAMIC_PRICES.ELIZA_ACTION;
    }

    return DEFAULT_PRICES.MCP_TOOL_CALL;
}

/**
 * Get price for multimodal generation based on model
 */
export function getMultimodalPrice(params: {
    requestProfile?: PriceLookupParams["requestProfile"];
    outputModality?: PriceLookupParams["outputModality"];
    taskType?: string;
    provider?: string;
}): string {
    const profile = params.requestProfile || params.outputModality;
    const taskType = (params.taskType || "").toLowerCase();

    if (profile === "image" || taskType.includes("image")) {
        return DYNAMIC_PRICES.IMAGE_GEN_SDXL;
    }

    if (profile === "audio" || taskType.includes("speech") || taskType.includes("audio")) {
        return DYNAMIC_PRICES.AUDIO_TTS;
    }

    if (profile === "video" || taskType.includes("video")) {
        return DYNAMIC_PRICES.VIDEO_GEN;
    }

    if (profile === "embedding" || taskType.includes("embedding") || taskType.includes("feature-extraction")) {
        return DYNAMIC_PRICES.EMBEDDING_SEARCH;
    }

    // Provider defaults for unknown models where only provider is known
    const provider = (params.provider || "").toLowerCase();
    if (provider === "vertex" || provider === "gemini") {
        return DYNAMIC_PRICES.AGENT_CHAT;
    }

    return DYNAMIC_PRICES.AGENT_CHAT;
}

/**
 * Calculate inference cost based on model pricing
 * Uses model card pricing if available, otherwise platform fee only
 */
export function calculateInferenceCost(
    modelPricing: { unit: string; values: Record<string, number> } | null,
    inputTokens: number,
    outputTokens: number
): PriceResult {
    if (!modelPricing) {
        throw new Error("model pricing is required");
    }

    const pricing = resolveBillingPrice(modelPricing, "text");
    if (pricing.unit !== "usd_per_1m_tokens") {
        throw new Error(`token cost calculation is not supported for pricing unit ${pricing.unit}`);
    }
    if (typeof pricing.values.input !== "number" || typeof pricing.values.output !== "number") {
        throw new Error("token pricing values are required");
    }

    // Calculate based on model pricing
    const inputCost = (inputTokens / 1_000_000) * pricing.values.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.values.output;
    const providerCost = inputCost + outputCost;
    const platformFee = providerCost * 0.01;
    const totalCost = providerCost + platformFee;

    return {
        providerCost,
        platformFee,
        totalCost,
        costUsdcWei: BigInt(Math.ceil(totalCost * 1_000_000)),
    };
}

/**
 * Calculate action cost with 1% platform fee
 */
export function calculateActionCost(actionCost: number): PriceResult {
    const platformFee = actionCost * 0.01;
    const totalCost = actionCost + platformFee;
    return {
        providerCost: actionCost,
        platformFee,
        totalCost,
        costUsdcWei: BigInt(Math.ceil(totalCost * 1_000_000)),
    };
}

/**
 * Calculate total cost for multiple operations
 */
export function calculateTotalCost(operations: Array<{
    type: keyof typeof DYNAMIC_PRICES;
    count?: number;
}>): string {
    let total = 0;

    for (const op of operations) {
        const price = parseInt(DYNAMIC_PRICES[op.type]);
        const count = op.count || 1;
        total += price * count;
    }

    return total.toString();
}

/**
 * Get price for a request (unified pricing lookup)
 */
export function getPriceForRequest(params: PriceLookupParams): string {
    // Tool pricing
    if (params.toolSource && params.toolName) {
        return getToolPrice({
            source: params.toolSource,
            toolName: params.toolName,
            isTransaction: params.isTransaction,
            complexity: params.complexity,
        });
    }

    // Canonical request-shape pricing
    if (params.requestProfile || params.outputModality || params.taskType || params.provider) {
        return getMultimodalPrice({
            requestProfile: params.requestProfile,
            outputModality: params.outputModality,
            taskType: params.taskType,
            provider: params.provider,
        });
    }

    // Backward-compatible fallback for callers providing only modelId
    if (params.modelId) {
        return DYNAMIC_PRICES.AGENT_CHAT;
    }

    // Default inference price
    return INFERENCE_PRICE_WEI.toString();
}

/**
 * Format price in USDC wei to human-readable string
 */
export function formatPrice(weiAmount: string): string {
    const usdc = parseInt(weiAmount) / 1_000_000;
    return `$${usdc.toFixed(6)}`;
}
