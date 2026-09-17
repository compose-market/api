/**
 * Cloud Run Handler
 *
 * Handles non-inference API endpoints:
 * - Account management (Compose Keys, sessions)
 * - Compose x402 facilitator
 * - Per-agent permissions and Composio accounts
 * - Model registry queries
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
    createKey,
    getKeyRecord,
    listUserKeys,
    revokeKey,
    getActiveSessionStatus,
} from "./x402/keys/index.js";
import type { SessionInactiveReason } from "./x402/keys/types.js";
import { resolveWalletScopes } from "./data/user/scopes.js";

import {
    extractKeyFromHeader,
    validateKey,
} from "./x402/keys/middleware.js";

import {
    getSessionFundingReadiness,
} from "./x402/session/allowance.js";
import { recordSession } from "./data/metrics/sessions.js";
import { handleLocalNetworkRoute } from "./local/network.js";
import { handleLocalStorageProvisionRoute } from "./local/paymaster.js";
import { handlePublicRoute, registerManowarRoutes } from "./routes.js";
import {
    AGENTS_ENTRYPOINT,
    AGENTS_CATALOG,
    MODELS_ENTRYPOINT,
    MODELS_CATALOG,
} from "./x402/discovery.js";
import { buildResolvedSettlementMeter, resolveBillingModel } from "./x402/metering.js";
import type { Modality, Usage } from "./inference/core.js";
import type { BillingMediaEvidence } from "./inference/telemetry.js";
import {
    authorizePaymentIntent,
    abortPaymentIntent,
    settlePaymentIntent,
} from "./x402/intents.js";
import { getDefaultNetwork, getNetwork, getNetworkRpcUrl, isEvmNetwork, isNetworkId, type EvmNetworkId, type NetworkId } from "./x402/configs/chains.js";
import { validateSvmAddress } from "@x402/svm";
import {
    getFacilitatorSupported,
    getFacilitatorChainMetadata,
    getNetworkFromPaymentPayload,
    parseFacilitatorSettleRequest,
    parseFacilitatorVerifyRequest,
    settlePayment,
    verifyPayment,
} from "./x402/facilitator.js";
// import { createBotchainAccount, prepareBotchainSessionApproval, submitBotchainSessionApproval } from "./botchain.js"; 
import { recordConfirmedPayment, triggerConfirmedPayment } from "./data/metrics/payments.js";

// Per-agent permissions / Composio accounts / gated connectors
const loadBackpack = () => import("./backpack/accounts.js");
const loadBackpackPermissions = () => import("./backpack/permissions.js");
const loadBackpackGated = () => import("./backpack/gated.js");

// Model Registry
const loadRegistry = () => import("./inference/catalog/registry.js");

// =============================================================================
// Configuration
// =============================================================================

// CORS is applied by the top-level middleware in api/index.ts (http/cors.ts).
// The duplicate header set used to live here; per the single-layer CORS
// policy it is now removed so browsers don't see conflicting values. Handlers
// continue to merge extra response headers (x-key-*, x-session-*,
// x-payment-intent-id, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Transaction-Hash,
// X-Receipt) freely on top of the middleware-set CORS + X-Request-Id.
const corsHeaders: Record<string, string> = {};

function networkHeader(event: APIGatewayProxyEventV2): NetworkId | undefined {
    const raw = getHeader(event, "x-network-id");
    return raw && isNetworkId(raw) ? raw : undefined;
}

function triggerPaymentMetric(network: NetworkId | undefined, txHash: unknown, source: string): void {
    if (!network || !isEvmNetwork(network) || typeof txHash !== "string" || txHash.trim().length === 0) return;
    triggerConfirmedPayment({ network, txHash }, source);
}

async function recordSettlementCycleMetrics(result: {
    native?: {
        chains?: Array<{
            network: EvmNetworkId;
            settleTxHash?: string;
        }>;
    } | null;
    intents?: {
        results?: Array<{
            network: NetworkId;
            txHash?: string;
            status?: string;
            error?: string;
        }>;
    } | null;
}, source: string): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    for (const chain of result.native?.chains || []) {
        if (chain.settleTxHash) {
            tasks.push(recordConfirmedPayment({
                network: chain.network,
                txHash: chain.settleTxHash,
            }).catch((error) => {
                console.error("[metrics] native batch settlement record failed", {
                    source,
                    network: chain.network,
                    txHash: chain.settleTxHash,
                    error: error instanceof Error ? error.message : String(error),
                });
            }));
        }
    }
    for (const item of result.intents?.results || []) {
        if (item.status === "confirmed" && item.txHash && isEvmNetwork(item.network)) {
            tasks.push(recordConfirmedPayment({
                network: item.network,
                txHash: item.txHash,
            }).catch((error) => {
                console.error("[metrics] intent batch settlement record failed", {
                    source,
                    network: item.network,
                    txHash: item.txHash,
                    error: error instanceof Error ? error.message : String(error),
                });
            }));
        }
    }
    await Promise.all(tasks);
}

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
function getHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
    const normalized = name.toLowerCase();
    for (const [key, value] of Object.entries(event.headers || {})) {
        if (key.toLowerCase() === normalized) {
            return value;
        }
    }
    return undefined;
}

function normalizeAccount(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    return normalized || null;
}

function requireUserAddressHeader(event: APIGatewayProxyEventV2): string {
    const userAddress = normalizeAccount(getHeader(event, "x-session-user-address"));
    if (!userAddress) {
        throw new Error("x-session-user-address header required");
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress) && !validateSvmAddress(userAddress)) {
        throw new Error("x-session-user-address header required");
    }
    return userAddress;
}

function requireNetworkHeader(event: APIGatewayProxyEventV2): NetworkId {
    const network = getHeader(event, "x-network-id");
    if (!network || !isNetworkId(network)) throw new Error("x-network-id header required");
    return network;
}

async function generateDecorativeImage(prompt: string, size: string): Promise<string> {
    const modelId = "FLUX-2-klein-9b";
    const [{ normalizeResponsesRequest }, { generateWithTools }, { getModelById }] = await Promise.all([
        import("./inference/core.js"),
        import("./inference/catalog/adapter.js"),
        import("./inference/catalog/registry.js"),
    ]);

    const card = getModelById(modelId);
    if (!card) {
        throw new Error(`Model not found: ${modelId}`);
    }

    const request = normalizeResponsesRequest({
        model: modelId,
        input: [{ type: "input_text", text: prompt }],
        modalities: ["image"],
        size,
        n: 1,
    });

    const output = (await generateWithTools(request, { modelId, provider: card.provider })).output;
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

        // Default to JSON; handlers that need other content types set the
        // `content-type` entry in `result.headers` explicitly.
        if (!res.getHeader("content-type")) {
            res.setHeader("content-type", "application/json; charset=utf-8");
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

    registerManowarRoutes(app);

    app.get("/openapi.json", routeHandler);
    app.get("/.well-known/x402", routeHandler);
    app.get(MODELS_CATALOG, routeHandler);
    app.get(AGENTS_CATALOG, routeHandler);
    app.post(new RegExp(`^${MODELS_ENTRYPOINT.replace(/\/$/u, "")}/?$`, "u"), routeHandler);
    app.post(new RegExp(`^${AGENTS_ENTRYPOINT.replace(/\/$/u, "")}/?$`, "u"), routeHandler);

    app.get("/health", routeHandler);
    app.get("/api/models", routeHandler);
    app.get("/agents", routeHandler);
    app.get("/agents/search", routeHandler);
    app.get(/^\/agent\/[^/]+\/avatar$/, routeHandler);
    app.get(/^\/agent\/[^/]+$/, routeHandler);
    app.get("/workflows", routeHandler);
    app.get(/^\/workflow\/0x[a-fA-F0-9]{40}$/, routeHandler);
    app.get("/api/agentverse/agents", routeHandler);

    app.get("/api/pricing", routeHandler);

    app.post("/api/payments/prepare", routeHandler);
    app.post("/api/payments/settle", routeHandler);
    app.post("/api/payments/abort", routeHandler);
    app.post("/api/payments/meter/model", routeHandler);
    app.get("/api/x402/facilitator/supported", routeHandler);
    app.get("/api/x402/facilitator/chains", routeHandler);
    app.post("/api/x402/facilitator/verify", routeHandler);
    app.post("/api/x402/facilitator/settle", routeHandler);
    app.post("/api/botchain/account/create", routeHandler);
    app.post("/api/botchain/session/prepare", routeHandler);
    app.post("/api/botchain/session/submit", routeHandler);

    app.get("/api/session", routeHandler);
    app.post("/api/keys", routeHandler);
    app.get("/api/keys", routeHandler);
    app.get(/^\/api\/keys\/[^/]+$/, routeHandler);
    app.delete(/^\/api\/keys\/[^/]+$/, routeHandler);

    app.get("/permissions", routeHandler);
    app.post("/permissions", routeHandler);
    app.delete("/permissions", routeHandler);
    app.get("/accounts", routeHandler);
    app.post("/accounts/connect", routeHandler);
    app.get("/accounts/status", routeHandler);
    app.post("/accounts/execute", routeHandler);
    app.delete("/accounts", routeHandler);
    app.get("/accounts/toolkits", routeHandler);
    app.get(/^\/accounts\/toolkits\/[^/]+\/actions$/, routeHandler);

    app.get("/gated", routeHandler);
    app.post("/gated/connect", routeHandler);
    app.post("/gated/grant", routeHandler);
    app.post("/gated/revoke", routeHandler);
    app.post("/gated/disconnect", routeHandler);
    app.post("/gated/resolve", routeHandler);
    app.get("/backpack/status", routeHandler);
    app.use("/api/registry", routeHandler);
    app.post("/api/local/link-token", routeHandler);
    app.post("/api/local/link-token/redeem", routeHandler);
    app.post("/api/local/deployments/register", routeHandler);
    app.post("/api/local/synapse/session", routeHandler);
    app.post("/api/local/filecoin-pin/session", routeHandler);
    app.post("/api/local/network/peers/upsert", routeHandler);
    app.get("/api/local/network/peers", routeHandler);

    app.post("/api/dispenser/claim", routeHandler);
    app.get("/api/dispenser/status", routeHandler);
    app.get(/^\/api\/dispenser\/status\/[^/]+$/, routeHandler);
    app.get(/^\/api\/dispenser\/check\/0x[a-fA-F0-9]{40}$/, routeHandler);

    app.post("/api/settlement/batch", routeHandler);

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
    // OPTIONS preflight is handled by the top-level CORS middleware. When the
    // handler is called directly (tests) we still short-circuit defensively.
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

        const localStorageProvisionRouteResult = await handleLocalStorageProvisionRoute(event, corsHeaders);
        if (localStorageProvisionRouteResult) {
            return localStorageProvisionRouteResult;
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
            return handleFacilitatorSupported();
        }

        if (method === "GET" && path === "/api/x402/facilitator/chains") {
            return handleFacilitatorChains();
        }

        if (method === "POST" && path === "/api/x402/facilitator/verify") {
            return handleFacilitatorVerify(event);
        }

        if (method === "POST" && path === "/api/x402/facilitator/settle") {
            return handleFacilitatorSettle(event);
        }

        /**
        if (method === "POST" && path === "/api/botchain/account/create") {
            const result = await createBotchainAccount(event.body);
            return {
                statusCode: result.statusCode,
                headers: corsHeaders,
                body: JSON.stringify(result.body),
            };
        }

        if (method === "POST" && path === "/api/botchain/session/prepare") {
            const result = await prepareBotchainSessionApproval(event.body);
            return {
                statusCode: result.statusCode,
                headers: corsHeaders,
                body: JSON.stringify(result.body),
            };
        }

        if (method === "POST" && path === "/api/botchain/session/submit") {
            const result = await submitBotchainSessionApproval(event.body);
            return {
                statusCode: result.statusCode,
                headers: corsHeaders,
                body: JSON.stringify(result.body),
            };
        }
        */

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

        // GET /api/keys/:keyId - Inspect one Compose Key. Requires Authorization
        // header containing the very key being inspected (JWT-possession proof).
        if (method === "GET" && /^\/api\/keys\/[^/]+$/.test(path)) {
            return handleGetKeyDetails(event);
        }

        // DELETE /api/keys/:keyId - Revoke a Compose Key
        if (method === "DELETE" && path.startsWith("/api/keys/")) {
            return handleRevokeKey(event);
        }

        if (path === "/permissions") {
            return handlePermissionsRoutes(event);
        }

        if (path === "/accounts" || path.startsWith("/accounts/")) {
            return handleAccountsRoutes(event);
        }

        if (path === "/gated" || path.startsWith("/gated/")) {
            return handleGatedRoutes(event);
        }

        if (path === "/backpack/status" && method === "GET") {
            return handleBackpackStatus(event);
        }

        // ==========================================================================
        // Dynamic Model Registry Routes
        // ==========================================================================

        if (path.startsWith("/api/registry/")) {
            return handleRegistryRoutes(event);
        }

        // ==========================================================================
        // Batch Settlement Routes (Deferred Payment System)
        // ==========================================================================

        if (method === "POST" && path === "/api/settlement/batch") {
            try {
                const { runBatchSettlementCycle } = await import("./x402/index.js");

                console.log("[batch-settlement] Triggered manually via API");
                const result = await runBatchSettlementCycle("manual-api");
                if (result.native) {
                    assertNativeBatchSettlement(result.native);
                }
                await recordSettlementCycleMetrics(result, "manual-batch");

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

        // ==========================================================================
        // Avatar and Banner Generation
        // ==========================================================================

        // Route: POST /api/generate-avatar - Generate avatar using FLUX 2 Klein 9b
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
                const brandStyle = `Cyberpunk aesthetic with neon cyan (#22d3ee) and hot fuchsia (#d946ef) accents on dark obsidian background (#020617). Glass panels, and subtle glow effects.`;
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

        // Route: POST /api/generate-banner - Generate banner using FLUX 2 Klein 9b (landscape 1792x1024)
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
        const { runBatchSettlementCycle } = await import("./x402/index.js");

        const result = await runBatchSettlementCycle("scheduled");
        if (result.native) {
            assertNativeBatchSettlement(result.native);
        }
        await recordSettlementCycleMetrics(result, "scheduled-batch");

        console.log("[batch-settlement] Completed:", {
            skipped: result.skipped,
            runId: result.intents?.runId,
            nativeRunId: result.native?.runId,
            nativeNetworks: result.native?.chains?.map((entry) => ({
                network: entry.network,
                claimCount: entry.claimCount,
                claimTxHashes: entry.claimTxHashes,
                settleTxHash: entry.settleTxHash,
                reconciledReceipts: entry.reconciledReceipts,
                reconciledEvidence: entry.reconciledEvidence,
                error: entry.error,
            })),
            totalUsers: result.intents?.totalUsers,
            totalIntents: result.intents?.totalIntents,
            successCount: result.intents?.successCount,
            failCount: result.intents?.failCount,
            duration: result.intents ? `${result.intents.endTime - result.intents.startTime}ms` : "0ms",
        });
    } catch (error) {
        console.error("[batch-settlement] Fatal error:", error);
        // Cloud Run Jobs are configured with max-retries=0; fail loudly so
        // batch settlement misconfiguration is visible instead of green.
        throw error;
    }
}

function assertNativeBatchSettlement(native: {
    chains?: Array<{ network: EvmNetworkId; error?: string }>;
}): void {
    const failed = native.chains?.filter((chain) => chain.error) || [];
    if (failed.length === 0) {
        return;
    }
    const detail = failed.map((chain) => `${chain.network}: ${chain.error}`).join("; ");
    throw new Error(`Native batch settlement failed: ${detail}`);
}


// =============================================================================
// Route Handlers
// =============================================================================

async function handleGetSession(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const userAddress = requireUserAddressHeader(event);
    const network = requireNetworkHeader(event);

    const sessionStatus = await getActiveSessionStatus(userAddress, network);
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
        budgetReserved: budgetLocked.toString(),
        budgetLocked: budgetLocked.toString(),
        budgetRemaining: budgetRemaining.toString(),
        expiresAt: session.expiresAt,
        network: session.network,
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
    headers["x-session-budget-reserved"] = budgetLocked.toString();
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
    runId?: string;
    idempotencyKey?: string;
};

async function handlePreparePaymentIntent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const body = event.body ? JSON.parse(event.body) as PaymentIntentPrepareBody : {};
    const authorization = event.headers.authorization || event.headers.Authorization;
    const network = requireNetworkHeader(event);

    const result = await authorizePaymentIntent({
        authorization: authorization || "",
        network,
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
        runId: body.runId,
        idempotencyKey: body.idempotencyKey,
    });

    if (result.ok && typeof result.body.paymentIntentId === "string" && result.headers["x-session-budget-limit"]) {
        try {
            await recordSession({
                keyId: result.body.paymentIntentId,
                network,
                createdAt: new Date(),
            });
        } catch (error) {
            console.error("[metrics] session record failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

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
    if (result.ok && result.body.status === "confirmed") {
        const body = result.body;
        triggerPaymentMetric(body.network, body.txHash, "payment-intent");
    }

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
    modality?: Modality;
    usage?: Usage;
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
            resolved: resolveBillingModel(body.modelId),
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
    let network: NetworkId;
    try {
        budgetLimit = parsePositiveIntegerInput(body.budgetLimit, "budgetLimit");
        expiresAt = parsePositiveIntegerInput(body.expiresAt, "expiresAt");
        network = requireNetworkHeader(event);
    } catch (error) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                error: error instanceof Error
                    ? error.message
                    : "budgetLimit, expiresAt, network, and purpose are required",
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

    try {
        const readiness = await getSessionFundingReadiness({
            userAddress,
            network,
            requiredBudgetWei: budgetLimit,
        });

        if (!readiness.ready) {
            const budgetLabel = purpose === "session" ? "session budget" : "Compose key budget";
            const actionLabel = purpose === "session" ? "session creation" : "key creation";
            const isFundingShortfall = readiness.reason === "insufficient_balance"
                || readiness.reason === "insufficient_allowance";
            const error = readiness.reason === "insufficient_balance"
                ? `Insufficient USDC balance for requested ${budgetLabel}`
                : readiness.reason === "insufficient_allowance"
                    ? `Insufficient USDC allowance for requested ${budgetLabel}`
                    : readiness.error || "Failed to verify Compose key funding readiness";
            const hint = readiness.reason === "insufficient_balance"
                ? `Fund the selected account with at least the selected ${budgetLabel}, then retry ${actionLabel}.`
                : readiness.reason === "insufficient_allowance"
                    ? `Authorize Compose.Market to spend at least the selected ${budgetLabel}, then retry ${actionLabel}.`
                    : readiness.hint;
            return {
                statusCode: isFundingShortfall ? 402 : 503,
                headers: corsHeaders,
                body: JSON.stringify({
                    error,
                    ...(hint ? { hint } : {}),
                    code: readiness.reason,
                    details: {
                        network: readiness.network,
                        payer: readiness.payer,
                        asset: readiness.asset,
                        requiredWei: readiness.requiredWei,
                        balanceWei: readiness.balanceWei,
                        allowanceWei: readiness.allowanceWei,
                        spender: readiness.spender,
                    },
                }),
            };
        }
    } catch (error) {
        return {
            statusCode: 503,
            headers: corsHeaders,
            body: JSON.stringify({
                error: error instanceof Error
                    ? error.message
                    : "Failed to verify Compose key funding readiness",
            }),
        };
    }

    const result = await createKey(userAddress, {
        budgetLimit,
        expiresAt,
        purpose,
        name: body.name,
        network,
    });

    const budgetLimitString = String(result.budgetLimit);
    const budgetUsed = "0";
    const budgetReserved = "0";
    const budgetRemaining = budgetLimitString;
    const createdAt = Date.now();

    return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify({
            ...result,
            budgetLimit: budgetLimitString,
            budgetUsed,
            budgetReserved,
            budgetLocked: budgetReserved,
            budgetRemaining,
            createdAt,
            purpose,
            network,
        }),
    };
}

async function handleListKeys(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    let userAddress: string;
    try {
        userAddress = requireUserAddressHeader(event);
    } catch (error) {
        return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: error instanceof Error ? error.message : "Invalid user address" }),
        };
    }

    let keys: Awaited<ReturnType<typeof listUserKeys>>;
    try {
        const scopes = await resolveWalletScopes(userAddress);
        keys = await listUserKeys(scopes);
    } catch (error) {
        const statusCode = typeof error === "object"
            && error !== null
            && "statusCode" in error
            && (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 503)
            ? error.statusCode
            : 503;
        return {
            statusCode,
            headers: corsHeaders,
            body: JSON.stringify({
                error: error instanceof Error ? error.message : "Failed to list Compose keys",
            }),
        };
    }

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
        network: k.network,
    }));

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ keys: safeKeys }),
    };
}

async function handleGetKeyDetails(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const keyId = event.rawPath.replace("/api/keys/", "");

    const authHeader = event.headers["authorization"] || event.headers["Authorization"];
    const keyToken = extractKeyFromHeader(authHeader);
    if (!keyToken) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "authentication_required",
                    message: "Authorization: Bearer compose-<jwt> of a key belonging to the same wallet is required",
                },
            }),
        };
    }

    const validation = await validateKey(keyToken, 0);
    if (!validation.valid || !validation.payload) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "authentication_failed",
                    message: validation.error || "Invalid Compose key",
                },
            }),
        };
    }

    // Accept either (a) the target key's own JWT, or (b) any live JWT whose
    // `sub` matches the target key's owner. The second path makes the
    // "manage my keys" UX in web/ and mesh work: the user's active session
    // token is used to inspect/revoke their OTHER keys (e.g. API keys)
    // without having to surface every key's token to the client.
    const record = validation.payload.keyId === keyId
        ? validation.record ?? (await getKeyRecord(keyId))
        : await getKeyRecord(keyId);

    if (!record) {
        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({
                error: { code: "key_not_found", message: "Key not found" },
            }),
        };
    }

    if (record.userAddress !== validation.payload.sub || record.network !== validation.payload.network) {
        return {
            statusCode: 403,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "forbidden",
                    message: "Authorization token does not belong to the owner of this key",
                },
            }),
        };
    }

    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
            keyId: record.keyId,
            purpose: record.purpose,
            budgetLimit: record.budgetLimit,
            budgetUsed: record.budgetUsed,
            budgetReserved: record.budgetReserved ?? 0,
            budgetRemaining: Math.max(
                0,
                record.budgetLimit - record.budgetUsed - (record.budgetReserved ?? 0),
            ),
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            revokedAt: record.revokedAt,
            lastUsedAt: record.lastUsedAt,
            name: record.name,
            network: record.network,
        }),
    };
}

async function handleRevokeKey(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const keyId = event.rawPath.replace("/api/keys/", "");

    // Identity cross-check: revocation requires proof of possession of a
    // Compose Key belonging to the same wallet. This covers both
    //   (a) revoke-self: the target key's own JWT, and
    //   (b) revoke-other: an active session JWT revoking an API key
    //       (or vice versa) that belongs to the same wallet.
    // The unsigned `x-session-user-address` header is never a trust input;
    // the JWT's signed `sub` is.
    const authHeader = event.headers["authorization"] || event.headers["Authorization"];
    const keyToken = extractKeyFromHeader(authHeader);
    if (!keyToken) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "authentication_required",
                    message: "Authorization: Bearer compose-<jwt> of a key belonging to the same wallet is required",
                },
            }),
        };
    }

    const validation = await validateKey(keyToken, 0);
    if (!validation.valid || !validation.payload) {
        return {
            statusCode: 401,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "authentication_failed",
                    message: validation.error || "Invalid Compose key",
                },
            }),
        };
    }

    const callerAddress = validation.payload.sub;
    const targetRecord = validation.payload.keyId === keyId
        ? validation.record ?? (await getKeyRecord(keyId))
        : await getKeyRecord(keyId);

    if (!targetRecord) {
        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({
                error: { code: "key_not_found", message: "Key not found" },
            }),
        };
    }

    if (targetRecord.userAddress !== callerAddress || targetRecord.network !== validation.payload.network) {
        return {
            statusCode: 403,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "forbidden",
                    message: "Authorization token does not belong to the owner of this key",
                },
            }),
        };
    }

    const success = await revokeKey(keyId, callerAddress);

    if (!success) {
        return {
            statusCode: 404,
            headers: corsHeaders,
            body: JSON.stringify({
                error: {
                    code: "key_not_found",
                    message: "Key not found or already revoked",
                },
            }),
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

async function handleFacilitatorSupported(): Promise<APIGatewayProxyResultV2> {
    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(await getFacilitatorSupported()),
    };
}

async function handleFacilitatorChains(): Promise<APIGatewayProxyResultV2> {
    const chains = (await getFacilitatorChainMetadata()).map((entry) => {
        const definition = getNetwork(entry.network);
        return {
            name: entry.name,
            network: entry.network,
            namespace: definition.namespace,
            shortName: definition.shortName,
            isTestnet: definition.environment === "testnet",
            explorer: definition.explorer,
            explorerQuery: definition.explorerQuery,
            rpcUrl: getNetworkRpcUrl(entry.network),
            assetAddress: definition.asset.address,
            schemes: definition.schemes,
            asset: definition.asset.symbol,
            decimals: definition.asset.decimals,
        };
    });
    return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
            chains,
            defaultNetwork: getDefaultNetwork(),
        }),
    };
}

async function handleFacilitatorVerify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const { paymentPayload, paymentRequirements } = parseFacilitatorVerifyRequest(body);
        const result = await verifyPayment(paymentPayload, paymentRequirements);

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

async function handleFacilitatorSettle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const { paymentPayload, paymentRequirements } = parseFacilitatorSettleRequest(body);
        const network = getNetworkFromPaymentPayload(paymentPayload);
        const result = await settlePayment(paymentPayload, paymentRequirements);
        if (result.success && isEvmNetwork(network)) {
            triggerPaymentMetric(network, result.transaction, "facilitator");
        }

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
// Permission / Account Route Handlers
// =============================================================================

function body(event: APIGatewayProxyEventV2): Record<string, any> {
    return event.body ? JSON.parse(event.body) : {};
}

function query(event: APIGatewayProxyEventV2): Record<string, string | undefined> {
    return event.queryStringParameters || {};
}

async function handlePermissionsRoutes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const permissions = await loadBackpackPermissions();
    const method = event.requestContext.http.method;

    try {
        if (method === "GET") {
            const params = query(event);
            if (!params.userAddress || !params.agentWallet) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress and agentWallet required" }) };
            }
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    permissions: await permissions.listPermissions(params.userAddress, params.agentWallet),
                }),
            };
        }

        if (method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.agentWallet || !data.consentType) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet and consentType required" }) };
            }
            const permission = await permissions.grantPermission({
                userAddress: data.userAddress,
                agentWallet: data.agentWallet,
                consentType: data.consentType,
                expiresAt: data.expiresAt,
            });
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, permission }) };
        }

        if (method === "DELETE") {
            const data = { ...query(event), ...body(event) };
            if (!data.userAddress || !data.agentWallet || !data.consentType) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet and consentType required" }) };
            }
            await permissions.revokePermission(data.userAddress, data.agentWallet, data.consentType);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[permissions] Error:", message);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: message }) };
    }
}

async function handleAccountsRoutes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const accounts = await loadBackpack();
    const path = event.rawPath;
    const method = event.requestContext.http.method;

    try {
        if (path === "/accounts/toolkits" && method === "GET") {
            const params = query(event);
            const limit = Number.parseInt(params.limit || "20", 10);
            const toolkits = await accounts.searchToolkits(params.search || "", limit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkits }) };
        }

        if (path.startsWith("/accounts/toolkits/") && path.endsWith("/actions") && method === "GET") {
            const toolkit = decodeURIComponent(path.replace("/accounts/toolkits/", "").replace(/\/actions$/u, ""));
            const limit = Number.parseInt(query(event).limit || "40", 10);
            const actions = await accounts.listToolkitActions(toolkit, limit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ toolkit, actions }) };
        }

        if (path === "/accounts/connect" && method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.agentWallet || !data.toolkit) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet and toolkit required" }) };
            }
            const result = await accounts.initiateConnection(data.userAddress, data.agentWallet, data.toolkit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
        }

        if (path === "/accounts" && method === "GET") {
            const params = query(event);
            if (!params.userAddress || !params.agentWallet) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress and agentWallet required" }) };
            }
            const connections = await accounts.listConnections(params.userAddress, params.agentWallet, params.toolkit);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ connections }) };
        }

        if (path === "/accounts/status" && method === "GET") {
            const params = query(event);
            if (!params.userAddress || !params.toolkit || !params.connectedAccountId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, toolkit and connectedAccountId required" }) };
            }
            const status = await accounts.checkConnection({
                userAddress: params.userAddress,
                toolkit: params.toolkit,
                connectedAccountId: params.connectedAccountId,
            });
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(status) };
        }

        if (path === "/accounts/execute" && method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.agentWallet || !data.toolkit || !data.connectedAccountId || !data.action) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet, toolkit, connectedAccountId and action required" }) };
            }
            const result = await accounts.executeToolkitAction({
                userAddress: data.userAddress,
                agentWallet: data.agentWallet,
                toolkit: data.toolkit,
                connectedAccountId: data.connectedAccountId,
                action: data.action,
                params: data.params,
                text: data.text,
            });
            return { statusCode: result.success ? 200 : 400, headers: corsHeaders, body: JSON.stringify(result) };
        }

        if (path === "/accounts" && method === "DELETE") {
            const data = { ...query(event), ...body(event) };
            if (!data.userAddress || !data.toolkit || !data.connectedAccountId) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, toolkit and connectedAccountId required" }) };
            }
            const result = await accounts.disconnectToolkit({
                userAddress: data.userAddress,
                toolkit: data.toolkit,
                connectedAccountId: data.connectedAccountId,
            });
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
        }

        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[accounts] Error:", message);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: message }) };
    }
}

interface ConnectorCardCredential {
    varName: string;
    description?: string;
    obtainUrl?: string;
}

interface ConnectorCard {
    slug: string;
    name?: string;
    status?: string;
    credentials: ConnectorCardCredential[];
    actions?: string[];
}

async function fetchConnectorCard(slug: string): Promise<ConnectorCard | null> {
    const base = process.env.CONNECTORS_URL?.trim().replace(/\/+$/u, "");
    if (!base) return null;
    try {
        const response = await fetch(`${base}/mcps/${encodeURIComponent(slug)}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return null;
        const card = await response.json() as {
            slug?: string;
            name?: string;
            status?: string;
            credentials?: Array<{ varName?: string; description?: string; obtainUrl?: string }>;
            tools?: Array<{ name?: string }>;
        };
        return {
            slug: card.slug || slug,
            name: card.name,
            status: card.status,
            credentials: Array.isArray(card.credentials)
                ? card.credentials
                    .filter((entry) => typeof entry?.varName === "string" && entry.varName.trim().length > 0)
                    .map((entry) => ({
                        varName: String(entry.varName).trim(),
                        ...(entry.description ? { description: entry.description } : {}),
                        ...(entry.obtainUrl ? { obtainUrl: entry.obtainUrl } : {}),
                    }))
                : [],
            actions: Array.isArray(card.tools)
                ? card.tools
                    .map((tool) => tool?.name)
                    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
                : undefined,
        };
    } catch {
        return null;
    }
}

async function handleGatedRoutes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const gated = await loadBackpackGated();
    const path = event.rawPath;
    const method = event.requestContext.http.method;

    try {
        if (path === "/gated" && method === "GET") {
            const params = query(event);
            if (!params.userAddress) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress required" }) };
            }
            const connections = await gated.listGated(params.userAddress);
            const grants = params.agentWallet ? await gated.listGatedGrants(params.userAddress) : [];
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    connections,
                    grants: grants.filter((grant) => !params.agentWallet || grant.agentWallet === params.agentWallet?.toLowerCase()),
                }),
            };
        }

        if (path === "/gated/connect" && method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.slug || !data.vars || typeof data.vars !== "object") {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, slug and vars required" }) };
            }
            const card = await fetchConnectorCard(String(data.slug));
            if (card && card.credentials.length > 0) {
                const provided = new Set(Object.keys(data.vars).map((name: string) => String(name).trim().toUpperCase()));
                const missing = card.credentials.filter((credential) => !provided.has(credential.varName.toUpperCase()));
                if (missing.length > 0) {
                    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "missing credential variables", missing }) };
                }
            }
            const connection = await gated.connectGated({
                userAddress: data.userAddress,
                slug: data.slug,
                vars: data.vars,
            });
            if (data.agentWallet) {
                await gated.grantGated({ userAddress: data.userAddress, agentWallet: data.agentWallet, slug: connection.slug });
            }
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, connection }) };
        }

        if (path === "/gated/grant" && method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.agentWallet || !data.slug) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet and slug required" }) };
            }
            const grant = await gated.grantGated({ userAddress: data.userAddress, agentWallet: data.agentWallet, slug: data.slug });
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, grant }) };
        }

        if (path === "/gated/revoke" && method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.agentWallet || !data.slug) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet and slug required" }) };
            }
            await gated.revokeGated({ userAddress: data.userAddress, agentWallet: data.agentWallet, slug: data.slug });
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
        }

        if (path === "/gated/disconnect" && method === "POST") {
            const data = body(event);
            if (!data.userAddress || !data.slug) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress and slug required" }) };
            }
            const result = await gated.disconnectGated(data.userAddress, data.slug);
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
        }

        if (path === "/gated/resolve" && method === "POST") {
            const expected = process.env.BACKPACK_INTERNAL_TOKEN?.trim();
            if (!expected || getHeader(event, "x-backpack-internal-token") !== expected) {
                return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: "unauthorized" }) };
            }
            const data = body(event);
            if (!data.userAddress || !data.agentWallet || !data.slug) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress, agentWallet and slug required" }) };
            }
            const resolved = await gated.resolveGated({
                userAddress: data.userAddress,
                agentWallet: data.agentWallet,
                slug: data.slug,
                ...(typeof data.runId === "string" && data.runId ? { runId: data.runId } : {}),
            });
            if (!resolved) {
                return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false }) };
            }
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, vars: resolved.vars }) };
        }

        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[gated] Error:", message);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: message }) };
    }
}

async function handleBackpackStatus(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const params = query(event);
        if (!params.userAddress || !params.agentWallet) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "userAddress and agentWallet required" }) };
        }
        const [accounts, gated] = await Promise.all([loadBackpack(), loadBackpackGated()]);
        const [connections, gatedConnections, gatedGrants] = await Promise.all([
            accounts.listConnections(params.userAddress, params.agentWallet),
            gated.listGated(params.userAddress),
            gated.listGatedGrants(params.userAddress),
        ]);
        const grantedSlugs = new Set(
            gatedGrants
                .filter((grant) => grant.agentWallet === params.agentWallet?.toLowerCase())
                .map((grant) => grant.slug),
        );
        const connectors = await Promise.all(gatedConnections.map(async (connection) => {
            const card = await fetchConnectorCard(connection.slug);
            const required = card?.credentials ?? [];
            const provided = new Set(connection.varNames.map((name) => name.toUpperCase()));
            const missingVars = required
                .filter((credential) => !provided.has(credential.varName.toUpperCase()))
                .map((credential) => ({
                    varName: credential.varName,
                    ...(credential.description ? { description: credential.description } : {}),
                    ...(credential.obtainUrl ? { obtainUrl: credential.obtainUrl } : {}),
                }));
            return {
                slug: connection.slug,
                name: card?.name ?? connection.slug,
                connected: connection.status === "active" && missingVars.length === 0,
                allowed: grantedSlugs.has(connection.slug),
                status: connection.status,
                missingVars,
                ...(card?.actions ? { actions: card.actions } : {}),
            };
        }));
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                userAddress: params.userAddress.toLowerCase(),
                agentWallet: params.agentWallet.toLowerCase(),
                accounts: connections.map((connection) => ({
                    slug: connection.slug,
                    connected: connection.connected,
                    granted: connection.granted ?? false,
                    connectedAccountId: connection.connectedAccountId,
                    status: connection.status,
                })),
                connectors,
            }),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[backpack-status] Error:", message);
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
    const sourceMatch = path.match(/^\/api\/registry\/models\/(hugging%20face|vertex|fireworks|openai|gemini|cloudflare|asicloud)$/);
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
