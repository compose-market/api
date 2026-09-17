import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCard } from "../inference/types.js";
import {
    analyzePowerVariant,
    matchBenchmarkRecord,
    selectBestPowerVariants,
} from "../data/benchmarks/matching.js";
import { buildFrontierIndex, canonicalFrontierId, isFrontierModel } from "../data/benchmarks/service.js";
import type { RawBenchmarkRecord } from "../data/benchmarks/types.js";
import { resolveBenchmarkCatalogModel } from "../data/benchmarks/service.js";

function record(overrides: Partial<RawBenchmarkRecord>): RawBenchmarkRecord {
    return {
        source: "artificial-analysis",
        sourceModelId: overrides.sourceModelId ?? overrides.sourceName ?? "source-id",
        sourceSlug: overrides.sourceSlug ?? null,
        sourceName: overrides.sourceName ?? "Model",
        sourceCreatorName: overrides.sourceCreatorName ?? "OpenAI",
        sourceCreatorSlug: overrides.sourceCreatorSlug ?? "openai",
        releaseDate: overrides.releaseDate ?? null,
        operation: overrides.operation ?? "chat",
        variant: overrides.variant ?? null,
        metrics: overrides.metrics ?? { intelligence: null },
        sourceVersion: overrides.sourceVersion ?? null,
        payload: overrides.payload ?? {},
    };
}

test("power tiers select the best measured variant without treating benchmark parameters as model tiers", () => {
    const rows = [
        record({ sourceModelId: "low", sourceName: "Frontier Model (low)", sourceSlug: "frontier-model-low", metrics: { intelligence: 40 } }),
        record({ sourceModelId: "high", sourceName: "Frontier Model (high)", sourceSlug: "frontier-model-high", metrics: { intelligence: 50 } }),
        record({ sourceModelId: "xhigh", sourceName: "Frontier Model (xhigh)", sourceSlug: "frontier-model", metrics: { intelligence: 48 } }),
        record({ sourceModelId: "horizon-low", sourceName: "Frontier Model (long-horizon, low)", sourceSlug: "frontier-model-horizon-low", metrics: { intelligence: 44 } }),
        record({ sourceModelId: "horizon-high", sourceName: "Frontier Model (long-horizon, high)", sourceSlug: "frontier-model-horizon-high", metrics: { intelligence: 46 } }),
    ];

    const selected = selectBestPowerVariants(rows, "intelligence", "higher");
    const winners = selected.filter((row) => row.isBest);
    assert.deepEqual(winners.map((row) => row.record.sourceModelId).sort(), ["high", "horizon-high"]);

    const horizon = analyzePowerVariant(rows[3]);
    assert.equal(horizon.baseName, "Frontier Model");
    assert.deepEqual(horizon.parameters, ["long-horizon"]);
});

test("benchmark matching uses exact aliases while retaining identity-bearing preview/chat/version terms", () => {
    const catalog = [
        {
            modelId: "example-2.5-preview",
            name: "Example 2.5 Preview",
            provider: "openai",
            family: "openai",
            type: "text generation",
            semantics: { capabilities: [{ operation: "chat" }] },
        } as ModelCard,
        {
            modelId: "example-25",
            name: "Example 25",
            provider: "openai",
            family: "openai",
            type: "text generation",
            semantics: { capabilities: [{ operation: "chat" }] },
        } as ModelCard,
    ];

    const match = matchBenchmarkRecord(record({
        sourceName: "Example 2.5 Preview (high)",
        sourceSlug: "example-2-5-preview",
        sourceModelId: "aa-example-preview",
    }), catalog, "2026-08-19");

    assert.equal(match.catalogModelId, "example-2.5-preview");
    assert.equal(match.catalogProvider, "openai");
    assert.notEqual(match.catalogModelId, "example-25");
});

test("power analysis treats adaptive reasoning and effort tiers as measurement modes of one model", () => {
    const adaptive = analyzePowerVariant(record({
        sourceName: "Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)",
        sourceSlug: "claude-opus-5-xhigh",
    }));
    const nonReasoning = analyzePowerVariant(record({
        sourceName: "Claude Sonnet 5 (Non-reasoning, High Effort)",
        sourceSlug: "claude-sonnet-5-non-reasoning",
    }));
    const plain = analyzePowerVariant(record({
        sourceName: "Claude Sonnet 5",
        sourceSlug: "claude-sonnet-5",
    }));

    // Adaptive reasoning is a mode label: stripped from identity AND
    // parameters, so every AA variant of one model maps to the canonical slug.
    assert.equal(adaptive.baseName, "Claude Opus 5");
    assert.equal(adaptive.powerRank, 5);
    assert.deepEqual(adaptive.parameters, []);
    assert.deepEqual(nonReasoning.parameters, []);
    assert.equal(nonReasoning.baseName, "Claude Sonnet 5");
    // Adaptive, non-reasoning, and plain records of the same model share one
    // power group, so only the best-measured variant keeps a link.
    assert.equal(nonReasoning.groupKey, plain.groupKey);
});

test("power analysis treats reasoning modes as variant labels, not identity or parameters", () => {
    const reasoning = analyzePowerVariant(record({
        sourceName: "DeepSeek V3.2 (Reasoning)",
        sourceSlug: "deepseek-v3-2-reasoning",
    }));
    const plain = analyzePowerVariant(record({
        sourceName: "DeepSeek V3.2",
        sourceSlug: "deepseek-v3-2",
    }));

    assert.equal(reasoning.baseName, "DeepSeek V3.2");
    assert.deepEqual(reasoning.parameters, []);
    // Same model, same parameters: one power group, one best variant.
    assert.equal(reasoning.groupKey, plain.groupKey);
});

test("benchmark matching links effort-tier and reasoning variants to the catalog model", () => {
    const catalog = [
        {
            modelId: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            provider: "deepinfra",
            family: "deepseek",
            type: "text generation",
            semantics: { capabilities: [{ operation: "chat" }] },
        } as ModelCard,
    ];

    const effort = matchBenchmarkRecord(record({
        sourceName: "DeepSeek V4 Pro (Reasoning, High Effort)",
        sourceSlug: "deepseek-v4-pro-0424-high",
        sourceCreatorName: "DeepSeek",
        sourceCreatorSlug: "deepseek",
        metrics: { intelligence: 43 },
    }), catalog, "2026-08-29");

    assert.equal(effort.catalogModelId, "deepseek-v4-pro");
    assert.equal(effort.matchMethod, "exact-id");

    const reasoning = matchBenchmarkRecord(record({
        sourceName: "DeepSeek V4 Pro (Non-reasoning)",
        sourceSlug: "deepseek-v4-pro-0424-non-reasoning",
        sourceCreatorName: "DeepSeek",
        sourceCreatorSlug: "deepseek",
    }), catalog, "2026-08-29");

    assert.equal(reasoning.catalogModelId, "deepseek-v4-pro");
});

test("benchmark matching links collapsed multi-provider rows through every provider wire id", () => {
    const catalog = [
        {
            modelId: "glm-5.2",
            name: "GLM 5.2",
            provider: "fireworks",
            family: "zai",
            type: "text generation",
            semantics: { capabilities: [{ operation: "chat" }] },
            providerRoutes: [
                { provider: "fireworks", upstreamModelId: "accounts/fireworks/models/glm-5p2" },
                { provider: "cloudflare", upstreamModelId: "@cf/zai-org/glm-5.2" },
            ],
        } as ModelCard,
    ];

    // Artificial Analysis slug uses the canonical dot/dash spelling.
    const slugMatch = matchBenchmarkRecord(record({
        sourceName: "GLM-5.2 (max)",
        sourceSlug: "glm-5-2",
        sourceCreatorName: "Z.ai",
        sourceCreatorSlug: "zai",
    }), catalog, "2026-08-29");
    assert.equal(slugMatch.catalogModelId, "glm-5.2");

    // A record carrying a provider wire spelling still links to the one row.
    const wireMatch = matchBenchmarkRecord(record({
        sourceName: "GLM 5.2",
        sourceSlug: "zai-org-glm-5-2",
        sourceModelId: "zai-org/GLM-5.2",
        sourceCreatorName: "Z.ai",
        sourceCreatorSlug: "zai",
    }), catalog, "2026-08-29");
    assert.equal(wireMatch.catalogModelId, "glm-5.2");

});

test("benchmark matching links media generators to editing and image-to-video arenas", () => {
    const catalog = [
        {
            modelId: "Seedance-2.0",
            name: "Seedance 2.0",
            provider: "deepinfra",
            family: "bytedance",
            type: "video generation",
            semantics: { capabilities: [{ operation: "text-to-video" }] },
        } as ModelCard,
        {
            modelId: "nano-banana-pro",
            name: "Nano Banana Pro",
            provider: "deepinfra",
            family: "google",
            type: "image generation",
            semantics: { capabilities: [{ operation: "text-to-image" }] },
        } as ModelCard,
    ];

    const video = matchBenchmarkRecord(record({
        operation: "image-to-video",
        sourceName: "Dreamina Seedance 2.0 720p",
        sourceSlug: "seedance-2-0",
        sourceCreatorName: "ByteDance",
        sourceCreatorSlug: "bytedance",
    }), catalog, "2026-08-29");
    assert.equal(video.catalogModelId, "Seedance-2.0");

    const image = matchBenchmarkRecord(record({
        operation: "image-to-image",
        sourceName: "Nano Banana Pro (Gemini 3 Pro Image)",
        sourceSlug: "gemini_nano-banana-pro",
        sourceCreatorName: "Google",
        sourceCreatorSlug: "google",
    }), catalog, "2026-08-29");
    assert.equal(image.catalogModelId, "nano-banana-pro");
});

test("frontier enrichment matches canonical model identity across provider and spelling skew", () => {
    // Worker rows can disagree with linked catalog rows on provider (route
    // winner drift) and spelling (Fireworks p-notation, casing) — especially
    // while the worker serves a different catalog version.
    const index = buildFrontierIndex([
        { provider: "fireworks", modelId: "glm-5p2" },
        { provider: "deepinfra", modelId: "Kimi-K3" },
        { provider: "gemini", modelId: "gemini-3-pro-preview" },
    ]);

    // Exact row match.
    assert.equal(isFrontierModel(index, "gemini", "gemini-3-pro-preview"), true);
    // p-notation spelling skew: collapsed catalog id glm-5.2 vs worker glm-5p2.
    assert.equal(isFrontierModel(index, "fireworks", "glm-5.2"), true);
    // Provider skew: canonical model id matches regardless of route winner.
    assert.equal(isFrontierModel(index, "alibaba", "kimi-k3"), true);
    assert.equal(isFrontierModel(index, "deepinfra", "Kimi-K3"), true);
    // Different models never match.
    assert.equal(isFrontierModel(index, "gemini", "gemini-3-pro"), false);
    assert.equal(isFrontierModel(index, "openai", "gpt-5.5"), false);

    assert.equal(canonicalFrontierId("GLM-5P2"), "glm-5.2");
    assert.equal(canonicalFrontierId("Qwen3.8-Max"), "qwen3.8-max");
});

test("benchmark publication follows the current canonical provider", () => {
    const model = resolveBenchmarkCatalogModel("gpt-5.5", "openai");
    assert.equal(model?.modelId, "gpt-5.5");
    assert.equal(model?.provider, "azure");
});
