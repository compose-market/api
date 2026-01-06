/**
 * Fireworks AI Pricing Sync
 * 
 * Hardcoded pricing from fireworks.ai/pricing
 * 
 * Output: fireworks-ai.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-fireworks-ai.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "fireworks-ai";

// Fireworks pricing from their public pricing page
// Last updated: 2025-12-31
// Source: https://fireworks.ai/pricing
const FIREWORKS_PRICING: Record<string, { input: number; output: number; type: string }> = {
    // LLMs - per 1M tokens
    "accounts/fireworks/models/llama-v3p1-405b-instruct": { input: 3.00, output: 3.00, type: "llm" },
    "accounts/fireworks/models/llama-v3p1-70b-instruct": { input: 0.90, output: 0.90, type: "llm" },
    "accounts/fireworks/models/llama-v3p1-8b-instruct": { input: 0.20, output: 0.20, type: "llm" },
    "accounts/fireworks/models/llama-v3p3-70b-instruct": { input: 0.90, output: 0.90, type: "llm" },
    "accounts/fireworks/models/mixtral-8x7b-instruct": { input: 0.50, output: 0.50, type: "llm" },
    "accounts/fireworks/models/qwen2p5-72b-instruct": { input: 0.90, output: 0.90, type: "llm" },
    "accounts/fireworks/models/deepseek-v3": { input: 0.90, output: 0.90, type: "llm" },

    // Image models
    "accounts/fireworks/models/flux-1-dev": { input: 0.025, output: 0, type: "image" },
    "accounts/fireworks/models/flux-1-schnell": { input: 0.003, output: 0, type: "image" },
    "accounts/fireworks/models/sdxl": { input: 0.002, output: 0, type: "image" },
};

interface ProviderModel {
    id: string;
    input: number;
    output: number;
    type: string;
}

interface ProviderData {
    provider: string;
    source: string;
    lastUpdated: string;
    totalModels: number;
    models: ProviderModel[];
}

async function main(): Promise<void> {
    console.log(`[sync-${PROVIDER}] Starting ${PROVIDER} pricing sync...\n`);

    const models: ProviderModel[] = Object.entries(FIREWORKS_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://fireworks.ai/pricing",
        lastUpdated: new Date().toISOString(),
        totalModels: models.length,
        models,
    };

    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

    console.log(`[sync-${PROVIDER}] Models: ${models.length}`);
    console.log(`[sync-${PROVIDER}] Wrote to ${outPath}`);
}

main().catch(console.error);
