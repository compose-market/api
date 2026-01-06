/**
 * HF Router API Pricing Sync
 * 
 * Uses the public HuggingFace Router API to get pricing for LLM providers:
 * - fireworks-ai, cerebras, nebius, nscale, ovhcloud, publicai
 * 
 * This is for providers that don't expose pricing in their own APIs.
 * 
 * Output: Individual JSON files per provider in data/huggingface/
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RouterProvider {
    provider: string;
    status?: string;
    pricing?: { input: number; output: number };
    context_length?: number;
    supports_tools?: boolean;
    supports_structured_output?: boolean;
}

interface RouterModel {
    id: string;
    providers: RouterProvider[];
}

interface RouterResponse {
    data: RouterModel[];
}

interface OutputModel {
    id: string;
    context_length: number | null;
    pricing: {
        input_per_1m: number;
        output_per_1m: number;
        currency: string;
    } | null;
}

interface ProviderData {
    provider: string;
    lastUpdated: string;
    source: string;
    totalModels: number;
    modelsWithPricing: number;
    models: OutputModel[];
}

// Providers to extract from HF Router (these don't have pricing in their own APIs)
const ROUTER_PROVIDERS = [
    "fireworks-ai",
    "cerebras",
    "nebius",
    "nscale",
    "ovhcloud",
    "publicai",
    "groq"
];

async function syncRouterProviders(): Promise<void> {
    console.log("[sync-router] Fetching from router.huggingface.co/v1/models...\n");

    const response = await fetch("https://router.huggingface.co/v1/models");
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as RouterResponse;
    console.log(`[sync-router] Fetched ${data.data.length} models from Router API\n`);

    // Group by provider
    const providerModels = new Map<string, OutputModel[]>();

    for (const model of data.data) {
        for (const prov of model.providers) {
            if (!ROUTER_PROVIDERS.includes(prov.provider)) continue;

            if (!providerModels.has(prov.provider)) {
                providerModels.set(prov.provider, []);
            }

            providerModels.get(prov.provider)!.push({
                id: model.id,
                context_length: prov.context_length || null,
                pricing: prov.pricing ? {
                    input_per_1m: prov.pricing.input,
                    output_per_1m: prov.pricing.output,
                    currency: "USD"
                } : null
            });
        }
    }

    console.log("=".repeat(60));
    console.log("[sync-router] RESULTS BY PROVIDER:\n");

    // Write individual files per provider
    for (const [provider, models] of providerModels) {
        const modelsWithPricing = models.filter(m => m.pricing !== null).length;

        const providerData: ProviderData = {
            provider,
            lastUpdated: new Date().toISOString(),
            source: "router.huggingface.co/v1/models",
            totalModels: models.length,
            modelsWithPricing,
            models
        };

        const outPath = path.join(__dirname, "..", "data", "huggingface", `${provider.replace("-", "_")}.json`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(providerData, null, 2));

        const pct = models.length > 0 ? ((modelsWithPricing / models.length) * 100).toFixed(1) : "0";
        console.log(`  ${provider}: ${modelsWithPricing}/${models.length} (${pct}%)`);
    }

    console.log(`\n[sync-router] Wrote ${providerModels.size} provider files`);
}

syncRouterProviders().catch(console.error);
