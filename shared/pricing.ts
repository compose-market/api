/**
 * Shared Pricing Module
 * 
 * Centralized pricing for all x402-enabled services.
 * Used in Phase 1 for pricing metadata, will be used in Phase 2 for actual settlement.
 */

// =============================================================================
// Dynamic Pricing Table (in USDC wei - 6 decimals)
// =============================================================================

export const DYNAMIC_PRICES = {
    // Agent Inference
    AGENT_CHAT: "5000",              // $0.005 per message

    // Tool Execution - Simple (read-only operations)
    GOAT_SIMPLE: "1000",             // $0.001 - price check, balance query
    MCP_TOOL_READ: "1000",           // $0.001 - read operations

    // Tool Execution - Transactions (on-chain writes)
    GOAT_TRANSACTION: "5000",        // $0.005 - swap, transfer, approve
    GOAT_COMPLEX: "10000",           // $0.01 - multi-step operations

    // MCP Server Tools
    MCP_TOOL_CALL: "1000",           // $0.001 - default MCP tool

    // Workflow Orchestration
    MANOWAR_ORCHESTRATION: "10000",  // $0.01 - coordinator fee
    MANOWAR_DELEGATION: "2000",      // $0.002 - per agent delegation

    // Multimodal Generation
    IMAGE_GEN_SDXL: "50000",         // $0.05 - Stable Diffusion XL
    IMAGE_GEN_FLUX: "100000",        // $0.10 - Flux Pro
    AUDIO_TTS: "20000",              // $0.02 - Text-to-Speech
    AUDIO_STT: "15000",              // $0.015 - Speech-to-Text
    VIDEO_GEN: "500000",             // $0.50 - Video generation

    // Memory & Storage
    MEM0_SEARCH: "500",              // $0.0005 - memory search
    MEM0_ADD: "1000",                // $0.001 - memory addition

    // ElizaOS Actions
    ELIZA_MESSAGE: "1000",           // $0.001 - message processing
    ELIZA_ACTION: "2000",            // $0.002 - action execution
} as const;

// =============================================================================
// Default Prices (for backward compatibility)
// =============================================================================

export const DEFAULT_PRICES = {
    MCP_TOOL_CALL: DYNAMIC_PRICES.MCP_TOOL_CALL,
    GOAT_EXECUTE: DYNAMIC_PRICES.GOAT_SIMPLE,
    ELIZA_MESSAGE: DYNAMIC_PRICES.ELIZA_MESSAGE,
    ELIZA_ACTION: DYNAMIC_PRICES.ELIZA_ACTION,
    WORKFLOW_RUN: DYNAMIC_PRICES.MANOWAR_ORCHESTRATION,
    AGENT_CHAT: DYNAMIC_PRICES.AGENT_CHAT,
} as const;

// =============================================================================
// Pricing Helper Functions
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

    // MCP tools - could be enhanced with tool-specific pricing
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
export function getMultimodalPrice(model: string): string {
    const modelLower = model.toLowerCase();

    // Image generation
    if (modelLower.includes("flux")) return DYNAMIC_PRICES.IMAGE_GEN_FLUX;
    if (modelLower.includes("sdxl") || modelLower.includes("stable-diffusion")) {
        return DYNAMIC_PRICES.IMAGE_GEN_SDXL;
    }

    // Audio
    if (modelLower.includes("tts") || modelLower.includes("bark")) {
        return DYNAMIC_PRICES.AUDIO_TTS;
    }
    if (modelLower.includes("whisper") || modelLower.includes("stt")) {
        return DYNAMIC_PRICES.AUDIO_STT;
    }

    // Video
    if (modelLower.includes("veo") || modelLower.includes("video")) {
        return DYNAMIC_PRICES.VIDEO_GEN;
    }

    // Default to agent chat pricing
    return DYNAMIC_PRICES.AGENT_CHAT;
}

/**
 * Format price in USDC wei to human-readable string
 */
export function formatPrice(weiAmount: string): string {
    const usdc = parseInt(weiAmount) / 1_000_000;
    return `$${usdc.toFixed(6)}`;
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
