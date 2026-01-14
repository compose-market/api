/**
 * Compose Keys - On-Chain Settlement
 * 
 * Server-side USDC transfers using TREASURY_WALLET private key.
 * The session key permissions were granted when the user created their session.
 * 
 * @module shared/x402/settlement
 */

import { getContract, prepareContractCall, sendTransaction, waitForReceipt } from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";
import {
    serverClient,
    paymentChain,
    paymentAsset,
    merchantWalletAddress,
    treasuryWalletAddress,
} from "../config/thirdweb.js";

// =============================================================================
// Types
// =============================================================================

export interface SettlementResult {
    success: boolean;
    txHash?: string;
    error?: string;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Get the TREASURY_WALLET account using DEPLOYER_KEY
 */
function getTreasuryAccount() {
    const privateKey = process.env.DEPLOYER_KEY;
    if (!privateKey) {
        throw new Error("DEPLOYER_KEY environment variable required");
    }

    return privateKeyToAccount({
        client: serverClient,
        privateKey: privateKey.startsWith("0x") ? privateKey as `0x${string}` : `0x${privateKey}`,
    });
}

/**
 * Get USDC contract instance
 */
function getUsdcContract() {
    return getContract({
        client: serverClient,
        chain: paymentChain,
        address: paymentAsset.address,
    });
}

// =============================================================================
// On-Chain Settlement
// =============================================================================

/**
 * Execute USDC transfer from user's smart account.
 * 
 * Uses the TREASURY_WALLET's session key permissions (granted when user created session)
 * to execute a USDC transfer to the merchant wallet.
 * 
 * @param userAddress - User's smart wallet address (source)
 * @param amountWei - Amount in USDC wei (6 decimals)
 * @returns Settlement result with tx hash or error
 */
export async function settleComposeKeyPayment(
    userAddress: string,
    amountWei: number,
): Promise<SettlementResult> {
    console.log(`[settlement] Initiating on-chain settlement:`);
    console.log(`[settlement]   From: ${userAddress}`);
    console.log(`[settlement]   To: ${merchantWalletAddress}`);
    console.log(`[settlement]   Amount: ${amountWei} wei ($${(amountWei / 1_000_000).toFixed(6)})`);
    console.log(`[settlement]   Session Key: ${treasuryWalletAddress}`);

    try {
        const treasuryAccount = getTreasuryAccount();
        const usdcContract = getUsdcContract();

        console.log(`[settlement]   Treasury: ${treasuryAccount.address}`);

        // Use transferFrom - TREASURY_WALLET has approval from user's session
        const transaction = prepareContractCall({
            contract: usdcContract,
            method: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
            params: [
                userAddress as `0x${string}`,
                merchantWalletAddress,
                BigInt(amountWei),
            ],
        });

        console.log(`[settlement] Sending transaction...`);

        const result = await sendTransaction({
            transaction,
            account: treasuryAccount,
        });

        console.log(`[settlement] Transaction submitted: ${result.transactionHash}`);

        // Wait for confirmation (Lambda has 120s timeout, allocate 30s for confirmation)
        try {
            const receipt = await waitForReceipt({
                client: serverClient,
                chain: paymentChain,
                transactionHash: result.transactionHash,
                maxBlocksWaitTime: 15,
            });

            if (receipt.status === "reverted") {
                console.error(`[settlement] Transaction reverted: ${result.transactionHash}`);
                return { success: false, error: "Transaction reverted on-chain" };
            }

            console.log(`[settlement] Transaction confirmed in block ${receipt.blockNumber}`);
        } catch (waitError) {
            // Timeout waiting for confirmation - transaction may still succeed
            // Log warning but return success since tx was submitted
            console.warn(`[settlement] Confirmation timeout for ${result.transactionHash}:`, waitError);
        }

        return {
            success: true,
            txHash: result.transactionHash,
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
