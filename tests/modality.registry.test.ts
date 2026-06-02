import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCard } from "../inference/types.js";
import {
  classifyModelCard,
  getModelCapabilities,
  getModalityOperations,
  isStreamableModality,
} from "../inference/catalog/modalities/index.js";
import { selectImageTaskForInput } from "../inference/catalog/modalities/image.js";
import {
  buildAIMLVideoSubmissionBody,
  buildGoogleVideoGenerationRequest,
  buildOpenAIVideoSubmissionBody,
  selectVideoTaskForInput,
  videoBillingMetricsFromOutput,
} from "../inference/catalog/modalities/video.js";
import { normalizeFeatureExtractionEmbeddings } from "../inference/catalog/modalities/embeddings.js";
import { getCompiledModels } from "../inference/catalog/registry.js";

function modelCard(overrides: Partial<ModelCard>): ModelCard {
  return {
    modelId: "test-model",
    name: "Test Model",
    provider: "openai",
    type: "chat-completions",
    description: null,
    input: ["text"],
    output: ["text"],
    contextWindow: null,
    pricing: null,
    ...overrides,
  };
}

test("modality classifier normalizes provider-specific task names to canonical ops", () => {
  const chat = classifyModelCard(modelCard({
    modelId: "gpt-4.1-mini",
    type: "chat-completions",
    input: ["text", "image"],
    output: ["text"],
  }));
  assert.equal(chat.modality, "text");
  assert.equal(chat.operation, "chat");
  assert.deepEqual(chat.input, ["text", "image"]);
  assert.deepEqual(chat.output, ["text"]);
  assert.equal(chat.streamable, true);
  assert.equal("meter" in chat, false);

  assert.equal(classifyModelCard(modelCard({
    modelId: "text-embedding-3-small",
    type: "embeddings",
    input: ["text"],
    output: ["text"],
  })).operation, "text-to-embedding");

  const multimodalEmbedding = classifyModelCard(modelCard({
    modelId: "gemini-embedding-2",
    type: "embeddings",
    input: ["text", "image", "video", "audio", "pdf"],
    output: ["text"],
  }));
  assert.equal(multimodalEmbedding.operation, "multimodal-embedding");
  assert.deepEqual(multimodalEmbedding.input, ["text", "image", "video", "audio"]);

  assert.equal(classifyModelCard(modelCard({
    modelId: "@cf/deepgram/aura-1",
    type: "text-to-speech",
    input: ["text", "audio"],
    output: ["audio"],
  })).operation, "text-to-speech");

  assert.equal(classifyModelCard(modelCard({
    modelId: "voice-designer",
    type: "text-to-speech",
    input: ["text"],
    output: ["audio"],
    pricing: {
      sections: [{
        unitKey: "per_voice_usd",
        unit: "Per voice",
        entries: { voice: 0.2 },
      }],
    },
  })).operation, "voice-design");

  assert.equal(classifyModelCard(modelCard({
    modelId: "image-edit-model",
    type: "image-to-image",
    input: ["text", "image"],
    output: ["image"],
  })).operation, "image-to-image");

  const videoEdit = classifyModelCard(modelCard({
    modelId: "video-edit-model",
    type: "video generation",
    input: ["image", "video"],
    output: ["video"],
  }));
  assert.equal(videoEdit.operation, "video-edit");
  assert.deepEqual(videoEdit.input, ["image", "video"]);
  assert.deepEqual(videoEdit.output, ["video"]);
});

function operations(modelId: string): Array<{ modality: string; operation: string }> {
  const model = getCompiledModels().models.find((entry) => entry.modelId === modelId);
  assert.ok(model, `${modelId} should be in the compiled catalog`);
  return getModelCapabilities(model).map((capability) => ({
    modality: capability.modality,
    operation: capability.operation,
  }));
}

test("realtime modality is catalog-native without stealing dual-mode REST operations", () => {
  assert.deepEqual(operations("gpt-realtime-1.5"), [
    { modality: "realtime", operation: "realtime-omni" },
  ]);

  assert.deepEqual(operations("qwen3-asr-flash-realtime"), [
    { modality: "realtime", operation: "realtime-transcription" },
  ]);

  assert.deepEqual(operations("scribe_v2_realtime"), [
    { modality: "realtime", operation: "realtime-transcription" },
  ]);

  const cloudflareTts = operations("@cf/deepgram/aura-1");
  assert.ok(cloudflareTts.some((entry) =>
    entry.modality === "audio" && entry.operation === "text-to-speech"
  ));
  assert.ok(cloudflareTts.some((entry) =>
    entry.modality === "realtime" && entry.operation === "realtime-speech"
  ));

  const cloudflareStt = operations("@cf/deepgram/nova-3");
  assert.ok(cloudflareStt.some((entry) =>
    entry.modality === "text" && entry.operation === "speech-to-text"
  ));
  assert.ok(cloudflareStt.some((entry) =>
    entry.modality === "realtime" && entry.operation === "realtime-transcription"
  ));

  assert.deepEqual(operations("@cf/deepgram/flux"), [
    { modality: "realtime", operation: "realtime-transcription" },
  ]);
});

test("speech umbrella models with text output stay text/omni instead of fake TTS", () => {
  const qwenOmni = operations("qwen-omni-turbo");
  assert.ok(qwenOmni.some((entry) =>
    entry.modality === "text" && entry.operation === "chat"
  ));
  assert.equal(qwenOmni.some((entry) =>
    entry.modality === "audio" && entry.operation === "text-to-speech"
  ), false);
});

test("modality catalog exposes canonical operation groups for integrators and agents", () => {
  const models = getCompiledModels().models;
  const operations = getModalityOperations(models);

  assert.ok(operations.some((entry) => entry.operation === "chat"));
  assert.ok(operations.some((entry) => entry.operation === "text-to-image"));
  assert.ok(operations.some((entry) => entry.operation === "text-to-video"));
  assert.ok(operations.some((entry) => entry.operation === "speech-to-text"));
  assert.ok(operations.some((entry) => entry.operation === "text-to-embedding"));
});

test("model capabilities expose source pricing units without flattening them", () => {
  const models = getCompiledModels().models;
  const tokenPricedImage = models.find((model) => model.modelId === "chatgpt-image-latest");
  const imagePricedImage = models.find((model) => model.modelId === "qwen-image");
  assert.ok(tokenPricedImage);
  assert.ok(imagePricedImage);

  const capabilities = [
    ...getModelCapabilities(tokenPricedImage),
    ...getModelCapabilities(imagePricedImage),
  ];
  const units = capabilities.flatMap((capability) => capability.pricingUnits.map((unit) => unit.unitKey));

  assert.ok(units.includes("usd_per_1m_tokens"));
  assert.ok(units.includes("usd_per_image"));
  assert.equal(capabilities.some((capability) => "meter" in capability), false);
});

test("streamable modality policy is explicit", () => {
  assert.equal(isStreamableModality("text"), true);
  assert.equal(isStreamableModality("image"), true);
  assert.equal(isStreamableModality("audio"), false);
  assert.equal(isStreamableModality("video"), false);
  assert.equal(isStreamableModality("embedding"), false);
  assert.equal(isStreamableModality("realtime"), true);
});

test("video modality shapes provider payloads without leaking shared params", () => {
  const options = {
    duration: 4,
    resolution: "720p",
    aspectRatio: "16:9",
    imageUrl: "https://example.com/frame.png",
    customParams: {
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "9:16",
      size: "1280x720",
      seed: 123,
    },
  };

  assert.deepEqual(buildOpenAIVideoSubmissionBody("sora-2", "camera pan", options), {
    model: "sora-2",
    prompt: "camera pan",
    size: "1280x720",
    seconds: "4",
    input_reference: { image_url: "https://example.com/frame.png" },
  });

  assert.deepEqual(buildAIMLVideoSubmissionBody("provider/video", "camera pan", options), {
    model: "provider/video",
    prompt: "camera pan",
    duration: "4",
    resolution: "720p",
    aspect_ratio: "16:9",
    size: "1280x720",
    seed: 123,
    image_url: "https://example.com/frame.png",
  });

  assert.deepEqual(buildGoogleVideoGenerationRequest("veo-3.1-fast-generate-preview", "camera pan", options), {
    model: "veo-3.1-fast-generate-preview",
    source: {
      prompt: "camera pan",
    },
    config: {
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "720p",
    },
  });
});

test("modality helpers select input operation from supplied attachments", () => {
  assert.equal(selectImageTaskForInput(undefined), "text-to-image");
  assert.equal(selectImageTaskForInput("https://example.com/image.png"), "image-to-image");
  assert.equal(selectVideoTaskForInput(undefined), "text-to-video");
  assert.equal(selectVideoTaskForInput("https://example.com/frame.png"), "image-to-video");
});

test("embedding modality accepts vector outputs without pooling token matrices", () => {
  assert.deepEqual(normalizeFeatureExtractionEmbeddings([0.1, 0.2]), [[0.1, 0.2]]);
  assert.deepEqual(normalizeFeatureExtractionEmbeddings([[0.1, 0.2], [0.3, 0.4]]), [[0.1, 0.2], [0.3, 0.4]]);
  assert.throws(
    () => normalizeFeatureExtractionEmbeddings([[[0.1], [0.2]]]),
    /unsupported embedding shape/i,
  );
});

function mp4Box(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

test("video modality derives billable quantities from generated media metadata", () => {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(4500, 16);
  const tkhd = Buffer.alloc(8);
  tkhd.writeUInt32BE(1280 * 65536, 0);
  tkhd.writeUInt32BE(720 * 65536, 4);
  const buffer = mp4Box("moov", Buffer.concat([
    mp4Box("mvhd", mvhd),
    mp4Box("trak", mp4Box("tkhd", tkhd)),
  ]));

  const metrics = videoBillingMetricsFromOutput({
    request: {
      mode: "responses",
      model: "video-model",
      stream: false,
      modality: "video",
      messages: [],
      responseId: "resp_video_media",
      billingMetrics: { request: 1 },
    },
    buffer,
    generatedUnits: 1,
  });

  assert.equal(metrics.second, 4.5);
  assert.equal(metrics.duration, 4.5);
  assert.equal(metrics.minute, 4.5 / 60);
  assert.equal(metrics.pixel, 1280 * 720);
  assert.equal(metrics.megapixel, (1280 * 720) / 1_000_000);
});

test("image modality derives billable quantities from generated WebP media metadata", async () => {
  const { imageBillingMetricsFromOutput } = await import("../inference/catalog/modalities/image.js");
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(639, 24, 3);
  webp.writeUIntLE(359, 27, 3);

  const metrics = imageBillingMetricsFromOutput({
    request: {
      mode: "responses",
      model: "image-model",
      stream: false,
      modality: "image",
      messages: [],
      responseId: "resp_webp_media",
    },
    buffer: webp,
    generatedUnits: 2,
  });

  assert.equal(metrics.pixel, 640 * 360 * 2);
  assert.equal(metrics.megapixel, (640 * 360 * 2) / 1_000_000);
});
