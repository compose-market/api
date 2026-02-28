/**
 * Cerebras Pricing Sync
 * 
 * Hardcoded pricing from cerebras.ai/pricing page
 * 
 * Output: cerebras.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-cerebras.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "cerebras";

// Cerebras pricing from their public pricing page
// Last updated: 2025-12-31
// Source: https://cerebras.ai/pricing
const CEREBRAS_PRICING: Record<string, { input: number; output: number; type: string }> = {
    // LLMs - per 1M tokens
    "llama3.1-8b": { input: 0.10, output: 0.10, type: "llm" },
    "llama-3.3-70b": { input: 0.60, output: 0.60, type: "llm" },
    "llama-4-scout-17b-16e-instruct": { input: 0.20, output: 0.20, type: "llm" },
    "qwen-3-32b": { input: 0.20, output: 0.20, type: "llm" },
    "qwen-3-235b-a22b-instruct": { input: 0.90, output: 0.90, type: "llm" },
    "gpt-oss-120b": { input: 0.00, output: 0.00, type: "llm" }, // Free preview
    "deepseek-r1-distill-llama-70b": { input: 0.60, output: 0.60, type: "llm" },
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
    console.log(`[sync-${PROVIDER}] Using hardcoded pricing from cerebras.ai/pricing\n`);

    const models: ProviderModel[] = Object.entries(CEREBRAS_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://cerebras.ai/pricing",
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
