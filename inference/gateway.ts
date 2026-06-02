import type { Express, NextFunction, Request as Req, Response as Res } from "express";
import type { PaymentRequired } from "@x402/core/types";

import {
  getCompiledModels,
  getExtendedModels,
  getModelById,
  resolveModel,
  searchModels,
  type ModelSearchInput,
  type ResolvedModel,
} from "./catalog/registry.js";
import { isProvider, type ModelCard, type ModelProvider } from "./types.js";
import type { AdapterStatus } from "./catalog/adapter.js";
import {
  CANONICAL_MODALITIES,
  getModelCapabilities,
  getModalityCatalog,
  getModalityOperations,
  isCanonicalModality,
  isCanonicalOperation,
} from "./catalog/modalities/index.js";
import {
  getFamilyCatalog,
  normalizeFamily,
} from "./catalog/families/index.js";
import {
  buildResolvedAuthorizationInput,
  buildSettlementMeterFromOutput,
} from "../x402/metering.js";
import {
  kickBatchSettlement,
  prepareInferencePayment,
  settlePreparedInferencePayment,
  type PreparedInferencePayment,
  type InferenceAuthorizationInput,
} from "../x402/index.js";
import { type Receipt } from "../http/request-context.js";
import {
  type MeteredSettlementInput,
} from "../x402/metering.js";
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
  toReceiptStreamEvent,
  toErrorStreamEvent,
  toVideoStatusStreamEvent,
  type Message,
  type Output,
  type Request,
  type Event,
} from "./core.js";
import {
  cancel as cancelEngine,
  generate as generateEngine,
  retrieve as retrieveEngine,
  stream as streamEngine,
} from "./engine.js";
import { redisGet, redisSet } from "../x402/keys/redis.js";

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

export interface ChatMessage {
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
  messages: ChatMessage[];
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
  prompt: string;
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

interface StoredResponseRecord {
  id: string;
  model: string;
  provider: ModelProvider;
  createdAt: number;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  inputMessages?: Message[];
  previousResponseId?: string;
  output?: Output;
  jobId?: string;
  error?: string;
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
  { method: "GET", path: "/v1/responses/:id", handler: handleGetResponse, description: "Retrieve response by ID" },
  { method: "GET", path: "/v1/responses/:id/input_items", handler: handleGetResponseInputItems, description: "Retrieve response input items" },
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
  const paymentRequired = getPaymentRequiredBody(asRecord) ?? getPaymentRequiredBody(causeRecord);
  const paymentRequiredHeader = getPaymentRequiredHeader(asRecord) ?? getPaymentRequiredHeader(causeRecord);

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
    return {
      status: 404,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Model not found",
        "invalid_request_error",
        "model_not_found",
      ),
    };
  }

  if (statusCode === 400) {
    return {
      status: 400,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Invalid request",
        "invalid_request_error",
        "invalid_request",
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
    return {
      status: 429,
      body: createErrorResponse(
        error instanceof Error ? error.message : "Rate limit exceeded",
        "rate_limit_error",
        "rate_limit_exceeded",
      ),
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

const REALTIME_REST_ERROR = "This model requires a realtime WebSocket session.";

function rejectRealtimeRequest(request: Request, res: Res): boolean {
  if (request.modality !== "realtime") {
    return false;
  }

  res.status(400).json(createCoreErrorResponse(
    REALTIME_REST_ERROR,
    "invalid_request_error",
    "realtime_session_required",
  ));
  return true;
}

function usesProviderStream(request: Request): boolean {
  if (request.modality === "text") {
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

function applyLegacyAttachments(messages: ChatMessage[], body: ChatCompletionRequest): ChatMessage[] {
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
  const parts: ChatContentPart[] = [];

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

const RESPONSE_RECORD_TTL_SECONDS = 24 * 60 * 60;
const responseRecordMemory = new Map<string, StoredResponseRecord>();
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

function composeSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
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
  const combined = composeSignals([parent, deadline.signal]);
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

function responseRecordKey(id: string): string {
  return `responses:record:${id}`;
}

async function saveResponseRecord(record: StoredResponseRecord): Promise<void> {
  responseRecordMemory.set(record.id, record);
  try {
    await redisSet(responseRecordKey(record.id), JSON.stringify(record), RESPONSE_RECORD_TTL_SECONDS);
  } catch (error) {
    console.warn("[gateway] Failed to persist response record to Redis:", error instanceof Error ? error.message : String(error));
  }
}

async function getResponseRecord(id: string): Promise<StoredResponseRecord | null> {
  const memory = responseRecordMemory.get(id);
  if (memory) {
    return memory;
  }

  try {
    const raw = await redisGet(responseRecordKey(id));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredResponseRecord;
    responseRecordMemory.set(id, parsed);
    return parsed;
  } catch (error) {
    console.warn("[gateway] Failed to read response record from Redis:", error instanceof Error ? error.message : String(error));
    return null;
  }
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
}): Promise<Receipt | null> {
  const settlementReceipt = await settlePreparedInferencePayment(
    args.payment,
    args.res,
    {
      meter: buildSettlementMeterFromOutput({
        request: args.request,
        output: args.output,
        resolved: args.resolved,
      }).meter as MeteredSettlementInput,
    },
  );

  if (
    settlementReceipt
    && BigInt(settlementReceipt.finalAmountWei || "0") > 0n
    && !settlementReceipt.txHash
    && !settlementReceipt.paymentIntentId
    && !settlementReceipt.sessionBudgetIntentId
    && !(settlementReceipt.paymentChannelId && settlementReceipt.paymentCumulativeAmountWei)
  ) {
    throw Object.assign(
      new Error("Nonzero settlement is missing x402 payment backing"),
      { statusCode: 402 },
    );
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
        composeFeeWei: settlementReceipt.platformFeeWei || "0",
        finalAmountWei: settlementReceipt.finalAmountWei,
        settlementStatus: settlementReceipt.settlementStatus || (settlementReceipt.txHash ? "settled" : "queued"),
        txHash: settlementReceipt.txHash,
        claimTxHash: settlementReceipt.claimTxHash,
        settleTxHash: settlementReceipt.settleTxHash,
        paymentIntentId: settlementReceipt.paymentIntentId,
        sessionBudgetIntentId: settlementReceipt.sessionBudgetIntentId,
        paymentChannelId: settlementReceipt.paymentChannelId,
        paymentCumulativeAmountWei: settlementReceipt.paymentCumulativeAmountWei,
        chainId: settlementReceipt.chainId || getChainIdFromInferenceRequest(args.req),
        settledAt: settlementReceipt.settledAt,
      });
    }
  }
  if (settlementReceipt?.evidenceOnly) {
    if (shouldKickSettlement(args.req)) {
      await kickBatchSettlement(settlementReceipt, "inference:evidence");
    }
    return null;
  }
  const receipt = await finalizeReceipt(
    receiptFromInferenceSettlement(settlementReceipt, getChainIdFromInferenceRequest(args.req)),
    receiptContextFromInferenceRequest(args.req),
  );
  if (shouldKickSettlement(args.req)) {
    await kickBatchSettlement(settlementReceipt, "inference:receipt");
  }
  return receipt;
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
  return !readHeader(req, "x-execution-run-id");
}

function readHeader(req: Req, name: string): string | undefined {
  const value = req.get?.(name) || req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getChainIdFromInferenceRequest(req: Req): number | undefined {
  const header = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    resource: `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url || ""}`,
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

function outputToAssistantMessage(output: Output): Message | null {
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

async function buildResponsesHistory(responseId: string, visited = new Set<string>()): Promise<Message[]> {
  if (visited.has(responseId)) {
    throw Object.assign(new Error(`Response history cycle detected for '${responseId}'`), { statusCode: 400 });
  }

  visited.add(responseId);
  const record = await getResponseRecord(responseId);
  if (!record) {
    throw Object.assign(new Error(`Response '${responseId}' not found`), { statusCode: 404 });
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

async function hydrateResponsesRequest(request: Request): Promise<Request> {
  const priorMessages = request.previousResponseId
    ? await buildResponsesHistory(request.previousResponseId)
    : [];
  const currentMessages = request.instructions
    ? [{ role: "system", content: request.instructions } satisfies Message, ...priorMessages, ...request.messages]
    : [...priorMessages, ...request.messages];

  return {
    ...request,
    messages: currentMessages,
  };
}

function inputItemsFromRecord(record: StoredResponseRecord): Record<string, unknown>[] {
  return (record.inputMessages || []).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
  }));
}

async function executeRequest(args: {
  req: Req;
  res: Res;
  request: Request;
  shape: ResponseShape;
}): Promise<void> {
  const request = args.shape === "responses"
    ? await hydrateResponsesRequest(args.request)
    : args.request;
  const modelId = request.model;
  if (!modelId) {
    args.res.status(400).json(createCoreErrorResponse("model is required", "invalid_request_error", "missing_model"));
    return;
  }

  if (rejectRealtimeRequest(request, args.res)) {
    return;
  }

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
  let paymentTerminal = false;
  const abortPaidInference = async (reason: string) => {
    if (paymentTerminal) {
      return;
    }
    paymentTerminal = true;
    await paid.payment.abort(reason);
  };
  const settleOutput = async (output: Output) => {
    const receipt = await settlePaidInference({
      req: args.req,
      res: args.res,
      payment: paid.payment,
      request,
      output,
      resolved: paid.resolved,
    });
    paymentTerminal = true;
    return receipt;
  };
  const abortPaymentOnClose = () => {
    void abortPaidInference(abortError(lifecycle.signal).message).catch((error) => {
      console.warn("[gateway] failed to abort inference payment after client close:", error instanceof Error ? error.message : String(error));
    });
  };
  lifecycle.signal.addEventListener("abort", abortPaymentOnClose, { once: true });

  const baseRecord: StoredResponseRecord = {
    id: request.responseId,
    model: modelId,
    provider: paid.resolved.provider,
    createdAt: Math.floor(Date.now() / 1000),
    status: "in_progress",
    inputMessages: args.shape === "responses" ? args.request.messages : undefined,
    previousResponseId: args.shape === "responses" ? args.request.previousResponseId : undefined,
  };
  await saveResponseRecord(baseRecord);

  try {
    if (request.stream && args.shape === "responses" && !usesProviderStream(request)) {
      args.res.setHeader("Content-Type", "text/event-stream");
      args.res.setHeader("Cache-Control", "no-cache");
      args.res.setHeader("Connection", "keep-alive");
      args.res.setHeader("x-response-id", request.responseId);
      applyRoutingHeaders(args.res, {
        attempts: 1,
        fallbackUsed: false,
        primary: { modelId },
        final: { modelId },
      });
      paid.payment.applyHeaders(args.res);
      args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, { type: "created" })));

      try {
        const direct = withDirectDeadline(lifecycle.signal);
        let routed: Awaited<ReturnType<typeof generateEngine>>;
        try {
          routed = await generateEngine(request, { signal: direct.signal });
        } finally {
          direct.cleanup();
        }
        const output = routed.result.output;
        const receipt = await settleOutput(output);
        let finalOutput = output;

        toResponsesOutputItems(output).forEach((item, outputIndex) => {
          args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, {
            type: "output-item",
            outputIndex,
            item,
          })));
        });

        if (receipt) {
          args.res.write(toReceiptStreamEvent(receiptStreamPayload(receipt)));
        }

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
                args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, {
                  type: "output-item",
                  outputIndex,
                  item,
                })));
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
              args.res.write(toErrorStreamEvent({
                code: "upstream_error",
                message: status.error || `Video job ${jobId} failed`,
              }));
              break;
            }

            if (Date.now() - startedAt >= timeoutMs) {
              args.res.write(toErrorStreamEvent({
                code: "upstream_timeout",
                message: `Video job ${jobId} did not complete within ${timeoutMs}ms`,
              }));
              break;
            }

            await wait(pollIntervalMs, lifecycle.signal);
          }

          if (lifecycle.aborted()) {
            throw abortError(lifecycle.signal);
          }
        }

        args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, {
          type: "done",
          finishReason: finalOutput.finishReason || "stop",
          usage: finalOutput.usage,
        })));
        args.res.write(formatCoreSSEDone());
        args.res.end();

        await saveResponseRecord({
          ...baseRecord,
          status: finalOutput.media?.status === "failed"
            ? "failed"
            : finalOutput.media?.jobId && finalOutput.media.status && finalOutput.media.status !== "completed"
              ? "in_progress"
              : "completed",
          output: finalOutput,
          ...(finalOutput.media?.jobId ? { jobId: finalOutput.media.jobId } : {}),
          ...(finalOutput.media?.status === "failed" ? { error: finalOutput.media.status } : {}),
        });
      } catch (error) {
        try {
          await abortPaidInference(error instanceof Error ? error.message : "stream_failed");
        } catch { /* best-effort */ }
        try {
          args.res.write(toErrorStreamEvent({
            code: "upstream_error",
            message: error instanceof Error ? error.message : String(error),
          }));
          args.res.write(formatCoreSSEDone());
          args.res.end();
        } catch { /* best-effort */ }
        throw error;
      }

      return;
    }

    if (request.stream && usesProviderStream(request)) {
      args.res.setHeader("Content-Type", "text/event-stream");
      args.res.setHeader("Cache-Control", "no-cache");
      args.res.setHeader("Connection", "keep-alive");
      // X-Request-Id is set by the top-level middleware. We also keep the
      // inference-specific response id available under x-response-id
      // so clients can round-trip it for /v1/responses/:id retrieval.
      args.res.setHeader("x-response-id", request.responseId);

      const routed = await streamEngine(request, { signal: lifecycle.signal });

      applyRoutingHeaders(args.res, routed.route);
      paid.payment.applyHeaders(args.res);
      if (args.shape === "responses") {
        args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, { type: "created" })));
      }

      let isFirstToken = true;
      let aggregatedText = "";
      let lastUsage: TokenUsage | undefined;
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
      let pendingImageDoneEvent: Event | null = null;

      try {
        for await (const event of routed.result.stream) {
          if (event.type === "text-delta") {
            aggregatedText += event.text || "";
            const payload = args.shape === "chat"
              ? toChatStreamEvent(request.responseId, modelId, event, isFirstToken)
              : toResponsesStreamEvent(request.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            isFirstToken = false;
            continue;
          }

          if (event.type === "thinking" || event.type === "tool-call" || event.type === "tool-call-delta") {
            const payload = args.shape === "chat"
              ? toChatStreamEvent(request.responseId, modelId, event, isFirstToken)
              : toResponsesStreamEvent(request.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            isFirstToken = false;
            continue;
          }

          if (event.type === "image-partial") {
            const payload = toResponsesStreamEvent(request.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
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
            pendingImageCompleteEvent = event;
            continue;
          }

          if (event.type === "done") {
            if (event.usage) {
              lastUsage = event.usage;
            }
            finishReason = event.finishReason || "stop";
            if (streamedImage) {
              pendingImageDoneEvent = event;
              continue;
            }
            const payload = args.shape === "chat"
              ? toChatStreamEvent(request.responseId, modelId, event)
              : toResponsesStreamEvent(request.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            if (args.shape === "chat" && event.usage) {
              args.res.write(formatCoreSSE(toChatUsageStreamEvent(request.responseId, modelId, event.usage)));
            }
          }
        }

        if (!lastUsage) {
          await abortPaidInference("missing_stream_usage");
          args.res.end();
          return;
        }

        const finalOutput: Output = {
          modality: streamedImage ? "image" : "text",
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
            : { content: aggregatedText }),
          usage: lastUsage,
          finishReason,
        };

        const streamReceipt = await settleOutput(finalOutput);

        if (pendingImageCompleteEvent) {
          args.res.write(formatCoreSSE(toResponsesStreamEvent(request.responseId, modelId, pendingImageCompleteEvent)));
          args.res.write(formatCoreSSE(toResponsesStreamEvent(
            request.responseId,
            modelId,
            pendingImageDoneEvent ?? {
              type: "done",
              usage: lastUsage,
              finishReason,
            },
          )));
        }

        if (streamReceipt) {
          args.res.write(toReceiptStreamEvent(receiptStreamPayload(streamReceipt)));
        }
        args.res.write(formatCoreSSEDone());
        args.res.end();

        await saveResponseRecord({
          ...baseRecord,
          status: "completed",
          output: finalOutput,
        });
      } catch (error) {
        try {
          await abortPaidInference(error instanceof Error ? error.message : "stream_failed");
        } catch { /* best-effort */ }
        if (!args.res.headersSent) {
          // Let the outer Express error handler send the JSON error response.
        } else {
          // Emit structured error frame before propagating so clients know why
          // the stream closed without a final `done` event.
          try {
            args.res.write(toErrorStreamEvent({
              code: "upstream_error",
              message: error instanceof Error ? error.message : String(error),
            }));
          } catch { /* best-effort */ }
          try { args.res.write(formatCoreSSEDone()); } catch { /* best-effort */ }
          try { args.res.end(); } catch { /* best-effort */ }
        }
        throw error;
      }

      return;
    }

    const direct = withDirectDeadline(lifecycle.signal);
    let routed: Awaited<ReturnType<typeof generateEngine>>;
    try {
      routed = await generateEngine(request, { signal: direct.signal });
    } finally {
      direct.cleanup();
    }

    applyRoutingHeaders(args.res, routed.route);

    const output = routed.result.output;
    const jsonReceipt = await settleOutput(output);
    applyReceiptHeader(args.res, jsonReceipt);

    const record: StoredResponseRecord = {
      ...baseRecord,
      status: output.media?.jobId && output.media.status && output.media.status !== "completed" ? "in_progress" : "completed",
      output,
      ...(output.media?.jobId ? { jobId: output.media.jobId } : {}),
    };
    await saveResponseRecord(record);

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
  if (rejectRealtimeRequest(args.request, args.res)) {
    return;
  }

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
    const direct = withDirectDeadline(lifecycle.signal);
    let result: Output;
    try {
      result = await args.execute(direct.signal);
    } finally {
      direct.cleanup();
    }
    const receipt = await settlePaidInference({
      req: args.req,
      res: args.res,
      payment: paid.payment,
      request: args.request,
      output: result,
      resolved: paid.resolved,
    });
    paymentTerminal = true;
    applyReceiptHeader(args.res, receipt);
    await args.onSuccess(result, receipt);
    lifecycle.done();
  } catch (error) {
    await abortPaidInference(error instanceof Error ? error.message : "inference_failed");
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
    res.status(200).json({ object: "list", data: models.models.map(withModelOperations) });
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
 * `compose.video.status` event. Not billable — the inference charge happens
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
