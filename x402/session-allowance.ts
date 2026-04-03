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

export const UNBOUNDED_SESSION_ALLOWANCE_WEI = (2n ** 256n) - 1n;

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

export async function readSessionAllowanceWei(
    userAddress: string,
    chainId: number,
): Promise<bigint> {
    const chain = getViemChain(chainId);
    const usdcAddress = getUsdcAddress(chainId);
    const rpcUrl = getRpcUrl(chainId);
    const spender = resolveSessionAllowanceSpenderAddress();

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });

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

export async function hasAnySessionAllowance(input: {
    userAddress: string;
    chainId: number;
}): Promise<boolean> {
    return (await readSessionAllowanceWei(input.userAddress, input.chainId)) > 0n;
}
