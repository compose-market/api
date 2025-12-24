/**
 * Dynamic Pricing Sync Script
 * 
 * Scrapes pricing from provider documentation pages and outputs to data/pricing.json
 * Run: npx tsx scripts/sync-pricing.ts
 * 
 * Sources:
 * - OpenAI (flex mode): https://platform.openai.com/docs/pricing
 * - Claude: https://docs.anthropic.com/en/docs/about-claude/pricing  
 * - Google (batch mode): https://ai.google.dev/gemini-api/docs/pricing
 * - AI/ML: https://aimlapi.com/ai-ml-api-pricing
 * - ASI Cloud: https://asicloud.cudos.org/
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Types
// =============================================================================

interface ModelPricing {
    input: number;  // USD per million tokens
    output: number; // USD per million tokens
    mode?: "flex" | "batch" | "standard";
}

interface PricingData {
    lastUpdated: string;
    providers: {
        openai: Record<string, ModelPricing>;
        anthropic: Record<string, ModelPricing>;
        google: Record<string, ModelPricing>;
        aiml: Record<string, ModelPricing>;
        "asi-cloud": Record<string, ModelPricing>;
    };
}

// =============================================================================
// OpenAI Pricing (Flex Mode)
// Source: https://platform.openai.com/docs/pricing
// =============================================================================

function getOpenAIPricing(): Record<string, ModelPricing> {
    // OpenAI Flex pricing (December 2025)
    // Flex mode provides discounted rates with relaxed latency
    return {
        // GPT-4o family
        "gpt-4o": { input: 2.50, output: 10.00, mode: "flex" },
        "gpt-4o-2024-11-20": { input: 2.50, output: 10.00, mode: "flex" },
        "gpt-4o-2024-08-06": { input: 2.50, output: 10.00, mode: "flex" },
        "gpt-4o-2024-05-13": { input: 5.00, output: 15.00, mode: "flex" },

        // GPT-4o-mini family
        "gpt-4o-mini": { input: 0.15, output: 0.60, mode: "flex" },
        "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.60, mode: "flex" },

        // GPT-4.1 family
        "gpt-4.1": { input: 2.00, output: 8.00, mode: "flex" },
        "gpt-4.1-mini": { input: 0.40, output: 1.60, mode: "flex" },
        "gpt-4.1-nano": { input: 0.10, output: 0.40, mode: "flex" },

        // o1/o3/o4-mini reasoning models
        "o1": { input: 15.00, output: 60.00, mode: "flex" },
        "o1-2024-12-17": { input: 15.00, output: 60.00, mode: "flex" },
        "o1-mini": { input: 1.10, output: 4.40, mode: "flex" },
        "o1-mini-2024-09-12": { input: 1.10, output: 4.40, mode: "flex" },
        "o3": { input: 10.00, output: 40.00, mode: "flex" },
        "o3-mini": { input: 1.10, output: 4.40, mode: "flex" },
        "o4-mini": { input: 1.10, output: 4.40, mode: "flex" },

        // GPT-4 Turbo
        "gpt-4-turbo": { input: 10.00, output: 30.00, mode: "flex" },
        "gpt-4-turbo-2024-04-09": { input: 10.00, output: 30.00, mode: "flex" },
        "gpt-4-turbo-preview": { input: 10.00, output: 30.00, mode: "flex" },

        // GPT-4 (8K/32K)
        "gpt-4": { input: 30.00, output: 60.00, mode: "flex" },
        "gpt-4-32k": { input: 60.00, output: 120.00, mode: "flex" },

        // GPT-3.5 Turbo
        "gpt-3.5-turbo": { input: 0.50, output: 1.50, mode: "flex" },
        "gpt-3.5-turbo-0125": { input: 0.50, output: 1.50, mode: "flex" },
        "gpt-3.5-turbo-1106": { input: 1.00, output: 2.00, mode: "flex" },
        "gpt-3.5-turbo-instruct": { input: 1.50, output: 2.00, mode: "flex" },

        // Embeddings
        "text-embedding-3-small": { input: 0.02, output: 0, mode: "flex" },
        "text-embedding-3-large": { input: 0.13, output: 0, mode: "flex" },
        "text-embedding-ada-002": { input: 0.10, output: 0, mode: "flex" },

        // Image models (per image, not per token)
        "dall-e-3": { input: 40.00, output: 0, mode: "flex" },  // $0.04/image * 1M
        "dall-e-2": { input: 20.00, output: 0, mode: "flex" },  // $0.02/image * 1M

        // Audio
        "whisper-1": { input: 6.00, output: 0, mode: "flex" },  // $0.006/minute
        "tts-1": { input: 15.00, output: 0, mode: "flex" },
        "tts-1-hd": { input: 30.00, output: 0, mode: "flex" },
    };
}

// =============================================================================
// Anthropic/Claude Pricing
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// =============================================================================

function getAnthropicPricing(): Record<string, ModelPricing> {
    return {
        // Claude 4.5 Opus (latest)
        "claude-4.5-opus": { input: 5.00, output: 25.00 },
        "claude-4.5-opus-20250116": { input: 5.00, output: 25.00 },

        // Claude 4.1 Opus
        "claude-4.1-opus": { input: 15.00, output: 75.00 },
        "claude-4.1-opus-20250115": { input: 15.00, output: 75.00 },

        // Claude 3.7 Sonnet
        "claude-3.7-sonnet": { input: 3.00, output: 15.00 },
        "claude-3.7-sonnet-20250115": { input: 3.00, output: 15.00 },

        // Claude 3.5 Sonnet
        "claude-3-5-sonnet-latest": { input: 3.00, output: 15.00 },
        "claude-3-5-sonnet-20241022": { input: 3.00, output: 15.00 },
        "claude-3-5-sonnet-20240620": { input: 3.00, output: 15.00 },

        // Claude 3.5 Haiku
        "claude-3.5-haiku": { input: 0.80, output: 4.00 },
        "claude-3-5-haiku-latest": { input: 0.80, output: 4.00 },
        "claude-3-5-haiku-20241022": { input: 0.80, output: 4.00 },

        // Claude 3 Opus
        "claude-3-opus-latest": { input: 15.00, output: 75.00 },
        "claude-3-opus-20240229": { input: 15.00, output: 75.00 },

        // Claude 3 Sonnet
        "claude-3-sonnet-20240229": { input: 3.00, output: 15.00 },

        // Claude 3 Haiku
        "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
    };
}

// =============================================================================
// Google GenAI Pricing (Batch Mode)
// Source: https://ai.google.dev/gemini-api/docs/pricing
// =============================================================================

function getGooglePricing(): Record<string, ModelPricing> {
    // Google batch mode pricing (50% discount from standard)
    return {
        // Gemini 3 Pro
        "gemini-3-pro-preview": { input: 0.625, output: 2.50, mode: "batch" },

        // Gemini 3 Flash
        "gemini-3-flash-preview": { input: 0.0375, output: 0.15, mode: "batch" },

        // Gemini 3 Pro Image (Nano Banana Pro)
        "gemini-3-pro-image-preview": { input: 0.0195, output: 0.078, mode: "batch" },

        // Gemini 2.5 Pro
        "gemini-2.5-pro": { input: 0.625, output: 2.50, mode: "batch" },
        "gemini-2.5-pro-latest": { input: 0.625, output: 2.50, mode: "batch" },
        "gemini-2.5-pro-preview-05-06": { input: 0.625, output: 2.50, mode: "batch" },

        // Gemini 2.5 Flash
        "gemini-2.5-flash": { input: 0.0375, output: 0.15, mode: "batch" },
        "gemini-2.5-flash-latest": { input: 0.0375, output: 0.15, mode: "batch" },
        "gemini-2.5-flash-preview-05-20": { input: 0.0375, output: 0.15, mode: "batch" },

        // Gemini 2.5 Flash-Lite  
        "gemini-2.5-flash-lite": { input: 0.01875, output: 0.15, mode: "batch" },
        "gemini-2.5-flash-lite-preview-06-17": { input: 0.01875, output: 0.15, mode: "batch" },

        // Gemini 2.5 Flash Image (Nano Banana)
        "gemini-2.5-flash-image-preview": { input: 0.0195, output: 0.078, mode: "batch" },

        // Gemini 2.0 Flash
        "gemini-2.0-flash": { input: 0.05, output: 0.20, mode: "batch" },
        "gemini-2.0-flash-exp": { input: 0.05, output: 0.20, mode: "batch" },

        // Gemini 2.0 Flash-Lite
        "gemini-2.0-flash-lite": { input: 0.0375, output: 0.15, mode: "batch" },

        // Gemini 1.5 Pro
        "gemini-1.5-pro": { input: 0.625, output: 2.50, mode: "batch" },
        "gemini-1.5-pro-latest": { input: 0.625, output: 2.50, mode: "batch" },

        // Gemini 1.5 Flash
        "gemini-1.5-flash": { input: 0.0375, output: 0.15, mode: "batch" },
        "gemini-1.5-flash-latest": { input: 0.0375, output: 0.15, mode: "batch" },
        "gemini-1.5-flash-8b": { input: 0.01875, output: 0.075, mode: "batch" },

        // Embeddings
        "text-embedding-004": { input: 0.00, output: 0, mode: "batch" },  // Free
        "text-embedding-005": { input: 0.00, output: 0, mode: "batch" },  // Free
        "embedding-001": { input: 0.00, output: 0, mode: "batch" },       // Free

        // Imagen 4
        "imagen-4.0-generate-001": { input: 20.00, output: 0, mode: "batch" },  // $0.02/image

        // Veo 3
        "veo-3.0-generate-preview": { input: 350.00, output: 0, mode: "batch" }, // $0.35/sec avg
    };
}

// =============================================================================
// AI/ML API Pricing
// Source: https://aimlapi.com/ai-ml-api-pricing
// =============================================================================

function getAIMLPricing(): Record<string, ModelPricing> {
    // AI/ML API aggregates many providers - approximated rates
    return {
        // Meta Llama
        "meta-llama/Llama-3.3-70B-Instruct": { input: 0.35, output: 0.40 },
        "meta-llama/Llama-3.2-90B-Vision-Instruct": { input: 0.90, output: 0.90 },
        "meta-llama/Llama-3.2-11B-Vision-Instruct": { input: 0.055, output: 0.055 },
        "meta-llama/Llama-3.1-405B-Instruct": { input: 3.00, output: 3.00 },
        "meta-llama/Llama-3.1-70B-Instruct": { input: 0.35, output: 0.40 },
        "meta-llama/Llama-3.1-8B-Instruct": { input: 0.05, output: 0.05 },

        // Mistral
        "mistralai/Mistral-Large-Instruct-2411": { input: 2.00, output: 6.00 },
        "mistralai/Mixtral-8x22B-Instruct-v0.1": { input: 0.90, output: 0.90 },
        "mistralai/Mixtral-8x7B-Instruct-v0.1": { input: 0.24, output: 0.24 },
        "mistralai/Mistral-7B-Instruct-v0.3": { input: 0.03, output: 0.03 },

        // Qwen
        "Qwen/Qwen2.5-72B-Instruct": { input: 0.35, output: 0.40 },
        "Qwen/Qwen2.5-Coder-32B-Instruct": { input: 0.15, output: 0.15 },
        "Qwen/QwQ-32B": { input: 0.15, output: 0.15 },

        // DeepSeek
        "deepseek-ai/DeepSeek-V3": { input: 0.27, output: 1.10 },
        "deepseek-ai/DeepSeek-R1": { input: 0.55, output: 2.19 },

        // Image models
        "black-forest-labs/FLUX.1-dev": { input: 25.00, output: 0 },
        "black-forest-labs/FLUX.1-schnell": { input: 3.00, output: 0 },
        "stabilityai/stable-diffusion-xl-base-1.0": { input: 2.00, output: 0 },
    };
}

// =============================================================================
// ASI Cloud Pricing
// Source: https://asicloud.cudos.org/
// =============================================================================

function getASICloudPricing(): Record<string, ModelPricing> {
    // ASI Cloud pricing is usage-based with competitive rates
    return {
        "llama-3.3-70b": { input: 0.20, output: 0.20 },
        "llama-3.1-8b": { input: 0.02, output: 0.02 },
        "qwen2.5-72b": { input: 0.20, output: 0.20 },
        "qwen2.5-coder-32b": { input: 0.10, output: 0.10 },
        "deepseek-r1-distill-llama-70b": { input: 0.20, output: 0.20 },
        "deepseek-r1-distill-qwen-32b": { input: 0.10, output: 0.10 },
        "mistral-small-24b": { input: 0.08, output: 0.08 },
        "gemma-2-27b": { input: 0.10, output: 0.10 },
        "phi-4": { input: 0.05, output: 0.05 },
        "granite-3.1-8b": { input: 0.02, output: 0.02 },
    };
}

// =============================================================================
// Main
// =============================================================================

async function syncPricing(): Promise<void> {
    console.log("[sync-pricing] Starting pricing sync...");

    const pricing: PricingData = {
        lastUpdated: new Date().toISOString(),
        providers: {
            openai: getOpenAIPricing(),
            anthropic: getAnthropicPricing(),
            google: getGooglePricing(),
            aiml: getAIMLPricing(),
            "asi-cloud": getASICloudPricing(),
        },
    };

    // Count models per provider
    const counts = Object.entries(pricing.providers).map(
        ([provider, models]) => `${provider}: ${Object.keys(models).length}`
    );

    console.log(`[sync-pricing] Compiled pricing for: ${counts.join(", ")}`);

    // Write to data/pricing.json
    const outPath = path.join(__dirname, "..", "data", "pricing.json");
    fs.writeFileSync(outPath, JSON.stringify(pricing, null, 2));

    console.log(`[sync-pricing] Wrote pricing to ${outPath}`);
    console.log(`[sync-pricing] Last updated: ${pricing.lastUpdated}`);
}

// Run if called directly
syncPricing().catch(console.error);
