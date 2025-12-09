/**
 * AWS Lambda Handler for Compose Market API
 * 
 * Handles:
 * - /api/inference - AI inference with x402 payments
 * - /api/models - Model listing
 * - /api/hf/* - HuggingFace endpoints
 * - /api/agentverse/* - Agentverse endpoints
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";

// Lazy-load heavy modules for cold start optimization
let inferenceHandler: typeof import("./inference").handleInference;
let multimodalHandler: typeof import("./inference").handleMultimodalInference;
let modelsHandler: typeof import("./inference").handleGetModels;
let hfModelsHandler: typeof import("./huggingface").handleGetHFModels;
let hfModelDetailsHandler: typeof import("./huggingface").handleGetHFModelDetails;
let hfTasksHandler: typeof import("./huggingface").handleGetHFTasks;
let agentverseSearch: typeof import("./agentverse").searchAgents;
let agentverseGet: typeof import("./agentverse").getAgent;
let agentverseExtractTags: typeof import("./agentverse").extractUniqueTags;
let agentverseExtractCategories: typeof import("./agentverse").extractUniqueCategories;
let models: typeof import("./shared/models");

// MCP Server URL for proxying
const MCP_SERVER_URL = process.env.MCP_SERVICE_URL || "https://mcp.compose.market";

async function loadModules() {
  if (!inferenceHandler) {
    const inference = await import("./inference");
    inferenceHandler = inference.handleInference;
    multimodalHandler = inference.handleMultimodalInference;
    modelsHandler = inference.handleGetModels;
  }
  if (!hfModelsHandler) {
    const hf = await import("./huggingface");
    hfModelsHandler = hf.handleGetHFModels;
    hfModelDetailsHandler = hf.handleGetHFModelDetails;
    hfTasksHandler = hf.handleGetHFTasks;
  }
  if (!agentverseSearch) {
    const av = await import("./agentverse");
    agentverseSearch = av.searchAgents;
    agentverseGet = av.getAgent;
    agentverseExtractTags = av.extractUniqueTags;
    agentverseExtractCategories = av.extractUniqueCategories;
  }
  if (!models) {
    models = await import("./shared/models");
  }
}

// CORS headers - x402 needs x-payment header and exposed response headers
// Session headers for x402 bypass: x-session-active, x-session-budget-remaining
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-payment, X-PAYMENT, x-session-active, x-session-budget-remaining, Access-Control-Expose-Headers",
  "Access-Control-Expose-Headers": "*",
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
    // Route: POST /api/inference - Uses multimodal handler for all tasks
    if (method === "POST" && path === "/api/inference") {
      const req = createMockReq(event);
      const res = createMockRes();
      // Use multimodal handler which routes based on modelId/task
      await multimodalHandler(req as any, res as any);
      return res.getResult();
    }

    // Route: GET /api/models - Legacy endpoint
    if (method === "GET" && path === "/api/models") {
      const req = createMockReq(event);
      const res = createMockRes();
      await modelsHandler(req as any, res as any);
      return res.getResult();
    }

    // ==========================================================================
    // Dynamic Model Registry Routes
    // ==========================================================================

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
    if (method === "GET" && path === "/api/registry/models/available") {
      const availableModels = await models.getAvailableModels();
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ models: availableModels, total: availableModels.length }),
      };
    }

    // Route: GET /api/registry/models/:source - Get models by source
    if (method === "GET" && path.match(/^\/api\/registry\/models\/(huggingface|asi-one|asi-cloud|openai|anthropic|google)$/)) {
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

    // Route: POST /api/inference/:modelId - Inference with dynamic model (supports multimodal)
    // Model IDs can contain slashes (e.g., "Comfy-Org/flux2-dev")
    if (method === "POST" && path.startsWith("/api/inference/") && path !== "/api/inference/") {
      const modelId = decodeURIComponent(path.slice("/api/inference/".length));
      const req = createMockReq(event);
      req.params = { modelId };
      req.body = {
        ...req.body,
        modelId, // Override modelId from path
      };
      const res = createMockRes();
      // Use multimodal handler which routes based on task type
      await multimodalHandler(req as any, res as any);
      return res.getResult();
    }

    // Route: GET /api/hf/models
    if (method === "GET" && path === "/api/hf/models") {
      const req = createMockReq(event);
      const res = createMockRes();
      await hfModelsHandler(req as any, res as any);
      return res.getResult();
    }

    // Route: GET /api/hf/models/:modelId/details
    if (method === "GET" && path.startsWith("/api/hf/models/") && path.endsWith("/details")) {
      const modelId = path.replace("/api/hf/models/", "").replace("/details", "");
      const req = createMockReq(event);
      req.params = { modelId };
      const res = createMockRes();
      await hfModelDetailsHandler(req as any, res as any);
      return res.getResult();
    }

    // Route: GET /api/hf/tasks
    if (method === "GET" && path === "/api/hf/tasks") {
      const req = createMockReq(event);
      const res = createMockRes();
      hfTasksHandler(req as any, res as any);
      return res.getResult();
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
          endpoint: `https://api.compose.market/api/agent/${agentId}/invoke`,
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

      // Forward to inference handler with agent context
      const req = createMockReq(event);
      req.body = {
        ...req.body,
        agentId: parseInt(agentId, 10),
      };
      const res = createMockRes();
      await inferenceHandler(req as any, res as any);
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

      // Forward x-payment header to MCP server for proper x402 handling
      const paymentHeader = event.headers["x-payment"] || event.headers["X-PAYMENT"];

      try {
        const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (paymentHeader) {
          fetchHeaders["x-payment"] = paymentHeader;
        }

        const response = await fetch(`${MCP_SERVER_URL}/servers/${encodeURIComponent(slug)}/call`, {
          method: "POST",
          headers: fetchHeaders,
          body: JSON.stringify(body),
        });

        // Collect response headers (includes x402 headers for 402 responses)
        const responseHeaders: Record<string, string> = { ...corsHeaders };
        response.headers.forEach((value, key) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey.startsWith("x-") || lowerKey === "content-type" || lowerKey === "access-control-expose-headers") {
            responseHeaders[key] = value;
          }
        });

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

