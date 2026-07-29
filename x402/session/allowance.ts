import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
    Address as SolanaAddress,
    address as solanaAddress,
    createSolanaRpc,
    devnet as solanaDevnet,
    getAddressEncoder as getSolanaAddressEncoder,
    getProgramDerivedAddress as getSolanaProgramDerivedAddress,
    mainnet as solanaMainnet,
} from "@solana/kit";

import {
    evmChainId,
    getNetwork,
    getNetworkRpcUrl,
    getViemChain,
    isEvmNetwork,
    isSolanaNetwork,
    type EvmNetworkId,
    type NetworkId,
    type SolanaNetworkId,
    NETWORK_IDS,
} from "../configs/chains.js";
import {
    merchantWalletAddress,
    svmTreasuryWalletAddress,
    treasuryWalletAddress,
} from "../wallets.js";

const ERC20_ALLOWANCE_ABI = [
    {
        name: "allowance",
        type: "function",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

const ERC20_BALANCE_OF_ABI = [
    {
        name: "balanceOf",
        type: "function",
        inputs: [
            { name: "account", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

export const UNBOUNDED_SESSION_ALLOWANCE_WEI = (2n ** 256n) - 1n;

export interface SessionFundingReadiness {
    ready: boolean;
    reason?: "insufficient_balance" | "insufficient_allowance";
    requiredWei: string;
    balanceWei: string;
    allowanceWei: string;
    spender: `0x${string}`;
    error?: string;
    hint?: string;
}

function normalizePrivateKey(value: string): `0x${string}` {
    return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

export function resolveSessionAllowanceSpenderAddress(
    env: NodeJS.ProcessEnv = process.env,
): `0x${string}` {
    const configuredTreasury = env.TREASURY_SERVER_WALLET_PUBLIC?.trim() as `0x${string}` | undefined;
    const deployerKey = env.FACILITATOR_KEY?.trim();

    if (deployerKey) {
        const derivedSpender = privateKeyToAccount(normalizePrivateKey(deployerKey)).address;
        if (
            configuredTreasury
            && configuredTreasury.toLowerCase() !== derivedSpender.toLowerCase()
        ) {
            console.warn(
                `[session-allowance] TREASURY_SERVER_WALLET_PUBLIC (${configuredTreasury}) does not match FACILITATOR_KEY public address (${derivedSpender}); using FACILITATOR_KEY`,
            );
        }
        return derivedSpender;
    }

    if (configuredTreasury) {
        return configuredTreasury;
    }

    return treasuryWalletAddress || merchantWalletAddress;
}

export function getSpendableSessionBudgetWei(input: {
    budgetLimitWei: bigint;
    usedWei: bigint;
    lockedWei: bigint;
    allowanceWei: bigint;
}): bigint {
    const offchainRemaining = input.budgetLimitWei - input.usedWei - input.lockedWei;
    const allowanceRemaining = input.allowanceWei - input.lockedWei;

    const normalizedOffchain = offchainRemaining > 0n ? offchainRemaining : 0n;
    const normalizedAllowance = allowanceRemaining > 0n ? allowanceRemaining : 0n;

    return normalizedOffchain < normalizedAllowance ? normalizedOffchain : normalizedAllowance;
}

export function shouldRequestUnlimitedSessionApproval(input: {
    currentAllowanceWei: bigint;
    requestedBudgetWei: bigint;
}): boolean {
    return input.currentAllowanceWei < input.requestedBudgetWei;
}

function readSessionAllowanceOverrideWei(): bigint | null {
    const raw = process.env.COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI?.trim();
    if (!raw) {
        return null;
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error("COMPOSE_SESSION_ALLOWANCE_OVERRIDE_WEI must be a base-10 integer string");
    }
    return BigInt(raw);
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

function createSvmRpc(network: SolanaNetworkId) {
    const rpcUrl = getNetworkRpcUrl(network);
    if (network === NETWORK_IDS.solanaDevnet) { return createSolanaRpc(solanaDevnet(rpcUrl)); }
    // if (network === NETWORK_IDS.solana) { return createSolanaRpc(solanaMainnet(rpcUrl)); }
    throw new Error(`Unsupported SVM network: ${network}`);
}

async function readSvmTokenProgramAddress(
    rpc: ReturnType<typeof createSvmRpc>,
    mint: SolanaAddress,
): Promise<SolanaAddress> {
    const typedRpc = rpc as {
        getAccountInfo: (address: SolanaAddress) => {
            send: () => Promise<{ value: { owner?: string } | null }>;
        };
    };
    const info = await typedRpc.getAccountInfo(mint).send();
    const owner = info.value?.owner;
    if (owner === SPL_TOKEN_2022_PROGRAM) return solanaAddress(SPL_TOKEN_2022_PROGRAM);
    if (owner === SPL_TOKEN_PROGRAM) return solanaAddress(SPL_TOKEN_PROGRAM);
    if (owner) throw new Error(`Unsupported SVM token program for mint ${mint}: ${owner}`);
    throw new Error(`SVM token mint not found: ${mint}`);
}

async function findAssociatedTokenAddress(input: {
    owner: SolanaAddress;
    mint: SolanaAddress;
    tokenProgram: SolanaAddress;
}): Promise<SolanaAddress> {
    const encoder = getSolanaAddressEncoder();
    const [ata] = await getSolanaProgramDerivedAddress({
        programAddress: solanaAddress(ASSOCIATED_TOKEN_PROGRAM),
        seeds: [
            encoder.encode(input.owner),
            encoder.encode(input.tokenProgram),
            encoder.encode(input.mint),
        ],
    });
    return ata;
}

async function fetchSvmTokenAccountData(
    rpc: ReturnType<typeof createSvmRpc>,
    ata: SolanaAddress,
): Promise<Buffer | null> {
    const typedRpc = rpc as {
        getAccountInfo: (address: SolanaAddress, config: { encoding: string }) => {
            send: () => Promise<{ value: { data?: [string, string] } | null }>;
        };
    };
    const info = await typedRpc.getAccountInfo(ata, { encoding: "base64" }).send();
    if (!info.value || !info.value.data) return null;
    const [base64Data] = info.value.data;
    return Buffer.from(base64Data, "base64");
}

async function readSvmUsdcBalanceWei(
    userAddress: string,
    network: SolanaNetworkId,
): Promise<bigint> {
    try {
        const rpc = createSvmRpc(network);
        const definition = getNetwork(network);
        const mint = solanaAddress(definition.asset.address);
        const owner = solanaAddress(userAddress);
        const tokenProgram = await readSvmTokenProgramAddress(rpc, mint);
        const ata = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
        const data = await fetchSvmTokenAccountData(rpc, ata);
        if (!data || data.length < 72) return 0n;
        return data.readBigUInt64LE(64);
    } catch (error) {
        console.warn(`[session-allowance] Failed to read SVM USDC balance for ${userAddress} on ${network}:`, error);
        return 0n;
    }
}

async function readSvmDelegateAllowanceWei(
    userAddress: string,
    network: SolanaNetworkId,
): Promise<bigint> {
    try {
        const rpc = createSvmRpc(network);
        const definition = getNetwork(network);
        const mint = solanaAddress(definition.asset.address);
        const owner = solanaAddress(userAddress);
        const tokenProgram = await readSvmTokenProgramAddress(rpc, mint);
        const ata = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
        const data = await fetchSvmTokenAccountData(rpc, ata);
        if (!data || data.length < 129) return 0n;

        const delegateOption = data.readUInt8(72);
        if (delegateOption === 0) return 0n;

        const delegatePubkey = data.subarray(76, 108).toString("hex");
        const expectedDelegate = svmTreasuryWalletAddress?.trim();
        if (!expectedDelegate) return 0n;

        const encoder = getSolanaAddressEncoder();
        const expectedDelegateBytes = encoder.encode(solanaAddress(expectedDelegate));
        if (delegatePubkey !== Buffer.from(expectedDelegateBytes).toString("hex")) return 0n;

        return data.readBigUInt64LE(121);
    } catch (error) {
        console.warn(`[session-allowance] Failed to read SVM delegate allowance for ${userAddress} on ${network}:`, error);
        return 0n;
    }
}

export async function readSessionAllowanceWei(
    userAddress: string,
    network: NetworkId,
): Promise<bigint> {
    const override = readSessionAllowanceOverrideWei();
    if (override !== null) {
        return override;
    }

    if (!isEvmNetwork(network)) {
        return readSvmDelegateAllowanceWei(userAddress, network as SolanaNetworkId);
    }
    const publicClient = createUsdcPublicClient(network);
    const usdcAddress = getNetwork(network).asset.address as `0x${string}`;
    const spender = resolveSessionAllowanceSpenderAddress();

    return publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [
            userAddress as `0x${string}`,
            spender,
        ],
    });
}

function createUsdcPublicClient(network: EvmNetworkId) {
    const chain = getViemChain(network);
    const rpcUrl = getNetworkRpcUrl(network);

    return createPublicClient({
        chain,
        transport: http(rpcUrl),
    });
}

export async function readSessionUsdcBalanceWei(
    userAddress: string,
    network: NetworkId,
): Promise<bigint> {
    if (!isEvmNetwork(network)) {
        return readSvmUsdcBalanceWei(userAddress, network as SolanaNetworkId);
    }
    const publicClient = createUsdcPublicClient(network);
    const usdcAddress = getNetwork(network).asset.address as `0x${string}`;

    return publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [
            userAddress as `0x${string}`,
        ],
    });
}

export async function hasAnySessionAllowance(input: {
    userAddress: string;
    network: NetworkId;
}): Promise<boolean> {
    return (await readSessionAllowanceWei(input.userAddress, input.network)) > 0n;
}

export async function getSessionFundingReadiness(input: {
    userAddress: string;
    network: NetworkId;
    requiredBudgetWei: bigint | number | string;
}): Promise<SessionFundingReadiness> {
    const requiredWei = BigInt(input.requiredBudgetWei);
    if (requiredWei <= 0n) {
        throw new Error("requiredBudgetWei must be greater than zero");
    }

    const spender = isSolanaNetwork(input.network)
        ? (svmTreasuryWalletAddress as `0x${string}`)
        : resolveSessionAllowanceSpenderAddress();
    const [balanceWei, allowanceWei] = await Promise.all([
        readSessionUsdcBalanceWei(input.userAddress, input.network),
        readSessionAllowanceWei(input.userAddress, input.network),
    ]);

    if (balanceWei < requiredWei) {
        return {
            ready: false,
            reason: "insufficient_balance",
            requiredWei: requiredWei.toString(),
            balanceWei: balanceWei.toString(),
            allowanceWei: allowanceWei.toString(),
            spender,
            error: "Insufficient USDC balance for requested session budget",
            hint: "Fund the tied wallet/smart account with at least the selected session budget, then retry session creation.",
        };
    }

    if (allowanceWei < requiredWei) {
        return {
            ready: false,
            reason: "insufficient_allowance",
            requiredWei: requiredWei.toString(),
            balanceWei: balanceWei.toString(),
            allowanceWei: allowanceWei.toString(),
            spender,
            error: "Insufficient USDC allowance for requested session budget",
            hint: `Approve at least the selected session budget to ${spender}, then retry session creation.`,
        };
    }

    return {
        ready: true,
        requiredWei: requiredWei.toString(),
        balanceWei: balanceWei.toString(),
        allowanceWei: allowanceWei.toString(),
        spender,
    };
}
