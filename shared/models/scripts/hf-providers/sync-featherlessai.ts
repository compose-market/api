/**
 * Featherless AI Pricing Sync
 * 
 * Output: featherless-ai.json
 * Run: npx tsx scripts/sync-featherless-ai.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "featherless-ai";

// Featherless AI - serverless inference
const FEATHERLESS_PRICING: Record<string, { input: number; output: number; type: string }> = {
    "meta-llama/Llama-3.1-70B-Instruct": { input: 0.50, output: 0.50, type: "llm" },
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.10, output: 0.10, type: "llm" },
    "Qwen/Qwen2.5-72B-Instruct": { input: 0.50, output: 0.50, type: "llm" },
};

interface ProviderModel { id: string; input: number; output: number; type: string; }
interface ProviderData { provider: string; source: string; lastUpdated: string; totalModels: number; models: ProviderModel[]; }

async function main(): Promise<void> {
    console.log(`[sync-${PROVIDER}] Starting ${PROVIDER} pricing sync...\n`);
    const models: ProviderModel[] = Object.entries(FEATHERLESS_PRICING).map(([id, p]) => ({ id, ...p }));
    const data: ProviderData = { provider: PROVIDER, source: "https://featherless.ai/", lastUpdated: new Date().toISOString(), totalModels: models.length, models };
    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`[sync-${PROVIDER}] Models: ${models.length}, Wrote to ${outPath}`);
}

main().catch(console.error);
