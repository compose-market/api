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
let modelsHandler: typeof import("./inference").handleGetModels;
let hfModelsHandler: typeof import("./huggingface").handleGetHFModels;
let hfModelDetailsHandler: typeof import("./huggingface").handleGetHFModelDetails;
let hfTasksHandler: typeof import("./huggingface").handleGetHFTasks;
let agentverseSearch: typeof import("./agentverse").searchAgents;
let agentverseGet: typeof import("./agentverse").getAgent;
let agentverseExtractTags: typeof import("./agentverse").extractUniqueTags;
let agentverseExtractCategories: typeof import("./agentverse").extractUniqueCategories;

async function loadModules() {
  if (!inferenceHandler) {
    const inference = await import("./inference");
    inferenceHandler = inference.handleInference;
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
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-payment, x-session-active, x-session-budget-remaining",
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
    // Route: POST /api/inference
    if (method === "POST" && path === "/api/inference") {
      const req = createMockReq(event);
      const res = createMockRes();
      await inferenceHandler(req as any, res as any);
      return res.getResult();
    }

    // Route: GET /api/models
    if (method === "GET" && path === "/api/models") {
      const req = createMockReq(event);
      const res = createMockRes();
      modelsHandler(req as any, res as any);
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

