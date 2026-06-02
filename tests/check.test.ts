import "dotenv/config";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { registerInferenceRoutes } from "../inference/gateway.js";
import { resolveModel } from "../inference/catalog/registry.js";

if (process.env.RUN_RUNTIME_CHECKS !== "1") {
  console.log("[check] SKIP: set RUN_RUNTIME_CHECKS=1 to run live inference runtime checks.");
  process.exit(0);
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }

interface InvokeResult {
  statusCode: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: JsonObject | null;
}

interface ModelEntry {
  modelId: string;
  provider?: string;
  type?: string | string[] | null;
}

const CHECK_CHAIN_ID = process.env.CHECK_CHAIN_ID || process.env.ACTIVE_CHAIN_ID || "338";
let inferenceServer: Server | null = null;
let inferenceBaseUrl: string | null = null;

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

async function ensureInferenceServer(): Promise<string> {
  if (inferenceBaseUrl) {
    return inferenceBaseUrl;
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  registerInferenceRoutes(app);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  inferenceServer = createServer(app);
  await new Promise<void>((resolve) => {
    inferenceServer!.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = inferenceServer.address() as AddressInfo;
  inferenceBaseUrl = `http://127.0.0.1:${port}`;
  return inferenceBaseUrl;
}

async function invoke(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<InvokeResult> {
  const baseUrl = await ensureInferenceServer();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options?.headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const bodyText = await response.text();

  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText,
    bodyJson: toJson(bodyText),
  };
}

async function stopInferenceServer(): Promise<void> {
  if (!inferenceServer) {
    return;
  }

  const server = inferenceServer;
  inferenceServer = null;
  inferenceBaseUrl = null;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function hasProviderKey(provider: string | undefined): boolean {
  if (!provider) return false;
  const name = provider.toLowerCase();

  if (name === "openai") return Boolean(process.env.OPENAI_API_KEY);
  if (name === "gemini") return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (name === "vertex") return Boolean(process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY);
  if (name === "fireworks") return Boolean(process.env.FIREWORKS_API_KEY);
  if (name === "hugging face") return Boolean(process.env.HUGGING_FACE_INFERENCE_TOKEN);
  if (name === "aiml") return Boolean(process.env.AI_ML_API_KEY);
  if (name === "cloudflare") return Boolean(process.env.CF_API_TOKEN);
  if (name === "asicloud") return Boolean(process.env.ASI_INFERENCE_API_KEY);

  return false;
}

function getModelTypes(model: ModelEntry): string[] {
  if (typeof model.type === "string") {
    return [model.type.toLowerCase()];
  }
  if (Array.isArray(model.type)) {
    return model.type.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  }
  return [];
}

function pickTextModel(models: ModelEntry[]): ModelEntry {
  if (process.env.CHECK_TEXT_MODEL) {
    const found = models.find((model) => model.modelId === process.env.CHECK_TEXT_MODEL);
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
    const match = models.find((model) => model.modelId === modelId && model.provider === "openai" && hasProviderKey(model.provider));
    if (match) {
      return match;
    }
  }

  const deprecatedRegex = /(babbage|davinci|curie|ada|gpt-3\.5|instruct|moderation|search-preview|realtime-preview|audio-preview|vision-preview)/i;

  const preferred = models.find((model) => {
    const types = getModelTypes(model);
    if (!hasProviderKey(model.provider)) return false;
    if (deprecatedRegex.test(model.modelId)) return false;
    if (types.some((type) => type.includes("image") || type.includes("video") || type.includes("speech") || type.includes("audio"))) return false;
    if (types.some((type) => type.includes("embedding") || type.includes("feature-extraction"))) return false;
    return true;
  });

  if (!preferred) {
    fail("No text-capable model found with configured provider credentials. Set CHECK_TEXT_MODEL or provider API keys.");
  }

  return preferred;
}

function pickEmbeddingModel(models: ModelEntry[], fallback: ModelEntry): ModelEntry {
  if (process.env.CHECK_EMBED_MODEL) {
    const found = models.find((model) => model.modelId === process.env.CHECK_EMBED_MODEL);
    if (found) return found;
    fail(`CHECK_EMBED_MODEL '${process.env.CHECK_EMBED_MODEL}' not found in /v1/models`);
  }

  const preferredEmbeddingIds = [
    "text-embedding-3-small",
    "text-embedding-3-large",
  ];
  for (const modelId of preferredEmbeddingIds) {
    const match = models.find((model) => model.modelId === modelId && hasProviderKey(model.provider));
    if (match) {
      return match;
    }
  }

  const preferred = models.find((model) => {
    const types = getModelTypes(model);
    if (!hasProviderKey(model.provider)) return false;
    return types.some((type) => type.includes("embedding") || type.includes("feature-extraction"));
  });

  return preferred || fallback;
}

function paymentHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-chain-id": CHECK_CHAIN_ID,
  };

  if (process.env.CHECK_COMPOSE_KEY) {
    headers.authorization = `Bearer ${process.env.CHECK_COMPOSE_KEY}`;
    return headers;
  }

  if (process.env.CHECK_PAYMENT_SIGNATURE) {
    headers["payment-signature"] = process.env.CHECK_PAYMENT_SIGNATURE;
    return headers;
  }

  fail("No test payment path configured. Set CHECK_COMPOSE_KEY or CHECK_PAYMENT_SIGNATURE.");
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
  try {
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

    requireValue(textModel.modelId, "Selected text model has no modelId");
    requireValue(textModel.provider, "Selected text model has no provider");

    logStep(`Selected text model: ${textModel.modelId} (${textModel.provider})`);
    logStep(`Selected embedding model: ${embedModel.modelId} (${embedModel.provider || "unknown"})`);

    logStep("Validating resolveModel requires catalog model identity");
    const unknownModelId = `unknown-model-check-${Date.now()}`;
    let threwWithoutProvider = false;
    try {
      resolveModel(unknownModelId);
    } catch {
      threwWithoutProvider = true;
    }
    if (!threwWithoutProvider) {
      fail("resolveModel unknown model did not throw");
    }

    logStep("Testing POST /v1/responses (non-stream)");
    const responsesCreate = await invoke("POST", "/v1/responses", {
      headers: authHeaders,
      body: {
        model: textModel.modelId,
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
        model: textModel.modelId,
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
        model: textModel.modelId,
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
        model: embedModel.modelId,
        input: "compose market embedding check",
      },
    });
    assertStatus(embeddingResult, [200], "POST /v1/embeddings");
    const embeddingData = embeddingResult.bodyJson?.data;
    if (!Array.isArray(embeddingData) || embeddingData.length === 0) {
      fail("/v1/embeddings returned no embedding vectors");
    }

    logStep("Testing unknown model returns a client error");
    const unknownCall = await invoke("POST", "/v1/responses", {
      headers: authHeaders,
      body: {
        model: unknownModelId,
        input: [{ role: "user", content: "Reply with OK" }],
        modalities: ["text"],
        stream: false,
      },
    });
    if (unknownCall.statusCode === 500) {
      fail(`Unknown model call returned 500: ${unknownCall.bodyText.slice(0, 500)}`);
    }
    if (unknownCall.statusCode < 400 || unknownCall.statusCode >= 500) {
      fail(`Unknown model call returned unexpected status ${unknownCall.statusCode}: ${unknownCall.bodyText.slice(0, 500)}`);
    }

    console.log("\n[check] SUCCESS: Inference runtime passes local production validation.");
  } finally {
    await stopInferenceServer();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[check] FAILURE: ${message}`);
    process.exit(1);
  });
