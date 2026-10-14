import { createPublicClient, http } from "viem";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { base58 } from "@scure/base";

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
    isNearNetwork,
    isSolanaNetwork,
    type EvmNetworkId,
    type NearNetworkId,
    type NetworkId,
    type SolanaNetworkId,
    NETWORK_IDS,
} from "../configs/chains.js";
import {
    nearTreasuryWalletAddress,
    resolveNearFacilitatorWallet,
    resolveNearTreasuryWallet,
    svmTreasuryWalletAddress,
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

export type SessionFundingFailureReason =
    | "insufficient_balance"
    | "insufficient_allowance"
    | "rpc_unavailable"
    | "network_configuration_error";

export interface SessionFundingReadiness {
    ready: boolean;
    reason?: SessionFundingFailureReason;
    network: NetworkId;
    payer: string;
    asset?: string;
    requiredWei: string;
    balanceWei?: string;
    allowanceWei?: string;
    spender?: string;
    error?: string;
    hint?: string;
}

export interface SessionFundingReadinessDependencies {
    resolveSpender?: (network: NetworkId) => string;
    readBalanceWei?: (userAddress: string, network: NetworkId) => Promise<bigint>;
    readAllowanceWei?: (userAddress: string, network: NetworkId) => Promise<bigint>;
}

export function resolveSessionAllowanceSpenderAddress(
    env: NodeJS.ProcessEnv = process.env,
): `0x${string}` {
    const configuredSpender = env.TREASURY_SERVER_WALLET_PUBLIC?.trim();
    if (!configuredSpender) {
        throw new Error("EVM Treasury Wallet can't be read.");
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(configuredSpender)) {
        throw new Error("EVMTreasury Wallet has an invalid format.");
    }

    return configuredSpender as `0x${string}`;
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

function readSessionBalanceOverrideWei(): bigint | null {
    const raw = process.env.COMPOSE_SESSION_BALANCE_OVERRIDE_WEI?.trim();
    if (!raw) {
        return null;
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error("COMPOSE_SESSION_BALANCE_OVERRIDE_WEI must be a base-10 integer string");
    }
    return BigInt(raw);
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

function createSvmRpc(network: SolanaNetworkId) {
    const rpcUrl = getNetworkRpcUrl(network);
    if (network === NETWORK_IDS.solanaDevnet) { return createSolanaRpc(solanaDevnet(rpcUrl)); }
    if (network === NETWORK_IDS.solana) { return createSolanaRpc(solanaMainnet(rpcUrl)); }
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
    const rpc = createSvmRpc(network);
    const definition = getNetwork(network);
    const mint = solanaAddress(definition.asset.address);
    const owner = solanaAddress(userAddress);
    const tokenProgram = await readSvmTokenProgramAddress(rpc, mint);
    const ata = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
    const data = await fetchSvmTokenAccountData(rpc, ata);
    if (!data || data.length < 72) return 0n;
    return data.readBigUInt64LE(64);
}

async function readSvmDelegateAllowanceWei(
    userAddress: string,
    network: SolanaNetworkId,
): Promise<bigint> {
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
    if (!expectedDelegate) {
        throw new Error("SVM Treasury Wallet can't be read.");
    }

    const encoder = getSolanaAddressEncoder();
    const expectedDelegateBytes = encoder.encode(solanaAddress(expectedDelegate));
    if (delegatePubkey !== Buffer.from(expectedDelegateBytes).toString("hex")) return 0n;

    return data.readBigUInt64LE(121);
}

function createNearProvider(network: NearNetworkId): JsonRpcProvider {
    const rpcUrl = getNetworkRpcUrl(network);
    return new JsonRpcProvider({ url: rpcUrl });
}

function isNearAccessKeyMissing(error: unknown): boolean {
    const text = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return /UNKNOWN_ACCESS_KEY|access key .* (not found|does not exist|doesn't exist)/i.test(text);
}

async function resolveNearFacilitatorPublicKey(provider: JsonRpcProvider, expectedSpender: string): Promise<string> {
    const facilitatorKey = process.env.NEAR_FACILITATOR_KEY?.trim();
    if (facilitatorKey) {
        const normalizedKey = (facilitatorKey.includes(":") ? facilitatorKey : `ed25519:${facilitatorKey}`) as KeyPairString;
        return KeyPair.fromString(normalizedKey).getPublicKey().toString();
    }
    if (expectedSpender.startsWith("ed25519:")) {
        return expectedSpender;
    }
    if (/^[0-9a-f]{64}$/.test(expectedSpender)) {
        return `ed25519:${base58.encode(Buffer.from(expectedSpender, "hex"))}`;
    }
    const keyList = await provider.viewAccessKeyList(expectedSpender, { finality: "final" });
    const firstKey = keyList.keys?.[0]?.public_key;
    if (!firstKey) {
        throw new Error(`No access keys found for NEAR treasury account ${expectedSpender}`);
    }
    return firstKey;
}

async function readNearUsdcBalanceWei(
    userAddress: string,
    network: NearNetworkId,
): Promise<bigint> {
    const provider = createNearProvider(network);
    const definition = getNetwork(network);
    const result = await provider.callFunction<string>(
        definition.asset.address,
        "ft_balance_of",
        { account_id: userAddress },
        { finality: "final" },
    );
    if (result === undefined || result === null) return 0n;
    if (typeof result !== "string" || !/^\d+$/.test(result)) {
        throw new Error(`Invalid ft_balance_of response from ${definition.asset.address}: ${String(result)}`);
    }
    return BigInt(result);
}

async function readNearDelegateAllowanceWei(
    userAddress: string,
    network: NearNetworkId,
): Promise<bigint> {
    const expectedSpender = resolveNearFacilitatorWallet(network)
        ?? resolveNearTreasuryWallet(network)
        ?? (process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC ?? nearTreasuryWalletAddress)?.trim();
    if (!expectedSpender) {
        throw new Error("NEAR Treasury Wallet can't be read.");
    }
    const provider = createNearProvider(network);
    const definition = getNetwork(network);
    const publicKey = await resolveNearFacilitatorPublicKey(provider, expectedSpender);
    try {
        const accessKey = await provider.viewAccessKey(userAddress, publicKey, { finality: "final" });
        if (accessKey.permission === "FullAccess") {
            return UNBOUNDED_SESSION_ALLOWANCE_WEI;
        }
        if (typeof accessKey.permission === "object" && accessKey.permission !== null && "FunctionCall" in accessKey.permission) {
            const fnPermission = accessKey.permission.FunctionCall;
            if (fnPermission.receiver_id !== definition.asset.address) {
                return 0n;
            }
            if (fnPermission.method_names.length > 0 && !fnPermission.method_names.includes("ft_transfer")) {
                return 0n;
            }
            return UNBOUNDED_SESSION_ALLOWANCE_WEI;
        }
        return 0n;
    } catch (error) {
        if (isNearAccessKeyMissing(error)) {
            return 0n;
        }
        throw error;
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
    const override = readSessionBalanceOverrideWei();
    if (override !== null) {
        return override;
    }
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
}, dependencies: SessionFundingReadinessDependencies = {}): Promise<SessionFundingReadiness> {
    const requiredWei = BigInt(input.requiredBudgetWei);
    if (requiredWei <= 0n) {
        throw new Error("requiredBudgetWei must be greater than zero");
    }

    const base = {
        network: input.network,
        payer: input.userAddress,
        requiredWei: requiredWei.toString(),
    };

    let asset: string;
    let spender: string;
    try {
        asset = getNetwork(input.network).asset.address;
        spender = dependencies.resolveSpender
            ? dependencies.resolveSpender(input.network)
            : isSolanaNetwork(input.network)
                ? (() => {
                    const configured = svmTreasuryWalletAddress?.trim();
                    if (!configured) {
                        throw new Error("SVM_TREASURY_SERVER_WALLET_PUBLIC environment variable required for Session allowance readiness");
                    }
                    return configured;
                })()
                : resolveSessionAllowanceSpenderAddress();
    } catch (error) {
        return {
            ready: false,
            reason: "network_configuration_error",
            ...base,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const balanceReader = dependencies.readBalanceWei || readSessionUsdcBalanceWei;
    const allowanceReader = dependencies.readAllowanceWei || readSessionAllowanceWei;
    const [balanceResult, allowanceResult] = await Promise.allSettled([
        balanceReader(input.userAddress, input.network),
        allowanceReader(input.userAddress, input.network),
    ]);
    const observedBalanceWei = balanceResult.status === "fulfilled" ? balanceResult.value : undefined;
    const observedAllowanceWei = allowanceResult.status === "fulfilled" ? allowanceResult.value : undefined;

    if (balanceResult.status === "rejected" || allowanceResult.status === "rejected") {
        const failures = [balanceResult, allowanceResult]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
        return {
            ready: false,
            reason: "rpc_unavailable",
            ...base,
            asset,
            spender,
            ...(observedBalanceWei !== undefined ? { balanceWei: observedBalanceWei.toString() } : {}),
            ...(observedAllowanceWei !== undefined ? { allowanceWei: observedAllowanceWei.toString() } : {}),
            error: failures.join("; "),
            hint: `Retry funding readiness for ${input.network}; no balance or allowance value was inferred from the failed RPC read.`,
        };
    }

    const balanceWei = balanceResult.value;
    const allowanceWei = allowanceResult.value;

    if (balanceWei < requiredWei) {
        return {
            ready: false,
            reason: "insufficient_balance",
            ...base,
            asset,
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
            ...base,
            asset,
            balanceWei: balanceWei.toString(),
            allowanceWei: allowanceWei.toString(),
            spender,
            error: "Insufficient USDC allowance for requested session budget",
            hint: `Approve at least the selected session budget to ${spender}, then retry session creation.`,
        };
    }

    return {
        ready: true,
        ...base,
        asset,
        balanceWei: balanceWei.toString(),
        allowanceWei: allowanceWei.toString(),
        spender,
    };
}
