/**
 * Cohere Pricing Sync
 * Output: cohere.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROVIDER = "cohere";

// Cohere pricing from cohere.com/pricing
const COHERE_PRICING: Record<string, { input: number; output: number; type: string }> = {
    "CohereForAI/c4ai-command-r-plus": { input: 2.50, output: 10.00, type: "llm" },
    "CohereForAI/c4ai-command-r-v01": { input: 0.50, output: 1.50, type: "llm" },
    "CohereForAI/command-r7b-12-2024": { input: 0.0375, output: 0.15, type: "llm" },
    "Cohere/embed-english-v3.0": { input: 0.10, output: 0, type: "embedding" },
    "Cohere/rerank-english-v3.0": { input: 2.00, output: 0, type: "rerank" },
};

interface ProviderModel { id: string; input: number; output: number; type: string; }
interface ProviderData { provider: string; source: string; lastUpdated: string; totalModels: number; models: ProviderModel[]; }

async function main(): Promise<void> {
    const models: ProviderModel[] = Object.entries(COHERE_PRICING).map(([id, p]) => ({ id, ...p }));
    const data: ProviderData = { provider: PROVIDER, source: "https://cohere.com/pricing", lastUpdated: new Date().toISOString(), totalModels: models.length, models };
    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`[sync-${PROVIDER}] Models: ${models.length}`);
}

main().catch(console.error);
