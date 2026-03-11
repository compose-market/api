/**
 * UserOperation Module (ERC-4337 v0.7)
 * 
 * Utilities for building and submitting ERC-4337 UserOperations on Cronos.
 * Uses ThirdWeb's AccountFactory for Smart Account creation.
 * 
 * @module shared/aa/userop
 */

import { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, toHex, concat, pad, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cronosTestnet } from "viem/chains";
import { CHAIN_IDS } from "../x402/configs/chains.js";

// =============================================================================
// Constants (v0.7)
// =============================================================================

// ERC-4337 v0.7 EntryPoint (universal across all chains)
export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

// ThirdWeb Default AccountFactory v0.7 (used on Avalanche Fuji and other chains)
export const THIRDWEB_ACCOUNT_FACTORY_V07 = "0x4be0ddfebca9a5a4a617dee4dece99e7c862dceb" as const;

// Our Custom AccountFactory on Cronos Testnet (deployed via ThirdWeb contracts)
export const CRONOS_TESTNET_ACCOUNT_FACTORY = "0x4bE0ddfebcA9A5A4a617dee4DeCe99E7c862dceb" as const;

/**
 * Get EntryPoint address for a chain (v0.7 universal)
 */
export function getEntryPointAddress(_chainId: number): Address {
    // v0.7 EntryPoint is the same on all chains
    return ENTRYPOINT_V07;
}

/**
 * Get AccountFactory address for a chain
 * - Cronos chains use our custom factory
 * - Other chains use ThirdWeb's default factory
 */
export function getAccountFactoryAddress(chainId: number): Address {
    if (chainId === CHAIN_IDS.cronosTestnet || chainId === CHAIN_IDS.cronos) {
        return CRONOS_TESTNET_ACCOUNT_FACTORY;
    }
    // ThirdWeb's default v0.7 factory for other chains (Fuji, etc)
    return THIRDWEB_ACCOUNT_FACTORY_V07;
}

// =============================================================================
// UserOperation Type (ERC-4337 v0.7 / PackedUserOperation)
// =============================================================================

/**
 * ERC-4337 v0.7 UserOperation
 * Uses packed gas limits format for efficiency
 */
export interface UserOperation {
    sender: Address;
    nonce: bigint;
    initCode: Hex;
    callData: Hex;
    accountGasLimits: Hex;      // packed: verificationGasLimit (16 bytes) + callGasLimit (16 bytes)
    preVerificationGas: bigint;
    gasFees: Hex;               // packed: maxPriorityFeePerGas (16 bytes) + maxFeePerGas (16 bytes)
    paymasterAndData: Hex;
    signature: Hex;
}

/**
 * Unpacked gas values for easier manipulation
 */
export interface UserOperationGas {
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}

// =============================================================================
// Gas Packing/Unpacking (v0.7)
// =============================================================================

/**
 * Pack two uint128 values into a bytes32
 */
export function packUints(high: bigint, low: bigint): Hex {
    const highHex = pad(toHex(high), { size: 16 });
    const lowHex = pad(toHex(low), { size: 16 });
    return concat([highHex, lowHex]) as Hex;
}

/**
 * Unpack bytes32 into two uint128 values
 */
export function unpackUints(packed: Hex): [bigint, bigint] {
    const high = BigInt(("0x" + packed.slice(2, 34)) as Hex);
    const low = BigInt(("0x" + packed.slice(34, 66)) as Hex);
    return [high, low];
}

/**
 * Pack gas limits: verificationGasLimit + callGasLimit
 */
export function packAccountGasLimits(verificationGasLimit: bigint, callGasLimit: bigint): Hex {
    return packUints(verificationGasLimit, callGasLimit);
}

/**
 * Pack gas fees: maxPriorityFeePerGas + maxFeePerGas
 */
export function packGasFees(maxPriorityFeePerGas: bigint, maxFeePerGas: bigint): Hex {
    return packUints(maxPriorityFeePerGas, maxFeePerGas);
}

// =============================================================================
// UserOperation Hash (v0.7)
// =============================================================================

import { encodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Pack a v0.7 UserOperation for hashing (without signature)
 * MUST match EntryPoint's UserOperationLib.encode() exactly:
 * abi.encode(sender, nonce, hashInitCode, hashCallData, accountGasLimits, preVerificationGas, gasFees, hashPaymasterAndData)
 */
export function packUserOp(userOp: UserOperation): Hex {
    // First, encode the UserOp fields using abi.encode (NOT concat!)
    const encoded = encodeAbiParameters(
        parseAbiParameters("address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32"),
        [
            userOp.sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits as `0x${string}`,
            userOp.preVerificationGas,
            userOp.gasFees as `0x${string}`,
            keccak256(userOp.paymasterAndData),
        ]
    );
    return keccak256(encoded);
}

/**
 * Compute the UserOperation hash for a given chain and EntryPoint
 * MUST match EntryPoint's getUserOpHash() exactly:
 * keccak256(abi.encode(userOpHash, entryPoint, chainId))
 */
export function getUserOpHash(userOp: UserOperation, entryPoint: Address, chainId: number): Hex {
    const packed = packUserOp(userOp);
    // The outer hash uses abi.encode(bytes32, address, uint256)
    const encoded = encodeAbiParameters(
        parseAbiParameters("bytes32, address, uint256"),
        [packed, entryPoint, BigInt(chainId)]
    );
    return keccak256(encoded);
}

// =============================================================================
// Smart Account Execute Encoding (ThirdWeb Account)
// =============================================================================

/**
 * Encode a call to Account.execute(dest, value, data)
 */
export function encodeExecute(to: Address, value: bigint, data: Hex): Hex {
    return encodeFunctionData({
        abi: [
            {
                name: "execute",
                type: "function",
                inputs: [
                    { name: "_target", type: "address" },
                    { name: "_value", type: "uint256" },
                    { name: "_calldata", type: "bytes" },
                ],
                outputs: [],
            },
        ],
        functionName: "execute",
        args: [to, value, data],
    });
}

/**
 * Encode a batch call to Account.executeBatch(targets, values, calldatas)
 */
export function encodeExecuteBatch(calls: { to: Address; value: bigint; data: Hex }[]): Hex {
    return encodeFunctionData({
        abi: [
            {
                name: "executeBatch",
                type: "function",
                inputs: [
                    { name: "_target", type: "address[]" },
                    { name: "_value", type: "uint256[]" },
                    { name: "_calldata", type: "bytes[]" },
                ],
                outputs: [],
            },
        ],
        functionName: "executeBatch",
        args: [
            calls.map((c) => c.to),
            calls.map((c) => c.value),
            calls.map((c) => c.data),
        ],
    });
}

// =============================================================================
// ThirdWeb AccountFactory Functions
// =============================================================================

/**
 * Generate initCode for deploying a Smart Account via ThirdWeb AccountFactory
 * 
 * initCode format: factory address (20 bytes) + factory.createAccount(owner, data) calldata
 */
export function generateInitCode(
    adminAddress: Address,
    data: Hex = "0x",
    chainId: number
): Hex {
    const factoryAddress = getAccountFactoryAddress(chainId);

    // Encode createAccount(admin, data) call
    const createAccountData = encodeFunctionData({
        abi: [
            {
                name: "createAccount",
                type: "function",
                inputs: [
                    { name: "_admin", type: "address" },
                    { name: "_data", type: "bytes" },
                ],
                outputs: [{ name: "", type: "address" }],
            },
        ],
        functionName: "createAccount",
        args: [adminAddress, data],
    });

    // initCode = factory (20 bytes) + calldata
    return concat([factoryAddress, createAccountData]);
}

/**
 * Predict the Smart Account address for a given admin
 * Queries the AccountFactory's getAddress() function
 */
export async function predictAccountAddress(
    adminAddress: Address,
    data: Hex = "0x",
    chainId: number
): Promise<Address> {
    const factoryAddress = getAccountFactoryAddress(chainId);
    const rpcUrl = chainId === CHAIN_IDS.cronosTestnet
        ? "https://evm-t3.cronos.org"
        : chainId === CHAIN_IDS.cronos
            ? "https://evm.cronos.org"
            : "https://api.avax-test.network/ext/bc/C/rpc"; // Fuji fallback

    const client = createPublicClient({
        chain: cronosTestnet,
        transport: http(rpcUrl),
    });

    // ThirdWeb AccountFactory has getAddress(admin, data) view function
    const predictedAddress = await client.readContract({
        address: factoryAddress,
        abi: [
            {
                name: "getAddress",
                type: "function",
                inputs: [
                    { name: "_admin", type: "address" },
                    { name: "_data", type: "bytes" },
                ],
                outputs: [{ name: "", type: "address" }],
                stateMutability: "view",
            },
        ],
        functionName: "getAddress",
        args: [adminAddress, data],
    });

    console.log(`[userop] Predicted account for admin ${adminAddress} via factory ${factoryAddress}: ${predictedAddress}`);

    return predictedAddress as Address;
}

/**
 * Check if a Smart Account is deployed
 */
export async function isAccountDeployed(
    address: Address,
    chainId: number
): Promise<boolean> {
    const rpcUrl = chainId === CHAIN_IDS.cronosTestnet
        ? "https://evm-t3.cronos.org"
        : "https://evm.cronos.org";

    const client = createPublicClient({
        chain: cronosTestnet,
        transport: http(rpcUrl),
    });

    const code = await client.getCode({ address });
    return code !== undefined && code !== "0x" && code.length > 2;
}

// =============================================================================
// Nonce Management
// =============================================================================

const ENTRYPOINT_V07_ABI = [
    {
        name: "getNonce",
        type: "function",
        inputs: [
            { name: "sender", type: "address" },
            { name: "key", type: "uint192" },
        ],
        outputs: [{ name: "nonce", type: "uint256" }],
        stateMutability: "view",
    },
    {
        name: "handleOps",
        type: "function",
        inputs: [
            {
                name: "ops",
                type: "tuple[]",
                components: [
                    { name: "sender", type: "address" },
                    { name: "nonce", type: "uint256" },
                    { name: "initCode", type: "bytes" },
                    { name: "callData", type: "bytes" },
                    { name: "accountGasLimits", type: "bytes32" },
                    { name: "preVerificationGas", type: "uint256" },
                    { name: "gasFees", type: "bytes32" },
                    { name: "paymasterAndData", type: "bytes" },
                    { name: "signature", type: "bytes" },
                ],
            },
            { name: "beneficiary", type: "address" },
        ],
        outputs: [],
    },
    {
        name: "balanceOf",
        type: "function",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

/**
 * Get the current nonce for a Smart Account
 */
export async function getNonce(
    sender: Address,
    chainId: number,
    key: bigint = 0n
): Promise<bigint> {
    const entryPoint = getEntryPointAddress(chainId);
    const rpcUrl = chainId === CHAIN_IDS.cronosTestnet
        ? "https://evm-t3.cronos.org"
        : "https://evm.cronos.org";

    const client = createPublicClient({
        chain: cronosTestnet,
        transport: http(rpcUrl),
    });

    const nonce = await client.readContract({
        address: entryPoint,
        abi: ENTRYPOINT_V07_ABI,
        functionName: "getNonce",
        args: [sender, key],
    }) as bigint;

    return nonce;
}

// =============================================================================
// Submit UserOperation
// =============================================================================

/**
 * Submit a v0.7 UserOperation directly to the EntryPoint
 * Uses SERVER_WALLET to pay for gas
 */
export async function submitUserOperation(
    userOp: UserOperation,
    chainId: number
): Promise<{ txHash: Hex; success: boolean }> {
    const entryPoint = getEntryPointAddress(chainId);
    const rpcUrl = chainId === CHAIN_IDS.cronosTestnet
        ? "https://evm-t3.cronos.org"
        : "https://evm.cronos.org";

    // Server wallet pays gas for handleOps
    const serverPrivateKey = process.env.SERVER_WALLET_KEY;
    if (!serverPrivateKey) {
        throw new Error("SERVER_WALLET_KEY not configured");
    }

    const account = privateKeyToAccount(serverPrivateKey as Hex);

    const walletClient = createWalletClient({
        account,
        chain: cronosTestnet,
        transport: http(rpcUrl),
    });

    console.log(`[aa/userop] Submitting UserOp (v0.7) to EntryPoint ${entryPoint}`);
    console.log(`[aa/userop] Sender: ${userOp.sender}`);
    console.log(`[aa/userop] Beneficiary (gas refund): ${account.address}`);

    // Explicit gas limit to avoid Cronos's EIP-4844 data gas estimation issues
    // Viem's auto-estimation returns values that are too low for the tx calldata size.
    const txHash = await walletClient.writeContract({
        address: entryPoint,
        abi: ENTRYPOINT_V07_ABI,
        functionName: "handleOps",
        args: [
            [{
                sender: userOp.sender,
                nonce: userOp.nonce,
                initCode: userOp.initCode,
                callData: userOp.callData,
                accountGasLimits: userOp.accountGasLimits,
                preVerificationGas: userOp.preVerificationGas,
                gasFees: userOp.gasFees,
                paymasterAndData: userOp.paymasterAndData,
                signature: userOp.signature,
            }],
            account.address, // Beneficiary receives leftover gas
        ],
        gas: 2_000_000n, // Explicit gas limit to prevent floor data gas cost errors
    });

    console.log(`[aa/userop] Transaction submitted: ${txHash}`);

    return { txHash, success: true };
}

// =============================================================================
// Gas Estimation
// =============================================================================

export interface GasEstimates {
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}

/**
 * Get gas estimates for a UserOperation on Cronos
 * Uses reasonable defaults for Cronos network
 */
export async function estimateGas(chainId: number): Promise<GasEstimates> {
    const rpcUrl = chainId === CHAIN_IDS.cronosTestnet
        ? "https://evm-t3.cronos.org"
        : "https://evm.cronos.org";

    const client = createPublicClient({
        chain: cronosTestnet,
        transport: http(rpcUrl),
    });

    // Get current gas price
    const gasPrice = await client.getGasPrice();

    // Cronos-specific defaults (account deployment needs ~350k gas)
    // mintWorkflow uses ~650k gas due to multiple cross-contract calls
    return {
        callGasLimit: 1_000_000n,           // 1M for complex contract calls like mintWorkflow
        verificationGasLimit: 500_000n,   // 500k for verification (covers ~350k deployment)
        preVerificationGas: 150_000n,     // 150k pre-verification
        maxFeePerGas: gasPrice * 2n,       // 2x current gas price
        maxPriorityFeePerGas: gasPrice / 2n, // 0.5x for priority
    };
}

/**
 * Build a complete UserOperation with gas estimates
 */
export async function buildUserOperation(
    sender: Address,
    callData: Hex,
    chainId: number,
    initCode: Hex = "0x"
): Promise<UserOperation> {
    const gas = await estimateGas(chainId);
    const nonce = await getNonce(sender, chainId);

    return {
        sender,
        nonce,
        initCode,
        callData,
        accountGasLimits: packAccountGasLimits(gas.verificationGasLimit, gas.callGasLimit),
        preVerificationGas: gas.preVerificationGas,
        gasFees: packGasFees(gas.maxPriorityFeePerGas, gas.maxFeePerGas),
        paymasterAndData: "0x",
        signature: "0x",
    };
}

// =============================================================================
// Cross-Chain Account Registration
// =============================================================================

/**
 * Register a ThirdWeb/Fuji Smart Account address on our Cronos AccountFactory
 * 
 * This is called when:
 * 1. New user creates wallet on Avalanche Fuji → immediately register on Cronos
 * 2. Returning user selects Cronos but account doesn't exist → register on Cronos
 * 
 * The admin address (EOA signer) is passed to createAccount to derive the same
 * Smart Account address on Cronos as on other chains.
 */
export async function registerAccountOnCronos(
    adminAddress: Address
): Promise<{ success: boolean; accountAddress: Address | null; txHash?: Hex; error?: string }> {
    const chainId = CHAIN_IDS.cronosTestnet;
    const factoryAddress = CRONOS_TESTNET_ACCOUNT_FACTORY;

    console.log(`[aa/userop] Registering account on Cronos for admin: ${adminAddress}`);

    // Server wallet pays gas for deployment
    const serverPrivateKey = process.env.SERVER_WALLET_KEY;
    if (!serverPrivateKey) {
        return { success: false, accountAddress: null, error: "SERVER_WALLET_KEY not configured" };
    }

    const account = privateKeyToAccount(serverPrivateKey as Hex);

    const walletClient = createWalletClient({
        account,
        chain: cronosTestnet,
        transport: http("https://evm-t3.cronos.org"),
    });

    const publicClient = createPublicClient({
        chain: cronosTestnet,
        transport: http("https://evm-t3.cronos.org"),
    });

    // ABI for AccountFactory
    const ACCOUNT_FACTORY_ABI = [
        {
            name: "createAccount",
            type: "function",
            inputs: [
                { name: "_admin", type: "address" },
                { name: "_data", type: "bytes" },
            ],
            outputs: [{ name: "", type: "address" }],
        },
        {
            name: "getAddress",
            type: "function",
            inputs: [
                { name: "_admin", type: "address" },
                { name: "_data", type: "bytes" },
            ],
            outputs: [{ name: "", type: "address" }],
            stateMutability: "view",
        },
    ] as const;

    try {
        // First check if account already exists by predicting address and checking code
        const predictedAddress = await publicClient.readContract({
            address: factoryAddress,
            abi: ACCOUNT_FACTORY_ABI,
            functionName: "getAddress",
            args: [adminAddress, "0x"],
        }) as Address;

        console.log(`[aa/userop] Predicted Cronos account address: ${predictedAddress}`);

        // Check if already deployed
        const code = await publicClient.getCode({ address: predictedAddress });
        if (code && code !== "0x" && code.length > 2) {
            console.log(`[aa/userop] Account already deployed on Cronos`);
            return { success: true, accountAddress: predictedAddress };
        }

        // Deploy account via factory
        console.log(`[aa/userop] Deploying account via factory...`);
        const txHash = await walletClient.writeContract({
            address: factoryAddress,
            abi: ACCOUNT_FACTORY_ABI,
            functionName: "createAccount",
            args: [adminAddress, "0x"],
        });

        console.log(`[aa/userop] Account created on Cronos, tx: ${txHash}`);

        return { success: true, accountAddress: predictedAddress, txHash };
    } catch (error) {
        console.error(`[aa/userop] Error registering account on Cronos:`, error);
        return {
            success: false,
            accountAddress: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Get the predicted Smart Account address for an admin on a given chain
 */
export async function getPredictedAccountAddress(
    adminAddress: Address,
    chainId: number
): Promise<Address | null> {
    const factoryAddress = getAccountFactoryAddress(chainId);
    const rpcUrl = chainId === CHAIN_IDS.cronosTestnet
        ? "https://evm-t3.cronos.org"
        : "https://evm.cronos.org";

    const client = createPublicClient({
        chain: cronosTestnet,
        transport: http(rpcUrl),
    });

    try {
        const address = await client.readContract({
            address: factoryAddress,
            abi: [{
                name: "getAddress",
                type: "function",
                inputs: [
                    { name: "_admin", type: "address" },
                    { name: "_data", type: "bytes" },
                ],
                outputs: [{ name: "", type: "address" }],
                stateMutability: "view",
            }],
            functionName: "getAddress",
            args: [adminAddress, "0x"],
        }) as Address;

        return address;
    } catch (error) {
        console.error(`[aa/userop] Error predicting address:`, error);
        return null;
    }
}

