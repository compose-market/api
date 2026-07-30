import type { PaymentPayload } from "@x402/core/types";
import { randomUUID } from "node:crypto";
import type { NetworkId } from "./configs/chains.js";

import {
  valkeyDel,
  valkeyExpire,
  valkeyGet,
  valkeyHGetAll,
  valkeyHIncrByAmount,
  valkeyHSet,
  valkeySAdd,
  valkeySMembers,
  valkeySRem,
  valkeySetNXEX,
} from "./keys/valkey.js";

const TTL_SECONDS = 15 * 60;
const PREFIX = "x402:envelope";
const LOCK_PREFIX = "x402:envelope-lock";
const LOCK_TTL_SECONDS = 10;
const LOCK_ATTEMPTS = 20;
const LOCK_DELAY_MS = 25;

export interface RawEnvelope {
  rootRunId: string;
  maxAmountWei: string;
  network: NetworkId;
  paymentPayload: PaymentPayload;
  usedWei: string;
  payer?: string;
  createdAt?: number;
  updatedAt?: number;
}

function key(rootRunId: string): string {
  return `${PREFIX}:${rootRunId}`;
}

function payerKey(payer: string, network?: NetworkId): string {
  return network ? `${PREFIX}:payer:${network}:${payer}` : `${PREFIX}:payer:${payer}`;
}

function lockKey(rootRunId: string): string {
  return `${LOCK_PREFIX}:${rootRunId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lock<T>(rootRunId: string, fn: () => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const target = lockKey(rootRunId);
  let acquired = false;
  for (let i = 0; i < LOCK_ATTEMPTS; i += 1) {
    acquired = await valkeySetNXEX(target, owner, LOCK_TTL_SECONDS);
    if (acquired) break;
    await sleep(LOCK_DELAY_MS);
  }
  if (!acquired) {
    throw new Error("Payment envelope is busy");
  }
  try {
    return await fn();
  } finally {
    if (await valkeyGet(target) === owner) {
      await valkeyDel(target);
    }
  }
}

function parse(data: Record<string, string>): RawEnvelope | null {
  if (!data.rootRunId || !data.maxAmountWei || !data.network || !data.paymentPayload) {
    return null;
  }
  return {
    rootRunId: data.rootRunId,
    maxAmountWei: data.maxAmountWei,
    network: data.network as NetworkId,
    paymentPayload: JSON.parse(data.paymentPayload) as PaymentPayload,
    usedWei: data.usedWei || "0",
    ...(data.payer ? { payer: data.payer } : {}),
    ...(data.createdAt ? { createdAt: Number.parseInt(data.createdAt, 10) } : {}),
    ...(data.updatedAt ? { updatedAt: Number.parseInt(data.updatedAt, 10) } : {}),
  };
}

export async function saveRawEnvelope(input: {
  rootRunId: string;
  maxAmountWei: string;
  network: NetworkId;
  paymentPayload: PaymentPayload;
  payer?: string;
}): Promise<void> {
  if (!input.rootRunId) return;
  const target = key(input.rootRunId);
  const existing = parse(await valkeyHGetAll(target));
  if (existing) {
    await valkeyExpire(target, TTL_SECONDS);
    if (existing.payer) {
      await index(input.rootRunId, existing.payer, existing.network);
    }
    return;
  }
  const current = Date.now();
  const payer = input.payer?.trim();
  await valkeyHSet(target, {
    rootRunId: input.rootRunId,
    maxAmountWei: input.maxAmountWei,
    network: input.network,
    paymentPayload: JSON.stringify(input.paymentPayload),
    usedWei: "0",
    ...(payer ? { payer } : {}),
    createdAt: String(current),
    updatedAt: String(current),
  });
  await valkeyExpire(target, TTL_SECONDS);
  if (payer) {
    await index(input.rootRunId, payer, input.network);
  }
}

export async function readRawEnvelope(rootRunId: string): Promise<RawEnvelope | null> {
  if (!rootRunId) return null;
  return parse(await valkeyHGetAll(key(rootRunId)));
}

async function index(rootRunId: string, payer: string, network: NetworkId): Promise<void> {
  const normalized = payer.trim();
  await Promise.all([
    valkeySAdd(payerKey(normalized), rootRunId),
    valkeySAdd(payerKey(normalized, network), rootRunId),
  ]);
  await Promise.all([
    valkeyExpire(payerKey(normalized), TTL_SECONDS),
    valkeyExpire(payerKey(normalized, network), TTL_SECONDS),
  ]);
}

function active(envelope: RawEnvelope): boolean {
  try {
    return BigInt(envelope.maxAmountWei) > BigInt(envelope.usedWei || "0");
  } catch {
    return false;
  }
}

export async function readActiveRawEnvelope(input: {
  payer: string;
  network?: NetworkId;
}): Promise<RawEnvelope | null> {
  const normalized = input.payer.trim();
  if (!normalized) return null;
  const setKey = payerKey(normalized, input.network);
  const ids = await valkeySMembers(setKey);
  if (ids.length === 0) return null;

  const envelopes = await Promise.all(ids.map(async (id) => [id, await readRawEnvelope(id)] as const));
  const stale = envelopes.filter(([, envelope]) => !envelope).map(([id]) => id);
  if (stale.length > 0) {
    await valkeySRem(setKey, ...stale);
  }

  const candidates = envelopes
    .map(([, envelope]) => envelope)
    .filter((envelope): envelope is RawEnvelope => Boolean(
      envelope
      && envelope.payer === normalized
      && (!input.network || envelope.network === input.network)
      && active(envelope),
    ))
    .sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0));

  return candidates[0] || null;
}

export async function reserveRawEnvelope(rootRunId: string, amountWei: string): Promise<RawEnvelope> {
  return lock(rootRunId, async () => {
    const target = key(rootRunId);
    const envelope = parse(await valkeyHGetAll(target));
    if (!envelope) {
      throw new Error("Payment envelope not found");
    }
    const amount = BigInt(amountWei);
    const used = BigInt(envelope.usedWei || "0");
    const max = BigInt(envelope.maxAmountWei);
    if (amount < 0n || used + amount > max) {
      throw new Error("Payment envelope budget exhausted");
    }
    const usedWei = await valkeyHIncrByAmount(target, "usedWei", amountWei);
    await valkeyHSet(target, "updatedAt", String(Date.now()));
    await valkeyExpire(target, TTL_SECONDS);
    if (envelope.payer) {
      await index(rootRunId, envelope.payer, envelope.network);
    }
    return { ...envelope, usedWei };
  });
}

export async function releaseRawEnvelope(rootRunId: string, amountWei: string): Promise<void> {
  await lock(rootRunId, async () => {
    const target = key(rootRunId);
    const envelope = parse(await valkeyHGetAll(target));
    if (!envelope) return;
    await valkeyHIncrByAmount(target, "usedWei", `-${amountWei}`);
    await valkeyHSet(target, "updatedAt", String(Date.now()));
    await valkeyExpire(target, TTL_SECONDS);
    if (envelope.payer) {
      await index(rootRunId, envelope.payer, envelope.network);
    }
  });
}
