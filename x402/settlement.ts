/**
 * Compose Keys - On-Chain Settlement
 * 
 * Server-side USDC transfers using TREASURY_WALLET private key.
 * The session key permissions were granted when the user created their session.
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
    merchantWalletAddress,
    treasuryWalletAddress,
} from "./wallets.js";
import { getViemChain, getUsdcAddress, getRpcUrl } from "./configs/chains.js";

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

// =============================================================================
// Account & Client Helpers
// =============================================================================

/**
 * Get the TREASURY_WALLET account using DEPLOYER_KEY
 */
function getTreasuryAccount() {
    const privateKey = process.env.DEPLOYER_KEY;
    if (!privateKey) {
        throw new Error("DEPLOYER_KEY environment variable required");
    }

    return privateKeyToAccount(
        (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex,
    );
}

// =============================================================================
// On-Chain Settlement (Compose Keys - uses transferFrom)
// =============================================================================

/**
 * Execute USDC transfer from user's smart account.
 * 
 * Uses the TREASURY_WALLET's session key permissions (granted when user created session)
 * to execute a USDC transfer to the merchant wallet.
 * 
 * @param userAddress - User's smart wallet address (source)
 * @param amountWei - Amount in USDC wei (6 decimals) - can be number or string
 * @param chainId - Chain ID (match user's session chain)
 * @returns Settlement result with tx hash or error
 */
export async function settleComposeKeyPayment(
    userAddress: string,
    amountWei: number | string,
    chainId: number,
): Promise<SettlementResult> {
    const amount = typeof amountWei === "string" ? BigInt(amountWei) : BigInt(amountWei);

    console.log(`[settlement] Initiating on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${merchantWalletAddress}`);
    console.log(`[settlement]   Amount: ${amount.toString()} wei ($${(Number(amount) / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Chain: ${chainId}`);
    console.log(`[settlement]   Session Key: ${treasuryWalletAddress}`);

    try {
        const treasuryAccount = getTreasuryAccount();
        const chain = getViemChain(chainId);
        const rpcUrl = getRpcUrl(chainId);
        const usdcAddress = getUsdcAddress(chainId);

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

        // Wait for confirmation
        try {
            const receipt = await publicClient.waitForTransactionReceipt({
                hash: txHash,
                confirmations: 1,
                timeout: 60_000,
            });

            if (receipt.status === "reverted") {
                console.error(`[settlement] Transaction reverted: ${txHash}`);
                return { success: false, error: "Transaction reverted on-chain" };
            }

            console.log(`[settlement] Transaction confirmed in block ${receipt.blockNumber}`);
        } catch (waitError) {
            // Timeout waiting for confirmation - transaction may still succeed
            // Log warning but return success since tx was submitted
            console.warn(`[settlement] Confirmation timeout for ${txHash}:`, waitError);
        }

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
