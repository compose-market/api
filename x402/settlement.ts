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
    appendTransactionMessageInstructions as appendSolanaTransactionMessageInstructions,
    createKeyPairSignerFromBytes as createSolanaKeyPairSignerFromBytes,
    createSolanaRpc as createSolanaKitRpc,
    createTransactionMessage as createSolanaTransactionMessage,
    devnet as solanaDevnet,
    getAddressEncoder as getSolanaAddressEncoder,
    getBase64EncodedWireTransaction as getSolanaBase64EncodedWireTransaction,
    getSignatureFromTransaction as getSolanaSignatureFromTransaction,
    getProgramDerivedAddress as getSolanaProgramDerivedAddress,
    mainnet as solanaMainnet,
    pipe as solanaPipe,
    setTransactionMessageFeePayerSigner as setSolanaTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash as setSolanaTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners as signSolanaTransactionMessageWithSigners,
    type Address as SolanaAddress,
    type Instruction as SolanaInstruction,
    type Signature as SolanaSignature,
} from "@solana/kit";
import { base58 } from "@scure/base";
import { type KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
    actionCreators as nearActionCreators,
    buildDelegateAction as buildNearDelegateAction,
    createTransaction as createNearTransaction,
    SCHEMA as NEAR_SCHEMA,
} from "@near-js/transactions";
import { baseDecode as nearBaseDecode } from "@near-js/utils";
import { deserialize as borshDeserialize, serialize as borshSerialize } from "borsh";
import {
    merchantWalletAddress,
    resolveNearFacilitatorWallet,
    resolveNearMerchantWallet,
    resolveNearTreasuryWallet,
    treasuryWalletAddress,
} from "./wallets.js";
import {
    getNetwork,
    getNetworkRpcUrl,
    getViemChain,
    isAddressValidForNetwork,
    isEvmNetwork,
    isNearNetwork,
    isSolanaNetwork,
    NETWORK_IDS,
    type EvmNetworkId,
    type NearNetworkId,
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
    notObserved?: boolean;
    resetPreparation?: boolean;
    syncNextNonce?: string;
    syncNextDelegateNonce?: string;
}

export interface PreparedSettlementTransaction {
    network: NetworkId;
    txHash: string;
    payload: string;
    nonce?: string;
    delegateNonce?: string;
    secondaryPayload?: string;
    secondaryTxHash?: string;
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
const SVM_MEMO_PROGRAM_ADDRESS = solanaAddress("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DEFAULT_SETTLEMENT_MEMO = "settlement";
const SVM_TRANSFER_CHECKED_DISCRIMINATOR = 12;
const SVM_CONFIRM_ATTEMPTS = 30;
const SVM_CONFIRM_DELAY_MS = 1_000;
const NEAR_FT_TRANSFER_GAS = 30_000_000_000_000n;
const NEAR_STORAGE_DEPOSIT_GAS = 30_000_000_000_000n;
const NEAR_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n;
const NEAR_ONE_YOCTO = 1n;
const NEAR_DELEGATE_ACTION_TTL_BLOCKS = 300n;
const EVM_RPC_TIMEOUT_MS = 15_000;
const NEAR_RPC_TIMEOUT_MS = 15_000;
const NEAR_RECONCILE_TIMEOUT_MS = 8_000;
const nearSenderByTxHash = new Map<string, string>();

export function normalizeSettlementMemo(raw?: string): string {
    const cleaned = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
    return cleaned || DEFAULT_SETTLEMENT_MEMO;
}

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

function sanitizeSettlementRecipients(
    network: NetworkId,
    payTo?: string,
    royalties?: { creator?: string; treasury?: string },
): {
    payTo?: string;
    treasury?: string;
    creator?: string;
} {
    const explicitPayTo = payTo?.trim() || undefined;
    if (explicitPayTo && !isAddressValidForNetwork(explicitPayTo, network)) {
        throw new Error(`Invalid settlement payTo address for ${network}: ${explicitPayTo}`);
    }
    const explicitTreasury = royalties?.treasury?.trim() || undefined;
    if (explicitTreasury && !isAddressValidForNetwork(explicitTreasury, network)) {
        throw new Error(`Invalid settlement treasury address for ${network}: ${explicitTreasury}`);
    }
    const rawCreator = royalties?.creator?.trim() || undefined;
    const creator = rawCreator && isAddressValidForNetwork(rawCreator, network)
        ? rawCreator
        : undefined;
    return {
        payTo: explicitPayTo,
        treasury: explicitTreasury,
        creator,
    };
}

/**
 * Definitive payer balance/allowance/delegate/access-key/address failures are
 * terminal so reserved session budget unlocks instead of retrying forever.
 * Signer native-gas shortages, RPC blips, timeouts, and ambiguous network
 * errors remain retryable obligations.
 */
export function classifySettlementError(
    error: unknown,
    context: SettlementErrorContext,
): SettlementResult {
    const message = settlementErrorMessage(error);
    if (/Invalid (?:settlement|payer) .*address|InvalidAddressError|Solana error #8078012|Synthetic test settlement payload/i.test(message)) {
        return {
            success: false,
            status: "failed",
            terminal: true,
            error: message,
        };
    }

    if (isEvmNetwork(context.network)) {
        const payerBalanceFailure = /ERC20InsufficientBalance|transfer amount exceeds balance|insufficient (?:token|USDC) balance|exceeds balance/i.test(message);
        const payerAllowanceFailure = /ERC20InsufficientAllowance|insufficient allowance|transfer amount exceeds allowance|exceeds allowance/i.test(message);
        if (context.phase === "prepare" && (payerBalanceFailure || payerAllowanceFailure)) {
            return {
                success: false,
                status: "failed",
                terminal: true,
                error: payerBalanceFailure ? "Insufficient USDC balance" : "Session expired or insufficient allowance",
            };
        }
        if (context.phase === "broadcast") {
            if (/already known|TransactionAlreadyImported|known transaction/i.test(message) && context.txHash) {
                return {
                    success: false,
                    status: "submitted",
                    txHash: context.txHash,
                    error: message,
                };
            }
            if (/nonce too low|NonceTooLow|nonce has already been used/i.test(message)) {
                return {
                    success: false,
                    status: "queued",
                    resetPreparation: true,
                    error: message,
                };
            }
        }
    }

    if (isSolanaNetwork(context.network)) {
        const feePayerGasShortage = /Attempt to debit an account but found no record of a prior credit|InsufficientFundsForFee|InsufficientFundsForRent/i.test(message);
        const svmPayerTokenFailure = !feePayerGasShortage && (
            /Payer USDC token account not found|invalid account data for instruction|AccountNotInitialized|could not find account|insufficient (?:token|USDC) balance|insufficient delegated|owner does not match|custom program error: 0x1\b|custom program error: 0x4\b|Error: insufficient funds/i.test(message)
        );
        if ((context.phase === "prepare" || context.phase === "broadcast") && svmPayerTokenFailure) {
            return {
                success: false,
                status: "failed",
                terminal: true,
                error: message,
            };
        }
        if (context.phase === "broadcast" && /Blockhash not found|BlockhashNotFound/i.test(message)) {
            return {
                success: false,
                status: "queued",
                resetPreparation: true,
                error: message,
            };
        }
        if (context.phase === "reconcile" && /not observed|not found/i.test(message)) {
            return {
                success: false,
                status: "submitted",
                notObserved: true,
                ...(context.txHash ? { txHash: context.txHash } : {}),
                error: message,
            };
        }
    }

    if (isNearNetwork(context.network)) {
        const nearRelayerError = /^NEAR relayer /i.test(message);
        const nearPayerTerminal = !nearRelayerError && /Insufficient USDC|doesn't have enough balance|AccessKeyDoesNotExist|access key .* does not exist|AccountDoesNotExist|account .* does not exist|InvalidAccessKeyError|SignerDoesNotExist|NotEnoughBalance|LackBalanceForState|is not registered/i.test(message);
        if (context.phase === "prepare" && nearPayerTerminal) {
            return {
                success: false,
                status: "failed",
                terminal: true,
                error: message,
            };
        }
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
    if (network === NETWORK_IDS.solana) { return createSolanaKitRpc(solanaMainnet(rpcUrl)); }
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

async function inspectSvmSignature(
    rpc: ReturnType<typeof createSvmRpc>,
    signature: SolanaSignature,
): Promise<SettlementResult> {
    const status = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
    const current = status.value[0];
    if (!current) {
        return {
            success: false,
            status: "submitted",
            notObserved: true,
            txHash: signature,
            error: "SVM transaction not observed",
        };
    }
    if (current.err) {
        return {
            success: false,
            status: "failed",
            terminal: true,
            txHash: signature,
            error: `SVM transaction failed: ${JSON.stringify(current.err)}`,
        };
    }
    if (current.confirmationStatus === "confirmed" || current.confirmationStatus === "finalized") {
        return {
            success: true,
            status: "confirmed",
            txHash: signature,
        };
    }
    return {
        success: false,
        status: "submitted",
        txHash: signature,
        error: `SVM transaction confirmation status: ${current.confirmationStatus ?? "processed"}`,
    };
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
    payTo?: string,
    options?: {
        royalties?: { creator?: string; treasury?: string };
        providerAmountWei?: string;
        platformFeeWei?: string;
        memo?: string;
        service?: string;
    },
): Promise<PreparedSettlementTransaction> {
    if (!isAddressValidForNetwork(userAddress, network)) {
        throw new Error(`Invalid payer address for ${network}: ${userAddress}`);
    }
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);
    const definition = getNetwork(network);
    const sanitized = sanitizeSettlementRecipients(network, payTo, options?.royalties);

    const creatorAddress = sanitized.creator;
    const treasuryAddress = (sanitized.treasury || sanitized.payTo || process.env.SVM_MERCHANT_WALLET_ADDRESS?.trim())?.trim();

    const hasSplit = Boolean(
        options?.providerAmountWei &&
        creatorAddress &&
        treasuryAddress &&
        creatorAddress !== treasuryAddress
    );

    const rpc = createSvmRpc(network);
    const signer = await getSvmSettlementSigner();
    const mint = solanaAddress(definition.asset.address);
    const owner = solanaAddress(userAddress);
    const tokenProgram = await readSvmTokenProgramAddress(rpc, mint);
    const sourceAta = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
    const settlementMemo = normalizeSettlementMemo(options?.memo ?? options?.service);

    const memoInstruction = {
        programAddress: SVM_MEMO_PROGRAM_ADDRESS,
        accounts: [],
        data: new TextEncoder().encode(settlementMemo),
    } satisfies SolanaInstruction;

    const instructions: SolanaInstruction[] = [];

    if (hasSplit && creatorAddress && treasuryAddress && options?.providerAmountWei) {
        const creatorAmount = BigInt(options.providerAmountWei);
        const treasuryAmount = BigInt(options?.platformFeeWei ?? (amount - creatorAmount).toString());

        console.log(`[settlement] Initiating SVM split on-chain settlement:`);
        console.log(`[settlement]   From: ${userAddress}`);
        console.log(`[settlement]   Provider/Recipient: ${creatorAddress} -> ${creatorAmount.toString()} wei`);
        console.log(`[settlement]   Platform/Fee: ${treasuryAddress} -> ${treasuryAmount.toString()} wei`);
        console.log(`[settlement]   Network: ${network}`);

        if (creatorAmount > 0n) {
            const creatorOwner = solanaAddress(creatorAddress);
            const creatorAta = await findAssociatedTokenAddress({ owner: creatorOwner, mint, tokenProgram });
            instructions.push(addSolanaSignersToInstruction([signer], {
                programAddress: tokenProgram,
                accounts: [
                    { address: sourceAta, role: SolanaAccountRole.WRITABLE },
                    { address: mint, role: SolanaAccountRole.READONLY },
                    { address: creatorAta, role: SolanaAccountRole.WRITABLE },
                    { address: signer.address, role: SolanaAccountRole.READONLY_SIGNER },
                ],
                data: encodeTransferCheckedInstructionData(creatorAmount, definition.asset.decimals),
            } satisfies SolanaInstruction));
        }

        if (treasuryAmount > 0n) {
            const treasuryOwner = solanaAddress(treasuryAddress);
            const treasuryAta = await findAssociatedTokenAddress({ owner: treasuryOwner, mint, tokenProgram });
            instructions.push(addSolanaSignersToInstruction([signer], {
                programAddress: tokenProgram,
                accounts: [
                    { address: sourceAta, role: SolanaAccountRole.WRITABLE },
                    { address: mint, role: SolanaAccountRole.READONLY },
                    { address: treasuryAta, role: SolanaAccountRole.WRITABLE },
                    { address: signer.address, role: SolanaAccountRole.READONLY_SIGNER },
                ],
                data: encodeTransferCheckedInstructionData(treasuryAmount, definition.asset.decimals),
            } satisfies SolanaInstruction));
        }
    } else {
        const merchant = (
            creatorAddress
                && options?.providerAmountWei
                && (options?.platformFeeWei === "0" || BigInt(options.providerAmountWei) >= amount)
                ? creatorAddress
                : treasuryAddress
        );
        if (!merchant || !isAddressValidForNetwork(merchant, network)) {
            throw new Error("SVM_MERCHANT_WALLET_ADDRESS environment variable required");
        }

        console.log(`[settlement] Initiating SVM on-chain settlement:`);
        console.log(`[settlement]   From: ${userAddress}`);
        console.log(`[settlement]   To: ${merchant}`);
        console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
        console.log(`[settlement]   Network: ${network}`);

        const merchantOwner = solanaAddress(merchant);
        const destinationAta = await findAssociatedTokenAddress({ owner: merchantOwner, mint, tokenProgram });
        instructions.push(addSolanaSignersToInstruction([signer], {
            programAddress: tokenProgram,
            accounts: [
                { address: sourceAta, role: SolanaAccountRole.WRITABLE },
                { address: mint, role: SolanaAccountRole.READONLY },
                { address: destinationAta, role: SolanaAccountRole.WRITABLE },
                { address: signer.address, role: SolanaAccountRole.READONLY_SIGNER },
            ],
            data: encodeTransferCheckedInstructionData(amount, definition.asset.decimals),
        } satisfies SolanaInstruction));
    }

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const transactionMessage = solanaPipe(
        createSolanaTransactionMessage({ version: 0 }),
        (message) => setSolanaTransactionMessageFeePayerSigner(signer, message),
        (message) => setSolanaTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
        (message) => appendSolanaTransactionMessageInstructions(instructions, message),
        (message) => appendSolanaTransactionMessageInstruction(memoInstruction, message),
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
