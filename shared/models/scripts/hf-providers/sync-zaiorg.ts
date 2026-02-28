/**
 * ZAI Org (GLM) Pricing Sync
 * Output: zai-org.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROVIDER = "zai-org";

const ZAI_PRICING: Record<string, { input: number; output: number; type: string }> = {
    "zai-org/GLM-4.5-Air": { input: 0.10, output: 0.10, type: "llm" },
    "zai-org/GLM-4.6": { input: 0.15, output: 0.15, type: "llm" },
};

interface ProviderModel { id: string; input: number; output: number; type: string; }
interface ProviderData { provider: string; source: string; lastUpdated: string; totalModels: number; models: ProviderModel[]; }

async function main(): Promise<void> {
    const models: ProviderModel[] = Object.entries(ZAI_PRICING).map(([id, p]) => ({ id, ...p }));
    const data: ProviderData = { provider: PROVIDER, source: "https://open.bigmodel.cn/", lastUpdated: new Date().toISOString(), totalModels: models.length, models };
    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`[sync-${PROVIDER}] Models: ${models.length}`);
}

main().catch(console.error);
