import { createHash, randomUUID } from "node:crypto";

import type { ReceiptStreamPayload } from "../inference/core.js";
import {
  encodeReceiptHeader,
  RECEIPT_HEADER,
  type Receipt,
  type Bill,
  type LineItem,
} from "../http/request-context.js";
import type { InferenceSettlementReceipt } from "./index.js";
import { isEvmNetwork, type NetworkId } from "./configs/chains.js";
import {
  getValkeyClient,
  valkeyHGetAll,
  valkeySMembers,
} from "./keys/valkey.js";

export interface ReceiptContext {
  service?: string;
  action?: string;
  resource?: string;
  userAddress?: string;
  network?: NetworkId;
}

export interface ReceiptListResult {
  userAddress: string;
  network: NetworkId;
  cumulative: {
    totalAmountWei: string;
    providerAmountWei: string;
    platformFeeWei: string;
    receiptCount: number;
  };
  receipts: Receipt[];
}

type HeaderSink = {
  headersSent?: boolean;
  setHeader: (name: string, value: string) => unknown;
};

const RECEIPT_TTL_SECONDS = 60 * 60 * 24 * 180;
const RECEIPT_KEY_PREFIX = "x402:receipt";
const BATCH_RECONCILIATION_KEY_PREFIX = "x402:batch-reconciliation";
const BATCH_RECONCILIATION_TTL_SECONDS = RECEIPT_TTL_SECONDS;

function receiptKey(receiptId: string): string {
  return `${RECEIPT_KEY_PREFIX}:${receiptId}`;
}

export function normalizeReceiptUserAddress(userAddress: string, network: NetworkId): string {
  const trimmed = userAddress.trim();
  return isEvmNetwork(network) ? trimmed.toLowerCase() : trimmed;
}

function userReceiptsKey(userAddress: string, network: NetworkId): string {
  return `${RECEIPT_KEY_PREFIX}:user:${network}:${normalizeReceiptUserAddress(userAddress, network)}`;
}

function userAggregateKey(userAddress: string, network: NetworkId): string {
  return `${RECEIPT_KEY_PREFIX}:aggregate:${network}:${normalizeReceiptUserAddress(userAddress, network)}`;
}

function batchChannelIdentity(channelId: string, network: NetworkId): string {
  return isEvmNetwork(network) ? channelId.toLowerCase() : channelId;
}

function batchReceiptsKey(channelId: string, network: NetworkId): string {
  return `${RECEIPT_KEY_PREFIX}:batch:${network}:${batchChannelIdentity(channelId, network)}`;
}

function batchReconciliationKey(channelId: string, network: NetworkId): string {
  return `${BATCH_RECONCILIATION_KEY_PREFIX}:${network}:${batchChannelIdentity(channelId, network)}`;
}

function intentReceiptsKey(intentId: string): string {
  return `${RECEIPT_KEY_PREFIX}:intent:${intentId}`;
}

function paymentIntentRecordKey(intentId: string): string {
  return `payment-intent:${intentId}`;
}

function requireBatchReceiptNetwork(receipt: Receipt): NetworkId {
  if (!receipt.network) {
    throw new Error("Batch receipt network is required");
  }
  return receipt.network as NetworkId;
}

function assertCanonicalBatchCumulativeAmount(value: string): void {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error("Batch receipt cumulative amount must be a canonical unsigned decimal integer");
  }
}

function transactionIdentity(txHash: string, network: NetworkId): string {
  return isEvmNetwork(network) ? txHash.toLowerCase() : txHash;
}

function stableReceiptId(receipt: Receipt): string {
  if (receipt.paymentChannelId && receipt.paymentCumulativeAmountWei !== undefined) {
    assertCanonicalBatchCumulativeAmount(receipt.paymentCumulativeAmountWei);
  }
  let identity: unknown[] | null = null;
  if (receipt.paymentChannelId && receipt.paymentCumulativeAmountWei) {
    const network = requireBatchReceiptNetwork(receipt);
    identity = [
      "batch",
      network,
      batchChannelIdentity(receipt.paymentChannelId, network),
      receipt.paymentCumulativeAmountWei,
    ];
  } else if (receipt.paymentIntentId) {
    identity = ["intent", receipt.paymentIntentId];
  } else if (receipt.txHash) {
    const network = receipt.network as NetworkId;
    identity = ["transaction", network, transactionIdentity(receipt.txHash, network)];
  }
  if (!identity) return receipt.id || `rct_${randomUUID().replace(/-/g, "")}`;
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const canonical = `rct_${digest.slice(0, 32)}`;
  if (receipt.id && receipt.id !== canonical) {
    throw new Error("Explicit receipt id conflicts with canonical backing");
  }
  return canonical;
}

const UPSERT_BATCH_RECONCILIATION_LUA = `
  local function text(value)
    if value == nil or value == cjson.null then return "" end
    return tostring(value)
  end

  local function transaction_identity(network, value)
    value = text(value)
    if string.sub(network, 1, 7) == "eip155:" then
      return string.lower(value)
    end
    return value
  end

  local function channel_identity(network, channel)
    channel = text(channel)
    if string.sub(network, 1, 7) == "eip155:" then
      return string.lower(channel)
    end
    return channel
  end

  local function canonical_decimal(value)
    if not string.match(value, "^%d+$") then
      error("batch reconciliation amounts must be unsigned decimal integers")
    end
    local canonical = string.gsub(value, "^0+", "")
    return canonical == "" and "0" or canonical
  end

  local function compare_decimal(left, right)
    left = canonical_decimal(left)
    right = canonical_decimal(right)
    if string.len(left) < string.len(right) then return -1 end
    if string.len(left) > string.len(right) then return 1 end
    if left < right then return -1 end
    if left > right then return 1 end
    return 0
  end

  local current_network = redis.call("HGET", KEYS[1], "network")
  local current_channel = redis.call("HGET", KEYS[1], "channelId")
  if current_network and current_network ~= ARGV[4] then
    error("batch reconciliation network mismatch")
  end
  if current_channel and current_channel ~= ARGV[5] then
    error("batch reconciliation channel mismatch")
  end

  local amount = canonical_decimal(ARGV[1])
  local claim_hash = transaction_identity(ARGV[4], ARGV[2])
  local settle_hash = transaction_identity(ARGV[4], ARGV[3])
  if settle_hash ~= "" then
    for _, receipt_id in ipairs(redis.call("SMEMBERS", KEYS[2])) do
      local receipt_raw = redis.call("GET", ARGV[8] .. receipt_id)
      if receipt_raw then
        local receipt = cjson.decode(receipt_raw)
        if text(receipt.network) == ARGV[4]
          and channel_identity(ARGV[4], receipt.paymentChannelId) == ARGV[5]
          and text(receipt.settlementStatus) == "failed"
          and compare_decimal(text(receipt.paymentCumulativeAmountWei), amount) <= 0 then
          local failed_hash = transaction_identity(ARGV[4], receipt.txHash)
          if failed_hash == "" then
            failed_hash = transaction_identity(ARGV[4], receipt.settleTxHash)
          end
          if failed_hash ~= "" and failed_hash ~= settle_hash then
            error("Batch receipt terminal transaction mismatch")
          end
        end
      end
    end
  end
  local claim_field = "claim:" .. amount
  local settle_field = "settle:" .. amount
  local existing_claim_raw = redis.call("HGET", KEYS[1], claim_field)
  local existing_claim = existing_claim_raw and cjson.decode(existing_claim_raw) or nil
  local existing_claim_hash = existing_claim
    and transaction_identity(ARGV[4], existing_claim.claimTxHash or "") or ""
  if existing_claim and claim_hash ~= "" and existing_claim_hash ~= ""
    and existing_claim_hash ~= claim_hash then
    error("claim transaction mismatch for cumulative watermark " .. amount)
  end
  local existing_settle_raw = redis.call("HGET", KEYS[1], settle_field)
  local existing_settle = existing_settle_raw and cjson.decode(existing_settle_raw) or nil
  local existing_settle_hash = existing_settle
    and transaction_identity(ARGV[4], existing_settle.settleTxHash or "") or ""
  if existing_settle and settle_hash ~= "" and existing_settle_hash ~= ""
    and existing_settle_hash ~= settle_hash then
    error("settle transaction mismatch for cumulative watermark " .. amount)
  end

  local claim_transition = existing_claim or {
    amountWei = amount,
    claimTxHash = claim_hash,
    claimedAt = ARGV[6]
  }
  claim_transition.claimTxHash = transaction_identity(ARGV[4], claim_transition.claimTxHash or "")
  if claim_transition.claimTxHash == "" and claim_hash ~= "" then
    claim_transition.claimTxHash = claim_hash
  end
  redis.call("HSET", KEYS[1], claim_field, cjson.encode(claim_transition))

  if settle_hash ~= "" then
    local settle_transition = existing_settle or {
      amountWei = amount,
      claimTxHash = claim_hash,
      settleTxHash = settle_hash,
      settledAt = ARGV[6]
    }
    settle_transition.claimTxHash = transaction_identity(ARGV[4], settle_transition.claimTxHash or "")
    settle_transition.settleTxHash = transaction_identity(ARGV[4], settle_transition.settleTxHash or "")
    if settle_transition.claimTxHash == "" and claim_hash ~= "" then
      settle_transition.claimTxHash = claim_hash
    end
    if settle_transition.settleTxHash == "" then
      settle_transition.settleTxHash = settle_hash
    end
    redis.call("HSET", KEYS[1], settle_field, cjson.encode(settle_transition))
  end

  local current_claimed = redis.call("HGET", KEYS[1], "claimedAmountWei") or "0"
  local claim_comparison = compare_decimal(amount, current_claimed)
  if claim_comparison > 0 then
    redis.call("HSET", KEYS[1],
      "claimedAmountWei", amount,
      "claimTxHash", claim_hash,
      "claimedAt", ARGV[6])
  elseif claim_comparison == 0 then
    if claim_hash ~= "" and (redis.call("HGET", KEYS[1], "claimTxHash") or "") == "" then
      redis.call("HSET", KEYS[1], "claimTxHash", claim_hash)
    end
    if not redis.call("HGET", KEYS[1], "claimedAt") then
      redis.call("HSET", KEYS[1], "claimedAt", ARGV[6])
    end
  end

  if settle_hash ~= "" then
    local current_settled = redis.call("HGET", KEYS[1], "settledAmountWei") or "0"
    local settle_comparison = compare_decimal(amount, current_settled)
    if settle_comparison > 0 then
      redis.call("HSET", KEYS[1],
        "settledAmountWei", amount,
        "settledClaimTxHash", claim_hash,
        "settleTxHash", settle_hash,
        "settledAt", ARGV[6])
    elseif settle_comparison == 0 then
      if claim_hash ~= "" and (redis.call("HGET", KEYS[1], "settledClaimTxHash") or "") == "" then
        redis.call("HSET", KEYS[1], "settledClaimTxHash", claim_hash)
      end
      if (redis.call("HGET", KEYS[1], "settleTxHash") or "") == "" then
        redis.call("HSET", KEYS[1], "settleTxHash", settle_hash)
      end
      if not redis.call("HGET", KEYS[1], "settledAt") then
        redis.call("HSET", KEYS[1], "settledAt", ARGV[6])
      end
    end
  end

  redis.call("HSET", KEYS[1], "network", ARGV[4], "channelId", ARGV[5])
  redis.call("EXPIRE", KEYS[1], ARGV[7])
  return 1
`;

async function upsertBatchReconciliation(input: {
  channelId: string;
  network: NetworkId;
  claimedAmountWei: string;
  claimTxHash?: string;
  settleTxHash?: string;
}): Promise<void> {
  if (typeof input.claimedAmountWei !== "string" || !/^(0|[1-9]\d*)$/u.test(input.claimedAmountWei)) {
    throw new Error("Batch reconciliation amount must be a canonical unsigned decimal integer");
  }
  const valkey = await getValkeyClient();
  await valkey.eval(
    UPSERT_BATCH_RECONCILIATION_LUA,
    2,
    batchReconciliationKey(input.channelId, input.network),
    batchReceiptsKey(input.channelId, input.network),
    input.claimedAmountWei,
    input.claimTxHash ? transactionIdentity(input.claimTxHash, input.network) : "",
    input.settleTxHash ? transactionIdentity(input.settleTxHash, input.network) : "",
    input.network,
    batchChannelIdentity(input.channelId, input.network),
    String(Date.now()),
    String(BATCH_RECONCILIATION_TTL_SECONDS),
    `${RECEIPT_KEY_PREFIX}:`,
  );
}

const STORE_BATCH_RECEIPT_LUA = `
  local function text(value)
    if value == nil or value == cjson.null then return "" end
    return tostring(value)
  end

  local function canonical_decimal(value)
    if not string.match(value, "^%d+$") then
      error("batch receipt cumulative amount must be an unsigned decimal integer")
    end
    local canonical = string.gsub(value, "^0+", "")
    return canonical == "" and "0" or canonical
  end

  local function compare_decimal(left, right)
    left = canonical_decimal(left)
    right = canonical_decimal(right)
    if string.len(left) < string.len(right) then return -1 end
    if string.len(left) > string.len(right) then return 1 end
    if left < right then return -1 end
    if left > right then return 1 end
    return 0
  end

  local function less_or_equal(left, right)
    return compare_decimal(left, right) <= 0
  end

  local function rank(status)
    if status == "settled" then return 5 end
    if status == "failed" then return 4 end
    if status == "claimed" then return 3 end
    if status == "submitted" then return 2 end
    if status == "queued" then return 1 end
    return 0
  end

  local function channel_identity(network, channel)
    if string.sub(text(network), 1, 7) == "eip155:" then
      return string.lower(text(channel))
    end
    return text(channel)
  end

  local function same_transaction(network, left, right)
    left = text(left)
    right = text(right)
    if left == "" or right == "" then return true end
    if string.sub(text(network), 1, 7) == "eip155:" then
      return string.lower(left) == string.lower(right)
    end
    return left == right
  end

  local function assert_same_transaction(network, left, right)
    if not same_transaction(network, left, right) then
      error("Batch receipt terminal transaction mismatch")
    end
  end

  local function canonical_transaction(network, value)
    value = text(value)
    if string.sub(text(network), 1, 7) == "eip155:" then
      return string.lower(value)
    end
    return value
  end

  local function normalize_batch_transactions(receipt)
    local claim_hash = canonical_transaction(receipt.network, receipt.claimTxHash)
    local settle_hash = canonical_transaction(receipt.network, receipt.settleTxHash)
    local tx_hash = canonical_transaction(receipt.network, receipt.txHash)
    receipt.claimTxHash = claim_hash ~= "" and claim_hash or nil
    receipt.settleTxHash = settle_hash ~= "" and settle_hash or nil
    receipt.txHash = tx_hash ~= "" and tx_hash or nil
    local status = text(receipt.settlementStatus)
    if status == "settled" or status == "failed" then
      if tx_hash ~= "" and settle_hash ~= "" and not same_transaction(receipt.network, tx_hash, settle_hash) then
        error("Batch receipt terminal transaction mismatch")
      end
      if tx_hash == "" and settle_hash ~= "" then
        tx_hash = settle_hash
        receipt.txHash = settle_hash
      end
      if status == "settled" and tx_hash == "" then
        error("Batch settled receipt transaction identity is required")
      end
    end
  end

  local function earliest_transition(prefix, cumulative, state_key)
    local values = redis.call("HGETALL", state_key)
    local selected = nil
    for index = 1, #values, 2 do
      local field = values[index]
      if string.sub(field, 1, #prefix) == prefix then
        local transition = cjson.decode(values[index + 1])
        if transition.amountWei and less_or_equal(cumulative, transition.amountWei)
          and (not selected or compare_decimal(transition.amountWei, selected.amountWei) < 0) then
          selected = transition
        end
      end
    end
    return selected
  end

  local function matches_covering_transaction(prefix, cumulative, state_key, hash_field, network, tx_hash)
    tx_hash = text(tx_hash)
    if tx_hash == "" then return true end
    local values = redis.call("HGETALL", state_key)
    for index = 1, #values, 2 do
      local field = values[index]
      if string.sub(field, 1, #prefix) == prefix then
        local transition = cjson.decode(values[index + 1])
        local transition_hash = text(transition[hash_field])
        if transition.amountWei and less_or_equal(cumulative, transition.amountWei)
          and transition_hash ~= "" and same_transaction(network, tx_hash, transition_hash) then
          return true
        end
      end
    end
    return false
  end

  local function aggregate_decimal(value)
    if not string.match(value, "^%d+$") then
      error("receipt aggregate values must be unsigned decimal integers")
    end
    local canonical = string.gsub(value, "^0+", "")
    return canonical == "" and "0" or canonical
  end

  local function add_decimal(left, right)
    left = aggregate_decimal(left)
    right = aggregate_decimal(right)
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

  local incoming = cjson.decode(ARGV[1])
  normalize_batch_transactions(incoming)
  if text(incoming.id) == "" or text(incoming.userAddress) == ""
    or text(incoming.network) == "" or text(incoming.paymentChannelId) == ""
    or text(incoming.paymentCumulativeAmountWei) == "" then
    error("Batch receipt identity is incomplete")
  end
  canonical_decimal(text(incoming.paymentCumulativeAmountWei))
  if text(incoming.network) ~= ARGV[4]
    or channel_identity(incoming.network, incoming.paymentChannelId) ~= ARGV[5] then
    error("Batch receipt backing mismatch")
  end
  local full = incoming
  local current_raw = redis.call("GET", KEYS[1])
  if current_raw then
    local current = cjson.decode(current_raw)
    normalize_batch_transactions(current)
    local immutable = {
      "id", "network", "userAddress", "paymentIntentId", "paymentChannelId",
      "paymentCumulativeAmountWei", "finalAmountWei", "providerAmountWei", "platformFeeWei",
      "rootRunId", "executionRunId", "parentExecutionRunId"
    }
    for _, field in ipairs(immutable) do
      if text(current[field]) ~= text(incoming[field]) then
        error("Receipt replay changed immutable " .. field)
      end
    end
    if current.settlementStatus == "settled" and incoming.settlementStatus == "settled" then
      assert_same_transaction(current.network, current.txHash, incoming.txHash)
    elseif current.settlementStatus == "failed"
      and (incoming.settlementStatus == "failed" or incoming.settlementStatus == "settled") then
      assert_same_transaction(current.network, current.txHash, incoming.txHash)
    end
    if rank(current.settlementStatus) >= rank("claimed")
      and rank(incoming.settlementStatus) >= rank("claimed")
      and text(current.claimTxHash) ~= "" and text(incoming.claimTxHash) ~= "" then
      assert_same_transaction(current.network, current.claimTxHash, incoming.claimTxHash)
    end
    if rank(current.settlementStatus) >= rank(incoming.settlementStatus) then
      full = current
    else
      full = current
      for field, value in pairs(incoming) do full[field] = value end
      if current.bills and #current.bills > 0 then full.bills = current.bills end
    end
  end

  if text(full.paymentIntentId) ~= "" and redis.call("EXISTS", KEYS[7]) == 1
    and (redis.call("HGET", KEYS[7], "paymentIntentId") or "") ~= "" then
    local intent_id = redis.call("HGET", KEYS[7], "paymentIntentId") or ""
    local intent_network = redis.call("HGET", KEYS[7], "network") or ""
    local intent_status = redis.call("HGET", KEYS[7], "status") or ""
    local intent_tx_hash = redis.call("HGET", KEYS[7], "txHash") or ""
    if intent_id ~= "" and intent_id ~= text(full.paymentIntentId) then
      error("Batch receipt payment intent mismatch")
    end
    if intent_network ~= "" and intent_network ~= text(full.network) then
      error("Batch receipt payment intent network mismatch")
    end
    if intent_status == "confirmed" then
      if intent_tx_hash == "" then
        error("Confirmed payment intent is missing its transaction identity")
      end
      if full.settlementStatus == "settled" or full.settlementStatus == "failed" then
        assert_same_transaction(full.network, full.txHash, intent_tx_hash)
      end
      full.settlementStatus = "settled"
      full.txHash = intent_tx_hash
      full.settledAt = tonumber(redis.call("HGET", KEYS[7], "confirmedAt") or ARGV[3])
    elseif intent_status == "submitted" then
      if intent_tx_hash == "" then
        error("Submitted payment intent is missing its transaction identity")
      end
      if full.settlementStatus == "submitted" then
        assert_same_transaction(full.network, full.txHash, intent_tx_hash)
      end
      if rank(full.settlementStatus) < rank("submitted") then
        full.settlementStatus = "submitted"
        full.txHash = intent_tx_hash
        full.settledAt = nil
      end
    elseif intent_status == "failed" or intent_status == "released" then
      if full.settlementStatus ~= "settled" then
        if full.settlementStatus == "failed" then
          assert_same_transaction(full.network, full.txHash, intent_tx_hash)
        end
        full.settlementStatus = "failed"
        full.settledAt = nil
        if intent_tx_hash ~= "" then full.txHash = intent_tx_hash end
      end
    end
  end

  local state_network = redis.call("HGET", KEYS[4], "network")
  local state_channel = redis.call("HGET", KEYS[4], "channelId")
  if state_network then
    if text(full.network) ~= state_network or state_network ~= ARGV[4] then
      error("Batch receipt reconciliation network mismatch")
    end
    if not state_channel
      or channel_identity(full.network, full.paymentChannelId) ~= state_channel
      or state_channel ~= ARGV[5] then
      error("Batch receipt reconciliation channel mismatch")
    end
    local cumulative = text(full.paymentCumulativeAmountWei)
    local settled = earliest_transition("settle:", cumulative, KEYS[4])
    local claimed = earliest_transition("claim:", cumulative, KEYS[4])
    if settled then
      local settle_hash = settled.settleTxHash or ""
      if full.settlementStatus == "failed" then
        assert_same_transaction(full.network, full.txHash, settle_hash)
      elseif full.settlementStatus == "settled"
        and not same_transaction(full.network, full.txHash, settle_hash)
        and not matches_covering_transaction(
          "settle:", cumulative, KEYS[4], "settleTxHash", full.network, full.txHash
        ) then
        assert_same_transaction(full.network, full.txHash, settle_hash)
      end
      full.settlementStatus = "settled"
      local settled_claim_hash = claimed and claimed.claimTxHash or ""
      full.claimTxHash = settled_claim_hash ~= "" and settled_claim_hash or nil
      full.settleTxHash = settle_hash ~= "" and settle_hash or nil
      full.txHash = settle_hash ~= "" and settle_hash or nil
      full.network = state_network
      full.settledAt = tonumber(settled.settledAt)
    elseif claimed and full.settlementStatus ~= "failed" and rank(full.settlementStatus) <= 3 then
      full.settlementStatus = "claimed"
      local claim_hash = claimed.claimTxHash or ""
      full.claimTxHash = claim_hash ~= "" and claim_hash or nil
      full.network = state_network
    end
  end

  normalize_batch_transactions(full)

  local aggregate_applied_field = "applied:" .. text(full.id)
  local aggregate_applied = redis.call("HEXISTS", KEYS[5], aggregate_applied_field) == 1
  local aggregate = nil
  if full.settlementStatus == "settled" and text(full.settledAt) ~= ""
    and not aggregate_applied then
    local provider_amount = text(full.providerAmountWei)
    local platform_fee = text(full.platformFeeWei)
    if provider_amount == "" then provider_amount = "0" end
    if platform_fee == "" then platform_fee = "0" end
    aggregate = {
      totalAmountWei = add_decimal(redis.call("HGET", KEYS[5], "totalAmountWei") or "0", text(full.finalAmountWei)),
      providerAmountWei = add_decimal(redis.call("HGET", KEYS[5], "providerAmountWei") or "0", provider_amount),
      platformFeeWei = add_decimal(redis.call("HGET", KEYS[5], "platformFeeWei") or "0", platform_fee),
      receiptCount = add_decimal(redis.call("HGET", KEYS[5], "receiptCount") or "0", "1")
    }
  end

  local encoded = cjson.encode(full)
  if aggregate then
    redis.call("HSET", KEYS[5],
      "totalAmountWei", aggregate.totalAmountWei,
      "providerAmountWei", aggregate.providerAmountWei,
      "platformFeeWei", aggregate.platformFeeWei,
      "receiptCount", aggregate.receiptCount,
      "lastReceiptId", text(full.id),
      "lastReceiptAt", text(full.settledAt),
      aggregate_applied_field, "1")
    redis.call("EXPIRE", KEYS[5], ARGV[2])
  elseif full.settlementStatus == "settled" and text(full.settledAt) ~= ""
    and aggregate_applied then
    redis.call("EXPIRE", KEYS[5], ARGV[2])
  end
  redis.call("SETEX", KEYS[1], ARGV[2], encoded)
  redis.call("SADD", KEYS[2], text(full.id))
  redis.call("EXPIRE", KEYS[2], ARGV[2])
  redis.call("SADD", KEYS[3], text(full.id))
  redis.call("EXPIRE", KEYS[3], ARGV[2])
  if text(full.paymentIntentId) ~= "" then
    redis.call("SADD", KEYS[6], text(full.id))
    redis.call("EXPIRE", KEYS[6], ARGV[2])
  end
  return encoded
`;

async function storeBatchReceiptAtomically(receipt: Receipt): Promise<Receipt> {
  if (!receipt.id || !receipt.userAddress || !receipt.paymentChannelId || !receipt.paymentCumulativeAmountWei) {
    throw new Error("Batch receipt identity is incomplete");
  }
  const network = requireBatchReceiptNetwork(receipt);
  const paymentIntentId = receipt.paymentIntentId;
  const valkey = await getValkeyClient();
  const result = await valkey.eval(
    STORE_BATCH_RECEIPT_LUA,
    7,
    receiptKey(receipt.id),
    userReceiptsKey(receipt.userAddress, network),
    batchReceiptsKey(receipt.paymentChannelId, network),
    batchReconciliationKey(receipt.paymentChannelId, network),
    userAggregateKey(receipt.userAddress, network),
    intentReceiptsKey(paymentIntentId || `none:${receipt.id}`),
    `payment-intent:${paymentIntentId || `none:${receipt.id}`}`,
    JSON.stringify(receipt),
    String(RECEIPT_TTL_SECONDS),
    String(Date.now()),
    network,
    batchChannelIdentity(receipt.paymentChannelId, network),
  );
  if (typeof result !== "string") {
    throw new Error("Batch receipt persistence returned an invalid result");
  }
  return JSON.parse(result) as Receipt;
}

const RECONCILE_BATCH_RECEIPT_LUA = `
  local function text(value)
    if value == nil or value == cjson.null then return "" end
    return tostring(value)
  end

  local function canonical_decimal(value)
    if not string.match(value, "^%d+$") then
      error("batch receipt cumulative amount must be an unsigned decimal integer")
    end
    local canonical = string.gsub(value, "^0+", "")
    return canonical == "" and "0" or canonical
  end

  local function compare_decimal(left, right)
    left = canonical_decimal(left)
    right = canonical_decimal(right)
    if string.len(left) < string.len(right) then return -1 end
    if string.len(left) > string.len(right) then return 1 end
    if left < right then return -1 end
    if left > right then return 1 end
    return 0
  end

  local function less_or_equal(left, right)
    return compare_decimal(left, right) <= 0
  end

  local function rank(status)
    if status == "settled" then return 5 end
    if status == "failed" then return 4 end
    if status == "claimed" then return 3 end
    if status == "submitted" then return 2 end
    if status == "queued" then return 1 end
    return 0
  end

  local function channel_identity(network, channel)
    if string.sub(text(network), 1, 7) == "eip155:" then
      return string.lower(text(channel))
    end
    return text(channel)
  end

  local function same_transaction(network, left, right)
    left = text(left)
    right = text(right)
    if left == "" or right == "" then return true end
    if string.sub(text(network), 1, 7) == "eip155:" then
      return string.lower(left) == string.lower(right)
    end
    return left == right
  end

  local function assert_same_transaction(network, left, right)
    if not same_transaction(network, left, right) then
      error("Batch receipt terminal transaction mismatch")
    end
  end

  local function earliest_transition(prefix, cumulative, state_key)
    local values = redis.call("HGETALL", state_key)
    local selected = nil
    for index = 1, #values, 2 do
      local field = values[index]
      if string.sub(field, 1, #prefix) == prefix then
        local transition = cjson.decode(values[index + 1])
        if transition.amountWei and less_or_equal(cumulative, transition.amountWei)
          and (not selected or compare_decimal(transition.amountWei, selected.amountWei) < 0) then
          selected = transition
        end
      end
    end
    return selected
  end

  local function matches_covering_transaction(prefix, cumulative, state_key, hash_field, network, tx_hash)
    tx_hash = text(tx_hash)
    if tx_hash == "" then return true end
    local values = redis.call("HGETALL", state_key)
    for index = 1, #values, 2 do
      local field = values[index]
      if string.sub(field, 1, #prefix) == prefix then
        local transition = cjson.decode(values[index + 1])
        local transition_hash = text(transition[hash_field])
        if transition.amountWei and less_or_equal(cumulative, transition.amountWei)
          and transition_hash ~= "" and same_transaction(network, tx_hash, transition_hash) then
          return true
        end
      end
    end
    return false
  end

  local function aggregate_decimal(value)
    if not string.match(value, "^%d+$") then
      error("receipt aggregate values must be unsigned decimal integers")
    end
    local canonical = string.gsub(value, "^0+", "")
    return canonical == "" and "0" or canonical
  end

  local function add_decimal(left, right)
    left = aggregate_decimal(left)
    right = aggregate_decimal(right)
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

  local raw = redis.call("GET", KEYS[1])
  if not raw then return {0, ""} end
  local receipt = cjson.decode(raw)
  if text(receipt.id) == "" or text(receipt.userAddress) == ""
    or text(receipt.network) == "" or text(receipt.paymentChannelId) == ""
    or text(receipt.paymentCumulativeAmountWei) == "" then
    error("Batch receipt identity is incomplete")
  end
  canonical_decimal(text(receipt.paymentCumulativeAmountWei))
  if text(receipt.network) ~= ARGV[2]
    or channel_identity(receipt.network, receipt.paymentChannelId) ~= ARGV[3] then
    error("Batch receipt backing mismatch")
  end
  local before_status = text(receipt.settlementStatus)
  local before_claim_hash = text(receipt.claimTxHash)
  local before_settle_hash = text(receipt.settleTxHash)
  local before_tx_hash = text(receipt.txHash)
  local before_settled_at = text(receipt.settledAt)
  local before_network = text(receipt.network)

  local state_network = redis.call("HGET", KEYS[2], "network")
  local state_channel = redis.call("HGET", KEYS[2], "channelId")
  if state_network then
    if before_network ~= state_network or state_network ~= ARGV[2] then
      error("Batch receipt reconciliation network mismatch")
    end
    if not state_channel
      or channel_identity(receipt.network, receipt.paymentChannelId) ~= state_channel
      or state_channel ~= ARGV[3] then
      error("Batch receipt reconciliation channel mismatch")
    end
    local cumulative = text(receipt.paymentCumulativeAmountWei)
    local settled = earliest_transition("settle:", cumulative, KEYS[2])
    local claimed = earliest_transition("claim:", cumulative, KEYS[2])
    if settled then
      local settle_hash = settled.settleTxHash or ""
      if receipt.settlementStatus == "failed" then
        assert_same_transaction(receipt.network, receipt.txHash, settle_hash)
      elseif receipt.settlementStatus == "settled"
        and not same_transaction(receipt.network, receipt.txHash, settle_hash)
        and not matches_covering_transaction(
          "settle:", cumulative, KEYS[2], "settleTxHash", receipt.network, receipt.txHash
        ) then
        assert_same_transaction(receipt.network, receipt.txHash, settle_hash)
      end
      receipt.settlementStatus = "settled"
      local settled_claim_hash = claimed and claimed.claimTxHash or ""
      receipt.claimTxHash = settled_claim_hash ~= "" and settled_claim_hash or nil
      receipt.settleTxHash = settle_hash ~= "" and settle_hash or nil
      receipt.txHash = settle_hash ~= "" and settle_hash or nil
      receipt.network = state_network
      receipt.settledAt = tonumber(settled.settledAt)
    elseif claimed and receipt.settlementStatus ~= "failed" and rank(receipt.settlementStatus) <= 3 then
      receipt.settlementStatus = "claimed"
      local claim_hash = claimed.claimTxHash or ""
      receipt.claimTxHash = claim_hash ~= "" and claim_hash or nil
      receipt.network = state_network
    end
  end

  local changed = before_status ~= text(receipt.settlementStatus)
    or before_claim_hash ~= text(receipt.claimTxHash)
    or before_settle_hash ~= text(receipt.settleTxHash)
    or before_tx_hash ~= text(receipt.txHash)
    or before_settled_at ~= text(receipt.settledAt)
    or before_network ~= text(receipt.network)
  local aggregate_key = "x402:receipt:aggregate:" .. text(receipt.network) .. ":" .. text(receipt.userAddress)
  local aggregate_applied_field = "applied:" .. text(receipt.id)
  local aggregate_applied = redis.call("HEXISTS", aggregate_key, aggregate_applied_field) == 1
  local aggregate = nil
  if receipt.settlementStatus == "settled" and text(receipt.settledAt) ~= ""
    and not aggregate_applied then
    local provider_amount = text(receipt.providerAmountWei)
    local platform_fee = text(receipt.platformFeeWei)
    if provider_amount == "" then provider_amount = "0" end
    if platform_fee == "" then platform_fee = "0" end
    aggregate = {
      totalAmountWei = add_decimal(redis.call("HGET", aggregate_key, "totalAmountWei") or "0", text(receipt.finalAmountWei)),
      providerAmountWei = add_decimal(redis.call("HGET", aggregate_key, "providerAmountWei") or "0", provider_amount),
      platformFeeWei = add_decimal(redis.call("HGET", aggregate_key, "platformFeeWei") or "0", platform_fee),
      receiptCount = add_decimal(redis.call("HGET", aggregate_key, "receiptCount") or "0", "1")
    }
  end
  local encoded = cjson.encode(receipt)
  if aggregate then
    redis.call("HSET", aggregate_key,
      "totalAmountWei", aggregate.totalAmountWei,
      "providerAmountWei", aggregate.providerAmountWei,
      "platformFeeWei", aggregate.platformFeeWei,
      "receiptCount", aggregate.receiptCount,
      "lastReceiptId", text(receipt.id),
      "lastReceiptAt", text(receipt.settledAt),
      aggregate_applied_field, "1")
    redis.call("EXPIRE", aggregate_key, ARGV[1])
  elseif receipt.settlementStatus == "settled" and text(receipt.settledAt) ~= ""
    and aggregate_applied then
    redis.call("EXPIRE", aggregate_key, ARGV[1])
  end
  if redis.call("EXISTS", aggregate_key) == 1 then
    redis.call("EXPIRE", aggregate_key, ARGV[1])
  end
  redis.call("SETEX", KEYS[1], ARGV[1], encoded)
  local user_key = "x402:receipt:user:" .. text(receipt.network) .. ":" .. text(receipt.userAddress)
  redis.call("SADD", user_key, text(receipt.id))
  redis.call("EXPIRE", user_key, ARGV[1])
  local batch_key = "x402:receipt:batch:" .. text(receipt.network) .. ":"
    .. channel_identity(receipt.network, receipt.paymentChannelId)
  redis.call("SADD", batch_key, text(receipt.id))
  redis.call("EXPIRE", batch_key, ARGV[1])
  if text(receipt.paymentIntentId) ~= "" then
    local intent_key = "x402:receipt:intent:" .. text(receipt.paymentIntentId)
    redis.call("SADD", intent_key, text(receipt.id))
    redis.call("EXPIRE", intent_key, ARGV[1])
  end
  return {changed and 1 or 0, encoded}
`;

async function reconcileStoredBatchReceipt(
  receiptId: string,
  channelId: string,
  network: NetworkId,
): Promise<{ changed: boolean; receipt: Receipt | null }> {
  const valkey = await getValkeyClient();
  const result = await valkey.eval(
    RECONCILE_BATCH_RECEIPT_LUA,
    2,
    receiptKey(receiptId),
    batchReconciliationKey(channelId, network),
    String(RECEIPT_TTL_SECONDS),
    network,
    batchChannelIdentity(channelId, network),
  ) as [number | string, string];
  const encoded = String(result?.[1] || "");
  return {
    changed: Number(result?.[0]) === 1,
    receipt: encoded ? JSON.parse(encoded) as Receipt : null,
  };
}

function addWei(a: string | undefined, b: string | undefined): string {
  return ((a ? BigInt(a) : 0n) + (b ? BigInt(b) : 0n)).toString();
}

function parseNestedBill(item: LineItem): {
  kind: Bill["kind"];
  source?: string;
  subject?: string;
} | null {
  const match = /^(model|tool|search|memory|connector)\.([^.]+)\.(.+):[^:]+$/u.exec(item.key);
  if (!match) {
    return null;
  }
  return {
    kind: match[1] as Bill["kind"],
    source: match[2],
    subject: match[3],
  };
}

function billKeyForItem(item: LineItem, receipt: Receipt): string {
  const parsed = parseNestedBill(item);
  if (parsed) {
    return [parsed.kind, parsed.source, parsed.subject].filter(Boolean).join(":");
  }
  const kind = receipt.service === "workflow" ? "workflow" : "agent";
  return [kind, receipt.action, receipt.subject].filter(Boolean).join(":");
}

export function buildBills(receipt: Receipt): Bill[] {
  const lineItems = receipt.lineItems || [];
  const grouped = new Map<string, Bill>();

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

async function cumulativeFor(userAddress: string, network: NetworkId): Promise<Receipt["cumulative"]> {
  const aggregate = await valkeyHGetAll(userAggregateKey(userAddress, network));
  return {
    totalAmountWei: aggregate.totalAmountWei || "0",
    providerAmountWei: aggregate.providerAmountWei || "0",
    platformFeeWei: aggregate.platformFeeWei || "0",
    receiptCount: Number.parseInt(aggregate.receiptCount || "0", 10) || 0,
  };
}

type NonBatchReceiptTransition =
  | { operation: "publish"; receipt: Receipt }
  | { operation: "settle"; paymentIntentId: string; txHash: string; settledAt: number }
  | { operation: "fail"; paymentIntentId: string; txHash?: string };

async function transitionNonBatchReceipt(
  receiptId: string,
  transition: NonBatchReceiptTransition,
): Promise<{ changed: boolean; receipt: Receipt | null }> {
  const valkey = await getValkeyClient();
  const payload = transition.operation === "publish"
    ? transition.receipt
    : {
      settlementStatus: transition.operation === "settle" ? "settled" : "failed",
      paymentIntentId: transition.paymentIntentId,
      ...(transition.operation === "settle"
        ? { txHash: transition.txHash, settledAt: transition.settledAt }
        : transition.txHash ? { txHash: transition.txHash } : {}),
    };
  const paymentIntentId = transition.operation === "publish"
    ? transition.receipt.paymentIntentId
    : transition.paymentIntentId;
  const paymentIntentKey = `payment-intent:${paymentIntentId || `none:${receiptId}`}`;
  const result = await valkey.eval(
    `
      local function text(value)
        if value == nil or value == cjson.null then return "" end
        return tostring(value)
      end

      local function rank(status)
        if status == "settled" then return 5 end
        if status == "failed" then return 4 end
        if status == "claimed" then return 3 end
        if status == "submitted" then return 2 end
        if status == "queued" then return 1 end
        return 0
      end

      local function same_transaction(network, left, right)
        left = text(left)
        right = text(right)
        if left == "" or right == "" then return true end
        if string.sub(text(network), 1, 7) == "eip155:" then
          return string.lower(left) == string.lower(right)
        end
        return left == right
      end

      local function assert_same_transaction(network, left, right)
        if not same_transaction(network, left, right) then
          error("Receipt terminal transaction mismatch")
        end
      end

      local function canonical_decimal(value)
        if not string.match(value, "^%d+$") then
          error("receipt aggregate values must be unsigned decimal integers")
        end
        local canonical = string.gsub(value, "^0+", "")
        return canonical == "" and "0" or canonical
      end

      local function add_decimal(left, right)
        left = canonical_decimal(left)
        right = canonical_decimal(right)
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

      local operation = ARGV[1]
      local payload = cjson.decode(ARGV[2])
      local current_raw = redis.call("GET", KEYS[1])
      local current = current_raw and cjson.decode(current_raw) or nil
      local receipt = nil
      local changed = 0

      if operation == "publish" then
        receipt = payload
        if current then
          local immutable = {
            "id", "network", "userAddress", "paymentIntentId", "paymentChannelId",
            "paymentCumulativeAmountWei", "finalAmountWei", "providerAmountWei", "platformFeeWei",
            "rootRunId", "executionRunId", "parentExecutionRunId"
          }
          for _, field in ipairs(immutable) do
            if text(current[field]) ~= text(receipt[field]) then
              error("Receipt replay changed immutable " .. field)
            end
          end
          if current.settlementStatus == "settled" and receipt.settlementStatus == "settled" then
            assert_same_transaction(current.network, current.txHash, receipt.txHash)
          elseif current.settlementStatus == "failed"
            and (receipt.settlementStatus == "failed" or receipt.settlementStatus == "settled") then
            assert_same_transaction(current.network, current.txHash, receipt.txHash)
          end
          if rank(current.settlementStatus) >= rank(receipt.settlementStatus) then
            receipt = current
          else
            local incoming = receipt
            local current_bills = current.bills
            receipt = current
            for field, value in pairs(incoming) do receipt[field] = value end
            if current_bills and #current_bills > 0 then receipt.bills = current_bills end
            changed = 1
          end
        else
          changed = 1
        end
      elseif operation == "settle" then
        if not current then return {0, ""} end
        receipt = current
        if text(receipt.paymentIntentId) ~= text(payload.paymentIntentId) then
          error("Receipt payment intent mismatch")
        end
        if receipt.settlementStatus == "settled" then
          assert_same_transaction(receipt.network, receipt.txHash, payload.txHash)
        else
          if receipt.settlementStatus == "failed" then
            assert_same_transaction(receipt.network, receipt.txHash, payload.txHash)
          end
          local settled_at = tonumber(text(payload.settledAt))
          if not settled_at then error("Settled receipt timestamp is required") end
          receipt.settlementStatus = "settled"
          receipt.txHash = payload.txHash
          receipt.settledAt = settled_at
          changed = 1
        end
      elseif operation == "fail" then
        if not current then return {0, ""} end
        receipt = current
        if text(receipt.paymentIntentId) ~= text(payload.paymentIntentId) then
          error("Receipt payment intent mismatch")
        end
        if receipt.settlementStatus == "settled" then
          -- A confirmed settlement is stronger than a racing failure projection.
        elseif receipt.settlementStatus == "failed" then
          assert_same_transaction(receipt.network, receipt.txHash, payload.txHash)
          if text(receipt.txHash) == "" and text(payload.txHash) ~= "" then
            receipt.txHash = payload.txHash
            changed = 1
          end
        else
          receipt.settlementStatus = "failed"
          receipt.settledAt = nil
          if text(payload.txHash) ~= "" then receipt.txHash = payload.txHash end
          changed = 1
        end
      else
        error("Unknown non-batch receipt transition")
      end

      if text(receipt.id) == "" or text(receipt.userAddress) == ""
        or text(receipt.network) == "" or text(receipt.finalAmountWei) == "" then
        error("Non-batch receipt identity is incomplete")
      end
      if text(receipt.paymentChannelId) ~= "" then
        error("Batch receipt cannot use non-batch transition")
      end

      if operation == "publish" and text(receipt.paymentIntentId) ~= ""
        and redis.call("EXISTS", KEYS[2]) == 1
        and (redis.call("HGET", KEYS[2], "paymentIntentId") or "") ~= "" then
        local intent_id = redis.call("HGET", KEYS[2], "paymentIntentId") or ""
        local intent_network = redis.call("HGET", KEYS[2], "network") or ""
        local intent_status = redis.call("HGET", KEYS[2], "status") or ""
        local intent_tx_hash = redis.call("HGET", KEYS[2], "txHash") or ""

        if intent_id ~= "" and intent_id ~= text(receipt.paymentIntentId) then
          error("Receipt payment intent mismatch")
        end
        if intent_network ~= "" and intent_network ~= text(receipt.network) then
          error("Receipt payment intent network mismatch")
        end

        local before_status = text(receipt.settlementStatus)
        local before_tx_hash = text(receipt.txHash)
        local before_settled_at = text(receipt.settledAt)
        if intent_status == "confirmed" then
          if intent_tx_hash == "" then
            error("Confirmed payment intent is missing its transaction identity")
          end
          if receipt.settlementStatus == "settled" or receipt.settlementStatus == "failed" then
            assert_same_transaction(receipt.network, receipt.txHash, intent_tx_hash)
          end
          receipt.settlementStatus = "settled"
          receipt.txHash = intent_tx_hash
          receipt.settledAt = tonumber(redis.call("HGET", KEYS[2], "confirmedAt") or ARGV[4])
        elseif intent_status == "submitted" then
          if intent_tx_hash == "" then
            error("Submitted payment intent is missing its transaction identity")
          end
          if receipt.settlementStatus == "submitted" then
            assert_same_transaction(receipt.network, receipt.txHash, intent_tx_hash)
          end
          if rank(receipt.settlementStatus) < rank("submitted") then
            receipt.settlementStatus = "submitted"
            receipt.txHash = intent_tx_hash
            receipt.settledAt = nil
          end
        elseif intent_status == "failed" or intent_status == "released" then
          if receipt.settlementStatus ~= "settled" then
            if receipt.settlementStatus == "failed" then
              assert_same_transaction(receipt.network, receipt.txHash, intent_tx_hash)
            end
            receipt.settlementStatus = "failed"
            receipt.settledAt = nil
            if intent_tx_hash ~= "" then receipt.txHash = intent_tx_hash end
          end
        end
        if before_status ~= text(receipt.settlementStatus)
          or before_tx_hash ~= text(receipt.txHash)
          or before_settled_at ~= text(receipt.settledAt) then
          changed = 1
        end
      end

      local aggregate_key = "x402:receipt:aggregate:" .. text(receipt.network) .. ":" .. text(receipt.userAddress)
      if receipt.settlementStatus == "settled" and text(receipt.settledAt) ~= "" then
        local applied_field = "applied:" .. text(receipt.id)
        if redis.call("HEXISTS", aggregate_key, applied_field) == 0 then
          local provider_amount = text(receipt.providerAmountWei)
          local platform_fee = text(receipt.platformFeeWei)
          if provider_amount == "" then provider_amount = "0" end
          if platform_fee == "" then platform_fee = "0" end
          local total = add_decimal(redis.call("HGET", aggregate_key, "totalAmountWei") or "0", text(receipt.finalAmountWei))
          local provider = add_decimal(redis.call("HGET", aggregate_key, "providerAmountWei") or "0", provider_amount)
          local platform = add_decimal(redis.call("HGET", aggregate_key, "platformFeeWei") or "0", platform_fee)
          local count = add_decimal(redis.call("HGET", aggregate_key, "receiptCount") or "0", "1")
          redis.call("HSET", aggregate_key,
            "totalAmountWei", total,
            "providerAmountWei", provider,
            "platformFeeWei", platform,
            "receiptCount", count,
            "lastReceiptId", text(receipt.id),
            "lastReceiptAt", text(receipt.settledAt),
            applied_field, "1")
        end
        redis.call("EXPIRE", aggregate_key, ARGV[3])
      end

      local encoded = cjson.encode(receipt)
      redis.call("SETEX", KEYS[1], ARGV[3], encoded)
      local user_key = "x402:receipt:user:" .. text(receipt.network) .. ":" .. text(receipt.userAddress)
      redis.call("SADD", user_key, text(receipt.id))
      redis.call("EXPIRE", user_key, ARGV[3])
      if text(receipt.paymentIntentId) ~= "" then
        local intent_key = "x402:receipt:intent:" .. text(receipt.paymentIntentId)
        redis.call("SADD", intent_key, text(receipt.id))
        redis.call("EXPIRE", intent_key, ARGV[3])
      end
      return {changed, encoded}
    `,
    2,
    receiptKey(receiptId),
    paymentIntentKey,
    transition.operation,
    JSON.stringify(payload),
    String(RECEIPT_TTL_SECONDS),
    String(Date.now()),
  ) as [number | string, string];
  const encoded = String(result?.[1] || "");
  return {
    changed: Number(result?.[0]) === 1,
    receipt: encoded ? JSON.parse(encoded) as Receipt : null,
  };
}

export async function storeReceipt(receipt: Receipt): Promise<Receipt> {
  const id = stableReceiptId(receipt);
  if (!receipt.userAddress) {
    return receipt;
  }

  const userAddress = receipt.userAddress;
  const network = receipt.network as NetworkId;
  let full: Receipt = {
    ...receipt,
    id,
    userAddress,
    bills: receipt.bills && receipt.bills.length > 0 ? receipt.bills : buildBills(receipt),
  };
  if (full.paymentChannelId) {
    if (!full.paymentCumulativeAmountWei) {
      throw new Error("Batch receipt cumulative amount is required");
    }
    full = await storeBatchReceiptAtomically(full);
  } else {
    const transitioned = await transitionNonBatchReceipt(id, { operation: "publish", receipt: full });
    if (!transitioned.receipt) {
      throw new Error("Non-batch receipt publication returned no receipt");
    }
    full = transitioned.receipt;
  }
  return {
    ...full,
    cumulative: await cumulativeFor(userAddress, network),
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
    userAddress: context.userAddress ?? receipt.userAddress,
  };
  full.bills = full.bills && full.bills.length > 0 ? full.bills : buildBills(full);
  return storeReceipt(full);
}

const LIST_RECEIPTS_LUA = `
  local function text(value)
    if value == nil or value == cjson.null then return "" end
    return tostring(value)
  end

  local encoded = {}
  for _, id in ipairs(redis.call("SMEMBERS", KEYS[1])) do
    local raw = redis.call("GET", ARGV[3] .. id)
    local valid = false
    if raw then
      local decoded, receipt = pcall(cjson.decode, raw)
      valid = decoded and type(receipt) == "table"
        and text(receipt.id) == id
        and text(receipt.userAddress) == ARGV[1]
        and text(receipt.network) == ARGV[2]
    end
    if valid then
      table.insert(encoded, raw)
    else
      redis.call("SREM", KEYS[1], id)
    end
  end
  return encoded
`;

function receiptSortKey(receipt: Receipt): number {
  if (typeof receipt.settledAt === "number" && Number.isFinite(receipt.settledAt) && receipt.settledAt > 0) {
    return receipt.settledAt;
  }
  if (
    receipt.settlementStatus === "queued"
    || receipt.settlementStatus === "submitted"
    || receipt.settlementStatus === "claimed"
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return 0;
}

export async function listReceipts(input: {
  userAddress: string;
  network: NetworkId;
  limit?: number;
  rootRunId?: string;
  executionRunId?: string;
}): Promise<ReceiptListResult> {
  const userAddress = input.userAddress;
  const cumulative = await cumulativeFor(userAddress, input.network);
  const valkey = await getValkeyClient();
  const encoded = await valkey.eval(
    LIST_RECEIPTS_LUA,
    1,
    userReceiptsKey(userAddress, input.network),
    userAddress,
    input.network,
    `${RECEIPT_KEY_PREFIX}:`,
  ) as string[];
  const rootFilter = input.rootRunId?.trim();
  const execFilter = input.executionRunId?.trim();
  const receipts = encoded
    .map((raw) => JSON.parse(String(raw)) as Receipt)
    .filter((receipt) => {
      if (rootFilter && receipt.rootRunId !== rootFilter) return false;
      if (execFilter && receipt.executionRunId !== execFilter) return false;
      return true;
    })
    .sort((a, b) => receiptSortKey(b) - receiptSortKey(a))
    .slice(0, input.limit ?? 50);

  return {
    userAddress,
    network: input.network,
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
  network: NetworkId;
  claimedAmountWei: string;
  claimTxHash?: string;
  settleTxHash?: string;
}): Promise<number> {
  await upsertBatchReconciliation(input);
  const ids = await valkeySMembers(batchReceiptsKey(input.channelId, input.network));
  let updated = 0;
  for (const id of ids) {
    const reconciled = await reconcileStoredBatchReceipt(id, input.channelId, input.network);
    if (reconciled.changed) updated += 1;
  }
  return updated;
}

export async function markIntentReceiptsSettled(input: {
  paymentIntentId?: string;
  txHash: string;
}): Promise<number> {
  const ids = new Set<string>();
  if (input.paymentIntentId) {
    for (const id of await valkeySMembers(intentReceiptsKey(input.paymentIntentId))) {
      ids.add(id);
    }
  }

  let updated = 0;
  for (const id of ids) {
    const transitioned = await transitionNonBatchReceipt(id, {
      operation: "settle",
      paymentIntentId: input.paymentIntentId!,
      txHash: input.txHash,
      settledAt: Date.now(),
    });
    if (transitioned.changed) updated += 1;
  }
  return updated;
}

export async function markIntentReceiptsFailed(input: {
  paymentIntentId?: string;
  txHash?: string;
  error?: string;
}): Promise<number> {
  if (!input.paymentIntentId) return 0;
  let updated = 0;
  for (const id of await valkeySMembers(intentReceiptsKey(input.paymentIntentId))) {
    const transitioned = await transitionNonBatchReceipt(id, {
      operation: "fail",
      paymentIntentId: input.paymentIntentId,
      ...(input.txHash ? { txHash: input.txHash } : {}),
    });
    if (transitioned.changed) updated += 1;
  }
  void input.error;
  return updated;
}

export function receiptFromInferenceSettlement(
  settlement: InferenceSettlementReceipt | null,
  network?: NetworkId,
): Receipt | null {
  if (!settlement) {
    return null;
  }

  const resolvedNetwork = settlement.network ?? network;
  if (!resolvedNetwork) {
    return null;
  }

  return {
    finalAmountWei: settlement.finalAmountWei,
    network: resolvedNetwork,
    settledAt: settlement.settledAt,
    ...(settlement.userAddress ? { userAddress: settlement.userAddress } : {}),
    ...(settlement.meterSubject ? { subject: settlement.meterSubject } : {}),
    ...(settlement.lineItems && settlement.lineItems.length > 0 ? { lineItems: settlement.lineItems } : {}),
    ...(settlement.providerAmountWei ? { providerAmountWei: settlement.providerAmountWei } : {}),
    ...(settlement.platformFeeWei ? { platformFeeWei: settlement.platformFeeWei } : {}),
    ...(settlement.txHash ? { txHash: settlement.txHash } : {}),
    settlementStatus: settlement.settlementStatus || (settlement.txHash ? "submitted" : "queued"),
    ...(settlement.claimTxHash ? { claimTxHash: settlement.claimTxHash } : {}),
    ...(settlement.settleTxHash ? { settleTxHash: settlement.settleTxHash } : {}),
    ...(settlement.paymentIntentId ? { paymentIntentId: settlement.paymentIntentId } : {}),
    ...(settlement.paymentChannelId ? { paymentChannelId: settlement.paymentChannelId } : {}),
    ...(settlement.paymentCumulativeAmountWei ? { paymentCumulativeAmountWei: settlement.paymentCumulativeAmountWei } : {}),
    ...(settlement.checkpointSequence !== undefined ? { checkpointSequence: settlement.checkpointSequence } : {}),
    ...(settlement.rootRunId ? { rootRunId: settlement.rootRunId } : {}),
    ...(settlement.executionRunId ? { executionRunId: settlement.executionRunId } : {}),
    ...(settlement.parentExecutionRunId ? { parentExecutionRunId: settlement.parentExecutionRunId } : {}),
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
  if (receipt.checkpointAmountWei) body.checkpoint_amount_wei = receipt.checkpointAmountWei;
  if (receipt.cumulativeAmountWei) body.cumulative_amount_wei = receipt.cumulativeAmountWei;
  if (receipt.checkpointSequence !== undefined) body.checkpoint_sequence = receipt.checkpointSequence;
  if (receipt.rootRunId) body.root_run_id = receipt.rootRunId;
  if (receipt.executionRunId) body.execution_run_id = receipt.executionRunId;
  if (receipt.parentExecutionRunId) body.parent_execution_run_id = receipt.parentExecutionRunId;
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
    checkpointAmountWei: receipt.checkpointAmountWei,
    cumulativeAmountWei: receipt.cumulativeAmountWei,
    checkpointSequence: receipt.checkpointSequence,
    rootRunId: receipt.rootRunId,
    executionRunId: receipt.executionRunId,
    parentExecutionRunId: receipt.parentExecutionRunId,
    providerAmountWei: receipt.providerAmountWei,
    platformFeeWei: receipt.platformFeeWei,
    meterSubject: receipt.subject,
    lineItems: receipt.lineItems,
    bills: receipt.bills,
    txHash: receipt.txHash,
    settlementStatus: receipt.settlementStatus,
    claimTxHash: receipt.claimTxHash,
    settleTxHash: receipt.settleTxHash,
    paymentIntentId: receipt.paymentIntentId,
    paymentChannelId: receipt.paymentChannelId,
    paymentCumulativeAmountWei: receipt.paymentCumulativeAmountWei,
    network: receipt.network,
    settledAt: receipt.settledAt,
    cumulative: receipt.cumulative,
  };
}
