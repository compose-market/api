import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
    getRpcUrl,
    getUsdcAddress,
    getViemChain,
} from "./configs/chains.js";
import {
    merchantWalletAddress,
    treasuryWalletAddress,
} from "./wallets.js";

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
    const deployerKey = env.DEPLOYER_KEY?.trim();

    if (deployerKey) {
        const derivedSpender = privateKeyToAccount(normalizePrivateKey(deployerKey)).address;
        if (
            configuredTreasury
            && configuredTreasury.toLowerCase() !== derivedSpender.toLowerCase()
        ) {
            console.warn(
                `[session-allowance] TREASURY_SERVER_WALLET_PUBLIC (${configuredTreasury}) does not match DEPLOYER_KEY public address (${derivedSpender}); using DEPLOYER_KEY`,
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

export async function readSessionAllowanceWei(
    userAddress: string,
    chainId: number,
): Promise<bigint> {
    const override = readSessionAllowanceOverrideWei();
    if (override !== null) {
        return override;
    }

    const publicClient = createUsdcPublicClient(chainId);
    const usdcAddress = getUsdcAddress(chainId);
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

function createUsdcPublicClient(chainId: number) {
    const chain = getViemChain(chainId);
    const rpcUrl = getRpcUrl(chainId);

    return createPublicClient({
        chain,
        transport: http(rpcUrl),
    });
}

export async function readSessionUsdcBalanceWei(
    userAddress: string,
    chainId: number,
): Promise<bigint> {
    const publicClient = createUsdcPublicClient(chainId);
    const usdcAddress = getUsdcAddress(chainId);

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
    chainId: number;
}): Promise<boolean> {
    return (await readSessionAllowanceWei(input.userAddress, input.chainId)) > 0n;
}

export async function getSessionFundingReadiness(input: {
    userAddress: string;
    chainId: number;
    requiredBudgetWei: bigint | number | string;
}): Promise<SessionFundingReadiness> {
    const requiredWei = BigInt(input.requiredBudgetWei);
    if (requiredWei <= 0n) {
        throw new Error("requiredBudgetWei must be greater than zero");
    }

    const spender = resolveSessionAllowanceSpenderAddress();
    const [balanceWei, allowanceWei] = await Promise.all([
        readSessionUsdcBalanceWei(input.userAddress, input.chainId),
        readSessionAllowanceWei(input.userAddress, input.chainId),
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
