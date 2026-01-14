/**
 * AWS Lambda Handler for Compose Market API
 * 
 * Handles:
 * - /v1/* - OpenAI-compatible API endpoints (primary)
 * - /api/registry/* - Model registry routes
 * - /api/hf/* - HuggingFace endpoints
 * - /api/agentverse/* - Agentverse endpoints
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";
import type { ModelCard } from "./shared/models/types.js";

// OpenAI-compatible endpoint handlers
import {
  handleListModels,
  handleGetModel,
  handleChatCompletions,
  handleImageGeneration,
  handleImageEdit,
  handleAudioSpeech,
  handleAudioTranscription,
  handleEmbeddings,
  handleVideoGeneration,
} from "./shared/api/openai/endpoints.js";

// Lazy-load heavy modules for cold start optimization
let hfModelsHandler: typeof import("./shared/models/providers/huggingface.js").handleGetHFModels;
let hfModelDetailsHandler: typeof import("./shared/models/providers/huggingface.js").handleGetHFModelDetails;
let hfTasksHandler: typeof import("./shared/models/providers/huggingface.js").handleGetHFTasks;
let agentverseSearch: typeof import("./external/agentverse.js").searchAgents;
let agentverseGet: typeof import("./external/agentverse.js").getAgent;
let agentverseExtractTags: typeof import("./external/agentverse.js").extractUniqueTags;
let agentverseExtractCategories: typeof import("./external/agentverse.js").extractUniqueCategories;
let models: typeof import("./shared/models/registry.js");

// Prod Servers URLs for proxying
const MCP_SERVER_URL = process.env.MCP_SERVICE_URL || "https://mcp.compose.market";
const MANOWAR_SERVER_URL = process.env.MANOWAR_SERVICE_URL || "https://manowar.compose.market";

async function loadModules() {
  if (!hfModelsHandler) {
    const hf = await import("./shared/models/providers/huggingface.js");
    hfModelsHandler = hf.handleGetHFModels;
    hfModelDetailsHandler = hf.handleGetHFModelDetails;
    hfTasksHandler = hf.handleGetHFTasks;
  }
  if (!agentverseSearch) {
    const av = await import("./external/agentverse.js");
    agentverseSearch = av.searchAgents;
    agentverseGet = av.getAgent;
    agentverseExtractTags = av.extractUniqueTags;
    agentverseExtractCategories = av.extractUniqueCategories;
  }
  if (!models) {
    models = await import("./shared/models/registry.js");
  }
}

// CORS headers - x402 needs x-payment header and exposed response headers
// Session headers for x402 bypass: x-session-active, x-session-budget-remaining
// Internal bypass: x-manowar-internal (for nested LLM calls from Manowar agents)
// Compose Keys: Authorization header for external clients
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-payment, X-PAYMENT, x-session-active, x-session-budget-remaining, x-session-user-address, x-manowar-internal, Access-Control-Expose-Headers",
  "Access-Control-Expose-Headers": "x-compose-key-budget-limit, x-compose-key-budget-used, x-compose-key-budget-remaining, *",
};

// Mock Express request/response for handler compatibility
function createMockReq(event: APIGatewayProxyEventV2) {
  const url = new URL(event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ""), "http://localhost");
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    originalUrl: event.rawPath,
    query: event.queryStringParameters || {},
    params: event.pathParameters || {},
    body: event.body ? JSON.parse(event.body) : {},
    headers: Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
    get: (header: string) => event.headers?.[header] || event.headers?.[header.toLowerCase()],
    protocol: "https",
  };
}

function createMockRes() {
  let statusCode = 200;
  let body: unknown = null;
  const headers: Record<string, string> = { ...corsHeaders };
  let headersSent = false;
  let isStreaming = false;
  let isBinary = false;
  const chunks: Buffer[] = [];

  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      body = JSON.stringify(data);
      headers["Content-Type"] = "application/json";
      return this;
    },
    send(data: Buffer | string) {
      if (Buffer.isBuffer(data)) {
        isBinary = true;
        body = data.toString("base64");
      } else {
        body = data;
      }
      headersSent = true;
      return this;
    },
    setHeader(key: string, value: string) {
      headers[key] = value;
      return this;
    },
    write(chunk: Buffer | string) {
      isStreaming = true;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end() {
      headersSent = true;
    },
    on(_event: string, _cb: () => void) {
      // No-op for Lambda
    },
    get headersSent() {
      return headersSent;
    },
    getResult(): APIGatewayProxyResultV2 {
      if (isStreaming) {
        return {
          statusCode,
          headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        };
      }
      if (isBinary) {
        return {
          statusCode,
          headers,
          body: body as string,
          isBase64Encoded: true,
        };
      }
      return {
        statusCode,
        headers,
        body: body as string,
      };
    },
  };
}

// Main handler
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

  await loadModules();

  const path = event.rawPath;
  const method = event.requestContext.http.method;

  try {
    // ==========================================================================
    // OpenAI-Compatible API v1 Routes (STANDARDIZED)
    // ==========================================================================

    // GET /v1/models - List available models (OpenAI format)
    if (method === "GET" && path === "/v1/models") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleListModels(req as any, res as any, false);
      return res.getResult();
    }

    // GET /v1/models/all - List ALL models including extended catalog
    if (method === "GET" && (path === "/v1/models/all" || event.queryStringParameters?.extended === "true")) {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleListModels(req as any, res as any, true);
      return res.getResult();
    }

    // GET /v1/models/:model - Get specific model details
    if (method === "GET" && path.startsWith("/v1/models/") && path !== "/v1/models/all") {
      const modelId = decodeURIComponent(path.replace("/v1/models/", ""));
      const req = createMockReq(event);
      (req as any).params = { model: modelId };
      const res = createMockRes();
      await handleGetModel(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/chat/completions - Chat completions (text-generation)
    if (method === "POST" && path === "/v1/chat/completions") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleChatCompletions(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/images/generations - Image generation
    if (method === "POST" && path === "/v1/images/generations") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleImageGeneration(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/images/edits - Image editing
    if (method === "POST" && path === "/v1/images/edits") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleImageEdit(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/audio/speech - Text to speech
    if (method === "POST" && path === "/v1/audio/speech") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleAudioSpeech(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/audio/transcriptions - Speech to text
    if (method === "POST" && path === "/v1/audio/transcriptions") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleAudioTranscription(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/embeddings - Create embeddings
    if (method === "POST" && path === "/v1/embeddings") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleEmbeddings(req as any, res as any);
      return res.getResult();
    }

    // POST /v1/videos/generations - Video generation
    if (method === "POST" && path === "/v1/videos/generations") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleVideoGeneration(req as any, res as any);
      return res.getResult();
    }

    // GET /v1/videos/:id - Check video generation status
    if (method === "GET" && path.startsWith("/v1/videos/") && path !== "/v1/videos/generations") {
      const { handleVideoStatus } = await import("./shared/api/openai/endpoints.js");
      const videoId = decodeURIComponent(path.split("/v1/videos/")[1]);
      const req = { ...createMockReq(event), params: { id: videoId } };
      const res = createMockRes();
      await handleVideoStatus(req as any, res as any);
      return res.getResult();
    }

    // Route: GET /api/pricing - Get pricing table
    if (method === "GET" && path === "/api/pricing") {
      const { DYNAMIC_PRICES } = await import("./shared/x402/pricing.js");
      const res = createMockRes();
      res.json({ prices: DYNAMIC_PRICES, version: "1.0" });
      return res.getResult();
    }

    // ==========================================================================
    // Compose Keys API Routes
    // ==========================================================================

    // POST /api/keys - Create a new Compose Key
    if (method === "POST" && path === "/api/keys") {
      const { createComposeKey } = await import("./shared/keys/index.js");
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
      });

      return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // GET /api/keys - List user's Compose Keys
    if (method === "GET" && path === "/api/keys") {
      const { listUserKeys } = await import("./shared/keys/index.js");
      const userAddress = event.headers["x-session-user-address"];

      if (!userAddress) {
        return {
          statusCode: 401,
          headers: corsHeaders,
          body: JSON.stringify({ error: "x-session-user-address header required" }),
        };
      }

      const keys = await listUserKeys(userAddress);

      // Return keys without tokens (security)
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

    // DELETE /api/keys/:keyId - Revoke a Compose Key
    if (method === "DELETE" && path.startsWith("/api/keys/")) {
      const { revokeKey } = await import("./shared/keys/index.js");
      const keyId = path.replace("/api/keys/", "");
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

    // Route: GET /api/models - Redirect to /v1/models
    if (method === "GET" && path === "/api/models") {
      const req = createMockReq(event);
      const res = createMockRes();
      await handleListModels(req as any, res as any, false);
      return res.getResult();
    }

    // ==========================================================================
    // Dynamic Model Registry Routes
    // ==========================================================================

    // Route: GET /api/registry/debug - Diagnostic endpoint for debugging model loading
    if (method === "GET" && path === "/api/registry/debug") {
      const registry = await models.getModelRegistry();
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          totalModels: registry.models.length,
          sources: registry.sources,
          lastUpdated: registry.lastUpdated,
          byProvider: Object.fromEntries(
            Object.entries(registry.sources || {}).map(([k, v]) => [k, (v as unknown as { count: number })?.count || 0])
          ),
          environment: {
            cwd: process.cwd(),
            nodeVersion: process.version,
            platform: process.platform,
            memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
          },
        }),
      };
    }

    // Route: GET /api/registry/models - Get all models from all providers (dynamic)
    if (method === "GET" && path === "/api/registry/models") {
      const registry = await models.getModelRegistry();
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(registry),
      };
    }

    // Route: GET /api/registry/models/available - Get only available models
    // Supports pagination: ?page=1&limit=100
    // Supports filters: ?provider=openai&task=text-generation&search=gpt
    // Supports ?refresh=true to force cache refresh
    if (method === "GET" && path === "/api/registry/models/available") {
      const query = event.queryStringParameters || {};
      const forceRefresh = query.refresh === "true";

      // Pagination params
      const page = Math.max(1, parseInt(query.page || "1", 10));
      const limit = Math.min(500, Math.max(1, parseInt(query.limit || "100", 10)));
      const offset = (page - 1) * limit;

      // Filter params
      const providerFilter = query.provider;
      const taskFilter = query.task;
      const searchQuery = query.search?.toLowerCase();

      // Get models (refresh if requested)
      let allModels: ModelCard[];
      if (forceRefresh) {
        const registry = await models.refreshRegistry();
        allModels = registry.models;
      } else {
        allModels = await models.getAvailableModels();
      }

      // Apply filters
      let filtered = allModels;
      if (providerFilter) {
        filtered = filtered.filter(m => m.provider === providerFilter);
      }
      if (taskFilter) {
        filtered = filtered.filter(m => m.taskType === taskFilter);
      }
      if (searchQuery) {
        filtered = filtered.filter(m =>
          m.modelId.toLowerCase().includes(searchQuery) ||
          m.name.toLowerCase().includes(searchQuery)
        );
      }

      // Paginate
      const paginated = filtered.slice(offset, offset + limit);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          models: paginated,
          total: filtered.length,
          page,
          limit,
          totalPages: Math.ceil(filtered.length / limit),
          hasMore: offset + limit < filtered.length,
        }),
      };
    }

    // Route: GET /api/registry/models/:source - Get models by source
    if (method === "GET" && path.match(/^\/api\/registry\/models\/(huggingface|asi-one|asi-cloud|openai|anthropic|google|openrouter|aiml)$/)) {
      const source = path.replace("/api/registry/models/", "") as any;
      const sourceModels = await models.getModelsBySource(source);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ source, models: sourceModels, total: sourceModels.length }),
      };
    }

    // Route: GET /api/registry/model/:modelId - Get specific model info
    if (method === "GET" && path.startsWith("/api/registry/model/")) {
      const modelId = decodeURIComponent(path.replace("/api/registry/model/", ""));
      const modelInfo = await models.getModelInfo(modelId);

      if (!modelInfo) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Model not found", modelId }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(modelInfo),
      };
    }

    // Route: POST /api/registry/refresh - Force refresh the model registry
    if (method === "POST" && path === "/api/registry/refresh") {
      const registry = await models.refreshRegistry();
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Registry refreshed",
          models: registry.models.length,
          sources: registry.sources,
          lastUpdated: registry.lastUpdated,
        }),
      };
    }

    // Route: GET /api/agentverse/agents
    if (method === "GET" && path === "/api/agentverse/agents") {
      const query = event.queryStringParameters || {};
      const result = await agentverseSearch({
        search: query.search,
        category: query.category,
        tags: query.tags ? query.tags.split(",") : undefined,
        status: query.status as "active" | "inactive" | undefined,
        limit: query.limit ? parseInt(query.limit, 10) : 30,
        offset: query.offset ? parseInt(query.offset, 10) : 0,
        sort: query.sort as any,
        direction: query.direction as "asc" | "desc" | undefined,
      });

      const uniqueTags = agentverseExtractTags(result.agents);
      const uniqueCategories = agentverseExtractCategories(result.agents);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: result.agents,
          total: result.total,
          offset: result.offset,
          limit: result.limit,
          tags: uniqueTags,
          categories: uniqueCategories,
        }),
      };
    }

    // Route: GET /api/agentverse/agents/:address
    if (method === "GET" && path.startsWith("/api/agentverse/agents/")) {
      const address = path.replace("/api/agentverse/agents/", "");
      const agent = await agentverseGet(address);

      if (!agent) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Agent not found" }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(agent),
      };
    }

    // Route: GET /api/agent/:agentId - A2A-compliant Agent Card endpoint
    // Returns agent card JSON for on-chain Manowar agents
    if (method === "GET" && path.match(/^\/api\/agent\/\d+$/)) {
      const agentId = path.replace("/api/agent/", "");

      // Return A2A Agent Card format
      // The actual data is fetched from on-chain by the frontend
      // This endpoint serves as the canonical URL for the agent
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "1.0.0",
          agentId: parseInt(agentId, 10),
          endpoint: `https://manowar.compose.market/agent/${agentId}/chat`,
          protocols: [
            { name: "x402", version: "1.0" },
            { name: "a2a", version: "1.0" },
          ],
          capabilities: ["inference", "workflow"],
          registry: "manowar",
          chain: 43113, // Avalanche Fuji
          contract: "0xb6d62374Ba0076bE2c1020b6a8BBD1b3c67052F7",
          // Full metadata is stored on IPFS, referenced by agentCardUri on-chain
        }),
      };
    }

    // Route: POST /api/agent/:agentId/invoke - A2A invoke endpoint
    // This is where agent calls are routed through x402 payment
    if (method === "POST" && path.match(/^\/api\/agent\/\d+\/invoke$/)) {
      const agentId = path.replace("/api/agent/", "").replace("/invoke", "");

      // Forward to chat completions handler with agent context
      const req = createMockReq(event);
      req.body = {
        ...req.body,
        agentId: parseInt(agentId, 10),
      };
      const res = createMockRes();
      await handleChatCompletions(req as any, res as any);
      return res.getResult();
    }

    // ==========================================================================
    // MCP/Plugin Routes - Proxied to MCP Server with x402 payment
    // ==========================================================================

    // Route: GET /api/mcp/plugins - List all available GOAT plugins (dynamically)
    if (method === "GET" && path === "/api/mcp/plugins") {
      try {
        const response = await fetch(`${MCP_SERVER_URL}/goat/plugins`);
        const data = await response.json();
        return {
          statusCode: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "MCP server unavailable", message: String(error) }),
        };
      }
    }

    // Route: GET /api/mcp/tools - List ALL GOAT tools across all plugins
    if (method === "GET" && path === "/api/mcp/tools") {
      try {
        const response = await fetch(`${MCP_SERVER_URL}/goat/tools`);
        const data = await response.json();
        return {
          statusCode: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "MCP server unavailable", message: String(error) }),
        };
      }
    }

    // Route: GET /api/mcp/status - Get GOAT runtime status
    if (method === "GET" && path === "/api/mcp/status") {
      try {
        const response = await fetch(`${MCP_SERVER_URL}/goat/status`);
        const data = await response.json();
        return {
          statusCode: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "MCP server unavailable", message: String(error) }),
        };
      }
    }

    // Route: GET /api/mcp/:pluginId/tools - List tools for a plugin with full JSON schemas
    if (method === "GET" && path.match(/^\/api\/mcp\/[^/]+\/tools$/)) {
      const pluginId = path.replace("/api/mcp/", "").replace("/tools", "");
      try {
        const response = await fetch(`${MCP_SERVER_URL}/goat/${encodeURIComponent(pluginId)}/tools`);
        const data = await response.json();
        return {
          statusCode: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Failed to fetch tools for ${pluginId}`, message: String(error) }),
        };
      }
    }

    // Route: GET /api/mcp/:pluginId/tools/:toolName - Get specific tool schema
    if (method === "GET" && path.match(/^\/api\/mcp\/[^/]+\/tools\/[^/]+$/)) {
      const parts = path.replace("/api/mcp/", "").split("/tools/");
      const pluginId = parts[0];
      const toolName = parts[1];
      try {
        const response = await fetch(`${MCP_SERVER_URL}/goat/${encodeURIComponent(pluginId)}/tools/${encodeURIComponent(toolName)}`);
        const data = await response.json();
        return {
          statusCode: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Failed to fetch tool ${toolName}`, message: String(error) }),
        };
      }
    }

    // Route: POST /api/mcp/:pluginId/execute - Execute a plugin tool with x402 payment
    if (method === "POST" && path.match(/^\/api\/mcp\/[^/]+\/execute$/)) {
      const pluginId = path.replace("/api/mcp/", "").replace("/execute", "");
      const body = event.body ? JSON.parse(event.body) : {};

      // Forward x-payment header to MCP server for proper x402 handling
      // The MCP server uses handleX402Payment which returns proper x402 protocol response
      const paymentHeader = event.headers["x-payment"] || event.headers["X-PAYMENT"];

      try {
        const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (paymentHeader) {
          fetchHeaders["x-payment"] = paymentHeader;
        }

        const response = await fetch(`${MCP_SERVER_URL}/goat/${encodeURIComponent(pluginId)}/execute`, {
          method: "POST",
          headers: fetchHeaders,
          body: JSON.stringify(body),
        });

        // Collect response headers (includes x402 headers for 402 responses)
        const responseHeaders: Record<string, string> = { ...corsHeaders };
        response.headers.forEach((value, key) => {
          // Preserve x402 protocol headers
          const lowerKey = key.toLowerCase();
          if (lowerKey.startsWith("x-") || lowerKey === "content-type" || lowerKey === "access-control-expose-headers") {
            responseHeaders[key] = value;
          }
        });

        const data = await response.json();

        // Calculate action cost: 1% fee on any gas/fees spent (only on success)
        if (response.status === 200) {
          const actionCost = (data as { gasCost?: number }).gasCost || 0;
          const platformFee = actionCost * 0.01;
          const totalCost = actionCost + platformFee;
          responseHeaders["X-Action-Cost"] = actionCost.toString();
          responseHeaders["X-Platform-Fee"] = platformFee.toFixed(6);
          responseHeaders["X-Total-Cost"] = totalCost.toFixed(6);
        }

        return {
          statusCode: response.status,
          headers: responseHeaders,
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Failed to execute ${pluginId}`, message: String(error) }),
        };
      }
    }

    // Route: GET /api/mcp/servers - List MCP servers
    if (method === "GET" && path === "/api/mcp/servers") {
      try {
        const response = await fetch(`${MCP_SERVER_URL}/servers`);
        const data = await response.json();
        return {
          statusCode: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "MCP server unavailable", message: String(error) }),
        };
      }
    }

    // Route: POST /api/mcp/servers/:slug/call - Call MCP server tool
    if (method === "POST" && path.match(/^\/api\/mcp\/servers\/[^/]+\/call$/)) {
      const slug = path.replace("/api/mcp/servers/", "").replace("/call", "");
      const body = event.body ? JSON.parse(event.body) : {};
      const { tool, args } = body;

      if (!tool) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "tool is required in request body" }),
        };
      }

      // Forward x-payment header to MCP server for proper x402 handling
      const paymentHeader = event.headers["x-payment"] || event.headers["X-PAYMENT"];

      try {
        const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (paymentHeader) {
          fetchHeaders["x-payment"] = paymentHeader;
        }

        // Call MCP server's actual route: /mcp/servers/:serverId/tools/:toolName
        const response = await fetch(`${MCP_SERVER_URL}/mcp/servers/${encodeURIComponent(slug)}/tools/${encodeURIComponent(tool)}`, {
          method: "POST",
          headers: fetchHeaders,
          body: JSON.stringify({ args }),
        });

        // Collect response headers (includes x402 headers for 402 responses)
        const responseHeaders: Record<string, string> = { ...corsHeaders };
        response.headers.forEach((value, key) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey.startsWith("x-") || lowerKey === "content-type" || lowerKey === "access-control-expose-headers") {
            responseHeaders[key] = value;
          }
        });

        // Handle non-OK responses with detailed error info
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Unknown MCP error" }));
          return {
            statusCode: response.status,
            headers: responseHeaders,
            body: JSON.stringify({
              success: false,
              error: errorData.error || errorData.message || `MCP tool execution failed`,
              details: errorData,
              serverId: slug,
              tool,
            }),
          };
        }

        const data = await response.json();
        return {
          statusCode: response.status,
          headers: responseHeaders,
          body: JSON.stringify(data),
        };
      } catch (error) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Failed to call ${slug}`, message: String(error) }),
        };
      }
    }

    // ==========================================================================
    // Mem0 Memory API Routes
    // ==========================================================================

    // Route: POST /api/memory/add - Add memory
    if (method === "POST" && path === "/api/memory/add") {
      const body = event.body ? JSON.parse(event.body) : {};

      try {
        const mem0 = await import("./shared/mem0.js");
        const result = await mem0.addMemory(body);
        return {
          statusCode: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(result),
        };
      } catch (error) {
        return {
          statusCode: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Failed to add memory", message: String(error) }),
        };
      }
    }

    // Route: POST /api/memory/search - Search memory
    if (method === "POST" && path === "/api/memory/search") {
      const body = event.body ? JSON.parse(event.body) : {};

      try {
        const mem0 = await import("./shared/mem0.js");
        const result = await mem0.searchMemory(body);
        return {
          statusCode: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(result),
        };
      } catch (error) {
        return {
          statusCode: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Failed to search memory", message: String(error) }),
        };
      }
    }

    // ==========================================================================
    // Avatar Generation for Create Agent
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
        const { invokeImage } = await import("./shared/models/invoke.js");
        const brandStyle = `Cyberpunk aesthetic with neon cyan (#22d3ee) and hot fuchsia (#d946ef) accents on dark obsidian background (#020617). High-tech futuristic feel with glass panels, circuit patterns, and subtle glow effects.`;
        const prompt = `Agent Name: ${title}
Agent Description: ${description}
Brand Style: ${brandStyle}

Create a professional square avatar icon for this AI agent. Clean, iconic design suitable for small sizes. No text.`;

        console.log("[generate-avatar] Prompt length:", prompt.length);

        // Generate image using Flux Schnell (routes through HF -> fal-ai fallback)
        const result = await invokeImage("black-forest-labs/FLUX.1-schnell", prompt, {
          size: "1024x1024",
          n: 1,
        });

        // Return base64 image
        const base64Image = result.buffer.toString("base64");
        const dataUrl = `data:${result.mimeType};base64,${base64Image}`;

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

    // ==========================================================================
    // Banner Generation for Compose Manowar
    // ==========================================================================

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
        const { invokeImage } = await import("./shared/models/invoke.js");
        const brandStyle = `Cyberpunk aesthetic with neon cyan (#22d3ee) and hot fuchsia (#d946ef) accents on dark obsidian background (#020617). High-tech futuristic feel with glass panels, circuit patterns, and subtle glow effects.`;
        const prompt = `Workflow Title: ${title}
Workflow Description: ${description}
Brand Style: ${brandStyle}

Create a professional wide banner image for an AI workflow orchestration system. Landscape format, abstract tech visualization with connected nodes, data flows, or circuit patterns. No text or logos. Dark background with neon accent highlights.`;

        console.log("[generate-banner] Prompt length:", prompt.length);

        // Generate image using Flux Schnell with landscape dimensions
        const result = await invokeImage("black-forest-labs/FLUX.1-schnell", prompt, {
          size: "1792x1024", // Landscape aspect ratio for banners
          n: 1,
        });

        // Return base64 image
        const base64Image = result.buffer.toString("base64");
        const dataUrl = `data:${result.mimeType};base64,${base64Image}`;

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
    console.error("Lambda handler error:", error);
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

