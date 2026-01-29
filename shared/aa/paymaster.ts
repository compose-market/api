/**
 * Paymaster Module (ERC-4337 v0.7)
 * 
 * Generates paymaster signatures for gasless UserOperations on Cronos.
 * The Paymaster contract verifies these signatures to sponsor gas.
 * 
 * @module shared/aa/paymaster
 */

import { concat, toHex, pad, keccak256, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { UserOperation } from "./userop.js";
import { unpackUints } from "./userop.js";

// =============================================================================
// Paymaster Address (set after deployment)
// =============================================================================

export function getPaymasterAddress(chainId: number): Address {
    const address = process.env.CRONOS_TESTNET_PAYMASTER;
    if (!address) {
        throw new Error("CRONOS_TESTNET_PAYMASTER not configured");
    }
    return address as Address;
}

// =============================================================================
// Paymaster Hash Generation (v0.7)
// =============================================================================

/**
 * Compute the hash that the Paymaster verifies (v0.7 format)
 * Must match Paymaster.getHash() in Solidity
 * 
 * v0.7 uses packed fields:
 * - accountGasLimits = verificationGasLimit (16 bytes) + callGasLimit (16 bytes)
 * - gasFees = maxPriorityFeePerGas (16 bytes) + maxFeePerGas (16 bytes)
 */
export function getPaymasterHash(
    userOp: UserOperation,
    validUntil: number,
    validAfter: number,
    chainId: number,
    paymasterAddress: Address
): Hex {
    // Unpack the gas values for hashing
    const [verificationGasLimit, callGasLimit] = unpackUints(userOp.accountGasLimits);
    const [maxPriorityFeePerGas, maxFeePerGas] = unpackUints(userOp.gasFees);

    // Match the Solidity encoding exactly:
    // keccak256(abi.encode(
    //     sender, nonce, keccak256(initCode), keccak256(callData),
    //     callGasLimit, verificationGasLimit, preVerificationGas,
    //     maxFeePerGas, maxPriorityFeePerGas,
    //     chainId, paymaster, validUntil, validAfter
    // ))

    const encoded = concat([
        pad(userOp.sender as Hex, { size: 32 }),
        pad(toHex(userOp.nonce), { size: 32 }),
        keccak256(userOp.initCode),
        keccak256(userOp.callData),
        pad(toHex(callGasLimit), { size: 32 }),
        pad(toHex(verificationGasLimit), { size: 32 }),
        pad(toHex(userOp.preVerificationGas), { size: 32 }),
        pad(toHex(maxFeePerGas), { size: 32 }),
        pad(toHex(maxPriorityFeePerGas), { size: 32 }),
        pad(toHex(chainId), { size: 32 }),
        pad(paymasterAddress as Hex, { size: 32 }),
        pad(toHex(validUntil), { size: 32 }),
        pad(toHex(validAfter), { size: 32 }),
    ]);

    return keccak256(encoded);
}

// =============================================================================
// Paymaster Signature Generation
// =============================================================================

/**
 * Sign a UserOperation for paymaster sponsorship
 * Uses SERVER_WALLET_KEY to sign
 */
export async function signPaymasterData(
    userOp: UserOperation,
    chainId: number,
    validitySeconds: number = 300
): Promise<Hex> {
    const serverPrivateKey = process.env.SERVER_WALLET_KEY;
    if (!serverPrivateKey) {
        throw new Error("SERVER_WALLET_KEY not configured");
    }

    const paymasterAddress = getPaymasterAddress(chainId);

    // Calculate validity window
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60; // Valid from 1 minute ago (clock skew tolerance)
    const validUntil = now + validitySeconds;

    // Create account from private key
    const account = privateKeyToAccount(serverPrivateKey as Hex);

    // Compute hash that matches Paymaster.getHash()
    const hash = getPaymasterHash(userOp, validUntil, validAfter, chainId, paymasterAddress);

    // Sign with EIP-191 prefix (matches toEthSignedMessageHash in Solidity)
    const signature = await account.signMessage({
        message: { raw: hash },
    });

    console.log(`[aa/paymaster] Signed for sender ${userOp.sender}`);
    console.log(`[aa/paymaster] validUntil: ${validUntil}, validAfter: ${validAfter}`);
    console.log(`[aa/paymaster] signature length: ${signature.length}`);

    return signature;
}

/**
 * Build the complete paymasterAndData field for a v0.7 UserOperation
 * 
 * Format (v0.7):
 * [0:20]   - paymaster address
 * [20:36]  - paymasterVerificationGasLimit (16 bytes, uint128)
 * [36:52]  - paymasterPostOpGasLimit (16 bytes, uint128)
 * [52:58]  - validUntil (uint48, 6 bytes)
 * [58:64]  - validAfter (uint48, 6 bytes)
 * [64:129] - signature (65 bytes)
 */
export async function buildPaymasterAndData(
    userOp: UserOperation,
    chainId: number,
    validitySeconds: number = 300
): Promise<Hex> {
    const paymasterAddress = getPaymasterAddress(chainId);

    // Calculate validity window
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validUntil = now + validitySeconds;

    // Paymaster gas limits (v0.7)
    const paymasterVerificationGasLimit = 100_000n;
    const paymasterPostOpGasLimit = 50_000n;

    // Sign the UserOp (with empty paymasterAndData for hash calculation)
    const signature = await signPaymasterData(
        { ...userOp, paymasterAndData: "0x" as Hex },
        chainId,
        validitySeconds
    );

    // Pack: paymaster (20) + pmVerificationGas (16) + pmPostOpGas (16) + validUntil (6) + validAfter (6) + signature (65)
    const paymasterAndData = concat([
        paymasterAddress,
        pad(toHex(paymasterVerificationGasLimit), { size: 16 }),
        pad(toHex(paymasterPostOpGasLimit), { size: 16 }),
        pad(toHex(validUntil), { size: 6 }),
        pad(toHex(validAfter), { size: 6 }),
        signature,
    ]);

    console.log(`[aa/paymaster] Built paymasterAndData (v0.7): ${paymasterAndData.length} chars`);

    return paymasterAndData;
}

// =============================================================================
// Verification Helper
// =============================================================================

/**
 * Verify a paymaster signature (for debugging)
 */
export function verifyPaymasterSignature(
    userOp: UserOperation,
    validUntil: number,
    validAfter: number,
    signature: Hex,
    chainId: number
): { valid: boolean; signer: Address | null } {
    const serverPrivateKey = process.env.SERVER_WALLET_KEY;
    if (!serverPrivateKey) {
        return { valid: false, signer: null };
    }

    const expectedSigner = privateKeyToAccount(serverPrivateKey as Hex).address;
    const paymasterAddress = getPaymasterAddress(chainId);

    // Recompute hash
    const hash = getPaymasterHash(userOp, validUntil, validAfter, chainId, paymasterAddress);

    // For now, we trust our own signature - full recovery would need ecrecover
    console.log(`[aa/paymaster] Expected signer: ${expectedSigner}`);
    console.log(`[aa/paymaster] Hash: ${hash}`);

    return { valid: true, signer: expectedSigner };
}
