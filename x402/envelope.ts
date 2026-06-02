import type { PaymentPayload } from "@x402/core/types";
import { randomUUID } from "node:crypto";

import {
  redisDel,
  redisExpire,
  redisGet,
  redisHGetAll,
  redisHIncrByAmount,
  redisHSet,
  redisSetNXEX,
} from "./keys/redis.js";

const TTL_SECONDS = 15 * 60;
const PREFIX = "x402:envelope";
const LOCK_PREFIX = "x402:envelope-lock";
const LOCK_TTL_SECONDS = 10;
const LOCK_ATTEMPTS = 20;
const LOCK_DELAY_MS = 25;

export interface RawEnvelope {
  rootRunId: string;
  maxAmountWei: string;
  chainId: number;
  paymentPayload: PaymentPayload;
  usedWei: string;
}

function key(rootRunId: string): string {
  return `${PREFIX}:${rootRunId}`;
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
    acquired = await redisSetNXEX(target, owner, LOCK_TTL_SECONDS);
    if (acquired) break;
    await sleep(LOCK_DELAY_MS);
  }
  if (!acquired) {
    throw new Error("Payment envelope is busy");
  }
  try {
    return await fn();
  } finally {
    if (await redisGet(target) === owner) {
      await redisDel(target);
    }
  }
}

function parse(data: Record<string, string>): RawEnvelope | null {
  if (!data.rootRunId || !data.maxAmountWei || !data.chainId || !data.paymentPayload) {
    return null;
  }
  return {
    rootRunId: data.rootRunId,
    maxAmountWei: data.maxAmountWei,
    chainId: Number.parseInt(data.chainId, 10),
    paymentPayload: JSON.parse(data.paymentPayload) as PaymentPayload,
    usedWei: data.usedWei || "0",
  };
}

export async function saveRawEnvelope(input: {
  rootRunId: string;
  maxAmountWei: string;
  chainId: number;
  paymentPayload: PaymentPayload;
}): Promise<void> {
  if (!input.rootRunId) return;
  const target = key(input.rootRunId);
  const existing = parse(await redisHGetAll(target));
  if (existing) {
    await redisExpire(target, TTL_SECONDS);
    return;
  }
  await redisHSet(target, {
    rootRunId: input.rootRunId,
    maxAmountWei: input.maxAmountWei,
    chainId: String(input.chainId),
    paymentPayload: JSON.stringify(input.paymentPayload),
    usedWei: "0",
  });
  await redisExpire(target, TTL_SECONDS);
}

export async function readRawEnvelope(rootRunId: string): Promise<RawEnvelope | null> {
  if (!rootRunId) return null;
  return parse(await redisHGetAll(key(rootRunId)));
}

export async function reserveRawEnvelope(rootRunId: string, amountWei: string): Promise<RawEnvelope> {
  return lock(rootRunId, async () => {
    const target = key(rootRunId);
    const envelope = parse(await redisHGetAll(target));
    if (!envelope) {
      throw new Error("Payment envelope not found");
    }
    const amount = BigInt(amountWei);
    const used = BigInt(envelope.usedWei || "0");
    const max = BigInt(envelope.maxAmountWei);
    if (amount < 0n || used + amount > max) {
      throw new Error("Payment envelope budget exhausted");
    }
    const usedWei = await redisHIncrByAmount(target, "usedWei", amountWei);
    await redisExpire(target, TTL_SECONDS);
    return { ...envelope, usedWei };
  });
}

export async function releaseRawEnvelope(rootRunId: string, amountWei: string): Promise<void> {
  await lock(rootRunId, async () => {
    const target = key(rootRunId);
    const envelope = parse(await redisHGetAll(target));
    if (!envelope) return;
    await redisHIncrByAmount(target, "usedWei", `-${amountWei}`);
    await redisExpire(target, TTL_SECONDS);
  });
}
