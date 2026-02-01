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
    merchantWalletAddress,
    treasuryWalletAddress,
} from "../config/thirdweb.js";
import { getChainObject, getUsdcAddress, isCronosChain } from "../config/chains.js";

// =============================================================================
// Types
// =============================================================================

export interface SettlementResult {
    success: boolean;
    txHash?: string;
    error?: string;
}

/**
 * Decoded Cronos x402 payment header payload
 */
export interface CronosPaymentPayload {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: `0x${string}`;
    signature: `0x${string}`;
    asset: `0x${string}`;
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
 * Get USDC contract instance for a specific chain
 */
function getUsdcContractForChain(chainId: number) {
    const chain = getChainObject(chainId);
    const usdcAddress = getUsdcAddress(chainId);
    return getContract({
        client: serverClient,
        chain,
        address: usdcAddress,
    });
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

        // Use chain-specific USDC contract
        const usdcContract = getUsdcContractForChain(chainId);
        const chain = getChainObject(chainId);

        console.log(`[settlement]   Treasury: ${treasuryAccount.address}`);

        // Use transferFrom - TREASURY_WALLET has approval from user's session
        const transaction = prepareContractCall({
            contract: usdcContract,
            method: "function transferFrom(address from, address to, uint256 amount) returns (bool)",
            params: [
                userAddress as `0x${string}`,
                merchantWalletAddress,
                amount,
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
                chain,
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

// =============================================================================
// Cronos x402 On-Chain Settlement (uses transferWithAuthorization)
// =============================================================================

/**
 * Execute EIP-3009 transferWithAuthorization on-chain for Cronos x402 payments.
 * 
 * The Facilitator SDK only verifies the signature - this function executes
 * the actual USDC transfer by calling the contract's transferWithAuthorization.
 * 
 * @param payload - Decoded X-PAYMENT header payload with signature
 * @param chainId - Cronos chain ID (338 or 25)
 * @returns Settlement result with tx hash or error
 */
export async function settleCronosX402Payment(
    payload: CronosPaymentPayload,
    chainId: number,
): Promise<SettlementResult> {
    console.log(`[cronos-settlement] Executing transferWithAuthorization on chain ${chainId}`);
    console.log(`[cronos-settlement]   From: ${payload.from}`);
    console.log(`[cronos-settlement]   To: ${payload.to}`);
    console.log(`[cronos-settlement]   Value: ${payload.value} wei ($${(parseInt(payload.value) / 1_000_000).toFixed(6)})`);

    if (!isCronosChain(chainId)) {
        return { success: false, error: `Chain ${chainId} is not a Cronos chain` };
    }

    try {
        const treasuryAccount = getTreasuryAccount();
        const usdcContract = getUsdcContractForChain(chainId);
        const chain = getChainObject(chainId);

        // Parse signature into v, r, s components
        const sig = payload.signature.startsWith("0x") ? payload.signature.slice(2) : payload.signature;
        if (sig.length !== 130) {
            return { success: false, error: `Invalid signature length: ${sig.length}` };
        }
        const r = `0x${sig.slice(0, 64)}` as `0x${string}`;
        const s = `0x${sig.slice(64, 128)}` as `0x${string}`;
        const v = parseInt(sig.slice(128, 130), 16);

        console.log(`[cronos-settlement]   v=${v}, r=${r.slice(0, 10)}..., s=${s.slice(0, 10)}...`);

        // EIP-3009 transferWithAuthorization
        // function transferWithAuthorization(
        //     address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        //     bytes32 nonce, uint8 v, bytes32 r, bytes32 s
        // )
        const transaction = prepareContractCall({
            contract: usdcContract,
            method: "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
            params: [
                payload.from,
                payload.to,
                BigInt(payload.value),
                BigInt(payload.validAfter),
                BigInt(payload.validBefore),
                payload.nonce,
                v,
                r,
                s,
            ],
        });

        console.log(`[cronos-settlement] Sending transferWithAuthorization...`);

        const result = await sendTransaction({
            transaction,
            account: treasuryAccount,
        });

        console.log(`[cronos-settlement] Transaction submitted: ${result.transactionHash}`);

        // Wait for confirmation
        try {
            const receipt = await waitForReceipt({
                client: serverClient,
                chain,
                transactionHash: result.transactionHash,
                maxBlocksWaitTime: 15,
            });

            if (receipt.status === "reverted") {
                console.error(`[cronos-settlement] Transaction reverted: ${result.transactionHash}`);
                return { success: false, error: "transferWithAuthorization reverted" };
            }

            console.log(`[cronos-settlement] Confirmed in block ${receipt.blockNumber}`);
        } catch (waitError) {
            console.warn(`[cronos-settlement] Confirmation timeout:`, waitError);
        }

        return {
            success: true,
            txHash: result.transactionHash,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[cronos-settlement] Failed:`, errorMessage);

        if (errorMessage.includes("AuthorizationUsed") || errorMessage.includes("nonce")) {
            return { success: false, error: "Authorization already used (replay attack prevented)" };
        }
        if (errorMessage.includes("AuthorizationExpired") || errorMessage.includes("expired")) {
            return { success: false, error: "Authorization expired" };
        }
        if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
            return { success: false, error: "Insufficient USDC balance" };
        }

        return { success: false, error: errorMessage };
    }
}

/**
 * Parse X-PAYMENT header and extract payment payload
 */
export function parseX402PaymentHeader(header: string): CronosPaymentPayload | null {
    try {
        const decoded = JSON.parse(Buffer.from(header, "base64").toString());
        if (decoded.x402Version !== 1 || !decoded.payload) {
            return null;
        }
        return decoded.payload as CronosPaymentPayload;
    } catch {
        return null;
    }
}

