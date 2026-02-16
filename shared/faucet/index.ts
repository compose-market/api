/**
 * Faucet Module
 *
 * Enterprise-grade faucet for distributing USDC to new accounts across multiple chains.
 * Uses Redis for global claim tracking to prevent duplicate claims across all chains.
 *
 * Features:
 * - Cross-chain claim prevention (Redis global tracking)
 * - Atomic operations with SETNX to prevent race conditions
 * - Automatic rollback on transaction failure
 * - Multi-chain support (Cronos, Avalanche, Arbitrum)
 *
 * @module shared/faucet
 */

import {
    redisGet,
    redisSet,
    redisDel,
    redisSetNX,
    redisIncr,
    redisExists,
} from "../configs/redis.js";
import {
    CHAIN_IDS,
    CHAIN_CONFIG,
    USDC_ADDRESSES,
    getChainObject,
} from "../configs/chains.js";
import { serverClient } from "../configs/thirdweb.js";
import {
    createPublicClient,
    createWalletClient,
    http,
    encodeFunctionData,
    decodeFunctionResult,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cronosTestnet, avalancheFuji } from "viem/chains";
import { defineChain } from "viem";

// =============================================================================
// Constants
// =============================================================================

/** 1 USDC in wei (6 decimals) */
export const FAUCET_CLAIM_AMOUNT = 1_000_000n;

/** Maximum claims per chain */
export const FAUCET_MAX_CLAIMS = 1000;

/** Redis key prefixes */
const FAUCET_PREFIX = "faucet:";
const CLAIMED_PREFIX = `${FAUCET_PREFIX}claimed:`;
const CHAIN_COUNT_PREFIX = `${FAUCET_PREFIX}chain:`;
const TX_LOG_PREFIX = `${FAUCET_PREFIX}tx:`;

/** Faucet contract addresses per chain */
export const FAUCET_ADDRESSES: Record<number, Address> = {
    [CHAIN_IDS.cronosTestnet]: (process.env.CRONOS_TESTNET_FAUCET_CONTRACT as Address),
    [CHAIN_IDS.avalancheFuji]: (process.env.AVALANCHE_FUJI_FAUCET_CONTRACT as Address),
    [CHAIN_IDS.arbitrumSepolia]: (process.env.ARBITRUM_SEPOLIA_FAUCET_CONTRACT as Address),
};

/** Supported faucet chains */
export const FAUCET_CHAINS = [
    CHAIN_IDS.cronosTestnet,
    CHAIN_IDS.avalancheFuji,
    CHAIN_IDS.arbitrumSepolia,
] as const;

// =============================================================================
// Types
// =============================================================================

export interface FaucetClaimRequest {
    address: string;
    chainId: number;
}

export interface FaucetClaimResult {
    success: boolean;
    txHash?: string;
    error?: string;
    alreadyClaimed?: boolean;
    globalClaimStatus?: {
        claimedOnChain?: number;
        claimedOnChainName?: string;
        claimedAt?: number;
    };
}

export interface FaucetStatus {
    chainId: number;
    chainName: string;
    totalClaims: number;
    maxClaims: number;
    remainingClaims: number;
    faucetBalance: string;
    faucetBalanceFormatted: string;
    isPaused: boolean;
    faucetAddress: string;
    usdcAddress: string;
    isConfigured: boolean;
}

export interface GlobalClaimStatus {
    claimed: boolean;
    chainId?: number;
    chainName?: string;
    claimedAt?: number;
}

// =============================================================================
// Faucet Contract ABI (minimal)
// =============================================================================

const FAUCET_ABI = [
    {
        name: "claimUSDC",
        type: "function",
        inputs: [{ name: "recipient", type: "address" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        name: "hasAddressClaimed",
        type: "function",
        inputs: [{ name: "addr", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
    },
    {
        name: "getFaucetStatus",
        type: "function",
        inputs: [],
        outputs: [
            { name: "balance", type: "uint256" },
            { name: "remainingClaims", type: "uint256" },
            { name: "isPaused", type: "bool" },
            { name: "_claimAmount", type: "uint256" },
            { name: "_maxClaims", type: "uint256" },
            { name: "_totalClaims", type: "uint256" },
        ],
        stateMutability: "view",
    },
    {
        name: "claimAmount",
        type: "function",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        name: "maxClaims",
        type: "function",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        name: "totalClaims",
        type: "function",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        name: "USDC",
        type: "function",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
] as const;

// =============================================================================
// Chain Configuration for Viem
// =============================================================================

const CHAIN_RPC_URLS: Record<number, string> = {
    [CHAIN_IDS.cronosTestnet]: process.env.CRONOS_TESTNET_RPC || "https://evm-t3.cronos.org",
    [CHAIN_IDS.avalancheFuji]: process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
    [CHAIN_IDS.arbitrumSepolia]: process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
};

const arbitrumSepolia = defineChain({
    id: 421614,
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpc: { default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] } },
    blockExplorers: { default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" } },
});

const VIEM_CHAINS: Record<number, typeof cronosTestnet | typeof avalancheFuji | typeof arbitrumSepolia> = {
    [CHAIN_IDS.cronosTestnet]: cronosTestnet,
    [CHAIN_IDS.avalancheFuji]: avalancheFuji,
    [CHAIN_IDS.arbitrumSepolia]: arbitrumSepolia,
};

// =============================================================================
// Redis Operations
// =============================================================================

/**
 * Check if address has claimed on ANY chain (global check)
 * Returns the chain ID where they claimed, or null if not claimed
 */
export async function getGlobalClaimStatus(address: string): Promise<GlobalClaimStatus> {
    const key = `${CLAIMED_PREFIX}${address.toLowerCase()}`;
    const data = await redisGet(key);

    if (!data) {
        return { claimed: false };
    }

    try {
        const parsed = JSON.parse(data);
        const chainName = parsed.chainId ? CHAIN_CONFIG[parsed.chainId as keyof typeof CHAIN_CONFIG]?.name : undefined;
        return {
            claimed: true,
            chainId: parsed.chainId,
            chainName,
            claimedAt: parsed.claimedAt,
        };
    } catch {
        return { claimed: true };
    }
}

/**
 * Record a claim in Redis (global)
 * Uses SETNX to prevent race conditions - atomic operation
 * Returns true if successfully recorded, false if already exists
 */
async function recordGlobalClaim(
    address: string,
    chainId: number
): Promise<boolean> {
    const key = `${CLAIMED_PREFIX}${address.toLowerCase()}`;
    const value = JSON.stringify({
        chainId,
        claimedAt: Date.now(),
    });

    const didSet = await redisSetNX(key, value);

    if (didSet) {
        const countKey = `${CHAIN_COUNT_PREFIX}${chainId}:count`;
        await redisIncr(countKey);
    }

    return didSet;
}

/**
 * Rollback a Redis claim (on transaction failure)
 */
async function rollbackGlobalClaim(address: string, chainId: number): Promise<void> {
    const key = `${CLAIMED_PREFIX}${address.toLowerCase()}`;
    await redisDel(key);

    const countKey = `${CHAIN_COUNT_PREFIX}${chainId}:count`;
    const currentCount = await redisGet(countKey);
    if (currentCount && parseInt(currentCount, 10) > 0) {
        const newValue = parseInt(currentCount, 10) - 1;
        await redisSet(countKey, newValue.toString());
    }

    console.log(`[faucet] Rolled back claim for ${address} on chain ${chainId}`);
}

/**
 * Get claim count for a chain from Redis
 */
async function getChainClaimCount(chainId: number): Promise<number> {
    const countKey = `${CHAIN_COUNT_PREFIX}${chainId}:count`;
    const count = await redisGet(countKey);
    return count ? parseInt(count, 10) : 0;
}

// =============================================================================
// Blockchain Operations
// =============================================================================

/**
 * Get Viem public client for a chain
 */
function getPublicClient(chainId: number) {
    const chain = VIEM_CHAINS[chainId];
    const rpcUrl = CHAIN_RPC_URLS[chainId];

    if (!chain || !rpcUrl) {
        throw new Error(`Unsupported chain: ${chainId}`);
    }

    return createPublicClient({
        chain,
        transport: http(rpcUrl),
    });
}

/**
 * Get Viem wallet client for signing transactions
 */
function getWalletClient(chainId: number) {
    const chain = VIEM_CHAINS[chainId];
    const rpcUrl = CHAIN_RPC_URLS[chainId];
    const deployerKey = process.env.DEPLOYER_KEY;

    if (!chain || !rpcUrl) {
        throw new Error(`Unsupported chain: ${chainId}`);
    }

    if (!deployerKey) {
        throw new Error("DEPLOYER_KEY not configured");
    }

    const account = privateKeyToAccount((deployerKey.startsWith("0x") ? deployerKey : `0x${deployerKey}`) as Hex);

    return {
        wallet: createWalletClient({
            account,
            chain,
            transport: http(rpcUrl),
        }),
        account,
    };
}

/**
 * Read faucet status from blockchain
 */
async function readFaucetStatus(chainId: number): Promise<{
    balance: bigint;
    remainingClaims: bigint;
    isPaused: boolean;
    claimAmount: bigint;
    maxClaims: bigint;
    totalClaims: bigint;
}> {
    const faucetAddress = FAUCET_ADDRESSES[chainId];
    if (!faucetAddress || faucetAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error(`Faucet not configured for chain ${chainId}`);
    }

    const client = getPublicClient(chainId);

    const [balance, remainingClaims, isPaused, claimAmount, maxClaims, totalClaims] = await client.readContract({
        address: faucetAddress,
        abi: FAUCET_ABI,
        functionName: "getFaucetStatus",
    });

    return {
        balance,
        remainingClaims,
        isPaused,
        claimAmount,
        maxClaims,
        totalClaims,
    };
}

/**
 * Check if address has claimed on-chain
 */
async function hasOnchainClaim(address: Address, chainId: number): Promise<boolean> {
    const faucetAddress = FAUCET_ADDRESSES[chainId];
    if (!faucetAddress || faucetAddress === "0x0000000000000000000000000000000000000000") {
        return false;
    }

    try {
        const client = getPublicClient(chainId);
        const claimed = await client.readContract({
            address: faucetAddress,
            abi: FAUCET_ABI,
            functionName: "hasAddressClaimed",
            args: [address],
        });
        return claimed;
    } catch (error) {
        console.error(`[faucet] Error checking on-chain claim:`, error);
        return false;
    }
}

/**
 * Execute the on-chain faucet claim transaction
 */
async function executeFaucetClaim(
    recipient: Address,
    chainId: number
): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const faucetAddress = FAUCET_ADDRESSES[chainId];
    if (!faucetAddress || faucetAddress === "0x0000000000000000000000000000000000000000") {
        return { success: false, error: "Faucet not configured for chain" };
    }

    try {
        const { wallet, account } = getWalletClient(chainId);
        const client = getPublicClient(chainId);

        console.log(`[faucet] Executing claim for ${recipient} on chain ${chainId}`);
        console.log(`[faucet] Faucet: ${faucetAddress}`);
        console.log(`[faucet] Caller: ${account.address}`);

        const { request } = await client.simulateContract({
            address: faucetAddress,
            abi: FAUCET_ABI,
            functionName: "claimUSDC",
            args: [recipient],
            account,
        });

        const txHash = await wallet.writeContract(request);

        console.log(`[faucet] Transaction submitted: ${txHash}`);

        const receipt = await client.waitForTransactionReceipt({
            hash: txHash,
            confirmations: 1,
            timeout: 60_000,
        });

        if (receipt.status === "reverted") {
            return { success: false, error: "Transaction reverted on-chain" };
        }

        await logTransaction(txHash, recipient, chainId, "success");

        return { success: true, txHash };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[faucet] Transaction failed:`, errorMessage);

        await logTransaction("failed", recipient, chainId, "failed", errorMessage);

        return { success: false, error: errorMessage };
    }
}

/**
 * Log transaction in Redis for audit trail
 */
async function logTransaction(
    txHash: string,
    recipient: Address,
    chainId: number,
    status: "success" | "failed",
    error?: string
): Promise<void> {
    const key = `${TX_LOG_PREFIX}${Date.now()}`;
    const value = JSON.stringify({
        txHash,
        recipient,
        chainId,
        status,
        error,
        timestamp: Date.now(),
    });
    await redisSet(key, value, 86400 * 30);
}

// =============================================================================
// Main Faucet Operations
// =============================================================================

/**
 * Check if faucet is available for a chain
 */
export async function checkFaucetAvailable(chainId: number): Promise<{
    available: boolean;
    reason?: string;
    status?: FaucetStatus;
}> {
    const faucetAddress = FAUCET_ADDRESSES[chainId];

    if (!faucetAddress || faucetAddress === "0x0000000000000000000000000000000000000000") {
        return { available: false, reason: "Faucet not deployed on this chain" };
    }

    if (!FAUCET_CHAINS.includes(chainId as any)) {
        return { available: false, reason: "Unsupported chain for faucet" };
    }

    try {
        const onchainStatus = await readFaucetStatus(chainId);
        const redisClaimCount = await getChainClaimCount(chainId);
        const chainConfig = CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG];

        if (onchainStatus.isPaused) {
            return {
                available: false,
                reason: "Faucet is paused",
                status: {
                    chainId,
                    chainName: chainConfig?.name || `Chain ${chainId}`,
                    totalClaims: Number(onchainStatus.totalClaims),
                    maxClaims: Number(onchainStatus.maxClaims),
                    remainingClaims: Number(onchainStatus.remainingClaims),
                    faucetBalance: onchainStatus.balance.toString(),
                    faucetBalanceFormatted: `${Number(onchainStatus.balance) / 1e6} USDC`,
                    isPaused: true,
                    faucetAddress,
                    usdcAddress: USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] || "0x",
                    isConfigured: true,
                },
            };
        }

        if (onchainStatus.totalClaims >= onchainStatus.maxClaims) {
            return {
                available: false,
                reason: "Maximum claims reached on this chain",
                status: {
                    chainId,
                    chainName: chainConfig?.name || `Chain ${chainId}`,
                    totalClaims: Number(onchainStatus.totalClaims),
                    maxClaims: Number(onchainStatus.maxClaims),
                    remainingClaims: 0,
                    faucetBalance: onchainStatus.balance.toString(),
                    faucetBalanceFormatted: `${Number(onchainStatus.balance) / 1e6} USDC`,
                    isPaused: false,
                    faucetAddress,
                    usdcAddress: USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] || "0x",
                    isConfigured: true,
                },
            };
        }

        if (onchainStatus.balance < onchainStatus.claimAmount) {
            return {
                available: false,
                reason: "Faucet has insufficient balance",
                status: {
                    chainId,
                    chainName: chainConfig?.name || `Chain ${chainId}`,
                    totalClaims: Number(onchainStatus.totalClaims),
                    maxClaims: Number(onchainStatus.maxClaims),
                    remainingClaims: Number(onchainStatus.remainingClaims),
                    faucetBalance: onchainStatus.balance.toString(),
                    faucetBalanceFormatted: `${Number(onchainStatus.balance) / 1e6} USDC`,
                    isPaused: false,
                    faucetAddress,
                    usdcAddress: USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] || "0x",
                    isConfigured: true,
                },
            };
        }

        return {
            available: true,
            status: {
                chainId,
                chainName: chainConfig?.name || `Chain ${chainId}`,
                totalClaims: Number(onchainStatus.totalClaims),
                maxClaims: Number(onchainStatus.maxClaims),
                remainingClaims: Number(onchainStatus.remainingClaims),
                faucetBalance: onchainStatus.balance.toString(),
                faucetBalanceFormatted: `${Number(onchainStatus.balance) / 1e6} USDC`,
                isPaused: false,
                faucetAddress,
                usdcAddress: USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] || "0x",
                isConfigured: true,
            },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { available: false, reason: `Error checking faucet: ${errorMessage}` };
    }
}

/**
 * Claim USDC from faucet
 *
 * Flow:
 * 1. Check if address has claimed on ANY chain (Redis global check)
 * 2. Check if faucet has remaining capacity
 * 3. Record claim in Redis atomically (SETNX)
 * 4. Call faucet contract to transfer USDC
 * 5. Rollback Redis on failure
 */
export async function claimFaucetUSDC(
    request: FaucetClaimRequest
): Promise<FaucetClaimResult> {
    const { address, chainId } = request;

    console.log(`[faucet] Claim request: ${address} on chain ${chainId}`);

    const normalizedAddress = address.toLowerCase() as Address;

    if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
        return {
            success: false,
            error: "Invalid address format",
        };
    }

    if (!FAUCET_CHAINS.includes(chainId as any)) {
        return {
            success: false,
            error: `Unsupported chain. Supported chains: ${FAUCET_CHAINS.map(id => CHAIN_CONFIG[id as keyof typeof CHAIN_CONFIG]?.name || id).join(", ")}`,
        };
    }

    const globalStatus = await getGlobalClaimStatus(normalizedAddress);

    if (globalStatus.claimed) {
        console.log(`[faucet] Address ${address} already claimed on chain ${globalStatus.chainId}`);
        return {
            success: false,
            alreadyClaimed: true,
            globalClaimStatus: {
                claimedOnChain: globalStatus.chainId,
                claimedOnChainName: globalStatus.chainName,
                claimedAt: globalStatus.claimedAt,
            },
            error: `Already claimed on ${globalStatus.chainName || `chain ${globalStatus.chainId}`}`,
        };
    }

    const onchainAlreadyClaimed = await hasOnchainClaim(normalizedAddress, chainId);
    if (onchainAlreadyClaimed) {
        console.log(`[faucet] Address ${address} already claimed on-chain`);
        await recordGlobalClaim(normalizedAddress, chainId);
        return {
            success: false,
            alreadyClaimed: true,
            globalClaimStatus: {
                claimedOnChain: chainId,
                claimedOnChainName: CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG]?.name,
                claimedAt: Date.now(),
            },
            error: `Already claimed on ${CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG]?.name || `chain ${chainId}`}`,
        };
    }

    const availability = await checkFaucetAvailable(chainId);
    if (!availability.available) {
        console.log(`[faucet] Faucet unavailable: ${availability.reason}`);
        return {
            success: false,
            error: availability.reason,
        };
    }

    const recorded = await recordGlobalClaim(normalizedAddress, chainId);
    if (!recorded) {
        console.log(`[faucet] Race condition - another claim recorded first`);
        const raceStatus = await getGlobalClaimStatus(normalizedAddress);
        return {
            success: false,
            alreadyClaimed: true,
            globalClaimStatus: {
                claimedOnChain: raceStatus.chainId,
                claimedOnChainName: raceStatus.chainName,
                claimedAt: raceStatus.claimedAt,
            },
            error: "Claim already processed by another request",
        };
    }

    const txResult = await executeFaucetClaim(normalizedAddress, chainId);

    if (!txResult.success) {
        await rollbackGlobalClaim(normalizedAddress, chainId);
        return {
            success: false,
            error: txResult.error,
        };
    }

    return {
        success: true,
        txHash: txResult.txHash,
    };
}

/**
 * Get faucet status for all supported chains
 */
export async function getAllFaucetStatuses(): Promise<FaucetStatus[]> {
    const statuses: FaucetStatus[] = [];

    for (const chainId of FAUCET_CHAINS) {
        try {
            const result = await checkFaucetAvailable(chainId);
            if (result.status) {
                statuses.push(result.status);
            } else {
                statuses.push({
                    chainId,
                    chainName: CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG]?.name || `Chain ${chainId}`,
                    totalClaims: 0,
                    maxClaims: FAUCET_MAX_CLAIMS,
                    remainingClaims: FAUCET_MAX_CLAIMS,
                    faucetBalance: "0",
                    faucetBalanceFormatted: "0 USDC",
                    isPaused: true,
                    faucetAddress: FAUCET_ADDRESSES[chainId] || "0x",
                    usdcAddress: USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] || "0x",
                    isConfigured: false,
                });
            }
        } catch (error) {
            console.error(`[faucet] Error getting status for chain ${chainId}:`, error);
        }
    }

    return statuses;
}

/**
 * Get explorer URL for a transaction
 */
export function getExplorerTxUrl(txHash: string, chainId: number): string {
    const chainConfig = CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG];
    if (!chainConfig) return "#";
    return `${chainConfig.explorer}/tx/${txHash}`;
}