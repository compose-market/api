import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "dotenv/config";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";

import { NETWORK_IDS, getNetwork } from "../x402/configs/chains.js";
import { merchantWalletAddress } from "../x402/wallets.js";
import { formatUsdcAtomic } from "../metrics/format.js";
import { aggregatePaymentLogs, incomingAmountFromLogs } from "../metrics/payments.js";
import { buildSnapshot } from "../metrics/snapshot.js";

const txA = `0x${"a".repeat(64)}` as const;
const txB = `0x${"b".repeat(64)}` as const;
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function transferLog(from: `0x${string}`, to: `0x${string}`, value: bigint) {
  return {
    address: getNetwork(NETWORK_IDS.arcTestnet).asset.address,
    topics: encodeEventTopics({
      abi: [transfer],
      eventName: "Transfer",
      args: { from, to },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

test("formatUsdcAtomic renders USDC 6-decimal atomic amounts without floating point math", () => {
  assert.equal(formatUsdcAtomic("0"), "0");
  assert.equal(formatUsdcAtomic("1"), "0.000001");
  assert.equal(formatUsdcAtomic("1000"), "0.001");
  assert.equal(formatUsdcAtomic("1000000"), "1");
  assert.equal(formatUsdcAtomic("123456789"), "123.456789");
});

test("aggregatePaymentLogs dedupes by transaction and sums incoming transfer amounts", () => {
  assert.deepEqual(aggregatePaymentLogs([
    { transactionHash: txA, args: { value: 1_000_000n } },
    { transactionHash: txA, args: { value: 2_500_000n } },
    { transactionHash: txB, args: { value: "42" } },
  ]), [
    { txHash: txA, amountAtomic: "3500000" },
    { txHash: txB, amountAtomic: "42" },
  ]);
});

test("incomingAmountFromLogs counts only transfers received by the merchant wallet", () => {
  const other = "0x1111111111111111111111111111111111111111";
  assert.equal(incomingAmountFromLogs(NETWORK_IDS.arcTestnet, [
    transferLog(other, merchantWalletAddress, 1_000_000n),
    transferLog(merchantWalletAddress, merchantWalletAddress, 2_000_000n),
    transferLog(merchantWalletAddress, other, 9_000_000n),
  ]), "3000000");
});

test("payments Neon migration keys rows by network and drops legacy chain_id", () => {
  const source = readFileSync(new URL("../metrics/db.ts", import.meta.url), "utf8");

  assert.match(source, /network\s+TEXT NOT NULL/u);
  assert.match(source, /PRIMARY KEY \(network, tx_hash\)/u);
  assert.match(source, /SET network = 'eip155:' \|\| chain_id::text/u);
  assert.match(source, /ALTER TABLE payments DROP COLUMN chain_id/u);
  assert.doesNotMatch(source, /chain_id\s+INTEGER NOT NULL/u);
});

test("buildSnapshot returns public metrics shape with named sources", () => {
  const snapshot = buildSnapshot({
    downloads: { total: 2258, daily: 26, updatedAt: "2026-06-02T00:00:00.000Z" },
    agents: { total: 54, daily: 2, source: "cloudflare-d1", updatedAt: "2026-06-02T00:01:00.000Z" },
    payments: {
      transactions: 5885,
      amountAtomic: "123456789",
      dailyTransactions: 35,
      dailyAmountAtomic: "456789",
      cutoff: "2026-06-02T00:02:00.000Z",
      updatedAt: "2026-06-02T00:02:00.000Z",
    },
    sessions: { total: 77, daily: 7, updatedAt: "2026-06-02T00:03:00.000Z" },
  });

  assert.equal(snapshot.totals.downloads, 2258);
  assert.equal(snapshot.totals.agents, 54);
  assert.equal(snapshot.totals.payments.transactions, 5885);
  assert.equal(snapshot.totals.payments.amountUsdc, "123.456789");
  assert.equal(snapshot.totals.sessions, 77);
  assert.equal(snapshot.daily.downloads, 26);
  assert.equal(snapshot.daily.agents, 2);
  assert.equal(snapshot.daily.payments.transactions, 35);
  assert.equal(snapshot.daily.payments.amountUsdc, "0.456789");
  assert.equal(snapshot.daily.sessions, 7);
  assert.equal(snapshot.sources.downloads.package, "@compose-market/sdk");
  assert.equal(snapshot.sources.payments.source, "merchant-wallet-settlements");
  assert.equal(snapshot.sources.payments.cutoff, "2026-06-02T00:02:00.000Z");
  assert.equal(snapshot.updatedAt, "2026-06-02T00:03:00.000Z");
});
