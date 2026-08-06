/**
 * Compose Keys - On-Chain Settlement
 * 
 * Server-side USDC transfers using the treasury private key.
 * Compose session permissions were granted when the user created their session.
 * 
 * Uses viem for all on-chain interactions (same pattern as facilitator.ts).
 * 
 * @module shared/x402/settlement
 */

import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    http,
    keccak256,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    AccountRole as SolanaAccountRole,
    addSignersToInstruction as addSolanaSignersToInstruction,
    address as solanaAddress,
    appendTransactionMessageInstruction as appendSolanaTransactionMessageInstruction,
    createKeyPairSignerFromBytes as createSolanaKeyPairSignerFromBytes,
    createSolanaRpc as createSolanaKitRpc,
    createTransactionMessage as createSolanaTransactionMessage,
    devnet as solanaDevnet,
    getAddressEncoder as getSolanaAddressEncoder,
    getBase64EncodedWireTransaction as getSolanaBase64EncodedWireTransaction,
    getSignatureFromTransaction as getSolanaSignatureFromTransaction,
    getProgramDerivedAddress as getSolanaProgramDerivedAddress,
    // mainnet as solanaMainnet,
    pipe as solanaPipe,
    setTransactionMessageFeePayerSigner as setSolanaTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash as setSolanaTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners as signSolanaTransactionMessageWithSigners,
    type Address as SolanaAddress,
    type Instruction as SolanaInstruction,
    type Signature as SolanaSignature,
} from "@solana/kit";
import { base58 } from "@scure/base";
import {
    merchantWalletAddress,
    treasuryWalletAddress,
} from "./wallets.js";
import {
    getNetwork,
    getNetworkRpcUrl,
    getViemChain,
    isEvmNetwork,
    isSolanaNetwork,
    NETWORK_IDS,
    type EvmNetworkId,
    type NetworkId,
    type SolanaNetworkId,
} from "./configs/chains.js";

// =============================================================================
// Types
// =============================================================================

export interface SettlementResult {
    success: boolean;
    status: "queued" | "submitted" | "confirmed" | "failed";
    txHash?: string;
    error?: string;
    terminal?: boolean;
}

export interface PreparedSettlementTransaction {
    network: NetworkId;
    txHash: string;
    payload: string;
    nonce?: string;
}

export type SettlementPreparationResult =
    | { success: true; prepared: PreparedSettlementTransaction }
    | { success: false; result: SettlementResult };

export interface SettlementErrorContext {
    network: NetworkId;
    phase: "prepare" | "broadcast" | "reconcile";
    txHash?: string;
}

// =============================================================================
// ERC20 transferFrom ABI fragment
// =============================================================================

const ERC20_TRANSFER_FROM_ABI = [
    {
        name: "transferFrom",
        type: "function",
        inputs: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
    },
] as const;

const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = solanaAddress("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SVM_TOKEN_PROGRAM_ADDRESS = solanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SVM_TOKEN_2022_PROGRAM_ADDRESS = solanaAddress("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SVM_TRANSFER_CHECKED_DISCRIMINATOR = 12;
const SVM_CONFIRM_ATTEMPTS = 30;
const SVM_CONFIRM_DELAY_MS = 1_000;

// =============================================================================
// Account & Client Helpers
// =============================================================================

/**
 * Get the TREASURY_WALLET account using FACILITATOR_KEY
 */
function getTreasuryAccount() {
    const privateKey = process.env.FACILITATOR_KEY;
    if (!privateKey) {
        throw new Error("FACILITATOR_KEY environment variable required");
    }

    return privateKeyToAccount(
        (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex,
    );
}

/** Opaque public identity used only to scope canonical signer nonce state. */
export function getEvmSettlementSignerIdentity(): string {
    return getTreasuryAccount().address.toLowerCase();
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function settlementErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        const candidate = error as Error & { shortMessage?: string; details?: string };
        return [candidate.shortMessage, candidate.details, candidate.message]
            .filter((value): value is string => Boolean(value))
            .join(" | ");
    }
    return String(error);
}

/**
 * Only definitive payer-USDC balance/allowance failures detected while
 * simulating transferFrom are terminal. Signer native-gas shortages, RPC
 * failures, timeouts, and every ambiguous post-signing failure remain payable
 * obligations. Confirmed reverts are handled by receipt reconciliation.
 */
export function classifySettlementError(
    error: unknown,
    context: SettlementErrorContext,
): SettlementResult {
    const message = settlementErrorMessage(error);
    const payerBalanceFailure = /ERC20InsufficientBalance|transfer amount exceeds balance|insufficient (?:token|USDC) balance/i.test(message);
    const payerAllowanceFailure = /ERC20InsufficientAllowance|insufficient allowance|transfer amount exceeds allowance/i.test(message);
    if (isEvmNetwork(context.network)
        && context.phase === "prepare"
        && (payerBalanceFailure || payerAllowanceFailure)) {
        return {
            success: false,
            status: "failed",
            terminal: true,
            error: payerBalanceFailure ? "Insufficient USDC balance" : "Session expired or insufficient allowance",
        };
    }
    const submitted = context.phase === "reconcile" && Boolean(context.txHash);
    return {
        success: false,
        status: submitted ? "submitted" : "queued",
        ...(submitted ? { txHash: context.txHash } : {}),
        error: message,
    };
}

function encodeTransferCheckedInstructionData(amount: bigint, decimals: number): Uint8Array {
    const data = new Uint8Array(10);
    data[0] = SVM_TRANSFER_CHECKED_DISCRIMINATOR;
    new DataView(data.buffer).setBigUint64(1, amount, true);
    data[9] = decimals;
    return data;
}

function createSvmRpc(network: SolanaNetworkId) {
    const rpcUrl = getNetworkRpcUrl(network);
    if (network === NETWORK_IDS.solanaDevnet) { return createSolanaKitRpc(solanaDevnet(rpcUrl)); }
    // if (network === NETWORK_IDS.solana) { return createSolanaKitRpc(solanaMainnet(rpcUrl)); }
    throw new Error(`Unsupported SVM settlement network: ${network}`);
}

async function getSvmSettlementSigner() {
    const privateKey = process.env.SVM_FACILITATOR_KEY?.trim();
    if (!privateKey) {
        throw new Error("SVM_FACILITATOR_KEY environment variable required");
    }
    return createSolanaKeyPairSignerFromBytes(base58.decode(privateKey));
}

async function findAssociatedTokenAddress(input: {
    owner: SolanaAddress;
    mint: SolanaAddress;
    tokenProgram: SolanaAddress;
}): Promise<SolanaAddress> {
    const encoder = getSolanaAddressEncoder();
    const [ata] = await getSolanaProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        seeds: [
            encoder.encode(input.owner),
            encoder.encode(input.tokenProgram),
            encoder.encode(input.mint),
        ],
    });
    return ata;
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
    if (owner === SVM_TOKEN_2022_PROGRAM_ADDRESS) return SVM_TOKEN_2022_PROGRAM_ADDRESS;
    if (owner === SVM_TOKEN_PROGRAM_ADDRESS) return SVM_TOKEN_PROGRAM_ADDRESS;
    if (owner) {
        throw new Error(`Unsupported SVM token program for mint ${mint}: ${owner}`);
    }
    throw new Error(`SVM token mint not found: ${mint}`);
}

async function confirmSvmSignature(
    rpc: ReturnType<typeof createSvmRpc>,
    signature: SolanaSignature,
): Promise<void> {
    for (let attempt = 0; attempt < SVM_CONFIRM_ATTEMPTS; attempt += 1) {
        const status = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
        const current = status.value[0];
        if (current?.err) {
            throw new Error(`SVM transaction failed: ${JSON.stringify(current.err)}`);
        }
        if (current?.confirmationStatus === "confirmed" || current?.confirmationStatus === "finalized") {
            return;
        }
        await delay(SVM_CONFIRM_DELAY_MS);
    }
    throw new Error("SVM transaction confirmation timeout");
}

async function prepareSvmKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: SolanaNetworkId,
): Promise<PreparedSettlementTransaction> {
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);
    const definition = getNetwork(network);
    const merchant = process.env.SVM_MERCHANT_WALLET_ADDRESS?.trim();
    if (!merchant) {
        throw new Error("SVM_MERCHANT_WALLET_ADDRESS environment variable required");
    }

    console.log(`[settlement] Initiating SVM on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${merchant}`);
    console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Network: ${network}`);

    const rpc = createSvmRpc(network);
    const signer = await getSvmSettlementSigner();
    const mint = solanaAddress(definition.asset.address);
    const owner = solanaAddress(userAddress);
    const merchantOwner = solanaAddress(merchant);
    const tokenProgram = await readSvmTokenProgramAddress(rpc, mint);
    const [sourceAta, destinationAta] = await Promise.all([
        findAssociatedTokenAddress({ owner, mint, tokenProgram }),
        findAssociatedTokenAddress({ owner: merchantOwner, mint, tokenProgram }),
    ]);

    const transferInstruction = addSolanaSignersToInstruction([signer], {
        programAddress: tokenProgram,
        accounts: [
            { address: sourceAta, role: SolanaAccountRole.WRITABLE },
            { address: mint, role: SolanaAccountRole.READONLY },
            { address: destinationAta, role: SolanaAccountRole.WRITABLE },
            { address: signer.address, role: SolanaAccountRole.READONLY_SIGNER },
        ],
        data: encodeTransferCheckedInstructionData(amount, definition.asset.decimals),
    } satisfies SolanaInstruction);

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const transactionMessage = solanaPipe(
        createSolanaTransactionMessage({ version: 0 }),
        (message) => setSolanaTransactionMessageFeePayerSigner(signer, message),
        (message) => setSolanaTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
        (message) => appendSolanaTransactionMessageInstruction(transferInstruction, message),
    );
    const signedTransaction = await signSolanaTransactionMessageWithSigners(transactionMessage);
    return {
        network,
        txHash: getSolanaSignatureFromTransaction(signedTransaction),
        payload: getSolanaBase64EncodedWireTransaction(signedTransaction),
    };
}

// =============================================================================
// On-Chain Settlement (Compose Keys - uses transferFrom)
// =============================================================================

/**
 * Execute USDC transfer from user's smart account.
 * 
 * Uses Compose session permissions to execute a USDC transfer to the merchant
 * wallet.
 * 
 * @param userAddress - User's smart wallet address (source)
 * @param amountWei - Amount in USDC wei (6 decimals) - can be number or string
 * @param network - Network ID (match user's session chain)
 * @returns Settlement result with tx hash or error
 */
async function prepareEvmKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: EvmNetworkId,
    nonce?: bigint,
): Promise<PreparedSettlementTransaction> {
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);

    console.log(`[settlement] Initiating on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${merchantWalletAddress}`);
    console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Network: ${network}`);
    console.log(`[settlement]   Session Key: ${treasuryWalletAddress}`);

    const treasuryAccount = getTreasuryAccount();
    const chain = getViemChain(network);
    const rpcUrl = getNetworkRpcUrl(network);
    const usdcAddress = getNetwork(network).asset.address as `0x${string}`;

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
        account: treasuryAccount,
        chain,
        transport: http(rpcUrl),
    });

    console.log(`[settlement]   Treasury: ${treasuryAccount.address}`);

    await publicClient.simulateContract({
        address: usdcAddress,
        abi: ERC20_TRANSFER_FROM_ABI,
        functionName: "transferFrom",
        args: [
            userAddress as `0x${string}`,
            merchantWalletAddress,
            amount,
        ],
        account: treasuryAccount,
    });
    const data = encodeFunctionData({
        abi: ERC20_TRANSFER_FROM_ABI,
        functionName: "transferFrom",
        args: [
            userAddress as `0x${string}`,
            merchantWalletAddress,
            amount,
        ],
    });
    const prepared = await walletClient.prepareTransactionRequest({
        account: treasuryAccount,
        to: usdcAddress,
        data,
        value: 0n,
        ...(nonce === undefined ? {} : { nonce: Number(nonce) }),
    });
    const payload = await walletClient.signTransaction(prepared);
    return {
        network,
        txHash: keccak256(payload),
        payload,
        nonce: String(prepared.nonce),
    };
}

export async function getEvmSettlementPendingNonce(network: EvmNetworkId): Promise<bigint> {
    const account = getTreasuryAccount();
    const publicClient = createPublicClient({
        chain: getViemChain(network),
        transport: http(getNetworkRpcUrl(network)),
    });
    return BigInt(await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
    }));
}

export async function prepareKeyPaymentForNetwork(
    userAddress: string,
    amountWei: number | string,
    network: NetworkId,
    options: { evmNonce?: bigint } = {},
): Promise<SettlementPreparationResult> {
    try {
        if (isEvmNetwork(network)) {
            return {
                success: true,
                prepared: await prepareEvmKeyPayment(userAddress, amountWei, network, options.evmNonce),
            };
        }
        if (isSolanaNetwork(network)) {
            return { success: true, prepared: await prepareSvmKeyPayment(userAddress, amountWei, network) };
        }
        return {
            success: false,
            result: { success: false, status: "queued", error: `Unsupported settlement network: ${network}` },
        };
    } catch (error) {
        return { success: false, result: classifySettlementError(error, { network, phase: "prepare" }) };
    }
}

export async function broadcastPreparedKeyPaymentForNetwork(
    prepared: PreparedSettlementTransaction,
): Promise<SettlementResult> {
    try {
        if (isEvmNetwork(prepared.network)) {
            const publicClient = createPublicClient({
                chain: getViemChain(prepared.network),
                transport: http(getNetworkRpcUrl(prepared.network)),
            });
            const returnedHash = await publicClient.sendRawTransaction({
                serializedTransaction: prepared.payload as Hex,
            });
            if (returnedHash.toLowerCase() !== prepared.txHash.toLowerCase()) {
                throw new Error(`RPC returned transaction hash ${returnedHash} for prepared identity ${prepared.txHash}`);
            }
            return { success: false, status: "submitted", txHash: prepared.txHash };
        }
        if (isSolanaNetwork(prepared.network)) {
            const rpc = createSvmRpc(prepared.network);
            const returnedHash = await rpc.sendTransaction(prepared.payload as ReturnType<typeof getSolanaBase64EncodedWireTransaction>, {
                encoding: "base64",
                preflightCommitment: "confirmed",
            }).send();
            if (returnedHash !== prepared.txHash) {
                throw new Error(`RPC returned transaction hash ${returnedHash} for prepared identity ${prepared.txHash}`);
            }
            return { success: false, status: "submitted", txHash: prepared.txHash };
        }
        return { success: false, status: "submitted", txHash: prepared.txHash, error: `Unsupported settlement network: ${prepared.network}` };
    } catch (error) {
        return classifySettlementError(error, {
            network: prepared.network,
            phase: "broadcast",
            txHash: prepared.txHash,
        });
    }
}

export async function submitKeyPaymentForNetwork(
    userAddress: string,
    amountWei: number | string,
    network: NetworkId,
): Promise<SettlementResult> {
    const preparation = await prepareKeyPaymentForNetwork(userAddress, amountWei, network);
    if (!preparation.success) return preparation.result;
    return broadcastPreparedKeyPaymentForNetwork(preparation.prepared);
}

export async function settleKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: EvmNetworkId,
): Promise<SettlementResult> {
    return settleKeyPaymentForNetwork(userAddress, amountWei, network);
}

export async function settleKeyPaymentForNetwork(
    userAddress: string,
    amountWei: number | string,
    network: NetworkId,
): Promise<SettlementResult> {
    const submitted = await submitKeyPaymentForNetwork(userAddress, amountWei, network);
    if (submitted.status !== "submitted" || !submitted.txHash) return submitted;
    return reconcileKeyPaymentForNetwork(submitted.txHash, network, { wait: true });
}

export async function reconcileKeyPaymentForNetwork(
    txHash: string,
    network: NetworkId,
    options: { wait?: boolean } = {},
): Promise<SettlementResult> {
    if (isEvmNetwork(network)) {
        try {
            const publicClient = createPublicClient({
                chain: getViemChain(network),
                transport: http(getNetworkRpcUrl(network)),
            });
            const receipt = options.wait
                ? await publicClient.waitForTransactionReceipt({
                    hash: txHash as Hex,
                    confirmations: 1,
                    timeout: 60_000,
                })
                : await publicClient.getTransactionReceipt({ hash: txHash as Hex });
            if (receipt.status !== "success") {
                return {
                    success: false,
                    status: "failed",
                    terminal: true,
                    txHash,
                    error: "Transaction reverted on-chain",
                };
            }
            return { success: true, status: "confirmed", txHash };
        } catch (error) {
            return classifySettlementError(error, { network, phase: "reconcile", txHash });
        }
    }
    if (isSolanaNetwork(network)) {
        try {
            const rpc = createSvmRpc(network);
            await confirmSvmSignature(rpc, txHash as SolanaSignature);
            return { success: true, status: "confirmed", txHash };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("transaction failed")) {
                return { success: false, status: "failed", terminal: true, txHash, error: message };
            }
            return classifySettlementError(error, { network, phase: "reconcile", txHash });
        }
    }
    return { success: false, status: "submitted", txHash, error: `Unsupported settlement network: ${network}` };
}
