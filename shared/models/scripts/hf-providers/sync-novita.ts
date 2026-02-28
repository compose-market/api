/**
 * Novita API Pricing Sync (Authenticated)
 * 
 * Uses NOVITA_API_KEY to fetch all models with real pricing
 * Fields: input_token_price_per_m, output_token_price_per_m
 * 
 * Output: data/huggingface/novita.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;

if (!NOVITA_API_KEY) {
    console.error("[sync-novita] ERROR: NOVITA_API_KEY not found in .env");
    process.exit(1);
}

interface NovitaModel {
    id: string;
    title?: string;
    display_name?: string;
    model_type?: string;
    context_size?: number;
    input_token_price_per_m?: number;
    output_token_price_per_m?: number;
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

async function syncNovita(): Promise<void> {
    console.log("[sync-novita] Fetching models from api.novita.ai...\n");

    const response = await fetch("https://api.novita.ai/v3/openai/models", {
        headers: { Authorization: `Bearer ${NOVITA_API_KEY}` },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as { data: NovitaModel[] };
    const models = data.data || [];
    console.log(`[sync-novita] Fetched ${models.length} models\n`);

    const output: OutputModel[] = models.map(m => ({
        id: m.id,
        name: m.display_name || m.title || m.id,
        type: m.model_type || "unknown",
        context_length: m.context_size || null,
        pricing: (m.input_token_price_per_m !== undefined) ? {
            // Novita returns price in 1/1000 of a cent, convert to dollars per 1M
            input_per_1m: m.input_token_price_per_m / 1000,
            output_per_1m: (m.output_token_price_per_m || 0) / 1000,
            currency: "USD"
        } : null
    }));

    const modelsWithPricing = output.filter(m => m.pricing !== null).length;

    const result = {
        provider: "novita",
        lastUpdated: new Date().toISOString(),
        totalModels: output.length,
        modelsWithPricing,
        models: output
    };

    const outPath = path.join(__dirname, "..", "data", "huggingface", "novita.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.log("=".repeat(60));
    console.log(`[sync-novita] RESULTS:`);
    console.log(`  Total models: ${output.length}`);
    console.log(`  Models with pricing: ${modelsWithPricing} (${((modelsWithPricing / output.length) * 100).toFixed(1)}%)`);
    console.log(`\n[sync-novita] Wrote to ${outPath}`);
}

syncNovita().catch(console.error);
