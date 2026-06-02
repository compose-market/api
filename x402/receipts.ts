import { randomUUID } from "node:crypto";

import { normalizeResponsesRequest, type ReceiptStreamPayload, type Modality } from "../inference/core.js";
import { isCanonicalModality } from "../inference/catalog/modalities/index.js";
import {
  encodeReceiptHeader,
  RECEIPT_HEADER,
  type Receipt,
  type ReceiptBill,
  type ReceiptLineItem,
} from "../http/request-context.js";
import type { InferenceSettlementReceipt } from "./index.js";
import {
  redisExpire,
  redisGet,
  redisHGetAll,
  redisHIncrByAmount,
  redisHSet,
  redisSAdd,
  redisSMembers,
  redisSet,
} from "./keys/redis.js";
import {
  buildResolvedSettlementMeter,
  meterSubject,
  resolveBillingModel,
  type MeteredSettlementInput,
  type MeterLineItem,
} from "./metering.js";

export type RouteSettlement =
  | { meter: MeteredSettlementInput }
  | {
    meter?: undefined;
    finalAmountWei: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    meterSubject?: string;
    lineItems?: ReceiptLineItem[];
    bills?: ReceiptBill[];
    evidence?: {
      kind: "agent" | "model" | "tool" | "search" | "memory" | "connector";
      rootRunId: string;
      executionRunId: string;
      parentExecutionRunId?: string;
      walletAddress?: string;
      name?: string;
      service?: string;
      action?: string;
      subject?: string;
      providerAmountWei: string;
      composeFeeWei: string;
      creatorFeeWei?: string;
    };
  };

export interface ReceiptContext {
  service?: string;
  action?: string;
  resource?: string;
  userAddress?: string;
  chainId?: number;
}

export interface ReceiptListResult {
  userAddress: string;
  chainId: number;
  cumulative: {
    totalAmountWei: string;
    providerAmountWei: string;
    platformFeeWei: string;
    receiptCount: number;
  };
  receipts: Receipt[];
}

export interface SettledIntentReceiptBody {
  finalAmountWei?: string;
  txHash?: string;
  meterSubject?: string;
  lineItems?: Receipt["lineItems"];
  providerAmountWei?: string;
  platformFeeWei?: string;
}

export interface MeterRecord {
  kind?: "model";
  source?: string;
  model?: string;
  name?: string;
  modality?: string;
  usage?: Record<string, unknown>;
  media?: Record<string, unknown>;
  responseId?: string;
}

type HeaderSink = {
  headersSent?: boolean;
  setHeader: (name: string, value: string) => unknown;
};

const RECEIPT_TTL_SECONDS = 60 * 60 * 24 * 180;
const RECEIPT_KEY_PREFIX = "x402:receipt";

function network(chainId: number | undefined): `eip155:${number}` | null {
  return typeof chainId === "number" && Number.isFinite(chainId)
    ? `eip155:${chainId}` as `eip155:${number}`
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function receiptKey(receiptId: string): string {
  return `${RECEIPT_KEY_PREFIX}:${receiptId}`;
}

function userReceiptsKey(userAddress: string, chainId: number): string {
  return `${RECEIPT_KEY_PREFIX}:user:${userAddress.toLowerCase()}:${chainId}`;
}

function userAggregateKey(userAddress: string, chainId: number): string {
  return `${RECEIPT_KEY_PREFIX}:aggregate:${userAddress.toLowerCase()}:${chainId}`;
}

function batchReceiptsKey(channelId: string): string {
  return `${RECEIPT_KEY_PREFIX}:batch:${channelId.toLowerCase()}`;
}

function intentReceiptsKey(intentId: string): string {
  return `${RECEIPT_KEY_PREFIX}:intent:${intentId}`;
}

function sessionReceiptsKey(intentId: string): string {
  return `${RECEIPT_KEY_PREFIX}:session:${intentId}`;
}

function addWei(a: string | undefined, b: string | undefined): string {
  return ((a ? BigInt(a) : 0n) + (b ? BigInt(b) : 0n)).toString();
}

function scope(prefix: string, lineItems: MeterLineItem[]): MeterLineItem[] {
  return lineItems.map((item) => ({
    ...item,
    key: `${prefix}:${item.key}`,
  }));
}

function parseNestedBill(item: ReceiptLineItem): {
  kind: ReceiptBill["kind"];
  source?: string;
  subject?: string;
} | null {
  const match = /^(model|tool|search|memory|connector)\.([^.]+)\.(.+):[^:]+$/u.exec(item.key);
  if (!match) {
    return null;
  }
  return {
    kind: match[1] as ReceiptBill["kind"],
    source: match[2],
    subject: match[3],
  };
}

function billKeyForItem(item: ReceiptLineItem, receipt: Receipt): string {
  const parsed = parseNestedBill(item);
  if (parsed) {
    return [parsed.kind, parsed.source, parsed.subject].filter(Boolean).join(":");
  }
  const kind = receipt.service === "workflow" ? "workflow" : "agent";
  return [kind, receipt.action, receipt.subject].filter(Boolean).join(":");
}

export function buildReceiptBills(receipt: Receipt): ReceiptBill[] {
  const lineItems = receipt.lineItems || [];
  const grouped = new Map<string, ReceiptBill>();

  for (const item of lineItems) {
    const parsed = parseNestedBill(item);
    const kind = parsed?.kind ?? (receipt.service === "workflow" ? "workflow" : "agent");
    const source = parsed?.source ?? receipt.service;
    const subject = parsed?.subject ?? receipt.subject;
    const key = billKeyForItem(item, receipt);
    const existing = grouped.get(key);
    if (existing) {
      existing.lineItems.push(item);
      existing.amountWei = addWei(existing.amountWei, item.amountWei);
      continue;
    }

    grouped.set(key, {
      kind,
      source,
      action: parsed?.source ?? receipt.action,
      subject,
      amountWei: item.amountWei,
      lineItems: [item],
    });
  }

  return [...grouped.values()];
}

async function cumulativeFor(userAddress: string, chainId: number): Promise<Receipt["cumulative"]> {
  const aggregate = await redisHGetAll(userAggregateKey(userAddress, chainId));
  return {
    totalAmountWei: aggregate.totalAmountWei || "0",
    providerAmountWei: aggregate.providerAmountWei || "0",
    platformFeeWei: aggregate.platformFeeWei || "0",
    receiptCount: Number.parseInt(aggregate.receiptCount || "0", 10) || 0,
  };
}

export async function storeReceipt(receipt: Receipt): Promise<Receipt> {
  if (!receipt.userAddress) {
    return receipt;
  }

  const [, chainIdPart] = receipt.network.split(":");
  const chainId = Number.parseInt(chainIdPart, 10);
  if (!Number.isFinite(chainId)) {
    return receipt;
  }

  const userAddress = receipt.userAddress.toLowerCase();
  const id = receipt.id || `rct_${randomUUID().replace(/-/g, "")}`;
  const full: Receipt = {
    ...receipt,
    id,
    userAddress,
    bills: receipt.bills && receipt.bills.length > 0 ? receipt.bills : buildReceiptBills(receipt),
  };

  await redisSet(receiptKey(id), JSON.stringify(full), RECEIPT_TTL_SECONDS);
  await redisSAdd(userReceiptsKey(userAddress, chainId), id);
  await redisExpire(userReceiptsKey(userAddress, chainId), RECEIPT_TTL_SECONDS);
  if (full.paymentChannelId) {
    await redisSAdd(batchReceiptsKey(full.paymentChannelId), id);
    await redisExpire(batchReceiptsKey(full.paymentChannelId), RECEIPT_TTL_SECONDS);
  }
  if (full.paymentIntentId) {
    await redisSAdd(intentReceiptsKey(full.paymentIntentId), id);
    await redisExpire(intentReceiptsKey(full.paymentIntentId), RECEIPT_TTL_SECONDS);
  }
  if (full.sessionBudgetIntentId) {
    await redisSAdd(sessionReceiptsKey(full.sessionBudgetIntentId), id);
    await redisExpire(sessionReceiptsKey(full.sessionBudgetIntentId), RECEIPT_TTL_SECONDS);
  }

  const aggregateKey = userAggregateKey(userAddress, chainId);
  await redisHIncrByAmount(aggregateKey, "totalAmountWei", full.finalAmountWei);
  if (full.providerAmountWei) {
    await redisHIncrByAmount(aggregateKey, "providerAmountWei", full.providerAmountWei);
  }
  if (full.platformFeeWei) {
    await redisHIncrByAmount(aggregateKey, "platformFeeWei", full.platformFeeWei);
  }
  await redisHIncrByAmount(aggregateKey, "receiptCount", "1");
  await redisHSet(aggregateKey, {
    lastReceiptId: id,
    lastReceiptAt: String(full.settledAt),
  });
  await redisExpire(aggregateKey, RECEIPT_TTL_SECONDS);

  return {
    ...full,
    cumulative: await cumulativeFor(userAddress, chainId),
  };
}

export async function finalizeReceipt(
  receipt: Receipt | null,
  context: ReceiptContext = {},
): Promise<Receipt | null> {
  if (!receipt) {
    return null;
  }

  const full: Receipt = {
    ...receipt,
    service: context.service ?? receipt.service,
    action: context.action ?? receipt.action,
    resource: context.resource ?? receipt.resource,
    userAddress: context.userAddress?.toLowerCase() ?? receipt.userAddress,
  };
  full.bills = full.bills && full.bills.length > 0 ? full.bills : buildReceiptBills(full);
  return storeReceipt(full);
}

export async function listReceipts(input: {
  userAddress: string;
  chainId: number;
  limit?: number;
}): Promise<ReceiptListResult> {
  const userAddress = input.userAddress.toLowerCase();
  const cumulative = await cumulativeFor(userAddress, input.chainId);
  const ids = await redisSMembers(userReceiptsKey(userAddress, input.chainId));
  const receipts = (await Promise.all(
    ids.map(async (id) => {
      const raw = await redisGet(receiptKey(id));
      return raw ? JSON.parse(raw) as Receipt : null;
    }),
  ))
    .filter((receipt): receipt is Receipt => Boolean(receipt))
    .sort((a, b) => b.settledAt - a.settledAt)
    .slice(0, input.limit ?? 50);

  return {
    userAddress,
    chainId: input.chainId,
    cumulative: {
      totalAmountWei: cumulative?.totalAmountWei || "0",
      providerAmountWei: cumulative?.providerAmountWei || "0",
      platformFeeWei: cumulative?.platformFeeWei || "0",
      receiptCount: cumulative?.receiptCount || 0,
    },
    receipts,
  };
}

export async function markBatchReceiptsSettled(input: {
  channelId: string;
  claimedAmountWei: string;
  claimTxHash?: string;
  settleTxHash?: string;
}): Promise<number> {
  const ids = await redisSMembers(batchReceiptsKey(input.channelId));
  let updated = 0;
  for (const id of ids) {
    const raw = await redisGet(receiptKey(id));
    if (!raw) continue;
    const receipt = JSON.parse(raw) as Receipt;
    if (receipt.settlementStatus === "settled") continue;
    const cumulative = receipt.paymentCumulativeAmountWei;
    if (!cumulative || BigInt(cumulative) > BigInt(input.claimedAmountWei)) {
      continue;
    }
    const next: Receipt = {
      ...receipt,
      settlementStatus: input.settleTxHash ? "settled" : "claimed",
      ...(input.claimTxHash ? { claimTxHash: input.claimTxHash } : {}),
      ...(input.settleTxHash ? { settleTxHash: input.settleTxHash, txHash: input.settleTxHash } : {}),
      settledAt: Date.now(),
    };
    await redisSet(receiptKey(id), JSON.stringify(next), RECEIPT_TTL_SECONDS);
    updated += 1;
  }
  return updated;
}

export async function markIntentReceiptsSettled(input: {
  paymentIntentId?: string;
  sessionBudgetIntentId?: string;
  txHash: string;
}): Promise<number> {
  const ids = new Set<string>();
  if (input.paymentIntentId) {
    for (const id of await redisSMembers(intentReceiptsKey(input.paymentIntentId))) {
      ids.add(id);
    }
  }
  if (input.sessionBudgetIntentId) {
    for (const id of await redisSMembers(sessionReceiptsKey(input.sessionBudgetIntentId))) {
      ids.add(id);
    }
  }

  let updated = 0;
  for (const id of ids) {
    const raw = await redisGet(receiptKey(id));
    if (!raw) continue;
    const receipt = JSON.parse(raw) as Receipt;
    if (receipt.settlementStatus === "settled") continue;
    const next: Receipt = {
      ...receipt,
      settlementStatus: "settled",
      txHash: input.txHash,
      settledAt: Date.now(),
    };
    await redisSet(receiptKey(id), JSON.stringify(next), RECEIPT_TTL_SECONDS);
    updated += 1;
  }
  return updated;
}

function meters(body: Record<string, unknown>): MeterRecord[] {
  const values = Array.isArray(body.meters) ? body.meters : [];
  return values
    .map((value): MeterRecord | null => {
      const item = record(value);
      if (!item || item.kind !== "model" || typeof item.model !== "string" || !item.model.trim()) {
        return null;
      }
      return {
        kind: "model",
        source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : "models_call",
        model: item.model.trim(),
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined,
        modality: typeof item.modality === "string" && item.modality.trim() ? item.modality.trim() : undefined,
        usage: record(item.usage) ?? undefined,
        media: record(item.media) ?? undefined,
        responseId: typeof item.responseId === "string" && item.responseId.trim() ? item.responseId.trim() : undefined,
      };
    })
    .filter((value): value is MeterRecord => Boolean(value));
}

function modality(value: string | undefined): Modality {
  if (isCanonicalModality(value)) {
    return value as Modality;
  }
  throw new Error("meter modality is required for nested model settlement");
}

function meterMedia(meter: MeterRecord): Record<string, unknown> | undefined {
  if (meter.media) {
    return meter.media;
  }
  const billingMetrics = record(meter.usage?.billingMetrics);
  return billingMetrics ? { billingMetrics, requests: 1 } : undefined;
}

function combinedMeter(
  base: MeteredSettlementInput,
  body: Record<string, unknown>,
): MeteredSettlementInput {
  const records = meters(body);
  if (records.length === 0) {
    return base;
  }

  const lineItems: MeterLineItem[] = [...base.lineItems];
  for (const item of records) {
    const resolved = resolveBillingModel(item.model!);
    const subject = meterSubject(resolved.provider, resolved.modelId);
    const metered = buildResolvedSettlementMeter({
      resolved,
      modality: modality(item.modality),
      usage: item.usage,
      media: meterMedia(item),
    });

    lineItems.push(...scope(`model.${item.source || "models_call"}.${subject}`, metered.meter.lineItems));
  }

  return {
    subject: base.subject,
    lineItems,
  };
}

export function receiptFromInferenceSettlement(
  settlement: InferenceSettlementReceipt | null,
  chainId?: number,
): Receipt | null {
  if (!settlement) {
    return null;
  }

  const resolvedNetwork = network(settlement.chainId ?? chainId);
  if (!resolvedNetwork) {
    return null;
  }

  return {
    finalAmountWei: settlement.finalAmountWei,
    network: resolvedNetwork,
    settledAt: settlement.settledAt,
    ...(settlement.meterSubject ? { subject: settlement.meterSubject } : {}),
    ...(settlement.lineItems && settlement.lineItems.length > 0 ? { lineItems: settlement.lineItems } : {}),
    ...(settlement.providerAmountWei ? { providerAmountWei: settlement.providerAmountWei } : {}),
    ...(settlement.platformFeeWei ? { platformFeeWei: settlement.platformFeeWei } : {}),
    ...(settlement.txHash ? { txHash: settlement.txHash } : {}),
    settlementStatus: settlement.settlementStatus || (settlement.txHash ? "settled" : "queued"),
    ...(settlement.claimTxHash ? { claimTxHash: settlement.claimTxHash } : {}),
    ...(settlement.settleTxHash ? { settleTxHash: settlement.settleTxHash } : {}),
    ...(settlement.paymentIntentId ? { paymentIntentId: settlement.paymentIntentId } : {}),
    ...(settlement.sessionBudgetIntentId ? { sessionBudgetIntentId: settlement.sessionBudgetIntentId } : {}),
    ...(settlement.paymentChannelId ? { paymentChannelId: settlement.paymentChannelId } : {}),
    ...(settlement.paymentCumulativeAmountWei ? { paymentCumulativeAmountWei: settlement.paymentCumulativeAmountWei } : {}),
  };
}

export function receiptFromSettledIntentBody(
  body: SettledIntentReceiptBody,
  chainId?: number,
): Receipt | null {
  if (!body.finalAmountWei) {
    return null;
  }

  const resolvedNetwork = network(chainId);
  if (!resolvedNetwork) {
    return null;
  }

  return {
    finalAmountWei: body.finalAmountWei,
    network: resolvedNetwork,
    settledAt: Date.now(),
    ...(body.meterSubject ? { subject: body.meterSubject } : {}),
    ...(body.lineItems && body.lineItems.length > 0 ? { lineItems: body.lineItems } : {}),
    ...(body.providerAmountWei ? { providerAmountWei: body.providerAmountWei } : {}),
    ...(body.platformFeeWei ? { platformFeeWei: body.platformFeeWei } : {}),
    ...(body.txHash ? { txHash: body.txHash } : {}),
    settlementStatus: body.txHash ? "settled" : "queued",
  };
}

export function applyReceiptHeader(res: HeaderSink, receipt: Receipt | null): void {
  if (!receipt || res.headersSent) return;
  res.setHeader(RECEIPT_HEADER, encodeReceiptHeader(receipt));
}

export function receiptForJsonBody(receipt: Receipt | null): Record<string, unknown> | undefined {
  if (!receipt) return undefined;

  const body: Record<string, unknown> = {
    final_amount_wei: receipt.finalAmountWei,
    network: receipt.network,
    settled_at: receipt.settledAt,
  };

  if (receipt.id) body.id = receipt.id;
  if (receipt.service) body.service = receipt.service;
  if (receipt.action) body.action = receipt.action;
  if (receipt.resource) body.resource = receipt.resource;
  if (receipt.userAddress) body.user_address = receipt.userAddress;
  if (receipt.subject) body.subject = receipt.subject;
  if (receipt.lineItems && receipt.lineItems.length > 0) {
    body.line_items = receipt.lineItems.map((item) => ({
      key: item.key,
      unit: item.unit,
      quantity: item.quantity,
      unit_price_usd: item.unitPriceUsd,
      amount_wei: item.amountWei,
    }));
  }
  if (receipt.bills && receipt.bills.length > 0) {
    body.bills = receipt.bills.map((bill) => ({
      kind: bill.kind,
      source: bill.source,
      name: bill.name,
      action: bill.action,
      subject: bill.subject,
      amount_wei: bill.amountWei,
      total: bill.total,
      duration: bill.duration,
      tx_id: bill.txId,
      children: bill.children,
      line_items: bill.lineItems.map((item) => ({
        key: item.key,
        unit: item.unit,
        quantity: item.quantity,
        unit_price_usd: item.unitPriceUsd,
        amount_wei: item.amountWei,
      })),
    }));
  }
  if (receipt.providerAmountWei) body.provider_amount_wei = receipt.providerAmountWei;
  if (receipt.platformFeeWei) body.platform_fee_wei = receipt.platformFeeWei;
  if (receipt.txHash) body.tx_hash = receipt.txHash;
  if (receipt.settlementStatus) body.settlement_status = receipt.settlementStatus;
  if (receipt.claimTxHash) body.claim_tx_hash = receipt.claimTxHash;
  if (receipt.settleTxHash) body.settle_tx_hash = receipt.settleTxHash;
  if (receipt.paymentIntentId) body.payment_intent_id = receipt.paymentIntentId;
  if (receipt.sessionBudgetIntentId) body.session_budget_intent_id = receipt.sessionBudgetIntentId;
  if (receipt.paymentChannelId) body.payment_channel_id = receipt.paymentChannelId;
  if (receipt.paymentCumulativeAmountWei) body.payment_cumulative_amount_wei = receipt.paymentCumulativeAmountWei;
  if (receipt.cumulative) {
    body.cumulative = {
      total_amount_wei: receipt.cumulative.totalAmountWei,
      provider_amount_wei: receipt.cumulative.providerAmountWei,
      platform_fee_wei: receipt.cumulative.platformFeeWei,
      receipt_count: receipt.cumulative.receiptCount,
    };
  }

  return body;
}

export function attachReceiptToJsonBody<T extends Record<string, unknown>>(
  body: T,
  receipt: Receipt | null,
): T & { receipt?: Record<string, unknown> } {
  const receiptJson = receiptForJsonBody(receipt);
  if (!receiptJson) {
    return body;
  }
  return {
    ...body,
    receipt: receiptJson,
  };
}

export function receiptStreamPayload(receipt: Receipt): ReceiptStreamPayload {
  return {
    id: receipt.id,
    service: receipt.service,
    action: receipt.action,
    resource: receipt.resource,
    userAddress: receipt.userAddress,
    finalAmountWei: receipt.finalAmountWei,
    providerAmountWei: receipt.providerAmountWei,
    platformFeeWei: receipt.platformFeeWei,
    meterSubject: receipt.subject,
    lineItems: receipt.lineItems,
    bills: receipt.bills,
    txHash: receipt.txHash,
    settlementStatus: receipt.settlementStatus,
    claimTxHash: receipt.claimTxHash,
    settleTxHash: receipt.settleTxHash,
    paymentChannelId: receipt.paymentChannelId,
    paymentCumulativeAmountWei: receipt.paymentCumulativeAmountWei,
    network: receipt.network,
    settledAt: receipt.settledAt,
    cumulative: receipt.cumulative,
  };
}

export function buildAgentTextSettlement(body: Record<string, unknown>): { meter: MeteredSettlementInput } {
  if (typeof body.model !== "string") {
    throw new Error("model is required for metered settlement");
  }

  const metered = buildResolvedSettlementMeter({
    resolved: resolveBillingModel(body.model),
    modality: "text",
    usage: body,
  });

  return { meter: combinedMeter(metered.meter, body) };
}

export function buildAgentResponsesSettlement(body: Record<string, unknown>): { meter: MeteredSettlementInput } {
  if (typeof body.model !== "string") {
    throw new Error("model is required for metered settlement");
  }

  const unified = normalizeResponsesRequest(body);
  const metered = buildResolvedSettlementMeter({
    resolved: resolveBillingModel(body.model),
    modality: unified.modality,
    usage: body,
    media: body,
  });

  return { meter: combinedMeter(metered.meter, body) };
}
