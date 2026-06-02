import test from "node:test";
import assert from "node:assert/strict";

import { aggregateCanonicalFamily, dedupeModels, type NormalizedModel } from "../inference/scripts/sync-models.js";

function model(parts: {
    provider?: string;
    modelId?: string;
    resource?: string;
    capacity?: number;
    state?: string;
}): NormalizedModel {
    return {
        name: parts.modelId ?? "gpt-4o",
        modelId: parts.modelId ?? "gpt-4o",
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
        ["wan2.1-t2i-plus", "alibaba"],
        ["cosyvoice-v3-flash", "alibaba"],
        ["paraformer-realtime-v2", "alibaba"],
        ["gte-rerank-v2", "alibaba"],
        ["fun-asr-2025-11-07", "alibaba"],
        ["qvq-max", "alibaba"],
        ["tongyi-embedding-vision-plus", "alibaba"],
        ["z-image-turbo", "alibaba"],
        ["happyhorse-1.0-t2v", "happyhorse"],
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
        ["o4-mini-deep-research", "openai"],
        ["dall-e-3", "openai"],
        ["sora-2", "openai"],
        ["chatgpt-image-latest", "openai"],
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
        ["llava-1.5-7b-hf", "llava-hf"],
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
        ["pipecat-ai/smart-turn-v2", "pipecat"],
        ["myshell-ai/melotts", "myshell"],
    ] as const;

    for (const [modelId, expected] of cases) {
        assert.equal(aggregateCanonicalFamily(modelId), expected, modelId);
    }
    assert.equal(aggregateCanonicalFamily("unlisted-model"), undefined);
});
