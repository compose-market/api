import test from "node:test";
import assert from "node:assert/strict";

interface ProviderMapping {
    provider: string;
    providerId: string;
    task?: string;
}

interface RawTop500Model {
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

interface HFModelEntry {
    modelId: string;
    selectedProvider: string;
    prices?: {
        unit: string;
        values: Record<string, number>;
    };
}

interface RealPrice {
    modelId: string;
    provider: string;
    input: number | null;
    output: number | null;
    unit: string;
    source: string;
}

function normalizeUnit(unit: string | null | undefined): string {
    const u = (unit ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/\/+/g, "_")
        .replace(/-+/g, "_");

    if (!u) return "unknown";
    if (u.includes("compute") && u.includes("second") && u.includes("usd")) return "usd_per_compute_second";
    if (u.includes("compute") && u.includes("second")) return "per_compute_second";
    if (u.includes("megapixel") && u.includes("usd")) return "usd_per_megapixel";
    if (u.includes("megapixel")) return "per_megapixel";
    if (u.includes("image") && u.includes("usd")) return "usd_per_image";
    if (u.includes("token") && u.includes("1m") && u.includes("usd")) return "usd_per_1m_tokens";
    return u;
}

function normalizeNumber(value: number | null | undefined): string | null {
    if (value == null || !Number.isFinite(value)) return null;
    return value.toFixed(9).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function chooseProvider(raw: RawTop500Model, hfModel: HFModelEntry | undefined): Top500Model | null {
    if (raw.allProviders.length === 0) return null;
    const hfSelectedProvider = hfModel?.selectedProvider ?? null;
    const preferred = hfSelectedProvider
        ? raw.allProviders.find((provider) => provider.provider === hfSelectedProvider) ?? null
        : null;
    const chosen = preferred ?? raw.allProviders[0];
    return {
        ...raw,
        provider: chosen.provider,
        providerId: chosen.providerId,
        hfSelectedProvider,
        selectionReason: preferred ? "selectedProvider from hf.json" : "first live provider mapping",
    };
}

function collectFalEndpointIds(models: Top500Model[]): string[] {
    const seen = new Set<string>();
    const endpointIds: string[] = [];
    for (const model of models) {
        const endpointId = model.providerId.trim();
        if (!endpointId || seen.has(endpointId)) continue;
        seen.add(endpointId);
        endpointIds.push(endpointId);
    }
    return endpointIds;
}

function getHfComparableValues(hfModel: HFModelEntry, normalizedUnit: string): { input: number | null; output: number | null } {
    const values = hfModel.prices?.values ?? {};
    if (normalizedUnit === "usd_per_1m_tokens") {
        return { input: values.input ?? null, output: values.output ?? null };
    }
    return {
        input: values.image ?? values.megapixel ?? values.compute_second ?? values.second ?? values.input ?? null,
        output: null,
    };
}

function comparePrices(hfModel: HFModelEntry, real: RealPrice): { status: "MATCH" | "MISMATCH" | "UNIT_MISMATCH"; details: string } {
    const hfUnit = normalizeUnit(hfModel.prices?.unit ?? null);
    const realUnit = normalizeUnit(real.unit);
    if (hfUnit !== "unknown" && realUnit !== "unknown" && hfUnit !== realUnit) {
        return { status: "UNIT_MISMATCH", details: `unit: hf=${hfModel.prices?.unit ?? "null"} vs real=${real.unit}` };
    }

    const { input, output } = getHfComparableValues(hfModel, realUnit);
    const issues: string[] = [];
    if (normalizeNumber(input) !== normalizeNumber(real.input)) issues.push(`input: hf=${input} vs real=${real.input}`);
    if (normalizeNumber(output) !== normalizeNumber(real.output)) issues.push(`output: hf=${output} vs real=${real.output}`);

    return issues.length === 0
        ? { status: "MATCH", details: `Verified from ${real.source}` }
        : { status: "MISMATCH", details: issues.join("; ") };
}

test("chooseProvider prefers hf selected provider when it is still live", () => {
    const raw: RawTop500Model = {
        id: "black-forest-labs/FLUX.1-dev",
        pipeline: "text-to-image",
        trending: 100,
        allProviders: [
            { provider: "replicate", providerId: "black-forest-labs/flux-dev" },
            { provider: "fal-ai", providerId: "fal-ai/flux/dev" },
        ],
    };
    const hfModel: HFModelEntry = {
        modelId: raw.id,
        selectedProvider: "fal-ai",
    };

    const chosen = chooseProvider(raw, hfModel);

    assert.ok(chosen);
    assert.equal(chosen.provider, "fal-ai");
    assert.equal(chosen.providerId, "fal-ai/flux/dev");
    assert.equal(chosen.selectionReason, "selectedProvider from hf.json");
});

test("comparePrices matches unit-aware megapixel pricing", () => {
    const hfModel: HFModelEntry = {
        modelId: "black-forest-labs/FLUX.1-dev",
        selectedProvider: "fal-ai",
        prices: {
            unit: "usd_per_megapixel",
            values: { megapixel: 0.025 },
        },
    };
    const real: RealPrice = {
        modelId: "black-forest-labs/FLUX.1-dev",
        provider: "fal-ai",
        input: 0.025,
        output: null,
        unit: "per_megapixels_usd",
        source: "api.fal.ai/v1/models/pricing (endpoint: fal-ai/flux/dev)",
    };

    const result = comparePrices(hfModel, real);

    assert.equal(result.status, "MATCH");
});

test("comparePrices matches unit-aware compute-second pricing", () => {
    const hfModel: HFModelEntry = {
        modelId: "tencent/HunyuanImage-3.0-Instruct",
        selectedProvider: "fal-ai",
        prices: {
            unit: "usd_per_compute_second",
            values: { compute_second: 0.00167 },
        },
    };
    const real: RealPrice = {
        modelId: "tencent/HunyuanImage-3.0-Instruct",
        provider: "fal-ai",
        input: 0.00167,
        output: null,
        unit: "per_compute seconds_usd",
        source: "api.fal.ai/v1/models/pricing (endpoint: fal-ai/hunyuan-image/v3/instruct/edit)",
    };

    const result = comparePrices(hfModel, real);

    assert.equal(result.status, "MATCH");
});

test("collectFalEndpointIds uses exact provider ids only", () => {
    const endpointIds = collectFalEndpointIds([
        {
            id: "black-forest-labs/FLUX.1-dev",
            pipeline: "text-to-image",
            trending: 100,
            provider: "fal-ai",
            providerId: "fal-ai/flux/dev",
            hfSelectedProvider: "fal-ai",
            selectionReason: "selectedProvider from hf.json",
            allProviders: [
                { provider: "fal-ai", providerId: "fal-ai/flux/dev" },
                { provider: "replicate", providerId: "black-forest-labs/flux-dev" },
            ],
        },
        {
            id: "Tongyi-MAI/Z-Image-Turbo",
            pipeline: "text-to-image",
            trending: 99,
            provider: "fal-ai",
            providerId: "fal-ai/z-image/turbo",
            hfSelectedProvider: "fal-ai",
            selectionReason: "selectedProvider from hf.json",
            allProviders: [
                { provider: "fal-ai", providerId: "fal-ai/z-image/turbo" },
                { provider: "wavespeed", providerId: "wavespeed-ai/z-image/turbo" },
            ],
        },
    ]);

    assert.deepEqual(endpointIds, [
        "fal-ai/flux/dev",
        "fal-ai/z-image/turbo",
    ]);
});
