import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ModelCard } from "../inference/types.js";
import {
  aggregateCanonicalFamily,
  familyOf,
  getFamilyCatalog,
  normalizeFamily,
} from "../inference/catalog/families/index.js";

function card(parts: Partial<ModelCard> & { modelId: string; family?: string }): ModelCard {
  return {
    modelId: parts.modelId,
    name: parts.name ?? parts.modelId,
    provider: parts.provider ?? "cloudflare",
    type: parts.type ?? "text-generation",
    description: parts.description ?? null,
    input: parts.input ?? ["text"],
    output: parts.output ?? ["text"],
    contextWindow: parts.contextWindow ?? null,
    pricing: parts.pricing ?? null,
    ...(parts.family !== undefined ? { family: parts.family } : {}),
    ...(parts.semantics !== undefined ? { semantics: parts.semantics } : {}),
  };
}

test("familyOf reads only the first-class model family field", () => {
  assert.equal(familyOf(card({
    modelId: "@cf/google/gemma-7b-it-lora",
    provider: "cloudflare",
    family: "Google",
    semantics: { family: "cloudflare" },
  })), "google");

  assert.equal(familyOf(card({
    modelId: "gpt-test",
    provider: "openai",
    semantics: { family: "openai" },
  })), null);
});

test("family catalog is scalar-only identity and model counts", () => {
  const catalog = getFamilyCatalog([
    card({ modelId: "gpt-5.3", family: "OpenAI" }),
    card({ modelId: "gpt-5.3-mini", family: "openai" }),
    card({ modelId: "@cf/deepgram/flux", family: "Deepgram" }),
    card({ modelId: "missing-family" }),
  ]);

  assert.deepEqual(catalog, [
    { family: "deepgram", modelCount: 1 },
    { family: "openai", modelCount: 2 },
  ]);
  assert.equal("capabilities" in catalog[0], false);
  assert.equal("operations" in catalog[0], false);
  assert.equal("pricingUnits" in catalog[0], false);
  assert.equal("sourceTypes" in catalog[0], false);
});

test("family normalizer emits scalar slugs", () => {
  assert.equal(normalizeFamily("OpenAI"), "openai");
  assert.equal(normalizeFamily("Z.AI / formerly Zhipu"), "z-ai-formerly-zhipu");
  assert.equal(normalizeFamily(""), null);
  assert.equal(normalizeFamily(null), null);
});

test("canonical family rules cover hosted owner namespaces and provider-native utilities", () => {
  assert.equal(aggregateCanonicalFamily("Ling-3.0-flash", "Ling 3.0 Flash"), "inclusionai");
  assert.equal(aggregateCanonicalFamily("inclusionAI/Ling-3.0-flash"), "inclusionai");
  assert.equal(aggregateCanonicalFamily("voice-enrollment"), "alibaba");
});

test("compiled catalog has first-class family for every active model", () => {
  const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), "inference", "data", "models.json"), "utf8")) as { models: ModelCard[] };
  const missing = data.models
    .filter((model) => !familyOf(model))
    .map((model) => `${model.provider}:${model.modelId}`);

  assert.deepEqual(missing, []);
});

test("compiled catalog reads model family from the canonical aggregator", () => {
  const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), "inference", "data", "models.json"), "utf8")) as { models: ModelCard[] };
  const byId = new Map(data.models.flatMap((model) => [
    [model.modelId, model],
    ...(model.upstreamModelId ? [[model.upstreamModelId, model] as const] : []),
    ...(Array.isArray(model.providerRoutes)
      ? model.providerRoutes.flatMap((route) => [[route.upstreamModelId, model] as const])
      : []),
  ]));

    const cases = [
        ["qwen-max", "alibaba"],
        ["cosyvoice-v3-flash", "alibaba"],
        ["wan2.1-t2i-plus", "alibaba"],
        ["DeepSeek-V3.2", "deepseek"],
        ["Cohere-rerank-v4.0-fast", "cohere"],
        ["gpt-5.4", "openai"],
        ["chat-latest", "openai"],
        ["omni-moderation-latest", "openai"],
        ["gemini-3.1-flash-lite", "google"],
        ["@cf/deepgram/flux", "deepgram"],
        ["@cf/baai/bge-base-en-v1.5", "baai"],
        ["@cf/black-forest-labs/flux-1-schnell", "blackforestlabs"],
        ["sonic-3.5-2026-05-04", "cartesia"],
        ["roboflow/doctr/ocr", "roboflow"],
        ["thinkingmachines/Inkling", "thinkingmachines"],
    ] as const;

  for (const [modelId, expected] of cases) {
    const model = byId.get(modelId);
    assert.ok(model, `missing ${modelId}`);
    assert.equal(familyOf(model), expected, modelId);
  }
});
