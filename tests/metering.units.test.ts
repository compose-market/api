import assert from "node:assert/strict";
import test from "node:test";

import {
  differenceMeteredAmount,
  differenceMeteredModelQuote,
  quoteMeteredAuthorization,
  quoteMeteredSettlement,
  requestBillingMetricsForCheckpoint,
  type MeterLineItem,
  type MeteredModelQuote,
} from "../x402/metering.js";

test("cumulative checkpoint differences are partition-invariant after atomic rounding", () => {
  const first = quoteMeteredSettlement({
    subject: "openai:rounding-regression",
    lineItems: [{
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1,
      unitPriceUsd: 2,
    }],
  });
  const secondCumulative = quoteMeteredSettlement({
    subject: "openai:rounding-regression",
    lineItems: [{
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 2,
      unitPriceUsd: 2,
    }],
  });

  const firstCheckpoint = differenceMeteredAmount(first);
  const secondCheckpoint = differenceMeteredAmount(secondCumulative, first);

  assert.equal(firstCheckpoint.finalAmountWei, "3");
  assert.equal(secondCheckpoint.providerAmountWei, "2");
  assert.equal(secondCheckpoint.platformFeeWei, "0");
  assert.equal(secondCheckpoint.finalAmountWei, "2");
  assert.equal(
    BigInt(firstCheckpoint.finalAmountWei) + BigInt(secondCheckpoint.finalAmountWei),
    BigInt(secondCumulative.finalAmountWei),
  );
  assert.deepEqual(secondCheckpoint.lineItems, [{
    key: "input_tokens",
    unit: "usd_per_1m_tokens",
    quantity: 1,
    unitPriceUsd: 2,
    amountWei: "2",
  }]);
});

test("cumulative checkpoint differences reject regressing authoritative quotes", () => {
  const larger = quoteMeteredSettlement({
    subject: "openai:rounding-regression",
    lineItems: [{
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 2,
      unitPriceUsd: 2,
    }],
  });
  const smaller = quoteMeteredSettlement({
    subject: "openai:rounding-regression",
    lineItems: [{
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1,
      unitPriceUsd: 2,
    }],
  });

  assert.throws(
    () => differenceMeteredAmount(smaller, larger),
    /cumulative metered amount regressed/i,
  );
});

test("model checkpoint differences preserve delta telemetry and exact rounded amounts", () => {
  const modelQuote = (quantity: number): MeteredModelQuote => {
    const meter = {
      subject: "openai:rounding-regression",
      lineItems: [{
        key: "input_tokens",
        unit: "usd_per_1m_tokens",
        quantity,
        unitPriceUsd: 2,
      }],
    };
    return {
      modelId: "rounding-regression",
      provider: "openai",
      known: true,
      meter,
      telemetry: {
        subject: meter.subject,
        lineItems: meter.lineItems.map((item) => ({ ...item, source: "provider_response" as const })),
        metrics: { input_tokens: quantity },
      },
      ...quoteMeteredSettlement(meter),
    };
  };

  const first = modelQuote(1);
  const cumulative = modelQuote(2);
  const checkpoint = differenceMeteredModelQuote(cumulative, first);

  assert.equal(checkpoint.finalAmountWei, "2");
  assert.equal(checkpoint.platformFeeWei, "0");
  assert.deepEqual(checkpoint.meter.lineItems, [{
    key: "input_tokens",
    unit: "usd_per_1m_tokens",
    quantity: 1,
    unitPriceUsd: 2,
  }]);
  assert.deepEqual(checkpoint.telemetry?.metrics, { input_tokens: 1 });
  assert.deepEqual(checkpoint.telemetry?.lineItems, [{
    key: "input_tokens",
    unit: "usd_per_1m_tokens",
    quantity: 1,
    unitPriceUsd: 2,
    source: "provider_response",
  }]);
});

test("quoteMeteredSettlement prices mixed token line items with 1 percent fee", () => {
  const lineItems: MeterLineItem[] = [
    {
      key: "input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1_000,
      unitPriceUsd: 2,
    },
    {
      key: "output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 500,
      unitPriceUsd: 8,
    },
  ];

  const quoted = quoteMeteredSettlement({
    subject: "openai:gpt-4.1-mini",
    lineItems,
  });

  assert.equal(quoted.subject, "openai:gpt-4.1-mini");
  assert.equal(quoted.providerAmountWei, "6000");
  assert.equal(quoted.platformFeeWei, "60");
  assert.equal(quoted.finalAmountWei, "6060");
  assert.deepEqual(quoted.lineItems, [
    { ...lineItems[0], amountWei: "2000" },
    { ...lineItems[1], amountWei: "4000" },
  ]);
});

test("quoteMeteredAuthorization prices explicit media units", () => {
  const quoted = quoteMeteredAuthorization({
    subject: "openai:gpt-image-1",
    lineItems: [
      {
        key: "generation",
        unit: "usd_per_image",
        quantity: 2,
        unitPriceUsd: 0.04,
      },
    ],
  });

  assert.equal(quoted.providerAmountWei, "80000");
  assert.equal(quoted.platformFeeWei, "800");
  assert.equal(quoted.finalAmountWei, "80800");
});

test("quoteMeteredSettlement rejects empty metered line items", () => {
  assert.throws(
    () =>
      quoteMeteredSettlement({
        subject: "missing",
        lineItems: [],
      }),
    /lineItems must contain at least one priced quantity/i,
  );
});

test("later streaming checkpoints retain pricing selectors without repeating fixed request quantities", () => {
  const metrics = {
    request: 1,
    generation: 2,
    pixel: 2_097_152,
    size: "1024x1024",
    quality: "hd",
    transparent: false,
  };

  assert.deepEqual(requestBillingMetricsForCheckpoint(metrics, 0), metrics);
  assert.deepEqual(requestBillingMetricsForCheckpoint(metrics, 1), {
    size: "1024x1024",
    quality: "hd",
    transparent: false,
  });
});
