import "dotenv/config";

import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validatePaymentRequired } from "@x402/core/schemas";

import {
  COMPOSE_PAYMENT_INTENT_EXTENSION_KEY,
  COMPOSE_METERING_EXTENSION_KEY,
} from "../x402/facilitator.js";
import {
  createPaymentRequired402Response,
  extractPaymentInfo,
  handleX402Payment,
  settlePreparedInferencePayment,
} from "../x402/index.js";

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

test("extractPaymentInfo ignores legacy X-PAYMENT headers", () => {
  const paymentInfo = extractPaymentInfo({
    "x-payment": "legacy-cronos-header",
    "x-session-active": "true",
    "x-session-budget-remaining": "25",
  });

  assert.equal(paymentInfo.paymentData, null);
  assert.equal(paymentInfo.sessionActive, true);
  assert.equal(paymentInfo.sessionBudgetRemaining, 25);
});

test("handleX402Payment emits PAYMENT-REQUIRED header that matches the spec body", async () => {
  const result = await handleX402Payment(
    null,
    "https://api.compose.market/agent/test/chat",
    "POST",
    "321",
    43113,
  );

  assert.equal(result.status, 402);
  assert.equal(typeof result.responseHeaders["PAYMENT-REQUIRED"], "string");

  const decoded = decodePaymentRequiredHeader(result.responseHeaders["PAYMENT-REQUIRED"]!);
  assert.deepEqual(decoded, result.responseBody);
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

test("settlePreparedInferencePayment preserves settlement chain id for stream receipts", async () => {
  const receipt = await settlePreparedInferencePayment(
    {
      maxAmountWei: "1000000",
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
