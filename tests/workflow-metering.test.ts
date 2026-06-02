import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildUsageRecordSettlementMeter,
  type UsageRecord,
} from "../x402/metering.js";

test("buildUsageRecordSettlementMeter prices mixed workflow usage across models", () => {
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const seededModels = {
    lastUpdated: new Date().toISOString(),
    totalModels: 2,
    byProvider: {},
    byType: {},
    models: [
      {
        modelId: "o4-mini-deep-research",
        name: "O4 Mini Deep Research",
        provider: "openai",
        type: "chat-completions",
        description: null,
        input: ["text"],
        output: ["text"],
        capabilities: ["streaming"],
        available: true,
        pricing: {
          unit: "usd_per_1m_tokens",
          values: {
            input: 0.4,
            output: 1.6,
          },
        },
        contextWindow: 1_000_000,
      },
      {
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
        contextWindow: 1_000_000,
      },
    ],
  };
  fs.writeFileSync(path.join(dataDir, "models.json"), JSON.stringify(seededModels));
  fs.writeFileSync(path.join(dataDir, "models_extended.json"), JSON.stringify(seededModels));

  const usageRecords: UsageRecord[] = [
    {
      agentWallet: "coordinator",
      model: "o4-mini-deep-research",
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
      key: "openai:o4-mini-deep-research:input_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 2_000,
      unitPriceUsd: 1,
    },
    {
      key: "openai:o4-mini-deep-research:output_tokens",
      unit: "usd_per_1m_tokens",
      quantity: 500,
      unitPriceUsd: 4,
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
  assert.equal(metered.providerAmountWei, "4800");
  assert.equal(metered.platformFeeWei, "48");
  assert.equal(metered.finalAmountWei, "4848");

  fs.rmSync(dataDir, { recursive: true, force: true });
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
