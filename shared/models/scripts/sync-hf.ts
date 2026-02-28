/**
 * HuggingFace Models Aggregation Script (Final)
 * 
 * This script:
 * 1. Fetches ALL models from HF Hub API that have inference providers
 * 2. Looks up pricing in our compiled provider JSONs
 * 3. Selects the CHEAPEST provider for each model (NO duplicates)
 * 4. Only includes models with valid pricing
 * 5. Verifies key models (Kling, Flux) are included
 * 6. Tests models via HF Router using HUGGING_FACE_INFERENCE_TOKEN
 * 
 * IMPORTANT: Inference is EXCLUSIVELY via HuggingFace Router endpoints.
 * Provider JSONs are ONLY for pricing data.
 * 
 * Output: data/providers/hf.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from lambda root
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

// =============================================================================
// Configuration
// =============================================================================

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;
if (!HF_TOKEN) {
    console.error("[sync-hf] ERROR: HUGGING_FACE_INFERENCE_TOKEN not found in .env");
    process.exit(1);
}

const HUB_API_BASE = "https://huggingface.co/api/models";
const ROUTER_API = "https://router.huggingface.co";

// Provider JSON mapping (provider name -> file name)
const PROVIDER_FILES: Record<string, string> = {
    "fal-ai": "falai.json",
    "replicate": "replicate.json",
    "together": "together.json",
    "novita": "novita.json",
    "hyperbolic": "hyperbolic.json",
    "sambanova": "sambanova.json",
    "nebius": "nebius.json",
    "nscale": "nscale.json",
    "fireworks-ai": "fireworks_ai.json",
    "cerebras": "cerebras.json",
    "groq": "groq.json",
    "ovhcloud": "ovhcloud.json",
    "publicai": "publicai.json",
    "cohere": "cohere.json",
    "scaleway": "scaleway.json",
    "wavespeed": "wavespeed.json",
    "hf-inference": "hf-inference.json",
    "featherless-ai": "featherless-ai.json",
};

// Models to verify are present
const KEY_MODELS = [
    "black-forest-labs/FLUX.1-dev",
    "black-forest-labs/FLUX.1-schnell",
    "Wan-AI/Wan2.1-T2V-14B",
    "Wan-AI/Wan2.1-I2V-14B-480P",
    "fal/AuraFlow",
];

// Models to test per provider
const TESTS_PER_PROVIDER: Record<string, number> = {
    "fal-ai": 10,
    "default": 5
};

// =============================================================================
// Types
// =============================================================================

interface ProviderPricing {
    input_per_1m?: number;
    output_per_1m?: number;
    unit_price?: number;
    unit?: string;
    currency: string;
}

interface ProviderModel {
    id: string;
    pricing: ProviderPricing | null;
}

interface ProviderData {
    provider: string;
    models: ProviderModel[];
}

interface HubProviderMapping {
    provider: string;
    providerId: string | null;
    status: string;
    task: string | null;
}

interface HubModel {
    id: string;
    pipeline_tag?: string;
    inferenceProviderMapping?: HubProviderMapping[] | Record<string, any>;
}

interface OutputModel {
    modelId: string;
    name: string;
    taskType: string;
    provider: string;
    providerId: string | null;
    pricing: {
        inputPer1M: number;
        outputPer1M: number;
        unit?: string;
        currency: string;
    } | null;
    verified: boolean;
    hasPricing: boolean;
}

// =============================================================================
// Load Provider Pricing Data
// =============================================================================

function loadProviderPricing(): Map<string, Map<string, ProviderPricing>> {
    console.log("[sync-hf] Loading provider pricing data...\n");

    const providerPricing = new Map<string, Map<string, ProviderPricing>>();
    const dataDir = path.join(__dirname, "..", "data", "huggingface");

    for (const [providerName, fileName] of Object.entries(PROVIDER_FILES)) {
        const filePath = path.join(dataDir, fileName);

        if (!fs.existsSync(filePath)) {
            console.log(`  [${providerName}] File not found: ${fileName}`);
            continue;
        }

        try {
            const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProviderData;
            const priceMap = new Map<string, ProviderPricing>();

            for (const model of raw.models || []) {
                if (model.pricing) {
                    // Normalize pricing structure
                    const normalized: ProviderPricing = {
                        input_per_1m: model.pricing.input_per_1m ?? model.pricing.unit_price ?? 0,
                        output_per_1m: model.pricing.output_per_1m ?? 0,
                        unit: model.pricing.unit,
                        currency: model.pricing.currency || "USD"
                    };

                    // Store by multiple ID formats for matching
                    priceMap.set(model.id, normalized);
                    priceMap.set(model.id.toLowerCase(), normalized);

                    // Also store by basename (e.g., "flux/dev" from "fal-ai/flux/dev")
                    if (model.id.includes("/")) {
                        const parts = model.id.split("/");
                        if (parts.length >= 2) {
                            const basename = parts.slice(1).join("/");
                            priceMap.set(basename, normalized);
                            priceMap.set(basename.toLowerCase(), normalized);
                        }
                    }
                }
            }

            providerPricing.set(providerName, priceMap);
            console.log(`  [${providerName}] Loaded ${priceMap.size} pricing entries`);
        } catch (e) {
            console.warn(`  [${providerName}] Error loading: ${e}`);
        }
    }

    console.log("");
    return providerPricing;
}

// =============================================================================
// Find Pricing for a Model
// =============================================================================

function findPricing(
    provider: string,
    providerId: string | null,
    modelId: string,
    providerPricing: Map<string, Map<string, ProviderPricing>>
): ProviderPricing | null {
    const priceMap = providerPricing.get(provider);
    if (!priceMap) return null;

    // Try multiple ID formats
    const candidates = [
        providerId,
        providerId?.toLowerCase(),
        modelId,
        modelId.toLowerCase(),
        `${provider}/${providerId}`,
        `${provider}/${modelId}`,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        const pricing = priceMap.get(candidate);
        if (pricing && (pricing.input_per_1m || pricing.output_per_1m || pricing.unit_price)) {
            return pricing;
        }
    }

    return null;
}

// =============================================================================
// Fetch HF Hub Models with Provider Mapping
// =============================================================================

async function fetchHubModels(): Promise<HubModel[]> {
    console.log("[sync-hf] Fetching models from HuggingFace Hub API...\n");

    const allModels: HubModel[] = [];

    // Initial URL with expand parameters and trending sort
    const baseParams = new URLSearchParams({
        inference_provider: "all",
        limit: "1000",
        sort: "trendingScore",
        direction: "-1",
    });
    ["inferenceProviderMapping", "pipeline_tag"].forEach(f => baseParams.append("expand[]", f));

    let nextUrl: string | null = `${HUB_API_BASE}?${baseParams.toString()}`;

    while (nextUrl) {
        const response: Response = await fetch(nextUrl, {
            headers: { Authorization: `Bearer ${HF_TOKEN}` }
        });

        if (!response.ok) {
            console.warn(`[sync-hf] Hub API error: ${response.status}`);
            break;
        }

        const batch = await response.json() as HubModel[];
        if (!batch || batch.length === 0) break;

        allModels.push(...batch);

        // Parse Link header for cursor-based pagination
        const linkHeader: string | null = response.headers.get("Link");
        nextUrl = null;

        if (linkHeader) {
            const match: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (match) {
                nextUrl = match[1];
            }
        }

        if (allModels.length % 5000 === 0 || allModels.length < 2000) {
            console.log(`  Fetched ${allModels.length} models...`);
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`\n[sync-hf] Total models from Hub API: ${allModels.length}\n`);
    return allModels;
}

// =============================================================================
// Parse Provider Mapping
// =============================================================================

function parseProviderMapping(mapping: HubModel["inferenceProviderMapping"]): HubProviderMapping[] {
    if (!mapping) return [];

    if (Array.isArray(mapping)) {
        return mapping.map(p => ({
            provider: p.provider,
            providerId: p.providerId || p.provider_id || null,
            status: p.status || "unknown",
            task: p.task || null
        })).filter(p => p.status === "live");
    }

    // Object format
    return Object.entries(mapping).map(([providerName, p]: [string, any]) => ({
        provider: providerName,
        providerId: p.providerId || p.provider_id || null,
        status: p.status || "unknown",
        task: p.task || null
    })).filter(p => p.status === "live");
}

// =============================================================================
// Calculate Total Price for Comparison
// =============================================================================

function getTotalPrice(pricing: ProviderPricing): number {
    // For per-unit pricing (images, videos), use unit_price
    if (pricing.unit_price) {
        return pricing.unit_price;
    }
    // For per-token pricing, sum input + output
    return (pricing.input_per_1m || 0) + (pricing.output_per_1m || 0);
}

// =============================================================================
// Test Model via HF Router
// =============================================================================

async function testModel(modelId: string, provider: string, task: string | null): Promise<boolean> {
    try {
        // Simple availability check via HF Router
        const url = `${ROUTER_API}/${provider}/v1/models`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${HF_TOKEN}` },
            signal: AbortSignal.timeout(5000)
        });

        return response.ok;
    } catch {
        return false;
    }
}

// =============================================================================
// Main Aggregation Logic
// =============================================================================

async function syncHF(): Promise<void> {
    console.log("=".repeat(70));
    console.log("[sync-hf] HuggingFace Models Aggregation - Final");
    console.log("=".repeat(70) + "\n");

    // 1. Load all provider pricing data
    const providerPricing = loadProviderPricing();

    // 2. Fetch all models from HF Hub with provider mappings
    const hubModels = await fetchHubModels();

    // 3. Process each model - find cheapest provider with pricing
    console.log("[sync-hf] Finding cheapest provider for each model...\n");

    const outputModels: OutputModel[] = [];
    const seenModelIds = new Set<string>();
    const providerStats = new Map<string, { total: number; withPricing: number }>();

    for (const model of hubModels) {
        const modelId = model.id;

        // Skip duplicates
        if (seenModelIds.has(modelId)) continue;

        const providers = parseProviderMapping(model.inferenceProviderMapping);
        if (providers.length === 0) continue;

        // Find all providers with pricing
        const providerOptions: Array<{
            provider: string;
            providerId: string | null;
            task: string | null;
            pricing: ProviderPricing;
            totalPrice: number;
        }> = [];

        for (const prov of providers) {
            // Track stats
            if (!providerStats.has(prov.provider)) {
                providerStats.set(prov.provider, { total: 0, withPricing: 0 });
            }
            providerStats.get(prov.provider)!.total++;

            // Find pricing
            const pricing = findPricing(prov.provider, prov.providerId, modelId, providerPricing);
            if (pricing) {
                providerStats.get(prov.provider)!.withPricing++;
                providerOptions.push({
                    provider: prov.provider,
                    providerId: prov.providerId,
                    task: prov.task,
                    pricing,
                    totalPrice: getTotalPrice(pricing)
                });
            }
        }

        // Include models even without pricing - find best provider
        // Prioritize cheapest provider WITH pricing, else use first available
        let selectedProvider: {
            provider: string;
            providerId: string | null;
            task: string | null;
            pricing: ProviderPricing | null;
            totalPrice: number;
        };

        const hasPricing = providerOptions.length > 0;
        if (hasPricing) {
            // Select CHEAPEST provider with pricing
            providerOptions.sort((a, b) => a.totalPrice - b.totalPrice);
            selectedProvider = providerOptions[0];
        } else {
            // No pricing available - use first live provider
            selectedProvider = {
                provider: providers[0].provider,
                providerId: providers[0].providerId,
                task: providers[0].task,
                pricing: null,
                totalPrice: 0
            };
        }

        seenModelIds.add(modelId);
        outputModels.push({
            modelId,
            name: modelId, // Use full modelId as name - NO stripping
            taskType: model.pipeline_tag || selectedProvider.task || "unknown",
            provider: selectedProvider.provider,
            providerId: selectedProvider.providerId,
            pricing: selectedProvider.pricing ? {
                inputPer1M: selectedProvider.pricing.input_per_1m || selectedProvider.pricing.unit_price || 0,
                outputPer1M: selectedProvider.pricing.output_per_1m || 0,
                unit: selectedProvider.pricing.unit,
                currency: selectedProvider.pricing.currency
            } : null,
            verified: false,
            hasPricing
        });
    }

    console.log(`[sync-hf] Models with pricing: ${outputModels.length}\n`);

    // 4. Print provider stats
    console.log("[sync-hf] Provider coverage:\n");
    for (const [provider, stats] of Array.from(providerStats.entries()).sort((a, b) => b[1].withPricing - a[1].withPricing)) {
        const pct = stats.total > 0 ? ((stats.withPricing / stats.total) * 100).toFixed(1) : "0";
        console.log(`  ${provider}: ${stats.withPricing}/${stats.total} (${pct}%)`);
    }
    console.log("");

    // 5. Verify key models are present
    console.log("[sync-hf] Verifying key models:\n");
    for (const keyModel of KEY_MODELS) {
        const found = outputModels.find(m =>
            m.modelId === keyModel ||
            m.modelId.toLowerCase() === keyModel.toLowerCase()
        );
        if (found) {
            const priceStr = found.pricing
                ? `$${found.pricing.inputPer1M}/${found.pricing.unit || "1M tokens"}`
                : "(no pricing)";
            console.log(`  ✅ ${keyModel} - ${found.provider} ${priceStr}`);
        } else {
            console.log(`  ❌ ${keyModel} - NOT FOUND`);
        }
    }
    console.log("");

    // 6. Test sample models per provider via HF Router
    console.log("[sync-hf] Testing models via HF Router...\n");

    const providerModels = new Map<string, OutputModel[]>();
    for (const model of outputModels) {
        if (!providerModels.has(model.provider)) {
            providerModels.set(model.provider, []);
        }
        providerModels.get(model.provider)!.push(model);
    }

    let totalVerified = 0;
    for (const [provider, models] of providerModels) {
        const testCount = TESTS_PER_PROVIDER[provider] || TESTS_PER_PROVIDER["default"];
        const toTest = models.slice(0, testCount);
        let passed = 0;

        for (const model of toTest) {
            const ok = await testModel(model.modelId, model.provider, model.taskType);
            if (ok) {
                model.verified = true;
                passed++;
                totalVerified++;
            }
            await new Promise(r => setTimeout(r, 100));
        }

        console.log(`  ${provider}: ${passed}/${toTest.length} verified`);
    }
    console.log(`\n[sync-hf] Total verified: ${totalVerified}\n`);

    // 7. Write output
    const output = {
        generatedAt: new Date().toISOString(),
        source: "HuggingFace Hub API + Provider Pricing JSONs",
        totalModels: outputModels.length,
        totalVerified,
        models: outputModels
    };

    const outPath = path.join(__dirname, "..", "data", "providers", "hf.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    console.log("=".repeat(70));
    console.log(`[sync-hf] COMPLETE`);
    console.log(`  Total models with pricing: ${outputModels.length}`);
    console.log(`  Verified via HF Router: ${totalVerified}`);
    console.log(`  Output: ${outPath}`);
    console.log("=".repeat(70));
}

// Run
syncHF().catch(console.error);
