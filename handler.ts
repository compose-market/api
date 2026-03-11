/**
 * Cloud Run Handler
 * 
 * Handles non-inference API endpoints:
 * - Account management (Compose Keys, sessions)
 * - Account Abstraction (Cronos)
 * - Backpack/Composio integrations
 * - Model registry queries
 * 
 * @module api/handler
 */

import type { Application, NextFunction, Request, Response, RequestHandler } from "express";

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
    getActiveSession,
} from "./x402/keys/index.js";

import {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    getKeyBudgetInfo,
} from "./x402/keys/middleware.js";

import { getActiveChainId } from "./x402/configs/chains.js";
import { handleDesktopUpdaterRoute } from "./desktop/updater.js";
import { handleDesktopNetworkRoute } from "./desktop/network.js";
import { handlePublicRoute, registerWorkflowRoutes } from "./routes.js";
import { buildResolvedSettlementMeter, resolveBillingModel } from "./x402/metering.js";
import type { UnifiedModality, UnifiedUsage } from "./inference/core.js";
import type { BillingMediaEvidence } from "./inference/telemetry.js";
import {
    authorizePaymentIntent,
    abortPaymentIntent,
    settlePaymentIntent,
} from "./x402/intents.js";
// Account Abstraction
const loadAA = () => import("./aa/index.js");

// Backpack / Composio
const loadBackpack = () => import("./backpack/composio.js");

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
        "X-PAYMENT, x-payment, x-session-active, x-session-budget-remaining, " +
        "x-session-user-address, x-desktop-device-id, x-network-internal, x-chain-id, x-payment-intent-id, Access-Control-Expose-Headers",
    "Access-Control-Expose-Headers":
        "PAYMENT-RESPONSE, payment-response, x-compose-key-budget-limit, " +
        "x-compose-key-budget-used, x-compose-key-budget-reserved, x-compose-key-budget-remaining, x-payment-intent-id, *",
};

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

    app.get("/api/session", routeHandler);
    app.post("/api/keys", routeHandler);
    app.get("/api/keys", routeHandler);
    app.post("/api/keys/settle", routeHandler);
    app.delete(/^\/api\/keys\/[^/]+$/, routeHandler);

    app.post("/api/aa/prepare", routeHandler);
    app.post("/api/aa/submit", routeHandler);
    app.get(/^\/api\/aa\/nonce\/0x[a-fA-F0-9]{40}$/, routeHandler);
    app.post("/api/aa/register-cronos", routeHandler);
    app.get(/^\/api\/aa\/predict-address\/0x[a-fA-F0-9]{40}$/, routeHandler);

    app.use("/api/backpack", routeHandler);
    app.use("/api/registry", routeHandler);
    app.post("/api/desktop/link-token", routeHandler);
    app.post("/api/desktop/link-token/redeem", routeHandler);
    app.post("/api/desktop/deployments/register", routeHandler);
    app.get("/api/desktop/updates/config", routeHandler);
    app.get(/^\/api\/desktop\/updates\/[^/]+\/[^/]+\/[^/]+$/, routeHandler);
    app.post("/api/desktop/network/peers/upsert", routeHandler);
    app.get("/api/desktop/network/peers", routeHandler);

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

        const desktopUpdaterRouteResult = await handleDesktopUpdaterRoute(event, corsHeaders);
        if (desktopUpdaterRouteResult) {
            return desktopUpdaterRouteResult;
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

        // ==========================================================================
        // Compose Keys API Routes
        // ==========================================================================

        // GET /api/session - Get active session
        if (method === "GET" && path === "/api/session") {
            return handleGetSession(event);
        }

        if (path.startsWith("/api/desktop/")) {
            const desktopRouteResult = await handleDesktopNetworkRoute(event, corsHeaders);
            if (desktopRouteResult) {
                return desktopRouteResult;
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
            const userAddress = event.headers["x-session-user-address"];
            const chainId = parseInt(event.queryStringParameters?.chainId || "338");

            if (!userAddress) {
                return {
                    statusCode: 401,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: "x-session-user-address header required" }),
                };
            }

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

    // Get session record from storage.ts (for token, keyId, expiresAt)
    const session = await getActiveSession(userAddress, chainId);

    if (!session) {
        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "No active session found",
                hasSession: false,
            }),
        };
    }

    // Get REAL-TIME budget from session-budget.ts (deferred payment ledger)
    const { getSessionStatus } = await import("./x402/session-budget.js");
    const budgetStatus = await getSessionStatus(
        userAddress,
        chainId ?? session.chainId ?? getActiveChainId()
    );

    // Use session-budget.ts for accurate budget (includes locked/used for deferred settlement)
    const budgetLimit = budgetStatus ? BigInt(budgetStatus.totalBudget) : BigInt(session.budgetLimit);
    const budgetUsed = budgetStatus ? BigInt(budgetStatus.usedBudget) : BigInt(session.budgetUsed);
    const budgetLocked = budgetStatus ? BigInt(budgetStatus.lockedBudget) : 0n;
    const budgetRemaining = budgetStatus ? BigInt(budgetStatus.availableBudget) : BigInt(session.budgetRemaining);

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
        budgetDepleted: budgetRemaining <= 0n,
        budgetLow: budgetPercentRemaining < 20 && budgetRemaining > 0n,
        expiringSoon: expiresInSeconds < 300 && expiresInSeconds > 0,
        expired: expiresInSeconds <= 0,
    };

    response.status = {
        isActive: !warnings.expired && budgetRemaining > 0n,
        isExpired: warnings.expired,
        expiresInSeconds,
        budgetPercentRemaining,
        warnings,
    };

    // Add warning headers for frontend
    const headers: Record<string, string> = { ...corsHeaders };

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

    const budgetLimit = String(result.budgetLimit);
    const budgetUsed = "0";
    const budgetRemaining = budgetLimit;
    const createdAt = Date.now();

    return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify({
            ...result,
            budgetLimit,
            budgetUsed,
            budgetRemaining,
            createdAt,
            chainId: body.chainId,
        }),
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
