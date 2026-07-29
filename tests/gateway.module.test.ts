import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt } from "../http/request-context.js";

const ORIGINAL_ENV = {
  THIRDWEB_SECRET_KEY: process.env.THIRDWEB_SECRET_KEY,
  THIRDWEB_SERVER_WALLET_ADDRESS: process.env.THIRDWEB_SERVER_WALLET_ADDRESS,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
};

async function importGatewayModule(): Promise<Record<string, unknown>> {
  delete process.env.THIRDWEB_SECRET_KEY;
  delete process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
  delete process.env.MERCHANT_WALLET_ADDRESS;

  try {
    return await import("../inference/gateway.js") as Record<string, unknown>;
  } finally {
    process.env.THIRDWEB_SECRET_KEY = ORIGINAL_ENV.THIRDWEB_SECRET_KEY;
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = ORIGINAL_ENV.THIRDWEB_SERVER_WALLET_ADDRESS;
    process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS;
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

test("external compatibility uses adapters without Compose state, retries, or deadlines", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const start = source.indexOf("export async function executeRequest");
  const end = source.indexOf("export async function handleResponses", start);
  const execute = source.slice(start, end);
  assert.match(execute, /args\.shape === "responses" && !externalCompatibility[\s\S]*hydrateResponsesRequest/);
  assert.match(execute, /store: args\.shape === "responses" && !externalCompatibility/);
  assert.match(execute, /retriesPerTarget: externalCompatibility \? 0 : undefined/);
  assert.match(execute, /externalCompatibility \? null : withDirectDeadline/);
  assert.doesNotMatch(source, /executeExternalWireRequest|upstream stream ended without terminal success/);
});

test("inference terminal event, DONE, and EOF are contiguous before settlement", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const closeStart = source.indexOf("function closeEventStream");
  const closeEnd = source.indexOf("function openEventStream", closeStart);
  const closeBody = source.slice(closeStart, closeEnd);
  assert.ok(closeBody.indexOf("res.write(formatCoreSSEDone())") < closeBody.indexOf("res.end()"));
  assert.doesNotMatch(closeBody, /await /);

  const terminalStart = source.indexOf("const terminalEvent = pendingDoneEvent");
  const settlementStart = source.indexOf("if (realtimeStream)", terminalStart);
  const terminalBody = source.slice(terminalStart, settlementStart);
  assert.match(terminalBody, /writeResponsesEvents|toChatStreamEvent/);
  assert.match(terminalBody, /closeEventStream\(args\.res\)/);
  assert.match(terminalBody, /lifecycle\.done\(\)/);
  assert.doesNotMatch(terminalBody, /await /);
});

test("gateway receipt JSON helpers preserve canonical settlement data without unit flattening", async () => {
  const gateway = await importGatewayModule();
  const receiptForJsonBody = gateway.receiptForJsonBody as (
    receipt: Receipt | null,
  ) => Record<string, unknown> | undefined;
  const attachReceiptToJsonBody = gateway.attachReceiptToJsonBody as <T extends Record<string, unknown>>(
    body: T,
    receipt: Receipt | null,
  ) => T & { receipt?: Record<string, unknown> };

  const receipt: Receipt = {
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
    network: "eip155:5042002",
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
    network: "eip155:5042002",
    settled_at: 1_778_888_001,
  });

  const responseBody = { created: 1, data: [{ url: "https://example.com/video.mp4" }] };
  assert.deepEqual(attachReceiptToJsonBody(responseBody, receipt), {
    created: 1,
    data: [{ url: "https://example.com/video.mp4" }],
    receipt: receiptForJsonBody(receipt),
  });
  assert.deepEqual(responseBody, { created: 1, data: [{ url: "https://example.com/video.mp4" }] });
});
