import "dotenv/config";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

import { handler } from "../handler.js";
import { resolveModel } from "../shared/models/registry.js";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }

interface InvokeResult {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: JsonObject | null;
}

interface ModelEntry {
  id: string;
  provider?: string;
  task_type?: string;
  capabilities?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
}

const CHECK_CHAIN_ID = process.env.CHECK_CHAIN_ID || process.env.ACTIVE_CHAIN_ID || "338";

function fail(message: string): never {
  throw new Error(message);
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    fail(message);
  }
  return value;
}

function toJson(bodyText: string): JsonObject | null {
  try {
    return JSON.parse(bodyText) as JsonObject;
  } catch {
    return null;
  }
}

function buildEvent(method: string, path: string, body?: unknown, headers?: Record<string, string>): APIGatewayProxyEventV2 {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: normalizedHeaders,
    requestContext: {
      accountId: "local",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "localhost",
      requestId: `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      routeKey: "$default",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "compose-market-check",
      },
    },
    isBase64Encoded: false,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as APIGatewayProxyEventV2;
}

async function invoke(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<InvokeResult> {
  const event = buildEvent(method, path, options?.body, options?.headers);
  const result = await handler(event, {} as Context);
  if (typeof result === "string") {
    return {
      statusCode: 200,
      headers: {},
      bodyText: result,
      bodyJson: toJson(result),
    };
  }

  return {
    statusCode: result.statusCode || 0,
    headers: (result.headers || {}) as Record<string, string>,
    bodyText: typeof result.body === "string" ? result.body : "",
    bodyJson: typeof result.body === "string" ? toJson(result.body) : null,
  };
}

function hasProviderKey(provider: string | undefined): boolean {
  if (!provider) return false;
  const name = provider.toLowerCase();

  if (name === "openai") return Boolean(process.env.OPENAI_API_KEY);
  if (name === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (name === "google") return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (name === "vertex") return Boolean(process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY);
  if (name === "openrouter") return Boolean(process.env.OPEN_ROUTER_API_KEY);
  if (name === "huggingface") return Boolean(process.env.HUGGING_FACE_INFERENCE_TOKEN);
  if (name === "aiml") return Boolean(process.env.AI_ML_API_KEY);
  if (name === "asi-one") return Boolean(process.env.ASI_ONE_API_KEY);
  if (name === "asi-cloud") return Boolean(process.env.ASI_INFERENCE_API_KEY);

  return false;
}

function pickTextModel(models: ModelEntry[]): ModelEntry {
  if (process.env.CHECK_TEXT_MODEL) {
    const found = models.find((model) => model.id === process.env.CHECK_TEXT_MODEL);
    if (found) return found;
    fail(`CHECK_TEXT_MODEL '${process.env.CHECK_TEXT_MODEL}' not found in /v1/models`);
  }

  const preferredOpenAI = [
    "gpt-4o-mini",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4.1",
    "gpt-5-mini",
    "gpt-5",
  ];

  for (const modelId of preferredOpenAI) {
    const match = models.find((model) => model.id === modelId && model.provider === "openai" && hasProviderKey(model.provider));
    if (match) {
      return match;
    }
  }

  const deprecatedRegex = /(babbage|davinci|curie|ada|gpt-3\.5|instruct|moderation|search-preview|realtime-preview|audio-preview|vision-preview)/i;

  const preferred = models.find((model) => {
    const task = (model.task_type || "").toLowerCase();
    if (!hasProviderKey(model.provider)) return false;
    if (deprecatedRegex.test(model.id)) return false;
    if (task.includes("image") || task.includes("video") || task.includes("speech") || task.includes("audio")) return false;
    if (task.includes("embedding") || task.includes("feature-extraction")) return false;
    return true;
  });

  if (!preferred) {
    fail("No text-capable model found with configured provider credentials. Set CHECK_TEXT_MODEL or provider API keys.");
  }

  return preferred;
}

function pickEmbeddingModel(models: ModelEntry[], fallback: ModelEntry): ModelEntry {
  if (process.env.CHECK_EMBED_MODEL) {
    const found = models.find((model) => model.id === process.env.CHECK_EMBED_MODEL);
    if (found) return found;
    fail(`CHECK_EMBED_MODEL '${process.env.CHECK_EMBED_MODEL}' not found in /v1/models`);
  }

  const preferredEmbeddingIds = [
    "text-embedding-3-small",
    "text-embedding-3-large",
  ];
  for (const modelId of preferredEmbeddingIds) {
    const match = models.find((model) => model.id === modelId && hasProviderKey(model.provider));
    if (match) {
      return match;
    }
  }

  const preferred = models.find((model) => {
    const task = (model.task_type || "").toLowerCase();
    const caps = model.capabilities || [];
    if (!hasProviderKey(model.provider)) return false;
    return task.includes("embedding") || task.includes("feature-extraction") || caps.includes("embeddings");
  });

  return preferred || fallback;
}

function paymentHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-chain-id": CHECK_CHAIN_ID,
  };

  if (process.env.MANOWAR_INTERNAL_SECRET) {
    headers["x-manowar-internal"] = process.env.MANOWAR_INTERNAL_SECRET;
    return headers;
  }

  if (process.env.CHECK_COMPOSE_KEY) {
    headers.authorization = `Bearer ${process.env.CHECK_COMPOSE_KEY}`;
    return headers;
  }

  if (process.env.CHECK_PAYMENT_SIGNATURE) {
    headers["payment-signature"] = process.env.CHECK_PAYMENT_SIGNATURE;
    return headers;
  }

  fail("No test payment path configured. Set MANOWAR_INTERNAL_SECRET or CHECK_COMPOSE_KEY or CHECK_PAYMENT_SIGNATURE.");
}

function assertStatus(result: InvokeResult, accepted: number[], context: string): void {
  if (!accepted.includes(result.statusCode)) {
    fail(`${context} failed: expected status ${accepted.join("/")}, got ${result.statusCode}. Body: ${result.bodyText.slice(0, 500)}`);
  }
}

function logStep(message: string): void {
  console.log(`\n[check] ${message}`);
}

async function main(): Promise<void> {
  const authHeaders = paymentHeaders();

  logStep("Loading model catalog via /v1/models");
  const modelsResult = await invoke("GET", "/v1/models", { headers: { "content-type": "application/json" } });
  assertStatus(modelsResult, [200], "GET /v1/models");

  const modelData = modelsResult.bodyJson?.data;
  if (!Array.isArray(modelData) || modelData.length === 0) {
    fail("/v1/models returned empty model list");
  }

  const models = modelData as unknown as ModelEntry[];
  const textModel = pickTextModel(models);
  const embedModel = pickEmbeddingModel(models, textModel);

  requireValue(textModel.id, "Selected text model has no id");
  requireValue(textModel.provider, "Selected text model has no provider");

  logStep(`Selected text model: ${textModel.id} (${textModel.provider})`);
  logStep(`Selected embedding model: ${embedModel.id} (${embedModel.provider || "unknown"})`);

  logStep("Validating resolveModel unknown explicit-provider path");
  const unknownModelId = `unknown-model-check-${Date.now()}`;
  const resolvedUnknown = resolveModel(unknownModelId, textModel.provider as any);
  if (resolvedUnknown.known) {
    fail("resolveModel unknown explicit-provider unexpectedly marked known=true");
  }
  let threwWithoutProvider = false;
  try {
    resolveModel(unknownModelId);
  } catch {
    threwWithoutProvider = true;
  }
  if (!threwWithoutProvider) {
    fail("resolveModel unknown without provider did not throw");
  }

  logStep("Testing POST /v1/responses (non-stream)");
  const responsesCreate = await invoke("POST", "/v1/responses", {
    headers: authHeaders,
    body: {
      model: textModel.id,
      input: [{ role: "user", content: "Reply with exactly OK" }],
      modalities: ["text"],
      stream: false,
    },
  });
  assertStatus(responsesCreate, [200], "POST /v1/responses");
  const responseId = responsesCreate.bodyJson?.id;
  if (typeof responseId !== "string" || !responseId) {
    fail("POST /v1/responses did not return a response id");
  }

  logStep("Testing GET /v1/responses/:id");
  const responseFetch = await invoke("GET", `/v1/responses/${encodeURIComponent(responseId)}`, {
    headers: authHeaders,
  });
  assertStatus(responseFetch, [200], "GET /v1/responses/:id");

  logStep("Testing GET /v1/responses/:id without payment (must not double-charge)");
  const responseFetchNoPay = await invoke("GET", `/v1/responses/${encodeURIComponent(responseId)}`, {
    headers: { "content-type": "application/json" },
  });
  assertStatus(responseFetchNoPay, [200], "GET /v1/responses/:id (no payment)");

  logStep("Testing POST /v1/responses/:id/cancel");
  const responseCancel = await invoke("POST", `/v1/responses/${encodeURIComponent(responseId)}/cancel`, {
    headers: authHeaders,
    body: {},
  });
  assertStatus(responseCancel, [200], "POST /v1/responses/:id/cancel");
  const cancelStatus = responseCancel.bodyJson?.status;
  if (cancelStatus !== "cancelled") {
    fail(`Expected cancelled status after cancel, got '${String(cancelStatus)}'`);
  }

  logStep("Testing POST /v1/responses/:id/cancel without payment (must not double-charge)");
  const responseCancelNoPay = await invoke("POST", `/v1/responses/${encodeURIComponent(responseId)}/cancel`, {
    headers: { "content-type": "application/json" },
    body: {},
  });
  assertStatus(responseCancelNoPay, [200], "POST /v1/responses/:id/cancel (no payment)");

  logStep("Testing POST /v1/responses (stream)");
  const responsesStream = await invoke("POST", "/v1/responses", {
    headers: authHeaders,
    body: {
      model: textModel.id,
      input: [{ role: "user", content: "Say hello in one short sentence." }],
      modalities: ["text"],
      stream: true,
    },
  });
  assertStatus(responsesStream, [200], "POST /v1/responses stream");
  if (!responsesStream.bodyText.includes("[DONE]") || !responsesStream.bodyText.includes("response.")) {
    fail("Streaming /v1/responses did not contain expected SSE response events");
  }

  logStep("Testing POST /v1/chat/completions adapter");
  const chatResult = await invoke("POST", "/v1/chat/completions", {
    headers: authHeaders,
    body: {
      model: textModel.id,
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      stream: false,
    },
  });
  assertStatus(chatResult, [200], "POST /v1/chat/completions");
  if (chatResult.bodyJson?.object !== "chat.completion") {
    fail("/v1/chat/completions did not return chat.completion shape");
  }

  logStep("Testing POST /v1/embeddings adapter");
  const embeddingResult = await invoke("POST", "/v1/embeddings", {
    headers: authHeaders,
    body: {
      model: embedModel.id,
      input: "compose market embedding check",
    },
  });
  assertStatus(embeddingResult, [200], "POST /v1/embeddings");
  const embeddingData = embeddingResult.bodyJson?.data;
  if (!Array.isArray(embeddingData) || embeddingData.length === 0) {
    fail("/v1/embeddings returned no embedding vectors");
  }

  logStep("Testing unknown model with explicit provider (no registry hard-fail)");
  const unknownCall = await invoke("POST", "/v1/responses", {
    headers: authHeaders,
    body: {
      model: unknownModelId,
      provider: textModel.provider,
      input: [{ role: "user", content: "Reply with OK" }],
      modalities: ["text"],
      stream: false,
    },
  });
  if (unknownCall.statusCode === 500) {
    fail(`Unknown explicit-provider call returned 500: ${unknownCall.bodyText.slice(0, 500)}`);
  }
  if (unknownCall.bodyText.includes("Provide an explicit provider for unknown models")) {
    fail("Unknown explicit-provider call was blocked by registry pre-validation");
  }

  console.log("\n[check] SUCCESS: Inference runtime passes local production validation.");
  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[check] FAILURE: ${message}`);
  process.exit(1);
});
