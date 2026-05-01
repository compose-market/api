import assert from "node:assert/strict";
import test from "node:test";
import type { ComposeReceipt } from "../http/request-context.js";

const ORIGINAL_ENV = {
  THIRDWEB_SECRET_KEY: process.env.THIRDWEB_SECRET_KEY,
  THIRDWEB_SERVER_WALLET_ADDRESS: process.env.THIRDWEB_SERVER_WALLET_ADDRESS,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  RUNTIME_INTERNAL_SECRET: process.env.RUNTIME_INTERNAL_SECRET,
};

async function importGatewayModule(): Promise<Record<string, unknown>> {
  delete process.env.THIRDWEB_SECRET_KEY;
  delete process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
  delete process.env.MERCHANT_WALLET_ADDRESS;
  delete process.env.RUNTIME_INTERNAL_SECRET;

  try {
    return await import("../inference/gateway.js") as Record<string, unknown>;
  } finally {
    process.env.THIRDWEB_SECRET_KEY = ORIGINAL_ENV.THIRDWEB_SECRET_KEY;
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = ORIGINAL_ENV.THIRDWEB_SERVER_WALLET_ADDRESS;
    process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS;
    process.env.RUNTIME_INTERNAL_SECRET = ORIGINAL_ENV.RUNTIME_INTERNAL_SECRET;
  }
}

test("gateway module does not export duplicate modality execution helpers", async () => {
  const gateway = await importGatewayModule();

  assert.equal("invokeUnified" in gateway, false);
  assert.equal("invokeImage" in gateway, false);
  assert.equal("invokeVideo" in gateway, false);
  assert.equal("invokeTTS" in gateway, false);
  assert.equal("invokeASR" in gateway, false);
  assert.equal("invokeEmbedding" in gateway, false);
  assert.equal("submitVideoJob" in gateway, false);
  assert.equal("checkVideoJobStatus" in gateway, false);
});

test("gateway receipt JSON helpers preserve canonical settlement data without unit flattening", async () => {
  const gateway = await importGatewayModule();
  const receiptForJsonBody = gateway.receiptForJsonBody as (
    receipt: ComposeReceipt | null,
  ) => Record<string, unknown> | undefined;
  const attachReceiptToJsonBody = gateway.attachReceiptToJsonBody as <T extends Record<string, unknown>>(
    body: T,
    receipt: ComposeReceipt | null,
  ) => T & { compose_receipt?: Record<string, unknown> };

  const receipt: ComposeReceipt = {
    subject: "model:video-special",
    lineItems: [
      {
        key: "megapixel",
        unit: "megapixel",
        quantity: 1.5,
        unitPriceUsd: 0.02,
        amountWei: "123",
      },
      {
        key: "compute_second",
        unit: "compute-second",
        quantity: 12,
        unitPriceUsd: 0.01,
        amountWei: "456",
      },
    ],
    providerAmountWei: "500",
    platformFeeWei: "79",
    finalAmountWei: "579",
    txHash: "0xabc",
    network: "eip155:43113",
    settledAt: 1_778_888_001,
  };

  assert.deepEqual(receiptForJsonBody(receipt), {
    subject: "model:video-special",
    line_items: [
      {
        key: "megapixel",
        unit: "megapixel",
        quantity: 1.5,
        unit_price_usd: 0.02,
        amount_wei: "123",
      },
      {
        key: "compute_second",
        unit: "compute-second",
        quantity: 12,
        unit_price_usd: 0.01,
        amount_wei: "456",
      },
    ],
    provider_amount_wei: "500",
    platform_fee_wei: "79",
    final_amount_wei: "579",
    tx_hash: "0xabc",
    network: "eip155:43113",
    settled_at: 1_778_888_001,
  });

  const responseBody = { created: 1, data: [{ url: "https://example.com/video.mp4" }] };
  assert.deepEqual(attachReceiptToJsonBody(responseBody, receipt), {
    created: 1,
    data: [{ url: "https://example.com/video.mp4" }],
    compose_receipt: receiptForJsonBody(receipt),
  });
  assert.deepEqual(responseBody, { created: 1, data: [{ url: "https://example.com/video.mp4" }] });
});
