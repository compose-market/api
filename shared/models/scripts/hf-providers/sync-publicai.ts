/**
 * PublicAI Pricing Sync
 * Output: publicai.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROVIDER = "publicai";

const PUBLICAI_PRICING: Record<string, { input: number; output: number; type: string }> = {
    "meta-llama/Llama-3.1-70B-Instruct": { input: 0.35, output: 0.35, type: "llm" },
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.08, output: 0.08, type: "llm" },
};

interface ProviderModel { id: string; input: number; output: number; type: string; }
interface ProviderData { provider: string; source: string; lastUpdated: string; totalModels: number; models: ProviderModel[]; }

async function main(): Promise<void> {
    const models: ProviderModel[] = Object.entries(PUBLICAI_PRICING).map(([id, p]) => ({ id, ...p }));
    const data: ProviderData = { provider: PROVIDER, source: "https://publicai.io/", lastUpdated: new Date().toISOString(), totalModels: models.length, models };
    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`[sync-${PROVIDER}] Models: ${models.length}`);
}

main().catch(console.error);
