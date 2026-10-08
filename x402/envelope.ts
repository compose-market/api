import type { PaymentPayload } from "@x402/core/types";
import { createHash } from "node:crypto";
import { getNetwork, isNetworkId, type NetworkId } from "./configs/chains.js";

import {
  getValkeyClient,
  valkeyHGetAll,
} from "./keys/valkey.js";

const TTL_SECONDS = 15 * 60;
const PREFIX = "x402:envelope";

export interface RawEnvelope {
  rootRunId: string;
  maxAmountWei: string;
  network: NetworkId;
  paymentPayload: PaymentPayload;
  usedWei: string;
  payer: string;
  asset: string;
  receiver: string;
  resource: string;
  channelId: string;
  signedMaxClaimable: string;
  voucherSignature: string;
  channelConfigFingerprint: string;
  backingFingerprint: string;
  createdAt?: number;
  updatedAt?: number;
}

type RawBatchPayload = {
  type: "deposit" | "voucher";
  channelConfig: {
    payer: string;
    receiver: string;
    token: string;
    network?: string;
    resource?: string;
    [key: string]: unknown;
  };
  voucher: {
    channelId: string;
    maxClaimableAmount: string;
    signature: string;
  };
  [key: string]: unknown;
};

export interface RawBatchBacking {
  network: NetworkId;
  payer: string;
  asset: string;
  receiver: string;
  resource: string;
  channelId: string;
  signedMaxClaimable: string;
  voucherSignature: string;
  channelConfigFingerprint: string;
  backingFingerprint: string;
  paymentPayloadJson: string;
}

function orderedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(orderedValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((ordered, entry) => {
        ordered[entry] = orderedValue((value as Record<string, unknown>)[entry]);
        return ordered;
      }, {});
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(orderedValue(value));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalBinding(network: NetworkId, value: string): string {
  const trimmed = value.trim();
  return network.startsWith("eip155:") ? trimmed.toLowerCase() : trimmed;
}

function positiveDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) > 0n;
}

export function resolveRawBatchBacking(input: {
  network: NetworkId;
  maxAmountWei: string;
  paymentPayload: PaymentPayload;
  payer?: string;
}): RawBatchBacking {
  const { paymentPayload } = input;
  if (paymentPayload.accepted?.scheme !== "batch-settlement") {
    throw new Error("Only verified batch-settlement payloads can be persisted as raw envelopes");
  }
  if (!isNetworkId(paymentPayload.accepted.network) || paymentPayload.accepted.network !== input.network) {
    throw new Error("Raw batch envelope network does not match the verified payment backing");
  }
  if (!positiveDecimal(input.maxAmountWei) || paymentPayload.accepted.amount !== input.maxAmountWei) {
    throw new Error("Raw batch envelope maximum does not match the verified payment backing");
  }

  const raw = paymentPayload.payload as Partial<RawBatchPayload> | undefined;
  if (
    !raw
    || (raw.type !== "deposit" && raw.type !== "voucher")
    || !raw.channelConfig
    || !raw.voucher
  ) {
    throw new Error("Invalid batch-settlement payload backing");
  }

  const resource = paymentPayload.resource?.url?.trim();
  const verifiedPayer = input.payer?.trim();
  const channelPayer = raw.channelConfig.payer?.trim();
  const channelReceiver = raw.channelConfig.receiver?.trim();
  const channelAsset = raw.channelConfig.token?.trim();
  const channelId = raw.voucher.channelId?.trim();
  const voucherSignature = raw.voucher.signature?.trim();
  const signedMaxClaimable = raw.voucher.maxClaimableAmount?.trim();
  if (
    !resource
    || !verifiedPayer
    || !channelPayer
    || !channelReceiver
    || !channelAsset
    || !channelId
    || !voucherSignature
    || !signedMaxClaimable
    || !positiveDecimal(signedMaxClaimable)
  ) {
    throw new Error("Incomplete verified batch-settlement payload backing");
  }
  if (BigInt(signedMaxClaimable) < BigInt(input.maxAmountWei)) {
    throw new Error("Signed batch-settlement maximum is below the verified request maximum");
  }

  const registryAsset = getNetwork(input.network).asset.address;
  const payer = canonicalBinding(input.network, channelPayer);
  const asset = canonicalBinding(input.network, registryAsset);
  const receiver = canonicalBinding(input.network, paymentPayload.accepted.payTo);
  if (canonicalBinding(input.network, verifiedPayer) !== payer) {
    throw new Error("Verified payer does not match the batch-settlement channel payer");
  }
  if (
    canonicalBinding(input.network, paymentPayload.accepted.asset) !== asset
    || canonicalBinding(input.network, channelAsset) !== asset
  ) {
    throw new Error("Batch-settlement asset does not match the canonical network asset");
  }
  if (canonicalBinding(input.network, channelReceiver) !== receiver) {
    throw new Error("Batch-settlement receiver does not match the verified payment receiver");
  }
  if (raw.channelConfig.network !== undefined && raw.channelConfig.network !== input.network) {
    throw new Error("Batch-settlement channel network does not match the verified payment network");
  }
  if (raw.channelConfig.resource !== undefined && raw.channelConfig.resource !== resource) {
    throw new Error("Batch-settlement channel resource does not match the verified payment resource");
  }
  if (input.network.startsWith("solana:") && (
    raw.channelConfig.network !== input.network
    || raw.channelConfig.resource !== resource
  )) {
    throw new Error("SVM batch-settlement backing requires canonical network and resource bindings");
  }
  if (input.network.startsWith("near:") && (
    raw.channelConfig.network !== input.network
    || raw.channelConfig.resource !== resource
  )) {
    throw new Error("NEAR batch-settlement backing requires canonical network and resource bindings");
  }

  const paymentPayloadJson = canonicalJson(paymentPayload);
  return {
    network: input.network,
    payer,
    asset,
    receiver,
    resource,
    channelId: input.network.startsWith("eip155:") ? channelId.toLowerCase() : channelId,
    signedMaxClaimable,
    voucherSignature: voucherSignature.startsWith("0x")
      ? voucherSignature.toLowerCase()
      : voucherSignature,
    channelConfigFingerprint: fingerprint(raw.channelConfig),
    backingFingerprint: fingerprint(paymentPayload),
    paymentPayloadJson,
  };
}

function key(rootRunId: string): string {
  return `${PREFIX}:${rootRunId}`;
}

function parse(data: Record<string, string>): RawEnvelope | null {
  if (
    !data.rootRunId
    || !data.maxAmountWei
    || !data.network
    || !data.paymentPayload
    || !data.payer
    || !data.asset
    || !data.receiver
    || !data.resource
    || !data.channelId
    || !data.signedMaxClaimable
    || !data.voucherSignature
    || !data.channelConfigFingerprint
    || !data.backingFingerprint
    || !isNetworkId(data.network)
  ) {
    return null;
  }
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = JSON.parse(data.paymentPayload) as PaymentPayload;
  } catch {
    return null;
  }
  let backing: RawBatchBacking;
  try {
    backing = resolveRawBatchBacking({
      network: data.network,
      maxAmountWei: data.maxAmountWei,
      paymentPayload,
      payer: data.payer,
    });
  } catch {
    return null;
  }
  if (
    backing.paymentPayloadJson !== data.paymentPayload
    || backing.payer !== data.payer
    || backing.asset !== data.asset
    || backing.receiver !== data.receiver
    || backing.resource !== data.resource
    || backing.channelId !== data.channelId
    || backing.signedMaxClaimable !== data.signedMaxClaimable
    || backing.voucherSignature !== data.voucherSignature
    || backing.channelConfigFingerprint !== data.channelConfigFingerprint
    || backing.backingFingerprint !== data.backingFingerprint
    || !/^(?:0|[1-9]\d*)$/u.test(data.usedWei || "0")
    || BigInt(data.usedWei || "0") > BigInt(data.maxAmountWei)
  ) return null;
  return {
    rootRunId: data.rootRunId,
    maxAmountWei: data.maxAmountWei,
    network: data.network as NetworkId,
    paymentPayload,
    usedWei: data.usedWei || "0",
    payer: data.payer,
    asset: data.asset,
    receiver: data.receiver,
    resource: data.resource,
    channelId: data.channelId,
    signedMaxClaimable: data.signedMaxClaimable,
    voucherSignature: data.voucherSignature,
    channelConfigFingerprint: data.channelConfigFingerprint,
    backingFingerprint: data.backingFingerprint,
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
  const backing = resolveRawBatchBacking(input);
  const target = key(input.rootRunId);
  const current = Date.now();
  const valkey = await getValkeyClient();
  const fields = {
    rootRunId: input.rootRunId,
    maxAmountWei: input.maxAmountWei,
    network: backing.network,
    paymentPayload: backing.paymentPayloadJson,
    payer: backing.payer,
    asset: backing.asset,
    receiver: backing.receiver,
    resource: backing.resource,
    channelId: backing.channelId,
    signedMaxClaimable: backing.signedMaxClaimable,
    voucherSignature: backing.voucherSignature,
    channelConfigFingerprint: backing.channelConfigFingerprint,
    backingFingerprint: backing.backingFingerprint,
  };
  const fieldArguments = Object.entries(fields).flat();
  const result = await valkey.eval(
    `if redis.call("EXISTS", KEYS[1]) == 1 then
      for index = 1, #ARGV - 2, 2 do
        if redis.call("HGET", KEYS[1], ARGV[index]) ~= ARGV[index + 1] then
          return -1
        end
      end
      redis.call("EXPIRE", KEYS[1], ARGV[#ARGV])
      return 0
    end
    redis.call("HSET", KEYS[1], unpack(ARGV, 1, #ARGV - 2))
    redis.call("HSET", KEYS[1], "usedWei", "0", "createdAt", ARGV[#ARGV - 1], "updatedAt", ARGV[#ARGV - 1])
    redis.call("EXPIRE", KEYS[1], ARGV[#ARGV])
    return 1`,
    1,
    target,
    ...fieldArguments,
    String(current),
    String(TTL_SECONDS),
  );
  if (Number(result) === -1) {
    throw new Error("Raw batch envelope immutable backing mismatch");
  }
}

export async function readRawEnvelope(rootRunId: string): Promise<RawEnvelope | null> {
  if (!rootRunId) return null;
  return parse(await valkeyHGetAll(key(rootRunId)));
}

function checkpointChannelId(network: NetworkId, channelId: string): string {
  return network.startsWith("eip155:") ? channelId.toLowerCase() : channelId;
}

export function rawBatchCheckpointField(input: {
  network: NetworkId;
  channelId: string;
  rootRunId: string;
  executionRunId: string;
  idempotencyKey?: string;
  sequence: number;
}): string {
  const idempotencyKey = input.idempotencyKey?.trim() || "";
  return `checkpoint:${fingerprint({
    network: input.network,
    channelId: checkpointChannelId(input.network, input.channelId),
    rootRunId: input.rootRunId,
    executionRunId: input.executionRunId,
    // One agent execution fans out into many nested billable requests that
    // all share (rootRunId, executionRunId). Scoping the checkpoint identity
    // by the request idempotency key keeps each settlement request distinct
    // while retries of the same request stay replay-protected. Omitted when
    // absent so legacy fingerprints remain addressable.
    ...(idempotencyKey ? { idempotencyKey } : {}),
    sequence: input.sequence,
  })}`;
}

export async function commitRawBatchCheckpointTransition(input: {
  backing: RawBatchBacking;
  amountWei: string;
  rootRunId: string;
  executionRunId: string;
  idempotencyKey?: string;
  sequence: number;
  channelStorage: "evm-json" | "svm-hash";
  channelKey: string;
  pendingKey?: string;
}): Promise<{ cumulativeAmountWei: string; replayed: boolean }> {
  if (!/^[1-9]\d*$/u.test(input.amountWei)) {
    throw new Error("Raw batch checkpoint amount must be a positive decimal integer");
  }
  if (!input.rootRunId.trim() || !input.executionRunId.trim()) {
    throw new Error("Raw batch checkpoint requires root and execution identities");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("Raw batch checkpoint sequence must be a non-negative safe integer");
  }

  const idempotencyKey = input.idempotencyKey?.trim() || "";
  const checkpointField = rawBatchCheckpointField({
    network: input.backing.network,
    channelId: input.backing.channelId,
    rootRunId: input.rootRunId,
    executionRunId: input.executionRunId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    sequence: input.sequence,
  });
  const valkey = await getValkeyClient();
  const result = await valkey.eval(
    `local function canonical_decimal(value)
      if not value or not string.match(value, "^%d+$") then return nil end
      local canonical = string.gsub(value, "^0+", "")
      return canonical == "" and "0" or canonical
    end
    local function add_decimal(left, right)
      left = canonical_decimal(left)
      right = canonical_decimal(right)
      if not left or not right then return nil end
      local i = string.len(left)
      local j = string.len(right)
      local carry = 0
      local digits = {}
      while i > 0 or j > 0 or carry > 0 do
        local a = i > 0 and tonumber(string.sub(left, i, i)) or 0
        local b = j > 0 and tonumber(string.sub(right, j, j)) or 0
        local sum = a + b + carry
        table.insert(digits, 1, tostring(sum % 10))
        carry = math.floor(sum / 10)
        i = i - 1
        j = j - 1
      end
      return table.concat(digits)
    end
    local function greater_than(left, right)
      left = canonical_decimal(left)
      right = canonical_decimal(right)
      if not left or not right then return nil end
      if string.len(left) ~= string.len(right) then
        return string.len(left) > string.len(right)
      end
      return left > right
    end
    local function envelope_matches()
      return redis.call("HGET", KEYS[1], "rootRunId") == ARGV[7]
        and redis.call("HGET", KEYS[1], "network") == ARGV[5]
        and redis.call("HGET", KEYS[1], "payer") == ARGV[10]
        and redis.call("HGET", KEYS[1], "asset") == ARGV[11]
        and redis.call("HGET", KEYS[1], "receiver") == ARGV[12]
        and redis.call("HGET", KEYS[1], "resource") == ARGV[13]
        and redis.call("HGET", KEYS[1], "channelId") == ARGV[6]
        and redis.call("HGET", KEYS[1], "signedMaxClaimable") == ARGV[14]
        and redis.call("HGET", KEYS[1], "voucherSignature") == ARGV[15]
        and redis.call("HGET", KEYS[1], "channelConfigFingerprint") == ARGV[16]
        and redis.call("HGET", KEYS[1], "backingFingerprint") == ARGV[17]
    end
    if redis.call("EXISTS", KEYS[1]) == 0 then return {-1, ""} end
    if not envelope_matches() then return {-2, ""} end

    local channel
    local charged
    local balance
    if ARGV[1] == "evm-json" then
      local raw = redis.call("GET", KEYS[2])
      if not raw then return {-3, ""} end
      channel = cjson.decode(raw)
      if channel.channelId ~= ARGV[6]
        or channel.network ~= ARGV[5]
        or channel.payer ~= ARGV[10]
        or channel.asset ~= ARGV[11]
        or channel.receiver ~= ARGV[12]
        or channel.resource ~= ARGV[13]
        or channel.signedMaxClaimable ~= ARGV[14]
        or channel.signature ~= ARGV[15]
        or channel.channelConfigFingerprint ~= ARGV[16]
        or channel.backingFingerprint ~= ARGV[17] then
        return {-4, ""}
      end
      charged = channel.chargedCumulativeAmount
      balance = channel.balance
    elseif ARGV[1] == "svm-hash" then
      if redis.call("EXISTS", KEYS[2]) == 0 then return {-3, ""} end
      if redis.call("HGET", KEYS[2], "channelId") ~= ARGV[6]
        or redis.call("HGET", KEYS[2], "network") ~= ARGV[5]
        or redis.call("HGET", KEYS[2], "payer") ~= ARGV[10]
        or redis.call("HGET", KEYS[2], "asset") ~= ARGV[11]
        or redis.call("HGET", KEYS[2], "payTo") ~= ARGV[12]
        or redis.call("HGET", KEYS[2], "resource") ~= ARGV[13]
        or redis.call("HGET", KEYS[2], "signedMaxClaimable") ~= ARGV[14]
        or redis.call("HGET", KEYS[2], "signature") ~= ARGV[15]
        or redis.call("HGET", KEYS[2], "channelConfigFingerprint") ~= ARGV[16]
        or redis.call("HGET", KEYS[2], "backingFingerprint") ~= ARGV[17] then
        return {-4, ""}
      end
      charged = redis.call("HGET", KEYS[2], "chargedCumulativeAmount")
      balance = redis.call("HGET", KEYS[2], "balance")
    else
      return {-8, ""}
    end
    if not canonical_decimal(charged) or not canonical_decimal(balance) then return {-4, ""} end

    local checkpointRaw = redis.call("HGET", KEYS[1], ARGV[18])
    if checkpointRaw then
      local checkpoint = cjson.decode(checkpointRaw)
      if checkpoint.network ~= ARGV[5]
        or checkpoint.channelId ~= ARGV[6]
        or checkpoint.rootRunId ~= ARGV[7]
        or checkpoint.executionRunId ~= ARGV[8]
        or tostring(checkpoint.sequence) ~= ARGV[9]
        or checkpoint.amountWei ~= ARGV[2]
        or checkpoint.backingFingerprint ~= ARGV[17]
        or (checkpoint.idempotencyKey or "") ~= ARGV[19] then
        return {-5, ""}
      end
      redis.call("EXPIRE", KEYS[1], ARGV[4])
      return {2, checkpoint.cumulativeAmountWei or ""}
    end

    local used = redis.call("HGET", KEYS[1], "usedWei")
    local maximum = redis.call("HGET", KEYS[1], "maxAmountWei")
    local nextUsed = add_decimal(used, ARGV[2])
    if not nextUsed or not canonical_decimal(maximum) or greater_than(nextUsed, maximum) then
      return {-6, ""}
    end
    local nextCharged = add_decimal(charged, ARGV[2])
    if not nextCharged
      or greater_than(nextCharged, ARGV[14])
      or greater_than(nextCharged, balance) then
      return {-7, ""}
    end

    if ARGV[1] == "evm-json" then
      channel.chargedCumulativeAmount = nextCharged
      channel.lastRequestTimestamp = tonumber(ARGV[3])
      channel.pendingRequest = nil
      redis.call("SET", KEYS[2], cjson.encode(channel))
    else
      redis.call("HSET", KEYS[2],
        "chargedCumulativeAmount", nextCharged,
        "lastRequestTimestamp", ARGV[3])
      redis.call("SADD", KEYS[3], ARGV[6])
      redis.call("EXPIRE", KEYS[2], ARGV[4])
      redis.call("EXPIRE", KEYS[3], ARGV[4])
    end
    redis.call("HSET", KEYS[1], "usedWei", nextUsed, "updatedAt", ARGV[3])
    redis.call("EXPIRE", KEYS[1], ARGV[4])
    local storedCheckpoint = {
      network = ARGV[5],
      channelId = ARGV[6],
      rootRunId = ARGV[7],
      executionRunId = ARGV[8],
      sequence = tonumber(ARGV[9]),
      amountWei = ARGV[2],
      cumulativeAmountWei = nextCharged,
      backingFingerprint = ARGV[17]
    }
    if ARGV[19] ~= "" then
      storedCheckpoint.idempotencyKey = ARGV[19]
    end
    redis.call("HSET", KEYS[1], ARGV[18], cjson.encode(storedCheckpoint))
    return {1, nextCharged}`,
    3,
    key(input.rootRunId),
    input.channelKey,
    input.pendingKey || key(input.rootRunId),
    input.channelStorage,
    input.amountWei,
    String(Date.now()),
    String(TTL_SECONDS),
    input.backing.network,
    input.backing.channelId,
    input.rootRunId,
    input.executionRunId,
    String(input.sequence),
    input.backing.payer,
    input.backing.asset,
    input.backing.receiver,
    input.backing.resource,
    input.backing.signedMaxClaimable,
    input.backing.voucherSignature,
    input.backing.channelConfigFingerprint,
    input.backing.backingFingerprint,
    checkpointField,
    idempotencyKey,
  );
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Unexpected raw batch checkpoint transition response");
  }
  const status = Number(result[0]);
  const cumulativeAmountWei = String(result[1] ?? "");
  if (status === 1 || status === 2) {
    if (!/^(?:0|[1-9]\d*)$/u.test(cumulativeAmountWei)) {
      throw new Error("Raw batch checkpoint returned an invalid cumulative amount");
    }
    return { cumulativeAmountWei, replayed: status === 2 };
  }
  const errors: Record<number, string> = {
    [-1]: "Raw batch envelope not found",
    [-2]: "Raw batch envelope immutable backing mismatch",
    [-3]: "Batch-settlement channel not found",
    [-4]: "Batch-settlement channel immutable backing mismatch",
    [-5]: "Raw batch checkpoint identity was replayed with changed amount or immutable backing",
    [-6]: "Raw batch envelope budget exhausted",
    [-7]: "Batch-settlement channel budget exhausted",
    [-8]: "Unsupported raw batch channel storage",
  };
  throw new Error(errors[status] || "Raw batch checkpoint transition failed closed");
}
