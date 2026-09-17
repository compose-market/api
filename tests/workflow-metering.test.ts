import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsageRecordSettlementMeter,
  type UsageRecord,
} from "../x402/metering.js";

test("buildUsageRecordSettlementMeter prices mixed workflow usage across models", () => {
  const usageRecords: UsageRecord[] = [
    {
      agentWallet: "coordinator",
      model: "openai/gpt-5.4",
      inputTokens: 2_000,
      outputTokens: 500,
      totalTokens: 2_500,
      timestamp: Date.now(),
    },
    {
      agentWallet: "researcher",
      model: "gemini-2.5-flash",
      inputTokens: 1_000,
      outputTokens: 200,
      totalTokens: 1_200,
      timestamp: Date.now(),
    },
  ];

  const metered = buildUsageRecordSettlementMeter({
    subject: "workflow:0xabc",
    usageRecords,
  });

  assert.equal(metered.subject, "workflow:0xabc");
  assert.deepEqual(metered.meter.lineItems, [
    {
      key: "openai:gpt-5.4:input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 2_000,
      unitPriceUsd: 2.5,
    },
    {
      key: "openai:gpt-5.4:output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 500,
      unitPriceUsd: 15,
    },
    {
      key: "gemini:gemini-2.5-flash:input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 1_000,
      unitPriceUsd: 0.3,
    },
    {
      key: "gemini:gemini-2.5-flash:output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 200,
      unitPriceUsd: 2.5,
    },
  ]);
  assert.equal(metered.providerAmountWei, "13300");
  assert.equal(metered.platformFeeWei, "133");
  assert.equal(metered.finalAmountWei, "13433");
});

test("buildUsageRecordSettlementMeter hard-fails when authoritative usage records are missing", () => {
  assert.throws(
    () =>
      buildUsageRecordSettlementMeter({
        subject: "workflow:0xabc",
        usageRecords: [],
      }),
    /usageRecords must contain at least one authoritative usage record/i,
  );
});
