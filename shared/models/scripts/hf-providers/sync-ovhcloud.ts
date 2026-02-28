/**
 * OVHcloud Pricing Sync
 * 
 * Hardcoded pricing from ovhcloud AI endpoints
 * 
 * Output: ovhcloud.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-ovhcloud.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "ovhcloud";

// OVHcloud pricing
// Last updated: 2025-12-31
// Source: https://www.ovhcloud.com/en/public-cloud/ai-endpoints/
const OVHCLOUD_PRICING: Record<string, { input: number; output: number; type: string }> = {
    "meta-llama/Llama-3.1-70B-Instruct": { input: 0.50, output: 0.50, type: "llm" },
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.15, output: 0.15, type: "llm" },
    "mistralai/Mistral-7B-Instruct-v0.3": { input: 0.15, output: 0.15, type: "llm" },
    "Qwen/Qwen2.5-72B-Instruct": { input: 0.50, output: 0.50, type: "llm" },
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

    const models: ProviderModel[] = Object.entries(OVHCLOUD_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/",
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
