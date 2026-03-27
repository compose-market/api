import type { Express, NextFunction, Request, Response } from "express";

import {
  getCompiledModels,
  getExtendedModels,
  getModelById,
  resolveModel,
} from "./models-registry.js";
import type { ModelCard, ModelProvider } from "./types.js";
import {
  buildResolvedAuthorizationInput,
  buildSettlementMeterFromOutput,
} from "../x402/metering.js";
import {
  authorizePaymentIntent,
  abortPaymentIntent,
  settlePaymentIntent,
} from "../x402/intents.js";
import type {
  MeteredAuthorizationInput,
  MeteredSettlementInput,
  ResolvedAuthorizationInput,
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
  type UnifiedMessage,
  type UnifiedOutput,
  type UnifiedRequest,
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

export function setCorsHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Chain-Id, x-chain-id, X-Payment-Data, PAYMENT-SIGNATURE, payment-signature",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Transaction-Hash, PAYMENT-RESPONSE, payment-response, X-Request-Id, X-Compose-Key-Budget-Remaining, x-compose-key-tx-hash, *",
  );
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

function adaptError(
  error: unknown,
  defaultStatus = 500,
): { status: number; body: ReturnType<typeof createErrorResponse> } {
  const asRecord = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const statusCode =
    (typeof asRecord?.statusCode === "number" ? asRecord.statusCode : undefined)
    ?? (typeof asRecord?.status === "number" ? asRecord.status : undefined)
    ?? (asRecord?.cause && typeof asRecord.cause === "object"
      ? (
        typeof (asRecord.cause as Record<string, unknown>).statusCode === "number"
          ? (asRecord.cause as Record<string, unknown>).statusCode as number
          : typeof (asRecord.cause as Record<string, unknown>).status === "number"
            ? (asRecord.cause as Record<string, unknown>).status as number
            : undefined
      )
      : undefined);

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
  }) as ResolvedAuthorizationInput;
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
    if (args.unified.stream && args.unified.modality === "text") {
      args.res.setHeader("Content-Type", "text/event-stream");
      args.res.setHeader("Cache-Control", "no-cache");
      args.res.setHeader("Connection", "keep-alive");
      args.res.setHeader("X-Request-Id", unified.responseId);

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
      for (const [key, value] of Object.entries(payment.getHeaders())) {
        args.res.setHeader(key, value);
      }

      let isFirstToken = true;
      let aggregatedText = "";
      let lastUsage: TokenUsage | undefined;
      let finishReason = "stop";

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

          if (event.type === "done") {
            if (event.usage) {
              lastUsage = event.usage;
            }
            finishReason = event.finishReason || "stop";
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
          modality: "text",
          content: aggregatedText,
          usage: lastUsage,
          finishReason,
        };

        await settlePreparedPayment(
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
        args.res.write(formatCoreSSEDone());
        args.res.end();

        await saveResponseRecord({
          ...baseRecord,
          status: "completed",
          output: finalOutput,
        });
      } catch (error) {
        if (!args.res.headersSent) {
          await payment.abort(error instanceof Error ? error.message : "stream_failed");
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
    await settlePreparedPayment(
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

    const record: StoredResponseRecord = {
      ...baseRecord,
      status: output.media?.jobId && output.media.status && output.media.status !== "completed" ? "in_progress" : "completed",
      output,
      ...(output.media?.jobId ? { jobId: output.media.jobId } : {}),
    };
    await saveResponseRecord(record);

    if (args.shape === "chat") {
      args.res.status(200).json(toChatCompletionsResponse(modelId, unified.responseId, output));
      return;
    }

    if (args.shape === "embeddings") {
      args.res.status(200).json(toEmbeddingsResponse(modelId, output));
      return;
    }

    const payload = toResponsesResponse(modelId, unified.responseId, output) as unknown as Record<string, unknown>;
    if (record.status !== "completed") {
      payload.status = record.status;
    }
    if (record.jobId) {
      payload.job_id = record.jobId;
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
  }
}

// =============================================================================
// Payment Helpers
// =============================================================================

function getChainIdFromReq(req: Request): number | undefined {
  const chainIdHeader = req.get?.("x-chain-id") || req.headers["x-chain-id"];
  if (!chainIdHeader) {
    return undefined;
  }

  const parsed = parseInt(String(chainIdHeader), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface PreparedInferencePayment {
  paymentIntentId: string;
  maxAmountWei: string;
  settle: (
    settlement:
      | { finalAmountWei: string }
      | { meter: MeteredSettlementInput },
  ) => Promise<{ success: boolean; txHash?: string; error?: string }>;
  abort: (reason?: string) => Promise<void>;
  getHeaders: () => Record<string, string>;
}

function isInternalInferenceRequest(authorization: string): boolean {
  if (!authorization) {
    return false;
  }

  const internalToken = process.env.RUNTIME_INTERNAL_SECRET;
  if (!internalToken) {
    return false;
  }

  return authorization === `Bearer ${internalToken}`;
}

async function prepareInferencePayment(
  req: Request,
  res: Response,
  authorizationInput:
    | { useBudgetCap: true }
    | { maxAmountWei: string }
    | { meter: MeteredAuthorizationInput },
): Promise<PreparedInferencePayment | null> {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (isInternalInferenceRequest(authorization)) {
    return {
      paymentIntentId: "",
      maxAmountWei: "0",
      settle: async () => ({ success: true }),
      abort: async () => undefined,
      getHeaders: () => ({}),
    };
  }

  const chainId = getChainIdFromReq(req);
  if (!authorization) {
    res.status(401).json({ error: "Compose key authorization is required" });
    return null;
  }

  const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
  const prepared = await authorizePaymentIntent({
    authorization,
    chainId: chainId ?? Number.NaN,
    service: "api",
    action: "inference",
    resource: resourceUrl,
    method: req.method || "POST",
    ...authorizationInput,
    composeRunId: typeof req.headers["x-compose-run-id"] === "string" ? req.headers["x-compose-run-id"] : undefined,
    idempotencyKey: typeof req.headers["x-idempotency-key"] === "string" ? req.headers["x-idempotency-key"] : undefined,
  });

  if (!prepared.ok) {
    for (const [key, value] of Object.entries(prepared.headers)) {
      res.setHeader(key, value);
    }
    res.status(prepared.status).json(prepared.body);
    return null;
  }

  let currentHeaders = { ...prepared.headers };

  return {
    paymentIntentId: prepared.body.paymentIntentId,
    maxAmountWei: prepared.body.maxAmountWei,
    settle: async (settlementInput) => {
      const settled = await settlePaymentIntent({
        paymentIntentId: prepared.body.paymentIntentId,
        ...settlementInput,
      });

      if (!settled.ok) {
        return {
          success: false,
          error: typeof settled.body.error === "string" ? settled.body.error : "Payment settlement failed",
        };
      }

      currentHeaders = { ...settled.headers };
      return {
        success: true,
        txHash: settled.body.txHash,
      };
    },
    abort: async (reason?: string) => {
      await abortPaymentIntent({
        paymentIntentId: prepared.body.paymentIntentId,
        reason: reason || "inference_failed",
      });
    },
    getHeaders: () => currentHeaders,
  };
}

async function settlePreparedPayment(
  payment: PreparedInferencePayment,
  res: Response,
  settlementInput: { finalAmountWei: string } | { meter: MeteredSettlementInput } = {
    finalAmountWei: payment.maxAmountWei,
  },
): Promise<void> {
  const settlement = await payment.settle(settlementInput);
  if (!settlement.success) {
    throw new Error(settlement.error || "Payment settlement failed");
  }

  if (!res.headersSent) {
    for (const [key, value] of Object.entries(payment.getHeaders())) {
      res.setHeader(key, value);
    }
  }

  if (settlement.txHash && !res.headersSent) {
    res.setHeader("X-Transaction-Hash", settlement.txHash);
    res.setHeader("x-compose-key-tx-hash", settlement.txHash);
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
  }) as ResolvedAuthorizationInput;
  const payment = await prepareInferencePayment(args.req, args.res, authorizationInput);
  if (!payment) {
    return;
  }

  try {
    const result = await args.execute();
    await settlePreparedPayment(payment, args.res, {
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
    const response: ModelsListResponse = {
      object: "list",
      data: models.models,
    };

    res.status(200).json(response);
  } catch (error) {
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body: payload } = adaptError(error, 500);
    res.status(status).json(payload);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
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
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
  }
}
