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

test("gateway accepts only canonical x402 payment backing rails", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");

  assert.doesNotMatch(
    source,
    /\bsessionBudgetIntentId\b/,
    "the gateway must not accept or propagate the removed Session-budget intent rail",
  );
});

test("inference checkpoints and receipt metadata complete before terminal events and EOF", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const closeStart = source.indexOf("function closeEventStream");
  const closeEnd = source.indexOf("function openEventStream", closeStart);
  const closeBody = source.slice(closeStart, closeEnd);
  assert.ok(closeBody.indexOf("res.write(formatCoreSSEDone())") < closeBody.indexOf("res.end()"));
  assert.doesNotMatch(closeBody, /await /);

  const directStart = source.indexOf('if (request.stream && args.shape === "responses" && !usesProviderStream(request))');
  const directEnd = source.indexOf('if (request.stream && usesProviderStream(request))', directStart);
  const directBody = source.slice(directStart, directEnd);
  const directSettle = directBody.indexOf("await finalizeDirectStreamPayment({");
  const directFinalizing = directBody.indexOf('status: "finalizing_payment"');
  const directReceipt = directBody.indexOf("toReceiptStreamEvent(receiptStreamPayload(receipt))");
  const directTerminal = directBody.lastIndexOf('type: "done"');
  const directClose = directBody.lastIndexOf("closeEventStream(args.res)");
  assert.ok(directSettle > 0, "direct Responses streams must enter the payment/terminal ordering boundary");
  assert.ok(directFinalizing > 0 && directFinalizing < directSettle, "direct streams must expose generation completion before payment finalization");
  assert.ok(directReceipt > directSettle, "direct stream receipt emission must be controlled by that boundary");
  assert.ok(directTerminal > directReceipt, "direct terminal event must follow receipt metadata");
  assert.ok(directClose > directTerminal, "direct EOF must follow the terminal event");

  const terminalStart = source.indexOf("const terminalEvent = pendingDoneEvent");
  const providerStart = source.lastIndexOf('if (request.stream && usesProviderStream(request))', terminalStart);
  const providerEnd = source.indexOf("return;", terminalStart);
  const providerBody = source.slice(providerStart, providerEnd);
  const flush = providerBody.indexOf("await settlementLane.flush()");
  const receipt = providerBody.indexOf("toReceiptStreamEvent(receiptStreamPayload(receipt))");
  const deferredImage = providerBody.indexOf("if (pendingImageCompleteEvent)");
  const finishItems = providerBody.indexOf("responsesEncoder.finishItems()");
  const terminal = providerBody.indexOf("const terminalEvent = pendingDoneEvent");
  const finalFlush = providerBody.lastIndexOf("await flushSettlement()", terminal);
  const providerFinalizing = providerBody.indexOf('status: "finalizing_payment"');
  const close = providerBody.indexOf("closeEventStream(args.res)", terminal);
  assert.ok(flush > 0, "provider streams must flush their serialized checkpoint lane");
  assert.ok(providerFinalizing > 0 && providerFinalizing < finalFlush, "provider streams must expose generation completion before the final settlement flush");
  assert.ok(receipt > 0 && receipt < terminal, "checkpoint receipts must precede the terminal semantic event");
  assert.ok(terminal > flush, "terminal semantic output must follow the final checkpoint flush");
  assert.ok(finalFlush > 0 && finalFlush < deferredImage, "image completion must follow the final checkpoint receipt");
  assert.ok(finalFlush < finishItems, "Responses item completion must follow the final checkpoint receipt");
  assert.ok(close > terminal, "DONE and EOF must follow the terminal semantic event");
  const finalOutputStart = providerBody.indexOf("let finalOutput: Output");
  const finalOutputEnd = providerBody.indexOf("if (pendingImageCompleteEvent)", finalOutputStart);
  const finalOutputBody = providerBody.slice(finalOutputStart, finalOutputEnd);
  assert.match(finalOutputBody, /modality: streamedImage \? "image" : request\.modality/);
  assert.match(finalOutputBody, /\.\.\.\(lastMedia \? \{ media: lastMedia \} : \{\}\)/);
});

test("cumulative stream settlement lane serializes authoritative cumulative snapshots", async () => {
  const gateway = await importGatewayModule();
  const createLane = gateway.createCumulativeSettlementLane;
  assert.equal(typeof createLane, "function", "gateway must expose the settlement lane for contract testing");

  const calls: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const lane = (createLane as (input: {
    settle: (output: Record<string, unknown>) => Promise<Receipt | null>;
    emitReceipt: (receipt: Receipt) => void;
  }) => {
    checkpoint: (output: Record<string, unknown>) => boolean;
    flush: () => Promise<void>;
    failure: () => Promise<never>;
    checkpointCount: () => number;
    hasEvidence: () => boolean;
  })({
    settle: async (output) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(output);
      order.push(`settle:${calls.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        finalAmountWei: String(calls.length),
        network: "eip155:5042002",
        settledAt: calls.length,
      };
    },
    emitReceipt: (receipt) => order.push(`receipt:${receipt.finalAmountWei}`),
  });

  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  }), true);
  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  }), false, "unchanged cumulative evidence must not create a checkpoint");
  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    media: {
      mimeType: "video/mp4",
      duration: 2,
      status: "completed",
      billingMetrics: {
        second: 2,
        resolution: "1080p",
        aspect_ratio: "16:9",
      },
    },
  }), true);
  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    media: {
      mimeType: "video/mp4",
      duration: 3,
      status: "completed",
      billingMetrics: {
        second: 3,
        resolution: "1080p",
        aspect_ratio: "16:9",
      },
    },
  }), true);

  await lane.flush();
  order.push("terminal");

  assert.equal(maxActive, 1, "settlement calls in one stream lane must never overlap");
  assert.equal(lane.hasEvidence(), true);
  assert.equal(lane.checkpointCount(), 3);
  assert.deepEqual(calls.map((call) => call.usage), [
    { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  ]);
  assert.deepEqual((calls[1]?.media), {
    mimeType: "video/mp4",
    duration: 2,
    status: "completed",
    billingMetrics: {
      second: 2,
      resolution: "1080p",
      aspect_ratio: "16:9",
    },
  });
  assert.deepEqual((calls[2]?.media), {
    mimeType: "video/mp4",
    duration: 3,
    status: "completed",
    billingMetrics: {
      second: 3,
      resolution: "1080p",
      aspect_ratio: "16:9",
    },
  });
  assert.deepEqual(order, ["settle:1", "receipt:1", "settle:2", "receipt:2", "settle:3", "receipt:3", "terminal"]);
});

test("gateway charges each stream checkpoint as cumulative quote minus prior charged quote", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const settleStart = source.indexOf("async function settlePaidInference");
  const settleEnd = source.indexOf("function metricDelta", settleStart);
  const settleBody = source.slice(settleStart, settleEnd);
  const executeStart = source.indexOf("export async function executeRequest");
  const executeEnd = source.indexOf("export async function handleResponses", executeStart);
  const executeBody = source.slice(executeStart, executeEnd);

  assert.match(settleBody, /differenceMeteredModelQuote/,
    "checkpoint settlement must subtract the prior successfully charged cumulative quote");
  assert.match(settleBody, /finalAmountWei:\s*quote\.finalAmountWei/,
    "settlement must receive the exact already-rounded checkpoint difference");
  assert.match(executeBody, /chargedCumulativeQuote/,
    "each request lane must retain its own last successfully charged cumulative quote");
});

test("gateway advances the financial watermark before receipt and evidence projection", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const settleStart = source.indexOf("async function settlePaidInference");
  const settleEnd = source.indexOf("function metricDelta", settleStart);
  const settleBody = source.slice(settleStart, settleEnd);
  const durableBackingCheck = settleBody.indexOf("Nonzero settlement is missing x402 payment backing");
  const backedCallback = settleBody.indexOf("args.onPaymentBacked?.");
  const evidenceProjection = settleBody.indexOf("await recordChargeEvidence");
  const receiptProjection = settleBody.indexOf("await finalizeReceipt");
  const settlementKick = settleBody.indexOf("await kickBatchSettlement");

  assert.ok(durableBackingCheck > 0, "nonzero settlement must be validated as durably backed");
  assert.ok(backedCallback > durableBackingCheck,
    "the financial watermark may advance only after durable backing is validated");
  assert.ok(backedCallback < evidenceProjection,
    "evidence projection failure must not leave the financial watermark stale");
  assert.ok(backedCallback < receiptProjection,
    "receipt projection failure must not leave the financial watermark stale");
  assert.ok(backedCallback < settlementKick,
    "settlement scheduling failure must not leave the financial watermark stale");

  const executeStart = source.indexOf("export async function executeRequest");
  const executeEnd = source.indexOf("export async function handleResponses", executeStart);
  const executeBody = source.slice(executeStart, executeEnd);
  const settleCall = executeBody.indexOf("await settlePaidInference({");
  const callbackStart = executeBody.indexOf("onPaymentBacked:", settleCall);
  const callbackEnd = executeBody.indexOf("},", callbackStart);
  const callbackBody = executeBody.slice(callbackStart, callbackEnd);

  assert.ok(callbackStart > settleCall, "stream settlement must provide a durable-backing callback");
  assert.match(callbackBody, /chargedCumulativeQuote\s*=\s*cumulativeQuote/);
  assert.match(callbackBody, /cumulativeSettlementAmountWei\s*\+=\s*BigInt\(settlement\.finalAmountWei\)/);
  assert.match(callbackBody, /settlementSequence\s*\+=\s*1/);
  assert.match(callbackBody, /paymentTerminal\s*=\s*true/);
});

test("cumulative stream settlement lane drains accepted checkpoints after the first failure", async () => {
  const gateway = await importGatewayModule();
  const createLane = gateway.createCumulativeSettlementLane as (input: {
    settle: (output: Record<string, unknown>) => Promise<Receipt | null>;
    emitReceipt: (receipt: Receipt) => void;
  }) => {
    checkpoint: (output: Record<string, unknown>) => boolean;
    flush: () => Promise<void>;
    failure: () => Promise<never>;
    checkpointCount: () => number;
  };
  const expected = new Error("settlement unavailable");
  const laterFailure = new Error("later settlement failure");
  const calls: Array<Record<string, unknown>> = [];
  const lane = createLane({
    settle: async (output) => {
      calls.push(output);
      throw calls.length === 1 ? expected : laterFailure;
    },
    emitReceipt: () => assert.fail("failed settlement cannot emit a receipt"),
  });

  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
  }), true);
  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
  }), true);
  assert.equal(lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
  }), true);
  assert.equal(lane.checkpointCount(), 3);

  await assert.rejects(lane.failure(), (error: unknown) => error === expected);
  assert.throws(() => lane.checkpoint({
    modality: "text",
    usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 },
  }), (error: unknown) => error === expected,
  "new deltas must be rejected with the original error after the first failure is observable");
  await assert.rejects(lane.flush(), (error: unknown) => error === expected);
  await assert.rejects(lane.flush(), (error: unknown) => error === expected);
  assert.equal(calls.length, 3, "all checkpoints accepted before failure must reach settlement exactly once");
  assert.deepEqual(calls.map((call) => call.usage), [
    { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
    { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
  ]);
});

test("provider stream errors checkpoint evidenced usage before abort and terminal error output", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const providerStart = source.indexOf('if (request.stream && usesProviderStream(request))');
  const providerEnd = source.indexOf("let routed:", providerStart);
  const providerBody = source.slice(providerStart, providerEnd);
  const usageUpdate = providerBody.indexOf("lastUsage = event.usage");
  const checkpoint = providerBody.indexOf("checkpointSettlement()", usageUpdate);
  const upstreamThrow = providerBody.indexOf('if (event.type === "error")', usageUpdate);
  assert.ok(usageUpdate > 0 && checkpoint > usageUpdate);
  assert.ok(checkpoint < upstreamThrow, "usage-bearing upstream errors must checkpoint before throwing");

  const catchStart = providerBody.lastIndexOf("} catch (error)");
  const catchBody = providerBody.slice(catchStart);
  const catchCheckpoint = catchBody.indexOf("checkpointSettlement(true)");
  const catchFlush = catchBody.indexOf("await settlementLane.flush()");
  const abort = catchBody.indexOf("await abortPaidInference");
  const terminalError = catchBody.indexOf("writeResponsesEvents", abort);
  assert.ok(catchCheckpoint > 0 && catchFlush > catchCheckpoint);
  assert.ok(abort > catchFlush, "evidenced settlement must flush before payment abort");
  assert.ok(terminalError > abort, "terminal error output must follow final settlement handling");
  assert.match(providerBody, /Promise\.race\(\[\s*iterator\.next\(\),\s*settlementLane\.failure\(\)/,
    "provider iteration must stop as soon as a checkpoint settlement fails");
  assert.match(catchBody, /await iterator\.return\?\.\(undefined\)/,
    "payment failure must cancel the upstream iterator");
});

test("direct stream failures and aborts settle evidenced output before terminal handling", async () => {
  const gateway = await importGatewayModule();
  const finalize = gateway.finalizeDirectStreamPayment as undefined | ((input: {
    output: Record<string, unknown>;
    settle: (output: Record<string, unknown>) => Promise<Receipt | null>;
    emitReceipt: (receipt: Receipt) => void;
    emitDone: () => void;
    emitError: (error: { code: string; message: string }) => void;
    terminalError?: { code: string; message: string };
    interruptedError?: Error;
  }) => Promise<"done" | "error">);
  assert.equal(typeof finalize, "function", "direct streams need one testable payment/terminal ordering boundary");

  const failedOrder: string[] = [];
  const failedResult = await finalize!({
    output: { modality: "video", media: { jobId: "job-1", status: "failed" } },
    settle: async () => {
      failedOrder.push("settle");
      return { finalAmountWei: "7", settlementStatus: "queued", network: "eip155:5042002" };
    },
    emitReceipt: () => failedOrder.push("receipt"),
    emitDone: () => failedOrder.push("done"),
    emitError: () => failedOrder.push("error"),
    terminalError: { code: "upstream_error", message: "video failed" },
  });
  assert.equal(failedResult, "error");
  assert.deepEqual(failedOrder, ["error"]);

  const abortOrder: string[] = [];
  const interrupted = new Error("client disconnected");
  await assert.rejects(finalize!({
    output: { modality: "video", media: { jobId: "job-2", status: "processing" } },
    settle: async () => {
      abortOrder.push("settle");
      return { finalAmountWei: "9", settlementStatus: "queued", network: "eip155:5042002" };
    },
    emitReceipt: () => abortOrder.push("receipt"),
    emitDone: () => abortOrder.push("done"),
    emitError: () => abortOrder.push("error"),
    interruptedError: interrupted,
  }), (error: unknown) => error === interrupted);
  assert.deepEqual(abortOrder, [], "disconnect before completion must not settle unevidenced video output");

  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const directStart = source.indexOf('if (request.stream && args.shape === "responses" && !usesProviderStream(request))');
  const directEnd = source.indexOf('if (request.stream && usesProviderStream(request))', directStart);
  const directBody = source.slice(directStart, directEnd);
  assert.match(directBody, /await finalizeDirectStreamPayment\(/,
    "the direct Responses stream branch must use the executable ordering boundary");
  const failureStart = directBody.indexOf('if (status.status === "failed")');
  const failureEnd = directBody.indexOf("if (Date.now() - startedAt", failureStart);
  assert.doesNotMatch(directBody.slice(failureStart, failureEnd), /args\.res\.write\(toErrorStreamEvent/,
    "video polling must defer terminal failure output until after settlement");
});

test("external execution lanes kick settlement independently", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const kickStart = source.indexOf("function shouldKickSettlement(req: Req)");
  const kickEnd = source.indexOf("function readHeader", kickStart);
  const kickBody = source.slice(kickStart, kickEnd);

  assert.doesNotMatch(kickBody, /x-execution-run-id/,
    "an external sibling or sub-agent identity must not suppress its payment lane");
  assert.match(kickBody, /return true/,
    "every durably backed checkpoint may elect one settlement kick owner");
});

test("provider EOF without a terminal event flushes evidence but never invents success", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const providerStart = source.indexOf('if (request.stream && usesProviderStream(request))');
  const providerEnd = source.indexOf("let routed:", providerStart);
  const providerBody = source.slice(providerStart, providerEnd);

  assert.match(providerBody, /sawProviderDone/,
    "the gateway must distinguish terminal provider output from transport EOF");
  assert.match(providerBody, /incomplete_provider_stream/,
    "incomplete EOF must enter the error path after its final evidenced checkpoint");
  assert.doesNotMatch(providerBody, /pendingDoneEvent \?\?/,
    "the gateway must not synthesize a successful done event when none arrived");
});

test("stream checkpoints preserve the single-use raw x402 rail", async () => {
  const gatewaySource = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const x402Source = await readFile(join(process.cwd(), "x402/index.ts"), "utf8");
  const providerStart = gatewaySource.indexOf('if (request.stream && usesProviderStream(request))');
  const providerEnd = gatewaySource.indexOf("let routed:", providerStart);
  const providerBody = gatewaySource.slice(providerStart, providerEnd);
  const functionSource = (name: string): string => {
    const start = x402Source.indexOf(`function ${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = x402Source.indexOf("\n}\n", start);
    assert.ok(end > start, `${name} must have a complete top-level body`);
    return x402Source.slice(start, end + 2);
  };
  const rawBatchBody = functionSource("createPreparedRawBatchPayment");
  const prepareRawBody = functionSource("prepareRawInferenceX402Payment");
  const verifiedBatchStart = prepareRawBody.indexOf("const verifiedBatchPayload");
  const singleUseStart = prepareRawBody.indexOf("let singleUseConsumed");
  assert.ok(verifiedBatchStart >= 0 && singleUseStart > verifiedBatchStart);
  const verifiedBatchBody = prepareRawBody.slice(verifiedBatchStart, singleUseStart);
  const rawExactOrUptoBody = prepareRawBody.slice(singleUseStart);

  assert.match(rawBatchBody, /settlementMode:\s*"continuous"/,
    "createPreparedRawBatchPayment must advertise continuous checkpoints");
  assert.doesNotMatch(rawBatchBody, /settlementMode:\s*"single"/,
    "a verified raw batch lane cannot degrade to single-use settlement");
  assert.match(verifiedBatchBody, /return createPreparedRawBatchPayment\(/,
    "verified raw batch payloads must delegate to the continuous batch rail");
  assert.match(rawExactOrUptoBody, /settlementMode:\s*"single"/,
    "raw exact and upto payloads must remain request-scoped single-use rails");
  assert.match(rawExactOrUptoBody, /if \(singleUseConsumed\)/,
    "raw exact and upto settlement must reject a second redemption");
  assert.match(rawExactOrUptoBody, /requirement\.scheme === "exact"/);
  assert.match(rawExactOrUptoBody, /requirement\.scheme === "upto"/);
  assert.match(providerBody, /paid\.payment\.settlementMode === "continuous"/);
  assert.match(providerBody, /if \(continuousSettlement\) checkpointSettlement\(\)/,
    "intermediate usage frames must not redeem a single-use raw authorization");
  assert.match(providerBody, /checkpointSettlement\(true\)/,
    "terminal or interrupted evidence must still settle once");
});

test("external first-event errors settle authoritative usage before preserving the HTTP error", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const providerStart = source.indexOf('if (request.stream && usesProviderStream(request))');
  const providerEnd = source.indexOf("let routed:", providerStart);
  const providerBody = source.slice(providerStart, providerEnd);
  const lane = providerBody.indexOf("createCumulativeSettlementLane");
  const firstRead = providerBody.indexOf("firstEvent = await iterator.next()");
  const firstError = providerBody.indexOf('firstEvent.value.type === "error"', firstRead);
  const checkpoint = providerBody.indexOf("checkpointSettlement(true)", firstError);
  const flush = providerBody.indexOf("await flushSettlement()", checkpoint);
  const errorThrow = providerBody.indexOf("throw Object.assign", firstError);

  assert.ok(lane > 0 && lane < firstRead, "the payment lane must exist before external first-event inspection");
  assert.ok(firstError > firstRead && checkpoint > firstError);
  assert.ok(flush > checkpoint && flush < errorThrow,
    "usage-bearing first-event errors must settle before the original error is propagated");
});

test("provider streams checkpoint usage-bearing text, tool, and heartbeat events without billing empty pings", async () => {
  const source = await readFile(join(process.cwd(), "inference/gateway.ts"), "utf8");
  const providerStart = source.indexOf('if (request.stream && usesProviderStream(request))');
  const providerEnd = source.indexOf("let routed:", providerStart);
  const providerBody = source.slice(providerStart, providerEnd);
  const loop = providerBody.indexOf("for await (const event of events())");
  const usage = providerBody.indexOf("if (event.usage) lastUsage = event.usage", loop);
  const checkpoint = providerBody.indexOf("if (continuousSettlement", usage);
  const textBranch = providerBody.indexOf('event.type === "text-delta"', loop);
  const ping = providerBody.indexOf('args.res.write(": ping\\n\\n")');
  const clear = providerBody.indexOf("clearInterval(providerKeepalive)", ping);

  assert.ok(usage > loop && checkpoint > usage && checkpoint < textBranch,
    "all usage-bearing event kinds must checkpoint before their semantic frame is emitted");
  assert.ok(ping > 0 && clear > ping, "provider streams must keep external clients alive and clean up the timer");
  assert.doesNotMatch(providerBody.slice(ping - 200, ping + 200), /checkpointSettlement/,
    "transport-only pings must remain non-billable");
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
