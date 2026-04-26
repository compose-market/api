import type { Express, NextFunction, Request, Response } from "express";
import type { PaymentRequired } from "@x402/core/types";

import {
  getCompiledModels,
  getExtendedModels,
  getModelById,
  resolveModel,
  searchModels,
  type ModelSearchInput,
} from "./models-registry.js";
import type { ModelCard, ModelProvider } from "./types.js";
import {
  buildResolvedAuthorizationInput,
  buildSettlementMeterFromOutput,
} from "../x402/metering.js";
import {
  prepareInferencePayment,
  settlePreparedInferencePayment,
  type InferenceAuthorizationInput,
  type InferenceSettlementReceipt,
} from "../x402/index.js";
import {
  encodeReceiptHeader,
  RECEIPT_HEADER,
  type ComposeReceipt,
} from "../http/request-context.js";
import {
  type MeteredSettlementInput,
} from "../x402/metering.js";
import {
  createErrorResponse as createCoreErrorResponse,
  formatSSE as formatCoreSSE,
  formatSSEDone as formatCoreSSEDone,
  normalizeChatRequest,
  normalizeEmbeddingsRequest,
  normalizeResponsesRequest,
  toChatCompletionsResponse,
  toChatStreamEvent,
  toChatUsageStreamEvent,
  toEmbeddingsResponse,
  toResponsesResponse,
  toResponsesStreamEvent,
  toComposeReceiptStreamEvent,
  toComposeErrorStreamEvent,
  toComposeVideoStatusStreamEvent,
  type UnifiedMessage,
  type UnifiedOutput,
  type UnifiedRequest,
  type UnifiedStreamEvent,
} from "./core.js";
import { runWithPolicy } from "./policy.js";
import { redisGet, redisSet } from "../x402/keys/redis.js";

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
  n?: number;
  size?: string;
  quality?: string;
  image_url?: string;
  image?: string;
}

export interface AudioSpeechRequest {
  model?: string;
  input: string;
  voice?: string;
  speed?: number;
  response_format?: string;
}

export interface AudioTranscriptionRequest {
  model?: string;
  file: string;
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
  inputMessages?: UnifiedMessage[];
  previousResponseId?: string;
  output?: UnifiedOutput;
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
export function setCorsHeaders(_res: Response): void {
  // Intentional no-op. See api/http/cors.ts for the canonical policy.
}

// =============================================================================
// Route Topology
// =============================================================================

type RouteMethod = "GET" | "POST";

export interface InferenceRoute {
  method: RouteMethod;
  path: string;
  handler: (req: Request, res: Response) => Promise<void>;
  description?: string;
}

export const INFERENCE_ROUTES: InferenceRoute[] = [
  { method: "GET", path: "/v1/models", handler: (req, res) => handleListModels(req, res, false), description: "List models" },
  { method: "GET", path: "/v1/models/all", handler: (req, res) => handleListModels(req, res, true), description: "List all models" },
  { method: "POST", path: "/v1/models/search", handler: handleSearchModels, description: "Search models" },
  { method: "GET", path: "/v1/models/:model/params", handler: handleModelParams, description: "Model optional params" },
  { method: "GET", path: "/v1/models/:model", handler: handleGetModel, description: "Get model" },
  { method: "POST", path: "/v1/responses", handler: handleResponses, description: "Canonical unified responses API" },
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
    app[method](route.path, (req: Request, res: Response, next: NextFunction) => {
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
              })),
            }
            : {}),
        },
        finish_reason: result.finishReason || (result.toolCalls?.length ? "tool_calls" : "stop"),
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
        finish_reason: isLast ? finishReason || "stop" : null,
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
    if (message.includes("429") || message.includes("rate limit")) {
      return {
        status: 429,
        body: createErrorResponse(error.message, "rate_limit_error", "rate_limit_exceeded"),
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

function writeAdaptedError(res: Response, error: unknown, defaultStatus = 500): void {
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

function requireModel(modelId: string): { provider: ModelProvider; card: ModelCard } {
  const card = getModelById(modelId);
  if (!card) {
    throw new Error(`Model not found: ${modelId}`);
  }
  return { provider: card.provider, card };
}

function loadAdapterRuntime() {
  return import("./providers/adapter.js");
}

async function invokeDirectAdapter(unified: UnifiedRequest): Promise<UnifiedOutput> {
  const { invokeAdapter } = await loadAdapterRuntime();
  const resolved = resolveModel(unified.model, unified.provider);
  return (
    await invokeAdapter(unified, {
      modelId: unified.model,
      provider: resolved.provider,
    })
  ).output;
}

async function retrieveDirectAdapter(jobId: string) {
  const { retrieveAdapter } = await loadAdapterRuntime();
  return retrieveAdapter(jobId);
}

function getRequiredOutputMedia(output: UnifiedOutput): NonNullable<UnifiedOutput["media"]> {
  if (!output.media) {
    throw new Error(`Adapter returned no media for ${output.modality}`);
  }

  return output.media;
}

async function readOutputMediaBuffer(output: UnifiedOutput): Promise<Buffer> {
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
  res: Response,
  routing: { attempts: number; fallbackUsed: boolean; primary: { modelId: string }; final: { modelId: string } },
): void {
  res.setHeader("x-routing-primary-model", routing.primary.modelId);
  res.setHeader("x-routing-final-model", routing.final.modelId);
  res.setHeader("x-routing-attempts", String(routing.attempts));
  res.setHeader("x-routing-fallback-used", routing.fallbackUsed ? "true" : "false");
}

function receiptFromSettlement(
  settlement: InferenceSettlementReceipt | null,
  chainId?: number,
): ComposeReceipt | null {
  if (!settlement) {
    return null;
  }

  const resolvedChainId = settlement.chainId ?? chainId;
  if (typeof resolvedChainId !== "number" || !Number.isFinite(resolvedChainId)) {
    return null;
  }

  const receipt: ComposeReceipt = {
    finalAmountWei: settlement.finalAmountWei,
    network: `eip155:${resolvedChainId}` as `eip155:${number}`,
    settledAt: settlement.settledAt,
  };

  if (settlement.meterSubject) receipt.subject = settlement.meterSubject;
  if (settlement.lineItems && settlement.lineItems.length > 0) receipt.lineItems = settlement.lineItems;
  if (settlement.providerAmountWei) receipt.providerAmountWei = settlement.providerAmountWei;
  if (settlement.platformFeeWei) receipt.platformFeeWei = settlement.platformFeeWei;
  if (settlement.txHash) receipt.txHash = settlement.txHash;

  return receipt;
}

function applyReceiptHeader(res: Response, receipt: ComposeReceipt | null): void {
  if (!receipt || res.headersSent) return;
  res.setHeader(RECEIPT_HEADER, encodeReceiptHeader(receipt));
}

function receiptForJsonBody(receipt: ComposeReceipt | null): Record<string, unknown> | undefined {
  if (!receipt) return undefined;
  return {
    subject: receipt.subject,
    line_items: receipt.lineItems?.map((item) => ({
      key: item.key,
      unit: item.unit,
      quantity: item.quantity,
      unit_price_usd: item.unitPriceUsd,
      amount_wei: item.amountWei,
    })),
    provider_amount_wei: receipt.providerAmountWei,
    platform_fee_wei: receipt.platformFeeWei,
    final_amount_wei: receipt.finalAmountWei,
    tx_hash: receipt.txHash,
    network: receipt.network,
    settled_at: receipt.settledAt,
  };
}

function getChainIdFromInferenceRequest(req: Request): number | undefined {
  const header = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function outputToAssistantMessage(output: UnifiedOutput): UnifiedMessage | null {
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
        })),
      }
      : {}),
  };
}

async function buildResponsesHistory(responseId: string, visited = new Set<string>()): Promise<UnifiedMessage[]> {
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

async function hydrateResponsesRequest(unified: UnifiedRequest): Promise<UnifiedRequest> {
  const priorMessages = unified.previousResponseId
    ? await buildResponsesHistory(unified.previousResponseId)
    : [];
  const currentMessages = unified.instructions
    ? [{ role: "system", content: unified.instructions } satisfies UnifiedMessage, ...priorMessages, ...unified.messages]
    : [...priorMessages, ...unified.messages];

  return {
    ...unified,
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

async function executeUnifiedRequest(args: {
  req: Request;
  res: Response;
  unified: UnifiedRequest;
  shape: ResponseShape;
}): Promise<void> {
  const unified = args.shape === "responses"
    ? await hydrateResponsesRequest(args.unified)
    : args.unified;
  const modelId = unified.model;
  if (!modelId) {
    args.res.status(400).json(createCoreErrorResponse("model is required", "invalid_request_error", "missing_model"));
    return;
  }

  const resolved = resolveModel(modelId, unified.provider);
  const authorizationInput = buildResolvedAuthorizationInput({
    request: unified,
    resolved,
  }) as InferenceAuthorizationInput;
  const payment = await prepareInferencePayment(args.req, args.res, authorizationInput);
  if (!payment) {
    return;
  }

  const baseRecord: StoredResponseRecord = {
    id: unified.responseId,
    model: modelId,
    provider: resolved.provider,
    createdAt: Math.floor(Date.now() / 1000),
    status: "in_progress",
    inputMessages: args.shape === "responses" ? args.unified.messages : undefined,
    previousResponseId: args.shape === "responses" ? args.unified.previousResponseId : undefined,
  };
  await saveResponseRecord(baseRecord);

  try {
    if (args.unified.stream && (args.unified.modality === "text" || args.unified.modality === "image")) {
      args.res.setHeader("Content-Type", "text/event-stream");
      args.res.setHeader("Cache-Control", "no-cache");
      args.res.setHeader("Connection", "keep-alive");
      // X-Request-Id is set by the top-level middleware. We also keep the
      // inference-specific response id available under x-compose-response-id
      // so clients can round-trip it for /v1/responses/:id retrieval.
      args.res.setHeader("x-compose-response-id", unified.responseId);

      const routed = await runWithPolicy({
        context: {
          modelId,
          provider: resolved.provider,
          card: resolved.card,
        },
        execute: async (target) => {
          const { streamAdapter } = await loadAdapterRuntime();
          return {
            target,
            stream: streamAdapter(unified, {
              modelId: target.modelId,
              provider: target.provider,
            }),
          };
        },
      });

      applyRoutingHeaders(args.res, routed);
      payment.applyHeaders(args.res);

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
      let pendingImageCompleteEvent: UnifiedStreamEvent | null = null;
      let pendingImageDoneEvent: UnifiedStreamEvent | null = null;

      try {
        for await (const event of routed.result.stream) {
          if (event.type === "text-delta") {
            aggregatedText += event.text || "";
            const payload = args.shape === "chat"
              ? toChatStreamEvent(unified.responseId, modelId, event, isFirstToken)
              : toResponsesStreamEvent(unified.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            isFirstToken = false;
            continue;
          }

          if (event.type === "tool-call") {
            const payload = args.shape === "chat"
              ? toChatStreamEvent(unified.responseId, modelId, event)
              : toResponsesStreamEvent(unified.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            continue;
          }

          if (event.type === "image-partial") {
            const payload = toResponsesStreamEvent(unified.responseId, modelId, event);
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
              ? toChatStreamEvent(unified.responseId, modelId, event)
              : toResponsesStreamEvent(unified.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            if (args.shape === "chat" && event.usage) {
              args.res.write(formatCoreSSE(toChatUsageStreamEvent(unified.responseId, modelId, event.usage)));
            }
          }
        }

        if (!lastUsage) {
          await payment.abort("missing_stream_usage");
          args.res.end();
          return;
        }

        const finalOutput: UnifiedOutput = {
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

        const settlementReceipt = await settlePreparedInferencePayment(
          payment,
          args.res,
          {
            meter: buildSettlementMeterFromOutput({
              request: unified,
              output: finalOutput,
              resolved,
            }).meter as MeteredSettlementInput,
          },
        );

        if (pendingImageCompleteEvent) {
          args.res.write(formatCoreSSE(toResponsesStreamEvent(unified.responseId, modelId, pendingImageCompleteEvent)));
          args.res.write(formatCoreSSE(toResponsesStreamEvent(
            unified.responseId,
            modelId,
            pendingImageDoneEvent ?? {
              type: "done",
              usage: lastUsage,
              finishReason,
            },
          )));
        }

        const streamChainId = getChainIdFromInferenceRequest(args.req);
        const streamReceipt = receiptFromSettlement(settlementReceipt, streamChainId);
        if (streamReceipt) {
          args.res.write(toComposeReceiptStreamEvent({
            finalAmountWei: streamReceipt.finalAmountWei,
            providerAmountWei: streamReceipt.providerAmountWei,
            platformFeeWei: streamReceipt.platformFeeWei,
            meterSubject: streamReceipt.subject,
            lineItems: streamReceipt.lineItems,
            txHash: streamReceipt.txHash,
            network: streamReceipt.network,
            settledAt: streamReceipt.settledAt,
          }));
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
          await payment.abort(error instanceof Error ? error.message : "stream_failed");
        } catch { /* best-effort */ }
        if (!args.res.headersSent) {
          // Let the outer Express error handler send the JSON error response.
        } else {
          // Emit structured error frame before propagating so clients know why
          // the stream closed without a final `done` event.
          try {
            args.res.write(toComposeErrorStreamEvent({
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

    const routed = await runWithPolicy({
      context: {
        modelId,
        provider: resolved.provider,
        card: resolved.card,
      },
      execute: async (target) =>
        (await loadAdapterRuntime()).invokeAdapter(unified, {
          modelId: target.modelId,
          provider: target.provider,
        }),
    });

    applyRoutingHeaders(args.res, routed);

    const output = routed.result.output;
    const jsonSettlementReceipt = await settlePreparedInferencePayment(
      payment,
      args.res,
      {
        meter: buildSettlementMeterFromOutput({
          request: unified,
          output,
          resolved,
        }).meter as MeteredSettlementInput,
      },
    );
    const jsonChainId = getChainIdFromInferenceRequest(args.req);
    const jsonReceipt = receiptFromSettlement(jsonSettlementReceipt, jsonChainId);
    applyReceiptHeader(args.res, jsonReceipt);

    const record: StoredResponseRecord = {
      ...baseRecord,
      status: output.media?.jobId && output.media.status && output.media.status !== "completed" ? "in_progress" : "completed",
      output,
      ...(output.media?.jobId ? { jobId: output.media.jobId } : {}),
    };
    await saveResponseRecord(record);

    const receiptJson = receiptForJsonBody(jsonReceipt);

    if (args.shape === "chat") {
      const body = toChatCompletionsResponse(modelId, unified.responseId, output) as unknown as Record<string, unknown>;
      if (receiptJson) body.compose_receipt = receiptJson;
      args.res.status(200).json(body);
      return;
    }

    if (args.shape === "embeddings") {
      const body = toEmbeddingsResponse(modelId, output) as unknown as Record<string, unknown>;
      if (receiptJson) body.compose_receipt = receiptJson;
      args.res.status(200).json(body);
      return;
    }

    const payload = toResponsesResponse(modelId, unified.responseId, output) as unknown as Record<string, unknown>;
    if (record.status !== "completed") {
      payload.status = record.status;
    }
    if (record.jobId) {
      payload.job_id = record.jobId;
    }
    if (receiptJson) {
      payload.compose_receipt = receiptJson;
    }
    args.res.status(200).json(payload);
  } catch (error) {
    await payment.abort(error instanceof Error ? error.message : "unified_inference_failed");
    await saveResponseRecord({
      ...baseRecord,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleResponses(req: Request, res: Response): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const unified = normalizeResponsesRequest(body);

    if (!unified.model) {
      res.status(400).json(createCoreErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    if (unified.modality === "embedding" && !unified.embeddingInput) {
      res.status(400).json(createCoreErrorResponse("input is required for embeddings", "invalid_request_error", "missing_input"));
      return;
    }

    if (unified.modality !== "embedding" && unified.messages.length === 0 && !unified.previousResponseId) {
      res.status(400).json(createCoreErrorResponse("input is required", "invalid_request_error", "missing_input"));
      return;
    }

    await executeUnifiedRequest({ req, res, unified, shape: "responses" });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleGetResponse(req: Request, res: Response): Promise<void> {
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
      const { retrieveAdapter } = await loadAdapterRuntime();
      const status = await retrieveAdapter(record.jobId);
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

async function handleGetResponseInputItems(req: Request, res: Response): Promise<void> {
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

async function handleCancelResponse(req: Request, res: Response): Promise<void> {
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
      const { cancelAdapter } = await loadAdapterRuntime();
      await cancelAdapter(record.jobId);
    }

    record.status = "cancelled";
    await saveResponseRecord(record);
    res.status(200).json(responseFromRecord(record));
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function runDeferredInference(args: {
  req: Request;
  res: Response;
  unified: UnifiedRequest;
  provider: ModelProvider;
  card: ModelCard | null;
  execute: () => Promise<UnifiedOutput>;
  onSuccess: (result: UnifiedOutput) => void | Promise<void>;
}): Promise<void> {
  const authorizationInput = buildResolvedAuthorizationInput({
    request: args.unified,
    resolved: {
      modelId: args.unified.model,
      provider: args.provider,
      known: true,
      card: args.card,
    },
  }) as InferenceAuthorizationInput;
  const payment = await prepareInferencePayment(args.req, args.res, authorizationInput);
  if (!payment) {
    return;
  }

  try {
    const result = await args.execute();
    await settlePreparedInferencePayment(payment, args.res, {
      meter: buildSettlementMeterFromOutput({
        request: args.unified,
        output: result,
        resolved: {
          modelId: args.unified.model,
          provider: args.provider,
          known: true,
          card: args.card,
        },
      }).meter as MeteredSettlementInput,
    });
    await args.onSuccess(result);
  } catch (error) {
    await payment.abort(error instanceof Error ? error.message : "inference_failed");
    throw error;
  }
}

// =============================================================================
// Endpoint Handlers
// =============================================================================

export async function handleListModels(req: Request, res: Response, extended = false): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const models = extended ? getExtendedModels() : getCompiledModels();
    res.status(200).json({ object: "list", data: models.models });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleSearchModels(req: Request, res: Response): Promise<void> {
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

    const modality = pickString("modality");
    const validModalities = ["text", "image", "audio", "video", "embedding"] as const;
    if (modality && !validModalities.includes(modality as typeof validModalities[number])) {
      res.status(400).json(createErrorResponse("modality must be text, image, audio, video, or embedding", "invalid_request_error", "invalid_modality"));
      return;
    }

    const result = searchModels({
      q: pickString("q"),
      modality: modality as ModelSearchInput["modality"],
      provider: pickString("provider") as ModelProvider | undefined,
      priceMaxPerMTok: pickNumber("priceMaxPerMTok") ?? pickNumber("price_max_per_mtok"),
      contextWindowMin: pickNumber("contextWindowMin") ?? pickNumber("context_window_min"),
      streaming: pickBoolean("streaming"),
      cursor: pickString("cursor"),
      limit: pickNumber("limit"),
    });

    res.status(200).json({
      object: "list",
      data: result.data,
      total: result.total,
      next_cursor: result.next_cursor,
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

async function handleModelParams(req: Request, res: Response): Promise<void> {
  const { handleGetModelParams } = await import("./params-handler.js");
  await handleGetModelParams(req, res);
}

export async function handleGetModel(req: Request, res: Response): Promise<void> {
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

    res.status(200).json(model);
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const unified = normalizeChatRequest(body);

    if (!unified.model) {
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
      unified.messages = applyLegacyAttachments(unified.messages as any, source) as any;
    }

    await executeUnifiedRequest({
      req,
      res,
      unified,
      shape: "chat",
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleImageGeneration(req: Request, res: Response): Promise<void> {
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
    const unified = normalizeResponsesRequest({
      model,
      input: [{ type: "input_text", text: body.prompt }],
      modalities: ["image"],
      n: body.n,
      size: body.size,
      quality: body.quality,
      image_url: body.image_url || body.image,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      unified,
      provider: resolved.provider,
      card: resolved.card,
      execute: () => invokeDirectAdapter(unified),
      onSuccess: (output) => {
        const media = getRequiredOutputMedia(output);
        res.status(200).json(
          adaptImageResponse({
            images: [
              media.base64
                ? { b64_json: media.base64 }
                : { url: media.url },
            ],
          }),
        );
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleImageEdit(req: Request, res: Response): Promise<void> {
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
    const unified = normalizeResponsesRequest({
      model,
      input: [{ type: "input_text", text: body.prompt }],
      modalities: ["image"],
      n: body.n,
      size: body.size,
      image_url: body.image,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      unified,
      provider: resolved.provider,
      card: resolved.card,
      execute: () => invokeDirectAdapter(unified),
      onSuccess: (output) => {
        const media = getRequiredOutputMedia(output);
        res.status(200).json(
          adaptImageResponse({
            images: [
              media.base64
                ? { b64_json: media.base64 }
                : { url: media.url },
            ],
          }),
        );
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleAudioSpeech(req: Request, res: Response): Promise<void> {
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
    const unified = normalizeResponsesRequest({
      model,
      input: [{ type: "input_text", text: body.input }],
      modalities: ["audio"],
      voice: body.voice,
      speed: body.speed,
      response_format: format,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      unified,
      provider: resolved.provider,
      card: resolved.card,
      execute: () => invokeDirectAdapter(unified),
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

export async function handleAudioTranscription(req: Request, res: Response): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = req.body as AudioTranscriptionRequest;
    if (!body.file) {
      res.status(400).json(createErrorResponse("file is required", "invalid_request_error", "missing_file"));
      return;
    }

    if (!body.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    const model = body.model;
    const unified = normalizeResponsesRequest({
      model,
      input: [{ type: "input_audio", audio_url: `data:application/octet-stream;base64,${body.file}` }],
      modalities: ["audio"],
      language: body.language,
      response_format: body.response_format,
    });

    const resolved = resolveModel(model);
    await runDeferredInference({
      req,
      res,
      unified,
      provider: resolved.provider,
      card: resolved.card,
      execute: () => invokeDirectAdapter(unified),
      onSuccess: (output) => {
        const response = adaptTranscriptionResponse({ text: output.content || "" });
        if (body.response_format === "text") {
          res.setHeader("Content-Type", "text/plain");
          res.send(response.text);
          return;
        }
        res.status(200).json(response);
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleEmbeddings(req: Request, res: Response): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const unified = normalizeEmbeddingsRequest(body);
    if (!unified.embeddingInput) {
      res.status(400).json(createErrorResponse("input is required", "invalid_request_error", "missing_input"));
      return;
    }
    if (!unified.model) {
      res.status(400).json(createErrorResponse("model is required", "invalid_request_error", "missing_model"));
      return;
    }

    await executeUnifiedRequest({
      req,
      res,
      unified,
      shape: "embeddings",
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleVideoGeneration(req: Request, res: Response): Promise<void> {
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

    const unified = normalizeResponsesRequest({
      model: body.model,
      input: [{ type: "input_text", text: body.prompt }],
      modalities: ["video"],
      duration: body.duration,
      aspect_ratio: body.aspect_ratio,
      size: body.size,
      image_url: body.image_url || body.image,
    });

    const resolved = resolveModel(body.model);
    await runDeferredInference({
      req,
      res,
      unified,
      provider: resolved.provider,
      card: resolved.card,
      execute: () => invokeDirectAdapter(unified),
      onSuccess: (output) => {
        const media = getRequiredOutputMedia(output);
        if (media.jobId && media.status && media.status !== "completed") {
          res.status(202).json({
            id: media.jobId,
            object: "video.generation",
            status: media.status,
            created: Math.floor(Date.now() / 1000),
            model: body.model,
          });
          return;
        }

        res.status(200).json(
          adaptVideoResponse(
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
          ),
        );
      },
    });
  } catch (error) {
    writeAdaptedError(res, error, 500);
  }
}

export async function handleVideoStatus(req: Request, res: Response): Promise<void> {
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
 *   - timeoutMs       (default 600000, min 5000, max 3600000)
 */
export async function handleVideoStatusStream(req: Request, res: Response): Promise<void> {
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
    parseInt(String(req.query.timeoutMs ?? ""), 10) || 600_000,
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
        res.write(toComposeErrorStreamEvent({
          code: "upstream_error",
          message: pollError instanceof Error ? pollError.message : String(pollError),
        }));
        res.write(formatCoreSSEDone());
        res.end();
        return;
      }

      res.write(toComposeVideoStatusStreamEvent({
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
        res.write(toComposeErrorStreamEvent({
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
      res.write(toComposeErrorStreamEvent({
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      }));
      res.write(formatCoreSSEDone());
      res.end();
    } catch { /* best-effort */ }
  }
}
