/**
 * Nebius AI Pricing Sync
 * 
 * Hardcoded pricing from nebius.com/ai-studio pricing
 * 
 * Output: nebius.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-nebius.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "nebius";

// Nebius pricing from their public pricing
// Last updated: 2025-12-31
// Source: https://nebius.com/ai-studio
const NEBIUS_PRICING: Record<string, { input: number; output: number; type: string }> = {
    // LLMs - per 1M tokens
    "meta-llama/Llama-3.1-405B-Instruct": { input: 1.00, output: 3.00, type: "llm" },
    "meta-llama/Llama-3.1-70B-Instruct": { input: 0.35, output: 0.40, type: "llm" },
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.02, output: 0.05, type: "llm" },
    "meta-llama/Llama-3.3-70B-Instruct": { input: 0.35, output: 0.40, type: "llm" },
    "Qwen/Qwen2.5-72B-Instruct": { input: 0.35, output: 0.40, type: "llm" },
    "Qwen/Qwen3-235B-A22B-Instruct": { input: 0.30, output: 0.80, type: "llm" },
    "deepseek-ai/DeepSeek-R1": { input: 0.55, output: 2.20, type: "llm" },
    "mistralai/Mistral-Large-2411": { input: 1.00, output: 3.00, type: "llm" },

    // Image models
    "black-forest-labs/FLUX.1-dev": { input: 0.025, output: 0, type: "image" },
    "black-forest-labs/FLUX.1-schnell": { input: 0.003, output: 0, type: "image" },
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
    console.log(`[sync-${PROVIDER}] Using hardcoded pricing from nebius.com\n`);

    const models: ProviderModel[] = Object.entries(NEBIUS_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://nebius.com/ai-studio",
        lastUpdated: new Date().toISOString(),
        totalModels: models.length,
        models,
    };

    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

    console.log(`[sync-${PROVIDER}] Results:`);
    console.log(`  Models with pricing: ${models.length}`);
    console.log(`\n[sync-${PROVIDER}] Wrote to ${outPath}`);
}

main().catch(console.error);
