import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResolvedAuthorizationInput,
  buildResolvedAuthorizationMeter,
  buildResolvedSettlementMeter,
  type ResolvedBillingModel,
} from "../x402/metering.js";

test("buildResolvedSettlementMeter derives strict token line items from authoritative usage", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "gemini-2.5-flash",
    provider: "gemini",
    known: true,
    card: {
      modelId: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "gemini",
      type: "chat-completions",
      description: null,
      input: ["text"],
      output: ["text"],
      capabilities: ["streaming"],
      available: true,
      pricing: {
        unit: "usd_per_1m_tokens",
        values: {
          input: 0.3,
          output: 2.5,
        },
      },
      contextWindow: 1000000,
    },
  };

  const metered = buildResolvedSettlementMeter({
    resolved,
    modality: "text",
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
    },
  });

  assert.equal(metered.meter.subject, "gemini:gemini-2.5-flash");
  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1200,
      unitPriceUsd: 0.3,
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 300,
      unitPriceUsd: 2.5,
    },
  ]);
  assert.equal(metered.providerAmountWei, "1110");
  assert.equal(metered.platformFeeWei, "12");
  assert.equal(metered.finalAmountWei, "1122");
});

test("buildResolvedSettlementMeter meters Azure token models through x402", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "Kimi-K2.5",
    provider: "azure",
    known: true,
    card: {
      modelId: "Kimi-K2.5",
      name: "Kimi-K2.5",
      provider: "azure",
      type: "text-generation",
      description: null,
      input: ["text"],
      output: ["text"],
      capabilities: ["streaming"],
      available: true,
      pricing: {
        unit: "1K Tokens",
        values: {
          input: 0.00066,
          output: 0.0033,
        },
      },
      contextWindow: {
        inputTokens: null,
        outputTokens: null,
      },
    },
  };

  const metered = buildResolvedSettlementMeter({
    resolved,
    modality: "text",
    usage: {
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
    },
  });

  assert.equal(metered.meter.subject, "azure:Kimi-K2.5");
  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "input_tokens",
      unit: "usd_per_1k_tokens",
      quantity: 1000,
      unitPriceUsd: 0.00066,
    },
    {
      key: "output_tokens",
      unit: "usd_per_1k_tokens",
      quantity: 1000,
      unitPriceUsd: 0.0033,
    },
  ]);
});

test("buildResolvedSettlementMeter accepts raw compiled token pricing sections", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "gpt-4.1-mini",
    provider: "openai",
    known: true,
    card: {
      modelId: "gpt-4.1-mini",
      name: "GPT-4.1 mini",
      provider: "openai",
      type: "chat-completions",
      description: null,
      input: ["text"],
      output: ["text"],
      capabilities: ["streaming"],
      available: true,
      pricing: {
        sections: [
          {
            header: "Text tokens",
            unit: "Per 1M tokens",
            unitKey: "per_1m_tokens_usd",
            entries: {
              input: 0.4,
              cached_input: 0.1,
              output: 1.6,
            },
          },
        ],
      },
      contextWindow: {
        inputTokens: 1_047_576,
        outputTokens: 32_768,
      },
    },
  };

  const metered = buildResolvedSettlementMeter({
    resolved,
    modality: "text",
    usage: {
      promptTokens: 2_000,
      completionTokens: 500,
      totalTokens: 2_500,
    },
  });

  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 2_000,
      unitPriceUsd: 0.4,
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 500,
      unitPriceUsd: 1.6,
    },
  ]);
});

test("buildResolvedAuthorizationMeter accepts top-level per-image compiled pricing", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "imagen-4.0-generate-001",
    provider: "gemini",
    known: true,
    card: {
      modelId: "imagen-4.0-generate-001",
      name: "Imagen 4",
      provider: "gemini",
      type: "text-to-image",
      description: null,
      input: ["text"],
      output: ["image"],
      capabilities: ["image-generation"],
      available: true,
      pricing: {
        unit: "per_image_usd",
        input: null,
        output: null,
        perImage: 0.04,
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const metered = buildResolvedAuthorizationMeter({
    request: {
      mode: "responses",
      model: "imagen-4.0-generate-001",
      provider: "gemini",
      stream: false,
      modality: "image",
      messages: [{ role: "user", content: "Generate a sunset" }],
      responseId: "resp_test",
      imageOptions: { n: 2 },
      billingMetrics: {
        request: 1,
        generation: 2,
        image: 2,
      },
    },
    resolved,
  });

  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 2,
      unitPriceUsd: 0.04,
    },
  ]);
});

test("buildResolvedAuthorizationInput defers token-priced text authorization to budget cap", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "gpt-4.1-mini",
    provider: "openai",
    known: true,
    card: {
      modelId: "gpt-4.1-mini",
      name: "GPT-4.1 mini",
      provider: "openai",
      type: "chat-completions",
      description: null,
      input: ["text"],
      output: ["text"],
      capabilities: ["streaming"],
      available: true,
      pricing: {
        sections: [
          {
            header: "Text tokens",
            unit: "Per 1M tokens",
            unitKey: "per_1m_tokens_usd",
            entries: {
              input: 0.4,
              output: 1.6,
            },
            default: true,
          },
        ],
      },
      contextWindow: {
        inputTokens: 1_047_576,
        outputTokens: 32_768,
      },
    },
  };

  const authorization = buildResolvedAuthorizationInput({
    request: {
      mode: "responses",
      model: "gpt-4.1-mini",
      provider: "openai",
      stream: true,
      modality: "text",
      messages: [{ role: "user", content: "hello" }],
      responseId: "resp_text_auth",
    },
    resolved,
  });

  assert.deepEqual(authorization, { useBudgetCap: true });
});

test("buildResolvedAuthorizationInput defers embeddings to budget cap", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "text-embedding-3-small",
    provider: "openai",
    known: true,
    card: {
      modelId: "text-embedding-3-small",
      name: "Text Embedding 3 Small",
      provider: "openai",
      type: "embeddings",
      description: null,
      input: ["text"],
      output: ["embedding"],
      capabilities: ["embeddings"],
      available: true,
      pricing: {
        sections: [
          {
            header: "Embeddings",
            unit: "Per 1M tokens",
            unitKey: "per_1m_tokens_usd",
            entries: {
              cost: 0.02,
            },
            default: true,
          },
        ],
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const authorization = buildResolvedAuthorizationInput({
    request: {
      mode: "embeddings",
      model: "text-embedding-3-small",
      provider: "openai",
      stream: false,
      modality: "embedding",
      messages: [],
      responseId: "resp_embedding_auth",
      embeddingInput: "hello world",
    },
    resolved,
  });

  assert.deepEqual(authorization, { useBudgetCap: true });
});

test("buildResolvedAuthorizationInput defers per-image authorization to budget cap", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "chatgpt-image-latest",
    provider: "openai",
    known: true,
    card: {
      modelId: "chatgpt-image-latest",
      name: "ChatGPT Image Latest",
      provider: "openai",
      type: "image-generation",
      description: null,
      input: ["text"],
      output: ["image"],
      capabilities: ["image-generation"],
      available: true,
      pricing: {
        sections: [
          {
            header: "Image generation",
            unit: "Per image",
            unitKey: "per_image_usd",
            entries: {
              cost: 0.009,
            },
            default: true,
          },
        ],
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const authorization = buildResolvedAuthorizationInput({
    request: {
      mode: "responses",
      model: "chatgpt-image-latest",
      provider: "openai",
      stream: false,
      modality: "image",
      messages: [{ role: "user", content: "Generate a skyline" }],
      responseId: "resp_image_auth",
      imageOptions: {},
      billingMetrics: {
        request: 1,
        generation: 1,
        image: 1,
      },
    },
    resolved,
  });

  assert.deepEqual(authorization, { useBudgetCap: true });
});

test("buildResolvedAuthorizationInput defers per-step media authorization to budget cap", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "accounts/fireworks/models/flux-1-schnell-fp8",
    provider: "fireworks",
    known: true,
    card: {
      modelId: "accounts/fireworks/models/flux-1-schnell-fp8",
      name: "FLUX.1 schnell FP8",
      provider: "fireworks",
      type: "text-to-image",
      description: null,
      input: ["text"],
      output: ["image"],
      capabilities: ["image-generation"],
      available: true,
      pricing: {
        unit: "per_step_usd",
        input: 0.00035,
        output: null,
        perStep: 0.00035,
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const authorization = buildResolvedAuthorizationInput({
    request: {
      mode: "responses",
      model: "accounts/fireworks/models/flux-1-schnell-fp8",
      provider: "fireworks",
      stream: false,
      modality: "image",
      messages: [{ role: "user", content: "Generate a skyline" }],
      responseId: "resp_fireworks_step_auth",
      customParams: {
        num_inference_steps: 4,
      },
      billingMetrics: {
        request: 1,
        num_inference_steps: 4,
      },
    },
    resolved,
  });

  assert.deepEqual(authorization, { useBudgetCap: true });
});

test("buildResolvedAuthorizationInput defers duration billing when video duration is omitted", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "sora-2",
    provider: "openai",
    known: true,
    card: {
      modelId: "sora-2",
      name: "Sora 2",
      provider: "openai",
      type: "text-to-video",
      description: null,
      input: ["text"],
      output: ["video"],
      capabilities: ["streaming"],
      available: true,
      pricing: {
        sections: [
          {
            header: "Video generation",
            unit: "Per second",
            unitKey: "per_second_usd",
            entries: {
              cost: 0.1,
            },
            default: true,
          },
        ],
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const authorization = buildResolvedAuthorizationInput({
    request: {
      mode: "responses",
      model: "sora-2",
      provider: "openai",
      stream: false,
      modality: "video",
      messages: [{ role: "user", content: "Generate a short clip" }],
      responseId: "resp_video_auth",
      videoOptions: {},
    },
    resolved,
  });

  assert.deepEqual(authorization, { useBudgetCap: true });
});

test("buildResolvedSettlementMeter hard-fails when authoritative media units are missing", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "openai/sora-2-t2v",
    provider: "openai",
    known: true,
    card: {
      modelId: "openai/sora-2-t2v",
      name: "Sora 2",
      provider: "openai",
      type: "videos",
      description: null,
      input: ["text"],
      output: ["video"],
      capabilities: ["streaming"],
      available: true,
      pricing: {
        unit: "usd_per_second",
        values: {
          second: 0.5,
        },
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  assert.throws(
    () =>
      buildResolvedSettlementMeter({
        resolved,
        modality: "video",
        media: {},
      }),
    /authoritative billable quantity is required/i,
  );
});

test("buildResolvedSettlementMeter accepts generic image megapixel aliases", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "image-processor",
    provider: "hugging face",
    known: true,
    card: {
      modelId: "image-processor",
      name: "Image Processor",
      provider: "hugging face",
      type: "image-to-image",
      description: null,
      input: ["image"],
      output: ["image"],
      capabilities: ["image-generation"],
      available: true,
      pricing: {
        unit: "usd_per_processed_megapixel",
        values: {
          processed_megapixel: 0.012,
        },
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const metered = buildResolvedSettlementMeter({
    resolved,
    modality: "image",
    media: {
      billingMetrics: {
        megapixel: 1.5,
      },
    },
  });

  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "processed_megapixel",
      unit: "usd_per_processed_megapixel",
      quantity: 1.5,
      unitPriceUsd: 0.012,
    },
  ]);
});

test("buildResolvedSettlementMeter accepts generic compute-second aliases", () => {
  const resolved: ResolvedBillingModel = {
    modelId: "image-compute",
    provider: "hugging face",
    known: true,
    card: {
      modelId: "image-compute",
      name: "Image Compute",
      provider: "hugging face",
      type: "text-to-image",
      description: null,
      input: ["text"],
      output: ["image"],
      capabilities: ["image-generation"],
      available: true,
      pricing: {
        unit: "usd_per_compute_second",
        values: {
          compute_second: 0.00167,
        },
      },
      contextWindow: {
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };

  const metered = buildResolvedSettlementMeter({
    resolved,
    modality: "image",
    media: {
      generatedSeconds: 3.25,
    },
  });

  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "compute_second",
      unit: "usd_per_compute_second",
      quantity: 3.25,
      unitPriceUsd: 0.00167,
    },
  ]);
});
