/**
 * Fal.ai Pricing Sync (Authenticated)
 * 
 * Uses fal.ai Platform API with FAL_API_KEY to get REAL pricing for ALL models
 * 1. Fetch all model IDs from gallery API (paginated)
 * 2. Query /v1/models/pricing in batches of 50 (max allowed)
 * 
 * Output: data/huggingface/falai.json
 * 
 * Run: npx tsx hf-providers/sync-falai.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Types
// =============================================================================

interface FalModel {
    id: string;
    title: string;
    category: string;
    pricing: {
        unit_price: number;
        unit: string;
        currency: string;
    } | null;
}

interface FalData {
    provider: string;
    lastUpdated: string;
    totalModels: number;
    modelsWithPricing: number;
    models: FalModel[];
}

interface FalGalleryModel {
    id: string;
    title: string;
    category: string;
}

interface FalGalleryResponse {
    page: number;
    pages: number;
    total: number;
    items?: FalGalleryModel[];
}

interface FalPricingResponse {
    prices: Array<{
        endpoint_id: string;
        unit_price: number;
        unit: string;
        currency: string;
    }>;
    next_cursor: string | null;
    has_more: boolean;
}

// =============================================================================
// Config
// =============================================================================

const FAL_API_KEY = process.env.FAL_API_KEY;
const PRICING_BATCH_SIZE = 50; // API limit

if (!FAL_API_KEY) {
    console.error("[sync-falai] ERROR: FAL_API_KEY not found in .env");
    process.exit(1);
}

// =============================================================================
// Fetch Gallery Models (get all model IDs)
// =============================================================================

async function fetchAllModelIds(): Promise<Map<string, FalGalleryModel>> {
    console.log("[sync-falai] Fetching all model IDs from gallery API...\n");

    const models = new Map<string, FalGalleryModel>();
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
        const url = `https://fal.ai/api/models?page=${page}&size=100`;
        const response = await fetch(url);

        if (!response.ok) {
            console.warn(`[sync-falai] Gallery API HTTP ${response.status} on page ${page}`);
            break;
        }

        const data = await response.json() as FalGalleryResponse;

        const items = data.items || [];
        if (items.length === 0) break;

        for (const model of items) {
            models.set(model.id, {
                id: model.id,
                title: model.title,
                category: model.category,
            });
        }

        totalPages = data.pages || 1;

        if (page % 5 === 0) {
            console.log(`  Page ${page}/${totalPages}, ${models.size} models`);
        }

        page++;
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`\n[sync-falai] Found ${models.size} models in gallery\n`);
    return models;
}

// =============================================================================
// Fetch Pricing (authenticated, batched)
// =============================================================================

async function fetchPricingBatch(endpointIds: string[], retryCount = 0): Promise<Map<string, FalPricingResponse["prices"][0]>> {
    const prices = new Map<string, FalPricingResponse["prices"][0]>();
    const MAX_RETRIES = 3;

    // Build query string with multiple endpoint_id params
    const params = new URLSearchParams();
    for (const id of endpointIds) {
        params.append("endpoint_id", id);
    }

    const url = `https://api.fal.ai/v1/models/pricing?${params.toString()}`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Key ${FAL_API_KEY}`,
        },
    });

    // Handle rate limiting with exponential backoff
    if (response.status === 429) {
        if (retryCount < MAX_RETRIES) {
            const waitTime = Math.pow(2, retryCount + 1) * 1000; // 2s, 4s, 8s
            console.log(`  Rate limited, waiting ${waitTime / 1000}s before retry ${retryCount + 1}/${MAX_RETRIES}...`);
            await new Promise(r => setTimeout(r, waitTime));
            return fetchPricingBatch(endpointIds, retryCount + 1);
        } else {
            console.warn(`  Rate limit exhausted after ${MAX_RETRIES} retries`);
            return prices;
        }
    }

    if (!response.ok) {
        console.warn(`[sync-falai] Pricing API HTTP ${response.status}`);
        return prices;
    }

    const data = await response.json() as FalPricingResponse;

    for (const price of data.prices || []) {
        prices.set(price.endpoint_id, price);
    }

    return prices;
}

async function fetchAllPricing(modelIds: string[]): Promise<Map<string, FalPricingResponse["prices"][0]>> {
    console.log(`[sync-falai] Fetching pricing for ${modelIds.length} models in batches of ${PRICING_BATCH_SIZE}...\n`);

    const allPrices = new Map<string, FalPricingResponse["prices"][0]>();
    const batches = Math.ceil(modelIds.length / PRICING_BATCH_SIZE);

    for (let i = 0; i < batches; i++) {
        const start = i * PRICING_BATCH_SIZE;
        const end = Math.min(start + PRICING_BATCH_SIZE, modelIds.length);
        const batch = modelIds.slice(start, end);

        const prices = await fetchPricingBatch(batch);
        for (const [id, price] of prices) {
            allPrices.set(id, price);
        }

        if ((i + 1) % 5 === 0 || i === batches - 1) {
            console.log(`  Batch ${i + 1}/${batches}, ${allPrices.size} prices fetched`);
        }

        // Rate limiting - 500ms between batches to avoid 429
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n[sync-falai] Fetched ${allPrices.size} prices from Platform API\n`);
    return allPrices;
}

// =============================================================================
// Main
// =============================================================================

async function syncFalai(): Promise<void> {
    console.log("[sync-falai] Starting fal.ai pricing sync (authenticated)...\n");
    console.log("=".repeat(60) + "\n");

    // 1. Get all model IDs from gallery
    const galleryModels = await fetchAllModelIds();

    // 2. Fetch pricing from Platform API
    const modelIds = Array.from(galleryModels.keys());
    const pricing = await fetchAllPricing(modelIds);

    // 3. Combine data
    const models: FalModel[] = [];
    for (const [id, model] of galleryModels) {
        const price = pricing.get(id);
        models.push({
            id: model.id,
            title: model.title,
            category: model.category,
            pricing: price ? {
                unit_price: price.unit_price,
                unit: price.unit,
                currency: price.currency,
            } : null,
        });
    }

    const modelsWithPricing = models.filter(m => m.pricing !== null).length;

    const data: FalData = {
        provider: "fal-ai",
        lastUpdated: new Date().toISOString(),
        totalModels: models.length,
        modelsWithPricing,
        models,
    };

    // Write to data/huggingface/falai.json
    const outPath = path.join(__dirname, "..", "data", "huggingface", "falai.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

    console.log("=".repeat(60));
    console.log(`[sync-falai] RESULTS:`);
    console.log(`  Total models: ${models.length}`);
    console.log(`  Models with pricing: ${modelsWithPricing} (${((modelsWithPricing / models.length) * 100).toFixed(1)}%)`);
    console.log(`\n[sync-falai] Wrote to ${outPath}`);
}

// Run
syncFalai().catch(console.error);
