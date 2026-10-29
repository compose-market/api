import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateCanonicalFamily } from "../inference/catalog/families/index.js";
import { cloudflareInputSchemasToParams } from "../inference/scripts/sync-cf.js";
import { schemaVariantKey, transformDeepInfraSchema } from "../inference/scripts/sync-deepinfra.js";
import { buildGeminiGenParamsFromDiscovery } from "../inference/scripts/sync-gemini.js";
import { mergeParamDefinitions, schemaToParamDefinitions } from "../inference/scripts/schema-params.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test("generated catalogs retain upstream-derived family identity", () => {
  for (const relativePath of ["../inference/data/models.json", "../inference/data/modalities/image.json"]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(testDirectory, relativePath), "utf8")) as {
      models: Array<{ family?: string; upstreamModelId?: string }>;
    };
    const clarityFlux = catalog.models.find((model) => model.upstreamModelId === "ClarityAI/flux");
    assert.equal(clarityFlux?.family, "clarityai", relativePath);
  }
});

test("Janus models are synchronized as native vision chat rather than image generation", () => {
  const imageCatalog = JSON.parse(fs.readFileSync(path.join(testDirectory, "../inference/data/modalities/image.json"), "utf8")) as {
    models: Array<{ modelId: string }>;
  };
  const textCatalog = JSON.parse(fs.readFileSync(path.join(testDirectory, "../inference/data/modalities/text.json"), "utf8")) as {
    models: Array<{ modelId: string; input?: string[]; output?: string[]; semantics?: { capabilities?: Array<{ operation?: string }> } }>;
  };
  const operations = (modelId: string) => {
    const model = textCatalog.models.find((candidate) => candidate.modelId === modelId);
    const capabilities = Array.isArray(model?.semantics?.capabilities) ? model.semantics.capabilities : [];
    return [...new Set(capabilities.map((capability) => capability?.operation).filter((operation): operation is string => typeof operation === "string"))].sort();
  };

  for (const modelId of ["Janus-Pro-1B", "Janus-Pro-7B"]) {
    assert.equal(imageCatalog.models.some((model) => model.modelId === modelId), false);
    const model = textCatalog.models.find((candidate) => candidate.modelId === modelId);
    if (model) {
      assert.deepEqual(model?.input, ["image", "text"]);
      assert.deepEqual(model?.output, ["text"]);
      assert.ok(operations(modelId).includes("vision-chat"));
    }
  }
});

test("image catalogs distinguish required source images from optional references", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(testDirectory, "../inference/data/modalities/image.json"), "utf8")) as {
    models: Array<{ modelId: string; capabilities?: { requires_image_input?: boolean }; semantics?: { capabilities?: Array<{ operation?: string }> } }>;
  };
  const operations = (modelId: string) => {
    const model = catalog.models.find((candidate) => candidate.modelId === modelId);
    const capabilities = Array.isArray(model?.semantics?.capabilities) ? model.semantics.capabilities : [];
    return [...new Set(capabilities.map((capability) => capability?.operation).filter((operation): operation is string => typeof operation === "string"))].sort();
  };

  const required = [
    "Ming-Image-0.1-Design-Layer",
    "qwen-image-edit",
    "qwen-image-edit-max-2026-01-16",
    "qwen-image-edit-plus",
    "qwen-image-edit-plus-2025-10-30",
    "qwen-image-edit-plus-2025-12-15",
    "wan2.5-i2i-preview",
    "stable-diffusion-v1-5-inpainting",
    "clarityai/flux",
    "blur_background",
    "enhance",
    "erase",
    "erase_foreground",
    "expand",
    "fibo_edit",
    "gen_fill",
    "remove_background",
    "replace_background",
    "creative",
    "crystal",
    "p-image-Edit",
    "Qwen-Image-Edit-Max",
    "Wan2.6-Image-Edit",
  ].sort();
  const flagged = catalog.models
    .filter((model) => model.capabilities?.requires_image_input === true)
    .map((model) => model.modelId)
    .sort();
  assert.deepEqual(flagged, required);

  for (const modelId of [
    "stable-diffusion-v1-5-inpainting",
    flagged.includes("Qwen-Image-Edit") ? "Qwen-Image-Edit" : "qwen-image-edit",
    "Qwen-Image-Edit-Max",
    "wan2.5-i2i-preview",
  ]) {
    assert.deepEqual(operations(modelId), ["image-to-image"], modelId);
  }

  for (const modelId of ["gpt-image-2", "gemini-2.5-flash-image", "MAI-Image-2.5"]) {
    assert.deepEqual(operations(modelId), ["image-to-image", "text-to-image"], modelId);
  }
  assert.deepEqual(operations("Wan2.7-Image-Edit"), ["image-to-image", "text-to-image"]);
});

test("family derivation gives synchronized upstream identity precedence over a public flux slug", () => {
  assert.equal(aggregateCanonicalFamily("ClarityAI/flux", "Flux"), "clarityai");
  assert.equal(aggregateCanonicalFamily("@cf/deepgram/flux", "Flux"), "deepgram");
  assert.equal(aggregateCanonicalFamily("flux", "Flux"), "blackforestlabs");
});

test("DeepInfra uses native media variants and derives required params and modalities from their schemas", () => {
  assert.equal(schemaVariantKey("text-to-image"), "default");
  assert.equal(schemaVariantKey("text-to-image", ["openai"]), "openai-images");

  const transformed = transformDeepInfraSchema({
    variant: { key: "default", url: "/models/ClarityAI/flux/schema/default" },
    schema_in: {
      type: "object",
      required: ["image", "conditioning"],
      properties: {
        image: { type: "string", format: "uri", description: "URL to the input image" },
        prompt: { type: "string", description: "Optional text prompt" },
        scale_factor: { type: "integer", default: 2, minimum: 2, maximum: 16 },
        conditioning: {
          type: "object",
          required: ["mask"],
          properties: {
            mask: {
              type: "array",
              minItems: 1,
              items: { type: "integer", minimum: 0, maximum: 255 },
            },
            strength: { type: "number", default: 0, minimum: 0, maximum: 1 },
          },
        },
      },
    },
    schema_out: {
      type: "object",
      required: ["image_url"],
      properties: {
        image_url: { type: "string", format: "uri" },
      },
    },
  }, "text-to-image");

  assert.deepEqual(new Set(transformed.supportedDataTypes.inputs), new Set(["image", "text"]));
  assert.deepEqual(transformed.supportedDataTypes.outputs, ["image"]);
  assert.equal(transformed.params.image?.required, true);
  assert.equal(transformed.params.scale_factor?.default, 2);
  assert.equal(transformed.params.scale_factor?.minimum, 2);
  assert.equal(transformed.params.scale_factor?.maximum, 16);
  assert.equal(transformed.params.conditioning?.required, true);
  assert.equal(transformed.params.conditioning?.properties?.mask?.required, true);
  assert.equal(transformed.params.conditioning?.properties?.mask?.items?.type, "integer");
  assert.equal(transformed.params.conditioning?.properties?.strength?.default, 0);
  assert.deepEqual(transformed.variant, {
    key: "default",
    url: "/models/ClarityAI/flux/schema/default",
  });
});

test("Cloudflare input schemas become ParamDefinition entries with exact types, defaults, and bounds", () => {
  const params = cloudflareInputSchemasToParams([{
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 2048 },
      steps: { type: "integer", default: 4, minimum: 1, maximum: 8 },
      guidance: { type: "number", default: 0 },
      enabled: { type: "boolean", default: false },
    },
  }]);

  assert.deepEqual(params.prompt, { type: "string", required: true, minLength: 1, maxLength: 2048 });
  assert.deepEqual(params.steps, { type: "integer", required: false, default: 4, minimum: 1, maximum: 8 });
  assert.equal(params.guidance?.default, 0);
  assert.equal(params.enabled?.default, false);
  assert.equal("input" in params, false);
  assert.equal("schemaUrls" in params, false);
});

test("schema conversion rejects contradictory source definitions", () => {
  assert.throws(() => schemaToParamDefinitions({
    type: "object",
    properties: { steps: { type: "integer", default: "four" } },
  }), /default does not match integer/);
  assert.throws(() => schemaToParamDefinitions({
    type: "object",
    properties: { steps: { type: "integer", minimum: 8, maximum: 1 } },
  }), /minimum 8 exceeds maximum 1/);
  assert.throws(() => mergeParamDefinitions([
    { steps: { type: "integer", required: false } },
    { steps: { type: "number", required: false } },
  ]), /Inconsistent definitions/);
});

test("schema conversion preserves authoritative union types", () => {
  assert.deepEqual(schemaToParamDefinitions({
    type: "object",
    properties: {
      image: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } },
        ],
      },
    },
  }).image, {
    type: ["string", "array"],
    required: false,
  });
});

test("schema conversion preserves top-level request alternatives", () => {
  assert.deepEqual(schemaToParamDefinitions({
    oneOf: [
      {
        type: "object",
        required: ["audio"],
        properties: { audio: { type: "array" }, language: { type: "string" } },
      },
      {
        type: "object",
        required: ["audio_b64"],
        properties: { audio_b64: { type: "string" }, language: { type: "string" } },
      },
    ],
  }), {
    audio: { type: "array", required: false },
    language: { type: "string", required: false },
    audio_b64: { type: "string", required: false },
  });
});

test("Gemini image params retain only image config reachable from the model operation", () => {
  const discovery = {
    resources: {
      models: {
        methods: {
          generateContent: { request: { $ref: "GenerateContentRequest" } },
          predict: { request: { $ref: "PredictRequest" } },
        },
      },
    },
    schemas: {
      GenerateContentRequest: {
        type: "object",
        properties: { generationConfig: { $ref: "GenerationConfig" } },
      },
      GenerationConfig: {
        type: "object",
        properties: {
          temperature: { type: "number" },
          imageConfig: { $ref: "ImageConfig" },
          speechConfig: { $ref: "SpeechConfig" },
        },
      },
      ImageConfig: {
        type: "object",
        properties: {
          aspectRatio: { type: "string", enum: ["1:1", "16:9"] },
          imageSize: { type: "string", default: "1K" },
        },
      },
      SpeechConfig: {
        type: "object",
        properties: { languageCode: { type: "string" } },
      },
      ImageResponseFormat: {
        type: "object",
        properties: { mimeType: { type: "string" } },
      },
      PredictRequest: {
        type: "object",
        properties: {
          instances: { type: "array" },
          parameters: { type: "object" },
        },
      },
    },
  };

  const contentParams = buildGeminiGenParamsFromDiscovery(
    discovery,
    "gemini-2.5-flash-image",
    "text-to-image",
    ["generateContent"],
  );
  assert.deepEqual(contentParams, {
    aspectRatio: { type: "string", required: false, options: ["1:1", "16:9"] },
    imageSize: { type: "string", required: false, default: "1K" },
  });
  assert.equal(buildGeminiGenParamsFromDiscovery(
    discovery,
    "imagen-4.0-generate-001",
    "text-to-image",
    ["predict"],
  ), undefined);
});

test("Gemini text-generation params retain GenerationConfig and ThinkingConfig without flattening Schema, ImageConfig, SpeechConfig, or ResponseFormatConfig", () => {
  const discovery = {
    resources: {
      models: {
        methods: {
          generateContent: { request: { $ref: "GenerateContentRequest" } },
        },
      },
    },
    schemas: {
      GenerateContentRequest: {
        id: "GenerateContentRequest",
        type: "object",
        properties: { generationConfig: { $ref: "GenerationConfig" } },
      },
      GenerationConfig: {
        id: "GenerationConfig",
        type: "object",
        properties: {
          temperature: { type: "number", description: "Controls randomness." },
          topP: { type: "number" },
          topK: { type: "integer" },
          maxOutputTokens: { type: "integer" },
          mediaResolution: {
            type: "string",
            enum: ["MEDIA_RESOLUTION_UNSPECIFIED", "MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_HIGH"],
          },
          _responseJsonSchema: { type: "any", deprecated: true },
          responseJsonSchema: { type: "any", description: "Internal detail." },
          responseSchema: { $ref: "Schema", deprecated: true },
          thinkingConfig: { $ref: "ThinkingConfig" },
          imageConfig: { $ref: "ImageConfig" },
          speechConfig: { $ref: "SpeechConfig" },
          responseFormat: { $ref: "ResponseFormatConfig" },
        },
      },
      ThinkingConfig: {
        id: "ThinkingConfig",
        type: "object",
        properties: {
          thinkingLevel: {
            type: "string",
            enum: ["THINKING_LEVEL_UNSPECIFIED", "LOW", "HIGH"],
          },
          includeThoughts: { type: "boolean" },
          thinkingBudget: { type: "integer" },
        },
      },
      Schema: {
        id: "Schema",
        type: "object",
        properties: {
          title: { type: "string" },
          maxLength: { type: "string" },
          enum: { type: "array" },
        },
      },
      ImageConfig: {
        id: "ImageConfig",
        type: "object",
        properties: {
          aspectRatio: { type: "string", enum: ["1:1", "16:9"] },
          imageSize: { type: "string", default: "1K" },
        },
      },
      SpeechConfig: {
        id: "SpeechConfig",
        type: "object",
        properties: {
          languageCode: { type: "string" },
        },
      },
      ResponseFormatConfig: {
        id: "ResponseFormatConfig",
        type: "object",
        properties: {
          audio: { $ref: "AudioResponseFormat" },
          text: { $ref: "TextResponseFormat" },
        },
      },
      AudioResponseFormat: {
        id: "AudioResponseFormat",
        type: "object",
        properties: {
          mimeType: { type: "string", enum: ["AUDIO_MP3", "AUDIO_WAV"] },
          bitRate: { type: "integer" },
        },
      },
      TextResponseFormat: {
        id: "TextResponseFormat",
        type: "object",
        properties: {
          mimeType: { type: "string", enum: ["APPLICATION_JSON", "TEXT_PLAIN"] },
        },
      },
    },
  };

  const textParams = buildGeminiGenParamsFromDiscovery(
    discovery,
    "gemini-2.5-flash",
    "text-generation",
    ["generateContent"],
    {
      apiModel: {
        temperature: 1,
        maxTemperature: 2,
        topP: 0.95,
        topK: 64,
        outputTokenLimit: 65536,
        thinking: true,
      },
    },
  );

  assert.deepEqual(textParams, {
    temperature: { type: "number", required: false, description: "Controls randomness.", default: 1, minimum: 0, maximum: 2 },
    topP: { type: "number", required: false, default: 0.95, minimum: 0, maximum: 1 },
    topK: { type: "integer", required: false, default: 64, minimum: 1 },
    maxOutputTokens: { type: "integer", required: false, minimum: 1, maximum: 65536 },
    mediaResolution: { type: "string", required: false, options: ["MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_HIGH"] },
    thinkingLevel: { type: "string", required: false, options: ["LOW", "HIGH"] },
    includeThoughts: { type: "boolean", required: false },
    thinkingBudget: { type: "integer", required: false },
  });
});
