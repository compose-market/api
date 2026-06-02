import { randomUUID } from "node:crypto";

import {
  redisExpire,
  redisHGetAll,
  redisHSet,
  redisSAdd,
  redisSMembers,
  redisSet,
} from "./keys/redis.js";

const TTL_SECONDS = 60 * 60 * 24;
const PREFIX = "x402:evidence";

export type EvidenceKind = "model" | "agent" | "tool" | "search" | "memory" | "connector";
export type SettlementStatus = "queued" | "claimed" | "settled" | "failed";

export interface ChargeEvidence {
  id?: string;
  chargeId?: string;
  kind: EvidenceKind;
  rootRunId: string;
  executionRunId: string;
  parentExecutionRunId?: string;
  service?: string;
  action?: string;
  subject?: string;
  walletAddress?: string;
  name?: string;
  providerAmountWei: string;
  composeFeeWei: string;
  creatorFeeWei?: string;
  finalAmountWei: string;
  settlementStatus?: SettlementStatus;
  txHash?: string;
  claimTxHash?: string;
  settleTxHash?: string;
  paymentIntentId?: string;
  sessionBudgetIntentId?: string;
  paymentChannelId?: string;
  paymentCumulativeAmountWei?: string;
  chainId?: number;
  settledAt?: number;
}

function key(id: string): string {
  return `${PREFIX}:charge:${id}`;
}

function executionKey(rootRunId: string, executionRunId: string): string {
  return `${PREFIX}:root:${rootRunId}:execution:${executionRunId}`;
}

function parentKey(rootRunId: string, parentExecutionRunId: string): string {
  return `${PREFIX}:root:${rootRunId}:parent:${parentExecutionRunId}`;
}

function rootKey(rootRunId: string): string {
  return `${PREFIX}:root:${rootRunId}:all`;
}

function channelKey(channelId: string): string {
  return `${PREFIX}:channel:${channelId.toLowerCase()}`;
}

function intentKey(intentId: string): string {
  return `${PREFIX}:intent:${intentId}`;
}

function sessionKey(intentId: string): string {
  return `${PREFIX}:session:${intentId}`;
}

function clean(value: string | undefined): string {
  return value?.trim() || "";
}

function fields(input: Required<Pick<ChargeEvidence, "id">> & ChargeEvidence): Record<string, string> {
  return {
    id: input.id,
    chargeId: clean(input.chargeId || input.id),
    kind: input.kind,
    rootRunId: input.rootRunId,
    executionRunId: input.executionRunId,
    parentExecutionRunId: clean(input.parentExecutionRunId),
    service: clean(input.service),
    action: clean(input.action),
    subject: clean(input.subject),
    walletAddress: clean(input.walletAddress),
    name: clean(input.name),
    providerAmountWei: input.providerAmountWei,
    composeFeeWei: input.composeFeeWei,
    creatorFeeWei: clean(input.creatorFeeWei),
    finalAmountWei: input.finalAmountWei,
    settlementStatus: input.settlementStatus || (input.txHash ? "settled" : "queued"),
    txHash: clean(input.txHash),
    claimTxHash: clean(input.claimTxHash),
    settleTxHash: clean(input.settleTxHash),
    paymentIntentId: clean(input.paymentIntentId),
    sessionBudgetIntentId: clean(input.sessionBudgetIntentId),
    paymentChannelId: clean(input.paymentChannelId),
    paymentCumulativeAmountWei: clean(input.paymentCumulativeAmountWei),
    chainId: input.chainId ? String(input.chainId) : "",
    settledAt: String(input.settledAt ?? Date.now()),
  };
}

function parse(data: Record<string, string>): ChargeEvidence | null {
  if (!data.id || !data.kind || !data.rootRunId || !data.executionRunId) {
    return null;
  }
  return {
    id: data.id,
    chargeId: data.chargeId || data.id,
    kind: data.kind as EvidenceKind,
    rootRunId: data.rootRunId,
    executionRunId: data.executionRunId,
    ...(data.parentExecutionRunId ? { parentExecutionRunId: data.parentExecutionRunId } : {}),
    ...(data.service ? { service: data.service } : {}),
    ...(data.action ? { action: data.action } : {}),
    ...(data.subject ? { subject: data.subject } : {}),
    ...(data.walletAddress ? { walletAddress: data.walletAddress } : {}),
    ...(data.name ? { name: data.name } : {}),
    providerAmountWei: data.providerAmountWei || "0",
    composeFeeWei: data.composeFeeWei || "0",
    ...(data.creatorFeeWei ? { creatorFeeWei: data.creatorFeeWei } : {}),
    finalAmountWei: data.finalAmountWei || "0",
    settlementStatus: (data.settlementStatus || (data.txHash ? "settled" : "queued")) as SettlementStatus,
    ...(data.txHash ? { txHash: data.txHash } : {}),
    ...(data.claimTxHash ? { claimTxHash: data.claimTxHash } : {}),
    ...(data.settleTxHash ? { settleTxHash: data.settleTxHash } : {}),
    ...(data.paymentIntentId ? { paymentIntentId: data.paymentIntentId } : {}),
    ...(data.sessionBudgetIntentId ? { sessionBudgetIntentId: data.sessionBudgetIntentId } : {}),
    ...(data.paymentChannelId ? { paymentChannelId: data.paymentChannelId } : {}),
    ...(data.paymentCumulativeAmountWei ? { paymentCumulativeAmountWei: data.paymentCumulativeAmountWei } : {}),
    ...(data.chainId ? { chainId: Number.parseInt(data.chainId, 10) } : {}),
    settledAt: data.settledAt ? Number.parseInt(data.settledAt, 10) : Date.now(),
  };
}

export async function recordChargeEvidence(input: ChargeEvidence): Promise<ChargeEvidence> {
  if (!input.rootRunId || !input.executionRunId) {
    return input;
  }

  const id = input.id || `chg_${randomUUID().replace(/-/g, "")}`;
  const full = { ...input, id, chargeId: input.chargeId || id };
  await redisHSet(key(id), fields(full));
  await redisExpire(key(id), TTL_SECONDS);

  await redisSAdd(executionKey(input.rootRunId, input.executionRunId), id);
  await redisExpire(executionKey(input.rootRunId, input.executionRunId), TTL_SECONDS);
  await redisSAdd(rootKey(input.rootRunId), id);
  await redisExpire(rootKey(input.rootRunId), TTL_SECONDS);
  if (input.parentExecutionRunId) {
    await redisSAdd(parentKey(input.rootRunId, input.parentExecutionRunId), id);
    await redisExpire(parentKey(input.rootRunId, input.parentExecutionRunId), TTL_SECONDS);
  }
  if (input.paymentChannelId) {
    await redisSAdd(channelKey(input.paymentChannelId), id);
    await redisExpire(channelKey(input.paymentChannelId), TTL_SECONDS);
  }
  if (input.paymentIntentId) {
    await redisSAdd(intentKey(input.paymentIntentId), id);
    await redisExpire(intentKey(input.paymentIntentId), TTL_SECONDS);
  }
  if (input.sessionBudgetIntentId) {
    await redisSAdd(sessionKey(input.sessionBudgetIntentId), id);
    await redisExpire(sessionKey(input.sessionBudgetIntentId), TTL_SECONDS);
  }

  return full;
}

async function list(ids: string[]): Promise<ChargeEvidence[]> {
  const charges = await Promise.all(ids.map(async (id) => parse(await redisHGetAll(key(id)))));
  return charges.filter((charge): charge is ChargeEvidence => Boolean(charge));
}

export async function listExecutionEvidence(rootRunId: string, executionRunId: string): Promise<ChargeEvidence[]> {
  if (!rootRunId || !executionRunId) {
    return [];
  }
  return list(await redisSMembers(executionKey(rootRunId, executionRunId)));
}

export async function listChildEvidence(rootRunId: string, parentExecutionRunId: string): Promise<ChargeEvidence[]> {
  if (!rootRunId || !parentExecutionRunId) {
    return [];
  }
  return list(await redisSMembers(parentKey(rootRunId, parentExecutionRunId)));
}

export async function markBatchEvidenceSettled(input: {
  channelId: string;
  claimedAmountWei: string;
  claimTxHash?: string;
  settleTxHash?: string;
  chainId?: number;
}): Promise<number> {
  const ids = await redisSMembers(channelKey(input.channelId));
  let updated = 0;
  for (const id of ids) {
    const current = parse(await redisHGetAll(key(id)));
    if (!current || current.settlementStatus === "settled") {
      continue;
    }
    const cumulative = current.paymentCumulativeAmountWei;
    if (!cumulative || BigInt(cumulative) > BigInt(input.claimedAmountWei)) {
      continue;
    }
    await redisHSet(key(id), {
      settlementStatus: input.settleTxHash ? "settled" : "claimed",
      ...(input.claimTxHash ? { claimTxHash: input.claimTxHash } : {}),
      ...(input.settleTxHash ? { settleTxHash: input.settleTxHash, txHash: input.settleTxHash } : {}),
      ...(input.chainId ? { chainId: String(input.chainId) } : {}),
      settledAt: String(Date.now()),
    });
    updated += 1;
  }
  return updated;
}

export async function markIntentEvidenceSettled(input: {
  paymentIntentId?: string;
  sessionBudgetIntentId?: string;
  txHash: string;
  chainId?: number;
}): Promise<number> {
  const ids = new Set<string>();
  if (input.paymentIntentId) {
    for (const id of await redisSMembers(intentKey(input.paymentIntentId))) {
      ids.add(id);
    }
  }
  if (input.sessionBudgetIntentId) {
    for (const id of await redisSMembers(sessionKey(input.sessionBudgetIntentId))) {
      ids.add(id);
    }
  }

  let updated = 0;
  for (const id of ids) {
    const current = parse(await redisHGetAll(key(id)));
    if (!current || current.settlementStatus === "settled") {
      continue;
    }
    await redisHSet(key(id), {
      settlementStatus: "settled",
      txHash: input.txHash,
      ...(input.chainId ? { chainId: String(input.chainId) } : {}),
      settledAt: String(Date.now()),
    });
    updated += 1;
  }
  return updated;
}
