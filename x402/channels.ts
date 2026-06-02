import { BatchSettlementChannelManager, BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import type { FacilitatorClient } from "@x402/core/server";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getBatchAsset, getBatchChannelStorage } from "./batch.js";
import { CHAIN_CONFIG, getActiveChainId, type ChainId } from "./configs/chains.js";
import { getComposeFacilitator } from "./facilitator.js";
import { markBatchEvidenceSettled } from "./evidence.js";
import { markBatchReceiptsSettled } from "./receipts.js";
import { merchantWalletAddress } from "./wallets.js";

const WITHDRAW_DELAY_SECONDS = 900;

type ChainResult = {
  chainId: ChainId;
  network: `eip155:${number}`;
  claimCount: number;
  claimTxHashes: string[];
  settleTxHash?: string;
  reconciledReceipts?: number;
  reconciledEvidence?: number;
  error?: string;
};

type ClaimTarget = {
  channelId: string;
  claimedAmountWei: string;
};

export type NativeBatchSettlementSummary = {
  runId: string;
  startedAt: number;
  finishedAt: number;
  chains: ChainResult[];
};

let scheme: BatchSettlementEvmScheme | null = null;
let client: FacilitatorClient | null = null;

function receiverAuthorizer() {
  const privateKey = process.env.DEPLOYER_KEY;
  if (!privateKey) {
    throw new Error("DEPLOYER_KEY environment variable is required for native batch settlement");
  }

  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
  return {
    address: account.address,
    signTypedData: (params: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => account.signTypedData(params as never),
  };
}

function serverScheme(): BatchSettlementEvmScheme {
  if (!scheme) {
    scheme = new BatchSettlementEvmScheme(merchantWalletAddress, {
      storage: getBatchChannelStorage(),
      receiverAuthorizerSigner: receiverAuthorizer(),
      withdrawDelay: WITHDRAW_DELAY_SECONDS,
    });
  }
  return scheme;
}

function facilitatorClient(): FacilitatorClient {
  if (client) {
    return client;
  }

  const facilitator = getComposeFacilitator();
  const created: FacilitatorClient = {
    verify: (paymentPayload, paymentRequirements) =>
      facilitator.verify(paymentPayload, paymentRequirements),
    settle: (paymentPayload, paymentRequirements) =>
      facilitator.settle(paymentPayload, paymentRequirements),
    getSupported: async () =>
      facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
  };
  client = created;
  return created;
}

function chains(): ChainId[] {
  const configured = (process.env.BATCH_SETTLEMENT_CHAIN_IDS || "")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value): value is ChainId => Number.isFinite(value) && value in CHAIN_CONFIG);

  return configured.length > 0 ? configured : [getActiveChainId()];
}

async function settleChain(chainId: ChainId): Promise<ChainResult> {
  const network = `eip155:${chainId}` as `eip155:${number}`;
  const asset = getBatchAsset(chainId);
  const storage = getBatchChannelStorage();
  const manager = new BatchSettlementChannelManager({
    scheme: serverScheme(),
    facilitator: facilitatorClient(),
    receiver: merchantWalletAddress,
    token: asset.address,
    network,
  });
  const idleSecs = Number.parseInt(process.env.BATCH_SETTLEMENT_IDLE_SECONDS || "0", 10) || 0;
  const now = Date.now();
  const targets: ClaimTarget[] = (await storage.list())
    .filter((channel) => {
      if (BigInt(channel.chargedCumulativeAmount) <= BigInt(channel.totalClaimed)) return false;
      return idleSecs <= 0 || now - channel.lastRequestTimestamp >= idleSecs * 1000;
    })
    .map((channel) => ({
      channelId: channel.channelId,
      claimedAmountWei: channel.chargedCumulativeAmount,
    }));

  const result = await manager.claimAndSettle({
    maxClaimsPerBatch: Number.parseInt(process.env.BATCH_SETTLEMENT_MAX_CLAIMS || "100", 10) || 100,
    idleSecs,
  });
  const claimTxHashes = result.claims.map((claim) => claim.transaction).filter(Boolean);
  const claimTxHash = claimTxHashes[claimTxHashes.length - 1];
  let reconciledReceipts = 0;
  let reconciledEvidence = 0;
  if (result.claims.length > 0) {
    for (const target of targets) {
      reconciledReceipts += await markBatchReceiptsSettled({
        channelId: target.channelId,
        claimedAmountWei: target.claimedAmountWei,
        ...(claimTxHash ? { claimTxHash } : {}),
        ...(result.settle?.transaction ? { settleTxHash: result.settle.transaction } : {}),
      });
      reconciledEvidence += await markBatchEvidenceSettled({
        channelId: target.channelId,
        claimedAmountWei: target.claimedAmountWei,
        ...(claimTxHash ? { claimTxHash } : {}),
        ...(result.settle?.transaction ? { settleTxHash: result.settle.transaction } : {}),
        chainId,
      });
    }
  }

  return {
    chainId,
    network,
    claimCount: result.claims.reduce((total, claim) => total + claim.vouchers, 0),
    claimTxHashes,
    ...(result.settle?.transaction ? { settleTxHash: result.settle.transaction } : {}),
    reconciledReceipts,
    reconciledEvidence,
  };
}

export async function runNativeBatchSettlement(): Promise<NativeBatchSettlementSummary> {
  const startedAt = Date.now();
  const runId = `native-batch-${startedAt}`;
  const results: ChainResult[] = [];

  for (const chainId of chains()) {
    try {
      results.push(await settleChain(chainId));
    } catch (error) {
      results.push({
        chainId,
        network: `eip155:${chainId}`,
        claimCount: 0,
        claimTxHashes: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    runId,
    startedAt,
    finishedAt: Date.now(),
    chains: results,
  };
}
