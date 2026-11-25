import assert from "node:assert/strict";
import test from "node:test";

import { getCompiledModels, getModelById, resolveModel, searchModels } from "../inference/adapters/registry.js";
import { isProvider, PROVIDERS } from "../inference/types.js";

test("provider registry covers every compiled catalog provider", () => {
  const providers = new Set(PROVIDERS);
  const unknown = new Set(
    getCompiledModels().models
      .map((model) => model.provider)
      .filter((provider) => !providers.has(provider)),
  );

  assert.deepEqual([...unknown].sort(), []);
});

test("resolveModel requires catalog model identity", () => {
  assert.throws(
    () => resolveModel("future-aiml-model"),
    /Model not found: future-aiml-model/,
  );
});

test("provider wire ids resolve to their serving route", () => {
  assert.equal(getModelById("@cf/zai-org/glm-5.2")?.provider, "cloudflare");
  assert.equal(getModelById("accounts/fireworks/models/glm-5p2")?.provider, "fireworks");
  assert.equal(getModelById("zai-org/GLM-5.2")?.provider, "deepinfra");
});

test("provider filtering includes secondary serving routes without duplicating models", () => {
  const result = searchModels({ provider: "openai", q: "gpt-5.5" });
  assert.equal(result.data.filter((model) => model.modelId === "gpt-5.5").length, 1);
});

test("compiled catalog excludes deprecated OpenAI Sora models", () => {
  const ids = new Set(getCompiledModels().models.map((model) => model.modelId));

  assert.equal(ids.has("sora-2"), false);
  assert.equal(ids.has("sora-2-pro"), false);
});

test("compiled ElevenLabs music pricing uses generated audio minute evidence", () => {
  const music = resolveModel("music_v1");
  const pricing = music.card?.pricing as { sections?: Array<{ unitKey?: string; entries?: Record<string, number> }> } | undefined;
  const sections = pricing?.sections || [];

  assert.ok(sections.length > 0);
  assert.ok(sections.every((section) => section.unitKey === "usd_per_generated_audio_minute"));
  assert.ok(sections.every((section) => typeof section.entries?.generated_audio_minute === "number" && section.entries.generated_audio_minute > 0));
});

test("compiled Roboflow catalog excludes volatile registry-only rows", () => {
  const ids = new Set(getCompiledModels().models.map((model) => model.modelId));

  assert.equal(ids.has("roboflow/cacao-woord/6"), false);
  assert.equal(ids.has("roboflow/infer/lmm"), false);
  assert.equal(ids.has("roboflow/rfdetr-small"), true);
});

test("compiled Roboflow SAM2 follows OpenAPI image-id response shape", () => {
  const sam2 = getCompiledModels().models.find((model) => model.modelId === "roboflow/sam2/embed-image");
  const sam = getCompiledModels().models.find((model) => model.modelId === "roboflow/sam/embed-image");

  assert.equal(sam?.type, "embeddings");
  assert.deepEqual(sam?.output, ["embedding_vector"]);
  assert.equal(sam2?.type, "image-segmentation");
  assert.deepEqual(sam2?.output, ["json"]);
});
