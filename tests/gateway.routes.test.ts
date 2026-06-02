import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  normalizeAudioTranscriptionFile,
  normalizeChatRequest,
  normalizeResponsesRequest,
  toChatCompletionsResponse,
  toChatStreamEvent,
  toChatUsageStreamEvent,
  toResponsesOutputItems,
  toResponsesStreamEvent,
} from "../inference/core.js";
import { resolve as resolveInferenceRequest } from "../inference/engine.js";
import { getModelById, searchModels } from "../inference/catalog/registry.js";
import { getModelCapabilities } from "../inference/catalog/modalities/index.js";
import { resolveModelParams } from "../inference/params-handler.js";

const TEXT_MODEL_ID = "gpt-4o";
const TEXT_MODEL_PROVIDER = "azure";
const EMBEDDING_MODEL_ID = "text-embedding-3-small";
const IMAGE_EMBEDDING_MODEL_ID = "roboflow/clip/embed-image";
const AUDIO_MODEL_ID = "@cf/deepgram/aura-1";
const STT_MODEL_ID = "qwen3-asr-flash";
const IMAGE_ANALYSIS_MODEL_ID = "roboflow/rfdetr-base";
const RERANK_MODEL_ID = "qwen3-rerank";

const ORIGINAL_ENV = {
  THIRDWEB_SECRET_KEY: process.env.THIRDWEB_SECRET_KEY,
  THIRDWEB_SERVER_WALLET_ADDRESS: process.env.THIRDWEB_SERVER_WALLET_ADDRESS,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  DEPLOYER_KEY: process.env.DEPLOYER_KEY,
};

async function withInferenceServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  process.env.THIRDWEB_SECRET_KEY = ORIGINAL_ENV.THIRDWEB_SECRET_KEY || "test-thirdweb-secret";
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS =
    ORIGINAL_ENV.THIRDWEB_SERVER_WALLET_ADDRESS || "0x1111111111111111111111111111111111111111";
  process.env.MERCHANT_WALLET_ADDRESS =
    ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  process.env.DEPLOYER_KEY = ORIGINAL_ENV.DEPLOYER_KEY || `0x${"11".repeat(32)}`;
  const { registerInferenceRoutes } = await import("../inference/gateway.js");
  const app = express();
  app.use(express.json());
  registerInferenceRoutes(app);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await run(baseUrl);
  } finally {
    process.env.THIRDWEB_SECRET_KEY = ORIGINAL_ENV.THIRDWEB_SECRET_KEY;
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = ORIGINAL_ENV.THIRDWEB_SERVER_WALLET_ADDRESS;
    process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS;
    process.env.DEPLOYER_KEY = ORIGINAL_ENV.DEPLOYER_KEY;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test("registerInferenceRoutes serves /v1 models directly", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await withInferenceServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/models`);
      assert.equal(response.status, 200);

      const body = await response.json() as { object: string; data: Array<Record<string, unknown>> };
      assert.equal(body.object, "list");
      assert.ok(Array.isArray(body.data));
      assert.ok(body.data.length > 0);

      const model = body.data.find((entry) => entry.modelId === TEXT_MODEL_ID);
      assert.ok(model);
      assert.equal(model.modelId, TEXT_MODEL_ID);
      assert.equal(model.provider, TEXT_MODEL_PROVIDER);
      assert.equal(model.type, "text generation");
      assert.deepEqual(model.input, ["text", "image", "audio"]);
      assert.deepEqual(model.output, ["text"]);
      assert.ok(model.contextWindow);
      assert.ok(model.pricing);
      assert.ok(Array.isArray(model.operations));
      assert.ok(model.operations.some((operation) => {
        const entry = operation as Record<string, unknown>;
        return entry.modality === "text"
          && entry.operation === "chat"
          && Array.isArray(entry.input)
          && Array.isArray(entry.output);
      }));
      assert.equal("id" in model, false);
      assert.equal("task_type" in model, false);
      assert.equal("context_window" in model, false);
      assert.equal("input_modalities" in model, false);
      assert.equal("output_modalities" in model, false);
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(
    warnings.some((warning) => warning.includes("[genai]") || warning.includes("[openai]") || warning.includes("[huggingface]") || warning.includes("[vertex]") || warning.includes("[fireworks]") || warning.includes("[cloudflare]")),
    false,
  );
});

test("registerInferenceRoutes serves canonical /v1/models/:model rows", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(TEXT_MODEL_ID)}`);
    assert.equal(response.status, 200);

    const model = await response.json() as Record<string, unknown>;
    assert.equal(model.modelId, TEXT_MODEL_ID);
    assert.equal(model.provider, TEXT_MODEL_PROVIDER);
    assert.equal(model.type, "text generation");
    assert.ok(Array.isArray(model.operations));
    assert.ok((model.operations as Array<Record<string, unknown>>).some((operation) =>
      operation.modality === "text" && operation.operation === "chat"
    ));
    assert.equal("id" in model, false);
    assert.equal("task_type" in model, false);
    assert.equal("context_window" in model, false);
  });
});

test("registerInferenceRoutes keeps model execution on public paid v1 routes", async () => {
  const { INFERENCE_ROUTES } = await import("../inference/gateway.js");
  const routes = new Set(INFERENCE_ROUTES.map((route) => `${route.method} ${route.path}`));

  assert.equal(routes.has("POST /v1/responses"), true);
  assert.equal(routes.has("POST /v1/chat/completions"), true);
  assert.equal(routes.has("POST /v1/generateWithTools"), false);
  assert.equal(routes.has("POST /v1/streamWithTools"), false);

  await withInferenceServer(async (baseUrl) => {
    for (const path of ["/v1/generateWithTools", "/v1/streamWithTools"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: TEXT_MODEL_ID }),
      });

      assert.equal(response.status, 404);
    }
  });
});

test("registerInferenceRoutes does not own /health", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 404);
  });
});

test("registerInferenceRoutes issues a 402 upto challenge with default envelope for token-metered requests when no compose key or cap is configured", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "421614",
      },
      body: JSON.stringify({
        model: TEXT_MODEL_ID,
        input: [{ role: "user", content: "hello" }],
        modalities: ["text"],
        stream: false,
      }),
    });

    assert.equal(response.status, 402);
    assert.equal(typeof response.headers.get("payment-required"), "string");

    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    assert.equal(paymentRequired.accepts[0]?.scheme, "upto");
    assert.equal(paymentRequired.accepts[0]?.network, "eip155:421614");
    // Default envelope is 1 USDC (1_000_000 atomic units)
    assert.equal(paymentRequired.accepts[0]?.amount, "1000000");
  });
});

test("registerInferenceRoutes challenges chat completions before provider execution", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await withInferenceServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Chain-ID": "421614",
        },
        body: JSON.stringify({
          model: TEXT_MODEL_ID,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });

      assert.equal(response.status, 402);
      assert.equal(typeof response.headers.get("payment-required"), "string");

      const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
      assert.equal(paymentRequired.accepts[0]?.scheme, "upto");
      assert.equal(paymentRequired.accepts[0]?.network, "eip155:421614");
      assert.equal(paymentRequired.accepts[0]?.amount, "1000000");
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(
    warnings.some((warning) => warning.includes("[genai]") || warning.includes("[openai]") || warning.includes("[huggingface]") || warning.includes("[vertex]") || warning.includes("[fireworks]") || warning.includes("[cloudflare]")),
    false,
  );
});

test("registerInferenceRoutes negotiates raw x402 upto pricing for deterministic inference requests", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
      },
      body: JSON.stringify({
        model: AUDIO_MODEL_ID,
        input: "Hello world",
        voice: "alloy",
      }),
    });

    assert.equal(response.status, 402);
    assert.equal(typeof response.headers.get("payment-required"), "string");

    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    assert.equal(paymentRequired.accepts[0]?.scheme, "upto");
    assert.equal(paymentRequired.accepts[0]?.network, "eip155:43113");
    assert.ok(Number(paymentRequired.accepts[0]?.amount || "0") > 0);
  });
});

test("normalizeAudioTranscriptionFile preserves locators and wraps bare base64", () => {
  assert.equal(
    normalizeAudioTranscriptionFile("https://cdn.example.com/audio.wav"),
    "https://cdn.example.com/audio.wav",
  );
  assert.equal(
    normalizeAudioTranscriptionFile("data:audio/webm;base64,AAAA"),
    "data:audio/webm;base64,AAAA",
  );
  assert.equal(
    normalizeAudioTranscriptionFile("AAAA"),
    "data:application/octet-stream;base64,AAAA",
  );
});

test("registerInferenceRoutes negotiates raw x402 upto pricing for token-metered inference when a max cap is supplied", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
        "x-x402-max-amount-wei": "250000",
      },
      body: JSON.stringify({
        model: TEXT_MODEL_ID,
        input: [{ type: "input_text", text: "Say hello." }],
        modalities: ["text"],
      }),
    });

    assert.equal(response.status, 402);
    assert.equal(typeof response.headers.get("payment-required"), "string");

    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    assert.equal(paymentRequired.accepts[0]?.scheme, "upto");
    assert.equal(paymentRequired.accepts[0]?.network, "eip155:43113");
    assert.equal(paymentRequired.accepts[0]?.amount, "250000");
  });
});

test("registerInferenceRoutes accepts image-only universal embedding requests before payment", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
      },
      body: JSON.stringify({
        model: IMAGE_EMBEDDING_MODEL_ID,
        input: [{ type: "input_image", image_url: "https://cdn.example.com/street.jpg" }],
        stream: false,
      }),
    });

    assert.equal(response.status, 402);
    assert.equal(typeof response.headers.get("payment-required"), "string");
  });
});

test("searchModels uses canonical modality classification instead of provider type spellings", () => {
  const text = searchModels({ modality: "text", q: TEXT_MODEL_ID, limit: 20 });
  assert.ok(text.data.some((model) => model.modelId === TEXT_MODEL_ID));

  const embedding = searchModels({ modality: "embedding", q: EMBEDDING_MODEL_ID, limit: 20 });
  assert.ok(embedding.data.some((model) => model.modelId === EMBEDDING_MODEL_ID));

  const audio = searchModels({ modality: "audio", q: AUDIO_MODEL_ID, limit: 20 });
  assert.ok(audio.data.some((model) => model.modelId === AUDIO_MODEL_ID));
});

function capabilitiesFor(modelId: string) {
  const model = getModelById(modelId);
  assert.ok(model, `expected catalog model ${modelId}`);
  return getModelCapabilities(model);
}

test("catalog classifiers emit operation-specific input and output shapes", () => {
  const alibabaImageVideo = capabilitiesFor("happyhorse-1.0-i2v");
  assert.equal(alibabaImageVideo.some((capability) => capability.operation === "text-to-video"), false);
  assert.ok(alibabaImageVideo.some((capability) =>
    capability.modality === "video"
    && capability.operation === "image-to-video"
    && capability.input.includes("image")
    && capability.input.includes("text")
    && capability.output.includes("video")
  ));

  const alibabaTextVideo = capabilitiesFor("happyhorse-1.0-t2v");
  assert.equal(alibabaTextVideo.some((capability) => capability.operation === "image-to-video"), false);
  assert.ok(alibabaTextVideo.some((capability) =>
    capability.modality === "video"
    && capability.operation === "text-to-video"
    && capability.input.includes("text")
    && capability.output.includes("video")
  ));

  const elevenLabsScribe = capabilitiesFor("scribe_v1");
  assert.equal(elevenLabsScribe.some((capability) => capability.operation === "chat"), false);
  assert.ok(elevenLabsScribe.some((capability) =>
    capability.modality === "text"
    && capability.operation === "speech-to-text"
    && capability.input.includes("audio")
    && capability.output.includes("text")
  ));

  const fireworksEmbedding = capabilitiesFor("accounts/fireworks/models/qwen3-reranker-8b");
  assert.equal(fireworksEmbedding.some((capability) => capability.operation === "rerank"), false);
  assert.ok(fireworksEmbedding.some((capability) =>
    capability.modality === "embedding"
    && capability.operation === "text-to-embedding"
  ));
});

test("normalizeResponsesRequest carries catalog operation through universal routing", () => {
  const stt = normalizeResponsesRequest({
    model: STT_MODEL_ID,
    input: [{ type: "input_audio", audio_url: "https://cdn.example.com/speech.wav" }],
    stream: true,
  });

  assert.equal(stt.modality, "text");
  assert.equal(stt.operation, "speech-to-text");

  const openaiStt = normalizeResponsesRequest({
    model: "gpt-4o-mini-transcribe",
    input: [
      { type: "input_text", text: "Use project-specific vocabulary." },
      { type: "input_audio", audio_url: "https://cdn.example.com/meeting.wav" },
    ],
  });

  assert.equal(openaiStt.modality, "text");
  assert.equal(openaiStt.operation, "speech-to-text");

  const realtime = normalizeResponsesRequest({
    model: "gpt-realtime-1.5",
    input: [{ type: "input_text", text: "Answer over a realtime session." }],
  });

  assert.equal(realtime.modality, "realtime");
  assert.equal(realtime.operation, "realtime-omni");

  const dualMode = normalizeResponsesRequest({
    model: "@cf/deepgram/nova-3",
    input: [{ type: "input_audio", audio_url: "https://cdn.example.com/meeting.wav" }],
  });

  assert.equal(dualMode.modality, "text");
  assert.equal(dualMode.operation, "speech-to-text");

  const imageAnalysis = normalizeResponsesRequest({
    model: IMAGE_ANALYSIS_MODEL_ID,
    input: [
      { type: "input_text", text: "Find the objects in this street scene." },
      { type: "input_image", image_url: "https://cdn.example.com/street.jpg" },
    ],
  });

  assert.equal(imageAnalysis.modality, "image");
  assert.equal(imageAnalysis.operation, "object-detection");

  const visionChat = normalizeResponsesRequest({
    model: "@cf/llava-hf/llava-1.5-7b-hf",
    input: [
      { type: "input_text", text: "Describe the scene." },
      { type: "input_image", image_url: "https://cdn.example.com/scene.jpg" },
    ],
  });

  assert.equal(visionChat.modality, "text");
  assert.equal(visionChat.operation, "vision-chat");

  const rerank = normalizeResponsesRequest({
    model: RERANK_MODEL_ID,
    input: [{ type: "input_text", text: "Rank Compose SDK documentation snippets." }],
  });

  assert.equal(rerank.modality, "text");
  assert.equal(rerank.operation, "rerank");

});

test("native inference ignores caller provider overrides and resolves from catalog model identity", () => {
  const request = normalizeResponsesRequest({
    model: TEXT_MODEL_ID,
    provider: "openai",
    input: [{ type: "input_text", text: "Say hello." }],
  });

  assert.equal("provider" in request, false);
  assert.equal(resolveInferenceRequest(request).provider, TEXT_MODEL_PROVIDER);

  const chat = normalizeChatRequest({
    model: TEXT_MODEL_ID,
    provider: "openai",
    messages: [{ role: "user", content: "Say hello." }],
  });

  assert.equal("provider" in chat, false);
  assert.equal(resolveInferenceRequest(chat).provider, TEXT_MODEL_PROVIDER);
});

test("realtime-only models are rejected before REST payment/provider execution", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-realtime-1.5",
        input: [{ type: "input_text", text: "Start a voice session." }],
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("payment-required"), null);
    const body = await response.json() as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, "realtime_session_required");
    assert.match(body.error?.message || "", /realtime WebSocket session/i);
  });
});

test("registerInferenceRoutes rejects unsupported model search providers", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/models/search?provider=not-a-provider`, {
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        message: "provider is not supported",
        type: "invalid_request_error",
        code: "invalid_provider",
      },
    });
  });
});

test("registerInferenceRoutes exposes modality operation catalogs", async () => {
  await withInferenceServer(async (baseUrl) => {
    const catalog = await fetch(`${baseUrl}/v1/modalities`);
    assert.equal(catalog.status, 200);

    const catalogBody = await catalog.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(catalogBody.object, "list");
    assert.ok(catalogBody.data.some((entry) => entry.modality === "text"));
    assert.ok(catalogBody.data.some((entry) => entry.modality === "audio"));

    const models = await fetch(`${baseUrl}/v1/modalities/text/operations/chat/models?limit=20&q=${encodeURIComponent(TEXT_MODEL_ID)}`);
    assert.equal(models.status, 200);

    const modelsBody = await models.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(modelsBody.object, "list");
    assert.ok(modelsBody.data.some((model) => model.modelId === TEXT_MODEL_ID));
  });
});

test("registerInferenceRoutes exposes scalar family catalogs", async () => {
  await withInferenceServer(async (baseUrl) => {
    const catalog = await fetch(`${baseUrl}/v1/families`);
    assert.equal(catalog.status, 200);

    const catalogBody = await catalog.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(catalogBody.object, "list");
    for (const entry of catalogBody.data) {
      assert.equal(typeof entry.family, "string");
      assert.equal(typeof entry.modelCount, "number");
      assert.equal("capabilities" in entry, false);
      assert.equal("operations" in entry, false);
      assert.equal("pricingUnits" in entry, false);
      assert.equal("sourceTypes" in entry, false);
    }
  });
});

test("adaptError preserves x402 payment-required negotiation metadata from settlement failures", async () => {
  const { adaptError } = await import("../inference/gateway.js");
  const { createPaymentRequired402Response } = await import("../x402/index.js");
  const { encodeComposePaymentRequiredHeader } = await import("../x402/facilitator.js");

  const paymentRequired = createPaymentRequired402Response({
    chainId: 84532,
    amountWei: 25_000_000,
    resourceUrl: "https://api.compose.market/v1/responses",
    errorMessage: "Session expired or insufficient allowance",
  });
  const paymentRequiredHeader = encodeComposePaymentRequiredHeader(paymentRequired);
  const settledError = Object.assign(new Error("Session expired or insufficient allowance"), {
    statusCode: 402,
    paymentRequired,
    paymentRequiredHeader,
  });

  const adapted = adaptError(settledError, 500);

  assert.equal(adapted.status, 402);
  assert.deepEqual(adapted.body, paymentRequired);
  assert.equal(adapted.headers?.["PAYMENT-REQUIRED"], paymentRequiredHeader);
  assert.equal(adapted.headers?.["payment-required"], paymentRequiredHeader);
});

test("adaptError classifies provider topup rate-limit wording as rate limit", async () => {
  const { adaptError } = await import("../inference/gateway.js");
  const error = new Error("OpenAI-wire chat HTTP 400: rate limit exceeded. Pending topup payment failed");

  const adapted = adaptError(error, 500);

  assert.equal(adapted.status, 429);
  assert.deepEqual(adapted.body.error, {
    message: error.message,
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  });
});

test("adaptError classifies provider missing modality input as invalid request", async () => {
  const { adaptError } = await import("../inference/gateway.js");
  const error = new Error("Roboflow image analysis requires an image input");

  const adapted = adaptError(error, 500);

  assert.equal(adapted.status, 400);
  assert.deepEqual(adapted.body.error, {
    message: error.message,
    type: "invalid_request_error",
    code: "missing_input",
  });
});

test("normalizeResponsesRequest preserves instructions and previous_response_id for direct Responses API clients", () => {
  const request = normalizeResponsesRequest({
    model: "gpt-5.3",
    instructions: "Be concise.",
    previous_response_id: "resp_prev_123",
    input: [{ type: "input_text", text: "Continue." }],
  });

  assert.equal(request.instructions, "Be concise.");
  assert.equal(request.previousResponseId, "resp_prev_123");
  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "Continue." }],
    },
  ]);
});

test("request normalizers fold universal attachments into user content without capability gating", () => {
  const chat = normalizeChatRequest({
    model: TEXT_MODEL_ID,
    messages: [{ role: "user", content: "Use these inputs." }],
    attachments: [
      { type: "image", url: "https://cdn.example.com/chart.png", detail: "high" },
      { type: "pdf", url: "https://cdn.example.com/spec.pdf", name: "spec.pdf" },
      { type: "audio", url: "https://cdn.example.com/brief.mp3" },
      { type: "video", url: "https://cdn.example.com/demo.mp4" },
    ],
  });

  assert.deepEqual(chat.messages[0].content, [
    { type: "text", text: "Use these inputs." },
    { type: "image_url", image_url: { url: "https://cdn.example.com/chart.png", detail: "high" } },
    { type: "text", text: "Attachment pdf:spec.pdf: https://cdn.example.com/spec.pdf" },
    { type: "input_audio", input_audio: { url: "https://cdn.example.com/brief.mp3" } },
    { type: "video_url", video_url: { url: "https://cdn.example.com/demo.mp4" } },
  ]);

  const responses = normalizeResponsesRequest({
    model: TEXT_MODEL_ID,
    input: "Summarize.",
    attachment: { type: "text", text: "Local note" },
  });

  assert.deepEqual(responses.messages[0].content, [
    { type: "text", text: "Summarize." },
    { type: "text", text: "Local note" },
  ]);
});

test("request normalizers only enable streaming for a boolean true stream flag", () => {
  assert.equal(normalizeChatRequest({
    model: TEXT_MODEL_ID,
    messages: [{ role: "user", content: "hello" }],
    stream: "false",
  }).stream, false);

  assert.equal(normalizeResponsesRequest({
    model: TEXT_MODEL_ID,
    input: [{ type: "input_text", text: "hello" }],
    stream: "false",
  }).stream, false);

  assert.equal(normalizeResponsesRequest({
    model: TEXT_MODEL_ID,
    input: [{ type: "input_text", text: "hello" }],
    stream: true,
  }).stream, true);
});

test("registerInferenceRoutes rejects non-boolean stream flags before payment negotiation", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
        "x-x402-max-amount-wei": "250000",
      },
      body: JSON.stringify({
        model: TEXT_MODEL_ID,
        messages: [{ role: "user", content: "hello" }],
        stream: "false",
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("payment-required"), null);
    assert.deepEqual(await response.json(), {
      error: {
        message: "stream must be a boolean when provided",
        type: "invalid_request_error",
        code: "invalid_stream",
      },
    });
  });
});

test("registerInferenceRoutes exposes universal response streams to payment negotiation", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
        "x-x402-max-amount-wei": "250000",
      },
      body: JSON.stringify({
        model: AUDIO_MODEL_ID,
        input: [{ type: "input_text", text: "Speak this aloud." }],
        modalities: ["audio"],
        stream: true,
      }),
    });

    assert.equal(response.status, 402);
    assert.equal(typeof response.headers.get("payment-required"), "string");

    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    assert.equal(paymentRequired.accepts[0]?.scheme, "upto");
    assert.equal(paymentRequired.accepts[0]?.network, "eip155:43113");
    assert.equal(paymentRequired.accepts[0]?.amount, "250000");
  });
});

test("response output item mapper exposes every native output family", () => {
  assert.deepEqual(toResponsesOutputItems({
    modality: "text",
    content: "hello",
  }), [{ type: "output_text", role: "assistant", text: "hello" }]);

  assert.deepEqual(toResponsesOutputItems({
    modality: "image",
    media: { mimeType: "image/png", base64: "aW1n", status: "completed" },
  }), [{
    type: "output_image",
    role: "assistant",
    image_url: "data:image/png;base64,aW1n",
    mime_type: "image/png",
  }]);

  assert.deepEqual(toResponsesOutputItems({
    modality: "audio",
    media: { mimeType: "audio/mpeg", base64: "YXVk", status: "completed" },
  }), [{
    type: "output_audio",
    role: "assistant",
    audio_url: "data:audio/mpeg;base64,YXVk",
    mime_type: "audio/mpeg",
    status: "completed",
  }]);

  assert.deepEqual(toResponsesOutputItems({
    modality: "video",
    media: {
      mimeType: "video/mp4",
      url: "https://cdn.example.com/video.mp4",
      jobId: "job_123",
      status: "processing",
      progress: 40,
    },
  }), [{
    type: "output_video",
    role: "assistant",
    video_url: "https://cdn.example.com/video.mp4",
    mime_type: "video/mp4",
    job_id: "job_123",
    status: "processing",
    progress: 40,
  }]);

  assert.deepEqual(toResponsesOutputItems({
    modality: "embedding",
    embeddings: [[0.1, 0.2, 0.3]],
  }), [{
    type: "output_embedding",
    role: "assistant",
    embedding: [0.1, 0.2, 0.3],
  }]);
});

test("responses stream mapper emits typed output and video status events", () => {
  assert.deepEqual(toResponsesStreamEvent("resp_123", "video-model", {
    type: "output-item",
    outputIndex: 0,
    item: {
      type: "output_audio",
      role: "assistant",
      audio_url: "data:audio/mpeg;base64,YXVk",
      mime_type: "audio/mpeg",
    },
  }), {
    type: "response.output_item.completed",
    response_id: "resp_123",
    model: "video-model",
    output_index: 0,
    item: {
      type: "output_audio",
      role: "assistant",
      audio_url: "data:audio/mpeg;base64,YXVk",
      mime_type: "audio/mpeg",
    },
  });

  assert.deepEqual(toResponsesStreamEvent("resp_123", "video-model", {
    type: "video-status",
    videoStatus: {
      jobId: "job_123",
      status: "processing",
      progress: 65,
      url: "https://cdn.example.com/video.mp4",
    },
  }), {
    type: "response.output_video.status",
    response_id: "resp_123",
    model: "video-model",
    job_id: "job_123",
    status: "processing",
    progress: 65,
    url: "https://cdn.example.com/video.mp4",
    error: undefined,
  });
});

test("normalizeResponsesRequest carries authoritative character metrics for audio generation", () => {
  const request = normalizeResponsesRequest({
    model: AUDIO_MODEL_ID,
    modalities: ["audio"],
    input: [{ type: "input_text", text: "Speak this aloud." }],
  });

  assert.equal(request.modality, "audio");
  assert.deepEqual(request.billingMetrics, {
    request: 1,
    output_format: "mp3",
    character: Array.from("Speak this aloud.").length,
  });
});

test("normalizeResponsesRequest injects lowest-cost ElevenLabs music defaults into billing", () => {
  const params = resolveModelParams("music_v1", "audio");
  assert.ok(params);
  assert.equal(params.params.music_length_ms?.type, "integer");
  assert.equal(params.defaults.music_length_ms, 3000);

  const request = normalizeResponsesRequest({
    model: "music_v1",
    modalities: ["audio"],
    input: [{ type: "input_text", text: "Warm synth-pop intro sound for Northstar Objects." }],
  });

  assert.equal(request.customParams?.music_length_ms, undefined);
  assert.equal(request.billingMetrics?.music_length_ms, 3000);
  assert.equal(request.billingMetrics?.duration, 3);
  assert.equal(request.billingMetrics?.generated_audio_minute, 0.05);
});

test("normalizeResponsesRequest injects lowest-cost video defaults into generation billing", () => {
  const textToVideo = normalizeResponsesRequest({
    model: "sora-2",
    modalities: ["video"],
    input: [{ type: "input_text", text: "A camera move through a neon arcade." }],
  });

  assert.equal(textToVideo.videoOptions?.duration, undefined);
  assert.equal(textToVideo.videoOptions?.resolution, undefined);
  assert.deepEqual(textToVideo.billingMetrics, {
    request: 1,
    duration: 4,
    aspect_ratio: "16:9",
    output_format: "mp4",
    second: 4,
    minute: 4 / 60,
    video: 1,
    generation: 1,
  });

  const imageToVideo = normalizeResponsesRequest({
    model: "sora-2",
    modalities: ["video"],
    input: [
      { type: "input_text", text: "The subject turns toward camera." },
      { type: "input_image", image_url: "https://example.com/frame.png" },
    ],
  });

  assert.equal(imageToVideo.videoOptions?.duration, undefined);
  assert.equal(imageToVideo.videoOptions?.imageUrl, undefined);

  const pricedWan = normalizeResponsesRequest({
    model: "wan2.1-i2v-plus",
    modalities: ["video"],
    input: [{ type: "input_text", text: "A camera move through a neon arcade." }],
  });

  assert.equal(pricedWan.videoOptions?.duration, undefined);
  assert.equal(pricedWan.videoOptions?.resolution, undefined);
  assert.equal(pricedWan.billingMetrics?.duration, 4);
  assert.equal(pricedWan.billingMetrics?.second, 4);

  const veo2 = normalizeResponsesRequest({
    model: "veo-2.0-generate-001",
    modalities: ["video"],
    input: [{ type: "input_text", text: "A quiet product reveal on a studio table." }],
  });

  assert.equal(veo2.videoOptions?.duration, undefined);
  assert.equal(veo2.billingMetrics?.duration, 5);
  assert.equal(veo2.billingMetrics?.second, 5);
});

test("resolveModelParams uses modality catalogs, not model-card request schemas", () => {
  const transcription = resolveModelParams("gpt-4o-mini-transcribe");
  assert.ok(transcription);
  assert.equal(transcription.type, "text");
  assert.equal(transcription.params.file, undefined);
  assert.equal(transcription.params.input, undefined);
  assert.deepEqual(transcription.params, {});

  const text = resolveModelParams("gpt-4o");
  assert.ok(text);
  assert.equal(text.type, "text");
  assert.deepEqual(text.params, {});

  const wan = resolveModelParams("wan2.1-i2v-turbo", "video");
  assert.ok(wan);
  assert.equal(wan.provider, "alibaba");
  assert.equal(wan.params.prompt_extend?.type, "boolean");
  assert.equal(wan.defaults.prompt_extend, false);
});

test("normalizeResponsesRequest coerces model param numeric strings before billing", () => {
  const request = normalizeResponsesRequest({
    model: "minimax/hailuo-02",
    modalities: ["video"],
    input: [{ type: "input_text", text: "A fast river through a valley." }],
    custom_params: {
      duration: "10",
    },
  });

  assert.equal(request.videoOptions?.duration, 10);
  assert.equal(request.customParams?.duration, 10);
  assert.equal(request.billingMetrics?.duration, 10);
  assert.equal(request.billingMetrics?.second, 10);
});


test("registerInferenceRoutes exposes response input items on the canonical /v1 path", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses/resp_missing/input_items`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Response 'resp_missing' not found",
        type: "invalid_request_error",
        code: "response_not_found",
      },
    });
  });
});

test("toChatUsageStreamEvent emits the OpenAI-compatible usage-only terminal chunk", () => {
  const event = toChatUsageStreamEvent("resp_usage_123", "gpt-5.2", {
    promptTokens: 123,
    completionTokens: 45,
    totalTokens: 168,
  }) as Record<string, unknown>;

  assert.equal(event.id, "resp_usage_123");
  assert.equal(event.object, "chat.completion.chunk");
  assert.equal(typeof event.created, "number");
  assert.equal(event.model, "gpt-5.2");
  assert.deepEqual(event.choices, []);
  assert.deepEqual(event.usage, {
    prompt_tokens: 123,
    completion_tokens: 45,
    total_tokens: 168,
  });
});

test("chat completion helpers preserve OpenAI-compatible streamed tool-call semantics", () => {
  const toolChunk = toChatStreamEvent(
    "resp_tool_123",
    TEXT_MODEL_ID,
    {
      type: "tool-call",
      toolCall: {
        id: "call_123",
        name: "get_price",
        arguments: "{\"symbol\":\"BTC\"}",
        providerMetadata: { google: { thoughtSignature: "sig_123" } },
      },
    },
    true,
  ) as Record<string, any>;

  assert.equal(toolChunk.choices[0].delta.role, "assistant");
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls, [
    {
      index: 0,
      id: "call_123",
      type: "function",
      function: {
        name: "get_price",
        arguments: "{\"symbol\":\"BTC\"}",
      },
      providerMetadata: { google: { thoughtSignature: "sig_123" } },
    },
  ]);

  const doneChunk = toChatStreamEvent(
    "resp_tool_123",
    TEXT_MODEL_ID,
    { type: "done", finishReason: "tool-calls" },
  ) as Record<string, any>;

  assert.equal(doneChunk.choices[0].finish_reason, "tool_calls");

  const response = toChatCompletionsResponse(TEXT_MODEL_ID, "resp_tool_123", {
    modality: "text",
    content: "",
    finishReason: "tool-calls",
    toolCalls: [{
      id: "call_123",
      name: "get_price",
      arguments: "{\"symbol\":\"BTC\"}",
      providerMetadata: { google: { thoughtSignature: "sig_123" } },
    }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });

  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls?.[0]?.function.name, "get_price");
  assert.deepEqual((response.choices[0].message.tool_calls?.[0] as any)?.providerMetadata, { google: { thoughtSignature: "sig_123" } });
});
