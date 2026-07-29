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
    http,
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
    txHash?: string;
    error?: string;
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

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

async function settleSvmKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: SolanaNetworkId,
): Promise<SettlementResult> {
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);
    const definition = getNetwork(network);
    const merchant = process.env.SVM_MERCHANT_WALLET_ADDRESS?.trim();
    if (!merchant) {
        return { success: false, error: "SVM_MERCHANT_WALLET_ADDRESS environment variable required" };
    }

    console.log(`[settlement] Initiating SVM on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${merchant}`);
    console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Network: ${network}`);

    try {
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
        const encodedTransaction = getSolanaBase64EncodedWireTransaction(signedTransaction);
        const txHash = await rpc.sendTransaction(encodedTransaction, {
            encoding: "base64",
            preflightCommitment: "confirmed",
        }).send();
        await confirmSvmSignature(rpc, txHash);

        console.log(`[settlement] SVM transaction confirmed: ${txHash}`);
        return {
            success: true,
            txHash,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[settlement] SVM transaction failed:`, errorMessage);

        if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
            return { success: false, error: "Insufficient USDC balance" };
        }
        if (
            errorMessage.includes("owner does not match")
            || errorMessage.includes("delegate")
            || errorMessage.includes("authority")
            || errorMessage.includes("MissingRequiredSignature")
        ) {
            return { success: false, error: "Session expired or insufficient allowance" };
        }

        return { success: false, error: errorMessage };
    }
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
export async function settleKeyPayment(
    userAddress: string,
    amountWei: number | string,
    network: EvmNetworkId,
): Promise<SettlementResult> {
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);

    console.log(`[settlement] Initiating on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${merchantWalletAddress}`);
    console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Network: ${network}`);
    console.log(`[settlement]   Session Key: ${treasuryWalletAddress}`);

    try {
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

        // Simulate first to catch errors before sending
        const { request } = await publicClient.simulateContract({
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

        console.log(`[settlement] Sending transaction...`);

        const txHash = await walletClient.writeContract(request);

        console.log(`[settlement] Transaction submitted: ${txHash}`);

        return {
            success: true,
            txHash,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[settlement] Transaction failed:`, errorMessage);

        if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
            return { success: false, error: "Insufficient USDC balance" };
        }
        if (errorMessage.includes("allowance") || errorMessage.includes("exceeds")) {
            return { success: false, error: "Session expired or insufficient allowance" };
        }

        return { success: false, error: errorMessage };
    }
}

export async function settleKeyPaymentForNetwork(
    userAddress: string,
    amountWei: number | string,
    network: NetworkId,
): Promise<SettlementResult> {
    if (isEvmNetwork(network)) {
        return settleKeyPayment(userAddress, amountWei, network);
    }
    if (isSolanaNetwork(network)) {
        return settleSvmKeyPayment(userAddress, amountWei, network);
    }
    return { success: false, error: `Unsupported settlement network: ${network}` };
}
