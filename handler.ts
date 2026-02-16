/**
 * AWS Lambda Handler
 * 
 * Handles non-inference API endpoints:
 * - Account management (Compose Keys, sessions)
 * - Account Abstraction (Cronos)
 * - Backpack/Composio integrations
 * - Model registry queries
 * 
 * All /v1/* endpoints are delegated to backend/lambda/shared/api/gateway.ts
 * using the gateway route matcher.
 * 
 * @module lambda/handler
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";

// Compose Keys
import {
    createComposeKey,
    listUserKeys,
    revokeKey,
    getActiveSession,
} from "./shared/keys/index.js";

import {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    getKeyBudgetInfo,
} from "./shared/keys/middleware.js";

import { settleComposeKeyPayment } from "./shared/x402/settlement.js";
import { getSessionStatus } from "./shared/x402/session-budget.js";

// Account Abstraction
const loadAA = () => import("./shared/aa/index.js");

// Backpack / Composio
const loadBackpack = () => import("./shared/backpack/composio.js");

// Model Registry
const loadRegistry = () => import("./shared/models/registry.js");

// Faucet
const loadFaucet = () => import("./shared/faucet/index.js");

// Inference Gateway (canonical /v1 routing)
import { handleInferenceEvent } from "./shared/inference/gateway.js";

// =============================================================================
// Configuration
// =============================================================================

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Authorization, PAYMENT-SIGNATURE, payment-signature, " +
        "X-PAYMENT, x-payment, x-session-active, x-session-budget-remaining, " +
        "x-session-user-address, x-manowar-internal, x-chain-id, Access-Control-Expose-Headers",
    "Access-Control-Expose-Headers":
        "PAYMENT-RESPONSE, payment-response, x-compose-key-budget-limit, " +
        "x-compose-key-budget-used, x-compose-key-budget-remaining, *",
};

// =============================================================================
// Main Lambda Handler
// =============================================================================

export async function handler(
    event: APIGatewayProxyEventV2,
    _context: Context
): Promise<APIGatewayProxyResultV2> {
    // Handle CORS preflight
    if (event.requestContext.http.method === "OPTIONS") {
        return {
            statusCode: 204,
            headers: corsHeaders,
            body: "",
        };
    }

    const path = event.rawPath;
    const method = event.requestContext.http.method;

    try {
        // ==========================================================================
        // /v1/* is delegated to shared/api/gateway.ts (single source of truth)
        // ==========================================================================

        if (path.startsWith("/v1/")) {
            return await handleInferenceEvent(event);
        }

        // GET /api/pricing - Get pricing table
        if (method === "GET" && path === "/api/pricing") {
            const { DYNAMIC_PRICES } = await import("./shared/x402/pricing.js");
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({ prices: DYNAMIC_PRICES, version: "1.0" }),
            };
        }

        // ==========================================================================
        // Compose Keys API Routes
        // ==========================================================================

        // GET /api/session - Get active session
        if (method === "GET" && path === "/api/session") {
            return handleGetSession(event);
        }

        // POST /api/keys - Create a new Compose Key
        if (method === "POST" && path === "/api/keys") {
            return handleCreateKey(event);
        }

        // GET /api/keys - List user's Compose Keys
        if (method === "GET" && path === "/api/keys") {
            return handleListKeys(event);
        }

        // POST /api/keys/settle - Settle payment using Compose Key
        if (method === "POST" && path === "/api/keys/settle") {
            return handleSettleKeyPayment(event);
        }

        // DELETE /api/keys/:keyId - Revoke a Compose Key
        if (method === "DELETE" && path.startsWith("/api/keys/")) {
            return handleRevokeKey(event);
        }

        // ==========================================================================
        // Account Abstraction API Routes (Cronos)
        // ==========================================================================

        // POST /api/aa/prepare - Prepare UserOperation
        if (method === "POST" && path === "/api/aa/prepare") {
            return handleAAPrepare(event);
        }

        // POST /api/aa/submit - Submit UserOperation
        if (method === "POST" && path === "/api/aa/submit") {
            return handleAASubmit(event);
        }

        // GET /api/aa/nonce/:address - Get Smart Account nonce
        if (method === "GET" && path.match(/^\/api\/aa\/nonce\/0x[a-fA-F0-9]{40}$/)) {
            return handleAANonce(event);
        }

        // POST /api/aa/register-cronos - Register account on Cronos
        if (method === "POST" && path === "/api/aa/register-cronos") {
            return handleAARegister(event);
        }

        // GET /api/aa/predict-address/:adminAddress - Predict Smart Account address
        if (method === "GET" && path.match(/^\/api\/aa\/predict-address\/0x[a-fA-F0-9]{40}$/)) {
            return handleAAPredictAddress(event);
        }

        // ==========================================================================
        // Backpack API Routes (Composio)
        // ==========================================================================

        if (path.startsWith("/api/backpack/")) {
            return handleBackpackRoutes(event);
        }

        // ==========================================================================
        // Dynamic Model Registry Routes
        // ==========================================================================

        if (path.startsWith("/api/registry/")) {
            return handleRegistryRoutes(event);
        }

        // ==========================================================================
        // Faucet API Routes
        // ==========================================================================

        // POST /api/faucet/claim - Claim USDC from faucet
        if (method === "POST" && path === "/api/faucet/claim") {
            return handleFaucetClaim(event);
        }

        // GET /api/faucet/status - Get faucet status for all chains
        if (method === "GET" && path === "/api/faucet/status") {
            return handleFaucetStatus();
        }

        // GET /api/faucet/status/:chainId - Get faucet status for specific chain
        if (method === "GET" && path.match(/^\/api\/faucet\/status\/\d+$/)) {
            return handleFaucetStatusByChain(event);
        }

        // GET /api/faucet/check/:address - Check if address has claimed
        if (method === "GET" && path.match(/^\/api\/faucet\/check\/0x[a-fA-F0-9]{40}$/)) {
            return handleFaucetCheck(event);
        }

        // ==========================================================================
        // Legacy /api/models - Redirect to /v1/models
        // ==========================================================================

        if (method === "GET" && path === "/api/models") {
            const compiled = await loadRegistry();
            const models = compiled.getCompiledModels();
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    object: "list",
                    data: models.models.map((model) => ({
                        id: model.modelId,
                        object: "model",
                        created: typeof model.createdAt === "number" ? model.createdAt : Math.floor(Date.now() / 1000),
                        owned_by: model.ownedBy || model.provider,
                        provider: model.provider,
                    })),
                }),
            };
        }

        // ==========================================================================
        // 404 - Not Found
        // ==========================================================================

        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Not found",
                message: `Route ${method} ${path} not found`,
                hint: "Use /v1/responses for canonical inference requests"
            }),
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[handler] Unhandled error:`, errorMessage);

        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Internal server error",
                message: errorMessage
            }),
        };
    }
}

// =============================================================================
// Scheduled Batch Settlement Handler
// =============================================================================

export async function batchSettlementHandler(
    _event: unknown,
    _context: Context,
): Promise<APIGatewayProxyResultV2> {
    try {
        const { runBatchSettlement } = await import("./shared/x402/accumulator/index.js");
        const summary = await runBatchSettlement();
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(summary),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: message }),
        };
    }
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGetSession(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const userAddress = event.headers["x-session-user-address"];
    const chainIdHeader = event.headers["x-chain-id"];
    const chainId = chainIdHeader ? parseInt(chainIdHeader, 10) : undefined;

    if (!userAddress) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({ error: "x-session-user-address header required" }),
        };
    }

    const session = await getActiveSession(userAddress, chainId);

    if (!session) {
        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({ error: "No active session found", hasSession: false }),
        };
    }

    // Get detailed session status for notifications
    let sessionStatus = null;
    if (chainId) {
        try {
            sessionStatus = await getSessionStatus(userAddress, chainId);
        } catch (e) {
            console.warn(`[handleGetSession] Could not get session status: ${e}`);
        }
    }

    const response: Record<string, any> = {
        hasSession: true,
        keyId: session.keyId,
        token: session.token,
        budgetLimit: session.budgetLimit,
        budgetUsed: session.budgetUsed,
        budgetRemaining: session.budgetRemaining,
        expiresAt: session.expiresAt,
        chainId: session.chainId,
        name: session.name,
    };

    // Add status warnings if available
    if (sessionStatus) {
        response.status = {
            isActive: sessionStatus.isActive,
            isExpired: sessionStatus.isExpired,
            expiresInSeconds: sessionStatus.expiresInSeconds,
            budgetPercentRemaining: sessionStatus.budgetPercentRemaining,
            warnings: sessionStatus.warnings,
        };

        // Add warning headers for frontend
        const headers: Record<string, string> = { ...corsHeaders };

        if (sessionStatus.warnings.budgetDepleted) {
            headers["x-session-status"] = "budget-depleted";
        } else if (sessionStatus.warnings.budgetLow) {
            headers["x-session-status"] = "budget-low";
        } else if (sessionStatus.warnings.expiringSoon) {
            headers["x-session-status"] = "expiring-soon";
        }

        if (sessionStatus.warnings.budgetLow || sessionStatus.warnings.budgetDepleted) {
            headers["x-session-budget-percent"] = String(Math.floor(sessionStatus.budgetPercentRemaining));
        }

        if (sessionStatus.warnings.expiringSoon || sessionStatus.warnings.expired) {
            headers["x-session-expires-in"] = String(sessionStatus.expiresInSeconds);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(response),
        };
    }

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(response),
    };
}

async function handleCreateKey(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const userAddress = event.headers["x-session-user-address"];
    const sessionActive = event.headers["x-session-active"] === "true";

    if (!userAddress || !sessionActive) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Active session required to create Compose Key" }),
        };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    if (!body.budgetLimit || !body.expiresAt) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "budgetLimit and expiresAt are required" }),
        };
    }

    const result = await createComposeKey(userAddress, {
        budgetLimit: body.budgetLimit,
        expiresAt: body.expiresAt,
        name: body.name,
        chainId: body.chainId,
    });

    return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify(result),
    };
}

async function handleListKeys(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const userAddress = event.headers["x-session-user-address"];

    if (!userAddress) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({ error: "x-session-user-address header required" }),
        };
    }

    const keys = await listUserKeys(userAddress);

    const safeKeys = keys.map(k => ({
        keyId: k.keyId,
        budgetLimit: k.budgetLimit,
        budgetUsed: k.budgetUsed,
        budgetRemaining: Math.max(0, k.budgetLimit - k.budgetUsed),
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        name: k.name,
        lastUsedAt: k.lastUsedAt,
    }));

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ keys: safeKeys }),
    };
}

async function handleSettleKeyPayment(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const authHeader = event.headers["authorization"];
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);

    if (!composeKeyToken) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Missing Compose Key in Authorization header" }),
        };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const amountWei = parseInt(body.amount, 10);

    const validation = await validateComposeKey(composeKeyToken, amountWei);
    if (!validation.valid) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({ error: validation.error }),
        };
    }

    const budgetRemaining = validation.record!.budgetLimit - validation.record!.budgetUsed;
    if (budgetRemaining < amountWei) {
        return {
            statusCode: 402,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Budget exhausted", budgetRemaining }),
        };
    }

    const keyChainId = validation.record!.chainId!;
    const result = await settleComposeKeyPayment(validation.payload!.sub, amountWei, keyChainId);

    if (!result.success) {
        return {
            statusCode: 402,
            headers: corsHeaders,
            body: JSON.stringify({ error: result.error }),
        };
    }

    await consumeKeyBudget(validation.payload!.keyId, amountWei);
    const budgetInfo = await getKeyBudgetInfo(validation.payload!.keyId);

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
            success: true,
            txHash: result.txHash,
            budgetRemaining: budgetInfo?.budgetRemaining || 0,
        }),
    };
}

async function handleRevokeKey(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const keyId = event.rawPath.replace("/api/keys/", "");
    const userAddress = event.headers["x-session-user-address"];

    if (!userAddress) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({ error: "x-session-user-address header required" }),
        };
    }

    const success = await revokeKey(keyId, userAddress);

    if (!success) {
        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Key not found or not authorized" }),
        };
    }

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, keyId }),
    };
}

// =============================================================================
// Account Abstraction Handlers
// =============================================================================

async function handleAAPrepare(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const aa = await loadAA();
    const body = event.body ? JSON.parse(event.body) : {};
    const { chainId, smartAccount, to, value, data, adminAddress } = body;

    if (!chainId || !smartAccount || !to || !data) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Missing required fields",
                required: ["chainId", "smartAccount", "to", "data"],
            }),
        };
    }

    try {
        let senderAddress = smartAccount as `0x${string}`;
        if (adminAddress && (chainId === 338 || chainId === 25)) {
            const predictedAddress = await aa.predictAccountAddress(adminAddress, "0x", chainId);
            senderAddress = predictedAddress;
        }

        const deployed = await aa.isAccountDeployed(senderAddress, chainId);

        let initCode: `0x${string}` = "0x";
        if (!deployed) {
            if (!adminAddress) {
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        error: "Account not deployed on this chain",
                        details: "adminAddress is required to deploy Smart Account on Cronos.",
                    }),
                };
            }
            initCode = aa.generateInitCode(adminAddress, "0x", chainId);
        }

        const [nonce, gas] = await Promise.all([
            aa.getNonce(senderAddress, chainId),
            aa.estimateGas(chainId),
        ]);

        const callData = aa.encodeExecute(to, BigInt(value || "0"), data);
        const verificationGasLimit = initCode !== "0x" ? gas.verificationGasLimit * 5n : gas.verificationGasLimit;

        const userOp = {
            sender: senderAddress,
            nonce,
            initCode,
            callData,
            accountGasLimits: aa.packAccountGasLimits(verificationGasLimit, gas.callGasLimit),
            preVerificationGas: gas.preVerificationGas,
            gasFees: aa.packGasFees(gas.maxPriorityFeePerGas, gas.maxFeePerGas),
            paymasterAndData: "0x" as `0x${string}`,
            signature: "0x" as `0x${string}`,
        };

        userOp.paymasterAndData = await aa.buildPaymasterAndData(userOp, chainId);
        const entryPoint = aa.getEntryPointAddress(chainId);
        const userOpHash = aa.getUserOpHash(userOp, entryPoint, chainId);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                userOpHash,
                userOp: {
                    sender: userOp.sender,
                    nonce: userOp.nonce.toString(),
                    initCode: userOp.initCode,
                    callData: userOp.callData,
                    accountGasLimits: userOp.accountGasLimits,
                    preVerificationGas: userOp.preVerificationGas.toString(),
                    gasFees: userOp.gasFees,
                    paymasterAndData: userOp.paymasterAndData,
                },
                accountDeployed: deployed,
                chainId,
            }),
        };
    } catch (error) {
        console.error("[aa/prepare] Error:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Failed to prepare UserOperation",
                details: error instanceof Error ? error.message : String(error),
            }),
        };
    }
}

async function handleAASubmit(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const aa = await loadAA();
    const body = event.body ? JSON.parse(event.body) : {};
    const { chainId, smartAccount, signature, preparedUserOp, to, value, data, adminAddress } = body;

    if (!chainId || !smartAccount || !signature) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Missing required fields",
                required: ["chainId", "smartAccount", "signature"],
            }),
        };
    }

    try {
        let userOp;

        if (preparedUserOp) {
            userOp = {
                sender: preparedUserOp.sender as `0x${string}`,
                nonce: BigInt(preparedUserOp.nonce),
                initCode: preparedUserOp.initCode as `0x${string}`,
                callData: preparedUserOp.callData as `0x${string}`,
                accountGasLimits: preparedUserOp.accountGasLimits as `0x${string}`,
                preVerificationGas: BigInt(preparedUserOp.preVerificationGas),
                gasFees: preparedUserOp.gasFees as `0x${string}`,
                paymasterAndData: (preparedUserOp.paymasterAndData || "0x") as `0x${string}`,
                signature: signature as `0x${string}`,
            };
        } else {
            // Legacy flow
            if (!to || !data) {
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        error: "Missing required fields for legacy flow",
                        required: ["to", "data"],
                    }),
                };
            }

            const deployed = await aa.isAccountDeployed(smartAccount, chainId);

            let initCode: `0x${string}` = "0x";
            if (!deployed) {
                if (!adminAddress) {
                    return {
                        statusCode: 400,
                        headers: corsHeaders,
                        body: JSON.stringify({
                            error: "Account not deployed on this chain",
                            details: "adminAddress is required to deploy Smart Account",
                        }),
                    };
                }
                initCode = aa.generateInitCode(adminAddress, "0x", chainId);
            }

            const [nonce, gas] = await Promise.all([
                aa.getNonce(smartAccount, chainId),
                aa.estimateGas(chainId),
            ]);

            const callData = aa.encodeExecute(to, BigInt(value || "0"), data);
            const verificationGasLimit = initCode !== "0x" ? gas.verificationGasLimit * 3n : gas.verificationGasLimit;

            userOp = {
                sender: smartAccount as `0x${string}`,
                nonce,
                initCode,
                callData,
                accountGasLimits: aa.packAccountGasLimits(verificationGasLimit, gas.callGasLimit),
                preVerificationGas: gas.preVerificationGas,
                gasFees: aa.packGasFees(gas.maxPriorityFeePerGas, gas.maxFeePerGas),
                paymasterAndData: "0x" as `0x${string}`,
                signature: signature as `0x${string}`,
            };

            userOp.paymasterAndData = await aa.buildPaymasterAndData(userOp, chainId);
        }

        const result = await aa.submitUserOperation(userOp, chainId);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                success: true,
                txHash: result.txHash,
                userOp: {
                    sender: userOp.sender,
                    nonce: userOp.nonce.toString(),
                },
            }),
        };
    } catch (error) {
        console.error("[aa/submit] Error:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Failed to submit transaction",
                details: error instanceof Error ? error.message : String(error),
            }),
        };
    }
}

async function handleAANonce(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const aa = await loadAA();
    const address = event.rawPath.split("/api/aa/nonce/")[1] as `0x${string}`;
    const chainId = parseInt(event.queryStringParameters?.chainId || "338", 10);

    try {
        const nonce = await aa.getNonce(address, chainId);
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ address, chainId, nonce: nonce.toString() }),
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: String(error) }),
        };
    }
}

async function handleAARegister(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const aa = await loadAA();
    const body = event.body ? JSON.parse(event.body) : {};
    const { adminAddress } = body;

    if (!adminAddress) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "adminAddress required" }),
        };
    }

    try {
        const result = await aa.registerAccountOnCronos(adminAddress);

        if (!result.success) {
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: result.error }),
            };
        }

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                success: true,
                accountAddress: result.accountAddress,
                txHash: result.txHash,
            }),
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: String(error) }),
        };
    }
}

async function handleAAPredictAddress(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const aa = await loadAA();
    const adminAddress = event.rawPath.split("/api/aa/predict-address/")[1] as `0x${string}`;
    const chainId = parseInt(event.queryStringParameters?.chainId || "338", 10);

    try {
        const address = await aa.getPredictedAccountAddress(adminAddress, chainId);
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ adminAddress, chainId, predictedAddress: address }),
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: String(error) }),
        };
    }
}

// =============================================================================
// Backpack Routes Handler
// =============================================================================

async function handleBackpackRoutes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const bp = await loadBackpack();
    const path = event.rawPath;
    const method = event.requestContext.http.method;

    try {
        // POST /api/backpack/connect
        if (path === "/api/backpack/connect" && method === "POST") {
            const body = event.body ? JSON.parse(event.body) : {};
            if (!body.userId || !body.toolkit) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId and toolkit required" }) };
            }
            const result = await bp.initiateConnection(body.userId, body.toolkit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
        }

        // GET /api/backpack/connections
        if (path === "/api/backpack/connections" && method === "GET") {
            const userId = event.queryStringParameters?.userId;
            if (!userId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId required" }) };
            }
            const connections = await bp.listConnections(userId);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ connections }) };
        }

        // GET /api/backpack/status/:toolkit
        if (path.startsWith("/api/backpack/status/") && method === "GET") {
            const toolkit = decodeURIComponent(path.replace("/api/backpack/status/", ""));
            const userId = event.queryStringParameters?.userId;
            if (!userId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId required" }) };
            }
            const status = await bp.checkConnection(userId, toolkit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkit, ...status }) };
        }

        // POST /api/backpack/disconnect
        if (path === "/api/backpack/disconnect" && method === "POST") {
            const body = event.body ? JSON.parse(event.body) : {};
            if (!body.userId || !body.toolkit) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId and toolkit required" }) };
            }
            const result = await bp.disconnectToolkit(body.userId, body.toolkit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
        }

        // GET /api/backpack/toolkits
        if (path === "/api/backpack/toolkits" && method === "GET") {
            const search = event.queryStringParameters?.search || "";
            const limit = parseInt(event.queryStringParameters?.limit || "20", 10);
            const toolkits = await bp.searchToolkits(search, limit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkits }) };
        }

        // POST /api/backpack/telegram/link
        if (path === "/api/backpack/telegram/link" && method === "POST") {
            const body = event.body ? JSON.parse(event.body) : {};
            if (!body.userId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId required" }) };
            }
            const result = await bp.initiateTelegramLink(body.userId);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
        }

        // GET /api/backpack/telegram/status
        if (path === "/api/backpack/telegram/status" && method === "GET") {
            const userId = event.queryStringParameters?.userId;
            if (!userId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId required" }) };
            }
            const status = await bp.checkTelegramBinding(userId);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkit: "telegram", ...status }) };
        }

        // POST /api/backpack/webhook/telegram
        if (path === "/api/backpack/webhook/telegram" && method === "POST") {
            const update = event.body ? JSON.parse(event.body) : {};
            const result = await bp.handleTelegramWebhook(update);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, ...result }) };
        }

        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[backpack] Error:", message);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: message }) };
    }
}

// =============================================================================
// Registry Routes Handler
// =============================================================================

async function handleRegistryRoutes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const registry = await loadRegistry();
    const path = event.rawPath;
    const method = event.requestContext.http.method;
    const query = event.queryStringParameters || {};

    // GET /api/registry/debug
    if (path === "/api/registry/debug" && method === "GET") {
        const data = await registry.getModelRegistry();
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                totalModels: data.models.length,
                sources: data.sources,
                lastUpdated: data.lastUpdated,
                environment: {
                    cwd: process.cwd(),
                    nodeVersion: process.version,
                    platform: process.platform,
                },
            }),
        };
    }

    // GET /api/registry/models
    if (path === "/api/registry/models" && method === "GET") {
        const data = await registry.getModelRegistry();
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(data),
        };
    }

    // GET /api/registry/models/available
    if (path === "/api/registry/models/available" && method === "GET") {
        const forceRefresh = query.refresh === "true";
        const page = Math.max(1, parseInt(query.page || "1", 10));
        const limit = Math.min(500, Math.max(1, parseInt(query.limit || "100", 10)));
        const offset = (page - 1) * limit;

        let allModels = forceRefresh
            ? (await registry.refreshRegistry()).models
            : await registry.getAvailableModels();

        // Apply filters
        if (query.provider) {
            allModels = allModels.filter((m: any) => m.provider === query.provider);
        }
        if (query.task) {
            allModels = allModels.filter((m: any) => m.taskType === query.task);
        }
        if (query.search) {
            const searchQuery = query.search.toLowerCase();
            allModels = allModels.filter((m: any) =>
                m.modelId.toLowerCase().includes(searchQuery) ||
                m.name.toLowerCase().includes(searchQuery)
            );
        }

        const paginated = allModels.slice(offset, offset + limit);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                models: paginated,
                total: allModels.length,
                page,
                limit,
                totalPages: Math.ceil(allModels.length / limit),
                hasMore: offset + limit < allModels.length,
            }),
        };
    }

    // GET /api/registry/models/:source
    const sourceMatch = path.match(/^\/api\/registry\/models\/(huggingface|asi-one|asi-cloud|openai|anthropic|google|openrouter|aiml)$/);
    if (sourceMatch && method === "GET") {
        const source = sourceMatch[1] as any;
        const sourceModels = await registry.getModelsBySource(source);
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ source, models: sourceModels, total: sourceModels.length }),
        };
    }

    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
}

// =============================================================================
// Faucet Route Handlers
// =============================================================================

async function handleFaucetClaim(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) : {};
    const { address, chainId } = body;

    if (!address || !chainId) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "address and chainId are required" }),
        };
    }

    if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Invalid address format" }),
        };
    }

    const faucet = await loadFaucet();
    const result = await faucet.claimFaucetUSDC({ address, chainId });

    const statusCode = result.success
        ? 200
        : result.alreadyClaimed
            ? 409
            : 500;

    return {
        statusCode,
        headers: corsHeaders,
        body: JSON.stringify(result),
    };
}

async function handleFaucetStatus(): Promise<APIGatewayProxyResultV2> {
    const faucet = await loadFaucet();
    const statuses = await faucet.getAllFaucetStatuses();

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
            faucets: statuses,
            claimAmount: 1_000_000,
            claimAmountFormatted: "$1.00 USDC",
            maxClaims: 1000,
        }),
    };
}

async function handleFaucetStatusByChain(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const chainId = parseInt(event.rawPath.split("/api/faucet/status/")[1], 10);

    const faucet = await loadFaucet();
    const result = await faucet.checkFaucetAvailable(chainId);

    return {
        statusCode: result.available ? 200 : 404,
        headers: corsHeaders,
        body: JSON.stringify(result),
    };
}

async function handleFaucetCheck(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const address = event.rawPath.split("/api/faucet/check/")[1] as `0x${string}`;

    const faucet = await loadFaucet();
    const status = await faucet.getGlobalClaimStatus(address);

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
            address,
            hasClaimed: status.claimed,
            claimedOnChain: status.chainId,
            claimedOnChainName: status.chainName,
            claimedAt: status.claimedAt,
        }),
    };
}
