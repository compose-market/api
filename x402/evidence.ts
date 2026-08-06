import { createHash, randomUUID } from "node:crypto";
import { isEvmNetwork, type NetworkId } from "./configs/chains.js";

import {
  getValkeyClient,
  valkeyHGetAll,
  valkeySRem,
  valkeySMembers,
} from "./keys/valkey.js";

const TTL_SECONDS = 60 * 60 * 24;
const PREFIX = "x402:evidence";
const BATCH_RECONCILIATION_KEY_PREFIX = "x402:batch-reconciliation";
const BATCH_RECONCILIATION_TTL_SECONDS = 60 * 60 * 24 * 180;

export type EvidenceKind = "model" | "agent" | "tool" | "search" | "memory" | "connector";
export type SettlementStatus = "queued" | "submitted" | "claimed" | "settled" | "failed";

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
  feeWei: string;
  creatorFeeWei?: string;
  finalAmountWei: string;
  settlementStatus?: SettlementStatus;
  txHash?: string;
  claimTxHash?: string;
  settleTxHash?: string;
  paymentIntentId?: string;
  paymentChannelId?: string;
  paymentCumulativeAmountWei?: string;
  network?: NetworkId;
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

function batchChannelIdentity(channelId: string, network: NetworkId): string {
  return isEvmNetwork(network) ? channelId.toLowerCase() : channelId;
}

function transactionIdentity(txHash: string, network: NetworkId): string {
  return isEvmNetwork(network) ? txHash.toLowerCase() : txHash;
}

function channelKey(channelId: string, network: NetworkId): string {
  return `${PREFIX}:channel:${network}:${batchChannelIdentity(channelId, network)}`;
}

function batchReconciliationKey(channelId: string, network: NetworkId): string {
  return `${BATCH_RECONCILIATION_KEY_PREFIX}:${network}:${batchChannelIdentity(channelId, network)}`;
}

function assertCanonicalBatchCumulativeAmount(value: string): void {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error("Batch charge evidence cumulative amount must be a canonical unsigned decimal integer");
  }
}

function intentKey(intentId: string): string {
  return `${PREFIX}:intent:${intentId}`;
}

function stableEvidenceId(input: ChargeEvidence): string {
  if (input.paymentChannelId && input.paymentCumulativeAmountWei !== undefined) {
    assertCanonicalBatchCumulativeAmount(input.paymentCumulativeAmountWei);
  }
  let identity: string[] | null = null;
  if (input.paymentChannelId && input.paymentCumulativeAmountWei) {
    if (!input.network) throw new Error("Batch charge evidence network is required");
    identity = [
      "batch",
      input.network,
      batchChannelIdentity(input.paymentChannelId, input.network),
      input.paymentCumulativeAmountWei,
    ];
  } else if (input.paymentIntentId) {
    identity = ["intent", input.paymentIntentId];
  } else if (input.chargeId) {
    identity = ["charge", input.chargeId];
  } else if (input.txHash) {
    if (!input.network) throw new Error("Transaction charge evidence network is required");
    identity = [
      "transaction",
      input.network,
      transactionIdentity(input.txHash, input.network),
    ];
  }
  if (!identity) return input.id || `chg_${randomUUID().replace(/-/g, "")}`;
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const canonical = `chg_${digest.slice(0, 32)}`;
  if (input.id && input.id !== canonical) {
    throw new Error("Explicit evidence id conflicts with canonical backing");
  }
  return canonical;
}

const UPSERT_BATCH_RECONCILIATION_LUA = `
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
  local claim_field = "claim:" .. amount
  local settle_field = "settle:" .. amount
  local existing_claim_raw = redis.call("HGET", KEYS[1], claim_field)
  local existing_claim = existing_claim_raw and cjson.decode(existing_claim_raw) or nil
  if existing_claim and ARGV[2] ~= "" and (existing_claim.claimTxHash or "") ~= ""
    and existing_claim.claimTxHash ~= ARGV[2] then
    error("claim transaction mismatch for cumulative watermark " .. amount)
  end
  local existing_settle_raw = redis.call("HGET", KEYS[1], settle_field)
  local existing_settle = existing_settle_raw and cjson.decode(existing_settle_raw) or nil
  if existing_settle and ARGV[3] ~= "" and (existing_settle.settleTxHash or "") ~= ""
    and existing_settle.settleTxHash ~= ARGV[3] then
    error("settle transaction mismatch for cumulative watermark " .. amount)
  end

  local claim_transition = existing_claim or {
    amountWei = amount,
    claimTxHash = ARGV[2],
    claimedAt = ARGV[6]
  }
  if (claim_transition.claimTxHash or "") == "" and ARGV[2] ~= "" then
    claim_transition.claimTxHash = ARGV[2]
  end
  redis.call("HSET", KEYS[1], claim_field, cjson.encode(claim_transition))

  if ARGV[3] ~= "" then
    local settle_transition = existing_settle or {
      amountWei = amount,
      claimTxHash = ARGV[2],
      settleTxHash = ARGV[3],
      settledAt = ARGV[6]
    }
    if (settle_transition.claimTxHash or "") == "" and ARGV[2] ~= "" then
      settle_transition.claimTxHash = ARGV[2]
    end
    if (settle_transition.settleTxHash or "") == "" then
      settle_transition.settleTxHash = ARGV[3]
    end
    redis.call("HSET", KEYS[1], settle_field, cjson.encode(settle_transition))
  end

  local current_claimed = redis.call("HGET", KEYS[1], "claimedAmountWei") or "0"
  local claim_comparison = compare_decimal(amount, current_claimed)
  if claim_comparison > 0 then
    redis.call("HSET", KEYS[1],
      "claimedAmountWei", amount,
      "claimTxHash", ARGV[2],
      "claimedAt", ARGV[6])
  elseif claim_comparison == 0 then
    if ARGV[2] ~= "" and (redis.call("HGET", KEYS[1], "claimTxHash") or "") == "" then
      redis.call("HSET", KEYS[1], "claimTxHash", ARGV[2])
    end
    if not redis.call("HGET", KEYS[1], "claimedAt") then
      redis.call("HSET", KEYS[1], "claimedAt", ARGV[6])
    end
  end

  if ARGV[3] ~= "" then
    local current_settled = redis.call("HGET", KEYS[1], "settledAmountWei") or "0"
    local settle_comparison = compare_decimal(amount, current_settled)
    if settle_comparison > 0 then
      redis.call("HSET", KEYS[1],
        "settledAmountWei", amount,
        "settledClaimTxHash", ARGV[2],
        "settleTxHash", ARGV[3],
        "settledAt", ARGV[6])
    elseif settle_comparison == 0 then
      if ARGV[2] ~= "" and (redis.call("HGET", KEYS[1], "settledClaimTxHash") or "") == "" then
        redis.call("HSET", KEYS[1], "settledClaimTxHash", ARGV[2])
      end
      if (redis.call("HGET", KEYS[1], "settleTxHash") or "") == "" then
        redis.call("HSET", KEYS[1], "settleTxHash", ARGV[3])
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
  const claimTxHash = input.claimTxHash
    ? transactionIdentity(input.claimTxHash, input.network)
    : "";
  const settleTxHash = input.settleTxHash
    ? transactionIdentity(input.settleTxHash, input.network)
    : "";
  await valkey.eval(
    UPSERT_BATCH_RECONCILIATION_LUA,
    1,
    batchReconciliationKey(input.channelId, input.network),
    input.claimedAmountWei,
    claimTxHash,
    settleTxHash,
    input.network,
    batchChannelIdentity(input.channelId, input.network),
    String(Date.now()),
    String(BATCH_RECONCILIATION_TTL_SECONDS),
  );
}

const STORE_BATCH_EVIDENCE_LUA = `
  local function text(value)
    if value == nil or value == cjson.null then return "" end
    return tostring(value)
  end

  local function canonical_decimal(value)
    if not string.match(value, "^%d+$") then
      error("batch evidence cumulative amount must be an unsigned decimal integer")
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
      error("Batch charge evidence terminal transaction mismatch")
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

  local function covering_transition_for_hash(prefix, cumulative, state_key, hash_field, network, tx_hash)
    local values = redis.call("HGETALL", state_key)
    local selected = nil
    for index = 1, #values, 2 do
      local field = values[index]
      if string.sub(field, 1, #prefix) == prefix then
        local transition = cjson.decode(values[index + 1])
        if transition.amountWei and less_or_equal(cumulative, transition.amountWei)
          and same_transaction(network, transition[hash_field], tx_hash)
          and (not selected or compare_decimal(transition.amountWei, selected.amountWei) < 0) then
          selected = transition
        end
      end
    end
    return selected
  end

  local function hash(key)
    local values = redis.call("HGETALL", key)
    local result = {}
    for index = 1, #values, 2 do result[values[index]] = values[index + 1] end
    return result
  end

  local incoming = cjson.decode(ARGV[1])
  if text(incoming.id) == "" or text(incoming.kind) == ""
    or text(incoming.rootRunId) == "" or text(incoming.executionRunId) == ""
    or text(incoming.paymentChannelId) == "" or text(incoming.paymentCumulativeAmountWei) == ""
    or text(incoming.network) == "" then
    error("Batch charge evidence identity is incomplete")
  end
  canonical_decimal(text(incoming.paymentCumulativeAmountWei))
  if text(incoming.network) ~= ARGV[6]
    or channel_identity(incoming.network, incoming.paymentChannelId) ~= ARGV[7] then
    error("Batch charge evidence backing mismatch")
  end
  local current = hash(KEYS[1])
  local full = incoming
  if current.id then
    local immutable = {
      "id", "chargeId", "kind", "rootRunId", "executionRunId", "parentExecutionRunId",
      "paymentIntentId", "paymentChannelId", "paymentCumulativeAmountWei", "network",
      "providerAmountWei", "feeWei", "creatorFeeWei", "finalAmountWei"
    }
    for _, field in ipairs(immutable) do
      if text(current[field]) ~= text(incoming[field]) then
        error("Charge evidence replay changed immutable " .. field)
      end
    end
    if current.settlementStatus == "settled" and incoming.settlementStatus == "settled" then
      assert_same_transaction(current.network, current.txHash, incoming.txHash)
    elseif current.settlementStatus == "failed" and incoming.settlementStatus == "failed" then
      assert_same_transaction(current.network, current.txHash, incoming.txHash)
    elseif current.settlementStatus == "failed" and incoming.settlementStatus == "settled" then
      assert_same_transaction(current.network, current.txHash, incoming.txHash)
    end
    if rank(current.settlementStatus) >= rank(incoming.settlementStatus) then
      full = current
    else
      full = current
      for field, value in pairs(incoming) do full[field] = value end
    end
  end

  if text(full.paymentIntentId) ~= "" and redis.call("EXISTS", KEYS[8]) == 1 then
    local intent_id = redis.call("HGET", KEYS[8], "paymentIntentId") or ""
    local intent_network = redis.call("HGET", KEYS[8], "network") or ""
    local intent_status = redis.call("HGET", KEYS[8], "status") or ""
    local intent_tx_hash = redis.call("HGET", KEYS[8], "txHash") or ""
    if intent_id == "" then
      intent_status = ""
    elseif intent_id ~= text(full.paymentIntentId) then
      error("Batch charge evidence payment intent mismatch")
    end
    if intent_network ~= "" and intent_network ~= text(full.network) then
      error("Batch charge evidence payment intent network mismatch")
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
      full.settledAt = redis.call("HGET", KEYS[8], "confirmedAt")
        or redis.call("HGET", KEYS[8], "updatedAt") or ARGV[5]
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
        full.settledAt = ""
      end
    elseif intent_status == "failed" or intent_status == "released" then
      if full.settlementStatus ~= "settled" then
        if full.settlementStatus == "failed" then
          assert_same_transaction(full.network, full.txHash, intent_tx_hash)
        end
        full.settlementStatus = "failed"
        full.settledAt = ""
        if intent_tx_hash ~= "" then full.txHash = intent_tx_hash end
      end
    end
  end

  local state_network = redis.call("HGET", KEYS[7], "network")
  local state_channel = redis.call("HGET", KEYS[7], "channelId")
  if state_network then
    if text(full.network) ~= state_network or state_network ~= ARGV[6] then
      error("Batch evidence reconciliation network mismatch")
    end
    if not state_channel
      or channel_identity(full.network, full.paymentChannelId) ~= state_channel
      or state_channel ~= ARGV[7] then
      error("Batch evidence reconciliation channel mismatch")
    end
    local cumulative = text(full.paymentCumulativeAmountWei)
    local settled = earliest_transition("settle:", cumulative, KEYS[7])
    local claimed = earliest_transition("claim:", cumulative, KEYS[7])
    if settled then
      local settle_hash = settled.settleTxHash or ""
      if full.settlementStatus == "settled" then
        if not same_transaction(full.network, full.txHash, settle_hash) then
          local previous = covering_transition_for_hash(
            "settle:", cumulative, KEYS[7], "settleTxHash", full.network, full.txHash)
          if not previous or compare_decimal(settled.amountWei, previous.amountWei) >= 0 then
            error("Batch charge evidence terminal transaction mismatch")
          end
        end
      end
      full.settlementStatus = "settled"
      full.claimTxHash = claimed and claimed.claimTxHash or ""
      full.settleTxHash = settle_hash
      full.txHash = full.settleTxHash
      full.network = state_network
      full.settledAt = settled.settledAt or ""
    elseif claimed and full.settlementStatus ~= "failed" and rank(full.settlementStatus) <= 3 then
      full.settlementStatus = "claimed"
      full.claimTxHash = claimed.claimTxHash or ""
      full.network = state_network
    end
  end

  for field, value in pairs(full) do redis.call("HSET", KEYS[1], field, text(value)) end
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  redis.call("SADD", KEYS[2], full.id)
  redis.call("EXPIRE", KEYS[2], ARGV[2])
  redis.call("SADD", KEYS[3], full.id)
  redis.call("EXPIRE", KEYS[3], ARGV[2])
  if ARGV[3] == "1" then
    redis.call("SADD", KEYS[4], full.id)
    redis.call("EXPIRE", KEYS[4], ARGV[2])
  end
  redis.call("SADD", KEYS[5], full.id)
  redis.call("EXPIRE", KEYS[5], ARGV[2])
  if ARGV[4] == "1" then
    redis.call("SADD", KEYS[6], full.id)
    redis.call("EXPIRE", KEYS[6], ARGV[2])
  end
  return cjson.encode(full)
`;

async function storeBatchEvidenceAtomically(
  input: Required<Pick<ChargeEvidence, "id">> & ChargeEvidence,
): Promise<ChargeEvidence> {
  if (!input.paymentChannelId || !input.paymentCumulativeAmountWei || !input.network) {
    throw new Error("Batch charge evidence identity is incomplete");
  }
  const valkey = await getValkeyClient();
  const paymentIntentId = input.paymentIntentId;
  const result = await valkey.eval(
    STORE_BATCH_EVIDENCE_LUA,
    8,
    key(input.id),
    executionKey(input.rootRunId, input.executionRunId),
    rootKey(input.rootRunId),
    input.parentExecutionRunId ? parentKey(input.rootRunId, input.parentExecutionRunId) : key(input.id),
    channelKey(input.paymentChannelId, input.network),
    input.paymentIntentId ? intentKey(input.paymentIntentId) : key(input.id),
    batchReconciliationKey(input.paymentChannelId, input.network),
    `payment-intent:${paymentIntentId || `none:${input.id}`}`,
    JSON.stringify(fields(input)),
    String(TTL_SECONDS),
    input.parentExecutionRunId ? "1" : "0",
    input.paymentIntentId ? "1" : "0",
    String(Date.now()),
    input.network,
    batchChannelIdentity(input.paymentChannelId, input.network),
  );
  if (typeof result !== "string") {
    throw new Error("Batch charge evidence persistence returned an invalid result");
  }
  const stored = parse(JSON.parse(result) as Record<string, string>);
  if (!stored) throw new Error("Batch charge evidence persistence returned unreadable metadata");
  return stored;
}

const RECONCILE_BATCH_EVIDENCE_LUA = `
  local function text(value)
    if value == nil or value == cjson.null then return "" end
    return tostring(value)
  end

  local function canonical_decimal(value)
    if not string.match(value, "^%d+$") then
      error("batch evidence cumulative amount must be an unsigned decimal integer")
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
      error("Batch charge evidence terminal transaction mismatch")
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

  local function covering_transition_for_hash(prefix, cumulative, state_key, hash_field, network, tx_hash)
    local values = redis.call("HGETALL", state_key)
    local selected = nil
    for index = 1, #values, 2 do
      local field = values[index]
      if string.sub(field, 1, #prefix) == prefix then
        local transition = cjson.decode(values[index + 1])
        if transition.amountWei and less_or_equal(cumulative, transition.amountWei)
          and same_transaction(network, transition[hash_field], tx_hash)
          and (not selected or compare_decimal(transition.amountWei, selected.amountWei) < 0) then
          selected = transition
        end
      end
    end
    return selected
  end

  local values = redis.call("HGETALL", KEYS[1])
  if #values == 0 then return {0, ""} end
  local evidence = {}
  for index = 1, #values, 2 do evidence[values[index]] = values[index + 1] end
  if text(evidence.id) == "" or text(evidence.kind) == ""
    or text(evidence.rootRunId) == "" or text(evidence.executionRunId) == ""
    or text(evidence.paymentChannelId) == "" or text(evidence.paymentCumulativeAmountWei) == ""
    or text(evidence.network) == "" then
    error("Batch charge evidence identity is incomplete")
  end
  canonical_decimal(text(evidence.paymentCumulativeAmountWei))
  if text(evidence.network) ~= ARGV[2]
    or channel_identity(evidence.network, evidence.paymentChannelId) ~= ARGV[3] then
    error("Batch charge evidence backing mismatch")
  end
  local before_status = text(evidence.settlementStatus)
  local before_claim_hash = text(evidence.claimTxHash)
  local before_settle_hash = text(evidence.settleTxHash)
  local before_tx_hash = text(evidence.txHash)
  local before_settled_at = text(evidence.settledAt)
  local before_network = text(evidence.network)

  local state_network = redis.call("HGET", KEYS[2], "network")
  local state_channel = redis.call("HGET", KEYS[2], "channelId")
  if state_network then
    if before_network ~= state_network or state_network ~= ARGV[2] then
      error("Batch evidence reconciliation network mismatch")
    end
    if not state_channel
      or channel_identity(evidence.network, evidence.paymentChannelId) ~= state_channel
      or state_channel ~= ARGV[3] then
      error("Batch evidence reconciliation channel mismatch")
    end
    local cumulative = text(evidence.paymentCumulativeAmountWei)
    local settled = earliest_transition("settle:", cumulative, KEYS[2])
    local claimed = earliest_transition("claim:", cumulative, KEYS[2])
    if settled then
      local settle_hash = settled.settleTxHash or ""
      if evidence.settlementStatus == "settled" then
        if not same_transaction(evidence.network, evidence.txHash, settle_hash) then
          local previous = covering_transition_for_hash(
            "settle:", cumulative, KEYS[2], "settleTxHash", evidence.network, evidence.txHash)
          if not previous or compare_decimal(settled.amountWei, previous.amountWei) >= 0 then
            error("Batch charge evidence terminal transaction mismatch")
          end
        end
      end
      evidence.settlementStatus = "settled"
      evidence.claimTxHash = claimed and claimed.claimTxHash or ""
      evidence.settleTxHash = settle_hash
      evidence.txHash = evidence.settleTxHash
      evidence.network = state_network
      evidence.settledAt = settled.settledAt or ""
    elseif claimed and evidence.settlementStatus ~= "failed" and rank(evidence.settlementStatus) <= 3 then
      evidence.settlementStatus = "claimed"
      evidence.claimTxHash = claimed.claimTxHash or ""
      evidence.network = state_network
    end
  end

  local changed = before_status ~= text(evidence.settlementStatus)
    or before_claim_hash ~= text(evidence.claimTxHash)
    or before_settle_hash ~= text(evidence.settleTxHash)
    or before_tx_hash ~= text(evidence.txHash)
    or before_settled_at ~= text(evidence.settledAt)
    or before_network ~= text(evidence.network)
  for field, value in pairs(evidence) do redis.call("HSET", KEYS[1], field, text(value)) end
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  local execution_key = "x402:evidence:root:" .. text(evidence.rootRunId)
    .. ":execution:" .. text(evidence.executionRunId)
  redis.call("SADD", execution_key, text(evidence.id))
  redis.call("EXPIRE", execution_key, ARGV[1])
  local root_key = "x402:evidence:root:" .. text(evidence.rootRunId) .. ":all"
  redis.call("SADD", root_key, text(evidence.id))
  redis.call("EXPIRE", root_key, ARGV[1])
  if text(evidence.parentExecutionRunId) ~= "" then
    local parent_key = "x402:evidence:root:" .. text(evidence.rootRunId)
      .. ":parent:" .. text(evidence.parentExecutionRunId)
    redis.call("SADD", parent_key, text(evidence.id))
    redis.call("EXPIRE", parent_key, ARGV[1])
  end
  local channel_key = "x402:evidence:channel:" .. text(evidence.network) .. ":"
    .. channel_identity(evidence.network, evidence.paymentChannelId)
  redis.call("SADD", channel_key, text(evidence.id))
  redis.call("EXPIRE", channel_key, ARGV[1])
  if text(evidence.paymentIntentId) ~= "" then
    local intent_key = "x402:evidence:intent:" .. text(evidence.paymentIntentId)
    redis.call("SADD", intent_key, text(evidence.id))
    redis.call("EXPIRE", intent_key, ARGV[1])
  end
  return {changed and 1 or 0, cjson.encode(evidence)}
`;

async function reconcileStoredBatchEvidence(
  evidenceId: string,
  channelId: string,
  network: NetworkId,
): Promise<boolean> {
  const valkey = await getValkeyClient();
  const result = await valkey.eval(
    RECONCILE_BATCH_EVIDENCE_LUA,
    2,
    key(evidenceId),
    batchReconciliationKey(channelId, network),
    String(TTL_SECONDS),
    network,
    batchChannelIdentity(channelId, network),
  ) as [number | string, string];
  return Number(result?.[0]) === 1;
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
    feeWei: input.feeWei,
    creatorFeeWei: clean(input.creatorFeeWei),
    finalAmountWei: input.finalAmountWei,
    settlementStatus: input.settlementStatus || (input.txHash ? "submitted" : "queued"),
    txHash: clean(input.txHash),
    claimTxHash: clean(input.claimTxHash),
    settleTxHash: clean(input.settleTxHash),
    paymentIntentId: clean(input.paymentIntentId),
    paymentChannelId: clean(input.paymentChannelId),
    paymentCumulativeAmountWei: clean(input.paymentCumulativeAmountWei),
    network: input.network || "",
    settledAt: input.settledAt === undefined ? "" : String(input.settledAt),
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
    feeWei: data.feeWei || "0",
    ...(data.creatorFeeWei ? { creatorFeeWei: data.creatorFeeWei } : {}),
    finalAmountWei: data.finalAmountWei || "0",
    settlementStatus: (data.settlementStatus || (data.txHash ? "submitted" : "queued")) as SettlementStatus,
    ...(data.txHash ? { txHash: data.txHash } : {}),
    ...(data.claimTxHash ? { claimTxHash: data.claimTxHash } : {}),
    ...(data.settleTxHash ? { settleTxHash: data.settleTxHash } : {}),
    ...(data.paymentIntentId ? { paymentIntentId: data.paymentIntentId } : {}),
    ...(data.paymentChannelId ? { paymentChannelId: data.paymentChannelId } : {}),
    ...(data.paymentCumulativeAmountWei ? { paymentCumulativeAmountWei: data.paymentCumulativeAmountWei } : {}),
    ...(data.network ? { network: data.network as NetworkId } : {}),
    ...(data.settledAt ? { settledAt: Number.parseInt(data.settledAt, 10) } : {}),
  };
}

type NonBatchEvidenceTransition =
  | {
    operation: "publish";
    evidence: Required<Pick<ChargeEvidence, "id">> & ChargeEvidence;
  }
  | {
    operation: "settle";
    paymentIntentId: string;
    txHash: string;
    network?: NetworkId;
    settledAt: number;
  }
  | {
    operation: "fail";
    paymentIntentId: string;
    txHash?: string;
  };

async function transitionNonBatchEvidence(
  evidenceId: string,
  transition: NonBatchEvidenceTransition,
): Promise<{ changed: boolean; evidence: ChargeEvidence | null }> {
  const valkey = await getValkeyClient();
  const payload = transition.operation === "publish"
    ? fields(transition.evidence)
    : {
      settlementStatus: transition.operation === "settle" ? "settled" : "failed",
      paymentIntentId: transition.paymentIntentId,
      txHash: clean(transition.txHash),
      network: transition.operation === "settle" ? clean(transition.network) : "",
      settledAt: transition.operation === "settle" ? String(transition.settledAt) : "",
    };
  const paymentIntentId = transition.operation === "publish"
    ? transition.evidence.paymentIntentId
    : transition.paymentIntentId;
  const paymentIntentKey = `payment-intent:${paymentIntentId || `none:${evidenceId}`}`;
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

      local function hash(hash_key)
        local values = redis.call("HGETALL", hash_key)
        local result = {}
        for index = 1, #values, 2 do result[values[index]] = values[index + 1] end
        return result
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
          error("Charge evidence terminal transaction mismatch")
        end
      end

      local function validate_non_batch(evidence)
        if text(evidence.id) == "" or text(evidence.kind) == ""
          or text(evidence.rootRunId) == "" or text(evidence.executionRunId) == "" then
          error("Non-batch charge evidence identity is incomplete")
        end
        if text(evidence.paymentChannelId) ~= "" then
          error("Batch charge evidence cannot use non-batch transition")
        end
      end

      local operation = ARGV[1]
      local payload = cjson.decode(ARGV[2])
      local current = hash(KEYS[1])
      local evidence = nil
      local changed = 0

      if operation == "publish" then
        evidence = payload
        if current.id then
          local immutable = {
            "id", "chargeId", "kind", "rootRunId", "executionRunId", "parentExecutionRunId",
            "paymentIntentId", "paymentChannelId", "paymentCumulativeAmountWei", "network",
            "providerAmountWei", "feeWei", "creatorFeeWei", "finalAmountWei"
          }
          for _, field in ipairs(immutable) do
            if text(current[field]) ~= text(evidence[field]) then
              error("Charge evidence replay changed immutable " .. field)
            end
          end
          if current.settlementStatus == "settled" and evidence.settlementStatus == "settled" then
            assert_same_transaction(current.network, current.txHash, evidence.txHash)
          elseif current.settlementStatus == "failed" and evidence.settlementStatus == "failed" then
            assert_same_transaction(current.network, current.txHash, evidence.txHash)
          elseif current.settlementStatus == "failed" and evidence.settlementStatus == "settled" then
            assert_same_transaction(current.network, current.txHash, evidence.txHash)
          end
          if rank(current.settlementStatus) >= rank(evidence.settlementStatus) then
            evidence = current
          else
            local incoming = evidence
            evidence = current
            for field, value in pairs(incoming) do evidence[field] = value end
            changed = 1
          end
        else
          changed = 1
        end
      elseif operation == "settle" then
        if not current.id then return {0, ""} end
        evidence = current
        validate_non_batch(evidence)
        if text(evidence.paymentIntentId) ~= text(payload.paymentIntentId) then
          error("Charge evidence payment intent mismatch")
        end
        if text(payload.network) ~= "" and text(evidence.network) ~= text(payload.network) then
          error("Charge evidence settlement network mismatch")
        end
        if evidence.settlementStatus == "settled" then
          assert_same_transaction(evidence.network, evidence.txHash, payload.txHash)
        else
          if evidence.settlementStatus == "failed" then
            assert_same_transaction(evidence.network, evidence.txHash, payload.txHash)
          end
          evidence.settlementStatus = "settled"
          evidence.txHash = payload.txHash
          evidence.settledAt = payload.settledAt
          changed = 1
        end
      elseif operation == "fail" then
        if not current.id then return {0, ""} end
        evidence = current
        validate_non_batch(evidence)
        if text(evidence.paymentIntentId) ~= text(payload.paymentIntentId) then
          error("Charge evidence payment intent mismatch")
        end
        if evidence.settlementStatus == "settled" then
          -- A confirmed settlement is stronger than a racing failure projection.
        elseif evidence.settlementStatus == "failed" then
          assert_same_transaction(evidence.network, evidence.txHash, payload.txHash)
          if text(evidence.txHash) == "" and text(payload.txHash) ~= "" then
            evidence.txHash = payload.txHash
            changed = 1
          end
        else
          evidence.settlementStatus = "failed"
          evidence.settledAt = ""
          if text(payload.txHash) ~= "" then evidence.txHash = payload.txHash end
          changed = 1
        end
      else
        error("Unknown non-batch charge evidence transition")
      end

      validate_non_batch(evidence)
      if operation == "publish" and text(evidence.paymentIntentId) ~= ""
        and redis.call("EXISTS", KEYS[2]) == 1 then
        local intent_id = redis.call("HGET", KEYS[2], "paymentIntentId") or ""
        local intent_network = redis.call("HGET", KEYS[2], "network") or ""
        local intent_status = redis.call("HGET", KEYS[2], "status") or ""
        local intent_tx_hash = redis.call("HGET", KEYS[2], "txHash") or ""
        if intent_id == "" then
          intent_status = ""
        elseif intent_id ~= text(evidence.paymentIntentId) then
          error("Charge evidence payment intent mismatch")
        end
        if intent_network ~= "" and intent_network ~= text(evidence.network) then
          error("Charge evidence payment intent network mismatch")
        end

        local before_status = text(evidence.settlementStatus)
        local before_tx_hash = text(evidence.txHash)
        local before_settled_at = text(evidence.settledAt)
        if intent_status == "confirmed" then
          if intent_tx_hash == "" then
            error("Confirmed payment intent is missing its transaction identity")
          end
          if evidence.settlementStatus == "settled" or evidence.settlementStatus == "failed" then
            assert_same_transaction(evidence.network, evidence.txHash, intent_tx_hash)
          end
          evidence.settlementStatus = "settled"
          evidence.txHash = intent_tx_hash
          evidence.settledAt = redis.call("HGET", KEYS[2], "confirmedAt")
            or redis.call("HGET", KEYS[2], "updatedAt") or ARGV[4]
        elseif intent_status == "submitted" then
          if intent_tx_hash == "" then
            error("Submitted payment intent is missing its transaction identity")
          end
          if evidence.settlementStatus == "submitted" then
            assert_same_transaction(evidence.network, evidence.txHash, intent_tx_hash)
          end
          if rank(evidence.settlementStatus) < rank("submitted") then
            evidence.settlementStatus = "submitted"
            evidence.txHash = intent_tx_hash
            evidence.settledAt = ""
          end
        elseif intent_status == "failed" or intent_status == "released" then
          if evidence.settlementStatus ~= "settled" then
            if evidence.settlementStatus == "failed" then
              assert_same_transaction(evidence.network, evidence.txHash, intent_tx_hash)
            end
            evidence.settlementStatus = "failed"
            evidence.settledAt = ""
            if intent_tx_hash ~= "" then evidence.txHash = intent_tx_hash end
          end
        end
        if before_status ~= text(evidence.settlementStatus)
          or before_tx_hash ~= text(evidence.txHash)
          or before_settled_at ~= text(evidence.settledAt) then
          changed = 1
        end
      end

      for field, value in pairs(evidence) do redis.call("HSET", KEYS[1], field, text(value)) end
      redis.call("EXPIRE", KEYS[1], ARGV[3])
      local execution_key = "x402:evidence:root:" .. text(evidence.rootRunId)
        .. ":execution:" .. text(evidence.executionRunId)
      redis.call("SADD", execution_key, text(evidence.id))
      redis.call("EXPIRE", execution_key, ARGV[3])
      local root_key = "x402:evidence:root:" .. text(evidence.rootRunId) .. ":all"
      redis.call("SADD", root_key, text(evidence.id))
      redis.call("EXPIRE", root_key, ARGV[3])
      if text(evidence.parentExecutionRunId) ~= "" then
        local parent_key = "x402:evidence:root:" .. text(evidence.rootRunId)
          .. ":parent:" .. text(evidence.parentExecutionRunId)
        redis.call("SADD", parent_key, text(evidence.id))
        redis.call("EXPIRE", parent_key, ARGV[3])
      end
      if text(evidence.paymentIntentId) ~= "" then
        local intent_key = "x402:evidence:intent:" .. text(evidence.paymentIntentId)
        redis.call("SADD", intent_key, text(evidence.id))
        redis.call("EXPIRE", intent_key, ARGV[3])
      end
      return {changed, cjson.encode(evidence)}
    `,
    2,
    key(evidenceId),
    paymentIntentKey,
    transition.operation,
    JSON.stringify(payload),
    String(TTL_SECONDS),
    String(Date.now()),
  ) as [number | string, string];
  const encoded = String(result?.[1] || "");
  const evidence = encoded ? parse(JSON.parse(encoded) as Record<string, string>) : null;
  return { changed: Number(result?.[0]) === 1, evidence };
}

export async function recordChargeEvidence(input: ChargeEvidence): Promise<ChargeEvidence> {
  const id = stableEvidenceId(input);
  if (!input.rootRunId || !input.executionRunId) {
    return input;
  }

  let full: Required<Pick<ChargeEvidence, "id">> & ChargeEvidence = {
    ...input,
    id,
    chargeId: input.chargeId || id,
  };
  if (full.paymentChannelId) {
    if (!full.paymentCumulativeAmountWei || !full.network) {
      throw new Error("Batch charge evidence requires network and cumulative amount");
    }
    return storeBatchEvidenceAtomically(full);
  }
  const transitioned = await transitionNonBatchEvidence(id, { operation: "publish", evidence: full });
  if (!transitioned.evidence) {
    throw new Error("Non-batch charge evidence publication returned no evidence");
  }
  return transitioned.evidence;
}

async function list(
  index: string,
  ids: string[],
  matches: (charge: ChargeEvidence) => boolean,
): Promise<ChargeEvidence[]> {
  const hydrated = await Promise.all(ids.map(async (id) => ({
    id,
    charge: parse(await valkeyHGetAll(key(id))),
  })));
  const staleIds: string[] = [];
  const charges: ChargeEvidence[] = [];
  for (const entry of hydrated) {
    if (!entry.charge || !matches(entry.charge)) {
      staleIds.push(entry.id);
      continue;
    }
    charges.push(entry.charge);
  }
  if (staleIds.length > 0) {
    await valkeySRem(index, ...staleIds);
  }
  return charges;
}

export async function listExecutionEvidence(rootRunId: string, executionRunId: string): Promise<ChargeEvidence[]> {
  if (!rootRunId || !executionRunId) {
    return [];
  }
  const index = executionKey(rootRunId, executionRunId);
  return list(index, await valkeySMembers(index), (charge) => (
    charge.rootRunId === rootRunId && charge.executionRunId === executionRunId
  ));
}

export async function listChildEvidence(rootRunId: string, parentExecutionRunId: string): Promise<ChargeEvidence[]> {
  if (!rootRunId || !parentExecutionRunId) {
    return [];
  }
  const index = parentKey(rootRunId, parentExecutionRunId);
  return list(index, await valkeySMembers(index), (charge) => (
    charge.rootRunId === rootRunId && charge.parentExecutionRunId === parentExecutionRunId
  ));
}

export async function markBatchEvidenceSettled(input: {
  channelId: string;
  claimedAmountWei: string;
  claimTxHash?: string;
  settleTxHash?: string;
  network: NetworkId;
}): Promise<number> {
  await upsertBatchReconciliation(input);
  const ids = await valkeySMembers(channelKey(input.channelId, input.network));
  let updated = 0;
  for (const id of ids) {
    if (await reconcileStoredBatchEvidence(id, input.channelId, input.network)) updated += 1;
  }
  return updated;
}

export async function markIntentEvidenceSettled(input: {
  paymentIntentId?: string;
  txHash: string;
  network?: NetworkId;
}): Promise<number> {
  const ids = new Set<string>();
  if (input.paymentIntentId) {
    for (const id of await valkeySMembers(intentKey(input.paymentIntentId))) {
      ids.add(id);
    }
  }

  let updated = 0;
  for (const id of ids) {
    const transitioned = await transitionNonBatchEvidence(id, {
      operation: "settle",
      paymentIntentId: input.paymentIntentId!,
      txHash: input.txHash,
      settledAt: Date.now(),
      ...(input.network ? { network: input.network } : {}),
    });
    if (transitioned.changed) updated += 1;
  }
  return updated;
}

export async function markIntentEvidenceFailed(input: {
  paymentIntentId?: string;
  txHash?: string;
  error?: string;
}): Promise<number> {
  if (!input.paymentIntentId) return 0;
  let updated = 0;
  for (const id of await valkeySMembers(intentKey(input.paymentIntentId))) {
    const transitioned = await transitionNonBatchEvidence(id, {
      operation: "fail",
      paymentIntentId: input.paymentIntentId,
      ...(input.txHash ? { txHash: input.txHash } : {}),
    });
    if (transitioned.changed) updated += 1;
  }
  void input.error;
  return updated;
}
