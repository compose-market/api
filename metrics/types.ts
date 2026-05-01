import type { Address, Hash } from "viem";

export const FUJI_CHAIN_ID = 43113 as const;
export const FUJI_USDC_ADDRESS = "0x5425890298aed601595a70AB815c96711a31Bc65" as const;

export type MetricsClientSource = "sdk" | "web" | "runtime" | "internal" | "unknown";

export interface MetricsFactorySnapshot {
    address: Address;
    totalAgents: string;
    confidence: "configured" | "abi-probed" | "event-probed";
    deployedAtBlock?: string;
    deploymentTxHash?: Hash;
    lastCheckedAt: number;
}

export interface MetricsContractDeployment {
    address: Address;
    deployer: Address;
    deployedAtBlock?: string;
    deploymentTxHash?: Hash;
    source: "direct-create" | "create2-event" | "create2-derived" | "configured-env";
    classifiedAs?: "agent-factory" | "unknown";
    discoveredAt: number;
}

export interface MetricsDownloadsSnapshot {
    totalObserved: number;
    sdk: {
        packageName: string;
        downloads: {
            lastDay: number;
            lastWeek: number;
            lastMonth: number;
            lastYear: number;
        };
        source: "npm";
        updatedAt?: number;
    };
    mesh: {
        repository: string;
        releaseAssetDownloads: number;
        releases: number;
        assets: Array<{
            name: string;
            downloadCount: number;
            releaseTag?: string;
        }>;
        clonesLast14Days?: number;
        uniqueClonersLast14Days?: number;
        viewsLast14Days?: number;
        uniqueViewersLast14Days?: number;
        source: "github";
        updatedAt?: number;
    };
    warnings: string[];
}

export interface MetricsSnapshot {
    dataset: string;
    chainId: typeof FUJI_CHAIN_ID;
    fromDate: string;
    lastIndexedBlock: string;
    lastDeploymentIndexedBlock: string;
    merchantAddress: Address;
    deployerAddress: Address;
    usdcAddress: Address;
    grossMerchantReceiptsWei: string;
    grossMerchantReceiptsUsdc: string;
    settlementTxCount: number;
    selfTransferCount: number;
    agentsMinted: number;
    agentFactories: MetricsFactorySnapshot[];
    deployedContracts: MetricsContractDeployment[];
    calls: {
        settledBillable: number;
        totalAttempts: number;
        bySource: Record<MetricsClientSource | string, number>;
    };
    downloads: MetricsDownloadsSnapshot;
    evidence: {
        transferLogCount: number;
        lastSettlementTxHash?: Hash;
        warnings: string[];
        updatedAt?: number;
    };
}

export interface MetricsBackfillSummary {
    dataset: string;
    chainId: typeof FUJI_CHAIN_ID;
    fromBlock: string;
    toBlock: string;
    receiptCursor: string;
    deploymentCursor: string;
    receiptRangesProcessed: number;
    deploymentRangesProcessed: number;
    explorerDeploymentPages?: number;
    explorerReceiptPages?: number;
    transferLogsProcessed: number;
    deploymentsDiscovered: number;
    factoriesChecked: number;
    warnings: string[];
}
