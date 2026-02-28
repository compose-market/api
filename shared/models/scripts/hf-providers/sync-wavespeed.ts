/**
 * Wavespeed Pricing Sync
 * 
 * Hardcoded pricing from wavespeed.ai
 * 
 * Output: wavespeed.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-wavespeed.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "wavespeed";

// Wavespeed pricing - focused on fast image/video generation
// Last updated: 2025-12-31
// Source: https://wavespeed.ai/
const WAVESPEED_PRICING: Record<string, { input: number; output: number; type: string }> = {
    // Image models - per image
    "wavespeed-ai/flux-dev": { input: 0.02, output: 0, type: "image" },
    "wavespeed-ai/flux-schnell": { input: 0.002, output: 0, type: "image" },
    "wavespeed-ai/sdxl": { input: 0.001, output: 0, type: "image" },
    "wavespeed-ai/sdxl-lightning": { input: 0.001, output: 0, type: "image" },

    // Video models
    "wavespeed-ai/wan-2.1-i2v": { input: 0.10, output: 0, type: "video" },
    "wavespeed-ai/hunyuan-video": { input: 0.15, output: 0, type: "video" },
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

    const models: ProviderModel[] = Object.entries(WAVESPEED_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://wavespeed.ai/",
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
