/**
 * Hyperbolic API Pricing Sync (Authenticated)
 * 
 * Uses HYPERBOLIC_API_KEY to fetch all models with real pricing
 * Fields: input_price, output_price
 * 
 * Output: data/huggingface/hyperbolic.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HYPERBOLIC_API_KEY = process.env.HYPERBOLIC_API_KEY;

if (!HYPERBOLIC_API_KEY) {
    console.error("[sync-hyperbolic] ERROR: HYPERBOLIC_API_KEY not found in .env");
    process.exit(1);
}

interface HyperbolicModel {
    id: string;
    owned_by?: string;
    context_length?: number | null;
    input_price?: number | null;
    output_price?: number | null;
    supports_chat?: boolean;
    supports_image_input?: boolean;
    supports_tools?: boolean;
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

async function syncHyperbolic(): Promise<void> {
    console.log("[sync-hyperbolic] Fetching models from api.hyperbolic.xyz...\n");

    const response = await fetch("https://api.hyperbolic.xyz/v1/models", {
        headers: { Authorization: `Bearer ${HYPERBOLIC_API_KEY}` },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as { data: HyperbolicModel[] };
    const models = data.data || [];
    console.log(`[sync-hyperbolic] Fetched ${models.length} models\n`);

    const output: OutputModel[] = models.map(m => ({
        id: m.id,
        name: m.id,
        context_length: m.context_length || null,
        pricing: (m.input_price !== null && m.input_price !== undefined) ? {
            input_per_1m: m.input_price,
            output_per_1m: m.output_price || m.input_price,
            currency: "USD"
        } : null
    }));

    const modelsWithPricing = output.filter(m => m.pricing !== null).length;

    const result = {
        provider: "hyperbolic",
        lastUpdated: new Date().toISOString(),
        totalModels: output.length,
        modelsWithPricing,
        models: output
    };

    const outPath = path.join(__dirname, "..", "data", "huggingface", "hyperbolic.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.log("=".repeat(60));
    console.log(`[sync-hyperbolic] RESULTS:`);
    console.log(`  Total models: ${output.length}`);
    console.log(`  Models with pricing: ${modelsWithPricing} (${((modelsWithPricing / output.length) * 100).toFixed(1)}%)`);
    console.log(`\n[sync-hyperbolic] Wrote to ${outPath}`);
}

syncHyperbolic().catch(console.error);
