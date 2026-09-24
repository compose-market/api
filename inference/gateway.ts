import type { Express, NextFunction, Request as Req, Response as Res } from "express";
import type { PaymentRequired } from "@x402/core/types";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { publicResourceUrl } from "../http/public-origin.js";

import {
  getCompiledModels,
  getExtendedModels,
  getModelById,
  resolveModel,
  searchModels,
  type ModelSearchInput,
  type ResolvedModel,
} from "./catalog/registry.js";
import { isProvider, type CompiledModelsData, type ModelCard, type ModelProvider } from "./types.js";
import type { AdapterStatus } from "./catalog/adapter.js";
import {
  CANONICAL_MODALITIES,
  getModelCapabilities,
  getModalityCatalog,
  getModalityOperations,
  isCanonicalModality,
  isCanonicalOperation,
} from "./catalog/modalities/index.js";
import { videoBillingMetricsFromOutput } from "./catalog/modalities/video.js";
import {
  getFamilyCatalog,
  normalizeFamily,
} from "./catalog/families/index.js";
import {
  buildResolvedAuthorizationInput,
  buildSettlementMeterFromOutput,
  differenceMeteredModelQuote,
  type MeteredModelQuote,
} from "../x402/metering.js";
import {
  kickBatchSettlement,
  getNetworkFromRequest,
  getPaymentSignatureFromRequest,
  prepareInferencePayment,
  settlePreparedInferencePayment,
  type PreparedInferencePayment,
  type InferenceAuthorizationInput,
} from "../x402/index.js";
import {
  buildModelEndpointPaymentRequired,
  sendPaymentRequired,
  shouldDirectChallenge,
} from "../x402/discovery.js";
import { type Receipt } from "../http/request-context.js";
import {
  applyReceiptHeader,
  attachReceiptToJsonBody,
  finalizeReceipt,
  receiptFromInferenceSettlement,
  receiptStreamPayload,
  receiptForJsonBody,
  type ReceiptContext,
} from "../x402/receipts.js";
import { recordChargeEvidence, type EvidenceKind } from "../x402/evidence.js";
import { isNetworkId, isServiceBlockedNetwork, type NetworkId } from "../x402/configs/chains.js";
import {
  createErrorResponse as createCoreErrorResponse,
  formatSSE as formatCoreSSE,
  formatSSEDone as formatCoreSSEDone,
  normalizeChatRequest,
  normalizeEmbeddingsRequest,
  normalizeAudioTranscriptionFile,
  normalizeResponsesRequest,
  toOpenAIChatFinishReason,
  toChatCompletionsResponse,
  toChatStreamEvent,
  toChatUsageStreamEvent,
  toEmbeddingsResponse,
  toResponsesOutputItems,
  toResponsesResponse,
  toResponsesStreamEvent,
  validateParallelToolCalls,
  toReceiptStreamEvent,
  toErrorStreamEvent,
  toVideoStatusStreamEvent,
  type Message as CoreMessage,
  type Part as CorePart,
  type Output,
  type Request,
  type Event,
} from "./core.js";
import { ResponsesStreamEncoder } from "./responses.js";
import {
  isContextOverflowError,
  manageContext,
  type ContextManagementResult,
} from "./context.js";
import {
  appendRealtime as appendRealtimeEngine,
  cancel as cancelEngine,
  closeRealtime as closeRealtimeEngine,
  generate as generateEngine,
  resolvedForRoute,
  retrieve as retrieveEngine,
  stream as streamEngine,
} from "./engine.js";
import {
  responseStateStore,
  type StoredResponseRecord,
} from "./state.js";
import {
  addInferenceSettlement,
  finishInferenceTelemetry,
  markInferenceFirstOutput,
  persistInferenceSettlement,
  startInferenceTelemetry,
} from "./events.js";

export { attachReceiptToJsonBody, receiptForJsonBody };

// =============================================================================
// Types
// =============================================================================

export interface ChatContentPartText {
  type: "text";
  text: string;
}

export interface ChatContentPartImage {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" } | string;
}

export interface ChatContentPartAudio {
  type: "input_audio";
  input_audio: { url: string } | string;
}

export interface ChatContentPartVideo {
  type: "video_url";
  video_url: { url: string } | string;
}

export interface ChatContentPartToolCall {
  type: "tool-call" | "tool_call";
  toolCallId?: string;
  toolName?: string;
  id?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
}

export interface ChatContentPartToolResult {
  type: "tool-result" | "tool_result";
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
}

export type ChatContentPart =
  | ChatContentPartText
  | ChatContentPartImage
  | ChatContentPartAudio
  | ChatContentPartVideo
  | ChatContentPartToolCall
  | ChatContentPartToolResult
  | Record<string, unknown>;

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    providerMetadata?: Record<string, unknown>;
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatOptions {
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?:
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };
  onToken?: (token: string) => void | Promise<void>;
  onToolCall?: (toolCall: { id: string; name: string; arguments: string }) => void | Promise<void>;
  onComplete?: (result: { usage: TokenUsage }) => void;
  onError?: (error: Error) => void | Promise<void>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
  finishReason?: string;
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments: string | object;
    providerMetadata?: Record<string, unknown>;
  }>;
}

export interface ImageOptions {
  size?: string;
  quality?: string;
  n?: number;
  imageUrl?: string;
}

export interface ImageResult {
  buffer: Buffer;
  mimeType: string;
}

export interface VideoOptions {
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  imageUrl?: string;
}

export interface VideoResult {
  buffer: Buffer;
  mimeType: string;
}

export interface VideoJobResult {
  jobId: string;
  status: "queued" | "processing";
}

export interface VideoJobStatus {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  error?: string;
  progress?: number;
}

export interface TTSOptions {
  voice?: string;
  speed?: number;
  responseFormat?: string;
}

export interface ASROptions {
  language?: string;
  responseFormat?: string;
}

export interface ASRResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface EmbeddingOptions {
  dimensions?: number;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage: { promptTokens: number; totalTokens: number };
}

export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  attachments?: unknown[];
  attachment?: unknown;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  tools?: ChatOptions["tools"];
  tool_choice?: ChatOptions["tool_choice"];
  image_url?: string;
  audio_url?: string;
  video_url?: string;
}

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  attachments?: unknown[];
  attachment?: unknown;
  n?: number;
  size?: string;
  quality?: string;
  image_url?: string;
  image?: string;
}

export interface AudioSpeechRequest {
  model?: string;
  input: string;
  attachments?: unknown[];
  attachment?: unknown;
  voice?: string;
  speed?: number;
  response_format?: string;
}

export interface AudioTranscriptionRequest {
  model?: string;
  file: string;
  attachments?: unknown[];
  attachment?: unknown;
  language?: string;
  response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
}

export interface VideoGenerationRequest {
  model: string;
  prompt?: string;
  attachments?: unknown[];
  attachment?: unknown;
  duration?: number;
  aspect_ratio?: string;
  size?: string;
  image_url?: string;
  image?: string;
}

export interface ModelsListResponse {
  object: "list";
  data: ModelCard[];
}

// =============================================================================
// CORS
// =============================================================================

// CORS is set by the top-level middleware (api/http/cors.ts). This helper is
// kept for backward compatibility with test callers that mock an Express
// response without the middleware chain in front of it; in the real server it
// is a no-op on top of the canonical headers the middleware has already set.
export function setCorsHeaders(_res: Res): void {
  // Intentional no-op. See api/http/cors.ts for the canonical policy.
}

function withModelOperations(model: ModelCard): ModelCard & { operations: ReturnType<typeof getModelCapabilities> } {
  return {
    ...model,
    operations: getModelCapabilities(model),
  };
}

type EncodedCatalogPayload = {
  raw: Buffer;
  gzip: Buffer;
  brotli: Buffer;
  hash: string;
};

const compiledCatalogPayloads = new WeakMap<CompiledModelsData, EncodedCatalogPayload>();
const extendedCatalogPayloads = new WeakMap<CompiledModelsData, EncodedCatalogPayload>();
const modelIndexPayloads = new WeakMap<CompiledModelsData, EncodedCatalogPayload>();

function encodeCatalogPayload(value: unknown): EncodedCatalogPayload {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    raw,
    gzip: gzipSync(raw, { level: 6 }),
    brotli: brotliCompressSync(raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    }),
    hash: createHash("sha256").update(raw).digest("base64url").slice(0, 24),
  };
}

function cachedCatalogPayload(
  cache: WeakMap<CompiledModelsData, EncodedCatalogPayload>,
  catalog: CompiledModelsData,
  build: () => unknown,
): EncodedCatalogPayload {
  const cached = cache.get(catalog);
  if (cached) return cached;
  const next = encodeCatalogPayload(build());
  cache.set(catalog, next);
  return next;
}

function acceptedEncoding(req: Req): "br" | "gzip" | "identity" {
  const header = req.headers["accept-encoding"];
  if (typeof header !== "string") return "identity";
  const accepted = new Map(header.split(",").map((part) => {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const quality = params.find((param) => param.trim().startsWith("q="));
    return [name.trim(), quality ? Number.parseFloat(quality.split("=")[1] || "0") : 1] as const;
  }));
  if ((accepted.get("br") ?? accepted.get("*") ?? 0) > 0) return "br";
  if ((accepted.get("gzip") ?? accepted.get("*") ?? 0) > 0) return "gzip";
  return "identity";
}

function etagMatches(req: Req, etag: string): boolean {
  const header = req.headers["if-none-match"];
  if (typeof header !== "string") return false;
  return header.split(",").some((candidate) => candidate.trim() === etag || candidate.trim() === "*");
}

function sendCatalogPayload(req: Req, res: Res, payload: EncodedCatalogPayload): void {
  const encoding = acceptedEncoding(req);
  const etag = `"${payload.hash}-${encoding}"`;
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  res.setHeader("CDN-Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("ETag", etag);
  if (etagMatches(req, etag)) {
    res.status(304).end();
    return;
  }

  const body = encoding === "br" ? payload.brotli : encoding === "gzip" ? payload.gzip : payload.raw;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (encoding !== "identity") res.setHeader("Content-Encoding", encoding);
  res.setHeader("Content-Length", String(body.byteLength));
  res.status(200).send(body);
}

function modelIndexCard(model: ModelCard): ModelCard {
  return {
    modelId: model.modelId,
    name: model.name,
    provider: model.provider,
    ...(model.family ? { family: model.family } : {}),
    type: model.type,
    description: null,
    input: model.input,
    output: model.output,
    contextWindow: model.contextWindow,
    pricing: model.pricing,
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.available !== undefined ? { available: model.available } : {}),
  };
}

function phrase(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

const MODALITIES = phrase(CANONICAL_MODALITIES);
const MODALITY_ERROR = `modality must be ${MODALITIES}`;

// =============================================================================
// Route Topology
// =============================================================================

type RouteMethod = "GET" | "POST";

export interface InferenceRoute {
  method: RouteMethod;
  path: string;
  handler: (req: Req, res: Res) => Promise<void>;
  description?: string;
}

export const INFERENCE_ROUTES: InferenceRoute[] = [
  { method: "GET", path: "/v1/models", handler: (req, res) => handleListModels(req, res, false), description: "List models" },
  { method: "GET", path: "/v1/models/all", handler: (req, res) => handleListModels(req, res, true), description: "List all models" },
  { method: "GET", path: "/v1/models/index", handler: handleListModelIndex, description: "List compact model selector index" },
  { method: "POST", path: "/v1/models/search", handler: handleSearchModels, description: "Search models" },
  { method: "GET", path: "/v1/families", handler: handleListFamilies, description: "List family catalogs" },
  { method: "GET", path: "/v1/families/:family", handler: handleGetFamily, description: "Get family catalog" },
  { method: "GET", path: "/v1/modalities", handler: handleListModalities, description: "List modality catalogs" },
  { method: "GET", path: "/v1/modalities/:modality", handler: handleGetModality, description: "Get modality catalog" },
  { method: "GET", path: "/v1/modalities/:modality/operations", handler: handleListModalityOperations, description: "List modality operations" },
  { method: "GET", path: "/v1/modalities/:modality/operations/:operation/models", handler: handleListOperationModels, description: "List models by modality operation" },
  { method: "GET", path: "/v1/models/:model/params", handler: handleModelParams, description: "Model optional params" },
  { method: "GET", path: "/v1/models/:model", handler: handleGetModel, description: "Get model" },
  { method: "POST", path: "/v1/responses", handler: handleResponses, description: "Canonical request responses API" },
  { method: "POST", path: "/v1/responses/:modelId", handler: handleModelResponses, description: "Concrete model Responses API" },
  { method: "GET", path: "/v1/responses/:id", handler: handleGetResponse, description: "Retrieve response by ID" },
  { method: "GET", path: "/v1/responses/:id/input_items", handler: handleGetResponseInputItems, description: "Retrieve response input items" },
  { method: "POST", path: "/v1/responses/:id/input_items", handler: handleAppendResponseInputItems, description: "Append input to live realtime response" },
  { method: "POST", path: "/v1/responses/:id/cancel", handler: handleCancelResponse, description: "Cancel response by ID" },
  { method: "POST", path: "/v1/chat/completions", handler: handleChatCompletions, description: "Chat completions" },
  { method: "POST", path: "/v1/images/generations", handler: handleImageGeneration, description: "Image generation" },
  { method: "POST", path: "/v1/images/edits", handler: handleImageEdit, description: "Image edits" },
  { method: "POST", path: "/v1/audio/speech", handler: handleAudioSpeech, description: "Audio speech" },
  { method: "POST", path: "/v1/audio/transcriptions", handler: handleAudioTranscription, description: "Audio transcription" },
  { method: "POST", path: "/v1/embeddings", handler: handleEmbeddings, description: "Embeddings" },
  { method: "POST", path: "/v1/videos/generations", handler: handleVideoGeneration, description: "Video generation" },
  { method: "GET", path: "/v1/videos/:id", handler: handleVideoStatus, description: "Video status" },
  { method: "GET", path: "/v1/videos/:id/stream", handler: handleVideoStatusStream, description: "Video status SSE stream" },
  { method: "POST", path: "/api/inference", handler: handleChatCompletions, description: "Legacy inference alias" },
];

export function registerInferenceRoutes(app: Express): void {
  for (const route of INFERENCE_ROUTES) {
    const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete";
    app[method](route.path, (req: Req, res: Res, next: NextFunction) => {
      void route.handler(req, res).catch(next);
    });
  }
}

// =============================================================================
// Adapter Helpers
// =============================================================================

function generateCompletionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function formatSSEDone(): string {
  return "data: [DONE]\n\n";
}

function createErrorResponse(message: string, type: string, code?: string, param?: string) {
  const error: Record<string, unknown> = { message, type };
  if (code) error.code = code;
  if (param) error.param = param;
  return { error };
}

type AdaptedErrorBody = ReturnType<typeof createErrorResponse> | PaymentRequired;

interface AdaptedErrorResult {
  status: number;
  body: AdaptedErrorBody;
  headers?: Record<string, string>;
}

function getErrorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function getErrorStatusCode(record: Record<string, unknown> | null): number | undefined {
  if (!record) {
    return undefined;
  }

  if (typeof record.statusCode === "number") {
    return record.statusCode;
  }

  if (typeof record.status === "number") {
    return record.status;
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = getErrorRecord(error);
  if (typeof record?.message === "string") return record.message;
  return String(error);
}

function missingInput(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("missing input")
    || message.includes("requires an image input")
    || message.includes("requires an audio input")
    || message.includes("requires a video input")
    || message.includes("requires a pdf input")
    || message.includes("image input is required")
    || message.includes("audio input is required")
    || message.includes("video input is required")
    || message.includes("pdf input is required")
    || message.includes("image is required")
    || message.includes("audio is required")
    || message.includes("video is required")
    || message.includes("file is required")
  );
}

function getPaymentRequiredBody(record: Record<string, unknown> | null): PaymentRequired | undefined {
  const candidate = record?.paymentRequired;
  if (
    candidate
    && typeof candidate === "object"
    && "x402Version" in candidate
    && Array.isArray((candidate as PaymentRequired).accepts)
  ) {
    return candidate as PaymentRequired;
  }

  return undefined;
}

function getPaymentRequiredHeader(record: Record<string, unknown> | null): string | null {
  if (!record) {
    return null;
  }

  const candidate = record.paymentRequiredHeader;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }

  return null;
}

function buildPaymentRequiredHeaders(paymentRequiredHeader: string | null): Record<string, string> | undefined {
  if (!paymentRequiredHeader) {
    return undefined;
  }

  return {
    "PAYMENT-REQUIRED": paymentRequiredHeader,
    "payment-required": paymentRequiredHeader,
  };
}

function adaptChatResponse(result: ChatResult, model: string, requestId: string) {
  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.content,
          ...(result.toolCalls
            ? {
              tool_calls: result.toolCalls.map((tc, i) => ({
                id: tc.id || `call_${i}`,
                type: "function",
                function: {
                  name: tc.name,
                  arguments:
                    typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
                },
                ...(tc.providerMetadata ? { providerMetadata: tc.providerMetadata } : {}),
              })),
            }
            : {}),
        },
        finish_reason: toOpenAIChatFinishReason(
          result.finishReason,
          result.toolCalls?.length ? "tool_calls" : "stop",
        ),
      },
    ],
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.totalTokens,
    },
  };
}

function adaptStreamChunk(
  content: string,
  model: string,
  requestId: string,
  isLast = false,
  finishReason: string | null = null,
  isFirst = false,
) {
  const delta: Record<string, unknown> = isLast ? {} : { content };
  if (!isLast && isFirst) {
    delta.role = "assistant";
  }

  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: isLast ? toOpenAIChatFinishReason(finishReason) : null,
      },
    ],
  };
}

function adaptStreamToolCallChunk(
  toolCall: { id: string; name: string; arguments: string },
  model: string,
  requestId: string,
) {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function adaptImageResponse(result: { images: Array<{ b64_json?: string; url?: string }> }) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: result.images,
  };
}

function adaptTranscriptionResponse(result: ASRResult) {
  return { text: result.text };
}

function adaptEmbeddingResponse(result: { embeddings: number[][] }, model: string, promptTokens: number) {
  return {
    object: "list",
    data: result.embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model,
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens,
    },
  };
}

function adaptVideoResponse(result: { videos: Array<{ base64?: string; url?: string; duration?: number }> }, model: string) {
  return {
    created: Math.floor(Date.now() / 1000),
    model,
    data: result.videos.map((video) => ({
      b64_json: video.base64,
      url: video.url,
      duration: video.duration,
    })),
  };
}

export function adaptError(
  error: unknown,
  defaultStatus = 500,
): AdaptedErrorResult {
  const asRecord = getErrorRecord(error);
  const causeRecord = getErrorRecord(asRecord?.cause);
  const statusCode = getErrorStatusCode(asRecord) ?? getErrorStatusCode(causeRecord);
  const retryAfter = typeof asRecord?.retryAfter === "string"
    ? asRecord.retryAfter
    : typeof causeRecord?.retryAfter === "string"
      ? causeRecord.retryAfter
      : undefined;
  const retryHeaders = retryAfter ? { "Retry-After": retryAfter } : undefined;
  const paymentRequired = getPaymentRequiredBody(asRecord) ?? getPaymentRequiredBody(causeRecord);
  const paymentRequiredHeader = getPaymentRequiredHeader(asRecord) ?? getPaymentRequiredHeader(causeRecord);

  if (isContextOverflowError(error) || isContextOverflowError(asRecord?.cause)) {
    return {
      status: typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 400,
      body: createErrorResponse(
        getErrorMessage(error),
        "invalid_request_error",
        "context_length_exceeded",
      ),
    };
  }

  if ((statusCode === 402 || paymentRequired || paymentRequiredHeader) && paymentRequired) {
    return {
      status: 402,
      body: paymentRequired,
      headers: buildPaymentRequiredHeaders(paymentRequiredHeader),
    };
  }

  if (missingInput(error) || missingInput(asRecord?.cause)) {
    return {
      status: 400,
      body: createErrorResponse(
        getErrorMessage(error),
        "invalid_request_error",
        "missing_input",
      ),
    };
  }

  if (statusCode === 404) {
    const record = getErrorRecord(error);
    return {
      status: 404,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Model not found",
        "invalid_request_error",
        typeof record?.code === "string" ? record.code : "model_not_found",
      ),
    };
  }

  if (statusCode === 400) {
    const record = getErrorRecord(error);
    return {
      status: 400,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Invalid request",
        "invalid_request_error",
        typeof record?.code === "string" ? record.code : "invalid_request",
      ),
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      status: statusCode,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Unauthorized",
        "authentication_error",
        "invalid_auth",
      ),
    };
  }

  if (statusCode === 429) {
    const record = getErrorRecord(error);
    return {
      status: 429,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Rate limit exceeded",
        "rate_limit_error",
        typeof record?.code === "string" ? record.code : "rate_limit_exceeded",
      ),
      ...(retryHeaders ? { headers: retryHeaders } : {}),
    };
  }

  if (statusCode === 408 || statusCode === 409 || statusCode === 425) {
    const record = getErrorRecord(error);
    return {
      status: statusCode,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Upstream request should be retried",
        "server_error",
        typeof record?.code === "string" ? record.code : "upstream_retryable_error",
      ),
      ...(retryHeaders ? { headers: retryHeaders } : {}),
    };
  }

  if (statusCode === 504) {
    const record = getErrorRecord(error);
    return {
      status: 504,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Upstream timeout",
        "upstream_error",
        typeof record?.code === "string" ? record.code : "upstream_timeout",
      ),
      ...(retryHeaders ? { headers: retryHeaders } : {}),
    };
  }

  if (statusCode === 503) {
    const record = getErrorRecord(error);
    return {
      status: 503,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Response state is unavailable",
        "server_error",
        typeof record?.code === "string" ? record.code : "response_state_unavailable",
      ),
      ...(retryHeaders ? { headers: retryHeaders } : {}),
    };
  }

  if (typeof statusCode === "number" && statusCode >= 500) {
    const record = getErrorRecord(error);
    return {
      status: statusCode,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Upstream server error",
        "server_error",
        typeof record?.code === "string" ? record.code : "upstream_server_error",
      ),
      ...(retryHeaders ? { headers: retryHeaders } : {}),
    };
  }

  if (statusCode === 402 || paymentRequiredHeader) {
    return {
      status: 402,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Payment required",
        "payment_error",
        "payment_required",
      ),
      headers: buildPaymentRequiredHeaders(paymentRequiredHeader),
    };
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("model not found")
      || message.includes("not found")
      || message.includes("does not exist")
      || message.includes("unknown model")
    ) {
      return {
        status: 404,
        body: createErrorResponse(error.message, "invalid_request_error", "model_not_found"),
      };
    }
    if (message.includes("429") || message.includes("rate limit")) {
      return {
        status: 429,
        body: createErrorResponse(error.message, "rate_limit_error", "rate_limit_exceeded"),
      };
    }
    if (message.includes("budget") || message.includes("payment") || message.includes("402")) {
      return {
        status: 402,
        body: createErrorResponse(error.message, "payment_error", "insufficient_funds"),
      };
    }
    if (message.includes("401") || message.includes("unauthorized") || message.includes("invalid key")) {
      return {
        status: 401,
        body: createErrorResponse(error.message, "authentication_error", "invalid_auth"),
      };
    }
  }

  return {
    status: defaultStatus,
    body: createErrorResponse(
      error instanceof Error ? error.message : "Internal server error",
      "internal_error",
    ),
  };
}

function writeAdaptedError(res: Res, error: unknown, defaultStatus = 500): void {
  const { status, body, headers } = adaptError(error, defaultStatus);

  if (!res.headersSent && headers) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }

  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  res.status(status).json(body);
}

function streamErrorPayload(error: unknown): NonNullable<Event["error"]> {
  const adapted = adaptError(error, 500);
  const adaptedError = getErrorRecord(adapted.body.error);
  return {
    code: typeof adaptedError?.code === "string" ? adaptedError.code : "upstream_error",
    message: typeof adaptedError?.message === "string" ? adaptedError.message : getErrorMessage(error),
    details: {
      status: adapted.status,
      type: typeof adaptedError?.type === "string" ? adaptedError.type : "upstream_error",
    },
  };
}

function validateStreamFlag(body: Record<string, unknown>, res: Res): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, "stream") || body.stream === undefined) {
    return true;
  }

  if (typeof body.stream === "boolean") {
    return true;
  }

  res.status(400).json(createErrorResponse(
    "stream must be a boolean when provided",
    "invalid_request_error",
    "invalid_stream",
  ));
  return false;
}

function validateStreamingModality(request: Request, res: Res): boolean {
  void request;
  void res;
  return true;
}

function usesProviderStream(request: Request): boolean {
  if (request.modality === "text") {
    return true;
  }
  if (request.modality === "realtime") {
    return true;
  }
  if (request.modality !== "image") {
    return false;
  }
  return request.operation === "text-to-image"
    || request.operation === "image-to-image"
    || !request.operation;
}

function requireModel(modelId: string): { provider: ModelProvider; card: ModelCard } {
  const card = getModelById(modelId);
  if (!card) {
    throw new Error(`Model not found: ${modelId}`);
  }
  return { provider: card.provider, card };
}

async function invokeDirectAdapter(request: Request, signal?: AbortSignal): Promise<Output> {
  return (await generateEngine(request, { signal })).result.output;
}

async function retrieveDirectAdapter(jobId: string): Promise<AdapterStatus> {
  return retrieveEngine(jobId);
}

function getRequiredOutputMedia(output: Output): NonNullable<Output["media"]> {
  if (!output.media) {
    throw new Error(`Adapter returned no media for ${output.modality}`);
  }

  return output.media;
}

async function readOutputMediaBuffer(output: Output): Promise<Buffer> {
  const media = getRequiredOutputMedia(output);
  if (media.base64) {
    return Buffer.from(media.base64, "base64");
  }
  if (!media.url) {
    throw new Error(`Adapter returned no binary payload for ${output.modality}`);
  }

  const response = await fetch(media.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media output: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function applyLegacyAttachments(messages: CoreMessage[], body: ChatCompletionRequest): CoreMessage[] {
  const { image_url, audio_url, video_url } = body;
  if (!image_url && !audio_url && !video_url) {
    return messages;
  }

  const next = [...messages];
  let targetIndex = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]?.role === "user") {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex < 0) {
    targetIndex = next.length;
    next.push({ role: "user", content: [] });
  }

  const target = next[targetIndex];
  const parts: CorePart[] = [];

  if (Array.isArray(target.content)) {
    parts.push(...target.content);
  } else if (typeof target.content === "string" && target.content.trim()) {
    parts.push({ type: "text", text: target.content });
  }

  if (image_url) {
    parts.push({ type: "image_url", image_url: { url: image_url } });
  }
  if (audio_url) {
    parts.push({ type: "input_audio", input_audio: { url: audio_url } });
  }
  if (video_url) {
    parts.push({ type: "video_url", video_url: { url: video_url } });
  }

  next[targetIndex] = {
    ...target,
    content: parts,
  };

  return next;
}

// =============================================================================
// Canonical Responses Runtime
// =============================================================================

type ResponseShape = "responses" | "chat" | "embeddings";

const DEFAULT_DIRECT_CALL_TIMEOUT_MS = 4 * 60_000;

class UpstreamTimeoutError extends Error {
  statusCode = 504;
  code = "upstream_timeout";

  constructor(timeoutMs: number) {
    super(`upstream_timeout: provider did not return within ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

function directCallTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.INFERENCE_DIRECT_CALL_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIRECT_CALL_TIMEOUT_MS;
}

function createRequestAbort(req: Req, res: Res): { signal: AbortSignal; aborted: () => boolean; done: () => void; cleanup: () => void } {
  const controller = new AbortController();
  let completed = false;

  const abort = (reason: string) => {
    if (completed || controller.signal.aborted) {
      return;
    }
    controller.abort(new Error(reason));
  };
  const onReqAborted = () => abort("client_request_aborted");
  const onReqClose = () => {
    if (req.destroyed && !req.complete) {
      abort("client_request_closed");
    }
  };
  const onResClose = () => {
    if (!res.writableEnded && !res.writableFinished) {
      abort("client_response_closed");
    }
  };
  const cleanup = () => {
    req.off("aborted", onReqAborted);
    req.off("close", onReqClose);
    res.off("close", onResClose);
    res.off("finish", done);
  };
  const done = () => {
    completed = true;
    cleanup();
  };

  req.on("aborted", onReqAborted);
  req.on("close", onReqClose);
  res.on("close", onResClose);
  res.on("finish", done);

  return {
    signal: controller.signal,
    aborted: () => controller.signal.aborted,
    done,
    cleanup,
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "request aborted");
  error.name = "AbortError";
  return error;
}

function signals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of live) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener] as const);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function withDirectDeadline(parent: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const timeoutMs = directCallTimeoutMs();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new UpstreamTimeoutError(timeoutMs)), timeoutMs);
  const combined = signals([parent, deadline.signal]);
  return {
    signal: combined.signal,
    cleanup: () => {
      clearTimeout(timer);
      combined.cleanup();
    },
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

async function saveResponseRecord(record: StoredResponseRecord): Promise<void> {
  await responseStateStore.save(record);
}

async function getResponseRecord(id: string): Promise<StoredResponseRecord | null> {
  return responseStateStore.get(id);
}

function applyRoutingHeaders(
  res: Res,
  routing: { attempts: number; fallbackUsed: boolean; primary: { modelId: string }; final: { modelId: string } },
): void {
  res.setHeader("x-routing-primary-model", routing.primary.modelId);
  res.setHeader("x-routing-final-model", routing.final.modelId);
  res.setHeader("x-routing-attempts", String(routing.attempts));
  res.setHeader("x-routing-fallback-used", routing.fallbackUsed ? "true" : "false");
}

interface PaidInferenceContext {
  resolved: ResolvedModel;
  payment: PreparedInferencePayment;
}

async function preparePaidInference(args: {
  req: Req;
  res: Res;
  request: Request;
  resolved?: ResolvedModel;
}): Promise<PaidInferenceContext | null> {
  const resolved = args.resolved ?? resolveModel(args.request.model);
  const authorizationInput = buildResolvedAuthorizationInput({
    request: args.request,
    resolved,
  }) as InferenceAuthorizationInput;
  const payment = await prepareInferencePayment(args.req, args.res, authorizationInput);
  if (!payment) {
    return null;
  }

  return { resolved, payment };
}

async function settlePaidInference(args: {
  req: Req;
  res: Res;
  payment: PreparedInferencePayment;
  request: Request;
  output: Output;
  resolved: ResolvedModel;
  checkpointSequence?: number;
  previousCumulativeAmountWei?: string;
  previousCumulativeQuote?: MeteredModelQuote;
  onPaymentBacked?: (result: {
    settlement: NonNullable<Awaited<ReturnType<typeof settlePreparedInferencePayment>>>;
    quote: MeteredModelQuote;
    cumulativeQuote: MeteredModelQuote;
  }) => void;
}): Promise<{
  receipt: Receipt | null;
  settlement: Awaited<ReturnType<typeof settlePreparedInferencePayment>>;
  quote: MeteredModelQuote;
  cumulativeQuote: MeteredModelQuote;
}> {
  const cumulativeQuote = buildSettlementMeterFromOutput({
    request: args.request,
    output: args.output,
    resolved: args.resolved,
    checkpointSequence: 0,
  });
  const quote = differenceMeteredModelQuote(cumulativeQuote, args.previousCumulativeQuote);
  if (BigInt(quote.finalAmountWei) === 0n) {
    return { receipt: null, settlement: null, quote, cumulativeQuote };
  }
  const settlementReceipt = await settlePreparedInferencePayment(
    args.payment,
    args.res,
    {
      finalAmountWei: quote.finalAmountWei,
      providerAmountWei: quote.providerAmountWei,
      platformFeeWei: quote.platformFeeWei,
      meterSubject: quote.subject,
      lineItems: quote.lineItems,
    },
  );

  if (
    settlementReceipt
    && BigInt(settlementReceipt.finalAmountWei || "0") > 0n
    && !settlementReceipt.txHash
    && !settlementReceipt.paymentIntentId
    && !(settlementReceipt.paymentChannelId && settlementReceipt.paymentCumulativeAmountWei)
  ) {
    throw Object.assign(
      new Error("Nonzero settlement is missing x402 payment backing"),
      { statusCode: 402 },
    );
  }
  if (settlementReceipt && BigInt(settlementReceipt.finalAmountWei || "0") > 0n) {
    args.onPaymentBacked?.({
      settlement: settlementReceipt,
      quote,
      cumulativeQuote,
    });
  }

  if (settlementReceipt?.providerAmountWei) {
    const rootRunId = readHeader(args.req, "x-run-id");
    const executionRunId = readHeader(args.req, "x-execution-run-id") || rootRunId;
    if (rootRunId && executionRunId) {
      const kind = resourceKind(args.req);
      const action = resourceAction(args.req, "v1-responses");
      await recordChargeEvidence({
        kind,
        rootRunId,
        executionRunId,
        parentExecutionRunId: readHeader(args.req, "x-parent-run-id"),
        service: kind === "model" ? "inference" : kind,
        action,
        subject: settlementReceipt.meterSubject,
        providerAmountWei: settlementReceipt.providerAmountWei,
        feeWei: settlementReceipt.platformFeeWei || "0",
        finalAmountWei: settlementReceipt.finalAmountWei,
        settlementStatus: settlementReceipt.settlementStatus || (settlementReceipt.txHash ? "submitted" : "queued"),
        txHash: settlementReceipt.txHash,
        claimTxHash: settlementReceipt.claimTxHash,
        settleTxHash: settlementReceipt.settleTxHash,
        paymentIntentId: settlementReceipt.paymentIntentId,
        paymentChannelId: settlementReceipt.paymentChannelId,
        paymentCumulativeAmountWei: settlementReceipt.paymentCumulativeAmountWei,
        network: settlementReceipt.network || getNetworkFromInferenceRequest(args.req),
        settledAt: settlementReceipt.settledAt,
      });
    }
  }
  if (settlementReceipt?.evidenceOnly) {
    if (shouldKickSettlement(args.req)) {
      await kickBatchSettlement(settlementReceipt, "inference:evidence");
    }
    return { receipt: null, settlement: settlementReceipt, quote, cumulativeQuote };
  }
  const baseReceipt = receiptFromInferenceSettlement(
    settlementReceipt,
    getNetworkFromInferenceRequest(args.req),
  );
  const receipt = await finalizeReceipt(
    baseReceipt
      ? {
        ...baseReceipt,
        checkpointAmountWei: baseReceipt.finalAmountWei,
        cumulativeAmountWei: (
          BigInt(args.previousCumulativeAmountWei || "0")
          + BigInt(baseReceipt.finalAmountWei || "0")
        ).toString(),
        checkpointSequence: baseReceipt.checkpointSequence ?? args.checkpointSequence,
        rootRunId: baseReceipt.rootRunId
          || readHeader(args.req, "x-run-id")
          || readHeader(args.req, "x-idempotency-key"),
        executionRunId: baseReceipt.executionRunId
          || readHeader(args.req, "x-execution-run-id")
          || readHeader(args.req, "x-run-id")
          || readHeader(args.req, "x-idempotency-key"),
        parentExecutionRunId: baseReceipt.parentExecutionRunId
          || readHeader(args.req, "x-parent-run-id"),
      }
      : null,
    receiptContextFromInferenceRequest(args.req),
  );
  if (shouldKickSettlement(args.req)) {
    await kickBatchSettlement(settlementReceipt, "inference:receipt");
  }
  return { receipt, settlement: settlementReceipt, quote, cumulativeQuote };
}

function metricDelta(current?: Record<string, unknown>, previous?: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const prior = previous?.[key];
    const priorNumber = typeof prior === "number" && Number.isFinite(prior) ? prior : 0;
    const delta = value - priorNumber;
    if (delta > 0) {
      result[key] = delta;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function metricContext(current?: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (typeof value === "string" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function checkpointMetrics(
  current: Record<string, unknown> | undefined,
  delta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const context = metricContext(current);
  if (!context && !delta) return undefined;
  return { ...(context || {}), ...(delta || {}) };
}

function usageDelta(current?: Output["usage"], previous?: Output["usage"]): Output["usage"] | undefined {
  if (!current) return undefined;
  const promptTokens = Math.max(0, current.promptTokens - (previous?.promptTokens || 0));
  const completionTokens = Math.max(0, current.completionTokens - (previous?.completionTokens || 0));
  const totalTokens = Math.max(0, current.totalTokens - (previous?.totalTokens || 0));
  const reasoningTokens = typeof current.reasoningTokens === "number"
    ? Math.max(0, current.reasoningTokens - (previous?.reasoningTokens || 0))
    : undefined;
  const cachedInputTokens = typeof current.cachedInputTokens === "number"
    ? Math.max(0, current.cachedInputTokens - (previous?.cachedInputTokens || 0))
    : undefined;
  const cacheWriteTokens = typeof current.cacheWriteTokens === "number"
    ? Math.max(0, current.cacheWriteTokens - (previous?.cacheWriteTokens || 0))
    : undefined;
  const billingMetricDelta = metricDelta(current.billingMetrics, previous?.billingMetrics);
  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0 && !reasoningTokens && !cachedInputTokens && !cacheWriteTokens && !billingMetricDelta) {
    return undefined;
  }
  const billingMetrics = checkpointMetrics(current.billingMetrics, billingMetricDelta);
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

function mediaDelta(current?: Output["media"], previous?: Output["media"]): Output["media"] | undefined {
  if (!current) return undefined;
  const duration = typeof current.duration === "number"
    ? Math.max(0, current.duration - (previous?.duration || 0))
    : undefined;
  const generatedUnits = typeof current.generatedUnits === "number"
    ? Math.max(0, current.generatedUnits - (previous?.generatedUnits || 0))
    : undefined;
  const billingMetricDelta = metricDelta(current.billingMetrics, previous?.billingMetrics);
  if (!duration && !generatedUnits && !billingMetricDelta) {
    return undefined;
  }
  const billingMetrics = checkpointMetrics(current.billingMetrics, billingMetricDelta);
  return {
    mimeType: current.mimeType,
    ...(duration ? { duration } : {}),
    ...(generatedUnits ? { generatedUnits } : {}),
    status: "completed",
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

function maxMetricEvidence(
  current?: Record<string, unknown>,
  previous?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(previous || {}) };
  for (const [key, value] of Object.entries(current || {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const prior = merged[key];
      merged[key] = typeof prior === "number" && Number.isFinite(prior)
        ? Math.max(prior, value)
        : value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function maxUsageEvidence(
  current: NonNullable<Output["usage"]>,
  previous?: Output["usage"],
): NonNullable<Output["usage"]> {
  const maximum = (value: number | undefined, prior: number | undefined): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return prior;
    return Math.max(prior || 0, value);
  };
  const promptTokens = maximum(current.promptTokens, previous?.promptTokens) || 0;
  const completionTokens = maximum(current.completionTokens, previous?.completionTokens) || 0;
  const totalTokens = maximum(current.totalTokens, previous?.totalTokens) || promptTokens + completionTokens;
  const reasoningTokens = maximum(current.reasoningTokens, previous?.reasoningTokens);
  const cachedInputTokens = maximum(current.cachedInputTokens, previous?.cachedInputTokens);
  const cacheWriteTokens = maximum(current.cacheWriteTokens, previous?.cacheWriteTokens);
  const billingMetrics = maxMetricEvidence(current.billingMetrics, previous?.billingMetrics);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

function maxMediaEvidence(
  current: NonNullable<Output["media"]>,
  previous?: Output["media"],
): NonNullable<Output["media"]> {
  const maximum = (value: number | undefined, prior: number | undefined): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return prior;
    return Math.max(prior || 0, value);
  };
  const duration = maximum(current.duration, previous?.duration);
  const generatedUnits = maximum(current.generatedUnits, previous?.generatedUnits);
  const billingMetrics = maxMetricEvidence(current.billingMetrics, previous?.billingMetrics);
  return {
    mimeType: current.mimeType || previous?.mimeType || "application/octet-stream",
    ...(duration !== undefined ? { duration } : {}),
    ...(generatedUnits !== undefined ? { generatedUnits } : {}),
    status: "completed",
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

export interface CumulativeSettlementLane {
  checkpoint: (output: Output) => boolean;
  flush: () => Promise<void>;
  failure: () => Promise<never>;
  checkpointCount: () => number;
  hasEvidence: () => boolean;
}

export async function finalizeDirectStreamPayment(args: {
  output: Output;
  settle: (output: Output) => Promise<Receipt | null>;
  emitReceipt: (receipt: Receipt) => void | Promise<void>;
  emitDone: () => void | Promise<void>;
  emitError: (error: { code: string; message: string }) => void | Promise<void>;
  terminalError?: { code: string; message: string };
  interruptedError?: Error;
}): Promise<"done" | "error"> {
  const receipt = await args.settle(args.output);
  if (args.interruptedError) {
    throw args.interruptedError;
  }
  if (receipt) {
    await args.emitReceipt(receipt);
  }
  if (args.terminalError) {
    await args.emitError(args.terminalError);
    return "error";
  }
  await args.emitDone();
  return "done";
}

export function createCumulativeSettlementLane(args: {
  settle: (output: Output) => Promise<Receipt | null>;
  emitReceipt: (receipt: Receipt) => void | Promise<void>;
}): CumulativeSettlementLane {
  let scheduledUsage: Output["usage"] | undefined;
  let scheduledMedia: Output["media"] | undefined;
  let scheduledCheckpoints = 0;
  let firstFailure: unknown;
  let chain: Promise<void> = Promise.resolve();
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);

  const checkpoint = (output: Output): boolean => {
    if (firstFailure) throw firstFailure;
    const deltaUsage = usageDelta(output.usage, scheduledUsage);
    const deltaMedia = mediaDelta(output.media, scheduledMedia);
    if (!deltaUsage && !deltaMedia) return false;

    if (output.usage) scheduledUsage = maxUsageEvidence(output.usage, scheduledUsage);
    if (output.media) scheduledMedia = maxMediaEvidence(output.media, scheduledMedia);
    scheduledCheckpoints += 1;

    const cumulativeOutput: Output = {
      modality: output.modality,
      ...(scheduledUsage ? { usage: scheduledUsage } : {}),
      ...(scheduledMedia ? { media: scheduledMedia } : {}),
      finishReason: output.finishReason || "stop",
    };
    chain = chain.then(async () => {
      try {
        const receipt = await args.settle(cumulativeOutput);
        if (receipt) await args.emitReceipt(receipt);
      } catch (error) {
        if (!firstFailure) {
          firstFailure = error;
          rejectFailure(error);
        }
      }
    });
    return true;
  };

  return {
    checkpoint,
    flush: async () => {
      await chain;
      if (firstFailure) throw firstFailure;
    },
    failure: () => failure,
    checkpointCount: () => scheduledCheckpoints,
    hasEvidence: () => scheduledCheckpoints > 0,
  };
}

function resourceKind(req: Req): EvidenceKind {
  const raw = readHeader(req, "x-resource-kind")?.toLowerCase();
  switch (raw) {
    case "agent":
    case "model":
    case "tool":
    case "search":
    case "memory":
    case "connector":
      return raw;
    default:
      return "model";
  }
}

function resourceAction(req: Req, fallback: string): string {
  return readHeader(req, "x-resource-action") || fallback;
}

function shouldKickSettlement(req: Req): boolean {
  void req;
  return true;
}

function readHeader(req: Req, name: string): string | undefined {
  const value = req.get?.(name) || req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNetworkFromInferenceRequest(req: Req): NetworkId | undefined {
  const header = req.get?.("x-network-id") || req.headers?.["x-network-id"];
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  return isNetworkId(String(value)) ? String(value) as NetworkId : undefined;
}

function receiptContextFromInferenceRequest(req: Req): ReceiptContext {
  const userHeader = req.get?.("x-session-user-address") || req.headers?.["x-session-user-address"];
  const userAddress = Array.isArray(userHeader) ? userHeader[0] : userHeader;
  const kind = resourceKind(req);
  return {
    service: kind === "model" ? "inference" : kind,
    action: kind === "model"
      ? `${req.method || "POST"} ${req.path || req.originalUrl || req.url || "/v1"}`
      : resourceAction(req, `${req.method || "POST"} ${req.path || req.originalUrl || req.url || "/v1"}`),
    resource: publicResourceUrl(req),
    userAddress: typeof userAddress === "string" ? userAddress.toLowerCase() : undefined,
  };
}

function responseFromRecord(record: StoredResponseRecord): Record<string, unknown> {
  if (!record.output) {
    return {
      id: record.id,
      object: "response",
      created_at: record.createdAt,
      status: record.status,
      model: record.model,
      output: [],
      ...(record.previousResponseId ? { previous_response_id: record.previousResponseId } : {}),
      ...(record.error ? { error: { message: record.error } } : {}),
      ...(record.jobId ? { job_id: record.jobId } : {}),
    };
  }

  const payload = toResponsesResponse(record.model, record.id, record.output) as unknown as Record<string, unknown>;
  payload.status = record.status;
  if (record.previousResponseId) {
    payload.previous_response_id = record.previousResponseId;
  }
  if (record.jobId) {
    payload.job_id = record.jobId;
  }
  if (record.error) {
    payload.error = { message: record.error };
  }
  return payload;
}

function outputToAssistantMessage(output: Output): CoreMessage | null {
  if (output.modality === "embedding") {
    return null;
  }

  if (output.modality !== "text") {
    return {
      role: "assistant",
      content: output.content
        || output.media?.url
        || output.media?.jobId
        || `[${output.modality}]`,
    };
  }

  return {
    role: "assistant",
    content: output.content || "",
    ...(output.reasoning !== undefined ? { reasoning_content: output.reasoning } : {}),
    ...(output.toolCalls?.length
      ? {
        tool_calls: output.toolCalls.map((call, index) => ({
          id: call.id || `call_${index}`,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
          },
          ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
        })),
      }
      : {}),
  };
}

async function buildResponsesHistory(responseId: string, visited = new Set<string>()): Promise<CoreMessage[]> {
  if (visited.has(responseId)) {
    throw Object.assign(new Error(`Response history cycle detected for '${responseId}'`), { statusCode: 400 });
  }

  visited.add(responseId);
  const record = await getResponseRecord(responseId);
  if (!record) {
    throw Object.assign(new Error(`Response '${responseId}' not found`), { statusCode: 404, code: "response_not_found" });
  }

  const prior = record.previousResponseId
    ? await buildResponsesHistory(record.previousResponseId, visited)
    : [];
  const inputMessages = Array.isArray(record.inputMessages) ? record.inputMessages : [];
  const assistantMessage = record.output ? outputToAssistantMessage(record.output) : null;

  return assistantMessage
    ? [...prior, ...inputMessages, assistantMessage]
    : [...prior, ...inputMessages];
}

async function buildResponsesItemHistory(
  responseId: string,
  visited = new Set<string>(),
): Promise<Record<string, unknown>[]> {
  if (visited.has(responseId)) {
    throw Object.assign(new Error(`Response history cycle detected for '${responseId}'`), { statusCode: 400 });
  }

  visited.add(responseId);
  const record = await getResponseRecord(responseId);
  if (!record) {
    throw Object.assign(new Error(`Response '${responseId}' not found`), { statusCode: 404, code: "response_not_found" });
  }

  const prior = record.previousResponseId
    ? await buildResponsesItemHistory(record.previousResponseId, visited)
    : [];
  const inputItems = Array.isArray(record.inputItems) ? record.inputItems : [];
  const outputItems = record.output ? toResponsesOutputItems(record.output) : [];
  return [...prior, ...inputItems, ...outputItems];
}

async function hydrateResponsesRequest(request: Request): Promise<Request> {
  const priorMessages = request.previousResponseId
    ? await buildResponsesHistory(request.previousResponseId)
    : [];
  const priorItems = request.previousResponseId
    ? await buildResponsesItemHistory(request.previousResponseId)
    : [];
  const currentMessages = request.instructions
    ? [{ role: "system", content: request.instructions } satisfies CoreMessage, ...priorMessages, ...request.messages]
    : [...priorMessages, ...request.messages];

  return {
    ...request,
    messages: currentMessages,
    inputItems: [...priorItems, ...(request.inputItems || [])],
  };
}

function inputItemsFromRecord(record: StoredResponseRecord): Record<string, unknown>[] {
  if (Array.isArray(record.inputItems)) {
    return record.inputItems.map((item) => ({ ...item }));
  }
  return (record.inputMessages || []).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.partial === true ? { partial: true } : {}),
  }));
}

function writeResponsesEvents(res: Res, encoder: ResponsesStreamEncoder, event: Event): void {
  for (const payload of encoder.push(event)) {
    res.write(formatCoreSSE(payload));
  }
}

function writeResponsesPayloads(res: Res, payloads: Array<Record<string, unknown>>): void {
  for (const payload of payloads) {
    res.write(formatCoreSSE(payload));
  }
}

function closeEventStream(res: Res): void {
  if (res.writableEnded) return;
  res.write(formatCoreSSEDone());
  res.end();
}

const INFERENCE_SSE_OPEN_PADDING = " ".repeat(2048);

function openEventStream(res: Res, responseId: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("x-response-id", responseId);
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(`: open ${INFERENCE_SSE_OPEN_PADDING}\n\n`);
  const flush = (res as Res & { flush?: () => void }).flush;
  if (typeof flush === "function") flush.call(res);
}

function writeDirectResponsesOutput(
  res: Res,
  encoder: ResponsesStreamEncoder,
  output: Output,
): void {
  toResponsesOutputItems(output).forEach((item, outputIndex) => {
    if (item.type === "function_call") {
      writeResponsesEvents(res, encoder, {
        type: "tool-call",
        outputIndex,
        toolCall: {
          id: typeof item.call_id === "string" ? item.call_id : "",
          itemId: typeof item.id === "string" ? item.id : undefined,
          callId: typeof item.call_id === "string" ? item.call_id : undefined,
          index: outputIndex,
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        },
      });
      return;
    }

    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        const record = part && typeof part === "object" && !Array.isArray(part)
          ? part as Record<string, unknown>
          : null;
        if (record?.type === "output_text" && typeof record.text === "string") {
          writeResponsesEvents(res, encoder, {
            type: "text-delta",
            itemId: typeof item.id === "string" ? item.id : undefined,
            outputIndex,
            text: record.text,
          });
        }
      }
      return;
    }

    writeResponsesEvents(res, encoder, {
      type: "output-item",
      outputIndex,
      item,
    });
  });
}

export async function executeRequest(args: {
  req: Req;
  res: Res;
  request: Request;
  shape: ResponseShape;
  externalCompatibility?: boolean;
}): Promise<void> {
  const externalCompatibility = args.externalCompatibility === true || args.res.locals.externalCompatibility === true;
  let request = args.shape === "responses" && !externalCompatibility
    ? await hydrateResponsesRequest(args.request)
    : args.request;
  const modelId = request.model;
  if (!modelId) {
    args.res.status(400).json(createCoreErrorResponse("model is required", "invalid_request_error", "missing_model"));
    return;
  }

  const contextModel = getModelById(modelId);
  let contextPlan: ContextManagementResult | null = null;
  if (args.shape === "responses" && request.modality === "text" && !externalCompatibility) {
    contextPlan = manageContext({ request, model: contextModel, defaultEnabled: true });
    request = contextPlan.request;
    if (contextPlan.compacted && !args.res.headersSent) {
      args.res.setHeader("x-context-management", "truncated");
      args.res.setHeader("x-context-original-estimated-tokens", String(contextPlan.originalEstimatedTokens));
      args.res.setHeader("x-context-effective-estimated-tokens", String(contextPlan.effectiveEstimatedTokens));
    }
  }

  validateParallelToolCalls(request);

  if (!validateStreamingModality(request, args.res)) {
    return;
  }

  const lifecycle = createRequestAbort(args.req, args.res);
  const paid = await preparePaidInference({
    req: args.req,
    res: args.res,
    request,
  });
  if (!paid) {
    lifecycle.cleanup();
    return;
  }
  const telemetry = startInferenceTelemetry({
    userAddress: readHeader(args.req, "x-session-user-address"),
    network: getNetworkFromInferenceRequest(args.req),
    request,
    resolved: paid.resolved,
  });
  let telemetryFinished = false;
  const finishTelemetry = async (status: "succeeded" | "failed" | "aborted", error?: unknown) => {
    if (telemetryFinished) return;
    telemetryFinished = true;
    await finishInferenceTelemetry(telemetry, status, error);
  };
  let paymentTerminal = false;
  let settlementSequence = 0;
  let cumulativeSettlementAmountWei = 0n;
  let chargedCumulativeQuote: MeteredModelQuote | undefined;
  let activeSettlement: Promise<Receipt | null> | null = null;
  let activeSettlementLane: CumulativeSettlementLane | null = null;
  let activeSettlementCheckpoint: (() => boolean) | null = null;
  const abortPaidInference = async (reason: string) => {
    if (paymentTerminal) {
      return;
    }
    paymentTerminal = true;
    await paid.payment.abort(reason);
  };
  const settleOutput = async (output: Output): Promise<Receipt | null> => {
    const checkpointSequence = settlementSequence;
    const pending = (async () => {
      const { receipt, settlement, quote, cumulativeQuote } = await settlePaidInference({
        req: args.req,
        res: args.res,
        payment: paid.payment,
        request,
        output,
        resolved: paid.resolved,
        checkpointSequence,
        previousCumulativeAmountWei: cumulativeSettlementAmountWei.toString(),
        previousCumulativeQuote: chargedCumulativeQuote,
        onPaymentBacked: ({ settlement, cumulativeQuote }) => {
          chargedCumulativeQuote = cumulativeQuote;
          cumulativeSettlementAmountWei += BigInt(settlement.finalAmountWei);
          settlementSequence += 1;
          paymentTerminal = true;
        },
      });
      const telemetrySettlement = addInferenceSettlement(telemetry, quote, settlement, receipt?.id);
      try {
        await persistInferenceSettlement(telemetry, telemetrySettlement);
      } catch (error) {
        console.error("[analytics] Failed to persist inference settlement checkpoint", error);
      }
      return receipt;
    })();
    activeSettlement = pending;
    try {
      return await pending;
    } finally {
      if (activeSettlement === pending) activeSettlement = null;
    }
  };
  const abortPaymentOnClose = () => {
    void (async () => {
      try {
        if (request.modality === "realtime") {
          await closeRealtimeEngine(request.responseId).catch(() => false);
        }
        activeSettlementCheckpoint?.();
        if (activeSettlementLane?.hasEvidence()) {
          await activeSettlementLane.flush();
          return;
        }
        if (activeSettlement) {
          await activeSettlement;
          return;
        }
      } catch (error) {
        console.warn("[gateway] failed to flush evidenced inference payment after client close:", error instanceof Error ? error.message : String(error));
      }
      await abortPaidInference(abortError(lifecycle.signal).message);
    })().catch((error) => {
      console.warn("[gateway] failed to abort inference payment after client close:", error instanceof Error ? error.message : String(error));
    });
  };
  lifecycle.signal.addEventListener("abort", abortPaymentOnClose, { once: true });

  const baseRecord: StoredResponseRecord = {
    id: request.responseId,
    model: modelId,
    provider: paid.resolved.provider,
    operation: request.operation,
    createdAt: Math.floor(Date.now() / 1000),
    status: "in_progress",
    store: args.shape === "responses" && !externalCompatibility ? args.request.store !== false : false,
    inputItems: args.shape === "responses" ? args.request.inputItems : undefined,
    inputMessages: args.shape === "responses" ? args.request.messages : undefined,
    previousResponseId: args.shape === "responses" ? args.request.previousResponseId : undefined,
  };

  try {
    let baseRecordSave: Promise<unknown> | null = null;
    if (request.stream) {
      applyRoutingHeaders(args.res, {
        attempts: 1,
        fallbackUsed: false,
        primary: { modelId },
        final: { modelId },
      });
      paid.payment.applyHeaders(args.res);
      if (!externalCompatibility) {
        openEventStream(args.res, request.responseId);
        baseRecordSave = saveResponseRecord(baseRecord).then(
          () => null,
          (error) => error,
        );
      }
    } else {
      await saveResponseRecord(baseRecord);
    }

    if (request.stream && args.shape === "responses" && !usesProviderStream(request)) {
      const responsesEncoder = new ResponsesStreamEncoder(request.responseId, modelId, baseRecord.createdAt);
      if (!externalCompatibility) writeResponsesEvents(args.res, responsesEncoder, { type: "created" });

      try {
        const direct = externalCompatibility ? null : withDirectDeadline(lifecycle.signal);
        const keepalive = setInterval(() => {
          if (!args.res.writableEnded) {
            args.res.write(": ping\n\n");
          }
        }, 15_000);
        let routed: Awaited<ReturnType<typeof generateEngine>>;
        try {
          routed = await generateEngine(request, {
            signal: direct?.signal || lifecycle.signal,
            retriesPerTarget: externalCompatibility ? 0 : undefined,
          });
        } finally {
          clearInterval(keepalive);
          direct?.cleanup();
        }
        const output = routed.result.output;
        if (externalCompatibility) {
          openEventStream(args.res, request.responseId);
          writeResponsesEvents(args.res, responsesEncoder, { type: "created" });
        }
        markInferenceFirstOutput(telemetry);
        let finalOutput = output;
        let terminalStreamError: { code: string; message: string } | undefined;

        writeDirectResponsesOutput(args.res, responsesEncoder, output);

        const jobId = output.media?.jobId;
        if (output.modality === "video" && jobId && output.media?.status !== "completed") {
          const startedAt = Date.now();
          const timeoutMs = 1_800_000;
          const pollIntervalMs = 2_000;
          let outputIndex = toResponsesOutputItems(output).length;

          while (!args.res.writableEnded && !lifecycle.aborted()) {
            const status = await retrieveDirectAdapter(jobId);
            args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, {
              type: "video-status",
              videoStatus: {
                jobId,
                status: status.status,
                progress: status.progress,
                url: status.url,
                error: status.error,
              },
            })));

            if (status.status === "completed") {
              finalOutput = {
                ...output,
                media: {
                  ...output.media,
                  mimeType: output.media!.mimeType,
                  status: "completed",
                  ...(status.url ? { url: status.url } : {}),
                  ...(typeof status.progress === "number" ? { progress: status.progress } : { progress: 100 }),
                },
              };
              for (const item of toResponsesOutputItems(finalOutput)) {
                writeResponsesEvents(args.res, responsesEncoder, {
                  type: "output-item",
                  outputIndex,
                  item,
                });
                outputIndex += 1;
              }
              break;
            }

            if (status.status === "failed") {
              finalOutput = {
                ...output,
                media: {
                  ...output.media,
                  mimeType: output.media!.mimeType,
                  status: "failed",
                  ...(typeof status.progress === "number" ? { progress: status.progress } : {}),
                },
              };
              terminalStreamError = {
                code: "upstream_error",
                message: status.error || `Video job ${jobId} failed`,
              };
              break;
            }

            if (Date.now() - startedAt >= timeoutMs) {
              terminalStreamError = {
                code: "upstream_timeout",
                message: `Video job ${jobId} did not complete within ${timeoutMs}ms`,
              };
              break;
            }

            await wait(pollIntervalMs, lifecycle.signal);
          }

        }

        finalOutput = { ...finalOutput, outputItems: responsesEncoder.items() };
        if (!externalCompatibility && !terminalStreamError && !lifecycle.aborted() && !args.res.writableEnded) {
          args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, {
            type: "status",
            status: "finalizing_payment",
            usage: finalOutput.usage,
          })));
        }
        const terminalOutcome = await finalizeDirectStreamPayment({
          output: finalOutput,
          settle: settleOutput,
          emitReceipt: (receipt) => {
            if (!args.res.writableEnded) {
              args.res.write(toReceiptStreamEvent(receiptStreamPayload(receipt)));
            }
          },
          emitDone: () => {
            if (!args.res.writableEnded) {
              writeResponsesEvents(args.res, responsesEncoder, {
                type: "done",
                finishReason: finalOutput.finishReason || "stop",
                usage: finalOutput.usage,
              });
              closeEventStream(args.res);
            }
          },
          emitError: (error) => {
            if (args.res.writableEnded) return;
            args.res.write(toErrorStreamEvent(error));
            if (externalCompatibility) args.res.end();
            else closeEventStream(args.res);
          },
          ...(terminalStreamError ? { terminalError: terminalStreamError } : {}),
          ...(lifecycle.aborted() ? { interruptedError: abortError(lifecycle.signal) } : {}),
        });
        lifecycle.done();
        const stateError = await baseRecordSave;
        if (stateError) throw stateError;

        await saveResponseRecord({
          ...baseRecord,
          status: terminalOutcome === "error"
            ? "failed"
            : finalOutput.media?.jobId && finalOutput.media.status && finalOutput.media.status !== "completed"
              ? "in_progress"
              : "completed",
          output: finalOutput,
          ...(finalOutput.media?.jobId ? { jobId: finalOutput.media.jobId } : {}),
          ...(terminalStreamError ? { error: terminalStreamError.message } : {}),
        });
        await finishTelemetry(terminalOutcome === "error" ? "failed" : "succeeded");
      } catch (error) {
        try {
          await abortPaidInference(error instanceof Error ? error.message : "stream_failed");
        } catch { /* best-effort */ }
        if (externalCompatibility && !args.res.headersSent) throw error;
        try {
          writeResponsesEvents(args.res, responsesEncoder, {
            type: "error",
            error: streamErrorPayload(error),
          });
          if (externalCompatibility) args.res.end();
          else closeEventStream(args.res);
        } catch { /* best-effort */ }
        throw error;
      }

      return;
    }

    if (request.stream && usesProviderStream(request)) {
      const routed = await streamEngine(request, {
        signal: lifecycle.signal,
        retriesPerTarget: externalCompatibility ? 0 : undefined,
      });

      const responsesEncoder = args.shape === "responses"
        ? new ResponsesStreamEncoder(request.responseId, modelId, baseRecord.createdAt)
        : null;
      const iterator = routed.result.stream[Symbol.asyncIterator]();
      let isFirstToken = true;
      let aggregatedText = "";
      let aggregatedReasoning = "";
      let lastUsage: Output["usage"] | undefined;
      let finishReason = "stop";
      let streamedImage: {
        base64: string;
        mimeType?: string;
        revisedPrompt?: string;
        duration?: number;
        generatedUnits?: number;
        billingMetrics?: Record<string, unknown>;
      } | null = null;
      let pendingImageCompleteEvent: Event | null = null;
      let pendingDoneEvent: Event | null = null;
      let sawProviderDone = false;
      const externalChatToolDeltaIndexes = new Set<number>();
      let lastMedia: Output["media"] | undefined;
      const realtimeStream = request.modality === "realtime";
      const continuousSettlement = paid.payment.settlementMode === "continuous";
      let receiptCount = 0;
      const cumulativeOutput = (): Output => ({
        modality: streamedImage ? "image" : request.modality,
        ...(lastUsage ? { usage: lastUsage } : {}),
        ...(lastMedia ? { media: lastMedia } : {}),
        finishReason,
      });
      const settlementLane = createCumulativeSettlementLane({
        settle: settleOutput,
        emitReceipt: (receipt) => {
          receiptCount += 1;
          if (!args.res.headersSent) {
            applyReceiptHeader(args.res, receipt);
            return;
          }
          if (args.res.writableEnded) return;
          try {
            args.res.write(toReceiptStreamEvent(receiptStreamPayload(receipt)));
          } catch (error) {
            console.warn("[gateway] failed to emit inference settlement receipt:", error instanceof Error ? error.message : String(error));
          }
        },
      });
      activeSettlementLane = settlementLane;
      const checkpointSettlement = (force = false) => {
        if (!force && !continuousSettlement) return false;
        return settlementLane.checkpoint(cumulativeOutput());
      };
      activeSettlementCheckpoint = () => checkpointSettlement(true);
      const flushSettlement = async () => {
        await settlementLane.flush();
        if (realtimeStream && settlementLane.hasEvidence() && receiptCount <= 0) {
          throw Object.assign(new Error("Realtime settlement produced no backed nonzero receipt"), { statusCode: 402 });
        }
      };
      let firstEvent: IteratorResult<Event> | null = null;
      if (externalCompatibility) {
        firstEvent = await iterator.next();
        if (firstEvent.done) throw new Error("upstream stream ended without output");
        if (firstEvent.value.type === "error") {
          markInferenceFirstOutput(telemetry);
          if (firstEvent.value.usage) lastUsage = firstEvent.value.usage;
          if (firstEvent.value.media) lastMedia = firstEvent.value.media;
          checkpointSettlement(true);
          await flushSettlement();
          throw Object.assign(new Error(firstEvent.value.error?.message || "upstream_error"), {
            code: firstEvent.value.error?.code,
          });
        }
        openEventStream(args.res, request.responseId);
      }
      if (responsesEncoder) writeResponsesEvents(args.res, responsesEncoder, { type: "created" });
      const events = async function* (): AsyncGenerator<Event> {
        if (firstEvent && !firstEvent.done) yield firstEvent.value;
        while (true) {
          const event = await Promise.race([
            iterator.next(),
            settlementLane.failure(),
          ]);
          if (event.done) return;
          yield event.value;
        }
      };
      const providerKeepalive = setInterval(() => {
        if (!args.res.writableEnded && args.res.headersSent) {
          args.res.write(": ping\n\n");
        }
      }, 15_000);

      try {
        for await (const event of events()) {
          markInferenceFirstOutput(telemetry);
          const eventHasEvidence = Boolean(event.usage || event.media);
          if (event.usage) lastUsage = event.usage;
          if (event.media) lastMedia = event.media;
          if (continuousSettlement && eventHasEvidence) checkpointSettlement();
          if (event.type === "text-delta") {
            aggregatedText += event.text || "";
            if (responsesEncoder) writeResponsesEvents(args.res, responsesEncoder, event);
            else args.res.write(formatCoreSSE(toChatStreamEvent(request.responseId, modelId, event, isFirstToken)));
            isFirstToken = false;
            continue;
          }

          if (event.type === "thinking" || event.type === "reasoning-delta") {
            if (event.type === "thinking" || event.type === "reasoning-delta") {
              aggregatedReasoning += event.thinking || event.text || "";
            }
            if (responsesEncoder) {
              writeResponsesEvents(args.res, responsesEncoder, event);
            } else {
              args.res.write(formatCoreSSE(toChatStreamEvent(request.responseId, modelId, event, isFirstToken)));
            }
            isFirstToken = false;
            continue;
          }

          if (event.type === "tool-call-delta") {
            if (externalCompatibility && typeof event.toolCallDelta?.index === "number") {
              externalChatToolDeltaIndexes.add(event.toolCallDelta.index);
            }
            if (responsesEncoder) {
              writeResponsesEvents(args.res, responsesEncoder, event);
            } else {
              args.res.write(formatCoreSSE(toChatStreamEvent(request.responseId, modelId, event, isFirstToken)));
            }
            isFirstToken = false;
            continue;
          }

          if (event.type === "tool-call") {
            if (responsesEncoder) {
              writeResponsesEvents(args.res, responsesEncoder, event);
            } else {
              const index = event.toolCall?.index ?? event.outputIndex ?? 0;
              if (!externalCompatibility || !externalChatToolDeltaIndexes.has(index)) {
                args.res.write(formatCoreSSE(toChatStreamEvent(request.responseId, modelId, event, isFirstToken)));
              }
            }
            isFirstToken = false;
            continue;
          }

          if (event.type === "output-item") {
            if (responsesEncoder) {
              writeResponsesEvents(args.res, responsesEncoder, event);
            }
            continue;
          }

          if (event.type === "image-partial") {
            const payload = toResponsesStreamEvent(request.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            continue;
          }

          if (
            event.type === "citation"
            || event.type === "warning"
            || event.type === "error"
            || event.type === "audio-chunk"
            || event.type === "subtitle"
            || event.type === "status"
            || event.type === "video-status"
            || event.type === "video-complete"
          ) {
            if (event.usage) {
              lastUsage = event.usage;
            }
            if (event.media) {
              lastMedia = event.media;
            }
            if (continuousSettlement) checkpointSettlement();
            if (event.type === "error") {
              throw Object.assign(new Error(event.error?.message || "upstream_error"), {
                code: event.error?.code,
              });
            }
            const payload = args.shape === "chat"
              ? toChatStreamEvent(request.responseId, modelId, event, isFirstToken)
              : toResponsesStreamEvent(request.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            isFirstToken = false;
            continue;
          }

          if (event.type === "image-complete") {
            streamedImage = event.image
              ? {
                base64: event.image.base64,
                ...(event.image.mimeType ? { mimeType: event.image.mimeType } : {}),
                ...(event.image.revisedPrompt ? { revisedPrompt: event.image.revisedPrompt } : {}),
                ...(typeof event.image.duration === "number" ? { duration: event.image.duration } : {}),
                ...(typeof event.image.generatedUnits === "number" ? { generatedUnits: event.image.generatedUnits } : {}),
                ...(event.image.billingMetrics ? { billingMetrics: event.image.billingMetrics } : {}),
              }
              : null;
            if (event.usage) {
              lastUsage = event.usage;
            }
            if (streamedImage) {
              lastMedia = {
                mimeType: streamedImage.mimeType || "image/png",
                ...(typeof streamedImage.duration === "number" ? { duration: streamedImage.duration } : {}),
                ...(typeof streamedImage.generatedUnits === "number" ? { generatedUnits: streamedImage.generatedUnits } : {}),
                ...(streamedImage.billingMetrics ? { billingMetrics: streamedImage.billingMetrics } : {}),
                status: "completed",
              };
            }
            pendingImageCompleteEvent = event;
            if (continuousSettlement) checkpointSettlement();
            continue;
          }

          if (event.type === "done") {
            if (event.usage) {
              lastUsage = event.usage;
            }
            if (event.media) {
              lastMedia = event.media;
            }
            finishReason = event.finishReason || "stop";
            pendingDoneEvent = event;
            if (!sawProviderDone && !externalCompatibility && !args.res.writableEnded) {
              const finalizingEvent: Event = {
                type: "status",
                status: "finalizing_payment",
                usage: event.usage || lastUsage,
              };
              const payload = args.shape === "chat"
                ? toChatStreamEvent(request.responseId, modelId, finalizingEvent, isFirstToken)
                : toResponsesStreamEvent(request.responseId, modelId, finalizingEvent);
              args.res.write(formatCoreSSE(payload));
            }
            sawProviderDone = true;
            if (continuousSettlement) checkpointSettlement();
            continue;
          }
        }

        checkpointSettlement(true);
        if (!sawProviderDone) {
          await flushSettlement();
          throw Object.assign(
            new Error("incomplete_provider_stream"),
            { code: "incomplete_provider_stream" },
          );
        }
        if (!settlementLane.hasEvidence()) {
          await abortPaidInference("missing_stream_evidence");
          await finishTelemetry("failed", new Error("missing_stream_evidence"));
          args.res.end();
          return;
        }

        let finalOutput: Output = {
          modality: streamedImage ? "image" : request.modality,
          ...(streamedImage
            ? {
              media: {
                mimeType: streamedImage.mimeType || "image/png",
                base64: streamedImage.base64,
                ...(streamedImage.revisedPrompt ? { revisedPrompt: streamedImage.revisedPrompt } : {}),
                ...(typeof streamedImage.duration === "number" ? { duration: streamedImage.duration } : {}),
                ...(typeof streamedImage.generatedUnits === "number" ? { generatedUnits: streamedImage.generatedUnits } : {}),
                ...(streamedImage.billingMetrics ? { billingMetrics: streamedImage.billingMetrics } : {}),
                status: "completed" as const,
              },
            }
            : {
              content: aggregatedText,
              ...(aggregatedReasoning ? { reasoning: aggregatedReasoning } : {}),
              ...(lastMedia ? { media: lastMedia } : {}),
            }),
          ...(lastUsage ? { usage: lastUsage } : {}),
          finishReason,
          ...(responsesEncoder && !streamedImage ? { outputItems: responsesEncoder.items() } : {}),
          ...(responsesEncoder?.calls().length ? { toolCalls: responsesEncoder.calls() } : {}),
        };

        if (continuousSettlement) settlementLane.checkpoint(finalOutput);
        await flushSettlement();

        if (pendingImageCompleteEvent) {
          args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, pendingImageCompleteEvent)));
          if (responsesEncoder) {
            writeDirectResponsesOutput(args.res, responsesEncoder, finalOutput);
            finalOutput = { ...finalOutput, outputItems: responsesEncoder.items() };
          }
        }

        if (responsesEncoder) {
          writeResponsesPayloads(args.res, responsesEncoder.finishItems());
          finalOutput = { ...finalOutput, outputItems: responsesEncoder.items() };
        }

        const terminalEvent = pendingDoneEvent!;
        if (responsesEncoder) {
          writeResponsesEvents(args.res, responsesEncoder, terminalEvent);
        } else {
          args.res.write(formatCoreSSE(toChatStreamEvent(request.responseId, modelId, terminalEvent)));
          if (terminalEvent.usage) {
            args.res.write(formatCoreSSE(toChatUsageStreamEvent(request.responseId, modelId, terminalEvent.usage)));
          }
        }
        closeEventStream(args.res);
        lifecycle.done();
        const stateError = await baseRecordSave;
        if (stateError) throw stateError;

        await saveResponseRecord({
          ...baseRecord,
          status: "completed",
          output: finalOutput,
        });
        await finishTelemetry("succeeded");
      } catch (error) {
        let terminalError: unknown = error;
        try {
          checkpointSettlement(true);
        } catch (settlementError) {
          terminalError = settlementError;
        }
        if (settlementLane.hasEvidence()) {
          try {
            await settlementLane.flush();
            if (realtimeStream && receiptCount <= 0) {
              throw Object.assign(new Error("Realtime settlement produced no backed nonzero receipt"), { statusCode: 402 });
            }
          } catch (settlementError) {
            terminalError = Object.assign(
              settlementError instanceof Error ? settlementError : new Error(String(settlementError)),
              { code: "payment_settlement_failed" },
            );
            if (realtimeStream) {
              void closeRealtimeEngine(request.responseId).catch(() => undefined);
            }
          }
        }
        try {
          await iterator.return?.(undefined);
        } catch { /* best-effort */ }
        try {
          await abortPaidInference(terminalError instanceof Error ? terminalError.message : "stream_failed");
        } catch { /* best-effort */ }
        if (!args.res.headersSent) {
          // Let the outer Express error handler send the JSON error response.
        } else {
          // Emit structured error frame before propagating so clients know why
          // the stream closed without a final `done` event.
          try {
            if (responsesEncoder) {
              writeResponsesEvents(args.res, responsesEncoder, {
                type: "error",
                error: streamErrorPayload(terminalError),
              });
            } else {
              args.res.write(toErrorStreamEvent(streamErrorPayload(terminalError)));
            }
          } catch { /* best-effort */ }
          try {
            if (externalCompatibility) args.res.end();
            else closeEventStream(args.res);
          } catch { /* best-effort */ }
        }
        throw terminalError;
      } finally {
        clearInterval(providerKeepalive);
        activeSettlementCheckpoint = null;
        activeSettlementLane = null;
      }

      return;
    }

    let routed: Awaited<ReturnType<typeof generateEngine>>;
    const runDirect = async (nextRequest: Request) => {
      const direct = externalCompatibility ? null : withDirectDeadline(lifecycle.signal);
      try {
        return await generateEngine(nextRequest, {
          signal: direct?.signal || lifecycle.signal,
          retriesPerTarget: externalCompatibility ? 0 : undefined,
        });
      } finally {
        direct?.cleanup();
      }
    };
    try {
      routed = await runDirect(request);
    } catch (error) {
      if (!contextPlan?.enabled || !isContextOverflowError(error)) throw error;
      const retryPlan = manageContext({
        request,
        model: contextModel,
        defaultEnabled: true,
        aggressive: true,
      });
      if (!retryPlan.compacted || retryPlan.effectiveEstimatedTokens >= contextPlan.effectiveEstimatedTokens) throw error;
      request = retryPlan.request;
      contextPlan = retryPlan;
      if (!args.res.headersSent) {
        args.res.setHeader("x-context-management", "truncated-retry");
        args.res.setHeader("x-context-effective-estimated-tokens", String(retryPlan.effectiveEstimatedTokens));
      }
      routed = await runDirect(request);
    }

    applyRoutingHeaders(args.res, routed.route);

    const output = routed.result.output;
    markInferenceFirstOutput(telemetry);
    const jsonReceipt = await settleOutput(output);
    applyReceiptHeader(args.res, jsonReceipt);

    const record: StoredResponseRecord = {
      ...baseRecord,
      status: output.media?.jobId && output.media.status && output.media.status !== "completed" ? "in_progress" : "completed",
      output,
      ...(output.media?.jobId ? { jobId: output.media.jobId } : {}),
    };
    await saveResponseRecord(record);
    await finishTelemetry("succeeded");

    if (args.shape === "chat") {
      const body = toChatCompletionsResponse(modelId, request.responseId, output) as unknown as Record<string, unknown>;
      args.res.status(200).json(attachReceiptToJsonBody(body, jsonReceipt));
      return;
    }

    if (args.shape === "embeddings") {
      const body = toEmbeddingsResponse(modelId, output) as unknown as Record<string, unknown>;
      args.res.status(200).json(attachReceiptToJsonBody(body, jsonReceipt));
      return;
    }

    const payload = toResponsesResponse(modelId, request.responseId, output) as unknown as Record<string, unknown>;
    if (record.status !== "completed") {
      payload.status = record.status;
    }
    if (record.jobId) {
      payload.job_id = record.jobId;
    }
    args.res.status(200).json(attachReceiptToJsonBody(payload, jsonReceipt));
  } catch (error) {
    await abortPaidInference(error instanceof Error ? error.message : "inference_failed");
    await saveResponseRecord({
      ...baseRecord,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    await finishTelemetry(lifecycle.aborted() ? "aborted" : "failed", error);
    if (externalCompatibility && !args.res.headersSent) {
      writeAdaptedError(args.res, error, 500);
      return;
    }
    throw error;
  } finally {
    lifecycle.signal.removeEventListener("abort", abortPaymentOnClose);
    lifecycle.cleanup();
  }
}

export async function handleResponses(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!validateStreamFlag(body, res)) {
      return;
    }

    const request = normalizeResponsesRequest(body);
    if (!validateStreamingModality(request, res)) {
      return;
    }

    if (!request.model) {
      res.status(400).json(createCoreErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    if (request.modality === "embedding" && !request.embeddingInput && request.messages.length === 0) {
      res.status(400).json(createCoreErrorResponse("input is required for embeddings", "invalid_request_error", "missing_input"));
      return;
    }

    if (request.modality !== "embedding" && request.messages.length === 0 && !request.previousResponseId) {
      res.status(400).json(createCoreErrorResponse("input is required", "invalid_request_error", "missing_input"));
      return;
    }

    await executeRequest({ req, res, request, shape: "responses" });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleModelResponses(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const rawModelId = Array.isArray(req.params.modelId) ? req.params.modelId[0] : req.params.modelId;
  const modelId = typeof rawModelId === "string" ? rawModelId : "";
  if (!modelId) {
    res.status(400).json(createCoreErrorResponse("modelId is required", "invalid_request_error", "missing_model"));
    return;
  }

  if (getPaymentSignatureFromRequest(req) && !getNetworkFromRequest(req)) {
    res.status(400).json({ error: "x-network-id header is required" });
    return;
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  if (body.model !== undefined && body.model !== modelId) {
    res.status(400).json(createCoreErrorResponse("body model must match path modelId", "invalid_request_error", "model_conflict"));
    return;
  }

  if (shouldDirectChallenge(req)) {
    const resourceUrl = publicResourceUrl(req);
    sendPaymentRequired(res, await buildModelEndpointPaymentRequired(modelId, resourceUrl));
    return;
  }

  req.body = {
    ...body,
    model: modelId,
  };
  await handleResponses(req, res);
}

async function handleGetResponse(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      res.status(400).json(createCoreErrorResponse("response id is required", "invalid_request_error", "missing_response_id"));
      return;
    }
    const responseId = id;
    // NOTE: Retrieval is NOT a billable inference action. The user already paid on creation.
    const record = await getResponseRecord(responseId);
    if (!record) {
      res.status(404).json(createCoreErrorResponse(`Response '${responseId}' not found`, "invalid_request_error", "response_not_found"));
      return;
    }

    if (record.status === "in_progress" && record.jobId) {
      const status = await retrieveEngine(record.jobId);
      if (status.status === "completed") {
        record.status = "completed";
        if (record.output?.media) {
          record.output.media = {
            ...record.output.media,
            ...(status.url ? { url: status.url } : {}),
            status: "completed",
          };
        }
      } else if (status.status === "failed") {
        record.status = "failed";
        record.error = status.error || "response_failed";
      } else {
        record.status = "in_progress";
      }
      await saveResponseRecord(record);
    }

    res.status(200).json(responseFromRecord(record));
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleGetResponseInputItems(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      res.status(400).json(createCoreErrorResponse("response id is required", "invalid_request_error", "missing_response_id"));
      return;
    }

    const record = await getResponseRecord(id);
    if (!record) {
      res.status(404).json(createCoreErrorResponse(`Response '${id}' not found`, "invalid_request_error", "response_not_found"));
      return;
    }

    res.status(200).json({
      object: "list",
      data: inputItemsFromRecord(record),
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleAppendResponseInputItems(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      res.status(400).json(createCoreErrorResponse("response id is required", "invalid_request_error", "missing_response_id"));
      return;
    }

    const record = await getResponseRecord(id);
    if (!record) {
      res.status(404).json(createCoreErrorResponse(`Response '${id}' not found`, "invalid_request_error", "response_not_found"));
      return;
    }
    if (record.status !== "in_progress") {
      res.status(409).json(createCoreErrorResponse(`Response '${id}' is not active`, "invalid_request_error", "response_not_active"));
      return;
    }

    const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body))
      ? req.body as Record<string, unknown>
      : {};
    const input = Object.prototype.hasOwnProperty.call(body, "input")
      ? body.input
      : Object.prototype.hasOwnProperty.call(body, "message")
        ? body.message
        : Object.prototype.hasOwnProperty.call(body, "prompt")
          ? body.prompt
          : body;
    const normalized = normalizeResponsesRequest({
      model: record.model,
      input,
      ...(record.previousResponseId ? { previous_response_id: record.previousResponseId } : {}),
      ...(body.instructions ? { instructions: body.instructions } : {}),
      ...(body.custom_params ? { custom_params: body.custom_params } : {}),
      ...(body.params ? { custom_params: body.params } : {}),
    });

    const appended = await appendRealtimeEngine(id, {
      ...body,
      model: record.model,
      ...(record.operation ? { operation: record.operation } : {}),
      input,
      messages: normalized.messages,
      customParams: normalized.customParams,
    });
    if (!appended) {
      res.status(409).json(createCoreErrorResponse(`Response '${id}' has no active realtime stream`, "invalid_request_error", "realtime_stream_not_active"));
      return;
    }

    record.inputMessages = [...(record.inputMessages || []), ...normalized.messages];
    await saveResponseRecord(record);

    res.status(200).json({
      object: "list",
      data: inputItemsFromRecord(record),
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleCancelResponse(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      res.status(400).json(createCoreErrorResponse("response id is required", "invalid_request_error", "missing_response_id"));
      return;
    }
    const responseId = id;
    // NOTE: Cancel is NOT a billable inference action. The user already paid on creation.
    const record = await getResponseRecord(responseId);
    if (!record) {
      res.status(404).json(createCoreErrorResponse(`Response '${responseId}' not found`, "invalid_request_error", "response_not_found"));
      return;
    }

    if (record.jobId) {
      await cancelEngine(record.jobId);
    }
    await closeRealtimeEngine(responseId);

    record.status = "cancelled";
    await saveResponseRecord(record);
    res.status(200).json(responseFromRecord(record));
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function runDeferredInference(args: {
  req: Req;
  res: Res;
  request: Request;
  provider: ModelProvider;
  card: ModelCard | null;
  execute: (signal: AbortSignal) => Promise<Output>;
  onSuccess: (result: Output, receipt: Receipt | null) => void | Promise<void>;
}): Promise<void> {
  const resolved: ResolvedModel = {
    modelId: args.request.model,
    provider: args.provider,
    known: true,
    card: args.card,
  };
  const lifecycle = createRequestAbort(args.req, args.res);
  const paid = await preparePaidInference({
    req: args.req,
    res: args.res,
    request: args.request,
    resolved,
  });
  if (!paid) {
    lifecycle.cleanup();
    return;
  }
  const telemetry = startInferenceTelemetry({
    userAddress: readHeader(args.req, "x-session-user-address"),
    network: getNetworkFromInferenceRequest(args.req),
    request: args.request,
    resolved: paid.resolved,
  });
  let telemetryFinished = false;
  const finishTelemetry = async (status: "succeeded" | "failed" | "aborted", error?: unknown) => {
    if (telemetryFinished) return;
    telemetryFinished = true;
    await finishInferenceTelemetry(telemetry, status, error);
  };
  let paymentTerminal = false;
  const abortPaidInference = async (reason: string) => {
    if (paymentTerminal) {
      return;
    }
    paymentTerminal = true;
    await paid.payment.abort(reason);
  };
  const abortPaymentOnClose = () => {
    void abortPaidInference(abortError(lifecycle.signal).message).catch((error) => {
      console.warn("[gateway] failed to abort deferred inference payment after client close:", error instanceof Error ? error.message : String(error));
    });
  };
  lifecycle.signal.addEventListener("abort", abortPaymentOnClose, { once: true });

  try {
    const direct = args.res.locals.externalCompatibility === true ? null : withDirectDeadline(lifecycle.signal);
    let result: Output;
    try {
      result = await args.execute(direct?.signal || lifecycle.signal);
    } finally {
      direct?.cleanup();
    }
    markInferenceFirstOutput(telemetry);
    const { receipt, settlement, quote } = await settlePaidInference({
      req: args.req,
      res: args.res,
      payment: paid.payment,
      request: args.request,
      output: result,
      resolved: paid.resolved,
      onPaymentBacked: () => {
        paymentTerminal = true;
      },
    });
    const telemetrySettlement = addInferenceSettlement(telemetry, quote, settlement, receipt?.id);
    try {
      await persistInferenceSettlement(telemetry, telemetrySettlement);
    } catch (error) {
      console.error("[analytics] Failed to persist deferred inference settlement", error);
    }
    paymentTerminal = true;
    applyReceiptHeader(args.res, receipt);
    await args.onSuccess(result, receipt);
    await finishTelemetry("succeeded");
    lifecycle.done();
  } catch (error) {
    await abortPaidInference(error instanceof Error ? error.message : "inference_failed");
    await finishTelemetry(lifecycle.aborted() ? "aborted" : "failed", error);
    throw error;
  } finally {
    lifecycle.signal.removeEventListener("abort", abortPaymentOnClose);
    lifecycle.cleanup();
  }
}

// =============================================================================
// Endpoint Handlers
// =============================================================================

export async function handleListModels(req: Req, res: Res, extended = false): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const models = extended ? getExtendedModels() : getCompiledModels();
    const cache = extended ? extendedCatalogPayloads : compiledCatalogPayloads;
    const payload = cachedCatalogPayload(cache, models, () => ({
      object: "list",
      data: models.models.map(withModelOperations),
    }));
    sendCatalogPayload(req, res, payload);
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleListModelIndex(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const catalog = getCompiledModels();
    const payload = cachedCatalogPayload(modelIndexPayloads, catalog, () => ({
      object: "list",
      version: catalog.lastUpdated,
      total: catalog.models.length,
      data: catalog.models.map(modelIndexCard),
    }));
    sendCatalogPayload(req, res, payload);
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleSearchModels(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const query = (req.query || {}) as Record<string, unknown>;
    const pickString = (key: string): string | undefined => {
      const v = body[key] ?? query[key];
      return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
    };
    const pickNumber = (key: string): number | undefined => {
      const v = body[key] ?? query[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim().length > 0) {
        const parsed = Number(v);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    };
    const pickBoolean = (key: string): boolean | undefined => {
      const v = body[key] ?? query[key];
      if (typeof v === "boolean") return v;
      if (v === "true") return true;
      if (v === "false") return false;
      return undefined;
    };

    const rawModality = pickString("modality");
    const modality = rawModality && isCanonicalModality(rawModality) ? rawModality : undefined;
    if (rawModality && !modality) {
      res.status(400).json(createErrorResponse(MODALITY_ERROR, "invalid_request_error", "invalid_modality"));
      return;
    }
    const operation = pickString("operation");
    if (operation && !isCanonicalOperation(operation)) {
      res.status(400).json(createErrorResponse("operation is not supported", "invalid_request_error", "invalid_operation"));
      return;
    }
    const rawProvider = pickString("provider");
    const provider = rawProvider && isProvider(rawProvider) ? rawProvider : undefined;
    if (rawProvider && !provider) {
      res.status(400).json(createErrorResponse("provider is not supported", "invalid_request_error", "invalid_provider"));
      return;
    }

    const result = searchModels({
      q: pickString("q"),
      modality: modality as ModelSearchInput["modality"],
      operation: operation as ModelSearchInput["operation"],
      provider,
      priceMaxPerMTok: pickNumber("priceMaxPerMTok") ?? pickNumber("price_max_per_mtok"),
      contextWindowMin: pickNumber("contextWindowMin") ?? pickNumber("context_window_min"),
      streaming: pickBoolean("streaming"),
      cursor: pickString("cursor"),
      limit: pickNumber("limit"),
    });

    res.status(200).json({
      object: "list",
      data: result.data.map(withModelOperations),
      total: result.total,
      next_cursor: result.next_cursor,
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleListFamilies(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    res.status(200).json({
      object: "list",
      data: getFamilyCatalog(getExtendedModels().models),
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleGetFamily(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const raw = Array.isArray(req.params.family) ? req.params.family[0] : req.params.family;
    const family = normalizeFamily(raw);
    if (!family) {
      res.status(400).json(createErrorResponse("family is required", "invalid_request_error", "invalid_family"));
      return;
    }

    const entry = getFamilyCatalog(getExtendedModels().models).find((item) => item.family === family);
    if (!entry) {
      res.status(404).json(createErrorResponse(`Family '${family}' not found`, "invalid_request_error", "family_not_found"));
      return;
    }

    res.status(200).json(entry);
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleListModalities(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const models = getExtendedModels().models;
    res.status(200).json({
      object: "list",
      data: getModalityCatalog(models),
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleGetModality(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const rawModality = Array.isArray(req.params.modality) ? req.params.modality[0] : req.params.modality;
    if (!isCanonicalModality(rawModality)) {
      res.status(400).json(createErrorResponse(MODALITY_ERROR, "invalid_request_error", "invalid_modality"));
      return;
    }

    const entry = getModalityCatalog(getExtendedModels().models).find((item) => item.modality === rawModality);
    res.status(200).json(entry);
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleListModalityOperations(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const rawModality = Array.isArray(req.params.modality) ? req.params.modality[0] : req.params.modality;
    if (!isCanonicalModality(rawModality)) {
      res.status(400).json(createErrorResponse(MODALITY_ERROR, "invalid_request_error", "invalid_modality"));
      return;
    }

    const models = getExtendedModels().models;
    res.status(200).json({
      object: "list",
      data: getModalityOperations(models, rawModality),
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleListOperationModels(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const rawModality = Array.isArray(req.params.modality) ? req.params.modality[0] : req.params.modality;
    const rawOperation = Array.isArray(req.params.operation) ? req.params.operation[0] : req.params.operation;
    if (!isCanonicalModality(rawModality)) {
      res.status(400).json(createErrorResponse(MODALITY_ERROR, "invalid_request_error", "invalid_modality"));
      return;
    }
    if (!isCanonicalOperation(rawOperation)) {
      res.status(400).json(createErrorResponse("operation is not supported", "invalid_request_error", "invalid_operation"));
      return;
    }

    const query = (req.query || {}) as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const result = searchModels({
      q: typeof query.q === "string" ? query.q : undefined,
      modality: rawModality,
      operation: rawOperation,
      provider: typeof query.provider === "string" ? query.provider as ModelProvider : undefined,
      streaming: query.streaming === "true" ? true : query.streaming === "false" ? false : undefined,
      cursor: typeof query.cursor === "string" ? query.cursor : undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });

    res.status(200).json({
      object: "list",
      data: result.data.map((model) => ({
        ...model,
        operations: getModelCapabilities(model),
      })),
      total: result.total,
      next_cursor: result.next_cursor,
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleModelParams(req: Req, res: Res): Promise<void> {
  const { handleGetModelParams } = await import("./params-handler.js");
  await handleGetModelParams(req, res);
}

export async function handleGetModel(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const modelIdParam = req.params.model || req.params.id;
    const modelId = Array.isArray(modelIdParam) ? modelIdParam[0] : modelIdParam;
    if (!modelId) {
      res.status(400).json(createErrorResponse("Model ID is required", "invalid_request_error", "missing_model_id"));
      return;
    }

    const model = getModelById(modelId);
    if (!model) {
      res
        .status(404)
        .json(createErrorResponse(`Model '${modelId}' not found`, "invalid_request_error", "model_not_found"));
      return;
    }

    res.status(200).json(withModelOperations(model));
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleChatCompletions(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!validateStreamFlag(body, res)) {
      return;
    }

    const request = normalizeChatRequest(body);
    if (!validateStreamingModality(request, res)) {
      return;
    }

    if (!request.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res
        .status(400)
        .json(createErrorResponse("messages is required and must be a non-empty array", "invalid_request_error", "missing_messages"));
      return;
    }

    // Legacy attachments are normalized into the user message payload.
    if (typeof body.image_url === "string" || typeof body.audio_url === "string" || typeof body.video_url === "string") {
      const source = body as unknown as ChatCompletionRequest;
      request.messages = applyLegacyAttachments(request.messages as any, source) as any;
    }

    await executeRequest({
      req,
      res,
      request,
      shape: "chat",
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleImageGeneration(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = req.body as ImageGenerationRequest;
    if (!body.prompt) {
      res.status(400).json(createErrorResponse("prompt is required", "invalid_request_error", "missing_prompt"));
      return;
    }

    if (!body.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    const model = body.model;
    const request = normalizeResponsesRequest({
      model,
      input: [{ type: "input_text", text: body.prompt }],
      modalities: ["image"],
      n: body.n,
      size: body.size,
      quality: body.quality,
      image_url: body.image_url || body.image,
      attachments: body.attachments,
      attachment: body.attachment,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      request,
      provider: resolved.provider,
      card: resolved.card,
      execute: (signal) => invokeDirectAdapter(request, signal),
      onSuccess: (output, receipt) => {
        const media = getRequiredOutputMedia(output);
        const body = adaptImageResponse({
          images: [
            media.base64
              ? { b64_json: media.base64 }
              : { url: media.url },
          ],
        });
        res.status(200).json(
          attachReceiptToJsonBody(
            body,
            receipt,
          ),
        );
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleImageEdit(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = req.body as { image?: string; prompt?: string; model?: string; n?: number; size?: string };
    if (!body.image) {
      res.status(400).json(createErrorResponse("image is required", "invalid_request_error", "missing_image"));
      return;
    }
    if (!body.prompt) {
      res.status(400).json(createErrorResponse("prompt is required", "invalid_request_error", "missing_prompt"));
      return;
    }

    if (!body.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    const model = body.model;
    const request = normalizeResponsesRequest({
      model,
      input: [{ type: "input_text", text: body.prompt }],
      modalities: ["image"],
      n: body.n,
      size: body.size,
      image_url: body.image,
      attachments: (body as Record<string, unknown>).attachments,
      attachment: (body as Record<string, unknown>).attachment,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      request,
      provider: resolved.provider,
      card: resolved.card,
      execute: (signal) => invokeDirectAdapter(request, signal),
      onSuccess: (output, receipt) => {
        const media = getRequiredOutputMedia(output);
        const body = adaptImageResponse({
          images: [
            media.base64
              ? { b64_json: media.base64 }
              : { url: media.url },
          ],
        });
        res.status(200).json(attachReceiptToJsonBody(body, receipt));
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleAudioSpeech(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = req.body as AudioSpeechRequest;
    if (!body.input) {
      res.status(400).json(createErrorResponse("input is required", "invalid_request_error", "missing_input"));
      return;
    }

    if (!body.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    const model = body.model;
    const format = body.response_format;
    const request = normalizeResponsesRequest({
      model,
      input: [{ type: "input_text", text: body.input }],
      modalities: ["audio"],
      voice: body.voice,
      speed: body.speed,
      response_format: format,
      attachments: body.attachments,
      attachment: body.attachment,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      request,
      provider: resolved.provider,
      card: resolved.card,
      execute: (signal) => invokeDirectAdapter(request, signal),
      onSuccess: async (output) => {
        const media = getRequiredOutputMedia(output);
        res.setHeader("Content-Type", media.mimeType || "audio/mpeg");
        res.send(await readOutputMediaBuffer(output));
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleAudioTranscription(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = req.body as AudioTranscriptionRequest;
    if (typeof body.file !== "string" || body.file.trim().length === 0) {
      res.status(400).json(createErrorResponse("file is required", "invalid_request_error", "missing_file"));
      return;
    }

    if (!body.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    const model = body.model;
    const audioUrl = normalizeAudioTranscriptionFile(body.file);
    const request = normalizeResponsesRequest({
      model,
      input: [{ type: "input_audio", audio_url: audioUrl }],
      modalities: ["audio"],
      language: body.language,
      response_format: body.response_format,
      attachments: body.attachments,
      attachment: body.attachment,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      request,
      provider: resolved.provider,
      card: resolved.card,
      execute: (signal) => invokeDirectAdapter(request, signal),
      onSuccess: (output, receipt) => {
        const response = adaptTranscriptionResponse({ text: output.content || "" });
        if (body.response_format === "text") {
          res.setHeader("Content-Type", "text/plain");
          res.send(response.text);
          return;
        }
        res.status(200).json(attachReceiptToJsonBody(response, receipt));
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleEmbeddings(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const request = normalizeEmbeddingsRequest(body);
    if (!request.embeddingInput) {
      res.status(400).json(createErrorResponse("input is required", "invalid_request_error", "missing_input"));
      return;
    }
    if (!request.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    await executeRequest({
      req,
      res,
      request,
      shape: "embeddings",
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleVideoGeneration(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = req.body as VideoGenerationRequest;
    if (!body.prompt) {
      res.status(400).json(createErrorResponse("prompt is required", "invalid_request_error", "missing_prompt"));
      return;
    }
    if (!body.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    const request = normalizeResponsesRequest({
      model: body.model,
      input: [{ type: "input_text", text: body.prompt }],
      modalities: ["video"],
      duration: body.duration,
      aspect_ratio: body.aspect_ratio,
      size: body.size,
      image_url: body.image_url || body.image,
      attachments: body.attachments,
      attachment: body.attachment,
    });

    const resolved = resolveModel(body.model);
    await runDeferredInference({
      req,
      res,
      request,
      provider: resolved.provider,
      card: resolved.card,
      execute: (signal) => invokeDirectAdapter(request, signal),
      onSuccess: (output, receipt) => {
        const media = getRequiredOutputMedia(output);
        if (media.jobId && media.status && media.status !== "completed") {
          res.status(202).json(attachReceiptToJsonBody({
            id: media.jobId,
            object: "video.generation",
            status: media.status,
            created: Math.floor(Date.now() / 1000),
            model: body.model,
          }, receipt));
          return;
        }

        const responseBody = adaptVideoResponse(
          {
            videos: [
              {
                base64: media.base64,
                url: media.url,
                duration: body.duration ?? media.duration,
              },
            ],
          },
          body.model,
        );
        res.status(200).json(attachReceiptToJsonBody(responseBody, receipt));
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleVideoStatus(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const jobIdParam = req.params.id;
    const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
    if (!jobId) {
      res
        .status(400)
        .json(createErrorResponse("Video job ID is required", "invalid_request_error", "missing_job_id"));
      return;
    }

    // NOTE: Status polling is NOT billable. Charge happens on generation submission.
    const status = await retrieveDirectAdapter(jobId);
    res.status(200).json({
      id: jobId,
      object: "video.generation",
      status: status.status,
      url: status.url,
      error: status.error,
      progress: status.progress,
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

/**
 * Server-Sent Events stream that polls the video job until it reaches a
 * terminal state and forwards every intermediate status update as a
 * `video.status` event. Not billable — the inference charge happens
 * on /v1/videos/generations submission.
 *
 * Query params:
 *   - pollIntervalMs  (default 2000, min 500, max 30000)
 *   - timeoutMs       (default 1800000, min 5000, max 3600000)
 */
export async function handleVideoStatusStream(req: Req, res: Res): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const jobIdParam = req.params.id;
  const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
  if (!jobId) {
    res.status(400).json(createErrorResponse("Video job ID is required", "invalid_request_error", "missing_job_id"));
    return;
  }

  const pollInterval = Math.min(Math.max(
    parseInt(String(req.query.pollIntervalMs ?? ""), 10) || 2000,
    500,
  ), 30_000);
  const timeoutMs = Math.min(Math.max(
    parseInt(String(req.query.timeoutMs ?? ""), 10) || 1_800_000,
    5_000,
  ), 3_600_000);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const startedAt = Date.now();
  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  try {
    while (!cancelled) {
      let status: { status: "queued" | "processing" | "completed" | "failed"; url?: string; error?: string; progress?: number };
      try {
        status = await retrieveDirectAdapter(jobId);
      } catch (pollError) {
        res.write(toErrorStreamEvent({
          code: "upstream_error",
          message: pollError instanceof Error ? pollError.message : String(pollError),
        }));
        res.write(formatCoreSSEDone());
        res.end();
        return;
      }

      res.write(toVideoStatusStreamEvent({
        jobId,
        status: status.status,
        progress: status.progress,
        url: status.url,
        error: status.error,
      }));

      if (status.status === "completed" || status.status === "failed") {
        res.write(formatCoreSSEDone());
        res.end();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        res.write(toErrorStreamEvent({
          code: "upstream_timeout",
          message: `Video job ${jobId} did not complete within ${timeoutMs}ms`,
        }));
        res.write(formatCoreSSEDone());
        res.end();
        return;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }

    // Client disconnected
    try { res.end(); } catch { /* already closed */ }
  } catch (error) {
    if (!res.headersSent) {
      writeAdaptedError(res, error, 500);
      return;
    }
    try {
      res.write(toErrorStreamEvent({
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      }));
      res.write(formatCoreSSEDone());
      res.end();
    } catch { /* best-effort */ }
  }
}
