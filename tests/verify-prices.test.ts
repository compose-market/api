import test from "node:test";
import assert from "node:assert/strict";

import {
    chooseProvider,
    comparePrices,
    collectFalEndpointIds,
    type HFModelEntry,
    type RealPrice,
    type RawTop500Model,
} from "./verify-prices.js";

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
