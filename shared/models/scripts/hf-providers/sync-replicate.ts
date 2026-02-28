/**
 * Replicate Pricing Sync
 * 
 * Hardcoded pricing from replicate.com/pricing page
 * 
 * Output: replicate.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-replicate.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "replicate";

// Replicate pricing from their public pricing page
// Last updated: 2025-12-31
// Source: https://replicate.com/pricing
const REPLICATE_PRICING: Record<string, { input: number; output: number; type: string; unit: string }> = {
    // LLMs - per 1M tokens
    "meta/llama-3-70b-instruct": { input: 0.65, output: 2.75, type: "llm", unit: "per_million_tokens" },
    "anthropic/claude-3.7-sonnet": { input: 3.00, output: 15.00, type: "llm", unit: "per_million_tokens" },
    "deepseek/deepseek-v3": { input: 1.45, output: 1.45, type: "llm", unit: "per_million_tokens" },

    // Image models - per image
    "black-forest-labs/flux-1.1-pro-ultra": { input: 0.06, output: 0, type: "image", unit: "per_image" },
    "black-forest-labs/flux-dev": { input: 0.025, output: 0, type: "image", unit: "per_image" },
    "black-forest-labs/flux-schnell": { input: 0.003, output: 0, type: "image", unit: "per_image" },
    "stability-ai/sdxl": { input: 0.002, output: 0, type: "image", unit: "per_image" },
    "recraft-ai/recraft-v3-svg": { input: 0.08, output: 0, type: "image", unit: "per_image" },
    "ideogram-ai/ideogram-v2": { input: 0.08, output: 0, type: "image", unit: "per_image" },

    // Video models - per second
    "google/veo-2": { input: 0.50, output: 0, type: "video", unit: "per_second" },
    "kuaishou-ai/kling-v1.6-pro": { input: 0.098, output: 0, type: "video", unit: "per_second" },
    "haiper-ai/haiper-video-2": { input: 0.05, output: 0, type: "video", unit: "per_second" },
    "minimax/video-01": { input: 0.035, output: 0, type: "video", unit: "per_second" },

    // Audio models
    "meta/musicgen": { input: 0.064, output: 0, type: "audio", unit: "per_run" },
    "playht/play-dialog": { input: 0.001, output: 0, type: "tts", unit: "per_second" },
};

interface ProviderModel {
    id: string;
    input: number;
    output: number;
    type: string;
    unit: string;
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
    console.log(`[sync-${PROVIDER}] Using hardcoded pricing from replicate.com/pricing\n`);

    const models: ProviderModel[] = Object.entries(REPLICATE_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
        unit: pricing.unit,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://replicate.com/pricing",
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
