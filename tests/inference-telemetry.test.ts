import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthoritativeBilling,
  buildRequestBilling,
  extractAuthoritativeUsage,
  normalizeBillingPrice,
  type BillingPrice,
} from "../inference/telemetry.js";
import {
  buildSettlementMeterFromOutput,
  resolveBillingModel,
} from "../inference/billing-adapter.js";
import { quoteMeteredSettlement } from "../x402/metering.js";

test("normalizeBillingPrice accepts raw compiled token sections", () => {
  const pricing = normalizeBillingPrice({
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
  });

  assert.deepEqual(pricing, {
    unit: "usd_per_1m_tokens",
    values: {
      input: 0.4,
      cached_input: 0.1,
      output: 1.6,
    },
  });
});

test("normalizeBillingPrice canonicalizes explicit cache-write aliases", () => {
  for (const [key, price] of [["cache_writes", 1.25], ["input_token_cache_creation_5m", 0.713]] as const) {
    const pricing = normalizeBillingPrice({
      sections: [{
        header: "Text tokens",
        unit: "Per 1M tokens",
        unitKey: "per_1m_tokens_usd",
        entries: { input: 1, output: 6, [key]: price },
      }],
    });
    assert.equal(pricing.values.cache_write, price);
  }
});

test("normalizeBillingPrice excludes private batch embedding rows in favor of online text input", () => {
  const pricing = normalizeBillingPrice({
    sections: [
      {
        header: "Default",
        unit: "Per 1M tokens",
        unitKey: "per_1m_tokens_usd",
        entries: { embedding_token_batch: 0.035 },
        source: { rows: [{ type: "embedding_token_batch", priceName: "Embedding(Batch File)" }] },
        default: true,
      },
      {
        header: "Text tokens",
        unit: "Per 1M tokens",
        unitKey: "per_1m_tokens_usd",
        entries: { input: 0.07 },
        source: { rows: [{ type: "embedding_token", priceName: "Text Input" }] },
      },
    ],
  });

  assert.deepEqual(pricing, {
    unit: "usd_per_1m_tokens",
    values: { input: 0.07 },
  });
});

test("normalizeBillingPrice normalizes raw generation units without modality inference", () => {
  const pricing = normalizeBillingPrice({
    price_value_usd: 0.042,
    price_unit: "/gen",
  });

  assert.deepEqual(pricing, {
    unit: "usd_per_generation",
    values: {
      generation: 0.042,
    },
  });
});

test("normalizeBillingPrice normalizes raw duration units without modality inference", () => {
  const pricing = normalizeBillingPrice({
    price_usd: 0.105,
    price_unit: "Per/sec",
  });

  assert.deepEqual(pricing, {
    unit: "usd_per_second",
    values: {
      second: 0.105,
    },
  });
});

test("normalizeBillingPrice rejects ambiguous multi-section pricing without an explicit default", () => {
  assert.throws(
    () =>
      normalizeBillingPrice({
        sections: [
          {
            header: "Tier A",
            unit: "Per image",
            unitKey: "per_image_usd",
            entries: { cost: 0.01 },
          },
          {
            header: "Tier B",
            unit: "Per image",
            unitKey: "per_image_usd",
            entries: { cost: 0.02 },
          },
        ],
      }),
    /explicit default/i,
  );
});

test("buildAuthoritativeBilling derives token line items from final usage", () => {
  const pricing: BillingPrice = {
    unit: "usd_per_1m_tokens",
    values: {
      input: 0.5,
      output: 1.5,
    },
  };

  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-4.1-mini",
    modality: "text",
    pricing,
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1200,
      unitPriceUsd: 0.5,
      source: "provider_response",
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 300,
      unitPriceUsd: 1.5,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling derives token line items from raw compiled pricing", () => {
  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-4.1-mini",
    modality: "text",
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
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1200,
      unitPriceUsd: 0.4,
      source: "provider_response",
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 300,
      unitPriceUsd: 1.6,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling splits cached input tokens when pricing exposes cached_input", () => {
  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-4.1-mini",
    modality: "text",
    pricing: {
      unit: "usd_per_1m_tokens",
      values: {
        input: 0.4,
        cached_input: 0.1,
        output: 1.6,
      },
    },
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cachedInputTokens: 200,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "cached_input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 200,
      unitPriceUsd: 0.1,
      source: "provider_response",
    },
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1000,
      unitPriceUsd: 0.4,
      source: "provider_response",
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 300,
      unitPriceUsd: 1.6,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling prices cache reads and writes without double-billing input", () => {
  const billing = buildAuthoritativeBilling({
    subject: "anthropic:claude-sonnet",
    modality: "text",
    pricing: {
      unit: "usd_per_1m_tokens",
      values: { input: 0.4, cached_input: 0.1, cache_write: 0.5, output: 1.6 },
    },
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cachedInputTokens: 200,
      cacheWriteTokens: 100,
    },
  });
  assert.deepEqual(billing.lineItems.map(({ key, quantity }) => ({ key, quantity })), [
    { key: "cached_input_tokens", quantity: 200 },
    { key: "cache_write_input_tokens", quantity: 100 },
    { key: "input_tokens", quantity: 900 },
    { key: "output_tokens", quantity: 300 },
  ]);
  assert.equal(
    billing.lineItems.filter((item) => item.key.includes("input_tokens")).reduce((sum, item) => sum + item.quantity, 0),
    1200,
  );
});

test("unpriced cache-write evidence does not invalidate priced cache reads", () => {
  const billing = buildAuthoritativeBilling({
    subject: "fireworks:minimax-m3",
    modality: "text",
    pricing: {
      unit: "usd_per_1m_tokens",
      values: { input: 0.3, cached_input: 0.06, output: 1.2 },
    },
    usage: {
      promptTokens: 132,
      completionTokens: 24,
      totalTokens: 156,
      cachedInputTokens: 131,
      cacheWriteTokens: 131,
    },
  });
  assert.deepEqual(billing.lineItems.map(({ key, quantity }) => ({ key, quantity })), [
    { key: "cached_input_tokens", quantity: 131 },
    { key: "input_tokens", quantity: 1 },
    { key: "output_tokens", quantity: 24 },
  ]);
});

test("cached-input metrics are never inferred as cache-write usage", () => {
  const usage = extractAuthoritativeUsage({
    promptTokens: 132,
    completionTokens: 20,
    totalTokens: 152,
    billingMetrics: { cached_input_tokens: 131 },
  });
  assert.equal(usage.cachedInputTokens, 131);
  assert.equal(usage.cacheWriteTokens, undefined);
  assert.equal(usage.billingMetrics?.cache_write_input_tokens, undefined);
});

test("buildAuthoritativeBilling does not double-count reasoning tokens", () => {
  const pricing: BillingPrice = {
    unit: "usd_per_1m_tokens",
    values: {
      input: 0.5,
      output: 1.5,
      reasoning: 6,
    },
  };

  const billing = buildAuthoritativeBilling({
    subject: "openai:o4-mini",
    modality: "text",
    pricing,
    usage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      reasoningTokens: 80,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1200,
      unitPriceUsd: 0.5,
      source: "provider_response",
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 220,
      unitPriceUsd: 1.5,
      source: "provider_response",
    },
    {
      key: "reasoning_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 80,
      unitPriceUsd: 6,
      source: "provider_response",
    },
  ]);
});

test("Kimi completion billing includes its authoritative reasoning-token subset onchain", () => {
  const billing = buildAuthoritativeBilling({
    subject: "fireworks:kimi-k3",
    modality: "text",
    pricing: {
      unit: "usd_per_1m_tokens",
      values: { input: 3, output: 15 },
    },
    usage: {
      promptTokens: 18_033,
      completionTokens: 7_877,
      reasoningTokens: 7_331,
      totalTokens: 25_910,
    },
  });
  assert.deepEqual(billing.lineItems.map(({ key, quantity }) => ({ key, quantity })), [
    { key: "input_tokens", quantity: 18_033 },
    { key: "output_tokens", quantity: 7_877 },
  ]);
  assert.equal(billing.metrics.reasoning_tokens, 7_331);
  const quote = quoteMeteredSettlement({ subject: billing.subject, lineItems: billing.lineItems });
  assert.equal(quote.providerAmountWei, "172254");
  assert.equal(quote.platformFeeWei, "1723");
  assert.equal(quote.finalAmountWei, "173977");
});

test("buildAuthoritativeBilling derives image counts from media output", () => {
  const pricing: BillingPrice = {
    unit: "usd_per_image",
    values: {
      generation: 0.03,
    },
  };

  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-image-1",
    modality: "image",
    pricing,
    media: {
      generatedUnits: 2,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 2,
      unitPriceUsd: 0.03,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling derives output megapixels from registry media units", () => {
  const billing = buildAuthoritativeBilling({
    subject: "cloudflare:@cf/black-forest-labs/flux-2-klein-9b",
    modality: "image",
    pricing: {
      unit: "per megapixel (MP)",
      input: 0.015,
      output: 0.002,
    },
    media: {
      billingMetrics: {
        megapixel: 2,
      },
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "megapixel",
      unit: "usd_per_megapixel",
      quantity: 2,
      unitPriceUsd: 0.002,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling derives output 512x512 tiles from measured pixels", () => {
  const billing = buildAuthoritativeBilling({
    subject: "cloudflare:@cf/lykon/dreamshaper-8-lcm",
    modality: "image",
    pricing: {
      unit: "per 512x512 tile",
      input: 0.000059,
      output: 0.000287,
    },
    media: {
      billingMetrics: {
        pixel: 1024 * 1024,
      },
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "512x512_tile",
      unit: "usd_per_512x512_tile",
      quantity: 4,
      unitPriceUsd: 0.000287,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling derives composite tile-step media quantities", () => {
  const billing = buildAuthoritativeBilling({
    subject: "cloudflare:@cf/black-forest-labs/flux-1-schnell",
    modality: "image",
    pricing: {
      unit: "per 512 by 512 tile; per step",
      perImage: 0.000053,
      perStep: 0.00011,
    },
    media: {
      billingMetrics: {
        pixel: 1024 * 1024,
        steps: 8,
      },
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "512_by_512_tile_per_step",
      unit: "usd_per_512_by_512_tile_per_step",
      quantity: 32,
      unitPriceUsd: 0.00011,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling derives per-step media quantities from model param usage keys", () => {
  const billing = buildAuthoritativeBilling({
    subject: "fireworks:accounts/fireworks/models/flux-1-schnell-fp8",
    modality: "image",
    pricing: {
      unit: "per_step_usd",
      input: 0.00035,
      output: null,
      perStep: 0.00035,
    },
    media: {
      billingMetrics: {
        num_inference_steps: 4,
      },
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "step",
      unit: "usd_per_step",
      quantity: 4,
      unitPriceUsd: 0.00035,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling selects the declared default media pricing section", () => {
  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-image-1",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          entries: { cost: 0.011 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          entries: { cost: 0.042 },
        },
      ],
    },
    media: {
      generatedUnits: 1,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 1,
      unitPriceUsd: 0.011,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling derives OpenAI image token sections from raw provider usage", () => {
  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-image-1",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Text tokens",
          unit: "Per 1M tokens",
          unitKey: "per_1m_tokens_usd",
          default: true,
          entries: {
            input: 5,
          },
        },
        {
          header: "Image tokens",
          unit: "Per 1M tokens",
          unitKey: "per_1m_tokens_usd",
          default: true,
          entries: {
            input: 10,
            output: 40,
          },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          entries: { cost: 0.011 },
        },
      ],
    },
    usage: {
      promptTokens: 120,
      completionTokens: 300,
      totalTokens: 420,
      raw: {
        input_tokens: 120,
        output_tokens: 300,
        total_tokens: 420,
        input_tokens_details: {
          text_tokens: 20,
          image_tokens: 100,
        },
        output_tokens_details: {
          image_tokens: 300,
        },
      },
    },
    media: {
      generatedUnits: 1,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "text_input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 20,
      unitPriceUsd: 5,
      source: "provider_response",
    },
    {
      key: "image_input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 100,
      unitPriceUsd: 10,
      source: "provider_response",
    },
    {
      key: "image_output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 300,
      unitPriceUsd: 40,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling prefers authoritative image token usage over duplicate per-image display tiers", () => {
  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-image-1",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Text tokens",
          unit: "Per 1M tokens",
          unitKey: "per_1m_tokens_usd",
          default: true,
          entries: {
            input: 5,
          },
        },
        {
          header: "Image tokens",
          unit: "Per 1M tokens",
          unitKey: "per_1m_tokens_usd",
          default: true,
          entries: {
            input: 10,
            output: 40,
          },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          entries: { cost: 0.011 },
        },
      ],
    },
    usage: {
      promptTokens: 120,
      completionTokens: 300,
      totalTokens: 420,
      billingMetrics: {
        input_text_tokens: 20,
        input_image_tokens: 100,
        output_image_tokens: 300,
      },
    },
    media: {
      generatedUnits: 1,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "text_input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 20,
      unitPriceUsd: 5,
      source: "provider_response",
    },
    {
      key: "image_input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 100,
      unitPriceUsd: 10,
      source: "provider_response",
    },
    {
      key: "image_output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 300,
      unitPriceUsd: 40,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling can settle authoritative media tiers when display pricing exists but token usage is absent", () => {
  const billing = buildAuthoritativeBilling({
    subject: "openai:gpt-image-2",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Text tokens",
          unit: "Per 1M tokens",
          unitKey: "per_1m_tokens_usd",
          default: true,
          entries: {
            input: 5,
            output: 10,
          },
        },
        {
          header: "Image tokens",
          unit: "Per 1M tokens",
          unitKey: "per_1m_tokens_usd",
          default: true,
          entries: {
            input: 8,
            output: 32,
          },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          entries: { cost: 0.009 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          entries: { cost: 0.034 },
        },
      ],
    },
    media: {
      generatedUnits: 1,
      billingMetrics: {
        quality: "standard",
      },
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 1,
      unitPriceUsd: 0.009,
      source: "provider_response",
    },
  ]);
});

test("buildAuthoritativeBilling hard-fails when authoritative media units are missing", () => {
  const pricing: BillingPrice = {
    unit: "usd_per_second",
    values: {
      second: 0.25,
    },
  };

  assert.throws(
    () =>
      buildAuthoritativeBilling({
        subject: "alibaba:wan2.7-t2v",
        modality: "video",
        pricing,
        media: {},
      }),
    /authoritative billable quantity is required/i,
  );
});

test("buildRequestBilling authorizes generated audio minute units", () => {
  const billing = buildRequestBilling({
    subject: "elevenlabs:music_v1",
    modality: "audio",
    pricing: {
      unit: "usd_per_generated_audio_minute",
      values: { generated_audio_minute: 0.3 },
    },
    metrics: {
      request: 1,
      generated_audio_minute: 0.05,
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generated_audio_minute",
      unit: "usd_per_generated_audio_minute",
      quantity: 0.05,
      unitPriceUsd: 0.3,
      source: "request",
    },
  ]);
});

test("buildAuthoritativeBilling settles generated audio minute units", () => {
  const billing = buildAuthoritativeBilling({
    subject: "elevenlabs:music_v1",
    modality: "audio",
    pricing: {
      unit: "usd_per_generated_audio_minute",
      values: { generated_audio_minute: 0.3 },
    },
    media: {
      billingMetrics: {
        generated_audio_minute: 0.25,
      },
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generated_audio_minute",
      unit: "usd_per_generated_audio_minute",
      quantity: 0.25,
      unitPriceUsd: 0.3,
      source: "provider_response",
    },
  ]);
});

test("buildRequestBilling selects an unambiguous media pricing tier from custom params", () => {
  const billing = buildRequestBilling({
    subject: "test:gpt-image-quality-tiers",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          selector: { quality: "standard" },
          entries: { cost: 0.04 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          selector: { quality: "hd" },
          entries: { cost: 0.08 },
        },
      ],
    },
    metrics: {
      request: 1,
      generation: 1,
      image: 1,
      quality: "hd",
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 1,
      unitPriceUsd: 0.08,
      source: "request",
    },
  ]);
});

test("buildRequestBilling ignores non-priced image params that share section cardinality", () => {
  const billing = buildRequestBilling({
    subject: "test:gpt-image-quality-tiers",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          selector: { quality: "standard" },
          entries: { cost: 0.04 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          selector: { quality: "hd" },
          entries: { cost: 0.08 },
        },
      ],
    },
    metrics: {
      request: 1,
      generation: 1,
      image: 1,
      quality: "hd",
      style: "natural",
      response_format: "b64_json",
      size: "1024x1024",
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 1,
      unitPriceUsd: 0.08,
      source: "request",
    },
  ]);
});

test("buildRequestBilling accepts authoritative gpt-image quality tiers without treating equal-area sizes as ambiguous", () => {
  const billing = buildRequestBilling({
    subject: "test:gpt-image-quality-tiers",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          default: true,
          selector: { quality: "low" },
          entries: { cost: 0.011 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          selector: { quality: "medium" },
          entries: { cost: 0.042 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          selector: { quality: "high" },
          entries: { cost: 0.167 },
        },
      ],
    },
    metrics: {
      request: 1,
      generation: 1,
      image: 1,
      quality: "high",
      size: "1536x1024",
      response_format: "url",
    },
  });

  assert.deepEqual(billing.lineItems, [
    {
      key: "generation",
      unit: "usd_per_image",
      quantity: 1,
      unitPriceUsd: 0.167,
      source: "request",
    },
  ]);
});

test("buildRequestBilling rejects equally specific pricing selectors", () => {
  assert.throws(() => buildRequestBilling({
    subject: "test:ambiguous-quality-tiers",
    modality: "image",
    pricing: {
      sections: [
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          selector: { quality: "high" },
          entries: { cost: 0.1 },
        },
        {
          header: "Image generation",
          unit: "Per image",
          unitKey: "per_image_usd",
          selector: { quality: "high" },
          entries: { cost: 0.2 },
        },
      ],
    },
    metrics: { generation: 1, quality: "high" },
  }), /pricing is ambiguous for selected parameters/i);
});

test("extractAuthoritativeUsage normalizes response_metadata token_usage with reasoning tokens", () => {
  const usage = extractAuthoritativeUsage({
    response_metadata: {
      token_usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        total_tokens: 165,
        reasoning_tokens: 9,
      },
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 120,
    completionTokens: 45,
    reasoningTokens: 9,
    totalTokens: 165,
    source: "response_metadata",
  });
});

test("extractAuthoritativeUsage normalizes response_metadata tokenUsage in camelCase payloads", () => {
  const usage = extractAuthoritativeUsage({
    responseMetadata: {
      tokenUsage: {
        promptTokens: 463,
        completionTokens: 55,
        totalTokens: 518,
      },
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 463,
    completionTokens: 55,
    totalTokens: 518,
    source: "response_metadata",
  });
});

test("extractAuthoritativeUsage normalizes usage_metadata reasoning details", () => {
  const usage = extractAuthoritativeUsage({
    usage_metadata: {
      input_tokens: 120,
      output_tokens: 45,
      total_tokens: 165,
      output_token_details: {
        reasoning: 9,
      },
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 120,
    completionTokens: 45,
    reasoningTokens: 9,
    totalTokens: 165,
    source: "usage_metadata",
  });
});

test("extractAuthoritativeUsage normalizes Google usageMetadata thoughts tokens", () => {
  const usage = extractAuthoritativeUsage({
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 45,
      thoughtsTokenCount: 9,
      totalTokenCount: 174,
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 120,
    completionTokens: 54,
    reasoningTokens: 9,
    totalTokens: 174,
    source: "google_usage_metadata",
  });
});

test("extractAuthoritativeUsage unwraps nested outputs payloads", () => {
  const usage = extractAuthoritativeUsage({
    outputs: {
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 120,
    completionTokens: 45,
    totalTokens: 165,
    source: "direct_fields",
  });
});

test("extractAuthoritativeUsage hard-fails when no authoritative usage payload is present", () => {
  assert.throws(
    () => extractAuthoritativeUsage({ usage: {} }),
    /authoritative usage is required/i,
  );
});

test("buildSettlementMeterFromOutput settles single-modality gpt-image-2.5-flare and gpt-image-2.5-sunburst without provider token details", () => {
  for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    const resolved = resolveBillingModel(modelId);
    const quote = buildSettlementMeterFromOutput({
      resolved,
      request: {
        mode: "responses",
        model: modelId,
        stream: true,
        modality: "image",
        operation: "text-to-image",
        messages: [{ role: "user", content: "Generate a neon synthwave skyline" }],
        responseId: `resp_${modelId}`,
      },
      output: {
        modality: "image",
        media: { mimeType: "image/png", generatedUnits: 1 },
        usage: {
          promptTokens: 32,
          completionTokens: 1056,
          totalTokens: 1088,
        },
      },
    });

    assert.equal(quote.modelId, modelId);
    assert.ok(BigInt(quote.finalAmountWei) > 0n);
    const keys = quote.meter.lineItems.map((item) => item.key);
    assert.ok(keys.includes("text_input_tokens"), `expected text_input_tokens for ${modelId}`);
    assert.ok(keys.includes("image_output_tokens"), `expected image_output_tokens for ${modelId}`);
  }
});

test("buildSettlementMeterFromOutput settles mixed-modality image edit when provider supplies input_tokens_details without output_tokens_details", () => {
  const resolved = resolveBillingModel("gpt-image-2.5-flare");
  const quote = buildSettlementMeterFromOutput({
    resolved,
    request: {
      mode: "responses",
      model: "gpt-image-2.5-flare",
      stream: false,
      modality: "image",
      operation: "image-to-image",
      messages: [{ role: "user", content: "Change the sky to twilight" }],
      imageOptions: { imageUrl: "https://example.com/source.png" },
      responseId: "resp_edit_details",
    },
    output: {
      modality: "image",
      media: { mimeType: "image/png", generatedUnits: 1 },
      usage: {
        promptTokens: 220,
        completionTokens: 1056,
        totalTokens: 1276,
        raw: {
          input_tokens: 220,
          output_tokens: 1056,
          total_tokens: 1276,
          input_tokens_details: {
            text_tokens: 20,
            image_tokens: 200,
          },
        },
      },
    },
  });

  const byKey = new Map(quote.meter.lineItems.map((item) => [item.key, item.quantity]));
  assert.equal(byKey.get("text_input_tokens"), 20);
  assert.equal(byKey.get("image_input_tokens"), 200);
  assert.equal(byKey.get("image_output_tokens"), 1056);
});
