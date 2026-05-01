import assert from "node:assert/strict";
import test from "node:test";

import {
  quoteMeteredAuthorization,
  quoteMeteredSettlement,
  type MeterLineItem,
} from "../x402/metering.js";

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
