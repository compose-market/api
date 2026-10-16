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

interface NearRpcErrorObject {
    name?: string;
    code?: number;
    message?: string;
    data?: unknown;
    cause?: {
        name?: string;
        info?: Record<string, unknown>;
    };
}

interface NearRpcEnvelope<T> {
    jsonrpc: string;
    id: string;
    result?: T;
    error?: NearRpcErrorObject;
}

interface NearFinalExecutionOutcome {
    final_execution_status?: string;
    status?: unknown;
    receipts_outcome?: Array<{
        outcome?: {
            status?: unknown;
        };
    }>;
}

async function nearJsonRpc<T>(
    network: NearNetworkId,
    method: string,
    params: unknown,
    timeoutMs = NEAR_RPC_TIMEOUT_MS,
): Promise<NearRpcEnvelope<T>> {
    const response = await fetch(getNetworkRpcUrl(network), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "compose-settlement",
            method,
            params,
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`NEAR RPC HTTP ${response.status} on ${method}`);
    }
    return await response.json() as NearRpcEnvelope<T>;
}

async function callNearViewFunction<T>(
    network: NearNetworkId,
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
): Promise<T> {
    const envelope = await nearJsonRpc<{ result?: number[]; error?: string }>(
        network,
        "query",
        {
            request_type: "call_function",
            finality: "optimistic",
            account_id: contractId,
            method_name: methodName,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
    );
    if (envelope.error) {
        throw new Error(`NEAR call_function ${methodName} failed: ${JSON.stringify(envelope.error)}`);
    }
    if (!envelope.result || envelope.result.error || !Array.isArray(envelope.result.result)) {
        throw new Error(`NEAR call_function ${methodName} error: ${envelope.result?.error ?? "empty result"}`);
    }
    const decoded = Buffer.from(envelope.result.result).toString("utf8");
    return JSON.parse(decoded) as T;
}

function extractNearSenderFromPayload(payload?: string): string | undefined {
    if (!payload) return undefined;
    try {
        const decoded = borshDeserialize(
            NEAR_SCHEMA.SignedTransaction,
            Buffer.from(payload, "base64"),
        ) as { transaction?: { signerId?: string } };
        const signerId = decoded?.transaction?.signerId?.trim();
        return signerId || undefined;
    } catch {
        return undefined;
    }
}

function evaluateNearFailureStatus(
    failure: unknown,
    txHash: string,
    label: "transaction" | "receipt",
): SettlementResult {
    const failureJson = JSON.stringify(failure);
    if (/DelegateActionExpired|DelegateActionInvalidNonce/i.test(failureJson)) {
        const akNonceMatch = /"ak_nonce"\s*:\s*(\d+)/.exec(failureJson);
        const syncNextDelegateNonce = akNonceMatch ? (BigInt(akNonceMatch[1]) + 1n).toString() : undefined;
        return {
            success: false,
            status: "queued",
            resetPreparation: true,
            ...(syncNextDelegateNonce ? { syncNextDelegateNonce } : {}),
            error: `NEAR delegate action stale (${label}): ${failureJson}`,
        };
    }
    return {
        success: false,
        status: "failed",
        terminal: true,
        txHash,
        error: `NEAR ${label} failed: ${failureJson}`,
    };
}

function evaluateNearExecutionOutcome(
    outcome: NearFinalExecutionOutcome,
    txHash: string,
): SettlementResult {
    const hasFailure = (status: unknown): status is { Failure: unknown } =>
        typeof status === "object" && status !== null && "Failure" in status && Boolean((status as { Failure?: unknown }).Failure);

    if (hasFailure(outcome.status)) {
        return evaluateNearFailureStatus(outcome.status.Failure, txHash, "transaction");
    }

    for (const receipt of outcome.receipts_outcome ?? []) {
        if (hasFailure(receipt.outcome?.status)) {
            return evaluateNearFailureStatus(receipt.outcome.status.Failure, txHash, "receipt");
        }
    }

    const topLevelComplete = typeof outcome.status === "object"
        && outcome.status !== null
        && ("SuccessValue" in outcome.status || "SuccessReceiptId" in outcome.status);
    const receiptsComplete = (outcome.receipts_outcome ?? []).every((receipt) => {
        const receiptStatus = receipt.outcome?.status;
        return typeof receiptStatus === "object"
            && receiptStatus !== null
            && ("SuccessValue" in receiptStatus || "SuccessReceiptId" in receiptStatus);
    });

    if (topLevelComplete && receiptsComplete) {
        return { success: true, status: "confirmed", txHash };
    }
    return { success: false, status: "submitted", txHash };
}

function getNearSettlementSigner(): KeyPairSigner {
    const privateKey = process.env.NEAR_FACILITATOR_KEY?.trim();
    if (!privateKey) {
        throw new Error("NEAR_FACILITATOR_KEY environment variable required");
    }
    const normalized = (privateKey.includes(":") ? privateKey : `ed25519:${privateKey}`) as KeyPairString;
    return KeyPairSigner.fromSecretKey(normalized);
}

/** Public key string of the NEAR facilitator signer used to scope per-account access-key nonces. */
export async function getNearSettlementSignerIdentity(): Promise<string> {
    return (await getNearSettlementSigner().getPublicKey()).toString();
}

/** Canonical Facilitator relayer account that sponsors NEAR settlement gas via NEP-366 SignedDelegate. */
export function getNearSettlementFeePayer(network: NearNetworkId): string {
    const feePayer = resolveNearFacilitatorWallet(network)?.trim();
    if (!feePayer || !isAddressValidForNetwork(feePayer, network)) {
        throw new Error("NEAR_TREASURY_SERVER_WALLET_PUBLIC environment variable required");
    }
    return feePayer;
}

/** Read the next valid on-chain access-key nonce (`ak_nonce + 1`) for a NEAR payer or relayer account. */
export async function getNearSettlementAccessKeyNonce(
    accountId: string,
    network: NearNetworkId,
    role: "payer" | "relayer" = "payer",
): Promise<bigint> {
    if (!isAddressValidForNetwork(accountId, network)) {
        if (role === "relayer") {
            throw new Error(`NEAR relayer configuration invalid for ${network}: ${accountId}`);
        }
        throw new Error(`Invalid payer address for ${network}: ${accountId}`);
    }
    const publicKey = await getNearSettlementSignerIdentity();
    const envelope = await nearJsonRpc<{ nonce?: number | string; error?: string }>(
        network,
        "query",
        {
            request_type: "view_access_key",
            finality: "optimistic",
            account_id: accountId,
            public_key: publicKey,
        },
    );
    if (envelope.error) {
        throw new Error(`NEAR view_access_key failed for ${accountId}: ${JSON.stringify(envelope.error)}`);
    }
    if (!envelope.result || envelope.result.error || envelope.result.nonce === undefined) {
        if (role === "relayer") {
            throw new Error(`NEAR relayer key unavailable for ${accountId}: ${envelope.result?.error ?? "missing nonce"}`);
        }
        throw new Error(`NEAR access key does not exist for ${accountId}: ${envelope.result?.error ?? "missing nonce"}`);
    }
    return BigInt(envelope.result.nonce) + 1n;
}

async function prepareNearKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: NearNetworkId,
    payTo?: string,
    options?: {
        nearNonce?: bigint;
        nearDelegateNonce?: bigint;
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
    const treasuryAddress = (
        sanitized.treasury
        || sanitized.payTo
        || resolveNearMerchantWallet(network)
        || process.env.NEAR_MERCHANT_WALLET_ADDRESS?.trim()
    );
    if (!treasuryAddress || !isAddressValidForNetwork(treasuryAddress, network)) {
        throw new Error("NEAR_MERCHANT_WALLET_ADDRESS environment variable required");
    }

    const settlementMemo = normalizeSettlementMemo(options?.memo ?? options?.service);
    const feePayer = getNearSettlementFeePayer(network);
    const delegatedRelay = userAddress !== feePayer;
    const signer = getNearSettlementSigner();
    const publicKey = await signer.getPublicKey();
    const [relayerNonce, delegateNonce, blockEnvelope, payerBalanceRaw] = await Promise.all([
        options?.nearNonce !== undefined
            ? Promise.resolve(options.nearNonce)
            : getNearSettlementAccessKeyNonce(feePayer, network, "relayer"),
        delegatedRelay
            ? (options?.nearDelegateNonce !== undefined
                ? Promise.resolve(options.nearDelegateNonce)
                : getNearSettlementAccessKeyNonce(userAddress, network, "payer"))
            : Promise.resolve(0n),
        nearJsonRpc<{ header?: { hash?: string; height?: number | string } }>(network, "block", { finality: "final" }),
        callNearViewFunction<string>(
            network,
            definition.asset.address,
            "ft_balance_of",
            { account_id: userAddress },
        ),
    ]);

    if (
        blockEnvelope.error
        || !blockEnvelope.result?.header?.hash
        || (delegatedRelay && blockEnvelope.result.header.height === undefined)
    ) {
        throw new Error(`NEAR block lookup failed: ${JSON.stringify(blockEnvelope.error ?? "missing block header")}`);
    }
    if (BigInt(payerBalanceRaw) < amount) {
        throw new Error("Insufficient USDC balance");
    }

    const blockHashBytes = nearBaseDecode(blockEnvelope.result.header.hash);
    let activeRelayerNonce = relayerNonce;

    const actions: ReturnType<typeof nearActionCreators.functionCall>[] = [];
    const isSelfCreator = Boolean(creatorAddress && creatorAddress.toLowerCase() === userAddress.toLowerCase());
    const hasSplitCandidate = Boolean(
        options?.providerAmountWei
        && creatorAddress
        && !isSelfCreator
        && creatorAddress.toLowerCase() !== treasuryAddress.toLowerCase()
        && BigInt(options.providerAmountWei) > 0n,
    );

    let splitApplied = false;
    if (hasSplitCandidate && creatorAddress && options?.providerAmountWei) {
        const creatorAmount = BigInt(options.providerAmountWei);
        const treasuryAmount = BigInt(options?.platformFeeWei ?? (amount - creatorAmount).toString());
        let creatorStorage = await callNearViewFunction<Record<string, string> | null>(
            network,
            definition.asset.address,
            "storage_balance_of",
            { account_id: creatorAddress },
        ).catch(() => null);

        if (creatorStorage === null || creatorStorage === undefined) {
            const storageTx = createNearTransaction(
                feePayer,
                publicKey,
                definition.asset.address,
                activeRelayerNonce,
                [
                    nearActionCreators.functionCall(
                        "storage_deposit",
                        { account_id: creatorAddress, registration_only: true },
                        NEAR_STORAGE_DEPOSIT_GAS,
                        NEAR_STORAGE_DEPOSIT_YOCTO,
                    ),
                ],
                blockHashBytes,
            );
            const [, signedStorageTx] = await signer.signTransaction(storageTx);
            const storagePayload = Buffer.from(
                borshSerialize(NEAR_SCHEMA.SignedTransaction, signedStorageTx),
            ).toString("base64");
            const storageRes = await nearJsonRpc<NearFinalExecutionOutcome>(
                network,
                "send_tx",
                {
                    signed_tx_base64: storagePayload,
                    wait_until: "EXECUTED_OPTIMISTIC",
                },
                NEAR_RPC_TIMEOUT_MS,
            ).catch(() => null);
            if (storageRes && !storageRes.error && storageRes.result) {
                activeRelayerNonce += 1n;
                const evaluated = evaluateNearExecutionOutcome(storageRes.result, "storage");
                if (evaluated.success) {
                    creatorStorage = { total: NEAR_STORAGE_DEPOSIT_YOCTO.toString() };
                }
            }
        }

        if (creatorStorage !== null && creatorStorage !== undefined) {
            console.log(`[settlement] Initiating NEAR split on-chain settlement (relayer: ${feePayer}, memo: ${settlementMemo}):`);
            console.log(`[settlement]   From: ${userAddress}`);
            console.log(`[settlement]   Provider/Recipient: ${creatorAddress} -> ${creatorAmount.toString()} wei`);
            console.log(`[settlement]   Platform/Fee: ${treasuryAddress} -> ${treasuryAmount.toString()} wei`);
            console.log(`[settlement]   Network: ${network}`);

            actions.push(nearActionCreators.functionCall(
                "ft_transfer",
                {
                    receiver_id: creatorAddress,
                    amount: creatorAmount.toString(),
                    memo: settlementMemo,
                },
                NEAR_FT_TRANSFER_GAS,
                NEAR_ONE_YOCTO,
            ));
            if (treasuryAmount > 0n) {
                actions.push(nearActionCreators.functionCall(
                    "ft_transfer",
                    {
                        receiver_id: treasuryAddress,
                        amount: treasuryAmount.toString(),
                        memo: settlementMemo,
                    },
                    NEAR_FT_TRANSFER_GAS,
                    NEAR_ONE_YOCTO,
                ));
            }
            splitApplied = true;
        }
    }

    if (!splitApplied) {
        const effectiveAmount = isSelfCreator && options?.platformFeeWei && BigInt(options.platformFeeWei) > 0n
            ? BigInt(options.platformFeeWei)
            : amount;
        console.log(`[settlement] Initiating NEAR on-chain settlement (relayer: ${feePayer}, memo: ${settlementMemo}):`);
        console.log(`[settlement]   From: ${userAddress}`);
        console.log(`[settlement]   To: ${treasuryAddress}`);
        console.log(`[settlement]   Amount: ${effectiveAmount.toString()} wei ($${(Number(effectiveAmount) / 1_000_000).toFixed(6)})`);
        console.log(`[settlement]   Network: ${network}`);

        actions.push(nearActionCreators.functionCall(
            "ft_transfer",
            {
                receiver_id: treasuryAddress,
                amount: effectiveAmount.toString(),
                memo: settlementMemo,
            },
            NEAR_FT_TRANSFER_GAS,
            NEAR_ONE_YOCTO,
        ));
    }

    if (!delegatedRelay) {
        const directTransaction = createNearTransaction(
            feePayer,
            publicKey,
            definition.asset.address,
            activeRelayerNonce,
            actions,
            blockHashBytes,
        );
        const [txHashBytes, signedTransaction] = await signer.signTransaction(directTransaction);
        const txHash = base58.encode(txHashBytes);
        const payload = Buffer.from(borshSerialize(NEAR_SCHEMA.SignedTransaction, signedTransaction)).toString("base64");
        nearSenderByTxHash.set(txHash, feePayer);
        return {
            network,
            txHash,
            payload,
            nonce: String(activeRelayerNonce),
        };
    }

    const maxBlockHeight = BigInt(blockEnvelope.result.header.height!) + NEAR_DELEGATE_ACTION_TTL_BLOCKS;
    const delegateAction = buildNearDelegateAction({
        actions,
        maxBlockHeight,
        nonce: delegateNonce,
        publicKey,
        receiverId: definition.asset.address,
        senderId: userAddress,
    });
    const [, signedDelegate] = await signer.signDelegateAction(delegateAction);
    const outerTransaction = createNearTransaction(
        feePayer,
        publicKey,
        userAddress,
        activeRelayerNonce,
        [nearActionCreators.signedDelegate(signedDelegate)],
        blockHashBytes,
    );
    const [txHashBytes, signedTransaction] = await signer.signTransaction(outerTransaction);
    const txHash = base58.encode(txHashBytes);
    const payload = Buffer.from(borshSerialize(NEAR_SCHEMA.SignedTransaction, signedTransaction)).toString("base64");
    nearSenderByTxHash.set(txHash, feePayer);
    return {
        network,
        txHash,
        payload,
        nonce: String(activeRelayerNonce),
        delegateNonce: String(delegateNonce),
    };
}

// =============================================================================
// On-Chain Settlement (Compose Keys - uses transferFrom)
// =============================================================================

/**
 * Execute USDC transfer from user's smart account.
 * 
 * Uses Compose session permissions to execute a USDC transfer to the merchant
 * wallet or split between creator and treasury.
 * 
 * @param userAddress - User's smart wallet address (source)
 * @param amountWei - Amount in USDC wei (6 decimals) - can be number or string
 * @param network - Network ID (match user's session chain)
 * @param nonce - Optional EVM nonce
 * @param payTo - Optional destination recipient
 * @param options - Optional royalties and fee breakdown
 * @returns Settlement result with tx hash or error
 */
async function prepareEvmKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: EvmNetworkId,
    nonce?: bigint,
    payTo?: string,
    options?: {
        royalties?: { creator?: string; treasury?: string };
        providerAmountWei?: string;
        platformFeeWei?: string;
    },
): Promise<PreparedSettlementTransaction> {
    if (!isAddressValidForNetwork(userAddress, network)) {
        throw new Error(`Invalid payer address for ${network}: ${userAddress}`);
    }
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);
    const sanitized = sanitizeSettlementRecipients(network, payTo, options?.royalties);
    const creatorAddress = sanitized.creator;
    const treasuryAddress = (
        (sanitized.treasury as `0x${string}` | undefined)
        ?? (sanitized.payTo as `0x${string}` | undefined)
        ?? merchantWalletAddress
    );
    if (!isAddressValidForNetwork(treasuryAddress, network)) {
        throw new Error(`Invalid settlement treasury address for ${network}: ${treasuryAddress}`);
    }

    const hasSplit = Boolean(
        options?.providerAmountWei &&
        creatorAddress &&
        treasuryAddress &&
        creatorAddress.toLowerCase() !== treasuryAddress.toLowerCase()
    );

    const treasuryAccount = getTreasuryAccount();
    const chain = getViemChain(network);
    const rpcUrl = getNetworkRpcUrl(network);
    const usdcAddress = getNetwork(network).asset.address as `0x${string}`;

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl, { timeout: EVM_RPC_TIMEOUT_MS }),
    });

    const walletClient = createWalletClient({
        account: treasuryAccount,
        chain,
        transport: http(rpcUrl, { timeout: EVM_RPC_TIMEOUT_MS }),
    });

    if (hasSplit && creatorAddress && treasuryAddress && options?.providerAmountWei) {
        const creatorAmount = BigInt(options.providerAmountWei);
        const treasuryAmount = BigInt(options?.platformFeeWei ?? (amount - creatorAmount).toString());

        console.log(`[settlement] Initiating EVM split on-chain settlement:`);
        console.log(`[settlement]   From: ${userAddress}`);
        console.log(`[settlement]   Provider/Recipient: ${creatorAddress} -> ${creatorAmount.toString()} wei`);
        console.log(`[settlement]   Platform/Fee: ${treasuryAddress} -> ${treasuryAmount.toString()} wei`);
        console.log(`[settlement]   Network: ${network}`);

        if (creatorAmount > 0n && treasuryAmount > 0n) {
            const startNonce = nonce !== undefined ? Number(nonce) : await publicClient.getTransactionCount({
                address: treasuryAccount.address,
                blockTag: "pending",
            });

            // Primary Tx: Creator share
            await publicClient.simulateContract({
                address: usdcAddress,
                abi: ERC20_TRANSFER_FROM_ABI,
                functionName: "transferFrom",
                args: [userAddress as `0x${string}`, creatorAddress as `0x${string}`, creatorAmount],
                account: treasuryAccount,
            });
            const data1 = encodeFunctionData({
                abi: ERC20_TRANSFER_FROM_ABI,
                functionName: "transferFrom",
                args: [userAddress as `0x${string}`, creatorAddress as `0x${string}`, creatorAmount],
            });
            const prepared1 = await walletClient.prepareTransactionRequest({
                account: treasuryAccount,
                to: usdcAddress,
                data: data1,
                value: 0n,
                nonce: startNonce,
            });
            const payload1 = await walletClient.signTransaction(prepared1);

            // Secondary Tx: Treasury share
            await publicClient.simulateContract({
                address: usdcAddress,
                abi: ERC20_TRANSFER_FROM_ABI,
                functionName: "transferFrom",
                args: [userAddress as `0x${string}`, treasuryAddress as `0x${string}`, treasuryAmount],
                account: treasuryAccount,
            });
            const data2 = encodeFunctionData({
                abi: ERC20_TRANSFER_FROM_ABI,
                functionName: "transferFrom",
                args: [userAddress as `0x${string}`, treasuryAddress as `0x${string}`, treasuryAmount],
            });
            const prepared2 = await walletClient.prepareTransactionRequest({
                account: treasuryAccount,
                to: usdcAddress,
                data: data2,
                value: 0n,
                nonce: startNonce + 1,
            });
            const payload2 = await walletClient.signTransaction(prepared2);

            return {
                network,
                txHash: keccak256(payload1),
                payload: payload1,
                nonce: String(prepared1.nonce),
                secondaryPayload: payload2,
                secondaryTxHash: keccak256(payload2),
            };
        }
    }

    // Single recipient fallback (no split, cross-chain creator stripped, creator === treasury, or 100% single share)
    const targetRecipient = (
        creatorAddress
            && options?.providerAmountWei
            && (options?.platformFeeWei === "0" || BigInt(options.providerAmountWei) >= amount)
            ? (creatorAddress as `0x${string}`)
            : treasuryAddress
    );

    console.log(`[settlement] Initiating on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${targetRecipient}`);
    console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Network: ${network}`);
    console.log(`[settlement]   Session Key: ${treasuryWalletAddress}`);
    console.log(`[settlement]   Treasury: ${treasuryAccount.address}`);

    await publicClient.simulateContract({
        address: usdcAddress,
        abi: ERC20_TRANSFER_FROM_ABI,
        functionName: "transferFrom",
        args: [
            userAddress as `0x${string}`,
            targetRecipient,
            amount,
        ],
        account: treasuryAccount,
    });
    const data = encodeFunctionData({
        abi: ERC20_TRANSFER_FROM_ABI,
        functionName: "transferFrom",
        args: [
            userAddress as `0x${string}`,
            targetRecipient,
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
        transport: http(getNetworkRpcUrl(network), { timeout: EVM_RPC_TIMEOUT_MS }),
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
    options: {
        evmNonce?: bigint;
        nearNonce?: bigint;
        nearDelegateNonce?: bigint;
        payTo?: string;
        royalties?: { creator?: string; treasury?: string };
        providerAmountWei?: string;
        platformFeeWei?: string;
        memo?: string;
        service?: string;
    } = {},
): Promise<SettlementPreparationResult> {
    try {
        if (isEvmNetwork(network)) {
            return {
                success: true,
                prepared: await prepareEvmKeyPayment(userAddress, amountWei, network, options.evmNonce, options.payTo, options),
            };
        }
        if (isSolanaNetwork(network)) {
            return { success: true, prepared: await prepareSvmKeyPayment(userAddress, amountWei, network, options.payTo, options) };
        }
        if (isNearNetwork(network)) {
            return { success: true, prepared: await prepareNearKeyPayment(userAddress, amountWei, network, options.payTo, options) };
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
    if (process.env.NODE_ENV !== "test" && prepared.payload.startsWith("test-signed:")) {
        return {
            success: false,
            status: "failed",
            terminal: true,
            error: "Synthetic test settlement payload cannot execute outside test mode",
        };
    }
    try {
        if (isEvmNetwork(prepared.network)) {
            const publicClient = createPublicClient({
                chain: getViemChain(prepared.network),
                transport: http(getNetworkRpcUrl(prepared.network), { timeout: EVM_RPC_TIMEOUT_MS }),
            });
            const returnedHash = await publicClient.sendRawTransaction({
                serializedTransaction: prepared.payload as Hex,
            });
            if (returnedHash.toLowerCase() !== prepared.txHash.toLowerCase()) {
                throw new Error(`RPC returned transaction hash ${returnedHash} for prepared identity ${prepared.txHash}`);
            }
            if (prepared.secondaryPayload) {
                try {
                    await publicClient.sendRawTransaction({
                        serializedTransaction: prepared.secondaryPayload as Hex,
                    });
                    console.log(`[settlement] Broadcasted secondary split transaction: ${prepared.secondaryTxHash}`);
                } catch (secErr) {
                    console.warn("[settlement] Secondary split transaction broadcast:", secErr);
                }
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
        if (isNearNetwork(prepared.network)) {
            const signerId = extractNearSenderFromPayload(prepared.payload);
            if (signerId) {
                nearSenderByTxHash.set(prepared.txHash, signerId);
            }
            const envelope = await nearJsonRpc<NearFinalExecutionOutcome>(
                prepared.network,
                "send_tx",
                {
                    signed_tx_base64: prepared.payload,
                    wait_until: "EXECUTED_OPTIMISTIC",
                },
                NEAR_RPC_TIMEOUT_MS,
            );
            if (envelope.error) {
                const causeName = envelope.error.cause?.name ?? "";
                const errorJson = JSON.stringify(envelope.error);
                if (causeName === "TIMEOUT_ERROR") {
                    return {
                        success: false,
                        status: "submitted",
                        txHash: prepared.txHash,
                        error: `NEAR send_tx awaiting execution: ${errorJson}`,
                    };
                }
                if (causeName === "INVALID_TRANSACTION" || /InvalidTransaction|InvalidTxError/i.test(errorJson)) {
                    if (/InvalidNonce/i.test(errorJson)) {
                        const alreadyExecuted = await reconcileKeyPaymentForNetwork(
                            prepared.txHash,
                            prepared.network,
                            { wait: false, userAddress: signerId, preparedTxPayload: prepared.payload },
                        );
                        if (alreadyExecuted.status === "confirmed" || (alreadyExecuted.status === "failed" && alreadyExecuted.terminal)) {
                            return alreadyExecuted;
                        }
                        const akNonceMatch = /"ak_nonce"\s*:\s*(\d+)/.exec(errorJson);
                        const syncNextNonce = akNonceMatch ? (BigInt(akNonceMatch[1]) + 1n).toString() : undefined;
                        return {
                            success: false,
                            status: "queued",
                            resetPreparation: true,
                            ...(syncNextNonce ? { syncNextNonce } : {}),
                            error: `NEAR InvalidNonce: ${errorJson}`,
                        };
                    }
                    if (/"Expired"\b|Expired/i.test(errorJson)) {
                        return {
                            success: false,
                            status: "queued",
                            resetPreparation: true,
                            error: `NEAR transaction blockhash expired: ${errorJson}`,
                        };
                    }
                    if (/NotEnoughBalance|LackBalanceForState/i.test(errorJson)) {
                        const configuredFeePayer = resolveNearFacilitatorWallet(prepared.network)?.trim();
                        const signerMatch = /"signer_id"\s*:\s*"([^"]+)"/.exec(errorJson);
                        const balanceShortageSigner = signerMatch?.[1]?.trim();
                        if (configuredFeePayer && (!balanceShortageSigner || balanceShortageSigner === configuredFeePayer)) {
                            return {
                                success: false,
                                status: "queued",
                                error: `NEAR relayer gas shortage (${configuredFeePayer}): ${errorJson}`,
                            };
                        }
                    }
                    if (/InvalidAccessKeyError|AccessKeyDoesNotExist|DepositWithFunctionCall|MethodNameMismatch|ReceiverMismatch|AllowanceDoesNotCoverBalance|RequiresFullAccess|SignerDoesNotExist|NotEnoughBalance|LackBalanceForState|ActionsValidation|TransactionSizeExceeded|CostOverflow/i.test(errorJson)) {
                        return {
                            success: false,
                            status: "failed",
                            terminal: true,
                            error: `NEAR invalid transaction: ${errorJson}`,
                        };
                    }
                }
                return {
                    success: false,
                    status: "queued",
                    error: `NEAR send_tx RPC error: ${errorJson}`,
                };
            }
            if (!envelope.result) {
                return {
                    success: false,
                    status: "submitted",
                    txHash: prepared.txHash,
                    error: "NEAR send_tx returned empty result",
                };
            }
            return evaluateNearExecutionOutcome(envelope.result, prepared.txHash);
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

export interface KeyPaymentSettlementOptions {
    payTo?: string;
    royalties?: { creator?: string; treasury?: string };
    providerAmountWei?: string;
    platformFeeWei?: string;
    memo?: string;
    service?: string;
}

export async function submitKeyPaymentForNetwork(
    userAddress: string,
    amountWei: number | string,
    network: NetworkId,
    options: KeyPaymentSettlementOptions = {},
): Promise<SettlementResult> {
    const preparation = await prepareKeyPaymentForNetwork(userAddress, amountWei, network, options);
    if (!preparation.success) return preparation.result;
    return broadcastPreparedKeyPaymentForNetwork(preparation.prepared);
}

export async function settleKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: EvmNetworkId,
    options: KeyPaymentSettlementOptions = {},
): Promise<SettlementResult> {
    return settleKeyPaymentForNetwork(userAddress, amountWei, network, options);
}

export async function settleKeyPaymentForNetwork(
    userAddress: string,
    amountWei: number | string,
    network: NetworkId,
    options: KeyPaymentSettlementOptions = {},
): Promise<SettlementResult> {
    const submitted = await submitKeyPaymentForNetwork(userAddress, amountWei, network, options);
    if (submitted.status === "confirmed" || submitted.status !== "submitted" || !submitted.txHash) return submitted;
    return reconcileKeyPaymentForNetwork(submitted.txHash, network, { wait: true, userAddress });
}

export async function reconcileKeyPaymentForNetwork(
    txHash: string,
    network: NetworkId,
    options: { wait?: boolean; userAddress?: string; preparedTxPayload?: string } = {},
): Promise<SettlementResult> {
    if (isEvmNetwork(network)) {
        try {
            const publicClient = createPublicClient({
                chain: getViemChain(network),
                transport: http(getNetworkRpcUrl(network), { timeout: EVM_RPC_TIMEOUT_MS }),
            });
            const receipt = options.wait
                ? await publicClient.waitForTransactionReceipt({
                    hash: txHash as Hex,
                    confirmations: 1,
                    timeout: 20_000,
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
            if (!options.wait) {
                return await inspectSvmSignature(rpc, txHash as SolanaSignature);
            }
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
    if (isNearNetwork(network)) {
        try {
            const validUserAddress = options.userAddress?.trim() && isAddressValidForNetwork(options.userAddress.trim(), network)
                ? options.userAddress.trim()
                : undefined;
            const senderAccountId = extractNearSenderFromPayload(options.preparedTxPayload)
                ?? nearSenderByTxHash.get(txHash)
                ?? validUserAddress
                ?? resolveNearFacilitatorWallet(network)
                ?? process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC?.trim()
                ?? "system";
            const envelope = await nearJsonRpc<NearFinalExecutionOutcome>(
                network,
                "tx",
                {
                    tx_hash: txHash,
                    sender_account_id: senderAccountId,
                    wait_until: options.wait ? "EXECUTED_OPTIMISTIC" : "NONE",
                },
                options.wait ? NEAR_RPC_TIMEOUT_MS : NEAR_RECONCILE_TIMEOUT_MS,
            );
            if (envelope.error) {
                const causeName = envelope.error.cause?.name ?? "";
                const errorJson = JSON.stringify(envelope.error);
                if (causeName === "UNKNOWN_TRANSACTION" || /UNKNOWN_TRANSACTION|does not exist/i.test(errorJson)) {
                    return {
                        success: false,
                        status: "submitted",
                        notObserved: true,
                        txHash,
                        error: `NEAR transaction not observed (${senderAccountId}): ${errorJson}`,
                    };
                }
                return {
                    success: false,
                    status: "submitted",
                    txHash,
                    error: `NEAR tx status RPC error: ${errorJson}`,
                };
            }
            if (!envelope.result) {
                return {
                    success: false,
                    status: "submitted",
                    txHash,
                    error: "NEAR tx status returned empty result",
                };
            }
            return evaluateNearExecutionOutcome(envelope.result, txHash);
        } catch (error) {
            return classifySettlementError(error, { network, phase: "reconcile", txHash });
        }
    }
    return { success: false, status: "submitted", txHash, error: `Unsupported settlement network: ${network}` };
}
