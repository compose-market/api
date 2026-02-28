/**
 * Sambanova API Pricing Sync (Authenticated)
 * 
 * Uses SAMBANOVA_API_KEY to fetch all models with real pricing
 * Fields: pricing.completion, pricing.prompt
 * 
 * Output: data/huggingface/sambanova.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMBANOVA_API_KEY = process.env.SAMBANOVA_API_KEY;

if (!SAMBANOVA_API_KEY) {
    console.error("[sync-sambanova] ERROR: SAMBANOVA_API_KEY not found in .env");
    process.exit(1);
}

interface SambanovaModel {
    id: string;
    context_length?: number;
    max_completion_tokens?: number;
    pricing?: {
        completion: string;
        prompt: string;
        duration_per_hour?: string;
    };
}

interface OutputModel {
    id: string;
    name: string;
    context_length: number | null;
    pricing: {
        input_per_1m: number;
        output_per_1m: number;
        currency: string;
    } | null;
}

async function syncSambanova(): Promise<void> {
    console.log("[sync-sambanova] Fetching models from api.sambanova.ai...\n");

    const response = await fetch("https://api.sambanova.ai/v1/models", {
        headers: { Authorization: `Bearer ${SAMBANOVA_API_KEY}` },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as { data: SambanovaModel[] };
    const models = data.data || [];
    console.log(`[sync-sambanova] Fetched ${models.length} models\n`);

    const output: OutputModel[] = models.map(m => {
        // Sambanova returns per-token price as string, convert to per-1M
        let pricing = null;
        if (m.pricing && m.pricing.prompt && m.pricing.completion) {
            const promptPrice = parseFloat(m.pricing.prompt);
            const completionPrice = parseFloat(m.pricing.completion);
            // Convert from per-token to per-1M tokens
            pricing = {
                input_per_1m: promptPrice * 1_000_000,
                output_per_1m: completionPrice * 1_000_000,
                currency: "USD"
            };
        }
        return {
            id: m.id,
            name: m.id,
            context_length: m.context_length || null,
            pricing
        };
    });

    const modelsWithPricing = output.filter(m => m.pricing !== null).length;

    const result = {
        provider: "sambanova",
        lastUpdated: new Date().toISOString(),
        totalModels: output.length,
        modelsWithPricing,
        models: output
    };

    const outPath = path.join(__dirname, "..", "data", "huggingface", "sambanova.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.log("=".repeat(60));
    console.log(`[sync-sambanova] RESULTS:`);
    console.log(`  Total models: ${output.length}`);
    console.log(`  Models with pricing: ${modelsWithPricing} (${((modelsWithPricing / output.length) * 100).toFixed(1)}%)`);
    console.log(`\n[sync-sambanova] Wrote to ${outPath}`);
}

syncSambanova().catch(console.error);
