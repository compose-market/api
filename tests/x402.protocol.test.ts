import "dotenv/config";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
import { receiptFromInferenceSettlement } from "../x402/receipts.js";
import { quoteMeteredSettlement } from "../x402/metering.js";
import type { PriceLookupParams } from "../x402/types.js";

const X402_SOURCE = readFileSync(new URL("../x402/index.ts", import.meta.url), "utf8");
const FACILITATOR_SOURCE = readFileSync(new URL("../x402/facilitator.ts", import.meta.url), "utf8");
const BATCH_SOURCE = readFileSync(new URL("../x402/batch.ts", import.meta.url), "utf8");
const SETTLEMENT_SOURCE = readFileSync(new URL("../x402/settlement.ts", import.meta.url), "utf8");
const ENVELOPE_SOURCE = readFileSync(new URL("../x402/envelope.ts", import.meta.url), "utf8");

test("createPaymentRequired402Response emits spec-compliant x402 v2 payment requirements with compose extensions", () => {
  const body = createPaymentRequired402Response({
    amountWei: 1122,
    network: "eip155:84532",
    resourceUrl: "https://api.compose.market/agent/test/stream",
    errorMessage: "Payment required",
  });

  validatePaymentRequired(body);

  assert.equal(body.x402Version, 2);
  assert.equal(body.resource.url, "https://api.compose.market/agent/test/stream");
  assert.equal(body.accepts[0]?.scheme, "exact");
  assert.equal(body.accepts[0]?.network, "eip155:84532");
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
    "x-network-id": "eip155:84532",
  };
  const req = {
    headers,
    method: "POST",
    path: "/agent/test/stream",
    originalUrl: "/agent/test/stream",
    url: "/agent/test/stream",
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

test("raw x402 admission requires an explicit selected network", () => {
  assert.doesNotMatch(X402_SOURCE, /fallbackChainId|getActiveChainId/);
  assert.match(X402_SOURCE, /const requiredNetwork = getNetworkFromRequest\(req\)/);
  assert.match(X402_SOURCE, /x-network-id header is required/);
});

test("raw x402 rejects payment signatures whose network differs from the selected network", () => {
  const decode = X402_SOURCE.indexOf("paymentNetwork = getNetworkFromPaymentPayload(paymentPayload)");
  const reject = X402_SOURCE.indexOf("paymentNetwork !== requiredNetwork");
  const verify = X402_SOURCE.indexOf("const verifyResult = await verifyPayment");

  assert.ok(decode > 0);
  assert.ok(reject > decode);
  assert.ok(verify > reject);
});

test("raw x402 verification, envelopes, and settlement use the selected network", () => {
  assert.match(X402_SOURCE, /network: requiredNetwork,\s+scheme: requirement\.scheme/);
  assert.match(X402_SOURCE, /runtimeHeaders: rawRuntimeHeaders\(requiredNetwork, requirement\.maxAmountWei\)/);
  assert.match(X402_SOURCE, /network: requiredNetwork,\s+paymentPayload/);
  assert.match(X402_SOURCE, /inherited\.network !== requiredNetwork/);
  assert.doesNotMatch(X402_SOURCE, /network: paymentNetwork,\s+scheme: requirement\.scheme/);
});

test("SVM parity lives in the existing global x402 modules without scheme rewrites", () => {
  assert.equal(existsSync(new URL("../x402/svm.ts", import.meta.url)), false);

  assert.match(FACILITATOR_SOURCE, /class UptoSvmFacilitator/);
  assert.match(FACILITATOR_SOURCE, /readonly scheme = "upto"/);
  assert.match(FACILITATOR_SOURCE, /class BatchSettlementSvmFacilitator/);
  assert.match(FACILITATOR_SOURCE, /readonly scheme = "batch-settlement"/);
  assert.match(FACILITATOR_SOURCE, /new ExactSvmFacilitator\(signer\)/);
  assert.match(FACILITATOR_SOURCE, /new UptoSvmFacilitator\(feePayer\)/);
  assert.match(FACILITATOR_SOURCE, /new BatchSettlementSvmFacilitator\(feePayer\)/);
  assert.match(FACILITATOR_SOURCE, /SVM_FACILITATOR_KEY/);
  assert.doesNotMatch(FACILITATOR_SOURCE, /from "\.\/svm\.js"/);
  assert.doesNotMatch(FACILITATOR_SOURCE, /SvmParityScheme/);
  assert.doesNotMatch(FACILITATOR_SOURCE, /accepted\.scheme\s*=\s*"exact"/);

  assert.match(BATCH_SOURCE, /export async function validateSvmBatchPayment/);
  assert.match(BATCH_SOURCE, /export async function rememberSvmBatchChannel/);
  assert.match(BATCH_SOURCE, /export async function commitSvmBatchCharge/);
  assert.match(BATCH_SOURCE, /export async function runSvmBatchSettlement/);
  assert.match(BATCH_SOURCE, /settlementStatus: "queued"/);
  assert.doesNotMatch(BATCH_SOURCE, /from "\.\/svm\.js"/);

  assert.match(X402_SOURCE, /import\("\.\/batch\.js"\)/);
  assert.doesNotMatch(X402_SOURCE, /import\("\.\/svm\.js"\)/);
});

test("raw x402 immutable-backing failures return a corrective 402 identically on EVM and SVM", () => {
  // The corrective-402 helper exists in the prepare path.
  assert.match(X402_SOURCE, /rejectWithCorrectivePaymentRequired = \(error: unknown\): null =>/);

  // The network-agnostic channel-state calls are wrapped by the corrective catch.
  // rememberBatchChannel dispatches to rememberSvmBatchChannel for Solana and
  // saveRawEnvelope is network-agnostic, so this single wrap covers SVM and EVM alike.
  const channelBlockStart = X402_SOURCE.indexOf("let depositState = resumedDeposit;");
  const saveEnvelope = X402_SOURCE.indexOf("await saveRawEnvelope({", channelBlockStart);
  const rememberDispatcher = X402_SOURCE.indexOf(
    "await rememberBatchChannel(paymentPayload, verificationRequirement, verifyResult);",
    channelBlockStart,
  );
  const correctiveCatch = X402_SOURCE.indexOf(
    "return rejectWithCorrectivePaymentRequired(error);",
    channelBlockStart,
  );
  assert.ok(channelBlockStart > 0);
  assert.ok(saveEnvelope > channelBlockStart);
  assert.ok(rememberDispatcher > channelBlockStart);
  assert.ok(correctiveCatch > saveEnvelope);
  assert.ok(correctiveCatch > rememberDispatcher);

  // The wrapped saveRawEnvelope/voucher lane is not gated behind an EVM-only check,
  // so Solana channels recover via the same corrective challenge as EVM ones.
  const wrappedLane = X402_SOURCE.slice(saveEnvelope, correctiveCatch);
  assert.doesNotMatch(wrappedLane, /isEvmNetwork/);

  // The settle-path checkpoint failure (commitRawBatchCheckpoint is network-agnostic
  // and uses svm-hash channel storage for Solana) attaches a fresh payment-required
  // challenge so adaptError renders a true corrective 402 on both networks.
  const checkpointCatch = X402_SOURCE.indexOf("Raw batch checkpoint failed");
  assert.ok(checkpointCatch > 0);
  assert.match(
    X402_SOURCE.slice(checkpointCatch),
    /paymentRequired,\s+paymentRequiredHeader: encodePaymentRequiredHeader\(paymentRequired\)/,
  );

  // Parity seams: the wrapped recovery path is the shared network-neutral layer, not
  // an EVM-only one. rememberBatchChannel must dispatch Solana channels to
  // rememberSvmBatchChannel, and the single atomic checkpoint transition must enforce
  // identical immutable-backing checks for both evm-json and svm-hash channel storage.
  assert.match(BATCH_SOURCE, /await rememberSvmBatchChannel\(paymentPayload, requirements\)/);
  assert.match(ENVELOPE_SOURCE, /channelStorage: "evm-json" \| "svm-hash"/);
  assert.match(ENVELOPE_SOURCE, /if ARGV\[1\] == "evm-json" then/);
  assert.match(ENVELOPE_SOURCE, /elseif ARGV\[1\] == "svm-hash" then/);
});

test("SVM settlements carry a fixed public-safe explorer memo", () => {
  assert.match(SETTLEMENT_SOURCE, /SVM_SETTLEMENT_MEMO\s*=\s*"compose\.market: settle USDC"/);
  assert.match(SETTLEMENT_SOURCE, /appendSolanaTransactionMessageInstruction\(memoInstruction, message\)/);
  assert.doesNotMatch(SETTLEMENT_SOURCE, /SVM_SETTLEMENT_MEMO[^\n]*paymentIntentId/);
});

test("settlePreparedInferencePayment preserves x402 payment-required negotiation details on settlement failures", async () => {
  const paymentRequired = createPaymentRequired402Response({
    amountWei: 76,
    network: "eip155:5042002",
    resourceUrl: "https://api.compose.market/v1/audio/speech",
    errorMessage: "Session expired or insufficient allowance",
  });

  await assert.rejects(
    settlePreparedInferencePayment(
      {
        maxAmountWei: "76",
        settlementMode: "single",
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
      settlementMode: "single",
      runtimeHeaders: {},
      settle: async () => ({
        success: true,
        txHash: "0xabc",
        finalAmountWei: quoted.finalAmountWei,
        providerAmountWei: quoted.providerAmountWei,
        platformFeeWei: quoted.platformFeeWei,
        meterSubject: quoted.subject,
        lineItems: quoted.lineItems,
        network: "eip155:5042002",
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

test("raw x402 settlement receipts preserve the verified payer identity", async () => {
  const payer = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq";
  const settlement = await settlePreparedInferencePayment(
    {
      maxAmountWei: "1000000",
      settlementMode: "continuous",
      runtimeHeaders: {},
      settle: async () => ({
        success: true,
        userAddress: payer,
        finalAmountWei: "24",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        settledAt: 1_784_294_001,
        settlementStatus: "queued",
        paymentChannelId: "0xa45e9ee88304f93c0e744b3b0841840a9b745635d9d44e94c2abcb1a82f7a2b0",
        paymentCumulativeAmountWei: "1259",
      }),
      abort: async () => undefined,
      applyHeaders: () => undefined,
    },
    {} as Response,
    { finalAmountWei: "24" },
  );

  const receipt = receiptFromInferenceSettlement(settlement, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");

  assert.equal(receipt?.userAddress, payer);
  assert.equal(receipt?.network, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  assert.equal(receipt?.paymentChannelId, "0xa45e9ee88304f93c0e744b3b0841840a9b745635d9d44e94c2abcb1a82f7a2b0");
});

test("queued and submitted payment backing never invents a settlement timestamp", async () => {
  for (const settlementStatus of ["queued", "submitted"] as const) {
    const receipt = await settlePreparedInferencePayment(
      {
        maxAmountWei: "1000000",
        settlementMode: "continuous",
        runtimeHeaders: {},
        settle: async () => ({
          success: true,
          userAddress: "0x1111111111111111111111111111111111111111",
          finalAmountWei: "24",
          network: "eip155:5042002",
          settlementStatus,
          paymentIntentId: `intent-${settlementStatus}`,
          ...(settlementStatus === "submitted" ? { txHash: `0x${"78".repeat(32)}` } : {}),
        }),
        abort: async () => undefined,
        applyHeaders: () => undefined,
      },
      {} as Response,
      { finalAmountWei: "24" },
    );

    assert.equal(receipt?.settlementStatus, settlementStatus);
    assert.equal(receipt?.settledAt, undefined);
  }
});

test("settlePreparedInferencePayment preserves settlement chain id for stream receipts", async () => {
  const receipt = await settlePreparedInferencePayment(
    {
      maxAmountWei: "1000000",
      settlementMode: "single",
      runtimeHeaders: {},
      settle: async () => ({
        success: true,
        finalAmountWei: "8836",
        network: "eip155:5042002",
        txHash: "0xagentsettlement",
      }),
      abort: async () => undefined,
      applyHeaders: () => undefined,
    },
    {} as Response,
    { finalAmountWei: "8836" },
  );

  assert.equal(receipt?.finalAmountWei, "8836");
  assert.equal(receipt?.network, "eip155:5042002");
  assert.equal(receipt?.txHash, "0xagentsettlement");
});

test("terminal batch settlement kicks require real backing and shared worker locks", () => {
  assert.match(X402_SOURCE, /export async function kickBatchSettlement/);
  assert.match(X402_SOURCE, /positiveAmount\(settlement\.finalAmountWei\)/);
  assert.match(X402_SOURCE, /settlement\.txHash/);
  assert.match(X402_SOURCE, /settlement\.paymentIntentId/);
  assert.doesNotMatch(X402_SOURCE, /sessionBudgetIntentId|session_budget_intent_id/);
  assert.match(X402_SOURCE, /settlement\.paymentChannelId && settlement\.paymentCumulativeAmountWei/);
  assert.match(X402_SOURCE, /valkeySetNXEX\(\s*SETTLEMENT_KICK_LOCK_KEY/);
  assert.match(X402_SOURCE, /valkeySetNXEX\(\s*SETTLEMENT_RUN_LOCK_KEY/);
  assert.match(X402_SOURCE, /void \(async \(\) =>/);
  assert.match(X402_SOURCE, /SETTLEMENT_KICK_RETRY_ATTEMPTS/);
  assert.match(X402_SOURCE, /SETTLEMENT_KICK_RETRY_MS/);
  assert.match(X402_SOURCE, /runBatchSettlementCycle\(nextReason\)/);
  assert.match(X402_SOURCE, /deduped/);
  assert.match(X402_SOURCE, /terminal kick exhausted retries/);
  assert.match(X402_SOURCE, /let locked = false/);
  assert.match(X402_SOURCE, /finally \{\s+if \(locked\)/);
  assert.match(X402_SOURCE, /activeSettlementCycle = null/);
  assert.match(X402_SOURCE, /runNativeBatchSettlement/);
  assert.match(X402_SOURCE, /runBatchSettlement/);
  assert.doesNotMatch(X402_SOURCE, /triggerSettlementJob/);
  assert.doesNotMatch(X402_SOURCE, /SETTLEMENT_TRIGGER_URL/);
  assert.doesNotMatch(X402_SOURCE, /metadata\.google\.internal/);
  assert.doesNotMatch(X402_SOURCE, /export async function requirePayment/);
  assert.doesNotMatch(X402_SOURCE, /export async function preparePayment/);
  assert.doesNotMatch(X402_SOURCE, /export async function handleX402Payment/);
  assert.doesNotMatch(X402_SOURCE, /consumeKeyBudget\([^)]*\)[\s\S]{0,160}settlementStatus: "queued"/);
});

test("raw batch envelopes use one checkpoint authority and only verified batch payloads persist", () => {
  const rawBatchFactoryStart = X402_SOURCE.indexOf("function createPreparedRawBatchPayment");
  const rawBatchFactoryEnd = X402_SOURCE.indexOf("async function prepareRawInferenceX402Payment");
  const verifiedBatchGuardStart = X402_SOURCE.indexOf("const verifiedBatchPayload = getBatchPayload(paymentPayload)");
  const singleUseStart = X402_SOURCE.indexOf("let singleUseConsumed = false");
  const rawBatchFactory = X402_SOURCE.slice(rawBatchFactoryStart, rawBatchFactoryEnd);
  const verifiedBatchGuard = X402_SOURCE.slice(verifiedBatchGuardStart, singleUseStart);

  assert.ok(rawBatchFactoryStart >= 0 && rawBatchFactoryEnd > rawBatchFactoryStart);
  assert.ok(verifiedBatchGuardStart >= 0 && singleUseStart > verifiedBatchGuardStart);
  assert.match(rawBatchFactory, /commitRawBatchCheckpoint\(\{[\s\S]*?amountWei: finalAmountWei,[\s\S]*?rootRunId: input\.rootRunId,[\s\S]*?executionRunId: input\.executionRunId,[\s\S]*?sequence,/);
  assert.match(rawBatchFactory, /settlementStatus: "queued"/);
  assert.doesNotMatch(rawBatchFactory, /\bsettledAt\b|\btxHash\b/);

  assert.equal(X402_SOURCE.match(/await saveRawEnvelope\(/gu)?.length, 1);
  assert.match(verifiedBatchGuard, /if \(verifiedBatchPayload\) \{[\s\S]*?await saveRawEnvelope\(/);
  assert.doesNotMatch(X402_SOURCE, /\b(?:reserveRawEnvelope|releaseRawEnvelope|commitBatchCharge)\b/);
});
