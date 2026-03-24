/**
 * Cloud Run Handler
 *
 * Handles non-inference API endpoints:
 * - Account management (Compose Keys, sessions)
 * - Compose x402 facilitator
 * - Backpack/Composio integrations
 * - Model registry queries
 */

import type { Application, NextFunction, Request, Response, RequestHandler } from "express";
import { createPublicClient, http } from "viem";

// Define types locally - Cloud Run uses Express request/response via mock pattern
interface APIGatewayProxyEventV2 {
    rawPath: string;
    requestContext: { http: { method: string } };
    headers: Record<string, string | undefined>;
    body?: string;
    queryStringParameters?: Record<string, string>;
    pathParameters?: Record<string, string>;
}

interface APIGatewayProxyResultV2 {
    statusCode: number;
    headers?: Record<string, string>;
    body: string;
    isBase64Encoded?: boolean;
}

type Context = Record<string, unknown>;

// Compose Keys
import {
    createComposeKey,
    listUserKeys,
    revokeKey,
    getActiveSessionStatus,
} from "./x402/keys/index.js";
import type { SessionInactiveReason } from "./x402/keys/types.js";

import {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    getKeyBudgetInfo,
} from "./x402/keys/middleware.js";

import { initializeSessionBudget } from "./x402/session-budget.js";
import { handleLocalNetworkRoute } from "./local/network.js";
import { handleLocalSynapseRoute } from "./local/paymaster.js";
import { handlePublicRoute, registerWorkflowRoutes } from "./routes.js";
import { buildResolvedSettlementMeter, resolveBillingModel } from "./x402/metering.js";
import type { UnifiedModality, UnifiedUsage } from "./inference/core.js";
import type { BillingMediaEvidence } from "./inference/telemetry.js";
import {
    authorizePaymentIntent,
    abortPaymentIntent,
    settlePaymentIntent,
} from "./x402/intents.js";
import { merchantWalletAddress } from "./x402/wallets.js";
import { getActiveChainId, getViemChain, getUsdcAddress, getRpcUrl } from "./x402/configs/chains.js";
import {
    getComposeFacilitatorSupported,
    parseComposeFacilitatorSettleRequest,
    parseComposeFacilitatorVerifyRequest,
    settleComposePayment,
    verifyComposePayment,
} from "./x402/facilitator.js";

// Backpack / Composio
const loadBackpack = () => import("./backpack/composio.js");
const loadBackpackPermissions = () => import("./backpack/backpack.js");

// Model Registry
const loadRegistry = () => import("./inference/modelsRegistry.js");

// Dispenser
const loadDispenser = () => import("./dispenser/index.js");

// =============================================================================
// Configuration
// =============================================================================

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Authorization, PAYMENT-SIGNATURE, payment-signature, " +
        "x-session-active, x-session-budget-remaining, " +
        "x-session-user-address, x-network-internal, x-chain-id, x-payment-intent-id, Access-Control-Expose-Headers",
    "Access-Control-Expose-Headers":
        "PAYMENT-REQUIRED, payment-required, PAYMENT-RESPONSE, payment-response, x-compose-key-budget-limit, " +
        "x-compose-key-budget-used, x-compose-key-budget-reserved, x-compose-key-budget-remaining, " +
        "x-session-budget-limit, x-session-budget-used, x-session-budget-locked, x-session-budget-remaining, " +
        "x-session-status, x-session-expires-in, x-session-budget-percent, x-compose-session-invalid, x-payment-intent-id, *",
};

function buildInactiveSessionPayload(reason: SessionInactiveReason): {
    hasSession: false;
    reason: SessionInactiveReason;
} {
    return {
        hasSession: false,
        reason,
    };
}

function parsePositiveIntegerInput(value: unknown, fieldName: string): number {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }

    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }

    throw new Error(`${fieldName} must be a positive integer`);
}

async function hasSufficientSessionAllowance(input: {
    userAddress: string;
    chainId: number;
    minimumBudgetWei: number;
}): Promise<boolean> {
    const chain = getViemChain(input.chainId);
    const usdcAddress = getUsdcAddress(input.chainId);
    const rpcUrl = getRpcUrl(input.chainId);

    if (!chain || !usdcAddress) {
        throw new Error(`Unsupported chain for session creation: ${input.chainId}`);
    }

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });

    const currentAllowance = await publicClient.readContract({
        address: usdcAddress,
        abi: [{
            name: "allowance",
            type: "function",
            inputs: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
            ],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
        }] as const,
        functionName: "allowance",
        args: [
            input.userAddress as `0x${string}`,
            merchantWalletAddress,
        ],
    });

    return currentAllowance >= BigInt(input.minimumBudgetWei);
}

function getHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
    const normalized = name.toLowerCase();
    for (const [key, value] of Object.entries(event.headers || {})) {
        if (key.toLowerCase() === normalized) {
            return value;
        }
    }
    return undefined;
}

function normalizeWallet(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function requireUserAddressHeader(event: APIGatewayProxyEventV2): string {
    const userAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!userAddress) {
        throw new Error("x-session-user-address header required");
    }
    return userAddress;
}

function requireChainIdHeader(event: APIGatewayProxyEventV2): number {
    const chainIdRaw = getHeader(event, "x-chain-id");
    const chainId = chainIdRaw ? Number.parseInt(chainIdRaw, 10) : Number.NaN;
    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error("x-chain-id header required");
    }
    return chainId;
}

async function generateDecorativeImage(prompt: string, size: string): Promise<string> {
    const modelId = "black-forest-labs/FLUX.1-schnell";
    const [{ normalizeResponsesRequest }, { invokeAdapter }, { getModelById }] = await Promise.all([
        import("./inference/core.js"),
        import("./inference/providers/adapter.js"),
        import("./inference/modelsRegistry.js"),
    ]);

    const card = getModelById(modelId);
    if (!card) {
        throw new Error(`Model not found: ${modelId}`);
    }

    const unified = normalizeResponsesRequest({
        model: modelId,
        input: [{ type: "input_text", text: prompt }],
        modalities: ["image"],
        size,
        n: 1,
    });

    const output = (await invokeAdapter(unified, { modelId, provider: card.provider })).output;
    if (!output.media) {
        throw new Error("Image generation returned no media");
    }

    if (output.media.base64) {
        return `data:${output.media.mimeType};base64,${output.media.base64}`;
    }
    if (output.media.url) {
        return output.media.url;
    }

    throw new Error("Image generation returned no image payload");
}

function buildApiEvent(req: Request): APIGatewayProxyEventV2 {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
    }

    const method = req.method.toUpperCase();
    const canHaveBody = !["GET", "HEAD", "OPTIONS"].includes(method);
    let body: string | undefined;
    const rawBody = (req as Request & { rawBody?: unknown }).rawBody;

    if (canHaveBody) {
        if (Buffer.isBuffer(rawBody)) {
            body = rawBody.toString("utf-8");
        } else if (typeof rawBody === "string") {
            body = rawBody;
        } else if (typeof req.body === "string") {
            body = req.body;
        } else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
            body = JSON.stringify(req.body);
        }
    }

    const queryIndex = req.originalUrl.indexOf("?");
    let queryStringParameters: Record<string, string> | undefined;
    if (queryIndex !== -1) {
        const params = new URLSearchParams(req.originalUrl.slice(queryIndex + 1));
        const parsed: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
            if (!(key in parsed)) {
                parsed[key] = value;
            }
        }
        if (Object.keys(parsed).length > 0) {
            queryStringParameters = parsed;
        }
    }

    return {
        rawPath: queryIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, queryIndex),
        requestContext: { http: { method } },
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(queryStringParameters ? { queryStringParameters } : {}),
    };
}

async function delegateExpressToApiHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const result = await handler(buildApiEvent(req), {});

        if (result.headers) {
            for (const [key, value] of Object.entries(result.headers)) {
                if (value !== undefined) {
                    res.setHeader(key, value);
                }
            }
        }

        res.status(result.statusCode);
        if (result.isBase64Encoded) {
            res.send(Buffer.from(result.body || "", "base64"));
            return;
        }

        res.send(result.body ?? "");
    } catch (error) {
        next(error);
    }
}

function expressApiHandler(): RequestHandler {
    return (req, res, next) => {
        void delegateExpressToApiHandler(req, res, next);
    };
}

export function registerHandlerRoutes(app: Application): void {
    const routeHandler = expressApiHandler();

    registerWorkflowRoutes(app);

    app.get("/health", routeHandler);
    app.get("/api/models", routeHandler);
    app.get("/agents", routeHandler);
    app.get(/^\/agent\/0x[a-fA-F0-9]{40}$/, routeHandler);
    app.get("/workflows", routeHandler);
    app.get(/^\/workflow\/0x[a-fA-F0-9]{40}$/, routeHandler);

    app.get("/api/pricing", routeHandler);

    app.post("/api/payments/prepare", routeHandler);
    app.post("/api/payments/settle", routeHandler);
    app.post("/api/payments/abort", routeHandler);
    app.post("/api/payments/meter/model", routeHandler);
    app.get("/api/x402/facilitator/supported", routeHandler);
    app.post("/api/x402/facilitator/verify", routeHandler);
    app.post("/api/x402/facilitator/settle", routeHandler);

    app.get("/api/session", routeHandler);
    app.post("/api/keys", routeHandler);
    app.get("/api/keys", routeHandler);
    app.post("/api/keys/settle", routeHandler);
    app.delete(/^\/api\/keys\/[^/]+$/, routeHandler);

    app.use("/api/backpack", routeHandler);
    app.use("/api/registry", routeHandler);
    app.post("/api/local/link-token", routeHandler);
    app.post("/api/local/link-token/redeem", routeHandler);
    app.post("/api/local/deployments/register", routeHandler);
    app.post("/api/local/synapse/session", routeHandler);
    app.get("/api/local/updates/config", routeHandler);
    app.get(/^\/api\/local\/updates\/[^/]+\/[^/]+\/[^/]+$/, routeHandler);
    app.post("/api/local/network/peers/upsert", routeHandler);
    app.get("/api/local/network/peers", routeHandler);

    app.post("/api/dispenser/claim", routeHandler);
    app.get("/api/dispenser/status", routeHandler);
    app.get(/^\/api\/dispenser\/status\/\d+$/, routeHandler);
    app.get(/^\/api\/dispenser\/check\/0x[a-fA-F0-9]{40}$/, routeHandler);

    app.post("/api/settlement/batch", routeHandler);
    app.get("/api/settlement/status", routeHandler);

    app.post("/api/generate-avatar", routeHandler);
    app.post("/api/generate-banner", routeHandler);

}

// =============================================================================
// Main APIs Handler
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
        // GET /api/pricing - Get pricing table
        if (method === "GET" && path === "/api/pricing") {
            const { getCompiledModels } = await loadRegistry();
            const models = getCompiledModels().models
                .filter((model) => model.pricing)
                .map((model) => ({
                    modelId: model.modelId,
                    provider: model.provider,
                    pricing: model.pricing,
                }));
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({ models, version: "2.0" }),
            };
        }

        const publicRouteResult = await handlePublicRoute(event, corsHeaders);
        if (publicRouteResult) {
            return publicRouteResult;
        }

        const localSynapseRouteResult = await handleLocalSynapseRoute(event, corsHeaders);
        if (localSynapseRouteResult) {
            return localSynapseRouteResult;
        }

        if (method === "POST" && path === "/api/payments/prepare") {
            return handlePreparePaymentIntent(event);
        }

        if (method === "POST" && path === "/api/payments/settle") {
            return handleSettlePaymentIntent(event);
        }

        if (method === "POST" && path === "/api/payments/abort") {
            return handleAbortPaymentIntent(event);
        }

        if (method === "POST" && path === "/api/payments/meter/model") {
            return handleMeterModelPayment(event);
        }

        if (method === "GET" && path === "/api/x402/facilitator/supported") {
            return handleComposeFacilitatorSupported();
        }

        if (method === "POST" && path === "/api/x402/facilitator/verify") {
            return handleComposeFacilitatorVerify(event);
        }

        if (method === "POST" && path === "/api/x402/facilitator/settle") {
            return handleComposeFacilitatorSettle(event);
        }

        // ==========================================================================
        // Compose Keys API Routes
        // ==========================================================================

        // GET /api/session - Get active session
        if (method === "GET" && path === "/api/session") {
            return handleGetSession(event);
        }

        if (path.startsWith("/api/local/")) {
            const localRouteResult = await handleLocalNetworkRoute(event, corsHeaders);
            if (localRouteResult) {
                return localRouteResult;
            }
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
        // Dispenser API Routes
        // ==========================================================================

        // POST /api/dispenser/claim - Claim USDC from dispenser
        if (method === "POST" && path === "/api/dispenser/claim") {
            return handleDispenserClaim(event);
        }

        // GET /api/dispenser/status - Get dispenser status for all chains
        if (method === "GET" && path === "/api/dispenser/status") {
            return handleDispenserStatus();
        }

        // GET /api/dispenser/status/:chainId - Get dispenser status for specific chain
        if (method === "GET" && path.match(/^\/api\/dispenser\/status\/\d+$/)) {
            return handleDispenserStatusByChain(event);
        }

        // GET /api/dispenser/check/:address - Check if address has claimed
        if (method === "GET" && path.match(/^\/api\/dispenser\/check\/0x[a-fA-F0-9]{40}$/)) {
            return handleDispenserCheck(event);
        }

        // ==========================================================================
        // Batch Settlement Routes (Deferred Payment System)
        // ==========================================================================

        // POST /api/settlement/batch - Trigger batch settlement (scheduled or manual)
        // Protected endpoint - only for internal use or admin
        if (method === "POST" && path === "/api/settlement/batch") {
            const internalSecret = event.headers["x-internal-secret"] || event.headers["X-Internal-Secret"];
            const expectedSecret = process.env.RUNTIME_INTERNAL_SECRET;

            // Security: Only allow internal calls
            if (internalSecret !== expectedSecret) {
                return {
                    statusCode: 401,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: "Unauthorized" }),
                };
            }

            try {
                const { runBatchSettlement } = await import("./x402/accumulator/index.js");

                console.log("[batch-settlement] Triggered manually via API");
                const result = await runBatchSettlement();

                return {
                    statusCode: 200,
                    headers: corsHeaders,
                    body: JSON.stringify(result),
                };
            } catch (error) {
                console.error("[batch-settlement] Error:", error);
                return {
                    statusCode: 500,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        error: "Batch settlement failed",
                        message: error instanceof Error ? error.message : String(error),
                    }),
                };
            }
        }

        // GET /api/settlement/status - Get pending settlement info for a user
        if (method === "GET" && path === "/api/settlement/status") {
            const chainId = parseInt(event.queryStringParameters?.chainId || String(getActiveChainId()), 10);
            const userAddress = requireUserAddressHeader(event);

            try {
                const { getBudgetInfo } = await import("./x402/session-budget.js");

                const info = await getBudgetInfo(userAddress, chainId);

                if (!info) {
                    return {
                        statusCode: 200,
                        headers: corsHeaders,
                        body: JSON.stringify({
                            hasActiveBudget: false,
                            message: "No active session budget found",
                        }),
                    };
                }

                return {
                    statusCode: 200,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        hasActiveBudget: true,
                        budget: info,
                    }),
                };
            } catch (error) {
                console.error("[settlement/status] Error:", error);
                return {
                    statusCode: 500,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        error: "Failed to get status",
                        message: error instanceof Error ? error.message : String(error),
                    }),
                };
            }
        }

        // ==========================================================================
        // Avatar and Banner Generation
        // ==========================================================================

        // Route: POST /api/generate-avatar - Generate avatar using Flux Schnell
        if (method === "POST" && path === "/api/generate-avatar") {
            const body = event.body ? JSON.parse(event.body) : {};
            const { title, description } = body;

            if (!title || !description) {
                return {
                    statusCode: 400,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify({ error: "You should add Name + Description before generating an avatar" }),
                };
            }

            try {
                const brandStyle = `Cyberpunk aesthetic with neon cyan (#22d3ee) and hot fuchsia (#d946ef) accents on dark obsidian background (#020617). High-tech futuristic feel with glass panels, circuit patterns, and subtle glow effects.`;
                const prompt = `Agent Name: ${title}
Agent Description: ${description}
Brand Style: ${brandStyle}

Create a professional square avatar icon for this AI agent. Clean, iconic design suitable for small sizes. No text.`;

                console.log("[generate-avatar] Prompt length:", prompt.length);

                const dataUrl = await generateDecorativeImage(prompt, "1024x1024");

                return {
                    statusCode: 200,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify({ imageUrl: dataUrl }),
                };
            } catch (error) {
                console.error("[generate-avatar] Error:", error);
                return {
                    statusCode: 500,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify({ error: "Avatar generation failed", message: String(error) }),
                };
            }
        }

        // Route: POST /api/generate-banner - Generate banner using Flux Schnell (landscape 1792x1024)
        if (method === "POST" && path === "/api/generate-banner") {
            const body = event.body ? JSON.parse(event.body) : {};
            const { title, description } = body;

            if (!title || !description) {
                return {
                    statusCode: 400,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify({ error: "You should add Title + Description before generating a banner" }),
                };
            }

            try {
                const brandStyle = `Cyberpunk aesthetic with neon cyan (#22d3ee) and hot fuchsia (#d946ef) accents on dark obsidian background (#020617). High-tech futuristic feel with glass panels, circuit patterns, and subtle glow effects.`;
                const prompt = `Workflow Title: ${title}
Workflow Description: ${description}
Brand Style: ${brandStyle}

Create a professional wide banner image for an AI workflow orchestration system. Landscape format, abstract tech visualization with connected nodes, data flows, or circuit patterns. No text or logos. Dark background with neon accent highlights.`;

                console.log("[generate-banner] Prompt length:", prompt.length);

                const dataUrl = await generateDecorativeImage(prompt, "1792x1024");

                return {
                    statusCode: 200,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify({ imageUrl: dataUrl }),
                };
            } catch (error) {
                console.error("[generate-banner] Error:", error);
                return {
                    statusCode: 500,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify({ error: "Banner generation failed", message: String(error) }),
                };
            }
        }

        // 404 for unknown routes
        return {
            statusCode: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Not found", path }),
        };
    } catch (error) {
        console.error("APIs handler error:", error);
        return {
            statusCode: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
        };
    }
}


/**
 * Batch Settlement Handler - Scheduled API
 * 
 * Triggered by CloudWatch Events every 2 minutes.
 * Processes accumulated payment intents for deferred settlement.
 */
export async function batchSettlementHandler(
    event: { source?: string } | unknown,
    _context: Record<string, unknown>
): Promise<void> {
    console.log("[batch-settlement] Scheduled handler invoked", JSON.stringify(event));

    try {
        const { runBatchSettlement } = await import("./x402/accumulator/index.js");

        const result = await runBatchSettlement();

        console.log("[batch-settlement] Completed:", {
            runId: result.runId,
            totalUsers: result.totalUsers,
            totalIntents: result.totalIntents,
            successCount: result.successCount,
            failCount: result.failCount,
            duration: `${result.endTime - result.startTime}ms`,
        });
    } catch (error) {
        console.error("[batch-settlement] Fatal error:", error);
        // Don't throw - let CloudWatch know the API succeeded (error is logged)
        // Throwing would trigger retries which could cause duplicate settlements
    }
}


// =============================================================================
// Route Handlers
// =============================================================================

async function handleGetSession(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const userAddress = requireUserAddressHeader(event);
    const chainId = requireChainIdHeader(event);

    const sessionStatus = await getActiveSessionStatus(userAddress, chainId);
    const session = sessionStatus.session;

    if (!session) {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(buildInactiveSessionPayload(sessionStatus.reason)),
        };
    }
    const budgetLimit = BigInt(session.budgetLimit);
    const budgetUsed = BigInt(session.budgetUsed);
    const budgetLocked = BigInt(session.budgetLocked);
    const budgetRemaining = BigInt(session.budgetRemaining);

    const response: Record<string, any> = {
        hasSession: true,
        keyId: session.keyId,
        token: session.token,
        budgetLimit: budgetLimit.toString(),
        budgetUsed: budgetUsed.toString(),
        budgetLocked: budgetLocked.toString(),
        budgetRemaining: budgetRemaining.toString(),
        expiresAt: session.expiresAt,
        chainId: session.chainId,
        name: session.name,
    };

    // Compute status warnings from real-time budget
    const now = Date.now();
    const expiresIn = Math.max(0, session.expiresAt - now);
    const expiresInSeconds = Math.floor(expiresIn / 1000);
    const budgetPercentRemaining = budgetLimit > 0n ? (Number(budgetRemaining) / Number(budgetLimit)) * 100 : 0;

    const warnings = {
        budgetDepleted: budgetRemaining <= 0n && budgetLocked <= 0n,
        budgetLow: budgetPercentRemaining < 20 && budgetRemaining > 0n,
        expiringSoon: expiresInSeconds < 300 && expiresInSeconds > 0,
        expired: expiresInSeconds <= 0,
    };

    response.status = {
        isActive: !warnings.expired && (budgetRemaining > 0n || budgetLocked > 0n),
        isExpired: warnings.expired,
        expiresInSeconds,
        budgetPercentRemaining,
        warnings,
    };

    // Add warning headers for frontend
    const headers: Record<string, string> = { ...corsHeaders };
    headers["x-session-budget-limit"] = budgetLimit.toString();
    headers["x-session-budget-used"] = budgetUsed.toString();
    headers["x-session-budget-locked"] = budgetLocked.toString();
    headers["x-session-budget-remaining"] = budgetRemaining.toString();

    if (warnings.budgetDepleted) {
        headers["x-session-status"] = "budget-depleted";
    } else if (warnings.budgetLow) {
        headers["x-session-status"] = "budget-low";
    } else if (warnings.expiringSoon) {
        headers["x-session-status"] = "expiring-soon";
    }

    if (warnings.budgetLow || warnings.budgetDepleted) {
        headers["x-session-budget-percent"] = String(Math.floor(budgetPercentRemaining));
    }

    if (warnings.expiringSoon || warnings.expired) {
        headers["x-session-expires-in"] = String(expiresInSeconds);
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(response),
    };
}

type PaymentIntentPrepareBody = {
    service?: string;
    action?: string;
    resource?: string;
    method?: string;
    maxAmountWei?: string;
    meter?: {
        subject?: string;
        lineItems?: Array<{
            key?: string;
            unit?: string;
            quantity?: number;
            unitPriceUsd?: number;
        }>;
    };
    composeRunId?: string;
    idempotencyKey?: string;
};

async function handlePreparePaymentIntent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) as PaymentIntentPrepareBody : {};
    const authorization = event.headers.authorization || event.headers.Authorization;
    const chainIdHeader = event.headers["x-chain-id"] || event.headers["X-Chain-Id"];
    const chainId = chainIdHeader ? parseInt(chainIdHeader, 10) : NaN;

    const result = await authorizePaymentIntent({
        authorization: authorization || "",
        chainId,
        service: body.service || "",
        action: body.action || "",
        resource: body.resource || "",
        method: body.method || "",
        maxAmountWei: body.maxAmountWei,
        meter: body.meter?.subject && Array.isArray(body.meter.lineItems)
            ? {
                subject: body.meter.subject,
                lineItems: body.meter.lineItems.map((lineItem) => ({
                    key: lineItem.key || "",
                    unit: (lineItem.unit || "") as never,
                    quantity: typeof lineItem.quantity === "number" ? lineItem.quantity : Number.NaN,
                    unitPriceUsd: typeof lineItem.unitPriceUsd === "number" ? lineItem.unitPriceUsd : Number.NaN,
                })),
            }
            : undefined,
        composeRunId: body.composeRunId,
        idempotencyKey: body.idempotencyKey,
    });

    return {
        statusCode: result.status,
        headers: {
            ...corsHeaders,
            ...result.headers,
        },
        body: JSON.stringify(result.body),
    };
}

type PaymentIntentSettleBody = {
    paymentIntentId?: string;
    finalAmountWei?: string;
    meter?: {
        subject?: string;
        lineItems?: Array<{
            key?: string;
            unit?: string;
            quantity?: number;
            unitPriceUsd?: number;
        }>;
    };
};

async function handleSettlePaymentIntent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) as PaymentIntentSettleBody : {};
    const result = await settlePaymentIntent({
        paymentIntentId: body.paymentIntentId || "",
        finalAmountWei: body.finalAmountWei,
        meter: body.meter?.subject && Array.isArray(body.meter.lineItems)
            ? {
                subject: body.meter.subject,
                lineItems: body.meter.lineItems.map((lineItem) => ({
                    key: lineItem.key || "",
                    unit: (lineItem.unit || "") as never,
                    quantity: typeof lineItem.quantity === "number" ? lineItem.quantity : Number.NaN,
                    unitPriceUsd: typeof lineItem.unitPriceUsd === "number" ? lineItem.unitPriceUsd : Number.NaN,
                })),
            }
            : undefined,
    });

    return {
        statusCode: result.status,
        headers: {
            ...corsHeaders,
            ...result.headers,
        },
        body: JSON.stringify(result.body),
    };
}

type PaymentIntentAbortBody = {
    paymentIntentId?: string;
    reason?: string;
};

async function handleAbortPaymentIntent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) as PaymentIntentAbortBody : {};
    const result = await abortPaymentIntent({
        paymentIntentId: body.paymentIntentId || "",
        reason: body.reason || "",
    });

    return {
        statusCode: result.status,
        headers: {
            ...corsHeaders,
            ...result.headers,
        },
        body: JSON.stringify(result.body),
    };
}

type PaymentModelMeterBody = {
    modelId?: string;
    provider?: string;
    modality?: UnifiedModality;
    usage?: UnifiedUsage;
    media?: BillingMediaEvidence;
};

async function handleMeterModelPayment(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) as PaymentModelMeterBody : {};

    if (!body.modelId) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "modelId is required" }),
        };
    }

    if (!body.modality) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "modality is required" }),
        };
    }

    try {
        const metered = buildResolvedSettlementMeter({
            resolved: resolveBillingModel(body.modelId, body.provider),
            modality: body.modality,
            usage: body.usage,
            media: body.media,
        });

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(metered),
        };
    } catch (error) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        };
    }
}

async function handleCreateKey(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) : {};
    const purpose = body.purpose === "session" || body.purpose === "api" ? body.purpose : null;

    let budgetLimit: number;
    let expiresAt: number;
    let chainId: number;
    try {
        budgetLimit = parsePositiveIntegerInput(body.budgetLimit, "budgetLimit");
        expiresAt = parsePositiveIntegerInput(body.expiresAt, "expiresAt");
        chainId = parsePositiveIntegerInput(body.chainId, "chainId");
    } catch (error) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                error: error instanceof Error
                    ? error.message
                    : "budgetLimit, expiresAt, chainId, and purpose are required",
            }),
        };
    }
    if (!purpose) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "purpose must be either session or api" }),
        };
    }
    if (expiresAt <= Date.now()) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: "expiresAt must be in the future" }),
        };
    }

    const userAddress = requireUserAddressHeader(event);
    if (purpose === "session") {
        const hasAllowance = await hasSufficientSessionAllowance({
            userAddress,
            chainId,
            minimumBudgetWei: budgetLimit,
        });

        if (!hasAllowance) {
            return {
                statusCode: 409,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "On-chain session allowance is missing or below the requested budget",
                    hint: "Approve the USDC session budget on-chain before creating the session",
                }),
            };
        }
    }

    const result = await createComposeKey(userAddress, {
        budgetLimit,
        expiresAt,
        purpose,
        name: body.name,
        chainId,
    });

    if (purpose === "session") {
        try {
            await initializeSessionBudget(
                userAddress.trim().toLowerCase(),
                chainId,
                String(budgetLimit),
                expiresAt,
            );
        } catch (error) {
            await revokeKey(result.keyId, userAddress);
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: error instanceof Error ? error.message : "Failed to initialize session budget",
                }),
            };
        }
    }

    const budgetLimitString = String(result.budgetLimit);
    const budgetUsed = "0";
    const budgetRemaining = budgetLimitString;
    const createdAt = Date.now();

    return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify({
            ...result,
            budgetLimit: budgetLimitString,
            budgetUsed,
            budgetRemaining,
            createdAt,
            purpose,
            chainId,
        }),
    };
}

async function handleListKeys(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const userAddress = requireUserAddressHeader(event);
    const keys = await listUserKeys(userAddress);

    const safeKeys = keys.map(k => ({
        keyId: k.keyId,
        purpose: k.purpose,
        budgetLimit: k.budgetLimit,
        budgetUsed: k.budgetUsed,
        budgetRemaining: Math.max(0, k.budgetLimit - k.budgetUsed - (k.budgetReserved || 0)),
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
    const { settleComposeKeyPayment } = await import("./x402/settlement.js");
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
    const userAddress = requireUserAddressHeader(event);
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
// Compose Facilitator Handlers
// =============================================================================

async function handleComposeFacilitatorSupported(): Promise<APIGatewayProxyResultV2> {
    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(getComposeFacilitatorSupported()),
    };
}

async function handleComposeFacilitatorVerify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const { paymentPayload, paymentRequirements } = parseComposeFacilitatorVerifyRequest(body);
        const result = await verifyComposePayment(paymentPayload, paymentRequirements);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result),
        };
    } catch (error) {
        console.error("[x402/facilitator/verify] Error:", error);
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Failed to verify payment",
                details: error instanceof Error ? error.message : String(error),
            }),
        };
    }
}

async function handleComposeFacilitatorSettle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const { paymentPayload, paymentRequirements } = parseComposeFacilitatorSettleRequest(body);
        const result = await settleComposePayment(paymentPayload, paymentRequirements);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result),
        };
    } catch (error) {
        console.error("[x402/facilitator/settle] Error:", error);
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Failed to settle payment",
                details: error instanceof Error ? error.message : String(error),
            }),
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
        // GET /api/backpack/permissions
        if (path === "/api/backpack/permissions" && method === "GET") {
            const userId = event.queryStringParameters?.userId;
            if (!userId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId required" }) };
            }
            const permissions = await loadBackpackPermissions();
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({ permissions: permissions.listPermissions(userId) }),
            };
        }

        // POST /api/backpack/permissions/grant
        if (path === "/api/backpack/permissions/grant" && method === "POST") {
            const body = event.body ? JSON.parse(event.body) : {};
            if (!body.userId || !body.consentType) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId and consentType required" }) };
            }
            const permissions = await loadBackpackPermissions();
            permissions.grantPermission({
                userId: body.userId,
                consentType: body.consentType,
                sessionId: body.sessionId,
                agentId: body.agentId,
                expiresAt: body.expiresAt,
            });
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
        }

        // POST /api/backpack/permissions/revoke
        if (path === "/api/backpack/permissions/revoke" && method === "POST") {
            const body = event.body ? JSON.parse(event.body) : {};
            if (!body.userId || !body.consentType) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userId and consentType required" }) };
            }
            const permissions = await loadBackpackPermissions();
            permissions.revokePermission(body.userId, body.consentType, body.sessionId, body.agentId);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
        }

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

        // POST /api/backpack/execute
        if (path === "/api/backpack/execute" && method === "POST") {
            const body = event.body ? JSON.parse(event.body) : {};
            if (!body.userId || !body.toolkit || !body.action) {
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: "userId, toolkit and action required" }),
                };
            }
            const result = await bp.executeToolkitAction({
                userId: body.userId,
                toolkit: body.toolkit,
                action: body.action,
                params: body.params,
                text: body.text,
            });
            return { statusCode: result.success ? 200 : 400, headers: corsHeaders, body: JSON.stringify(result) };
        }

        // GET /api/backpack/toolkits
        if (path === "/api/backpack/toolkits" && method === "GET") {
            const search = event.queryStringParameters?.search || "";
            const limit = parseInt(event.queryStringParameters?.limit || "20", 10);
            const toolkits = await bp.searchToolkits(search, limit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkits }) };
        }

        // GET /api/backpack/toolkits/:toolkit/actions
        if (path.startsWith("/api/backpack/toolkits/") && path.endsWith("/actions") && method === "GET") {
            const toolkit = decodeURIComponent(
                path.replace("/api/backpack/toolkits/", "").replace(/\/actions$/, ""),
            );
            const limit = parseInt(event.queryStringParameters?.limit || "40", 10);
            const actions = await bp.listToolkitActions(toolkit, limit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkit, actions }) };
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
            allModels = allModels.filter((m: any) => {
                if (typeof m.type === "string") {
                    return m.type === query.task;
                }
                if (Array.isArray(m.type)) {
                    return m.type.includes(query.task);
                }
                return false;
            });
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
    const sourceMatch = path.match(/^\/api\/registry\/models\/(hugging%20face|vertex|fireworks|openai|gemini|cloudflare|aiml|asicloud)$/);
    if (sourceMatch && method === "GET") {
        const source = decodeURIComponent(sourceMatch[1]) as any;
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
// Dispenser Route Handlers
// =============================================================================

async function handleDispenserClaim(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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

    const dispenser = await loadDispenser();
    const result = await dispenser.claimDispenserUSDC({ address, chainId });

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

async function handleDispenserStatus(): Promise<APIGatewayProxyResultV2> {
    const dispenser = await loadDispenser();
    const statuses = await dispenser.getAllDispenserStatuses();

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
            dispensers: statuses,
            claimAmount: 1_000_000,
            claimAmountFormatted: "$1.00 USDC",
            maxClaims: 1000,
        }),
    };
}

async function handleDispenserStatusByChain(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const chainId = parseInt(event.rawPath.split("/api/dispenser/status/")[1], 10);

    const dispenser = await loadDispenser();
    const result = await dispenser.checkDispenserAvailable(chainId);

    return {
        statusCode: result.available ? 200 : 404,
        headers: corsHeaders,
        body: JSON.stringify(result),
    };
}

async function handleDispenserCheck(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const address = event.rawPath.split("/api/dispenser/check/")[1] as `0x${string}`;

    const dispenser = await loadDispenser();
    const status = await dispenser.getGlobalClaimStatus(address);

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
