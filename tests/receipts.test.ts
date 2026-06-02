import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { registerWorkflowRoutes } from "../routes.js";
import {
  buildAgentTextSettlement,
  buildReceiptBills,
} from "../x402/receipts.js";
import { quoteMeteredSettlement } from "../x402/metering.js";
import { createComposeKey } from "../x402/keys/storage.js";
import { redisDel, redisSRem } from "../x402/keys/redis.js";
import type { Receipt } from "../http/request-context.js";

const ORIGINAL_COMPOSE_SESSION_SECRET = process.env.COMPOSE_SESSION_SECRET;

function wallet(): `0x${string}` {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}` as `0x${string}`;
}

function composeKeyRecordKey(keyId: string): string {
  return `compose-key:${keyId}`;
}

function userKeysKey(userAddress: string): string {
  return `user-keys:${userAddress.toLowerCase()}`;
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
    action: "agent-chat",
    subject: quoted.subject,
    lineItems: quoted.lineItems,
    providerAmountWei: quoted.providerAmountWei,
    platformFeeWei: quoted.platformFeeWei,
    finalAmountWei: quoted.finalAmountWei,
    network: "eip155:43114",
    settledAt: 1,
  };

  const bills = buildReceiptBills(receipt);
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

test("receipt listing uses ComposeKey identity instead of userAddress query trust", {
  skip: !process.env.REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT || !process.env.REDIS_KEYS_DEFAULT_PASSWORD,
}, async () => {
  process.env.COMPOSE_SESSION_SECRET ||= "test-compose-session-secret";
  const userAddress = wallet();
  const otherAddress = wallet();
  let keyId: string | undefined;

  const created = await createComposeKey(userAddress, {
    budgetLimit: 1_000_000,
    expiresAt: Date.now() + 10 * 60 * 1000,
    purpose: "api",
    chainId: 43114,
    name: "receipts-test",
  });
  keyId = created.keyId;

  const app = express();
  registerWorkflowRoutes(app);
  const server = app.listen(0);
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/receipts?userAddress=${otherAddress}&chainId=43114`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/receipts?userAddress=${otherAddress}&chainId=43114`, {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json() as { userAddress?: string };
    assert.equal(body.userAddress, userAddress.toLowerCase());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (keyId) {
      await redisDel(composeKeyRecordKey(keyId));
      await redisSRem(userKeysKey(userAddress), keyId);
    }
    if (ORIGINAL_COMPOSE_SESSION_SECRET === undefined) {
      delete process.env.COMPOSE_SESSION_SECRET;
    } else {
      process.env.COMPOSE_SESSION_SECRET = ORIGINAL_COMPOSE_SESSION_SECRET;
    }
  }
});
