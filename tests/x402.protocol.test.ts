import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Request, Response } from "express";

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validatePaymentRequired } from "@x402/core/schemas";

import {
  COMPOSE_PAYMENT_INTENT_EXTENSION_KEY,
  COMPOSE_METERING_EXTENSION_KEY,
} from "../x402/facilitator.js";
import {
  createPaymentRequired402Response,
  prepareInferencePayment,
  settlePreparedInferencePayment,
} from "../x402/index.js";
import { quoteMeteredSettlement } from "../x402/metering.js";
import type { PriceLookupParams } from "../x402/types.js";

const X402_SOURCE = readFileSync(new URL("../x402/index.ts", import.meta.url), "utf8");

test("createPaymentRequired402Response emits spec-compliant x402 v2 payment requirements with compose extensions", () => {
  const body = createPaymentRequired402Response({
    amountWei: 1122,
    chainId: 43113,
    resourceUrl: "https://api.compose.market/agent/test/chat",
    errorMessage: "Payment required",
  });

  validatePaymentRequired(body);

  assert.equal(body.x402Version, 2);
  assert.equal(body.resource.url, "https://api.compose.market/agent/test/chat");
  assert.equal(body.accepts[0]?.scheme, "exact");
  assert.equal(body.accepts[0]?.network, "eip155:43113");
  assert.equal(body.accepts[0]?.amount, "1122");
  assert.equal("maxAmountRequired" in body.accepts[0]!, false);
  assert.deepEqual(body.extensions, {
    [COMPOSE_METERING_EXTENSION_KEY]: {
      mode: "authoritative_usage",
      meterEndpoint: "/api/payments/meter/model",
    },
    [COMPOSE_PAYMENT_INTENT_EXTENSION_KEY]: {
      authorizeEndpoint: "/api/payments/prepare",
      settleEndpoint: "/api/payments/settle",
      abortEndpoint: "/api/payments/abort",
    },
  });
});

test("PriceLookupParams uses canonical mcp source naming only", () => {
  const mcpPrice: PriceLookupParams = {
    toolSource: "mcp",
    toolName: "calendar",
  };
  const onchainPrice: PriceLookupParams = {
    toolSource: "onchain",
    toolName: "erc20_transfer",
    isTransaction: true,
  };
  const source = readFileSync(new URL("../x402/types.ts", import.meta.url), "utf8");

  assert.equal(mcpPrice.toolSource, "mcp");
  assert.equal(onchainPrice.toolSource, "onchain");
  assert.match(source, /toolSource\?: "onchain" \| "mcp"/);
  assert.doesNotMatch(source, /toolSource\?:[^;]*"tools"/);
  assert.doesNotMatch(source, /toolSource\?:[^;]*"goat"/);
});

test("prepareInferencePayment emits PAYMENT-REQUIRED header that matches the spec body", async () => {
  const headers: Record<string, string> = {
    host: "api.compose.market",
    "x-chain-id": "43113",
  };
  const req = {
    headers,
    method: "POST",
    originalUrl: "/agent/test/chat",
    url: "/agent/test/chat",
    body: {},
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
  const captured: {
    headers: Record<string, string>;
    statusCode: number | null;
    body: unknown;
  } = {
    headers: {},
    statusCode: null,
    body: null,
  };
  const res = {
    setHeader(name: string, value: number | string | readonly string[]) {
      captured.headers[name] = Array.isArray(value) ? value.join(",") : String(value);
      return this;
    },
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;

  const payment = await prepareInferencePayment(req, res, {
    useBudgetCap: true,
    scheme: "batch-settlement",
  });

  assert.equal(payment, null);
  assert.equal(captured.statusCode, 402);
  assert.equal(typeof captured.headers["PAYMENT-REQUIRED"], "string");

  const decoded = decodePaymentRequiredHeader(captured.headers["PAYMENT-REQUIRED"]!);
  assert.deepEqual(decoded, JSON.parse(JSON.stringify(captured.body)));
});

test("settlePreparedInferencePayment preserves x402 payment-required negotiation details on settlement failures", async () => {
  const paymentRequired = createPaymentRequired402Response({
    amountWei: 76,
    chainId: 43113,
    resourceUrl: "https://api.compose.market/v1/audio/speech",
    errorMessage: "Session expired or insufficient allowance",
  });

  await assert.rejects(
    settlePreparedInferencePayment(
      {
        maxAmountWei: "76",
        runtimeHeaders: {},
        settle: async () => ({
          success: false,
          error: "Session expired or insufficient allowance",
          statusCode: 402,
          paymentRequired,
          paymentRequiredHeader: "encoded-payment-required",
        }),
        abort: async () => undefined,
        applyHeaders: () => undefined,
      },
      {} as Response,
      { finalAmountWei: "76" },
    ),
    (error: unknown) => {
      if (!(error instanceof Error)) {
        return false;
      }

      const record = error as Error & {
        statusCode?: number;
        paymentRequired?: unknown;
        paymentRequiredHeader?: string;
      };
      return record.statusCode === 402
        && record.paymentRequired === paymentRequired
        && record.paymentRequiredHeader === "encoded-payment-required";
    },
  );
});

test("settlePreparedInferencePayment preserves granular metered receipt fields", async () => {
  const meter = {
    subject: "model:metered-test",
    lineItems: [
      {
        key: "request",
        unit: "usd_per_request",
        quantity: 1,
        unitPriceUsd: 0.001,
      },
    ],
  };
  const quoted = quoteMeteredSettlement(meter);

  const receipt = await settlePreparedInferencePayment(
    {
      maxAmountWei: "1000000",
      runtimeHeaders: {},
      settle: async () => ({
        success: true,
        txHash: "0xabc",
        finalAmountWei: quoted.finalAmountWei,
        providerAmountWei: quoted.providerAmountWei,
        platformFeeWei: quoted.platformFeeWei,
        meterSubject: quoted.subject,
        lineItems: quoted.lineItems,
        chainId: 43113,
        settledAt: 1_778_888_001,
      }),
      abort: async () => undefined,
      applyHeaders: () => undefined,
    },
    {} as Response,
    { meter },
  );

  assert.ok(receipt);
  assert.equal(receipt.finalAmountWei, quoted.finalAmountWei);
  assert.equal(receipt.providerAmountWei, quoted.providerAmountWei);
  assert.equal(receipt.platformFeeWei, quoted.platformFeeWei);
  assert.equal(receipt.meterSubject, quoted.subject);
  assert.deepEqual(receipt.lineItems, quoted.lineItems);
});

test("settlePreparedInferencePayment preserves settlement chain id for stream receipts", async () => {
  const receipt = await settlePreparedInferencePayment(
    {
      maxAmountWei: "1000000",
      runtimeHeaders: {},
      settle: async () => ({
        success: true,
        finalAmountWei: "8836",
        chainId: 43113,
        txHash: "0xagentsettlement",
      }),
      abort: async () => undefined,
      applyHeaders: () => undefined,
    },
    {} as Response,
    { finalAmountWei: "8836" },
  );

  assert.equal(receipt?.finalAmountWei, "8836");
  assert.equal(receipt?.chainId, 43113);
  assert.equal(receipt?.txHash, "0xagentsettlement");
});

test("terminal batch settlement kicks require real backing and shared worker locks", () => {
  assert.match(X402_SOURCE, /export async function kickBatchSettlement/);
  assert.match(X402_SOURCE, /positiveAmount\(settlement\.finalAmountWei\)/);
  assert.match(X402_SOURCE, /settlement\.txHash/);
  assert.match(X402_SOURCE, /settlement\.paymentIntentId/);
  assert.match(X402_SOURCE, /settlement\.sessionBudgetIntentId/);
  assert.match(X402_SOURCE, /settlement\.paymentChannelId && settlement\.paymentCumulativeAmountWei/);
  assert.match(X402_SOURCE, /redisSetNXEX\(\s*SETTLEMENT_KICK_LOCK_KEY/);
  assert.match(X402_SOURCE, /redisSetNXEX\(\s*SETTLEMENT_RUN_LOCK_KEY/);
  assert.match(X402_SOURCE, /void \(async \(\) =>/);
  assert.match(X402_SOURCE, /SETTLEMENT_KICK_RETRY_ATTEMPTS/);
  assert.match(X402_SOURCE, /SETTLEMENT_KICK_RETRY_MS/);
  assert.match(X402_SOURCE, /runBatchSettlementCycle\(nextReason\)/);
  assert.match(X402_SOURCE, /deduped/);
  assert.match(X402_SOURCE, /terminal kick exhausted retries/);
  assert.match(X402_SOURCE, /runNativeBatchSettlement/);
  assert.match(X402_SOURCE, /runBatchSettlement/);
  assert.doesNotMatch(X402_SOURCE, /triggerSettlementJob/);
  assert.doesNotMatch(X402_SOURCE, /SETTLEMENT_TRIGGER_URL/);
  assert.doesNotMatch(X402_SOURCE, /metadata\.google\.internal/);
  assert.doesNotMatch(X402_SOURCE, /export async function requirePayment/);
  assert.doesNotMatch(X402_SOURCE, /export async function prepareComposePayment/);
  assert.doesNotMatch(X402_SOURCE, /export async function handleX402Payment/);
  assert.doesNotMatch(X402_SOURCE, /consumeKeyBudget\([^)]*\)[\s\S]{0,160}settlementStatus: "queued"/);
});
