/**
 * Dispenser Module
 *
 * Dispenser for distributing USDC to new accounts across multiple chains.
 * Uses ValKey for global claim tracking to prevent duplicate claims across all chains.
 *
 * Features:
 * - Cross-chain claim prevention (ValKey global tracking)
 * - Atomic operations with SETNX to prevent race conditions
 * - Automatic rollback on transaction failure
 * - Multi-chain support (Avalanche, Arbitrum)
 *
 * @module shared/dispenser
 */

import {
    valkeyGet,
    valkeySet,
    valkeyDel,
    valkeySetNX,
    valkeyIncr,
} from "../x402/keys/valkey.js";
import {
    NETWORK_IDS,
    getNetwork,
    isEvmNetwork,
    type EvmNetworkId,
    type NetworkId,
} from "../x402/configs/chains.js";

const DISPENSER_NETWORKS = [
    NETWORK_IDS.arcTestnet,
    // NETWORK_IDS.arbitrumSepolia,
] as const satisfies readonly EvmNetworkId[];
type DispenserNetwork = typeof DISPENSER_NETWORKS[number];
const NETWORK_CONFIG = {
    [NETWORK_IDS.arcTestnet]: getNetwork(NETWORK_IDS.arcTestnet),
    // [NETWORK_IDS.arbitrumSepolia]: getNetwork(NETWORK_IDS.arbitrumSepolia),
} as const;
const USDC_ADDRESSES = {
    [NETWORK_IDS.arcTestnet]: getNetwork(NETWORK_IDS.arcTestnet).asset.address,
    // [NETWORK_IDS.arbitrumSepolia]: getNetwork(NETWORK_IDS.arbitrumSepolia).asset.address,
} as const;
import {
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

// =============================================================================
// Constants
// =============================================================================

/** 1 USDC in wei (6 decimals) */
export const DISPENSER_CLAIM_AMOUNT = 1_000_000n;

/** Maximum claims per chain */
export const DISPENSER_MAX_CLAIMS = 1000;

/** ValKey key prefixes */
const DISPENSER_PREFIX = "dispenser:";
const CLAIMED_PREFIX = `${DISPENSER_PREFIX}claimed:`;
const CHAIN_COUNT_PREFIX = `${DISPENSER_PREFIX}chain:`;
const TX_LOG_PREFIX = `${DISPENSER_PREFIX}tx:`;


// Deterministic deployment keeps the dispenser address identical across chains.
const SHARED_DISPENSER_ADDRESS = process.env.DISPENSER_CONTRACT as Address;

/** Supported dispenser EVM networks */
export const DISPENSER_CHAINS = DISPENSER_NETWORKS;

function isDispenserNetwork(network: EvmNetworkId): network is DispenserNetwork {
    return (DISPENSER_NETWORKS as readonly EvmNetworkId[]).includes(network);
}

// =============================================================================
// Types
// =============================================================================

export interface DispenserClaimRequest {
    address: string;
    network: NetworkId;
}

export interface DispenserClaimResult {
    success: boolean;
    txHash?: string;
    error?: string;
    alreadyClaimed?: boolean;
    globalClaimStatus?: {
        claimedOnNetwork?: NetworkId;
        claimedOnNetworkName?: string;
        claimedAt?: number;
    };
}

export interface DispenserStatus {
    network: NetworkId;
    networkName: string;
    totalClaims: number;
    maxClaims: number;
    remainingClaims: number;
    dispenserBalance: string;
    dispenserBalanceFormatted: string;
    isPaused: boolean;
    dispenserAddress: string;
    usdcAddress: string;
    isConfigured: boolean;
}

export interface GlobalClaimStatus {
    claimed: boolean;
    network?: NetworkId;
    networkName?: string;
    claimedAt?: number;
}

// =============================================================================
// Dispenser Contract ABI (minimal)
// =============================================================================

const DISPENSER_ABI = [
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
        name: "getDispenserStatus",
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

const NETWORK_RPC_URLS: Record<EvmNetworkId, string> = {
    [NETWORK_IDS.arcTestnet]: process.env.ARC_TESTNET_RPC as string,
    // [NETWORK_IDS.arbitrumSepolia]: process.env.ARBITRUM_SEPOLIA_RPC as string,
};

const VIEM_CHAINS: Record<EvmNetworkId, typeof arcTestnet> = {
    [NETWORK_IDS.arcTestnet]: arcTestnet,
    // [NETWORK_IDS.arbitrumSepolia]: arbitrumSepolia,
};

// =============================================================================
// ValKey Operations
// =============================================================================

/**
 * Check if address has claimed on ANY chain (global check)
 * Returns the chain ID where they claimed, or null if not claimed
 */
export async function getGlobalClaimStatus(address: string): Promise<GlobalClaimStatus> {
    const key = `${CLAIMED_PREFIX}${address.toLowerCase()}`;
    const data = await valkeyGet(key);

    if (!data) {
        return { claimed: false };
    }

    try {
        const parsed = JSON.parse(data);
        const network = typeof parsed.network === "string" ? parsed.network as NetworkId : undefined;
        const networkName = network && isEvmNetwork(network)
            ? NETWORK_CONFIG[network as keyof typeof NETWORK_CONFIG]?.name
            : undefined;
        return {
            claimed: true,
            network,
            networkName,
            claimedAt: parsed.claimedAt,
        };
    } catch {
        return { claimed: true };
    }
}

/**
 * Record a claim in ValKey (global)
 * Uses SETNX to prevent race conditions - atomic operation
 * Returns true if successfully recorded, false if already exists
 */
async function recordGlobalClaim(
    address: string,
    network: EvmNetworkId,
): Promise<boolean> {
    const key = `${CLAIMED_PREFIX}${address.toLowerCase()}`;
    const value = JSON.stringify({
        network,
        claimedAt: Date.now(),
    });

    const didSet = await valkeySetNX(key, value);

    if (didSet) {
        const countKey = `${CHAIN_COUNT_PREFIX}${network}:count`;
        await valkeyIncr(countKey);
    }

    return didSet;
}

/**
 * Rollback a ValKey claim (on transaction failure)
 */
async function rollbackGlobalClaim(address: string, network: EvmNetworkId): Promise<void> {
    const key = `${CLAIMED_PREFIX}${address.toLowerCase()}`;
    await valkeyDel(key);

    const countKey = `${CHAIN_COUNT_PREFIX}${network}:count`;
    const currentCount = await valkeyGet(countKey);
    if (currentCount && parseInt(currentCount, 10) > 0) {
        const newValue = parseInt(currentCount, 10) - 1;
        await valkeySet(countKey, newValue.toString());
    }

    console.log(`[dispenser] Rolled back claim for ${address} on network ${network}`);
}

/**
 * Get claim count for a chain from ValKey
 */
async function getNetworkClaimCount(network: EvmNetworkId): Promise<number> {
    const countKey = `${CHAIN_COUNT_PREFIX}${network}:count`;
    const count = await valkeyGet(countKey);
    return count ? parseInt(count, 10) : 0;
}

// =============================================================================
// Blockchain Operations
// =============================================================================

/**
 * Get Viem public client for a chain
 */
function getPublicClient(network: EvmNetworkId) {
    const chain = VIEM_CHAINS[network];
    const rpcUrl = NETWORK_RPC_URLS[network];

    if (!chain || !rpcUrl) {
        throw new Error(`Unsupported dispenser network: ${network}`);
    }

    return createPublicClient({
        chain,
        transport: http(rpcUrl),
    });
}

/**
 * Get Viem wallet client for signing transactions
 */
function getWalletClient(network: EvmNetworkId) {
    const chain = VIEM_CHAINS[network];
    const rpcUrl = NETWORK_RPC_URLS[network];
    const deployerKey = process.env.FACILITATOR_KEY;

    if (!chain || !rpcUrl) {
        throw new Error(`Unsupported dispenser network: ${network}`);
    }

    if (!deployerKey) {
        throw new Error("FACILITATOR_KEY not configured");
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
 * Read dispenser status from blockchain
 */
async function readDispenserStatus(network: EvmNetworkId): Promise<{
    balance: bigint;
    remainingClaims: bigint;
    isPaused: boolean;
    claimAmount: bigint;
    maxClaims: bigint;
    totalClaims: bigint;
}> {
    const dispenserAddress = SHARED_DISPENSER_ADDRESS;

    const client = getPublicClient(network);

    const [balance, remainingClaims, isPaused, claimAmount, maxClaims, totalClaims] = await client.readContract({
        address: dispenserAddress,
        abi: DISPENSER_ABI,
        functionName: "getDispenserStatus",
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
async function hasOnchainClaim(address: Address, network: EvmNetworkId): Promise<boolean> {
    const dispenserAddress = SHARED_DISPENSER_ADDRESS;

    try {
        const client = getPublicClient(network);
        const claimed = await client.readContract({
            address: dispenserAddress,
            abi: DISPENSER_ABI,
            functionName: "hasAddressClaimed",
            args: [address],
        });
        return claimed;
    } catch (error) {
        console.error(`[dispenser] Error checking on-chain claim:`, error);
        return false;
    }
}

/**
 * Execute the on-chain dispenser claim transaction
 */
async function executeDispenserClaim(
    recipient: Address,
    network: EvmNetworkId,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const dispenserAddress = SHARED_DISPENSER_ADDRESS;

    try {
        const { wallet, account } = getWalletClient(network);
        const client = getPublicClient(network);

        console.log(`[dispenser] Executing claim for ${recipient} on network ${network}`);
        console.log(`[dispenser] Dispenser: ${dispenserAddress}`);
        console.log(`[dispenser] Caller: ${account.address}`);

        const { request } = await client.simulateContract({
            address: dispenserAddress,
            abi: DISPENSER_ABI,
            functionName: "claimUSDC",
            args: [recipient],
            account,
        });

        const txHash = await wallet.writeContract(request);

        console.log(`[dispenser] Transaction submitted: ${txHash}`);

        const receipt = await client.waitForTransactionReceipt({
            hash: txHash,
            confirmations: 1,
            timeout: 60_000,
        });

        if (receipt.status === "reverted") {
            return { success: false, error: "Transaction reverted on-chain" };
        }

        await logTransaction(txHash, recipient, network, "success");

        return { success: true, txHash };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[dispenser] Transaction failed:`, errorMessage);

        await logTransaction("failed", recipient, network, "failed", errorMessage);

        return { success: false, error: errorMessage };
    }
}

/**
 * Log transaction in ValKey for audit trail
 */
async function logTransaction(
    txHash: string,
    recipient: Address,
    network: EvmNetworkId,
    status: "success" | "failed",
    error?: string
): Promise<void> {
    const key = `${TX_LOG_PREFIX}${Date.now()}`;
    const value = JSON.stringify({
        txHash,
        recipient,
        network,
        status,
        error,
        timestamp: Date.now(),
    });
    await valkeySet(key, value, 86400 * 30);
}

// =============================================================================
// Main Dispenser Operations
// =============================================================================

function buildStatus(input: {
    network: DispenserNetwork;
    onchain?: Awaited<ReturnType<typeof readDispenserStatus>>;
    isPaused: boolean;
    isConfigured: boolean;
    remainingClaims?: number;
}): DispenserStatus {
    const networkConfig = getNetwork(input.network);
    const onchain = input.onchain;
    return {
        network: input.network,
        networkName: networkConfig?.name || input.network,
        totalClaims: onchain ? Number(onchain.totalClaims) : 0,
        maxClaims: onchain ? Number(onchain.maxClaims) : DISPENSER_MAX_CLAIMS,
        remainingClaims: input.remainingClaims ?? (onchain ? Number(onchain.remainingClaims) : DISPENSER_MAX_CLAIMS),
        dispenserBalance: onchain ? onchain.balance.toString() : "0",
        dispenserBalanceFormatted: onchain ? `${Number(onchain.balance) / 1e6} USDC` : "0 USDC",
        isPaused: input.isPaused,
        dispenserAddress: SHARED_DISPENSER_ADDRESS,
        usdcAddress: getNetwork(input.network).asset.address,
        isConfigured: input.isConfigured,
    };
}

/**
 * Check if dispenser is available for a network.
 */
export async function checkDispenserAvailable(network: NetworkId): Promise<{
    available: boolean;
    reason?: string;
    status?: DispenserStatus;
}> {
    const dispenserAddress = SHARED_DISPENSER_ADDRESS;

    if (!isEvmNetwork(network)) {
        return { available: false, reason: "Dispenser is not configured for this network" };
    }

    if (!dispenserAddress || dispenserAddress === "0x0000000000000000000000000000000000000000") {
        return { available: false, reason: "Dispenser not deployed on this network" };
    }

    if (!isDispenserNetwork(network)) {
        return { available: false, reason: "Unsupported network for dispenser" };
    }

    try {
        const onchainStatus = await readDispenserStatus(network);
        const valkeyClaimCount = await getNetworkClaimCount(network);
        void valkeyClaimCount;

        if (onchainStatus.isPaused) {
            return {
                available: false,
                reason: "Dispenser is paused",
                status: buildStatus({ network, onchain: onchainStatus, isPaused: true, isConfigured: true }),
            };
        }

        if (onchainStatus.totalClaims >= onchainStatus.maxClaims) {
            return {
                available: false,
                reason: "Maximum claims reached on this network",
                status: buildStatus({ network, onchain: onchainStatus, isPaused: false, isConfigured: true, remainingClaims: 0 }),
            };
        }

        if (onchainStatus.balance < onchainStatus.claimAmount) {
            return {
                available: false,
                reason: "Dispenser has insufficient balance",
                status: buildStatus({ network, onchain: onchainStatus, isPaused: false, isConfigured: true }),
            };
        }

        return {
            available: true,
            status: buildStatus({ network, onchain: onchainStatus, isPaused: false, isConfigured: true }),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { available: false, reason: `Error checking dispenser: ${errorMessage}` };
    }
}

/**
 * Claim USDC from dispenser
 *
 * Flow:
 * 1. Check if address has claimed on ANY chain (ValKey global check)
 * 2. Check if dispenser has remaining capacity
 * 3. Record claim in ValKey atomically (SETNX)
 * 4. Call dispenser contract to transfer USDC
 * 5. Rollback ValKey on failure
 */
export async function claimDispenserUSDC(
    request: DispenserClaimRequest
): Promise<DispenserClaimResult> {
    const { address, network } = request;

    console.log(`[dispenser] Claim request: ${address} on network ${network}`);

    if (!isEvmNetwork(network)) {
        return {
            success: false,
            error: "Dispenser is not configured for this network",
        };
    }

    const normalizedAddress = address.toLowerCase() as Address;

    if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
        return {
            success: false,
            error: "Invalid address format",
        };
    }

    if (!isDispenserNetwork(network)) {
        return {
            success: false,
            error: `Unsupported network. Supported networks: ${DISPENSER_NETWORKS.map(id => NETWORK_CONFIG[id]?.name || id).join(", ")}`,
        };
    }

    const globalStatus = await getGlobalClaimStatus(normalizedAddress);

    if (globalStatus.claimed) {
        console.log(`[dispenser] Address ${address} already claimed on network ${globalStatus.network}`);
        return {
            success: false,
            alreadyClaimed: true,
            globalClaimStatus: {
                claimedOnNetwork: globalStatus.network,
                claimedOnNetworkName: globalStatus.networkName,
                claimedAt: globalStatus.claimedAt,
            },
            error: `Already claimed on ${globalStatus.networkName || globalStatus.network || "another network"}`,
        };
    }

    const onchainAlreadyClaimed = await hasOnchainClaim(normalizedAddress, network);
    if (onchainAlreadyClaimed) {
        console.log(`[dispenser] Address ${address} already claimed on-chain`);
        await recordGlobalClaim(normalizedAddress, network);
        return {
            success: false,
            alreadyClaimed: true,
            globalClaimStatus: {
                claimedOnNetwork: network,
                claimedOnNetworkName: getNetwork(network).name,
                claimedAt: Date.now(),
            },
            error: `Already claimed on ${getNetwork(network).name || network}`,
        };
    }

    const availability = await checkDispenserAvailable(network);
    if (!availability.available) {
        console.log(`[dispenser] Dispenser unavailable: ${availability.reason}`);
        return {
            success: false,
            error: availability.reason,
        };
    }

    const recorded = await recordGlobalClaim(normalizedAddress, network);
    if (!recorded) {
        console.log(`[dispenser] Race condition - another claim recorded first`);
        const raceStatus = await getGlobalClaimStatus(normalizedAddress);
        return {
            success: false,
            alreadyClaimed: true,
            globalClaimStatus: {
                claimedOnNetwork: raceStatus.network,
                claimedOnNetworkName: raceStatus.networkName,
                claimedAt: raceStatus.claimedAt,
            },
            error: "Claim already processed by another request",
        };
    }

    const txResult = await executeDispenserClaim(normalizedAddress, network);

    if (!txResult.success) {
        await rollbackGlobalClaim(normalizedAddress, network);
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
 * Get dispenser status for all supported networks
 */
export async function getAllDispenserStatuses(): Promise<DispenserStatus[]> {
    const statuses: DispenserStatus[] = [];

    for (const network of DISPENSER_NETWORKS) {
        try {
            const result = await checkDispenserAvailable(network);
            if (result.status) {
                statuses.push(result.status);
            } else {
                statuses.push(buildStatus({ network, isPaused: true, isConfigured: false }));
            }
        } catch (error) {
            console.error(`[dispenser] Error getting status for network ${network}:`, error);
        }
    }

    return statuses;
}

/**
 * Get explorer URL for a transaction
 */
export function getExplorerTxUrl(txHash: string, network: EvmNetworkId): string {
    const networkConfig = getNetwork(network);
    if (!networkConfig) return "#";
    return `${networkConfig.explorer}/tx/${txHash}`;
}
