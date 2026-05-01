/**
 * Price Verification — Top Trending Hugging Face Models
 *
 * Verifies the provider prices currently represented in hf.json.
 *
 * Strategy:
 *   1. Fetch top trending HF models with all live provider mappings.
 *   2. For each model, prefer the provider selected in hf.json when it is still live.
 *   3. Fetch real pricing from the provider's official API, pricing page, or model page.
 *   4. Compare against hf.json with unit-aware matching.
 *
 * Optional env flags:
 *   VERIFY_PROVIDERS=groq,cohere
 *   VERIFY_LIMIT=50
 *
 * Run:
 *   cd api && DOTENV_CONFIG_PATH=.env npx tsx tests/verify-prices.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import * as cheerio from "cheerio";
import puppeteer, { type Browser, type Page } from "puppeteer";
import {
    parseCerebrasPricingText,
    parseOVHcloudCatalogText,
    parseWaveSpeedModelPage,
    type CerebrasParsedRow,
} from "./verify-prices.parsers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN ?? process.env.HUGGING_FACE_INFERENCE_API_KEY ?? "";
const FAL_KEY = process.env.FAL_API_KEY ?? "";
const NOVITA_KEY = process.env.NOVITA_API_KEY ?? "";
const TOGETHER_KEY = process.env.TOGETHER_API_KEY ?? "";
const NSCALE_KEY = process.env.NSCALE_API_KEY ?? "";
const HYPERBOLIC_KEY = process.env.HYPERBOLIC_API_KEY ?? "";
const SAMBANOVA_KEY = process.env.SAMBANOVA_API_KEY ?? "";
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY ?? "";
const PUBLICAI_KEY = process.env.PUBLICAI_API_KEY ?? "";
const MASSIVE_USER = process.env.JOIN_MASSIVE_AUTH_USERNAME ?? "";
const MASSIVE_PASS = process.env.JOIN_MASSIVE_AUTH_PASSWORD ?? "";

const MASSIVE_PROXY = "https://network.joinmassive.com:65535";
const HF_JSON = process.env.VERIFY_HF_JSON_PATH
    ? path.resolve(process.env.VERIFY_HF_JSON_PATH)
    : path.join(__dirname, "..", "inference", "data", "providers", "hf.json");
const OUTPUT = path.join(__dirname, "..", "inference", "data", "reports", "price_verification_report.json");
const L = "[verify-prices]";
const HF_PROVIDER_LIST = "groq,novita,cerebras,sambanova,nscale,fal-ai,hyperbolic,together,fireworks-ai,zai-org,replicate,cohere,scaleway,publicai,ovhcloud,wavespeed,hf-inference";
const DEFAULT_LIMIT = Number.parseInt(process.env.VERIFY_LIMIT ?? "500", 10);
const VERIFY_LIMIT = Number.isFinite(DEFAULT_LIMIT) && DEFAULT_LIMIT > 0 ? DEFAULT_LIMIT : 500;
const VERIFY_PROVIDERS = new Set(
    (process.env.VERIFY_PROVIDERS ?? "")
        .split(",")
        .map(v => v.trim())
        .filter(Boolean)
);
const HAS_PROVIDER_FILTER = VERIFY_PROVIDERS.size > 0;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toLc(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
}

function modelShortId(value: string): string {
    return value.split("/").pop()?.toLowerCase() ?? value.toLowerCase();
}

function providerRoot(value: string): string {
    return value.split(":")[0]?.trim() ?? value.trim();
}

function parseMoney(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const cleaned = value.replace(/[$,\s]/g, "");
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUnit(unit: string | null | undefined): string {
    const u = toLc(unit)
        .replace(/\s+/g, "_")
        .replace(/\/+/g, "_")
        .replace(/-+/g, "_");

    if (!u) return "unknown";
    if (u.includes("subscription")) return "subscription";
    if (u.includes("compute") && u.includes("second") && u.includes("usd")) return "usd_per_compute_second";
    if (u.includes("compute") && u.includes("second")) return "per_compute_second";
    if (u.includes("serverless")) return "compute_time";
    if (u.includes("compute")) return "compute_time";
    if (u.includes("processed") && u.includes("megapixel") && u.includes("usd")) return "usd_per_processed_megapixel";
    if (u.includes("processed") && u.includes("megapixel")) return "per_processed_megapixel";
    if (u.includes("1k_search")) return "usd_per_1k_searches";
    if (u.includes("1k_character") && u.includes("usd")) return "usd_per_1k_characters";
    if (u.includes("minute") && u.includes("usd")) return "usd_per_minute";
    if (u.includes("second") && u.includes("video") && u.includes("usd")) return "usd_per_second_video";
    if (u.includes("second") && u.includes("audio") && u.includes("usd")) return "usd_per_second_audio";
    if (u.includes("second") && u.includes("usd")) return "usd_per_second";
    if (u.includes("hour") && u.includes("usd")) return "usd_per_hour";
    if (u.includes("frame") && u.includes("usd")) return "usd_per_frame";
    if (u.includes("generation") && u.includes("usd")) return "usd_per_generation";
    if (u.includes("video") && u.includes("usd")) return "usd_per_video";
    if (u.includes("character") && u.includes("usd")) return "usd_per_1m_characters";
    if (u.includes("step") && u.includes("usd")) return "usd_per_step";
    if (u.includes("megapixel") && u.includes("usd")) return "usd_per_megapixel";
    if (u.includes("megapixel")) return "per_megapixel";
    if (u.includes("image") && u.includes("usd")) return "usd_per_image";
    if (u.includes("image")) return "per_image";
    if (u.includes("run") && u.includes("usd")) return "usd_per_run";
    if (u.includes("run")) return "per_run";
    if (u.includes("token") && u.includes("1m") && u.includes("usd")) return "usd_per_1m_tokens";
    if (u.includes("token") && u.includes("1m") && u.includes("eur")) return "eur_per_1m_tokens";
    if (u.includes("token") && u.includes("1m") && (u.includes("cny") || u.includes("rmb"))) return "cny_per_1m_tokens";
    if (u.includes("token") && u.includes("1m")) return "per_1m_tokens";
    return u;
}

function normalizeNumber(value: number | null | undefined): string | null {
    if (value == null || !Number.isFinite(value)) return null;
    const fixed = value.toFixed(9);
    return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function numbersMatch(a: number | null | undefined, b: number | null | undefined): boolean {
    return normalizeNumber(a) === normalizeNumber(b);
}

function makeCandidates(model: Top500Model): string[] {
    const raw = [
        model.providerId,
        model.id,
        providerRoot(model.providerId),
        providerRoot(model.id),
        modelShortId(model.providerId),
        modelShortId(model.id),
    ];
    return [...new Set(raw.map(toLc).filter(Boolean))];
}

function buildExactKeySet(values: Array<string | null | undefined>): Set<string> {
    const keys = new Set<string>();
    for (const value of values) {
        const lc = toLc(value);
        if (!lc) continue;
        keys.add(lc);
        keys.add(compactKey(lc));
    }
    return keys;
}

function matchesExactKey(topModel: Top500Model, ...keys: Array<string | null | undefined>): boolean {
    const candidateKeys = buildExactKeySet(makeCandidates(topModel));
    for (const key of keys) {
        const normalized = toLc(key);
        if (!normalized) continue;
        if (candidateKeys.has(normalized) || candidateKeys.has(compactKey(normalized))) {
            return true;
        }
    }
    return false;
}

function findApiObject<T>(
    models: T[],
    topModel: Top500Model,
    getKeys: (model: T) => Array<string | null | undefined> = (model) => [(model as { id?: string }).id ?? null],
): T | null {
    for (const item of models) {
        if (getKeys(item).some((key) => matchesExactKey(topModel, key))) {
            return item;
        }
    }
    return null;
}

function matchByKeys<T>(
    topModel: Top500Model,
    entries: Iterable<[string, T]>,
): T | null {
    for (const [key, value] of entries) {
        if (matchesExactKey(topModel, key)) {
            return value;
        }
    }
    return null;
}

function compactKey(value: string | null | undefined): string {
    return toLc(value).replace(/[^a-z0-9]+/g, "");
}

function shouldVerifyProvider(provider: string): boolean {
    return !HAS_PROVIDER_FILTER || VERIFY_PROVIDERS.has(provider);
}

function currentUA(): string {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

async function prepareBrowserPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    await page.setUserAgent(currentUA());
    await page.setViewport({ width: 1600, height: 1200 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    if (MASSIVE_USER && MASSIVE_PASS) {
        await page.authenticate({ username: MASSIVE_USER, password: MASSIVE_PASS });
    }
    return page;
}

async function navigateWithRetry(page: Page, url: string, timeout = 45000, scroll = false): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await page.goto(url, { waitUntil: "networkidle2", timeout });
            const title = await page.title().catch(() => "");
            if (title.includes("Just a moment") || title.includes("Attention Required")) {
                await sleep(8000);
                await page.waitForFunction(() => !document.title.includes("Just a moment"), { timeout: 30000 }).catch(() => { });
            }
            const html = await page.content();
            if (html.includes("Access denied") || html.includes("Error 1015")) {
                if (attempt < 3) {
                    await sleep(3000);
                    continue;
                }
                return false;
            }
            await sleep(1500);
            if (scroll) {
                await page.evaluate(async () => {
                    for (let i = 0; i < 20; i++) {
                        window.scrollBy(0, 800);
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }
                    window.scrollTo(0, 0);
                }).catch(() => { });
                await sleep(1000);
            }
            return true;
        } catch (error) {
            if (attempt < 3) {
                await sleep(3000);
                continue;
            }
            return false;
        }
    }
    return false;
}

// ============================================================
// STEP 1: Get top trending models from HF Hub API
// ============================================================
interface ProviderMapping {
    provider: string;
    providerId: string;
    task?: string;
}

export interface RawTop500Model {
    id: string;
    pipeline: string;
    allProviders: ProviderMapping[];
    trending: number;
}

interface Top500Model extends RawTop500Model {
    provider: string;
    providerId: string;
    hfSelectedProvider: string | null;
    selectionReason: string;
}

async function fetchTop500Raw(): Promise<RawTop500Model[]> {
    console.log(`${L} STEP 1: Fetching top trending models from HF Hub API...`);

    const models: RawTop500Model[] = [];
    const seen = new Set<string>();
    const pageSize = Math.min(100, VERIFY_LIMIT);

    for (let offset = 0; models.length < VERIFY_LIMIT; offset += pageSize) {
        const url = `https://huggingface.co/api/models?inference_provider=${HF_PROVIDER_LIST}&sort=trendingScore&direction=-1&limit=${pageSize}&offset=${offset}&expand%5B%5D=inferenceProviderMapping`;
        const resp = await fetch(url, {
            headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {},
        });
        if (!resp.ok) throw new Error(`Hub API ${resp.status}: ${await resp.text()}`);

        const data = await resp.json() as any[];
        if (data.length === 0) break;

        for (const item of data) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);

            const live = (item.inferenceProviderMapping ?? [])
                .filter((p: any) => p.status === "live")
                .map((p: any) => ({ provider: p.provider, providerId: p.providerId ?? item.id, task: p.task ?? undefined }));
            if (live.length === 0) continue;

            models.push({
                id: item.id,
                pipeline: item.pipeline_tag ?? "unknown",
                allProviders: live,
                trending: item.trendingScore ?? 0,
            });

            if (models.length >= VERIFY_LIMIT) break;
        }

        if (data.length < pageSize) break;
    }

    console.log(`${L}   ✅ Got ${models.length} raw models with live provider mappings`);
    return models;
}

// ============================================================
// HF JSON loading and provider selection
// ============================================================
export interface HFModelEntry {
    modelId: string;
    selectedProvider: string;
    prices?: {
        unit: string;
        values: Record<string, number>;
    };
    providers?: Array<{
        provider: string;
        providerId?: string;
        pricing?: {
            unit: string;
            values: Record<string, number>;
        };
    }>;
}

function loadHFJson(): Map<string, HFModelEntry> {
    const data = JSON.parse(fs.readFileSync(HF_JSON, "utf-8"));
    const idx = new Map<string, HFModelEntry>();
    for (const model of data.models ?? []) idx.set(model.modelId, model);
    return idx;
}

export function chooseProvider(raw: RawTop500Model, hfModel: HFModelEntry | undefined): Top500Model | null {
    const live = raw.allProviders.filter(p => shouldVerifyProvider(p.provider));
    if (live.length === 0) return null;

    const hfSelectedProvider = hfModel?.selectedProvider ?? null;
    const preferred = hfSelectedProvider
        ? live.find(p => p.provider === hfSelectedProvider) ?? null
        : null;

    const chosen = preferred ?? live[0];
    return {
        ...raw,
        provider: chosen.provider,
        providerId: chosen.providerId,
        hfSelectedProvider,
        selectionReason: preferred ? "selectedProvider from hf.json" : "first live provider mapping",
    };
}

// ============================================================
// STEP 2: Fetch real prices from provider APIs/websites
// ============================================================
export interface RealPrice {
    modelId: string;
    provider: string;
    input: number | null;
    output: number | null;
    unit: string;
    source: string;
    notes?: string;
}

export function collectFalEndpointIds(models: Top500Model[]): string[] {
    const endpointIds: string[] = [];
    const seen = new Set<string>();

    for (const model of models) {
        const endpointId = model.providerId.trim();
        if (endpointId.length === 0 || seen.has(endpointId)) continue;
        seen.add(endpointId);
        endpointIds.push(endpointId);
    }

    return endpointIds;
}

async function fetchFalPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [fal-ai] Fetching prices via api.fal.ai...`);
    const prices = new Map<string, RealPrice>();
    const modelsByEndpointId = new Map<string, Top500Model[]>();

    for (const model of models) {
        const endpointId = model.providerId.trim();
        const existing = modelsByEndpointId.get(endpointId) ?? [];
        existing.push(model);
        modelsByEndpointId.set(endpointId, existing);
    }

    const fetchBatch = async (batch: string[]): Promise<void> => {
        if (batch.length === 0) return;

        const params = new URLSearchParams();
        for (const id of batch) params.append("endpoint_id", id);

        const resp = await fetch(`https://api.fal.ai/v1/models/pricing?${params.toString()}`, {
            headers: { Authorization: `Key ${FAL_KEY}` },
        });
        if (resp.status === 429) {
            await sleep(3000);
            return await fetchBatch(batch);
        }
        if (resp.status === 404 && batch.length > 1) {
            for (const endpointId of batch) {
                await fetchBatch([endpointId]);
                await sleep(100);
            }
            return;
        }
        if (!resp.ok) {
            console.warn(`${L}   [fal-ai] HTTP ${resp.status} for ${batch.join(", ")}`);
            return;
        }

        const data = await resp.json() as { prices: Array<{ endpoint_id: string; unit_price: number; unit: string; currency: string }> };
        for (const price of data.prices ?? []) {
            for (const model of modelsByEndpointId.get(price.endpoint_id) ?? []) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "fal-ai",
                    input: price.unit_price,
                    output: null,
                    unit: `per_${price.unit}_${price.currency.toLowerCase()}`,
                    source: `api.fal.ai/v1/models/pricing (endpoint: ${price.endpoint_id})`,
                });
            }
        }
    };

    const endpointIds = collectFalEndpointIds(models);
    for (let i = 0; i < endpointIds.length; i += 50) {
        const batch = endpointIds.slice(i, i + 50);
        try {
            await fetchBatch(batch);
        } catch (error: any) {
            console.warn(`${L}   [fal-ai] batch error: ${error.message}`);
        }
        await sleep(250);
    }

    console.log(`${L}   [fal-ai] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchNovitaPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [novita] Fetching prices via api.novita.ai...`);
    const prices = new Map<string, RealPrice>();
    try {
        const resp = await fetch("https://api.novita.ai/v3/openai/models", {
            headers: { Authorization: `Bearer ${NOVITA_KEY}` },
        });
        if (!resp.ok) {
            console.warn(`${L}   [novita] HTTP ${resp.status}`);
            return prices;
        }
        const data = await resp.json() as { data: Array<{ id: string; input_token_price_per_m?: number; output_token_price_per_m?: number }> };
        const apiModels = data.data ?? [];
        for (const model of models) {
            const apiModel = findApiObject(apiModels, model, (item) => [item.id]);
            if (!apiModel || apiModel.input_token_price_per_m == null) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "novita",
                input: apiModel.input_token_price_per_m / 10000,
                output: (apiModel.output_token_price_per_m ?? 0) / 10000,
                unit: "per_1M_tokens_usd",
                source: `api.novita.ai/v3/openai/models (id: ${apiModel.id})`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [novita] error: ${error.message}`);
    }
    console.log(`${L}   [novita] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchTogetherPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [together] Fetching prices via api.together.xyz...`);
    const prices = new Map<string, RealPrice>();
    try {
        const resp = await fetch("https://api.together.xyz/v1/models", {
            headers: { Authorization: `Bearer ${TOGETHER_KEY}` },
        });
        if (!resp.ok) {
            console.warn(`${L}   [together] HTTP ${resp.status}`);
            return prices;
        }
        const apiModels = await resp.json() as any[];
        for (const model of models) {
            const apiModel = findApiObject(apiModels, model, (item) => [item.id, item.display_name, item.name]);
            if (!apiModel?.pricing) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "together",
                input: apiModel.pricing.input ?? null,
                output: apiModel.pricing.output ?? null,
                unit: "per_1M_tokens_usd",
                source: `api.together.xyz/v1/models (id: ${apiModel.id})`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [together] error: ${error.message}`);
    }
    console.log(`${L}   [together] got ${prices.size}/${models.length}`);
    return prices;
}

interface NscaleImagePricingRow {
    author: string;
    pricePerMegapixel: number;
}

function getSelectedProviderTask(model: Top500Model): string | null {
    const selected = model.allProviders.find(
        entry => entry.provider === model.provider && entry.providerId === model.providerId,
    );
    return selected?.task?.trim() || (model.pipeline !== "unknown" ? model.pipeline : null);
}

async function fetchNscaleImagePricingRows(): Promise<NscaleImagePricingRow[]> {
    const response = await fetch("https://www.nscale.com/product/serverless", {
        headers: { "User-Agent": currentUA(), Accept: "text/html" },
    });
    if (!response.ok) {
        throw new Error(`nscale pricing page HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const legendNames = $(".pt-legend-item .text-mono-small-regular")
        .map((_, element) => $(element).text().replace(/\s+/g, " ").trim())
        .get();
    const statRows = $(".pt-stats-item")
        .map((_, item) => {
            const author = $(item).find(".pt-stat.is-hidden .text-mono-small-regular").text().replace(/\s+/g, " ").trim();
            const visibleStats = $(item).find(".pt-stat:not(.is-hidden)")
                .map((__, stat) => $(stat).text().replace(/\s+/g, " ").trim())
                .get();
            const type = visibleStats[0];
            const priceText = visibleStats[1];
            if (type === undefined || priceText === undefined) return null;
            return { author, type, priceText };
        })
        .get()
        .filter((row): row is { author: string; type: string; priceText: string } => row !== null);

    if (legendNames.length !== statRows.length) {
        throw new Error(`Nscale pricing page row mismatch: ${legendNames.length} names vs ${statRows.length} stats`);
    }

    return statRows
        .map((row, index) => ({ ...row, name: legendNames[index] }))
        .filter(row => row.type === "Text-to-Image")
        .map(row => {
            const priceMatch = row.priceText.match(/\$([0-9]+(?:\.[0-9]+)?)/);
            if (priceMatch === null) {
                throw new Error(`Missing Nscale image price in page row '${row.name}'`);
            }
            if (!row.priceText.toLowerCase().includes("per mega-pixel")) {
                throw new Error(`Unsupported Nscale image unit in page row '${row.name}': ${row.priceText}`);
            }
            return {
                author: row.author,
                pricePerMegapixel: Number.parseFloat(priceMatch[1]),
            };
        });
}

async function fetchNscalePrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [nscale] Fetching prices via inference.api.nscale.com...`);
    const prices = new Map<string, RealPrice>();
    try {
        const resp = await fetch("https://inference.api.nscale.com/v1/models", {
            headers: { Authorization: `Bearer ${NSCALE_KEY}` },
        });
        if (!resp.ok) {
            console.warn(`${L}   [nscale] HTTP ${resp.status}`);
            return prices;
        }
        const data = await resp.json() as { data: any[] };
        const needsImagePricing = models.some(model => getSelectedProviderTask(model) === "text-to-image");
        const imagePricingRows = needsImagePricing ? await fetchNscaleImagePricingRows() : [];
        for (const model of models) {
            const apiModel = findApiObject(data.data ?? [], model, (item) => [item.id, item.model, item.name]);
            if (!apiModel?.pricing) continue;
            if (getSelectedProviderTask(model) === "text-to-image") {
                const outputPrice = parseMoney(apiModel.pricing.output);
                const owner = toLc(apiModel.owned_by);
                if (outputPrice == null || !owner) continue;
                const matches = imagePricingRows.filter(row =>
                    toLc(row.author) === owner && numbersMatch(row.pricePerMegapixel, outputPrice),
                );
                if (matches.length !== 1) {
                    console.warn(`${L}   [nscale] could not confirm image unit for ${model.id}`);
                    continue;
                }
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "nscale",
                    input: outputPrice,
                    output: null,
                    unit: "usd_per_megapixel",
                    source: `inference.api.nscale.com/v1/models + https://www.nscale.com/product/serverless (id: ${apiModel.id})`,
                });
                continue;
            }
            prices.set(model.id, {
                modelId: model.id,
                provider: "nscale",
                input: apiModel.pricing.input ?? null,
                output: apiModel.pricing.output ?? null,
                unit: "per_1M_tokens_usd",
                source: `inference.api.nscale.com/v1/models (id: ${apiModel.id})`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [nscale] error: ${error.message}`);
    }
    console.log(`${L}   [nscale] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchHyperbolicPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [hyperbolic] Fetching prices via api.hyperbolic.xyz...`);
    const prices = new Map<string, RealPrice>();
    try {
        const resp = await fetch("https://api.hyperbolic.xyz/v1/models", {
            headers: { Authorization: `Bearer ${HYPERBOLIC_KEY}` },
        });
        if (!resp.ok) {
            console.warn(`${L}   [hyperbolic] HTTP ${resp.status}`);
            return prices;
        }
        const data = await resp.json() as { data: any[] };
        for (const model of models) {
            const apiModel = findApiObject(data.data ?? [], model, (item) => [item.id, item.model_name, item.name]);
            if (apiModel?.input_price != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "hyperbolic",
                    input: apiModel.input_price ?? null,
                    output: apiModel.output_price ?? apiModel.input_price ?? null,
                    unit: "per_1M_tokens_usd",
                    source: `api.hyperbolic.xyz/v1/models (id: ${apiModel.id})`,
                });
                continue;
            }

            const providerModelId = model.providerId.replaceAll("/", "_");
            const priceResp = await fetch(`https://api.hyperbolic.xyz/models/${providerModelId}/price`, {
                headers: { Authorization: `Bearer ${HYPERBOLIC_KEY}` },
            });
            if (!priceResp.ok) continue;
            const priceData = await priceResp.json() as { llm_tokens?: number | null; amount?: number | null };
            if (priceData.llm_tokens == null || priceData.amount == null || priceData.llm_tokens === 0) continue;
            const unitAmount = priceData.amount / priceData.llm_tokens;
            prices.set(model.id, {
                modelId: model.id,
                provider: "hyperbolic",
                input: unitAmount * 1_000_000,
                output: unitAmount * 1_000_000,
                unit: "per_1M_tokens_usd",
                source: `api.hyperbolic.xyz/models/${providerModelId}/price`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [hyperbolic] error: ${error.message}`);
    }
    console.log(`${L}   [hyperbolic] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchSambanovaPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [sambanova] Fetching prices via api.sambanova.ai...`);
    const prices = new Map<string, RealPrice>();
    try {
        const resp = await fetch("https://api.sambanova.ai/v1/models", {
            headers: { Authorization: `Bearer ${SAMBANOVA_KEY}` },
        });
        if (!resp.ok) {
            console.warn(`${L}   [sambanova] HTTP ${resp.status}`);
            return prices;
        }
        const data = await resp.json() as { data: any[] };
        for (const model of models) {
            const apiModel = findApiObject(data.data ?? [], model, (item) => [item.id, item.name, item.model]);
            if (!apiModel?.pricing?.prompt || !apiModel?.pricing?.completion) continue;
            const prompt = parseMoney(apiModel.pricing.prompt);
            const completion = parseMoney(apiModel.pricing.completion);
            if (prompt == null || completion == null) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "sambanova",
                input: prompt * 1_000_000,
                output: completion * 1_000_000,
                unit: "per_1M_tokens_usd",
                source: `api.sambanova.ai/v1/models (id: ${apiModel.id})`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [sambanova] error: ${error.message}`);
    }
    console.log(`${L}   [sambanova] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchFireworksPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [fireworks-ai] Fetching prices via app.fireworks.ai internal API...`);
    const prices = new Map<string, RealPrice>();
    try {
        const resp = await fetch("https://app.fireworks.ai/api/models?filter=All&serverless=true", {
            headers: {
                Accept: "application/json",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": currentUA(),
            },
        });
        if (!resp.ok) {
            console.warn(`${L}   [fireworks-ai] HTTP ${resp.status}`);
            return prices;
        }
        const raw = await resp.json() as any;
        const allModels = Array.isArray(raw) ? raw : (raw.models || raw.data || []);
        const liveModels = allModels.filter((item: any) => item.serverless === true);
        for (const model of models) {
            const apiModel = findApiObject(liveModels, model, (item: any) => [
                item.id,
                item.name,
                item.link ? providerRoot(String(item.link).replace(/^\/models\//, "")) : null,
            ]);
            if (!(apiModel as any)?.cost) continue;

            let input: number | null = null;
            let output: number | null = null;
            let unit = "unknown";

            const apiCost = (apiModel as any).cost;

            if (apiCost.inputTokenUncachedPrice != null || apiCost.inputTokenPrice != null || apiCost.outputTokenPrice != null) {
                input = apiCost.inputTokenUncachedPrice ?? apiCost.inputTokenPrice ?? null;
                output = apiCost.outputTokenPrice ?? null;
                unit = "per_1M_tokens_usd";
            } else if (apiCost.tokenPrice != null) {
                input = apiCost.tokenPrice;
                output = null;
                unit = "per_1M_tokens_usd";
            } else if (apiCost.unitPrice != null) {
                input = apiCost.unitPrice;
                output = null;
                unit = "per_image_usd";
            } else if (apiCost.stepPrice != null) {
                input = apiCost.stepPrice;
                output = null;
                unit = "per_step_usd";
            } else if (apiCost.durationPrice != null) {
                input = apiCost.durationPrice / 60;
                output = null;
                unit = "per_second_usd";
            } else {
                continue;
            }

            prices.set(model.id, {
                modelId: model.id,
                provider: "fireworks-ai",
                input,
                output,
                unit,
                source: `app.fireworks.ai/api/models (id: ${(apiModel as any).id ?? (apiModel as any).name ?? model.providerId})`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [fireworks-ai] error: ${error.message}`);
    }
    console.log(`${L}   [fireworks-ai] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchGroqPrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [groq] Scraping model docs for ${models.length} models...`);
    const prices = new Map<string, RealPrice>();

    for (const model of models) {
        const page = await prepareBrowserPage(browser);
        const url = `https://console.groq.com/docs/model/${model.providerId}`;
        try {
            const ok = await navigateWithRetry(page, url, 30000, false);
            if (!ok) {
                await page.close().catch(() => { });
                continue;
            }
            const details = await page.evaluate(() => {
                const text = document.body.innerText || "";
                const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
                let inPricingSection = false;
                let inputPrice: number | null = null;
                let outputPrice: number | null = null;
                let perHour: number | null = null;
                let perMillionChars: number | null = null;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const lower = line.toLowerCase();
                    if (lower === "pricing" || lower === "price") {
                        inPricingSection = true;
                        continue;
                    }
                    if (lower === "limits" || lower === "key technical specifications") {
                        inPricingSection = false;
                    }
                    if (!inPricingSection) continue;
                    if (/per\s*\$/i.test(line) || /tokens?\s*per/i.test(line)) continue;

                    const priceMatch = line.match(/^\$([0-9.]+)/);
                    if (!priceMatch) continue;
                    const price = parseFloat(priceMatch[1]);
                    const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(" ").toLowerCase();
                    if (context.includes("hour")) {
                        perHour = price;
                        continue;
                    }
                    if (context.includes("character")) {
                        perMillionChars = price;
                        continue;
                    }
                    const prev = lines.slice(Math.max(0, i - 3), i).join(" ").toLowerCase();
                    if (prev.includes("input") && inputPrice == null) {
                        inputPrice = price;
                    } else if ((prev.includes("output") || inputPrice != null) && outputPrice == null) {
                        outputPrice = price;
                    }
                }

                return { inputPrice, outputPrice, perHour, perMillionChars };
            });

            if (details.inputPrice != null || details.outputPrice != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "groq",
                    input: details.inputPrice,
                    output: details.outputPrice,
                    unit: "per_1M_tokens_usd",
                    source: url,
                });
            } else if (details.perHour != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "groq",
                    input: details.perHour,
                    output: null,
                    unit: "per_hour_usd",
                    source: url,
                });
            } else if (details.perMillionChars != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "groq",
                    input: details.perMillionChars,
                    output: null,
                    unit: "per_1M_characters_usd",
                    source: url,
                });
            }
        } catch (error: any) {
            console.warn(`${L}   [groq] ${model.id}: ${error.message}`);
        } finally {
            await page.close().catch(() => { });
        }
        await sleep(300);
    }

    console.log(`${L}   [groq] got ${prices.size}/${models.length}`);
    return prices;
}

interface CoherePricing {
    modelFamily: string;
    inputPer1M?: number;
    outputPer1M?: number;
    textPer1M?: number;
    imagePer1M?: number;
    per1KSearches?: number;
    unit: string;
}

async function extractCohereTabPricing(page: Page): Promise<CoherePricing[]> {
    return await page.evaluate(() => {
        const results: CoherePricing[] = [];
        const text = document.body.innerText || "";
        const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
        let currentModel = "";

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^command\s*a$/i.test(line)) currentModel = "command-a";
            else if (/^command\s*r$/i.test(line) && !/7b/i.test(line)) currentModel = "command-r";
            else if (/command\s*r7b/i.test(line)) currentModel = "command-r7b";
            else if (/^embed\s*\d/i.test(line) || line.toLowerCase() === "embed 4" || line.toLowerCase() === "embed") currentModel = "embed";
            else if (/rerank.*fast/i.test(line)) currentModel = "rerank-fast";
            else if (/rerank.*pro/i.test(line) || (line.toLowerCase().includes("rerank") && line.toLowerCase().includes("multilingual"))) currentModel = "rerank-pro";
            if (!currentModel) continue;

            const priceMatch = line.match(/\$([0-9.]+)\s*(?:\/\s*)?/);
            if (!priceMatch) continue;
            const amount = parseFloat(priceMatch[1]);
            const prevLine = (lines[i - 1] || "").toLowerCase();
            const prevPrevLine = (lines[i - 2] || "").toLowerCase();
            const context = `${prevPrevLine} ${prevLine} ${line.toLowerCase()}`;
            let entry = results.find(item => item.modelFamily === currentModel);
            if (!entry) {
                entry = { modelFamily: currentModel, unit: "usd_per_1m_tokens" };
                results.push(entry);
            }

            if (context.includes("search")) {
                entry.per1KSearches = amount;
                entry.unit = "usd_per_1k_searches";
            } else if (context.includes("image")) {
                entry.imagePer1M = amount;
            } else if (context.includes("text cost") || (prevLine.includes("text") && !prevLine.includes("context"))) {
                entry.textPer1M = amount;
            } else if (context.includes("output") || prevLine === "output") {
                if (entry.outputPer1M == null) entry.outputPer1M = amount;
            } else if (context.includes("input") || prevLine === "input" || entry.inputPer1M == null) {
                if (entry.inputPer1M == null) entry.inputPer1M = amount;
            }
        }

        return results;
    });
}

function getCohereFamily(modelId: string): string {
    const name = modelId.toLowerCase();
    if (name.includes("command-a") || name.includes("command_a")) return "command-a";
    if (name.includes("r7b") || name.includes("command-r7b")) return "command-r7b";
    if (name.includes("command-r") && !name.includes("r7b")) return "command-r";
    if (name.includes("embed")) return "embed";
    if (name.includes("rerank") && name.includes("fast")) return "rerank-fast";
    if (name.includes("rerank") && (name.includes("pro") || name.includes("multilingual"))) return "rerank-pro";
    if (name.includes("aya") || name.includes("tiny-aya")) return "command-r7b";
    return "";
}

async function fetchCoherePrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [cohere] Scraping cohere.com/pricing...`);
    const prices = new Map<string, RealPrice>();
    const page = await prepareBrowserPage(browser);
    try {
        const ok = await navigateWithRetry(page, "https://cohere.com/pricing", 45000, false);
        if (!ok) return prices;
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button, [role='tab'], div[class*='tab'], span"));
            for (const el of buttons) {
                const text = (el as HTMLElement).innerText?.toLowerCase().trim() || "";
                if (text === "generative models" || text.includes("generative model")) {
                    (el as HTMLElement).click();
                    break;
                }
            }
        }).catch(() => { });
        await sleep(2500);
        const generative = await extractCohereTabPricing(page);

        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button, [role='tab'], div[class*='tab'], span"));
            for (const el of buttons) {
                const text = (el as HTMLElement).innerText?.toLowerCase().trim() || "";
                if (text.includes("retrieval") || text === "advanced retrieval models") {
                    (el as HTMLElement).click();
                    break;
                }
            }
        }).catch(() => { });
        await sleep(2500);
        const retrieval = await extractCohereTabPricing(page);

        const pricingMap = new Map<string, CoherePricing>();
        for (const entry of [...generative, ...retrieval]) {
            const existing = pricingMap.get(entry.modelFamily);
            pricingMap.set(entry.modelFamily, { ...existing, ...entry });
        }

        for (const model of models) {
            const family = getCohereFamily(model.providerId) || getCohereFamily(model.id);
            const pricing = pricingMap.get(family);
            if (!pricing) continue;

            if (pricing.per1KSearches != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "cohere",
                    input: pricing.per1KSearches,
                    output: null,
                    unit: "per_1K_searches_usd",
                    source: "https://cohere.com/pricing",
                    notes: `family=${family}`,
                });
                continue;
            }

            const input = pricing.inputPer1M ?? pricing.textPer1M ?? null;
            const output = pricing.outputPer1M ?? pricing.imagePer1M ?? null;
            if (input == null && output == null) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "cohere",
                input,
                output,
                unit: "per_1M_tokens_usd",
                source: "https://cohere.com/pricing",
                notes: `family=${family}`,
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [cohere] error: ${error.message}`);
    } finally {
        await page.close().catch(() => { });
    }
    console.log(`${L}   [cohere] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchWavespeedPrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [wavespeed] Scraping wavespeed.ai/pricing...`);
    const prices = new Map<string, RealPrice>();
    const page = await prepareBrowserPage(browser);

    try {
        let sharedPricingLoaded = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.goto("https://wavespeed.ai/pricing", { waitUntil: "domcontentloaded", timeout: 45000 });
                await sleep(2500);
                sharedPricingLoaded = true;
                break;
            } catch {
                if (attempt < 3) await sleep(2000);
            }
        }
        const pricingData = sharedPricingLoaded
            ? await page.evaluate(() => {
                const text = document.body.innerText || "";
                const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
                const results: Array<{
                    modelName: string;
                    perImage?: number;
                    perMegapixel?: number;
                    perSecondVideo?: number;
                    perVideo?: number;
                    inputPer1M?: number;
                    outputPer1M?: number;
                    unit: string;
                }> = [];
                let currentModel = "";
                let currentSection = "";

                for (const line of lines) {
                    const lower = line.toLowerCase();
                    if (lower.includes("image") && lower.includes("model")) currentSection = "image";
                    if (lower.includes("video")) currentSection = "video";
                    if (lower.includes("language model")) currentSection = "language";
                    if ((line.includes("/") || line.includes("flux") || line.includes("wan") || line.includes("stable")) && !line.includes("$") && !line.includes("http") && line.length < 80) {
                        currentModel = line;
                        continue;
                    }
                    if (!currentModel) continue;
                    const priceMatch = line.match(/\$([0-9.]+)/);
                    if (!priceMatch) continue;
                    const amount = parseFloat(priceMatch[1]);
                    let entry = results.find(item => item.modelName === currentModel);
                    if (!entry) {
                        entry = { modelName: currentModel, unit: "" };
                        results.push(entry);
                    }
                    if (lower.includes("per image") || lower.includes("/image")) {
                        entry.perImage = amount;
                        entry.unit = "usd_per_image";
                    } else if (lower.includes("megapixel") || lower.includes("per mp")) {
                        entry.perMegapixel = amount;
                        entry.unit = "usd_per_megapixel";
                    } else if (lower.includes("per second") || lower.includes("/second")) {
                        entry.perSecondVideo = amount;
                        entry.unit = "usd_per_second_video";
                    } else if (lower.includes("per video") || lower.includes("/video")) {
                        entry.perVideo = amount;
                        entry.unit = "usd_per_video";
                    } else if (lower.includes("input") || lower.includes("1m input")) {
                        entry.inputPer1M = amount;
                        entry.unit = "usd_per_1m_tokens";
                    } else if (lower.includes("output") || lower.includes("1m output")) {
                        entry.outputPer1M = amount;
                        entry.unit = "usd_per_1m_tokens";
                    } else if (currentSection === "image" && entry.perImage == null) {
                        entry.perImage = amount;
                        entry.unit = "usd_per_image";
                    } else if (currentSection === "video" && entry.perSecondVideo == null) {
                        entry.perSecondVideo = amount;
                        entry.unit = "usd_per_second_video";
                    } else if (entry.inputPer1M == null) {
                        entry.inputPer1M = amount;
                        entry.unit = "usd_per_1m_tokens";
                    } else if (entry.outputPer1M == null) {
                        entry.outputPer1M = amount;
                        entry.unit = "usd_per_1m_tokens";
                    }
                }
                return results;
            })
            : [];

        const sharedEntries = pricingData.map((item: any) => [item.modelName, item] as [string, any]);
        const unresolved: Top500Model[] = [];

        for (const model of models) {
            const match = matchByKeys(model, sharedEntries);
            if (!match) {
                unresolved.push(model);
                continue;
            }
            if (match.perImage != null) {
                prices.set(model.id, { modelId: model.id, provider: "wavespeed", input: match.perImage, output: null, unit: "per_image_usd", source: "https://wavespeed.ai/pricing" });
            } else if (match.perSecondVideo != null) {
                prices.set(model.id, { modelId: model.id, provider: "wavespeed", input: match.perSecondVideo, output: null, unit: "per_second_video_usd", source: "https://wavespeed.ai/pricing" });
            } else if (match.perVideo != null) {
                prices.set(model.id, { modelId: model.id, provider: "wavespeed", input: match.perVideo, output: null, unit: "per_video_usd", source: "https://wavespeed.ai/pricing" });
            } else if (match.inputPer1M != null || match.outputPer1M != null) {
                prices.set(model.id, { modelId: model.id, provider: "wavespeed", input: match.inputPer1M ?? null, output: match.outputPer1M ?? null, unit: "per_1M_tokens_usd", source: "https://wavespeed.ai/pricing" });
            } else {
                unresolved.push(model);
            }
        }

        for (const model of unresolved) {
            const routeId = model.providerId.split(":")[0].split("/").map(encodeURIComponent).join("/");
            const url = `https://wavespeed.ai/models/${routeId}`;
            let loaded = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
                    await sleep(2500);
                    loaded = true;
                    break;
                } catch {
                    if (attempt < 3) await sleep(2000);
                }
            }
            if (!loaded) continue;
            const html = await page.content().catch(() => "");
            const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
            const parsed = parseWaveSpeedModelPage({
                providerId: model.providerId.split(":")[0],
                html,
                text,
                sourceUrl: url,
            });
            if (!parsed) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "wavespeed",
                input: parsed.input,
                output: parsed.output,
                unit: parsed.unit,
                source: parsed.source,
                notes: parsed.notes,
            });
            await sleep(150);
        }
    } catch (error: any) {
        console.warn(`${L}   [wavespeed] error: ${error.message}`);
    } finally {
        await page.close().catch(() => { });
    }
    console.log(`${L}   [wavespeed] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchScalewayPrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [scaleway] Scraping scaleway.com pricing...`);
    const prices = new Map<string, RealPrice>();
    const page = await prepareBrowserPage(browser);
    try {
        const ok = await navigateWithRetry(page, "https://www.scaleway.com/en/pricing/model-as-a-service/", 60000, true);
        if (!ok) return prices;
        const pricingData = await page.evaluate(() => {
            const text = document.body.innerText || "";
            const results: Array<{ model: string; inputPrice: number | null; outputPrice: number | null }> = [];
            const allElements = document.querySelectorAll("tr, [class*='row'], [class*='Row']");
            for (const element of allElements) {
                const rowText = (element as HTMLElement).innerText || "";
                const eurMatches = rowText.match(/€\s*([0-9.]+)/g);
                if (!eurMatches || eurMatches.length === 0) continue;
                const modelMatch = rowText.match(/([\w.-]+-[\w.-]+(?:-[\w.-]+)*)/);
                if (!modelMatch) continue;
                const modelName = modelMatch[1].toLowerCase();
                const amounts = eurMatches.map(item => parseFloat(item.replace("€", "").trim()));
                results.push({ model: modelName, inputPrice: amounts[0] ?? null, outputPrice: amounts[1] ?? null });
            }
            return results;
        });

        for (const model of models) {
            const match = matchByKeys(model, pricingData.map((item: any) => [item.model, item] as [string, any]));
            if (!match || match.inputPrice == null) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "scaleway",
                input: match.inputPrice,
                output: match.outputPrice,
                unit: "per_1M_tokens_eur",
                source: "https://www.scaleway.com/en/pricing/model-as-a-service/",
                notes: "raw official EUR price; no FX conversion applied in verifier",
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [scaleway] error: ${error.message}`);
    } finally {
        await page.close().catch(() => { });
    }
    console.log(`${L}   [scaleway] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchReplicatePrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [replicate] Fetching pricing from billingConfig in model HTML...`);
    const prices = new Map<string, RealPrice>();

    async function fetchModelPricing(replicateModelId: string): Promise<any | null> {
        const cleanId = replicateModelId.split(":")[0];
        const url = `https://replicate.com/${cleanId}`;
        const response = await fetch(url, {
            headers: { "User-Agent": currentUA(), Accept: "text/html" },
        });
        if (!response.ok) return null;
        const html = await response.text();
        const scriptRegex = /<script[^>]*id="react-component-props-[^"]*"[^>]*>(.*?)<\/script>/gs;
        let match: RegExpExecArray | null;
        while ((match = scriptRegex.exec(html)) !== null) {
            try {
                const data = JSON.parse(match[1]);
                if ("billingConfig" in data && data.billingConfig) return data.billingConfig;
            } catch {
                // ignore invalid blocks
            }
        }
        return null;
    }

    function parseBillingConfig(config: any): RealPrice | null {
        const pricing: Record<string, number> = {};
        let unit = "unknown";
        for (const tier of config.current_tiers ?? []) {
            for (const price of tier.prices ?? []) {
                const amount = parseMoney(price.price);
                if (amount == null) continue;
                const titleLower = toLc(price.title);
                if (price.metric === "token_input_count") {
                    pricing.input = titleLower.includes("thousand") ? amount * 1000 : amount;
                    unit = "per_1M_tokens_usd";
                } else if (price.metric === "token_output_count") {
                    pricing.output = titleLower.includes("thousand") ? amount * 1000 : amount;
                    unit = "per_1M_tokens_usd";
                } else if (price.metric === "image_output_count") {
                    pricing.input = titleLower.includes("thousand") ? amount / 1000 : amount;
                    unit = "per_image_usd";
                } else if (price.metric === "video_output_duration_seconds") {
                    pricing.input = amount;
                    unit = "per_second_video_usd";
                } else if (price.metric === "audio_output_duration_seconds") {
                    pricing.input = amount;
                    unit = "per_second_audio_usd";
                }
            }
        }
        if (Object.keys(pricing).length === 0) return null;
        return {
            modelId: "",
            provider: "replicate",
            input: pricing.input ?? null,
            output: pricing.output ?? null,
            unit,
            source: "",
        };
    }

    for (const model of models) {
        try {
            const billing = await fetchModelPricing(model.providerId);
            if (!billing) continue;
            const parsed = parseBillingConfig(billing);
            if (!parsed) continue;
            prices.set(model.id, {
                ...parsed,
                modelId: model.id,
                source: `https://replicate.com/${model.providerId.split(":")[0]}`,
            });
        } catch (error: any) {
            console.warn(`${L}   [replicate] ${model.id}: ${error.message}`);
        }
        await sleep(150);
    }

    console.log(`${L}   [replicate] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchPublicAIPrices(models: Top500Model[]): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [publicai] Fetching prices via api.publicai.co...`);
    const prices = new Map<string, RealPrice>();
    if (!PUBLICAI_KEY) {
        console.warn(`${L}   [publicai] PUBLICAI_API_KEY missing`);
        return prices;
    }
    try {
        const resp = await fetch("https://api.publicai.co/v1/models", {
            headers: {
                Authorization: `Bearer ${PUBLICAI_KEY}`,
                Accept: "application/json",
                "User-Agent": currentUA(),
            },
        });
        if (!resp.ok) {
            console.warn(`${L}   [publicai] HTTP ${resp.status}`);
            return prices;
        }
        const data = await resp.json() as { data?: any[]; object?: string };
        const apiModels = data.data ?? [];
        for (const model of models) {
            const apiModel = findApiObject(apiModels, model, (item) => [item.id]);
            const pricing = apiModel?.pricing;
            if (!pricing || (pricing.input == null && pricing.output == null)) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "publicai",
                input: pricing.input ?? null,
                output: pricing.output ?? null,
                unit: "per_1M_tokens_usd",
                source: "https://api.publicai.co/v1/models",
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [publicai] error: ${error.message}`);
    }
    console.log(`${L}   [publicai] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchCerebrasPrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [cerebras] Fetching models API and pricing page...`);
    const prices = new Map<string, RealPrice>();
    const page = await prepareBrowserPage(browser);

    try {
        let apiModels: any[] = [];
        if (CEREBRAS_KEY) {
            const apiResp = await fetch("https://api.cerebras.ai/v1/models", {
                headers: { Authorization: `Bearer ${CEREBRAS_KEY}` },
            });
            if (apiResp.ok) {
                const data = await apiResp.json() as { data: any[] };
                apiModels = data.data ?? [];
            }
        }

        const ok = await navigateWithRetry(page, "https://cerebras.ai/pricing", 45000, true);
        if (!ok) return prices;
        const pricingText = await page.evaluate(() => document.body.innerText || "");
        const pricingData = parseCerebrasPricingText(pricingText);
        const pricingByKey = new Map<string, CerebrasParsedRow>();
        for (const row of pricingData) {
            pricingByKey.set(compactKey(row.modelName), row);
        }

        for (const model of models) {
            const apiModel = findApiObject(apiModels, model, (item) => [item.id, item.hugging_face_id]);
            const match = pricingByKey.get(compactKey(apiModel?.id ?? model.providerId));
            if (!match || !match.inputPer1M) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "cerebras",
                input: match.inputPer1M,
                output: match.outputPer1M || match.inputPer1M,
                unit: "per_1M_tokens_usd",
                source: "https://cerebras.ai/pricing",
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [cerebras] error: ${error.message}`);
    } finally {
        await page.close().catch(() => { });
    }

    console.log(`${L}   [cerebras] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchOVHcloudPrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [ovhcloud] Scraping endpoints.ai.cloud.ovh.net...`);
    const prices = new Map<string, RealPrice>();
    const page = await prepareBrowserPage(browser);
    try {
        const sourceUrl = "https://www.ovhcloud.com/en-ca/public-cloud/ai-endpoints/catalog/";
        const ok = await navigateWithRetry(page, sourceUrl, 60000, true);
        if (!ok) return prices;
        const pricingText = await page.evaluate(() => document.body.innerText || "");
        const pricingData = parseOVHcloudCatalogText(pricingText);

        for (const model of models) {
            const match = matchByKeys(model, pricingData.map((item: any) => [item.name, item] as [string, any]));
            if (!match) continue;
            if ((match as any).perImage != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "ovhcloud",
                    input: (match as any).perImage,
                    output: null,
                    unit: "per_image_usd",
                    source: sourceUrl,
                });
            } else if ((match as any).inputPer1M != null || (match as any).outputPer1M != null) {
                prices.set(model.id, {
                    modelId: model.id,
                    provider: "ovhcloud",
                    input: (match as any).inputPer1M ?? null,
                    output: (match as any).outputPer1M ?? null,
                    unit: "per_1M_tokens_usd",
                    source: sourceUrl,
                });
            }
        }
    } catch (error: any) {
        console.warn(`${L}   [ovhcloud] error: ${error.message}`);
    } finally {
        await page.close().catch(() => { });
    }
    console.log(`${L}   [ovhcloud] got ${prices.size}/${models.length}`);
    return prices;
}

async function fetchZaiOrgPrices(models: Top500Model[], browser: Browser): Promise<Map<string, RealPrice>> {
    console.log(`${L}   [zai-org] Scraping official pricing pages...`);
    const prices = new Map<string, RealPrice>();
    const page = await prepareBrowserPage(browser);
    try {
        const urls = ["https://open.bigmodel.cn/pricing", "https://bigmodel.cn/pricing", "https://open.bigmodel.cn/dev/howuse/rate-limits"];
        let loaded = false;
        for (const url of urls) {
            const ok = await navigateWithRetry(page, url, 20000, true);
            if (!ok) continue;
            const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
            if (text.length > 200 && (text.includes("GLM") || text.includes("价格") || text.toLowerCase().includes("pricing"))) {
                loaded = true;
                break;
            }
        }
        if (!loaded) return prices;

        const pricingData = await page.evaluate(() => {
            const text = document.body.innerText || "";
            const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
            const results: Array<{ modelName: string; input?: number; output?: number; currency: "USD" | "CNY" }> = [];
            let currentModel = "";
            for (const line of lines) {
                if ((line.includes("GLM") || line.includes("glm") || line.includes("ChatGLM")) && !line.includes("$") && !line.includes("¥") && line.length < 50) {
                    currentModel = line;
                    continue;
                }
                if (!currentModel) continue;
                const usd = line.match(/\$([0-9.]+)/);
                const cny = line.match(/[¥￥]([0-9.]+)/);
                if (!usd && !cny) continue;
                const currency = usd ? "USD" : "CNY";
                const amount = parseFloat((usd ?? cny)![1]);
                let entry = results.find(item => item.modelName === currentModel && item.currency === currency);
                if (!entry) {
                    entry = { modelName: currentModel, currency };
                    results.push(entry);
                }
                if (entry.input == null) entry.input = amount;
                else if (entry.output == null) entry.output = amount;
            }
            return results;
        });

        for (const model of models) {
            const match = matchByKeys(model, pricingData.map((item: any) => [item.modelName, item] as [string, any]));
            if (!match) continue;
            prices.set(model.id, {
                modelId: model.id,
                provider: "zai-org",
                input: match.input ?? null,
                output: match.output ?? null,
                unit: match.currency === "USD" ? "per_1M_tokens_usd" : "per_1M_tokens_cny",
                source: "https://open.bigmodel.cn/pricing",
                notes: match.currency === "USD" ? undefined : "raw official CNY price; no FX conversion applied in verifier",
            });
        }
    } catch (error: any) {
        console.warn(`${L}   [zai-org] error: ${error.message}`);
    } finally {
        await page.close().catch(() => { });
    }
    console.log(`${L}   [zai-org] got ${prices.size}/${models.length}`);
    return prices;
}

function fetchHFInferencePrices(models: Top500Model[]): Map<string, RealPrice> {
    console.log(`${L}   [hf-inference] Compute-time billing`);
    const prices = new Map<string, RealPrice>();
    for (const model of models) {
        prices.set(model.id, {
            modelId: model.id,
            provider: "hf-inference",
            input: null,
            output: null,
            unit: "compute_time",
            source: "https://huggingface.co/pricing",
        });
    }
    return prices;
}

// ============================================================
// STEP 3: Compare real prices vs hf.json
// ============================================================
type VerificationStatus =
    | "MATCH"
    | "MISMATCH"
    | "UNIT_MISMATCH"
    | "NOT_IN_HF"
    | "NO_REAL_PRICE"
    | "SUBSCRIPTION"
    | "COMPUTE_TIME";

interface VerificationResult {
    rank: number;
    modelId: string;
    provider: string;
    providerId: string;
    hfSelectedProvider: string | null;
    selectionReason: string;
    pipeline: string;
    allLiveProviders: ProviderMapping[];
    hfPrice: { unit: string; values: Record<string, number> } | null;
    realPrice: RealPrice | null;
    status: VerificationStatus;
    details: string;
}

function getHfComparableValues(hfModel: HFModelEntry, normalizedUnit: string): { input: number | null; output: number | null } {
    const values = hfModel.prices?.values ?? {};

    switch (normalizedUnit) {
        case "usd_per_1m_tokens":
        case "per_1m_tokens":
        case "eur_per_1m_tokens":
        case "cny_per_1m_tokens":
            return {
                input: values.input ?? null,
                output: values.output ?? null,
            };
        case "usd_per_image":
        case "per_image":
        case "usd_per_megapixel":
        case "per_megapixel":
        case "usd_per_processed_megapixel":
        case "per_processed_megapixel":
        case "usd_per_run":
        case "per_run":
        case "usd_per_step":
        case "usd_per_minute":
        case "usd_per_second":
        case "usd_per_second_video":
        case "usd_per_second_audio":
        case "usd_per_compute_second":
        case "per_compute_second":
        case "usd_per_video":
        case "usd_per_generation":
        case "usd_per_frame":
        case "usd_per_1k_characters":
        case "usd_per_1m_characters":
        case "usd_per_1k_searches":
            return {
                input:
                    values.image ??
                    values.megapixel ??
                    values.processed_megapixel ??
                    values.output ??
                    values.generation ??
                    values.run ??
                    values.video ??
                    values.frame ??
                    values.step ??
                    values.minute ??
                    values.compute_second ??
                    values.second ??
                    values.text ??
                    values.search ??
                    values.input ??
                    null,
                output: null,
            };
        default:
            return {
                input: values.input ?? null,
                output: values.output ?? null,
            };
    }
}

export function comparePrices(hfModel: HFModelEntry, real: RealPrice): { status: VerificationStatus; details: string } {
    const hfUnit = normalizeUnit(hfModel.prices?.unit ?? null);
    const realUnit = normalizeUnit(real.unit);
    if (hfUnit !== "unknown" && realUnit !== "unknown" && hfUnit !== realUnit) {
        return {
            status: "UNIT_MISMATCH",
            details: `unit: hf=${hfModel.prices?.unit ?? "null"} vs real=${real.unit}`,
        };
    }

    const { input: hfInput, output: hfOutput } = getHfComparableValues(hfModel, realUnit);
    const issues: string[] = [];

    const compareField = (name: "input" | "output", hfValue: number | null, realValue: number | null) => {
        if (hfValue == null && realValue == null) return;
        if (hfValue == null || realValue == null) {
            issues.push(`${name}: hf=${hfValue} vs real=${realValue}`);
            return;
        }
        if (!numbersMatch(hfValue, realValue)) {
            issues.push(`${name}: hf=${normalizeNumber(hfValue)} vs real=${normalizeNumber(realValue)}`);
        }
    };

    compareField("input", hfInput, real.input);
    compareField("output", hfOutput, real.output);

    if (issues.length === 0) {
        return { status: "MATCH", details: `Verified from ${real.source}` };
    }
    return { status: "MISMATCH", details: issues.join("; ") };
}

async function main(): Promise<void> {
    const start = Date.now();
    const hfIdx = loadHFJson();
    console.log(`${L} Loaded ${hfIdx.size} models from hf.json`);

    const rawTop = await fetchTop500Raw();
    const selectedTop = rawTop
        .map(raw => chooseProvider(raw, hfIdx.get(raw.id)))
        .filter((model): model is Top500Model => model !== null);

    const byProvider = new Map<string, Top500Model[]>();
    for (const model of selectedTop) {
        const existing = byProvider.get(model.provider) ?? [];
        existing.push(model);
        byProvider.set(model.provider, existing);
    }

    console.log(`\n${L} Provider distribution:`);
    for (const [provider, models] of [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${provider}: ${models.length}`);
    }

    console.log(`\n${L} STEP 2: Fetching real prices from provider sources...`);
    const realPrices = new Map<string, RealPrice>();
    const mergePrices = (map: Map<string, RealPrice>) => {
        for (const [key, value] of map) realPrices.set(key, value);
    };

    const apiProviderJobs: Array<Promise<Map<string, RealPrice>>> = [];
    if (byProvider.has("fal-ai")) apiProviderJobs.push(fetchFalPrices(byProvider.get("fal-ai")!));
    if (byProvider.has("novita")) apiProviderJobs.push(fetchNovitaPrices(byProvider.get("novita")!));
    if (byProvider.has("together")) apiProviderJobs.push(fetchTogetherPrices(byProvider.get("together")!));
    if (byProvider.has("nscale")) apiProviderJobs.push(fetchNscalePrices(byProvider.get("nscale")!));
    if (byProvider.has("hyperbolic")) apiProviderJobs.push(fetchHyperbolicPrices(byProvider.get("hyperbolic")!));
    if (byProvider.has("sambanova")) apiProviderJobs.push(fetchSambanovaPrices(byProvider.get("sambanova")!));
    if (byProvider.has("fireworks-ai")) apiProviderJobs.push(fetchFireworksPrices(byProvider.get("fireworks-ai")!));
    if (byProvider.has("replicate")) apiProviderJobs.push(fetchReplicatePrices(byProvider.get("replicate")!));
    if (byProvider.has("publicai")) apiProviderJobs.push(fetchPublicAIPrices(byProvider.get("publicai")!));
    if (byProvider.has("hf-inference")) apiProviderJobs.push(Promise.resolve(fetchHFInferencePrices(byProvider.get("hf-inference")!)));
    for (const result of await Promise.all(apiProviderJobs)) {
        mergePrices(result);
    }

    const browserProviders = ["groq", "cohere", "wavespeed", "scaleway", "cerebras", "ovhcloud", "zai-org"];
    const needsBrowser = browserProviders.some(provider => byProvider.has(provider));
    let browser: Browser | null = null;
    if (needsBrowser) {
        console.log(`\n${L} Launching Puppeteer with JoinMassive proxy...`);
        browser = await puppeteer.launch({
            headless: true,
            args: [
                `--proxy-server=${MASSIVE_PROXY}`,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--ignore-certificate-errors",
            ],
        });
    }

    try {
        if (browser) {
            const browserJobs: Array<Promise<Map<string, RealPrice>>> = [];
            if (byProvider.has("groq")) browserJobs.push(fetchGroqPrices(byProvider.get("groq")!, browser));
            if (byProvider.has("cohere")) browserJobs.push(fetchCoherePrices(byProvider.get("cohere")!, browser));
            if (byProvider.has("wavespeed")) browserJobs.push(fetchWavespeedPrices(byProvider.get("wavespeed")!, browser));
            if (byProvider.has("scaleway")) browserJobs.push(fetchScalewayPrices(byProvider.get("scaleway")!, browser));
            if (byProvider.has("cerebras")) browserJobs.push(fetchCerebrasPrices(byProvider.get("cerebras")!, browser));
            if (byProvider.has("ovhcloud")) browserJobs.push(fetchOVHcloudPrices(byProvider.get("ovhcloud")!, browser));
            if (byProvider.has("zai-org")) browserJobs.push(fetchZaiOrgPrices(byProvider.get("zai-org")!, browser));
            for (const result of await Promise.all(browserJobs)) {
                mergePrices(result);
            }
        }
    } finally {
        if (browser) {
            await browser.close().catch(() => { });
        }
    }

    console.log(`\n${L} STEP 3: Comparing real prices vs hf.json...`);
    console.log(`${L}   Real prices fetched: ${realPrices.size}/${selectedTop.length}`);

    const results: VerificationResult[] = [];
    let matchCount = 0;
    let mismatchCount = 0;
    let unitMismatchCount = 0;
    let notInHF = 0;
    let noRealPrice = 0;
    let subOrCompute = 0;

    for (let i = 0; i < selectedTop.length; i++) {
        const model = selectedTop[i];
        const rank = i + 1;
        const hfModel = hfIdx.get(model.id);
        const real = realPrices.get(model.id) ?? null;

        if (!hfModel) {
            notInHF++;
            results.push({
                rank,
                modelId: model.id,
                provider: model.provider,
                providerId: model.providerId,
                hfSelectedProvider: model.hfSelectedProvider,
                selectionReason: model.selectionReason,
                pipeline: model.pipeline,
                allLiveProviders: model.allProviders,
                hfPrice: null,
                realPrice: real,
                status: "NOT_IN_HF",
                details: "Model not found in hf.json",
            });
            continue;
        }

        if (!real) {
            noRealPrice++;
            results.push({
                rank,
                modelId: model.id,
                provider: model.provider,
                providerId: model.providerId,
                hfSelectedProvider: model.hfSelectedProvider,
                selectionReason: model.selectionReason,
                pipeline: model.pipeline,
                allLiveProviders: model.allProviders,
                hfPrice: hfModel.prices ?? null,
                realPrice: null,
                status: "NO_REAL_PRICE",
                details: "Could not fetch real price from provider source",
            });
            continue;
        }

        if (normalizeUnit(real.unit) === "subscription") {
            subOrCompute++;
            results.push({
                rank,
                modelId: model.id,
                provider: model.provider,
                providerId: model.providerId,
                hfSelectedProvider: model.hfSelectedProvider,
                selectionReason: model.selectionReason,
                pipeline: model.pipeline,
                allLiveProviders: model.allProviders,
                hfPrice: hfModel.prices ?? null,
                realPrice: real,
                status: "SUBSCRIPTION",
                details: `subscription pricing — ${real.source}`,
            });
            continue;
        }

        if (normalizeUnit(real.unit) === "compute_time") {
            subOrCompute++;
            results.push({
                rank,
                modelId: model.id,
                provider: model.provider,
                providerId: model.providerId,
                hfSelectedProvider: model.hfSelectedProvider,
                selectionReason: model.selectionReason,
                pipeline: model.pipeline,
                allLiveProviders: model.allProviders,
                hfPrice: hfModel.prices ?? null,
                realPrice: real,
                status: "COMPUTE_TIME",
                details: `compute-time pricing — ${real.source}`,
            });
            continue;
        }

        const comparison = comparePrices(hfModel, real);
        if (comparison.status === "MATCH") matchCount++;
        else if (comparison.status === "UNIT_MISMATCH") unitMismatchCount++;
        else mismatchCount++;

        results.push({
            rank,
            modelId: model.id,
            provider: model.provider,
            providerId: model.providerId,
            hfSelectedProvider: model.hfSelectedProvider,
            selectionReason: model.selectionReason,
            pipeline: model.pipeline,
            allLiveProviders: model.allProviders,
            hfPrice: hfModel.prices ?? null,
            realPrice: real,
            status: comparison.status,
            details: comparison.details,
        });
    }

    console.log("=".repeat(72));
    console.log("PRICE VERIFICATION REPORT");
    console.log("=".repeat(72));
    console.log(`  Verified models:          ${selectedTop.length}`);
    console.log(`  MATCH:                    ${matchCount}`);
    console.log(`  MISMATCH:                 ${mismatchCount}`);
    console.log(`  UNIT_MISMATCH:            ${unitMismatchCount}`);
    console.log(`  NOT_IN_HF:                ${notInHF}`);
    console.log(`  NO_REAL_PRICE:            ${noRealPrice}`);
    console.log(`  SUBSCRIPTION/COMPUTE:     ${subOrCompute}`);

    const noPriceByProvider: Record<string, number> = {};
    for (const result of results.filter(item => item.status === "NO_REAL_PRICE")) {
        noPriceByProvider[result.provider] = (noPriceByProvider[result.provider] ?? 0) + 1;
    }
    if (Object.keys(noPriceByProvider).length > 0) {
        console.log(`\n${L} Missing real prices by provider:`);
        for (const [provider, count] of Object.entries(noPriceByProvider).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${provider}: ${count}`);
        }
    }

    const providerCoverage = Object.fromEntries(
        [...byProvider.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([provider, models]) => {
                const providerResults = results.filter(result => result.provider === provider);
                return [
                    provider,
                    {
                        selected: models.length,
                        realPricesFetched: providerResults.filter(result => result.realPrice !== null).length,
                        matches: providerResults.filter(result => result.status === "MATCH").length,
                        mismatches: providerResults.filter(result => result.status === "MISMATCH").length,
                        unitMismatches: providerResults.filter(result => result.status === "UNIT_MISMATCH").length,
                        noRealPrice: providerResults.filter(result => result.status === "NO_REAL_PRICE").length,
                        notInHF: providerResults.filter(result => result.status === "NOT_IN_HF").length,
                    },
                ];
            }),
    );

    const report = {
        timestamp: new Date().toISOString(),
        summary: {
            verifiedModels: selectedTop.length,
            matches: matchCount,
            mismatches: mismatchCount,
            unitMismatches: unitMismatchCount,
            notInHF,
            noRealPrice,
            subOrCompute,
        },
        total: selectedTop.length,
        filters: {
            verifyProviders: [...VERIFY_PROVIDERS],
            verifyLimit: VERIFY_LIMIT,
        },
        matches: matchCount,
        mismatches: mismatchCount,
        unitMismatches: unitMismatchCount,
        notInHF,
        noRealPrice,
        subOrCompute,
        providerCoverage,
        results,
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    console.log(`\n${L} Full report saved to: ${OUTPUT}`);
    console.log(`${L} Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename) {
    main().catch(error => {
        console.error(`${L} FATAL:`, error);
        process.exit(1);
    });
}
