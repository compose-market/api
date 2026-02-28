/**
 * Together API Pricing Sync (Authenticated)
 * 
 * Uses TOGETHER_API_KEY to fetch all models with real pricing
 * 
 * Output: data/huggingface/together.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;

if (!TOGETHER_API_KEY) {
    console.error("[sync-together] ERROR: TOGETHER_API_KEY not found in .env");
    process.exit(1);
}

interface TogetherModel {
    id: string;
    display_name?: string;
    type?: string;
    context_length?: number;
    pricing?: {
        input: number;
        output: number;
        hourly?: number;
        base?: number;
        finetune?: number;
    };
}

interface OutputModel {
    id: string;
    name: string;
    type: string;
    context_length: number | null;
    pricing: {
        input_per_1m: number;
        output_per_1m: number;
        currency: string;
    } | null;
}

async function syncTogether(): Promise<void> {
    console.log("[sync-together] Fetching models from api.together.xyz...\n");

    const response = await fetch("https://api.together.xyz/v1/models", {
        headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const models = await response.json() as TogetherModel[];
    console.log(`[sync-together] Fetched ${models.length} models\n`);

    const output: OutputModel[] = models.map(m => ({
        id: m.id,
        name: m.display_name || m.id,
        type: m.type || "unknown",
        context_length: m.context_length || null,
        pricing: m.pricing ? {
            input_per_1m: m.pricing.input,
            output_per_1m: m.pricing.output,
            currency: "USD"
        } : null
    }));

    const modelsWithPricing = output.filter(m => m.pricing !== null).length;

    const data = {
        provider: "together",
        lastUpdated: new Date().toISOString(),
        totalModels: output.length,
        modelsWithPricing,
        models: output
    };

    const outPath = path.join(__dirname, "..", "data", "huggingface", "together.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

    console.log("=".repeat(60));
    console.log(`[sync-together] RESULTS:`);
    console.log(`  Total models: ${output.length}`);
    console.log(`  Models with pricing: ${modelsWithPricing} (${((modelsWithPricing / output.length) * 100).toFixed(1)}%)`);
    console.log(`\n[sync-together] Wrote to ${outPath}`);
}

syncTogether().catch(console.error);
