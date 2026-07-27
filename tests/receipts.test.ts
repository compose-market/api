import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { registerManowarRoutes } from "../routes.js";
import {
  buildAgentTextSettlement,
  buildBills,
} from "../x402/receipts.js";
import { closeValkey } from "../x402/keys/valkey.js";
import { quoteMeteredSettlement } from "../x402/metering.js";
import type { Receipt } from "../http/request-context.js";

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

test("agent settlement meters include granular nested models_call bills", () => {
  const settlement = buildAgentTextSettlement({
    model: "asi1-mini",
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    billingMetrics: {
      input_text_tokens: 1000,
      output_text_tokens: 500,
    },
    meters: [{
      kind: "model",
      source: "models_call",
      model: "@cf/leonardo/lucid-origin",
      modality: "image",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        billingMetrics: { tile: 1 },
      },
      media: {
        billingMetrics: { tile: 1 },
        requests: 1,
      },
      responseId: "resp_img",
    }],
  });
  const quoted = quoteMeteredSettlement(settlement.meter);
  const receipt: Receipt = {
    service: "agent",
    action: "agent-stream",
    subject: quoted.subject,
    lineItems: quoted.lineItems,
    providerAmountWei: quoted.providerAmountWei,
    platformFeeWei: quoted.platformFeeWei,
    finalAmountWei: quoted.finalAmountWei,
    network: "eip155:43114",
    settledAt: 1,
  };

  const bills = buildBills(receipt);
  const kinds = bills.map((bill) => bill.kind).sort();

  assert.deepEqual(kinds, ["agent", "model"]);
  assert.ok(bills.some((bill) => bill.kind === "model" && bill.source === "models_call"));
  assert.ok(quoted.lineItems.some((item) => item.key.startsWith("model.models_call.cloudflare:@cf/leonardo/lucid-origin:")));
});

test("nested model meters fail closed without canonical modality evidence", () => {
  assert.throws(
    () => buildAgentTextSettlement({
      model: "asi1-mini",
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      billingMetrics: {
        input_text_tokens: 1000,
        output_text_tokens: 500,
      },
      meters: [{
        kind: "model",
        source: "models_call",
        model: "@cf/leonardo/lucid-origin",
        usage: { billingMetrics: { tile: 1 } },
        media: { billingMetrics: { tile: 1 }, requests: 1 },
      }],
    }),
    /meter modality is required/,
  );
});

test("receipt listing requires x-session-user-address header", async () => {
  const app = express();
  registerManowarRoutes(app);
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/receipts?network=eip155%3A43114`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("receipt listing returns authorized receipts", async () => {
  const userAddress = wallet();

  const app = express();
  registerManowarRoutes(app);
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;

    const authorized = await fetch(`http://127.0.0.1:${port}/api/receipts?network=eip155%3A43114`, {
      headers: { "x-session-user-address": userAddress, "x-network-id": "eip155:43114" },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json() as { userAddress?: string };
    assert.equal(body.userAddress, userAddress);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeValkey();
  }
});
