/**
 * nScale Pricing Sync
 * 
 * Hardcoded pricing from nscale.com
 * 
 * Output: nscale.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-nscale.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "nscale";

// nScale pricing
// Last updated: 2025-12-31
// Source: https://nscale.com/
const NSCALE_PRICING: Record<string, { input: number; output: number; type: string }> = {
    "meta-llama/Llama-3.1-70B-Instruct": { input: 0.30, output: 0.30, type: "llm" },
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.08, output: 0.08, type: "llm" },
    "meta-llama/Llama-3.3-70B-Instruct": { input: 0.30, output: 0.30, type: "llm" },
    "Qwen/Qwen2.5-72B-Instruct": { input: 0.30, output: 0.30, type: "llm" },
    "deepseek-ai/DeepSeek-V3": { input: 0.40, output: 0.40, type: "llm" },
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

    const models: ProviderModel[] = Object.entries(NSCALE_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://nscale.com/",
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
