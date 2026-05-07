import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  toChatCompletionsResponse,
  toChatStreamEvent,
  toChatUsageStreamEvent,
} from "../inference/core.js";
import { searchModels } from "../inference/models-registry.js";

const ORIGINAL_ENV = {
  THIRDWEB_SECRET_KEY: process.env.THIRDWEB_SECRET_KEY,
  THIRDWEB_SERVER_WALLET_ADDRESS: process.env.THIRDWEB_SERVER_WALLET_ADDRESS,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  DEPLOYER_KEY: process.env.DEPLOYER_KEY,
  RUNTIME_INTERNAL_SECRET: process.env.RUNTIME_INTERNAL_SECRET,
};

async function withInferenceServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  process.env.THIRDWEB_SECRET_KEY = ORIGINAL_ENV.THIRDWEB_SECRET_KEY || "test-thirdweb-secret";
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS =
    ORIGINAL_ENV.THIRDWEB_SERVER_WALLET_ADDRESS || "0x1111111111111111111111111111111111111111";
  process.env.MERCHANT_WALLET_ADDRESS =
    ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  process.env.DEPLOYER_KEY = ORIGINAL_ENV.DEPLOYER_KEY || `0x${"11".repeat(32)}`;
  delete process.env.RUNTIME_INTERNAL_SECRET;
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
    process.env.RUNTIME_INTERNAL_SECRET = ORIGINAL_ENV.RUNTIME_INTERNAL_SECRET;
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

      const model = body.data.find((entry) => entry.modelId === "gpt-4.1-mini");
      assert.ok(model);
      assert.equal(model.name, "GPT 4.1 Mini");
      assert.equal(model.provider, "openai");
      assert.equal(model.type, "chat-completions");
      assert.deepEqual(model.input, ["text", "image"]);
      assert.deepEqual(model.output, ["text"]);
      assert.deepEqual(model.contextWindow, {
        inputTokens: 1047576,
        outputTokens: 32768,
      });
      assert.deepEqual(model.pricing, {
        sections: [
          {
            header: "Text tokens",
            unit: "Per 1M tokens",
            unitKey: "usd_per_1m_tokens",
            default: true,
            entries: {
              input: 0.4,
              cached_input: 0.1,
              output: 1.6,
            },
          },
        ],
      });
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
    const response = await fetch(`${baseUrl}/v1/models/${encodeURIComponent("gpt-4.1-mini")}`);
    assert.equal(response.status, 200);

    const model = await response.json() as Record<string, unknown>;
    assert.equal(model.modelId, "gpt-4.1-mini");
    assert.equal(model.name, "GPT 4.1 Mini");
    assert.equal(model.provider, "openai");
    assert.equal(model.type, "chat-completions");
    assert.equal("id" in model, false);
    assert.equal("task_type" in model, false);
    assert.equal("context_window" in model, false);
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
        model: "gpt-4.1-mini",
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

test("registerInferenceRoutes negotiates raw x402 exact pricing for deterministic inference requests", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
      },
      body: JSON.stringify({
        model: "@cf/deepgram/aura-1",
        input: "Hello world",
        voice: "alloy",
      }),
    });

    assert.equal(response.status, 402);
    assert.equal(typeof response.headers.get("payment-required"), "string");

    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    assert.equal(paymentRequired.accepts[0]?.scheme, "exact");
    assert.equal(paymentRequired.accepts[0]?.network, "eip155:43113");
    assert.ok(Number(paymentRequired.accepts[0]?.amount || "0") > 0);
  });
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
        model: "gpt-4.1-mini",
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

test("searchModels uses canonical modality classification instead of provider type spellings", () => {
  const text = searchModels({ modality: "text", q: "gpt-4.1-mini", limit: 20 });
  assert.ok(text.data.some((model) => model.modelId === "gpt-4.1-mini"));

  const embedding = searchModels({ modality: "embedding", q: "text-embedding-3-small", limit: 20 });
  assert.ok(embedding.data.some((model) => model.modelId === "text-embedding-3-small"));

  const audio = searchModels({ modality: "audio", q: "@cf/deepgram/aura-1", limit: 20 });
  assert.ok(audio.data.some((model) => model.modelId === "@cf/deepgram/aura-1"));
});

test("registerInferenceRoutes exposes modality operation catalogs", async () => {
  await withInferenceServer(async (baseUrl) => {
    const catalog = await fetch(`${baseUrl}/v1/modalities`);
    assert.equal(catalog.status, 200);

    const catalogBody = await catalog.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(catalogBody.object, "list");
    assert.ok(catalogBody.data.some((entry) => entry.modality === "text"));
    assert.ok(catalogBody.data.some((entry) => entry.modality === "audio"));

    const models = await fetch(`${baseUrl}/v1/modalities/text/operations/chat/models?limit=20&q=gpt-4.1-mini`);
    assert.equal(models.status, 200);

    const modelsBody = await models.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(modelsBody.object, "list");
    assert.ok(modelsBody.data.some((model) => model.modelId === "gpt-4.1-mini"));
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
    model: "gpt-4.1-mini",
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
    model: "gpt-4.1-mini",
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
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "hello" }],
    stream: "false",
  }).stream, false);

  assert.equal(normalizeResponsesRequest({
    model: "gpt-4.1-mini",
    input: [{ type: "input_text", text: "hello" }],
    stream: "false",
  }).stream, false);

  assert.equal(normalizeResponsesRequest({
    model: "gpt-4.1-mini",
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
        model: "gpt-4.1-mini",
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

test("registerInferenceRoutes rejects unsupported streaming modalities before payment negotiation", async () => {
  await withInferenceServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "43113",
        "x-x402-max-amount-wei": "250000",
      },
      body: JSON.stringify({
        model: "@cf/deepgram/aura-1",
        input: [{ type: "input_text", text: "Speak this aloud." }],
        modalities: ["audio"],
        stream: true,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("payment-required"), null);
    assert.deepEqual(await response.json(), {
      error: {
        message: "streaming is only supported for text and image modalities",
        type: "invalid_request_error",
        code: "unsupported_stream_modality",
      },
    });
  });
});

test("normalizeResponsesRequest carries authoritative character metrics for audio generation", () => {
  const request = normalizeResponsesRequest({
    model: "@cf/deepgram/aura-1",
    modalities: ["audio"],
    input: [{ type: "input_text", text: "Speak this aloud." }],
  });

  assert.equal(request.modality, "audio");
  assert.deepEqual(request.billingMetrics, {
    request: 1,
    character: Array.from("Speak this aloud.").length,
  });
});

test("normalizeResponsesRequest does not inject provider video defaults into generation requests", () => {
  const textToVideo = normalizeResponsesRequest({
    model: "sora-2",
    modalities: ["video"],
    input: [{ type: "input_text", text: "A camera move through a neon arcade." }],
  });

  assert.equal(textToVideo.videoOptions?.duration, undefined);
  assert.equal(textToVideo.videoOptions?.resolution, undefined);
  assert.deepEqual(textToVideo.billingMetrics, {
    request: 1,
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

test("toChatUsageStreamEvent emits the OpenAI usage-only terminal chunk LangChain expects", () => {
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
    "gpt-4o",
    {
      type: "tool-call",
      toolCall: {
        id: "call_123",
        name: "get_price",
        arguments: "{\"symbol\":\"BTC\"}",
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
    },
  ]);

  const doneChunk = toChatStreamEvent(
    "resp_tool_123",
    "gpt-4o",
    { type: "done", finishReason: "tool-calls" },
  ) as Record<string, any>;

  assert.equal(doneChunk.choices[0].finish_reason, "tool_calls");

  const response = toChatCompletionsResponse("gpt-4o", "resp_tool_123", {
    modality: "text",
    content: "",
    finishReason: "tool-calls",
    toolCalls: [{ id: "call_123", name: "get_price", arguments: "{\"symbol\":\"BTC\"}" }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });

  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls?.[0]?.function.name, "get_price");
});
