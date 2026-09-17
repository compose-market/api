import test from "node:test";
import assert from "node:assert/strict";

import { aggregateCanonicalFamily, collapseDuplicateModels, dedupeModels, dotNotation, normalizePublicModelId, transformHuggingFaceModel, type NormalizedModel } from "../inference/scripts/sync-models.js";

function model(parts: {
    provider?: string;
    modelId?: string;
    resource?: string;
    capacity?: number;
    state?: string;
    family?: string;
}): NormalizedModel {
    return {
        name: parts.modelId ?? "gpt-4o",
        modelId: parts.modelId ?? "gpt-4o",
        ...(parts.family ? { family: parts.family } : {}),
        description: null,
        type: "text generation",
        provider: parts.provider ?? "azure",
        input: null,
        output: null,
        contextWindow: null,
        pricing: null,
        sourceMetadata: {
            azureDeployment: {
                resource: parts.resource,
                deploymentName: parts.modelId ?? "gpt-4o",
                provisioningState: parts.state ?? "Succeeded",
                sku: {
                    name: "GlobalStandard",
                    capacity: parts.capacity,
                },
            },
        },
    };
}

test("dedupeModels chooses the highest-capacity live Azure deployment for duplicate provider model ids", () => {
    const [selected] = dedupeModels([
        model({ resource: "Microsoft", capacity: 250 }),
        model({ resource: "Movzihpn", capacity: 5001 }),
    ]);

    assert.equal(selected?.modelId, "gpt-4o");
    assert.equal((selected?.sourceMetadata as any).azureDeployment.resource, "Movzihpn");
});

test("dedupeModels prefers a succeeded deployment over a higher-capacity non-succeeded deployment", () => {
    const [selected] = dedupeModels([
        model({ resource: "FailedResource", capacity: 9000, state: "Failed" }),
        model({ resource: "LiveResource", capacity: 100, state: "Succeeded" }),
    ]);

    assert.equal((selected?.sourceMetadata as any).azureDeployment.resource, "LiveResource");
});

test("aggregateCanonicalFamily centralizes model family routing", () => {
    const cases = [
        ["qwen-max", "alibaba"],
        ["qwq-plus", "alibaba"],
        ["wan2.1-t2i-plus", "alibaba"],
        ["cosyvoice-v3-flash", "alibaba"],
        ["paraformer-realtime-v2", "alibaba"],
        ["gte-rerank-v2", "alibaba"],
        ["fun-asr-2025-11-07", "alibaba"],
        ["qvq-max", "alibaba"],
        ["tongyi-embedding-vision-plus", "alibaba"],
        ["z-image-turbo", "alibaba"],
        ["happyhorse-1.0-t2v", "alibaba"],
        ["nemotron-ultra-253b-v1", "nvidia"],
        ["nv-embedqa-e5-v5", "nvidia"],
        ["grok-4.1", "xai"],
        ["claude-opus-4.5", "anthropic"],
        ["FLUX.2-pro", "blackforestlabs"],
        ["flux-2-pro", "blackforestlabs"],
        ["kontext-max", "blackforestlabs"],
        ["glm-5.1", "zai"],
        ["autoglm-rumination", "zai"],
        ["cogview4", "zai"],
        ["cogvideox-flash", "zai"],
        ["kimi-k2.6", "moonshot"],
        ["moonshot-v1-128k", "moonshot"],
        ["deepseek-v4-pro", "deepseek"],
        ["minimax-m2.7", "minimax"],
        ["hailuo-02", "minimax"],
        ["hunyuan-video", "tencent"],
        ["tencent/Hy3", "tencent"],
        ["ernie-4.5", "baidu"],
        ["mai-image-2", "microsoft"],
        ["gemini-3.1-flash-lite", "google"],
        ["gemma-4-26b-a4b-it", "google"],
        ["embeddinggemma-300m", "google"],
        ["imagen-4.0-ultra", "google"],
        ["veo-3.1-generate-preview", "google"],
        ["lyria-3-pro-preview", "google"],
        ["deep-research-pro-preview-12-2025", "google"],
        ["nano-banana", "google"],
        ["llama-4-scout", "meta"],
        ["seamless-m4t-v2", "meta"],
        ["m2m100-1.2b", "meta"],
        ["bart-large-cnn", "meta"],
        ["detr-resnet-50", "meta"],
        ["phi-4", "microsoft"],
        ["orca-mini", "microsoft"],
        ["resnet-50", "microsoft"],
        ["mistral-large", "mistral"],
        ["mixtral-8x22b", "mistral"],
        ["pixtral-large", "mistral"],
        ["codestral-latest", "mistral"],
        ["magistral-medium", "mistral"],
        ["devstral-small", "mistral"],
        ["ministral-8b", "mistral"],
        ["command-a-03-2025", "cohere"],
        ["rerank-v4.0", "cohere"],
        ["embed-v4.0", "cohere"],
        ["aya-expanse-32b", "cohere"],
        ["c4ai-command-r7b", "cohere"],
        ["whisper-1", "openai"],
        ["gpt-5.4", "openai"],
        ["o1", "openai"],
        ["o3-mini", "openai"],
        ["gpt-5.6-sol", "openai"],
        ["gpt-image-2", "openai"],
        ["gpt-audio-1.5", "openai"],
        ["tts-1-hd", "openai"],
        ["text-embedding-3-large", "openai"],
        ["gpt-oss-120b", "openai"],
        ["@cf/deepgram/flux", "deepgram"],
        ["nova-3", "deepgram"],
        ["aura-2-en", "deepgram"],
        ["eleven_flash_v2", "elevenlabs"],
        ["music_v1", "elevenlabs"],
        ["scribe_v2_realtime", "elevenlabs"],
        ["sonic-3.5", "cartesia"],
        ["roboflow/doctr/ocr", "roboflow"],
        ["bge-base-en-v1.5", "baai"],
        ["e5-large-v2", "microsoft"],
        ["stable-diffusion-xl", "stabilityai"],
        ["sdxl-lightning", "stabilityai"],
        ["sd3-large", "stabilityai"],
        ["stable-cascade", "stabilityai"],
        ["ltx-video", "lightricks"],
        ["kolors", "kuaishou"],
        ["hidream-i1", "hidream"],
        ["ideogram-v3", "ideogram"],
        ["recraft-v3", "recraft"],
        ["mochi-1", "genmo"],
        ["seedream-4.0", "bytedance"],
        ["doubao-seed-1.6", "bytedance"],
        ["firered-asr", "xiaohongshu"],
        ["longcat-flash", "meituan"],
        ["granite-4.0-h", "ibm"],
        ["ibm-granite/granite-4.0-h-micro", "ibm"],
        ["apertus-70b", "swissai"],
        ["eurollm-9b", "utter-project"],
        ["ai4bharat/indictrans2-en-indic-1b", "ai4bharat"],
        ["internvl-3", "shanghai-ai-lab"],
        ["intern-video2", "shanghai-ai-lab"],
        ["yi-large", "01ai"],
        ["dbrx-instruct", "databricks"],
        ["falcon-180b", "tii"],
        ["tulu-3-70b", "allenai"],
        ["olmo-2-1124", "allenai"],
        ["asi1-mini", "asicloud"],
        ["lucid-origin", "leonardo"],
        ["phoenix-1.0", "leonardo"],
        ["llava-1.5-7b-hf", "huggingface"],
        ["@cf/moondream/moondream3.1-9B-A2B", "moondream"],
        ["dreamshaper-8-lcm", "lykon"],
        ["plamo-embedding-1b", "pfnet"],
        ["playai-tts", "playht"],
        ["playht-v2", "playht"],
        ["arcee-nova", "arcee"],
        ["nous-hermes-2", "nousresearch"],
        ["hermes-3-llama", "nousresearch"],
        ["smolvlm2", "huggingface"],
        ["distilbert-sst-2-int8", "huggingface"],
        ["@cf/aisingapore/gemma-sea-lion-v4-27b-it", "aisingapore"],
        ["pipecat-ai/smart-turn-v2", "daily"],
        ["myshell-ai/melotts", "myshell"],
    ] as const;

    for (const [modelId, expected] of cases) {
        assert.equal(aggregateCanonicalFamily(modelId), expected, modelId);
    }
    assert.equal(aggregateCanonicalFamily("unlisted-model"), undefined);
});

test("music generation source types normalize to the catalog writer type", () => {
    const transformed = transformHuggingFaceModel({
        modelId: "music_v1",
        name: "music_v1",
        type: "music-generation",
        supportedDataTypes: {
            inputs: ["text"],
            outputs: ["audio"],
        },
    });

    assert.equal(transformed?.type, "music generation");
});

test("normalizePublicModelId strips upstream decorations into upstreamModelId", () => {
    const cases = [
        ["fireworks", "accounts/fireworks/models/kimi-k3", "kimi-k3"],
        ["cloudflare", "@cf/moonshotai/kimi-k2.6", "kimi-k2.6"],
        ["deepinfra", "meta-llama/llama-3.3-70b-instruct", "llama-3.3-70b-instruct"],
        ["asicloud", "google/gemma-3-27b-it", "gemma-3-27b-it"],
        ["alibaba", "ZHIPU/GLM-5.3", "GLM-5.3"],
        ["alibaba", "ZHIPU/GLM-5.2", "GLM-5.2"],
    ] as const;

    for (const [provider, decorated, clean] of cases) {
        const normalized = normalizePublicModelId(model({ provider, modelId: decorated }));
        assert.equal(normalized.modelId, clean, decorated);
        assert.equal(normalized.name, clean, decorated);
        assert.equal(normalized.upstreamModelId, decorated, decorated);
    }
});

test("normalizePublicModelId normalizes Fireworks p-notation to the canonical dot form", () => {
    const cases = [
        ["accounts/fireworks/models/glm-5p2", "glm-5.2"],
        ["accounts/fireworks/models/kimi-k2p7-code", "kimi-k2.7-code"],
        ["accounts/fireworks/models/qwen3p8-max", "qwen3.8-max"],
        ["accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b", "nemotron-lightning-3.5-30b-a3b"],
    ] as const;

    for (const [decorated, clean] of cases) {
        const normalized = normalizePublicModelId(model({ provider: "fireworks", modelId: decorated }));
        assert.equal(normalized.modelId, clean, decorated);
        assert.equal(normalized.upstreamModelId, decorated, decorated);
    }
    assert.equal(dotNotation("glm-5p2"), "glm-5.2");
    // Active-params markers (a3b, 235b) are not version dots.
    assert.equal(dotNotation("qwen3-235b-a22b"), "qwen3-235b-a22b");
});

test("normalizePublicModelId leaves clean and non-decorated provider IDs untouched", () => {
    const cases = [
        ["azure", "gpt-5.5"],
        ["alibaba", "qwen-max"],
        ["asicloud", "asi1-mini"],
        ["deepgram", "deepgram/aura-2-apollo-en"],
        ["roboflow", "roboflow/box"],
        ["openai", "gpt-5.5"],
    ] as const;

    for (const [provider, modelId] of cases) {
        const normalized = normalizePublicModelId(model({ provider, modelId }));
        assert.equal(normalized.modelId, modelId, modelId);
        assert.equal(normalized.upstreamModelId, undefined, modelId);
    }
});

test("dedupeModels keeps rows that share a cleaned slug but keep distinct upstream IDs", () => {
    const rows = dedupeModels([
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "qwen/qwen3-32b" })),
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "other/qwen3-32b" })),
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.upstreamModelId).sort(), ["other/qwen3-32b", "qwen/qwen3-32b"]);
});

test("collapseDuplicateModels merges same-model provider rows into one row with an ordered fallback chain", () => {
    const alibaba = model({ provider: "alibaba", modelId: "deepseek-v4-flash", family: "deepseek" });
    alibaba.capabilities = { chat_completion: true };
    const fireworks = normalizePublicModelId(model({ provider: "fireworks", modelId: "accounts/fireworks/models/deepseek-v4-flash", family: "deepseek" }));
    fireworks.capabilities = { responses: true };
    const rows = collapseDuplicateModels([alibaba, fireworks]);

    assert.equal(rows.length, 1);

    const [collapsed] = rows;
    assert.equal(collapsed?.modelId, "deepseek-v4-flash");
    assert.equal(collapsed?.provider, "fireworks"); // PROVIDER_PRIORITY winner
    assert.equal(collapsed?.upstreamModelId, "accounts/fireworks/models/deepseek-v4-flash");
    assert.deepEqual(collapsed?.providerRoutes?.map((route) => ({
        provider: route.provider,
        upstreamModelId: route.upstreamModelId,
        pricing: route.pricing,
    })), [
        { provider: "fireworks", upstreamModelId: "accounts/fireworks/models/deepseek-v4-flash", pricing: null },
        { provider: "alibaba", upstreamModelId: "deepseek-v4-flash", pricing: null },
    ]);
    assert.deepEqual(collapsed?.availableFrom, ["fireworks", "alibaba"]);
    assert.deepEqual(collapsed?.providerRoutes?.map((route) => route.capabilities), [
        { responses: true },
        { chat_completion: true },
    ]);
});

test("collapseDuplicateModels keeps the bare id for the priority winner and routes the loser", () => {
    const rows = collapseDuplicateModels([
        model({ provider: "azure", modelId: "gpt-5.5", family: "openai" }),
        model({ provider: "openai", modelId: "gpt-5.5", family: "openai" }),
    ]);

    assert.equal(rows.length, 1);

    const [collapsed] = rows;
    assert.equal(collapsed?.modelId, "gpt-5.5");
    assert.equal(collapsed?.provider, "azure");
    assert.deepEqual(collapsed?.providerRoutes?.map((route) => [route.provider, route.upstreamModelId]), [
        ["azure", "gpt-5.5"],
        ["openai", "gpt-5.5"],
    ]);
});

test("collapseDuplicateModels groups case and p-notation variants of the same model", () => {
    const rows = collapseDuplicateModels([
        model({ provider: "alibaba", modelId: "deepseek-v3.2", family: "deepseek" }),
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "deepseek-ai/DeepSeek-V3.2", family: "deepseek" })),
        normalizePublicModelId(model({ provider: "fireworks", modelId: "accounts/fireworks/models/deepseek-v3p2", family: "deepseek" })),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.provider, "fireworks");
    assert.deepEqual(rows[0]?.providerRoutes?.map((route) => route.provider), ["fireworks", "deepinfra", "alibaba"]);
    // Fireworks' wire id keeps the p-notation slug.
    assert.equal(rows[0]?.providerRoutes?.[0]?.upstreamModelId, "accounts/fireworks/models/deepseek-v3p2");
});

test("collapseDuplicateModels merges same-provider rows that arrive via distinct upstream paths", () => {
    const rows = collapseDuplicateModels([
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "qwen/qwen3-32b", family: "alibaba" })),
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "other/qwen3-32b", family: "alibaba" })),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.provider, "deepinfra");
    assert.equal(rows[0]?.providerRoutes?.length, 1);
});

test("collapseDuplicateModels fills missing winner fields from fallback providers", () => {
    const winner = normalizePublicModelId(model({ provider: "fireworks", modelId: "accounts/fireworks/models/merge-me", family: "deepseek" }));
    winner.pricing = null;
    winner.description = null;
    const fallback = model({ provider: "deepinfra", modelId: "merge-me", family: "deepseek" });
    fallback.pricing = { unit: "per_1M_tokens_usd", input: 0.1, output: 0.2 };
    fallback.description = "filled from deepinfra";

    const rows = collapseDuplicateModels([winner, fallback]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.description, "filled from deepinfra");
    assert.deepEqual(rows[0]?.pricing, { unit: "per_1M_tokens_usd", input: 0.1, output: 0.2 });
    // Per-route pricing preserves each provider's own prices.
    assert.deepEqual(rows[0]?.providerRoutes?.[1]?.pricing, { unit: "per_1M_tokens_usd", input: 0.1, output: 0.2 });
});

test("collapseDuplicateModels takes display name and description from the family's creator route", () => {
    const azureHost = model({ provider: "azure", modelId: "gpt-5.6-luna", family: "openai" });
    azureHost.name = "OpenAI gpt-5.6-luna";
    azureHost.description = "GPT‑5.6-luna is OpenAI's most capable frontier model, built to deliver faster, more reliable results for complex professional work.";
    const openaiCreator = model({ provider: "openai", modelId: "gpt-5.6-luna", family: "openai" });
    openaiCreator.name = "GPT-5.6 Luna";
    openaiCreator.description = "GPT-5.6 Luna is designed for cost-sensitive, high-volume workloads. It roughly corresponds to the nano model tier used in earlier GPT-5 families.";

    const [collapsed] = collapseDuplicateModels([azureHost, openaiCreator]);

    // Routing stays with the PROVIDER_PRIORITY winner (azure — its wire id
    // is the bare model id), but display metadata comes from the creator.
    assert.equal(collapsed?.provider, "azure");
    assert.equal(collapsed?.upstreamModelId, undefined);
    assert.equal(collapsed?.name, "GPT-5.6 Luna");
    assert.equal(collapsed?.description, openaiCreator.description);
    // The creator route keeps its own display copy for consumers that need it.
    const creatorRoute = collapsed?.providerRoutes?.find((route) => route.provider === "openai");
    assert.equal(creatorRoute?.name, "GPT-5.6 Luna");
    assert.equal(creatorRoute?.description, openaiCreator.description);
});

test("collapseDuplicateModels keeps hoster display fields when no same-family creator route exists", () => {
    const [collapsed] = collapseDuplicateModels([
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "deepseek-ai/DeepSeek-V4-Pro", family: "deepseek" })),
    ]);

    // No "deepseek" provider exists; the winner's fields stand.
    assert.equal(collapsed?.name, "DeepSeek-V4-Pro");
});

test("collapseDuplicateModels keeps distinct dated snapshots separate", () => {
    const rows = collapseDuplicateModels([
        model({ provider: "alibaba", modelId: "deepseek-v4-flash", family: "deepseek" }),
        model({ provider: "fireworks", modelId: "deepseek-v4-flash-0731", family: "deepseek" }),
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.modelId).sort(), ["deepseek-v4-flash", "deepseek-v4-flash-0731"]);
});

test("collapseDuplicateModels keeps genuine family collisions on one slug as separate models", () => {
    // deepgram `flux` is a realtime speech model; ClarityAI `flux` is an
    // image editor. Same bare slug, different models: no merge.
    const rows = collapseDuplicateModels([
        normalizePublicModelId(model({ provider: "cloudflare", modelId: "@cf/deepgram/flux", family: "deepgram" })),
        normalizePublicModelId(model({ provider: "deepinfra", modelId: "ClarityAI/flux", family: "clarityai" })),
    ]);

    assert.equal(rows.length, 2);

    const bare = rows.find((row) => row.modelId === "flux");
    const aliased = rows.find((row) => row.modelId === "clarityai/flux");
    assert.ok(bare, "priority winner keeps the bare slug");
    assert.ok(aliased, "the other family takes the family-qualified alias");
    assert.equal(bare?.provider, "cloudflare");
    assert.equal(bare?.family, "deepgram");
    assert.equal(bare?.upstreamModelId, "@cf/deepgram/flux");
    assert.equal(aliased?.provider, "deepinfra");
    assert.equal(aliased?.family, "clarityai");
    assert.equal(aliased?.upstreamModelId, "ClarityAI/flux");
});
