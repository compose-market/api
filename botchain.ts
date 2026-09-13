/**
 * Botchain Mainnet (eip155:677) smart-account infrastructure.
 *
 * 1. Account creation: Thirdweb Social Login derives one deterministic EVM
 *    smart-account address per owner across networks through the existing
 *    Thirdweb v0.6 account factory. When a connector first selects Botchain
 *    (or logs in with Botchain selected), `createBotchainAccount` deploys
 *    that account on Botchain through the factory. The merchant wallet pays
 *    the creation transaction; an already-deployed account returns "ready"
 *    without spending anything.
 *
 * 2. Session approval relay: the ERC-20 session `approve` must be executed
 *    by the smart account, which only obeys its admin or the EntryPoint.
 *    `prepareBotchainSessionApproval` builds the v0.6 UserOperation (the
 *    EntryPoint computes its hash; the admin signs it off-chain — Thirdweb
 *    is identity-only). `submitBotchainSessionApproval` then pays for it
 *    exactly like account creation: one ordinary merchant transaction that
 *    (only when the account's EntryPoint gas escrow is short) tops up
 *    `depositTo(account)` and submits `handleOps` — atomically through the
 *    canonical Multicall3. No paymaster, no bundler, no deposit ceremony:
 *    unused prefund stays as the account's escrow and actual gas is
 *    reimbursed to the merchant beneficiary.
 */
import { z } from "@x402/core/schemas";
import {
    createPublicClient,
    createWalletClient,
    decodeFunctionData,
    encodeFunctionData,
    erc20Abi,
    hexToString,
    http,
    parseEventLogs,
    type Hash,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { NETWORK_IDS, getNetwork, getNetworkRpcUrl, getViemChain } from "./x402/configs/chains.js";
import { resolveSessionAllowanceSpenderAddress } from "./x402/session/allowance.js";

/** Existing Thirdweb v0.6 account factory already deployed on Botchain. */
const THIRDWEB_ACCOUNT_FACTORY_V0_6 = "0x85e23b94e7F5E9cC1fF78BCe78cfb15B81f0DF00" as const;

/** Canonical EntryPoint v0.6, deployed on Botchain. */
const ENTRY_POINT_V0_6 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as const;

/** Canonical Multicall3, already deployed on Botchain. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const FACTORY_ABI = [
    {
        type: "function",
        name: "createAccount",
        inputs: [
            { name: "owner", type: "address", internalType: "address" },
            { name: "salt", type: "bytes", internalType: "bytes" },
        ],
        outputs: [{ name: "", type: "address", internalType: "contract ILightAccount" }],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "getAddress",
        inputs: [
            { name: "owner", type: "address", internalType: "address" },
            { name: "salt", type: "bytes", internalType: "bytes" },
        ],
        outputs: [{ name: "", type: "address", internalType: "address" }],
        stateMutability: "view",
    },
] as const;

const ACCOUNT_ABI = [
    {
        type: "function",
        name: "isAdmin",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
        outputs: [{ name: "", type: "bool", internalType: "bool" }],
        stateMutability: "view",
    },
] as const;

const ACCOUNT_EXECUTE_ABI = [
    {
        type: "function",
        name: "execute",
        inputs: [
            { name: "target", type: "address", internalType: "address" },
            { name: "value", type: "uint256", internalType: "uint256" },
            { name: "calldata", type: "bytes", internalType: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/** ERC-4337 v0.6 EntryPoint interface used by the session relay. */
const ENTRY_POINT_ABI = [
    {
        type: "function",
        name: "getNonce",
        inputs: [
            { name: "sender", type: "address", internalType: "address" },
            { name: "key", type: "uint192", internalType: "uint192" },
        ],
        outputs: [{ name: "nonce", type: "uint256", internalType: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getUserOpHash",
        inputs: [
            {
                name: "userOp",
                type: "tuple",
                internalType: "struct UserOperation",
                components: [
                    { name: "sender", type: "address", internalType: "address" },
                    { name: "nonce", type: "uint256", internalType: "uint256" },
                    { name: "initCode", type: "bytes", internalType: "bytes" },
                    { name: "callData", type: "bytes", internalType: "bytes" },
                    { name: "callGasLimit", type: "uint256", internalType: "uint256" },
                    { name: "verificationGasLimit", type: "uint256", internalType: "uint256" },
                    { name: "preVerificationGas", type: "uint256", internalType: "uint256" },
                    { name: "maxFeePerGas", type: "uint256", internalType: "uint256" },
                    { name: "maxPriorityFeePerGas", type: "uint256", internalType: "uint256" },
                    { name: "paymasterAndData", type: "bytes", internalType: "bytes" },
                    { name: "signature", type: "bytes", internalType: "bytes" },
                ],
            },
        ],
        outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
        outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "depositTo",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "handleOps",
        inputs: [
            {
                name: "ops",
                type: "tuple[]",
                internalType: "struct UserOperation[]",
                components: [
                    { name: "sender", type: "address", internalType: "address" },
                    { name: "nonce", type: "uint256", internalType: "uint256" },
                    { name: "initCode", type: "bytes", internalType: "bytes" },
                    { name: "callData", type: "bytes", internalType: "bytes" },
                    { name: "callGasLimit", type: "uint256", internalType: "uint256" },
                    { name: "verificationGasLimit", type: "uint256", internalType: "uint256" },
                    { name: "preVerificationGas", type: "uint256", internalType: "uint256" },
                    { name: "maxFeePerGas", type: "uint256", internalType: "uint256" },
                    { name: "maxPriorityFeePerGas", type: "uint256", internalType: "uint256" },
                    { name: "paymasterAndData", type: "bytes", internalType: "bytes" },
                    { name: "signature", type: "bytes", internalType: "bytes" },
                ],
            },
            { name: "beneficiary", type: "address", internalType: "address" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "event",
        name: "UserOperationEvent",
        inputs: [
            { name: "userOpHash", type: "bytes32", indexed: true, internalType: "bytes32" },
            { name: "sender", type: "address", indexed: true, internalType: "address" },
            { name: "paymaster", type: "address", indexed: true, internalType: "address" },
            { name: "nonce", type: "uint256", indexed: false, internalType: "uint256" },
            { name: "success", type: "bool", indexed: false, internalType: "bool" },
            { name: "actualGasCost", type: "uint256", indexed: false, internalType: "uint256" },
            { name: "actualGasUsed", type: "uint256", indexed: false, internalType: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "UserOperationRevertReason",
        inputs: [
            { name: "userOpHash", type: "bytes32", indexed: true, internalType: "bytes32" },
            { name: "sender", type: "address", indexed: true, internalType: "address" },
            { name: "nonce", type: "uint256", indexed: false, internalType: "uint256" },
            { name: "revertReason", type: "bytes", indexed: false, internalType: "bytes" },
        ],
        anonymous: false,
    },
] as const;

const MULTICALL3_ABI = [
    {
        type: "function",
        name: "aggregate3Value",
        inputs: [
            {
                name: "calls",
                type: "tuple[]",
                internalType: "struct Call3Value[]",
                components: [
                    { name: "target", type: "address", internalType: "address" },
                    { name: "allowFailure", type: "bool", internalType: "bool" },
                    { name: "value", type: "uint256", internalType: "uint256" },
                    { name: "callData", type: "bytes", internalType: "bytes" },
                ],
            },
        ],
        outputs: [
            {
                name: "returnData",
                type: "tuple[]",
                internalType: "struct Result[]",
                components: [
                    { name: "success", type: "bool", internalType: "bool" },
                    { name: "returnData", type: "bytes", internalType: "bytes" },
                ],
            },
        ],
        stateMutability: "payable",
    },
] as const;

/** Padded v0.6 gas caps for the session approval UserOperation. */
const SESSION_GAS = {
    callGasLimit: 500_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 100_000n,
} as const;

function EVM_ADDRESS_SCHEMA(field: string) {
    return z.string().regex(/^0x[0-9a-fA-F]{40}$/u, `${field} must be a 0x-prefixed EVM address`);
}

const EVM_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);

const DECIMAL_STRING = z.string().regex(/^\d+$/u, "must be a decimal string");

const HEX_BYTES = z.string().regex(/^0x[0-9a-fA-F]*$/u, "must be 0x-prefixed hex bytes");

const ACCOUNT_CREATE_REQUEST_SCHEMA = z.object({
    owner: EVM_ADDRESS_SCHEMA("owner"),
    account: EVM_ADDRESS_SCHEMA("account"),
}).strict();

const SESSION_USER_OPERATION_SCHEMA = z.object({
    sender: EVM_ADDRESS,
    nonce: DECIMAL_STRING,
    initCode: HEX_BYTES,
    callData: HEX_BYTES,
    callGasLimit: DECIMAL_STRING,
    verificationGasLimit: DECIMAL_STRING,
    preVerificationGas: DECIMAL_STRING,
    maxFeePerGas: DECIMAL_STRING,
    maxPriorityFeePerGas: DECIMAL_STRING,
    paymasterAndData: HEX_BYTES,
    signature: HEX_BYTES,
}).strict();

const SESSION_PREPARE_REQUEST_SCHEMA = z.object({
    owner: EVM_ADDRESS,
    account: EVM_ADDRESS,
    /** Session budget to approve, in asset base units (wei). */
    amount: DECIMAL_STRING,
}).strict();

const SESSION_SUBMIT_REQUEST_SCHEMA = z.object({
    owner: EVM_ADDRESS,
    account: EVM_ADDRESS,
    userOperation: SESSION_USER_OPERATION_SCHEMA,
}).strict();

/** Upper bound for waiting on the creation transaction receipt. */
const RECEIPT_TIMEOUT_MS = 45_000;

export interface BotchainAccountCreateResult {
    statusCode: number;
    body: {
        status?: "ready" | "pending";
        account?: string;
        transactionHash?: string;
        error?: string;
    };
}

function errorResult(statusCode: number, error: string, transactionHash?: Hash): BotchainAccountCreateResult {
    return {
        statusCode,
        body: { error, ...(transactionHash ? { transactionHash } : {}) },
    };
}

function getMerchantAccount() {
    const privateKey = process.env.FACILITATOR_KEY?.trim();
    if (!privateKey) {
        throw new Error("FACILITATOR_KEY environment variable is required for Botchain account creation");
    }
    return privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`);
}

function clients() {
    const chain = getViemChain(NETWORK_IDS.botchain);
    const rpcUrl = getNetworkRpcUrl(NETWORK_IDS.botchain);
    const account = getMerchantAccount();
    return {
        chain,
        account,
        publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
        walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    };
}

/**
 * POST /api/botchain/account/create
 *
 * Body: `{ owner, account }` — both lowercase EVM addresses. `account` must
 * match the Thirdweb v0.6 factory prediction for `owner` with empty salt.
 *
 * - 200 `{ status: "ready", account, transactionHash? }` — account deployed
 *   (either already on entry, or created and mined by this request).
 * - 202 `{ status: "pending", account, transactionHash }` — creation
 *   transaction broadcast but not yet mined within the wait window.
 * - 400 `{ error }` — malformed body or owner/account prediction mismatch.
 * - 503 `{ error }` — chain/RPC or creation-transaction failure.
 */
export async function createBotchainAccount(rawBody: string | undefined): Promise<BotchainAccountCreateResult> {
    let body: unknown;
    try {
        body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
        return errorResult(400, "Request body must be valid JSON");
    }

    const parsed = ACCOUNT_CREATE_REQUEST_SCHEMA.safeParse(body);
    if (!parsed.success) {
        return errorResult(400, parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    const { owner, account } = parsed.data;
    const ownerAddress = owner.toLowerCase() as `0x${string}`;
    const accountAddress = account.toLowerCase() as `0x${string}`;

    try {
        const { chain, account: merchant, publicClient, walletClient } = clients();

        const predicted = await publicClient.readContract({
            address: THIRDWEB_ACCOUNT_FACTORY_V0_6,
            abi: FACTORY_ABI,
            functionName: "getAddress",
            args: [ownerAddress, "0x"],
        });
        if (predicted.toLowerCase() !== accountAddress) {
            return errorResult(
                400,
                "account does not match the Thirdweb account factory prediction for owner",
            );
        }

        const deployedCode = await publicClient.getCode({ address: accountAddress });
        if (deployedCode) {
            const isAdmin = await publicClient.readContract({
                address: accountAddress,
                abi: ACCOUNT_ABI,
                functionName: "isAdmin",
                args: [ownerAddress],
            });
            if (!isAdmin) {
                return errorResult(503, "Account is deployed but the owner is not its admin");
            }
            return {
                statusCode: 200,
                body: { status: "ready", account: accountAddress },
            };
        }

        const transactionHash = await walletClient.writeContract({
            address: THIRDWEB_ACCOUNT_FACTORY_V0_6,
            abi: FACTORY_ABI,
            functionName: "createAccount",
            args: [ownerAddress, "0x"],
            account: merchant,
            chain,
        });

        try {
            const receipt = await publicClient.waitForTransactionReceipt({
                hash: transactionHash,
                timeout: RECEIPT_TIMEOUT_MS,
            });
            if (receipt.status !== "success") {
                console.error("[botchain/account/create] Creation transaction reverted:", transactionHash);
                return errorResult(503, "Account creation transaction reverted", transactionHash);
            }
            return {
                statusCode: 200,
                body: { status: "ready", account: accountAddress, transactionHash },
            };
        } catch (error) {
            console.error("[botchain/account/create] Receipt wait failed:", error);
            return {
                statusCode: 202,
                body: { status: "pending", account: accountAddress, transactionHash },
            };
        }
    } catch (error) {
        console.error("[botchain/account/create] Error:", error);
        return errorResult(503, error instanceof Error ? error.message : "Botchain account creation failed");
    }
}

// =============================================================================
// Session approval relay (ERC-4337 v0.6, merchant-paid, no paymaster)
// =============================================================================

export interface BotchainSessionEndpointResult {
    statusCode: number;
    body: {
        userOp?: Record<string, string>;
        userOpHash?: string;
        entryPoint?: string;
        transactionHash?: string;
        success?: boolean;
        status?: "pending";
        reason?: string;
        error?: string;
    };
}

function sessionError(statusCode: number, error: string): BotchainSessionEndpointResult {
    return { statusCode, body: { error } };
}

class SessionIntentError extends Error {}

/** The session allowance spender the server settles against (treasury). */
function sessionAllowanceSpender(): `0x${string}` {
    try {
        return resolveSessionAllowanceSpenderAddress().toLowerCase() as `0x${string}`;
    } catch {
        throw new SessionIntentError("Session allowance spender configuration is unavailable");
    }
}

function usdtAsset(): `0x${string}` {
    return getNetwork(NETWORK_IDS.botchain).asset.address.toLowerCase() as `0x${string}`;
}

/**
 * Encode the full session approval call the smart account must execute:
 * `execute(USDT, 0, approve(session allowance spender, amount))`.
 * The facilitator owns the token, the spender, and the intent — the client
 * only supplies the amount.
 */
function encodeSessionApproveCallData(amount: bigint): Hex {
    return encodeFunctionData({
        abi: ACCOUNT_EXECUTE_ABI,
        functionName: "execute",
        args: [
            usdtAsset(),
            0n,
            encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [sessionAllowanceSpender(), amount],
            }),
        ],
    });
}

/** Decode the account's `execute(target, value, calldata)` wrapper. */
function decodeAccountExecute(callData: string): { target: `0x${string}`; value: bigint; innerData: string } {
    const decoded = decodeFunctionData({ abi: ACCOUNT_EXECUTE_ABI, data: callData as Hex });
    if (decoded.functionName !== "execute" || decoded.args.length !== 3) {
        throw new SessionIntentError("user operation callData is not an account execute call");
    }
    const [target, value, innerData] = decoded.args as [`0x${string}`, bigint, string];
    return { target: target.toLowerCase() as `0x${string}`, value, innerData };
}

/** Validate the executed intent inside a session UserOperation. */
function requireSessionUserOperationIntent(callData: string): void {
    const executed = decodeAccountExecute(callData);
    if (executed.target !== usdtAsset()) {
        throw new SessionIntentError("session approval target must be the Botchain USDT asset");
    }
    if (executed.value !== 0n) {
        throw new SessionIntentError("session approval must not transfer value");
    }
    const decoded = decodeFunctionData({ abi: erc20Abi, data: executed.innerData as Hex });
    if (decoded.functionName !== "approve" || decoded.args.length !== 2) {
        throw new SessionIntentError("session approval inner call is not an ERC-20 approve");
    }
    const [spender] = decoded.args as [`0x${string}`, bigint];
    if (spender.toLowerCase() !== sessionAllowanceSpender()) {
        throw new SessionIntentError("session approval spender must be the session allowance spender");
    }
}

/** Verify the factory prediction for `owner` matches `account` and the account is deployed. */
async function requireMatchingDeployedAccount(
    publicClient: ReturnType<typeof createPublicClient>,
    owner: `0x${string}`,
    account: `0x${string}`,
): Promise<void> {
    const predicted = await publicClient.readContract({
        address: THIRDWEB_ACCOUNT_FACTORY_V0_6,
        abi: FACTORY_ABI,
        functionName: "getAddress",
        args: [owner, "0x"],
    });
    if (predicted.toLowerCase() !== account) {
        throw new SessionIntentError("account does not match the Thirdweb account factory prediction for owner");
    }
    const deployedCode = await publicClient.getCode({ address: account });
    if (!deployedCode) {
        throw new SessionIntentError("smart account is not deployed on Botchain yet; retry after account creation completes");
    }
}

function parseSessionBody(rawBody: string | undefined): unknown {
    try {
        return rawBody ? JSON.parse(rawBody) : {};
    } catch {
        throw new SessionIntentError("Request body must be valid JSON");
    }
}

/**
 * POST /api/botchain/session/prepare
 *
 * Body: `{ owner, account, amount }` — the session budget in asset base
 * units. The facilitator owns the approval intent (Botchain USDT asset,
 * session allowance spender) and encodes the full account call itself.
 * Returns the v0.6 UserOperation (empty signature, no paymaster) and its
 * hash computed by the deployed EntryPoint — the admin wallet signs that
 * hash off-chain.
 */
export async function prepareBotchainSessionApproval(
    rawBody: string | undefined,
): Promise<BotchainSessionEndpointResult> {
    try {
        const parsed = SESSION_PREPARE_REQUEST_SCHEMA.safeParse(parseSessionBody(rawBody));
        if (!parsed.success) {
            return sessionError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
        }
        const owner = parsed.data.owner.toLowerCase() as `0x${string}`;
        const account = parsed.data.account.toLowerCase() as `0x${string}`;
        const amount = BigInt(parsed.data.amount);
        if (amount <= 0n) {
            return sessionError(400, "amount must be greater than zero");
        }

        const { publicClient } = clients();
        await requireMatchingDeployedAccount(publicClient, owner, account);

        const [nonce, gasPrice] = await Promise.all([
            publicClient.readContract({
                address: ENTRY_POINT_V0_6,
                abi: ENTRY_POINT_ABI,
                functionName: "getNonce",
                args: [account, 0n],
            }),
            publicClient.getGasPrice(),
        ]);

        const userOp = {
            sender: account,
            nonce: nonce as bigint,
            initCode: "0x" as Hex,
            callData: encodeSessionApproveCallData(amount),
            callGasLimit: SESSION_GAS.callGasLimit,
            verificationGasLimit: SESSION_GAS.verificationGasLimit,
            preVerificationGas: SESSION_GAS.preVerificationGas,
            maxFeePerGas: gasPrice * 2n,
            maxPriorityFeePerGas: gasPrice / 2n,
            paymasterAndData: "0x" as Hex,
            signature: "0x" as Hex,
        };

        const userOpHash = await publicClient.readContract({
            address: ENTRY_POINT_V0_6,
            abi: ENTRY_POINT_ABI,
            functionName: "getUserOpHash",
            args: [userOp],
        });

        return {
            statusCode: 200,
            body: {
                userOp: {
                    sender: userOp.sender,
                    nonce: userOp.nonce.toString(),
                    initCode: userOp.initCode,
                    callData: userOp.callData,
                    callGasLimit: userOp.callGasLimit.toString(),
                    verificationGasLimit: userOp.verificationGasLimit.toString(),
                    preVerificationGas: userOp.preVerificationGas.toString(),
                    maxFeePerGas: userOp.maxFeePerGas.toString(),
                    maxPriorityFeePerGas: userOp.maxPriorityFeePerGas.toString(),
                    paymasterAndData: userOp.paymasterAndData,
                },
                userOpHash: userOpHash as string,
                entryPoint: ENTRY_POINT_V0_6,
            },
        };
    } catch (error) {
        if (error instanceof SessionIntentError) return sessionError(400, error.message);
        console.error("[botchain/session/prepare] Error:", error);
        return sessionError(503, error instanceof Error ? error.message : "Botchain session prepare failed");
    }
}

function decodeRevertReason(bytes: string | undefined): string | undefined {
    if (!bytes || bytes === "0x") return undefined;
    try {
        return hexToString(bytes as Hex);
    } catch {
        return bytes;
    }
}

/**
 * POST /api/botchain/session/submit
 *
 * Body: `{ owner, account, userOperation }` with the admin's signature. The
 * merchant wallet pays one ordinary transaction — exactly like account
 * creation: when the account's EntryPoint gas escrow is short, the same
 * transaction first tops up `depositTo(account)` through Multicall3 and then
 * submits `handleOps`; the unused prefund stays as the account's escrow and
 * actual gas is reimbursed to the merchant beneficiary.
 */
export async function submitBotchainSessionApproval(
    rawBody: string | undefined,
): Promise<BotchainSessionEndpointResult> {
    let owner: `0x${string}`;
    let account: `0x${string}`;
    let userOpInput: {
        sender: string;
        nonce: string;
        initCode: string;
        callData: string;
        callGasLimit: string;
        verificationGasLimit: string;
        preVerificationGas: string;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
        paymasterAndData: string;
        signature: string;
    };
    try {
        const parsed = SESSION_SUBMIT_REQUEST_SCHEMA.safeParse(parseSessionBody(rawBody));
        if (!parsed.success) {
            return sessionError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
        }
        owner = parsed.data.owner.toLowerCase() as `0x${string}`;
        account = parsed.data.account.toLowerCase() as `0x${string}`;
        userOpInput = {
            ...parsed.data.userOperation,
            sender: parsed.data.userOperation.sender.toLowerCase(),
            initCode: parsed.data.userOperation.initCode.toLowerCase(),
            callData: parsed.data.userOperation.callData.toLowerCase(),
            paymasterAndData: parsed.data.userOperation.paymasterAndData.toLowerCase(),
            signature: parsed.data.userOperation.signature.toLowerCase(),
        };

        if (userOpInput.sender !== account) {
            throw new SessionIntentError("user operation sender must match the account");
        }
        if (userOpInput.initCode !== "0x") {
            throw new SessionIntentError("session relay requires an already-deployed account (initCode must be empty)");
        }
        if (userOpInput.paymasterAndData !== "0x") {
            throw new SessionIntentError("session relay must not use a paymaster");
        }
        requireSessionUserOperationIntent(userOpInput.callData);
        await requireMatchingDeployedAccount(clients().publicClient, owner, account);
    } catch (error) {
        if (error instanceof SessionIntentError) return sessionError(400, error.message);
        console.error("[botchain/session/submit] Error:", error);
        return sessionError(503, error instanceof Error ? error.message : "Botchain session submit failed");
    }

    try {
        const { chain, account: merchant, publicClient, walletClient } = clients();

        const currentNonce = await publicClient.readContract({
            address: ENTRY_POINT_V0_6,
            abi: ENTRY_POINT_ABI,
            functionName: "getNonce",
            args: [account, 0n],
        });
        if ((currentNonce as bigint) !== BigInt(userOpInput.nonce)) {
            return sessionError(400, "user operation nonce is stale; prepare again");
        }

        const userOp = {
            sender: account,
            nonce: BigInt(userOpInput.nonce),
            initCode: "0x" as Hex,
            callData: userOpInput.callData as Hex,
            callGasLimit: BigInt(userOpInput.callGasLimit),
            verificationGasLimit: BigInt(userOpInput.verificationGasLimit),
            preVerificationGas: BigInt(userOpInput.preVerificationGas),
            maxFeePerGas: BigInt(userOpInput.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(userOpInput.maxPriorityFeePerGas),
            paymasterAndData: "0x" as Hex,
            signature: userOpInput.signature as Hex,
        };

        // Gas escrow: fund only the shortfall, with a safety buffer. Unused
        // prefund remains on the account's EntryPoint balance for later ops.
        const requiredPrefund =
            (userOp.callGasLimit + userOp.verificationGasLimit + userOp.preVerificationGas) * userOp.maxFeePerGas;
        const escrowTarget = requiredPrefund * 12n / 10n;
        const escrow = await publicClient.readContract({
            address: ENTRY_POINT_V0_6,
            abi: ENTRY_POINT_ABI,
            functionName: "balanceOf",
            args: [account],
        });
        const shortfall = escrowTarget > (escrow as bigint) ? escrowTarget - (escrow as bigint) : 0n;

        const handleOpsCalldata = encodeFunctionData({
            abi: ENTRY_POINT_ABI,
            functionName: "handleOps",
            args: [[userOp], merchant.address],
        });

        let transactionHash: Hash;
        if (shortfall > 0n) {
            const depositToCalldata = encodeFunctionData({
                abi: ENTRY_POINT_ABI,
                functionName: "depositTo",
                args: [account],
            });
            transactionHash = await walletClient.writeContract({
                address: MULTICALL3,
                abi: MULTICALL3_ABI,
                functionName: "aggregate3Value",
                args: [[
                    {
                        target: ENTRY_POINT_V0_6,
                        allowFailure: false,
                        value: shortfall,
                        callData: depositToCalldata,
                    },
                    {
                        target: ENTRY_POINT_V0_6,
                        allowFailure: false,
                        value: 0n,
                        callData: handleOpsCalldata,
                    },
                ]],
                value: shortfall,
                account: merchant,
                chain,
            });
        } else {
            transactionHash = await walletClient.writeContract({
                address: ENTRY_POINT_V0_6,
                abi: ENTRY_POINT_ABI,
                functionName: "handleOps",
                args: [[userOp], merchant.address],
                account: merchant,
                chain,
            });
        }

        let receipt;
        try {
            receipt = await publicClient.waitForTransactionReceipt({
                hash: transactionHash,
                timeout: RECEIPT_TIMEOUT_MS,
            });
        } catch (error) {
            console.error("[botchain/session/submit] Receipt wait failed:", error);
            return {
                statusCode: 202,
                body: { status: "pending", transactionHash },
            };
        }

        if (receipt.status !== "success") {
            console.error("[botchain/session/submit] Relay transaction reverted:", transactionHash);
            return sessionError(503, "Botchain session relay transaction reverted");
        }

        const opEvents = parseEventLogs({
            abi: ENTRY_POINT_ABI,
            logs: receipt.logs,
            eventName: "UserOperationEvent",
        }).filter((event) => event.args.sender.toLowerCase() === account);
        const revertEvents = parseEventLogs({
            abi: ENTRY_POINT_ABI,
            logs: receipt.logs,
            eventName: "UserOperationRevertReason",
        }).filter((event) => event.args.sender.toLowerCase() === account);
        const opEvent = opEvents.at(-1);
        const revertEvent = revertEvents.at(-1);
        if (!opEvent) {
            console.error("[botchain/session/submit] No UserOperationEvent in receipt:", transactionHash);
            return {
                statusCode: 503,
                body: { error: "No UserOperationEvent in the relay receipt", transactionHash },
            };
        }

        return {
            statusCode: 200,
            body: {
                transactionHash,
                success: opEvent.args.success,
                ...(opEvent.args.success ? {} : {
                    reason: decodeRevertReason(revertEvent?.args.revertReason)
                        ?? "session approval user operation reverted",
                }),
            },
        };
    } catch (error) {
        console.error("[botchain/session/submit] Error:", error);
        return sessionError(503, error instanceof Error ? error.message : "Botchain session submit failed");
    }
}
