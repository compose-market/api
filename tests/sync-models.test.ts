import test from "node:test";
import assert from "node:assert/strict";

import {
    selectPopularHFModels,
    transformHuggingFaceModel,
} from "../inference/scripts/sync-models.js";

test("transformHuggingFaceModel preserves the exact hf values under the normalized keys", () => {
    const raw = {
        modelId: "Qwen/Qwen3.5-35B-A3B",
        name: "Qwen3.5-35B-A3B",
        description: "Native vision-language model",
        type: "image-text-to-text",
        task: "conversational",
        modality: "text",
        contextLength: 262144,
        contextWindow: {
            inputTokens: 262144,
            outputTokens: 65536,
        },
        prices: {
            unit: "usd_per_1m_tokens",
            values: {
                input: 0.25,
                output: 2,
            },
        },
        supportedDataTypes: {
            inputs: ["text", "image", "video"],
            outputs: ["text"],
        },
    };

    const model = transformHuggingFaceModel(raw);

    assert.deepEqual(model, {
        name: "Qwen3.5-35B-A3B",
        modelId: "Qwen/Qwen3.5-35B-A3B",
        description: "Native vision-language model",
        type: "image-text-to-text",
        provider: "hugging face",
        input: ["text", "image", "video"],
        output: ["text"],
        contextWindow: {
            inputTokens: 262144,
            outputTokens: 65536,
        },
        pricing: {
            unit: "usd_per_1m_tokens",
            values: {
                input: 0.25,
                output: 2,
            },
        },
    });
});

test("selectPopularHFModels keeps non-HF rows and takes the top live-trending HF rows per exact category", () => {
    const makeHF = (modelId: string): {
        name: string;
        modelId: string;
        description: string | null;
        type: string;
        provider: string;
        input: string[];
        output: string[];
        contextWindow: number;
        pricing: { unit: string; values: { input: number; output: number } };
    } => ({
        name: modelId,
        modelId,
        description: null,
        type: "text-generation",
        provider: "hugging face",
        input: ["text"],
        output: ["text"],
        contextWindow: 128000,
        pricing: { unit: "usd_per_1m_tokens", values: { input: 1, output: 1 } },
    });

    const models = [
        makeHF("org/model-a"),
        makeHF("org/model-b"),
        {
            ...makeHF("org/model-c"),
            type: "image-to-image",
            input: ["image"],
            output: ["image"],
        },
        makeHF("org/model-d"),
        {
            name: "GPT-4o mini",
            modelId: "openai/gpt-4o-mini",
            description: null,
            type: "text-generation",
            provider: "openai",
            input: ["text"],
            output: ["text"],
            contextWindow: 128000,
            pricing: { unit: "usd_per_1m_tokens", values: { input: 0.15, output: 0.6 } },
        },
    ];

    const categories = new Map([
        ["org/model-a", { type: "text-generation", task: "conversational", modality: "text" }],
        ["org/model-b", { type: "text-generation", task: "conversational", modality: "text" }],
        ["org/model-c", { type: "image-to-image", task: "image-editing", modality: "image" }],
        ["org/model-d", { type: "text-generation", task: "conversational", modality: "text" }],
    ]);

    const trendingScores = new Map<string, number>([
        ["org/model-b", 900],
        ["org/model-a", 800],
        ["org/model-c", 700],
    ]);

    const selected = selectPopularHFModels(models, categories, trendingScores, 1);

    assert.deepEqual(
        selected.map(model => model.modelId),
        ["openai/gpt-4o-mini", "org/model-c", "org/model-b"],
    );
});
