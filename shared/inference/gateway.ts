import type { Request, Response } from "express";
import { embedMany, generateText, jsonSchema, streamText } from "ai";
import { GoogleGenAI } from "@google/genai";

// Local types for Cloud Run compatibility (replacing aws-lambda types)
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

import {
  getCompiledModels,
  getExtendedModels,
  getLanguageModel,
  getModelById,
  resolveModel,
} from "../models/registry.js";
import type { ModelCard, ModelProvider } from "../models/types.js";
import {
  getPriceForRequest,
  handleX402Payment,
  INFERENCE_PRICE_WEI,
  prepareDeferredPayment,
  type PreparedPayment,
} from "../x402/index.js";
import {
  createErrorResponse as createCoreErrorResponse,
  formatSSE as formatCoreSSE,
  formatSSEDone as formatCoreSSEDone,
  normalizeChatRequest,
  normalizeEmbeddingsRequest,
  normalizeResponsesRequest,
  toChatCompletionsResponse,
  toChatStreamEvent,
  toEmbeddingsResponse,
  toResponsesResponse,
  toResponsesStreamEvent,
  type UnifiedOutput,
  type UnifiedRequest,
} from "./core.js";
import { runWithPolicy } from "./policy.js";
import { cancelAdapter, invokeAdapter, retrieveAdapter, streamAdapter, type AdapterStatus, type AdapterTarget } from "../models/providers/adapter.js";
import { redisGet, redisSet } from "../configs/redis.js";

import {
  generateImage as googleGenerateImage,
  generateSpeech as googleGenerateSpeech,
  generateVideo as googleGenerateVideo,
} from "../models/providers/genai.js";
import {
  openaiGenerateImage,
  openaiGenerateSpeech,
  openaiGenerateVideo,
  openaiTranscribeAudio,
} from "../models/providers/openai.js";
import {
  executeHFInference,
  type HFInferenceInput,
} from "../models/providers/huggingface.js";
import {
  generateVertexChat,
  generateVertexEmbeddings,
  generateVertexImage,
  generateVertexSpeech,
  generateVertexVideo,
  streamVertexChat,
  transcribeVertexAudio,
} from "../models/providers/vertex.js";

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
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    provider?: string;
    name?: string;
    description?: string;
    context_window?: number;
    max_output_tokens?: number;
    capabilities?: string[];
    pricing?: { input: number; output: number };
    task_type?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  }>;
}

interface StoredResponseRecord {
  id: string;
  model: string;
  provider: ModelProvider;
  createdAt: number;
  status: "in_progress" | "completed" | "failed" | "cancelled";
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
    "Content-Type, Authorization, X-Chain-Id, X-Payment-Data, PAYMENT-SIGNATURE, payment-signature, x-session-active, x-session-budget-remaining, x-session-user-address, x-manowar-internal",
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

function pathToMatcher(path: string): {
  regex: RegExp;
  keys: string[];
} {
  const keys: string[] = [];
  const pattern = path.replace(/:([^/]+)/g, (_m, key: string) => {
    keys.push(key);
    return `(?<${key}>[^/]+)`;
  });
  return { regex: new RegExp(`^${pattern}$`), keys };
}

function parsePathParams(pathPattern: string, actualPath: string): Record<string, string> | null {
  const { regex } = pathToMatcher(pathPattern);
  const match = actualPath.match(regex);
  if (!match) {
    return null;
  }
  return (match.groups || {}) as Record<string, string>;
}

export const INFERENCE_ROUTES: InferenceRoute[] = [
  { method: "GET", path: "/v1/models", handler: (req, res) => handleListModels(req, res, false), description: "List models" },
  { method: "GET", path: "/v1/models/all", handler: (req, res) => handleListModels(req, res, true), description: "List all models" },
  { method: "GET", path: "/v1/models/:model/params", handler: handleModelParams, description: "Model optional params" },
  { method: "GET", path: "/v1/models/:model", handler: handleGetModel, description: "Get model" },
  { method: "POST", path: "/v1/responses", handler: handleResponses, description: "Canonical unified responses API" },
  { method: "GET", path: "/v1/responses/:id", handler: handleGetResponse, description: "Retrieve response by ID" },
  { method: "POST", path: "/v1/responses/:id/cancel", handler: handleCancelResponse, description: "Cancel response by ID" },
  { method: "POST", path: "/v1/chat/completions", handler: handleChatCompletions, description: "Chat completions" },
  { method: "POST", path: "/v1/images/generations", handler: handleImageGeneration, description: "Image generation" },
  { method: "POST", path: "/v1/images/edits", handler: handleImageEdit, description: "Image edits" },
  { method: "POST", path: "/v1/audio/speech", handler: handleAudioSpeech, description: "Audio speech" },
  { method: "POST", path: "/v1/audio/transcriptions", handler: handleAudioTranscription, description: "Audio transcription" },
  { method: "POST", path: "/v1/embeddings", handler: handleEmbeddings, description: "Embeddings" },
  { method: "POST", path: "/v1/videos/generations", handler: handleVideoGeneration, description: "Video generation" },
  { method: "GET", path: "/v1/videos/:id", handler: handleVideoStatus, description: "Video status" },
];

export function matchInferenceRoute(
  method: string,
  path: string,
): { route: InferenceRoute; params: Record<string, string> } | null {
  const upper = method.toUpperCase();
  for (const route of INFERENCE_ROUTES) {
    if (route.method !== upper) {
      continue;
    }
    const params = parsePathParams(route.path, path);
    if (params) {
      return { route, params };
    }
  }
  return null;
}

interface MockRequest {
  method: string;
  path: string;
  originalUrl: string;
  query: Record<string, string | undefined>;
  params: Record<string, string>;
  body: any;
  headers: Record<string, string | undefined>;
  get: (header: string) => string | undefined;
  url: string;
}

interface MockResponse {
  status(code: number): MockResponse;
  json(data: unknown): MockResponse;
  send(data: Buffer | string): MockResponse;
  setHeader(key: string, value: string): MockResponse;
  write(chunk: Buffer | string): void;
  end(): void;
  on(event: string, cb: () => void): MockResponse;
  headersSent: boolean;
  getResult(): APIGatewayProxyResultV2;
}

function createMockReq(event: APIGatewayProxyEventV2): MockRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    headers[key.toLowerCase()] = value;
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.pathParameters || {})) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }

  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    originalUrl: event.rawPath,
    url: event.rawPath,
    query: event.queryStringParameters || {},
    params,
    body: event.body ? JSON.parse(event.body) : {},
    headers,
    get: (header: string) => headers[header.toLowerCase()],
  };
}

function createMockRes(): MockResponse {
  let statusCode = 200;
  let body: unknown = "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Chain-Id, X-Payment-Data, PAYMENT-SIGNATURE, payment-signature, x-session-active, x-session-budget-remaining, x-session-user-address, x-manowar-internal",
    "Access-Control-Expose-Headers":
      "X-Transaction-Hash, PAYMENT-RESPONSE, payment-response, X-Request-Id, X-Compose-Key-Budget-Remaining, x-compose-key-tx-hash, *",
  };
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
      headersSent = true;
      return this;
    },
    send(data: Buffer | string) {
      if (Buffer.isBuffer(data)) {
        body = data.toString("base64");
        isBinary = true;
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
    on() {
      return this;
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
          body: String(body || ""),
          isBase64Encoded: true,
        };
      }
      return {
        statusCode,
        headers,
        body: String(body || ""),
      };
    },
  };
}

export async function handleInferenceEvent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Chain-Id, X-Payment-Data, PAYMENT-SIGNATURE, payment-signature, x-session-active, x-session-budget-remaining, x-session-user-address, x-manowar-internal",
        "Access-Control-Expose-Headers":
          "X-Transaction-Hash, PAYMENT-RESPONSE, payment-response, X-Request-Id, X-Compose-Key-Budget-Remaining, x-compose-key-tx-hash, *",
      },
      body: "",
    };
  }

  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const match = matchInferenceRoute(method, path);

  if (!match) {
    return {
      statusCode: 404,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Not found",
        message: `Route ${method} ${path} not found`,
      }),
    };
  }

  const req = createMockReq(event);
  req.params = { ...req.params, ...match.params };
  const res = createMockRes();
  await match.route.handler(req as any, res as any);
  return res.getResult();
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

// =============================================================================
// Model Helpers
// =============================================================================

function modelCardToOpenAI(card: ModelCard) {
  return {
    id: card.modelId,
    object: "model" as const,
    created:
      typeof card.createdAt === "number"
        ? card.createdAt
        : card.createdAt
          ? Math.floor(new Date(card.createdAt).getTime() / 1000)
          : Math.floor(Date.now() / 1000),
    owned_by: card.ownedBy || card.provider,
    provider: card.provider,
    name: card.name,
    description: card.description,
    context_window: card.contextWindow,
    max_output_tokens: card.maxOutputTokens,
    capabilities: card.capabilities,
    pricing: card.pricing || undefined,
    task_type: card.taskType as string,
    input_modalities: card.inputModalities,
    output_modalities: card.outputModalities,
  };
}

function requireModel(modelId: string): { provider: ModelProvider; card: ModelCard } {
  const card = getModelById(modelId);
  if (!card) {
    throw new Error(`Model not found: ${modelId}`);
  }
  return { provider: card.provider, card };
}

async function withRetry<T>(operation: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < retries) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
}

// =============================================================================
// Content Normalization
// =============================================================================

function normalizeContentToString(content: unknown): string {
  if (content == null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textOnly = content
      .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part) => (part as { text?: unknown }).text)
      .filter((text): text is string => typeof text === "string");

    if (textOnly.length > 0) {
      return textOnly.join("\n");
    }

    return JSON.stringify(content);
  }

  return String(content);
}

function normalizeContentParts(contentArray: unknown[]): unknown[] {
  const normalized: unknown[] = [];

  for (const rawPart of contentArray) {
    if (!rawPart || typeof rawPart !== "object") {
      continue;
    }

    const part = rawPart as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text") {
      if (typeof part.text === "string") {
        normalized.push({ type: "text", text: part.text });
      }
      continue;
    }

    if (type === "image_url") {
      const value = part.image_url;
      const url = typeof value === "string" ? value : (value as { url?: string } | undefined)?.url;
      if (url) {
        normalized.push({ type: "image", image: url });
      }
      continue;
    }

    if (type === "input_audio") {
      const value = part.input_audio;
      const url = typeof value === "string" ? value : (value as { url?: string } | undefined)?.url;
      if (url) {
        normalized.push({ type: "file", data: url, mimeType: "audio/mpeg" });
      }
      continue;
    }

    if (type === "video_url") {
      const value = part.video_url;
      const url = typeof value === "string" ? value : (value as { url?: string } | undefined)?.url;
      if (url) {
        normalized.push({ type: "file", data: url, mimeType: "video/mp4" });
      }
      continue;
    }

    if (type === "tool-call" || type === "tool_call") {
      normalized.push({
        type: "tool-call",
        toolCallId: part.toolCallId || part.id || "",
        toolName: part.toolName || part.name || "",
        args: part.args || part.input || {},
      });
      continue;
    }

    if (type === "tool-result" || type === "tool_result") {
      normalized.push({
        type: "tool-result",
        toolCallId: part.toolCallId || "",
        toolName: part.toolName || "",
        result:
          typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? ""),
      });
      continue;
    }

    // Unknown parts are preserved as serialized text to avoid dropping input context.
    normalized.push({
      type: "text",
      text: JSON.stringify(part),
    });
  }

  return normalized;
}

function convertToolsForAISDK(tools: ChatOptions["tools"]) {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted: Record<string, { description?: string; inputSchema: ReturnType<typeof jsonSchema> }> = {};

  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) {
      continue;
    }

    converted[tool.function.name] = {
      description: tool.function.description || "",
      inputSchema: jsonSchema(tool.function.parameters || { type: "object", properties: {} }),
    };
  }

  return Object.keys(converted).length ? converted : undefined;
}

function convertToolChoice(
  toolChoice: ChatOptions["tool_choice"],
): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return {
      type: "tool",
      toolName: toolChoice.function.name,
    };
  }

  return undefined;
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

function mapMessagesForAISDK(messages: ChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((message) => {
    if (message.role === "system") {
      return { role: "system", content: normalizeContentToString(message.content) };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id || "",
            toolName: message.name || "",
            result: normalizeContentToString(message.content),
          },
        ],
      };
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const content: unknown[] = [];
      const text = normalizeContentToString(message.content);
      if (text) {
        content.push({ type: "text", text });
      }

      for (const call of message.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = call.function.arguments || {};
        }

        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function.name,
          args,
        });
      }

      return { role: "assistant", content };
    }

    if (Array.isArray(message.content)) {
      const parts = normalizeContentParts(message.content);
      if (parts.length > 0) {
        return { role: message.role, content: parts };
      }
    }

    return {
      role: message.role,
      content: normalizeContentToString(message.content),
    };
  });
}

function mapMessagesForVertex(messages: ChatMessage[]): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((message) => {
    if (Array.isArray(message.content)) {
      return { role: message.role, content: message.content };
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      return {
        role: "assistant",
        content: normalizeContentToString(message.content),
      };
    }

    if (message.role === "tool") {
      return {
        role: "user",
        content: normalizeContentToString(message.content),
      };
    }

    return {
      role: message.role,
      content: normalizeContentToString(message.content),
    };
  });
}

// =============================================================================
// Unified Invocation API
// =============================================================================

export async function invokeUnified(
  modelId: string,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult | void> {
  const { provider } = requireModel(modelId);

  if (provider === "vertex") {
    const vertexMessages = mapMessagesForVertex(messages);

    if (options.stream) {
      let fullText = "";
      await streamVertexChat(modelId, vertexMessages, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        onToken: async (token) => {
          fullText += token;
          if (options.onToken) {
            await options.onToken(token);
          }
        },
        onComplete: async () => {
          if (options.onComplete) {
            const tokens = Math.ceil(fullText.length / 4);
            options.onComplete({
              usage: {
                promptTokens: 0,
                completionTokens: tokens,
                totalTokens: tokens,
              },
            });
          }
        },
        onError: options.onError,
      });
      return;
    }

    const text = await generateVertexChat(modelId, vertexMessages, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });

    const estimatedTokens = Math.ceil(text.length / 4);
    return {
      content: text,
      usage: {
        promptTokens: 0,
        completionTokens: estimatedTokens,
        totalTokens: estimatedTokens,
      },
      finishReason: "stop",
    };
  }

  const model = getLanguageModel(modelId, provider);
  const mappedMessages = mapMessagesForAISDK(messages);

  if (options.stream) {
    const result = streamText({
      model,
      messages: mappedMessages as any,
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(options.tools ? { tools: convertToolsForAISDK(options.tools) } : {}),
      ...(options.tool_choice ? { toolChoice: convertToolChoice(options.tool_choice) } : {}),
      onError: (error) => {
        if (options.onError) {
          options.onError(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        if (options.onToken) {
          await options.onToken((part as { text?: string }).text || "");
        }
        continue;
      }

      if (part.type === "tool-call") {
        if (options.onToolCall) {
          const payload = part as { toolCallId?: string; toolName?: string; input?: unknown; args?: unknown };
          await options.onToolCall({
            id: payload.toolCallId || `call_${Date.now()}`,
            name: payload.toolName || "",
            arguments: JSON.stringify(payload.input ?? payload.args ?? {}),
          });
        }
        continue;
      }

      if (part.type === "error") {
        const payload = part as { error?: unknown };
        throw new Error(String(payload.error ?? "Unknown stream error"));
      }
    }

    if (options.onComplete) {
      const usage = (await result.usage) as {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
      options.onComplete({
        usage: {
          promptTokens: usage?.promptTokens || 0,
          completionTokens: usage?.completionTokens || 0,
          totalTokens: usage?.totalTokens || 0,
        },
      });
    }

    return;
  }

  const result = await generateText({
    model,
    messages: mappedMessages as any,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(options.tools ? { tools: convertToolsForAISDK(options.tools) } : {}),
    ...(options.tool_choice ? { toolChoice: convertToolChoice(options.tool_choice) } : {}),
  });

  const toolCalls = result.toolCalls?.map((call, index) => ({
    id: (call as { toolCallId?: string }).toolCallId || `call_${index}`,
    name: (call as { toolName: string }).toolName,
    arguments: JSON.stringify((call as { args?: unknown }).args || {}),
  }));

  return {
    content: result.text,
    usage: {
      promptTokens: (result.usage as { promptTokens?: number })?.promptTokens || 0,
      completionTokens: (result.usage as { completionTokens?: number })?.completionTokens || 0,
      totalTokens: (result.usage as { totalTokens?: number })?.totalTokens || 0,
    },
    finishReason: result.finishReason,
    toolCalls: toolCalls && toolCalls.length ? toolCalls : undefined,
  };
}

export const invokeChat = invokeUnified;
export const invoke = invokeUnified;

export async function invokeImage(
  modelId: string,
  prompt: string,
  options: ImageOptions = {},
): Promise<ImageResult> {
  const { provider } = requireModel(modelId);

  return withRetry(async () => {
    switch (provider) {
      case "google": {
        const buffer = await googleGenerateImage(modelId, prompt, { numberOfImages: options.n });
        return { buffer, mimeType: "image/png" };
      }
      case "openai": {
        const buffer = await openaiGenerateImage(modelId, prompt, {
          size: options.size as "1024x1024" | "1792x1024" | "1024x1792" | "256x256" | "512x512" | undefined,
          quality: options.quality as "standard" | "hd" | undefined,
          n: options.n,
        });
        return { buffer, mimeType: "image/png" };
      }
      case "vertex": {
        const result = await generateVertexImage(modelId, prompt, {
          size: options.size,
          n: options.n,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      case "huggingface": {
        const card = getModelById(modelId);
        const input: HFInferenceInput = {
          modelId,
          task: "text-to-image",
          prompt,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(input);
        return { buffer: result.data as Buffer, mimeType: "image/png" };
      }
      case "aiml": {
        const apiKey = process.env.AI_ML_API_KEY;
        if (!apiKey) {
          throw new Error("AI_ML_API_KEY not configured");
        }

        const response = await fetch("https://api.aimlapi.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            prompt,
            n: options.n || 1,
            size: options.size || "1024x1024",
            ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`AIML image generation failed: ${response.status} - ${text}`);
        }

        const data = (await response.json()) as {
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        const first = data.data?.[0];
        if (!first) {
          throw new Error("AIML returned no image data");
        }

        if (first.b64_json) {
          return { buffer: Buffer.from(first.b64_json, "base64"), mimeType: "image/png" };
        }

        if (!first.url) {
          throw new Error("AIML returned no image URL");
        }

        const imageResponse = await fetch(first.url);
        if (!imageResponse.ok) {
          throw new Error(`Failed to download AIML image: ${imageResponse.status}`);
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        return { buffer: Buffer.from(arrayBuffer), mimeType: "image/png" };
      }
      default:
        throw new Error(`Image generation not supported for provider: ${provider}`);
    }
  });
}

export async function invokeVideo(
  modelId: string,
  prompt: string,
  options: VideoOptions = {},
): Promise<VideoResult> {
  const { provider } = requireModel(modelId);

  return withRetry(async () => {
    switch (provider) {
      case "google": {
        const result = await googleGenerateVideo(modelId, prompt, {
          duration: options.duration,
          aspectRatio: options.aspectRatio as "16:9" | "9:16" | undefined,
        });
        return { buffer: result.videoBuffer, mimeType: result.mimeType };
      }
      case "openai": {
        const result = await openaiGenerateVideo(modelId, prompt, {
          duration: options.duration,
          resolution: options.resolution as "720p" | "1080p" | "1792p" | undefined,
          aspectRatio: options.aspectRatio as "16:9" | "9:16" | "1:1" | undefined,
        });
        return { buffer: result.videoBuffer, mimeType: result.mimeType };
      }
      case "vertex": {
        const result = await generateVertexVideo(modelId, prompt, {
          duration: options.duration,
          aspectRatio: options.aspectRatio,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      case "huggingface": {
        const card = getModelById(modelId);
        const input: HFInferenceInput = {
          modelId,
          task: "text-to-video",
          prompt,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(input);
        return { buffer: result.data as Buffer, mimeType: "video/mp4" };
      }
      case "aiml": {
        const apiKey = process.env.AI_ML_API_KEY;
        if (!apiKey) {
          throw new Error("AI_ML_API_KEY not configured");
        }

        const submitResponse = await fetch("https://api.aimlapi.com/v2/video/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            prompt,
            aspect_ratio: options.aspectRatio || "16:9",
            ...(options.duration ? { duration: String(options.duration) } : {}),
            ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
          }),
        });

        if (!submitResponse.ok) {
          const text = await submitResponse.text();
          throw new Error(`AIML video generation failed: ${submitResponse.status} - ${text}`);
        }

        const submitData = (await submitResponse.json()) as {
          id?: string;
          status?: string;
          video?: { url?: string };
          video_url?: string;
          url?: string;
          data?: { video?: { url?: string } };
        };

        const inlineUrl = submitData.video?.url || submitData.video_url || submitData.url || submitData.data?.video?.url;
        if (inlineUrl) {
          const videoResponse = await fetch(inlineUrl);
          if (!videoResponse.ok) {
            throw new Error(`Failed to download AIML video: ${videoResponse.status}`);
          }
          return {
            buffer: Buffer.from(await videoResponse.arrayBuffer()),
            mimeType: "video/mp4",
          };
        }

        if (!submitData.id) {
          throw new Error("AIML returned no job id");
        }

        const status = await checkVideoJobStatus(`aiml:${submitData.id}`);
        if (status.status !== "completed" || !status.url) {
          throw new Error(status.error || "AIML video generation did not complete");
        }

        const response = await fetch(status.url);
        if (!response.ok) {
          throw new Error(`Failed to download AIML video: ${response.status}`);
        }

        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          mimeType: "video/mp4",
        };
      }
      default:
        throw new Error(`Video generation not supported for provider: ${provider}`);
    }
  });
}

export async function invokeTTS(
  modelId: string,
  input: string,
  options: TTSOptions = {},
): Promise<Buffer> {
  const { provider } = requireModel(modelId);

  return withRetry(async () => {
    switch (provider) {
      case "openai":
        return openaiGenerateSpeech(modelId, input, {
          voice: (options.voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer") || "alloy",
          speed: options.speed,
          responseFormat: (options.responseFormat as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm") || "mp3",
        });
      case "google":
        return googleGenerateSpeech(modelId, input);
      case "vertex":
        return (await generateVertexSpeech(modelId, input, {
          voice: options.voice,
        })).buffer;
      case "huggingface": {
        const card = getModelById(modelId);
        const payload: HFInferenceInput = {
          modelId,
          task: "text-to-speech",
          text: input,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(payload);
        return result.data as Buffer;
      }
      default:
        throw new Error(`Text-to-speech not supported for provider: ${provider}`);
    }
  });
}

export async function invokeASR(
  modelId: string,
  audioBuffer: Buffer,
  options: ASROptions = {},
): Promise<ASRResult> {
  const { provider } = requireModel(modelId);

  return withRetry(async () => {
    switch (provider) {
      case "openai":
        return openaiTranscribeAudio(modelId, audioBuffer, {
          language: options.language,
          responseFormat: (options.responseFormat as "json" | "text" | "srt" | "verbose_json" | "vtt") || "json",
        });
      case "vertex":
        return transcribeVertexAudio(modelId, audioBuffer, {
          language: options.language,
        });
      case "huggingface": {
        const card = getModelById(modelId);
        const payload: HFInferenceInput = {
          modelId,
          task: "automatic-speech-recognition",
          audio: audioBuffer.toString("base64"),
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(payload);
        return { text: (result.data as { text?: string }).text || "" };
      }
      default:
        throw new Error(`Speech-to-text not supported for provider: ${provider}`);
    }
  });
}

export async function invokeEmbedding(
  modelId: string,
  input: string | string[],
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  const { provider } = requireModel(modelId);
  const values = Array.isArray(input) ? input : [input];

  return withRetry(async () => {
    if (provider === "vertex") {
      const result = await generateVertexEmbeddings(modelId, values);
      return {
        embeddings: result.embeddings,
        usage: {
          promptTokens: 0,
          totalTokens: 0,
        },
      };
    }

    const model = getLanguageModel(modelId, provider);
    const result = await embedMany({ model: model as any, values });
    return {
      embeddings: result.embeddings,
      usage: {
        promptTokens: 0,
        totalTokens: 0,
      },
    };
  });
}

export async function submitVideoJob(
  modelId: string,
  prompt: string,
  options: VideoOptions = {},
): Promise<VideoJobResult> {
  const { provider } = requireModel(modelId);

  switch (provider) {
    case "aiml": {
      const apiKey = process.env.AI_ML_API_KEY;
      if (!apiKey) {
        throw new Error("AI_ML_API_KEY not configured");
      }

      const response = await fetch("https://api.aimlapi.com/v2/video/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          prompt,
          aspect_ratio: options.aspectRatio || "16:9",
          ...(options.duration ? { duration: String(options.duration) } : {}),
          ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`AIML video submission failed: ${response.status} - ${text}`);
      }

      const data = (await response.json()) as { id?: string; status?: string };
      if (!data.id) {
        throw new Error("AIML returned no job id");
      }

      return {
        jobId: `aiml:${data.id}`,
        status: data.status === "queued" ? "queued" : "processing",
      };
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY not configured");
      }

      const response = await fetch("https://api.openai.com/v1/videos", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          prompt,
          size: options.aspectRatio === "9:16" ? "720x1280" : "1280x720",
          seconds: String(options.duration && options.duration >= 8 ? (options.duration >= 12 ? 12 : 8) : 4),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI video submission failed: ${response.status} - ${text}`);
      }

      const data = (await response.json()) as { id?: string; status?: string };
      if (!data.id) {
        throw new Error("OpenAI returned no job id");
      }

      return {
        jobId: `openai:${data.id}`,
        status: data.status === "queued" ? "queued" : "processing",
      };
    }

    case "google": {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
      }

      const genai = new GoogleGenAI({ apiKey }) as any;
      const operation = await genai.videos.generate({
        model: modelId,
        prompt,
      });

      if (!operation.name) {
        throw new Error("Google returned no operation name");
      }

      return {
        jobId: `google:${operation.name}`,
        status: "processing",
      };
    }

    case "vertex": {
      const apiKey = process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
      const projectId = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
      const location = process.env.VERTEX_LOCATION || "us-central1";

      if (!apiKey) {
        throw new Error("VERTEX_AI_API_KEY or GOOGLE_CLOUD_API_KEY not configured");
      }
      if (!projectId) {
        throw new Error("VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT not configured");
      }

      const normalizedModel = modelId.includes("/") ? modelId.split("/").pop() : modelId;
      const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${normalizedModel}:predictLongRunning`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            aspectRatio: options.aspectRatio || "16:9",
            durationSeconds: options.duration || 8,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Vertex video submission failed: ${response.status} - ${text}`);
      }

      const data = (await response.json()) as { name?: string };
      if (!data.name) {
        throw new Error("Vertex returned no operation name");
      }

      return {
        jobId: `vertex:${data.name}`,
        status: "processing",
      };
    }

    default:
      throw new Error(`Async video generation not supported for provider: ${provider}`);
  }
}

export async function checkVideoJobStatus(jobId: string): Promise<VideoJobStatus> {
  const [provider, providerJobId] = jobId.split(":");
  if (!provider || !providerJobId) {
    throw new Error(`Invalid video job id: ${jobId}`);
  }

  switch (provider) {
    case "aiml": {
      const apiKey = process.env.AI_ML_API_KEY;
      if (!apiKey) {
        throw new Error("AI_ML_API_KEY not configured");
      }

      const response = await fetch(
        `https://api.aimlapi.com/v2/video/generations?generation_id=${encodeURIComponent(providerJobId)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      );

      if (!response.ok) {
        throw new Error(`AIML video status check failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        status?: string;
        url?: string;
        video_url?: string;
        video?: { url?: string };
        error?: string;
      };

      const status =
        data.status === "completed" || data.status === "success"
          ? "completed"
          : data.status === "failed"
            ? "failed"
            : data.status === "queued"
              ? "queued"
              : "processing";

      return {
        jobId,
        status,
        url: data.url || data.video_url || data.video?.url,
        error: data.error,
      };
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY not configured");
      }

      const response = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(providerJobId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        throw new Error(`OpenAI video status check failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        status?: string;
        video?: { url?: string };
        error?: string;
      };

      const status =
        data.status === "completed" || data.status === "success"
          ? "completed"
          : data.status === "failed"
            ? "failed"
            : data.status === "queued"
              ? "queued"
              : "processing";

      return {
        jobId,
        status,
        url: data.video?.url,
        error: data.error,
      };
    }

    case "google": {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
      }

      const genai = new GoogleGenAI({ apiKey }) as any;
      const operation = await genai.operations.get({ operationName: providerJobId });

      if (!operation.done) {
        return { jobId, status: "processing" };
      }

      if (operation.error) {
        return { jobId, status: "failed", error: operation.error.message };
      }

      const url = operation.response?.videos?.[0]?.uri as string | undefined;
      return { jobId, status: "completed", url };
    }

    case "vertex": {
      const apiKey = process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
      const location = process.env.VERTEX_LOCATION || "us-central1";
      if (!apiKey) {
        throw new Error("VERTEX_AI_API_KEY or GOOGLE_CLOUD_API_KEY not configured");
      }

      const response = await fetch(`https://${location}-aiplatform.googleapis.com/v1/${providerJobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        throw new Error(`Vertex video status check failed: ${response.status}`);
      }

      const operation = (await response.json()) as {
        done?: boolean;
        error?: { message: string };
        response?: { predictions?: Array<{ bytesBase64Encoded?: string }> };
      };

      if (!operation.done) {
        return { jobId, status: "processing" };
      }

      if (operation.error) {
        return { jobId, status: "failed", error: operation.error.message };
      }

      const base64 = operation.response?.predictions?.[0]?.bytesBase64Encoded;
      if (!base64) {
        return { jobId, status: "completed" };
      }

      return {
        jobId,
        status: "completed",
        url: `data:video/mp4;base64,${base64}`,
      };
    }

    default:
      throw new Error(`Unsupported video status provider: ${provider}`);
  }
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

function amountForUnifiedRequest(request: UnifiedRequest, provider: ModelProvider, card?: ModelCard | null): number {
  const profile = request.modality;
  const amount = parseInt(
    getPriceForRequest({
      modelId: request.model,
      provider,
      requestProfile: profile,
      outputModality: request.modality,
      taskType: typeof card?.taskType === "string" ? card.taskType : undefined,
    }),
    10,
  );

  return Number.isFinite(amount) && amount > 0 ? amount : INFERENCE_PRICE_WEI;
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
      ...(record.error ? { error: { message: record.error } } : {}),
      ...(record.jobId ? { job_id: record.jobId } : {}),
    };
  }

  const payload = toResponsesResponse(record.model, record.id, record.output) as unknown as Record<string, unknown>;
  payload.status = record.status;
  if (record.jobId) {
    payload.job_id = record.jobId;
  }
  if (record.error) {
    payload.error = { message: record.error };
  }
  return payload;
}

async function executeUnifiedRequest(args: {
  req: Request;
  res: Response;
  unified: UnifiedRequest;
  shape: ResponseShape;
}): Promise<void> {
  const modelId = args.unified.model;
  if (!modelId) {
    args.res.status(400).json(createCoreErrorResponse("model is required", "invalid_request_error", "missing_model"));
    return;
  }

  const resolved = resolveModel(modelId, args.unified.provider);
  const amountWei = amountForUnifiedRequest(args.unified, resolved.provider, resolved.card);
  const payment = await prepareInferencePayment(args.req, args.res, amountWei);
  if (!payment) {
    return;
  }

  const baseRecord: StoredResponseRecord = {
    id: args.unified.responseId,
    model: modelId,
    provider: resolved.provider,
    createdAt: Math.floor(Date.now() / 1000),
    status: "in_progress",
  };
  await saveResponseRecord(baseRecord);

  try {
    if (args.unified.stream && args.unified.modality === "text") {
      args.res.setHeader("Content-Type", "text/event-stream");
      args.res.setHeader("Cache-Control", "no-cache");
      args.res.setHeader("Connection", "keep-alive");
      args.res.setHeader("X-Request-Id", args.unified.responseId);

      const routed = await runWithPolicy({
        context: {
          modelId,
          provider: resolved.provider,
          card: resolved.card,
        },
        execute: async (target) => {
          return {
            target,
            stream: streamAdapter(args.unified, {
              modelId: target.modelId,
              provider: target.provider,
            }),
          };
        },
      });

      applyRoutingHeaders(args.res, routed);

      let settled = false;
      let isFirstToken = true;
      let aggregatedText = "";
      let lastUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason = "stop";

      try {
        for await (const event of routed.result.stream) {
          if (event.type === "text-delta") {
            if (!settled) {
              await settlePreparedPayment(payment, args.res);
              settled = true;
            }
            aggregatedText += event.text || "";
            const payload = args.shape === "chat"
              ? toChatStreamEvent(args.unified.responseId, modelId, event, isFirstToken)
              : toResponsesStreamEvent(args.unified.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            isFirstToken = false;
            continue;
          }

          if (event.type === "tool-call") {
            if (!settled) {
              await settlePreparedPayment(payment, args.res);
              settled = true;
            }
            const payload = args.shape === "chat"
              ? toChatStreamEvent(args.unified.responseId, modelId, event)
              : toResponsesStreamEvent(args.unified.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
            continue;
          }

          if (event.type === "done") {
            if (event.usage) {
              lastUsage = event.usage;
            }
            finishReason = event.finishReason || "stop";
            const payload = args.shape === "chat"
              ? toChatStreamEvent(args.unified.responseId, modelId, event)
              : toResponsesStreamEvent(args.unified.responseId, modelId, event);
            args.res.write(formatCoreSSE(payload));
          }
        }

        if (!settled) {
          await payment.abort("no_stream_output");
        }

        args.res.write(formatCoreSSEDone());
        args.res.end();

        await saveResponseRecord({
          ...baseRecord,
          status: "completed",
          output: {
            modality: "text",
            content: aggregatedText,
            usage: lastUsage,
            finishReason,
          },
        });
      } catch (error) {
        if (!settled) {
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
        invokeAdapter(args.unified, {
          modelId: target.modelId,
          provider: target.provider,
        }),
    });

    applyRoutingHeaders(args.res, routed);

    const output = routed.result.output;
    await settlePreparedPayment(payment, args.res);

    const record: StoredResponseRecord = {
      ...baseRecord,
      status: output.media?.jobId && output.media.status && output.media.status !== "completed" ? "in_progress" : "completed",
      output,
      ...(output.media?.jobId ? { jobId: output.media.jobId } : {}),
    };
    await saveResponseRecord(record);

    if (args.shape === "chat") {
      args.res.status(200).json(toChatCompletionsResponse(modelId, args.unified.responseId, output));
      return;
    }

    if (args.shape === "embeddings") {
      args.res.status(200).json(toEmbeddingsResponse(modelId, output));
      return;
    }

    const payload = toResponsesResponse(modelId, args.unified.responseId, output) as unknown as Record<string, unknown>;
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

    if (unified.modality !== "embedding" && unified.messages.length === 0) {
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

async function sendPaymentChallenge(req: Request, res: Response, amountWei: number): Promise<void> {
  const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
  const result = await handleX402Payment(
    null,
    resourceUrl,
    req.method || "POST",
    String(amountWei || INFERENCE_PRICE_WEI),
    getChainIdFromReq(req),
  );

  for (const [key, value] of Object.entries(result.responseHeaders)) {
    res.setHeader(key, value);
  }

  res.status(result.status).json(result.responseBody);
}

async function prepareInferencePayment(
  req: Request,
  res: Response,
  amountWei: number,
): Promise<PreparedPayment | null> {
  const payment = await prepareDeferredPayment(req, amountWei);
  if (payment.valid) {
    return payment;
  }

  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const error = payment.error || "Payment required";

  if (authHeader.startsWith("Bearer ")) {
    if (/invalid/i.test(error)) {
      res.status(401).json({ error });
      return null;
    }

    if (/budget|exhausted/i.test(error)) {
      res.status(402).json({ error });
      return null;
    }
  }

  await sendPaymentChallenge(req, res, amountWei);
  return null;
}

async function settlePreparedPayment(payment: PreparedPayment, res: Response): Promise<void> {
  const settlement = await payment.settle();
  if (!settlement.success) {
    throw new Error(settlement.error || "Payment settlement failed");
  }

  for (const [key, value] of Object.entries(payment.getHeaders())) {
    res.setHeader(key, value);
  }

  if (settlement.txHash) {
    res.setHeader("X-Transaction-Hash", settlement.txHash);
    res.setHeader("x-compose-key-tx-hash", settlement.txHash);
  }
}

async function runDeferredInference<T>(args: {
  req: Request;
  res: Response;
  amountWei: number;
  execute: () => Promise<T>;
  onSuccess: (result: T) => void;
}): Promise<void> {
  const payment = await prepareInferencePayment(args.req, args.res, args.amountWei);
  if (!payment) {
    return;
  }

  try {
    const result = await args.execute();
    await settlePreparedPayment(payment, args.res);
    args.onSuccess(result);
  } catch (error) {
    await payment.abort(error instanceof Error ? error.message : "inference_failed");
    throw error;
  }
}

function modelPrice(modelId?: string, requestProfile: "text" | "image" | "audio" | "video" | "embedding" = "text"): number {
  if (!modelId) {
    return INFERENCE_PRICE_WEI;
  }
  const amount = parseInt(getPriceForRequest({ modelId, requestProfile }), 10);
  return Number.isFinite(amount) ? amount : INFERENCE_PRICE_WEI;
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
      data: models.models.map(modelCardToOpenAI),
    };

    res.status(200).json(response);
  } catch (error) {
    const { status, body } = adaptError(error, 500);
    res.status(status).json(body);
  }
}

async function handleModelParams(req: Request, res: Response): Promise<void> {
  const { handleGetModelParams } = await import("./paramsHandler.js");
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

    res.status(200).json(modelCardToOpenAI(model));
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

    const model = body.model || "dall-e-3";
    await runDeferredInference({
      req,
      res,
      amountWei: modelPrice(model, "image"),
      execute: () =>
        invokeImage(model, body.prompt, {
          n: body.n,
          size: body.size,
          quality: body.quality,
          imageUrl: body.image_url || body.image,
        }),
      onSuccess: (result) => {
        res.status(200).json(
          adaptImageResponse({
            images: [{ b64_json: result.buffer.toString("base64") }],
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

    const model = body.model || "dall-e-2";
    await runDeferredInference({
      req,
      res,
      amountWei: modelPrice(model, "image"),
      execute: () => invokeImage(model, body.prompt!, { n: body.n, size: body.size, imageUrl: body.image }),
      onSuccess: (result) => {
        res.status(200).json(
          adaptImageResponse({
            images: [{ b64_json: result.buffer.toString("base64") }],
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

    const model = body.model || "tts-1";
    const format = body.response_format || "mp3";

    await runDeferredInference({
      req,
      res,
      amountWei: modelPrice(model, "audio"),
      execute: () =>
        invokeTTS(model, body.input, {
          voice: body.voice || "alloy",
          speed: body.speed,
          responseFormat: format,
        }),
      onSuccess: (audio) => {
        const contentTypes: Record<string, string> = {
          mp3: "audio/mpeg",
          opus: "audio/opus",
          aac: "audio/aac",
          flac: "audio/flac",
          wav: "audio/wav",
          pcm: "audio/pcm",
        };
        res.setHeader("Content-Type", contentTypes[format] || "audio/mpeg");
        res.send(audio);
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

    const model = body.model || "whisper-1";
    const buffer = Buffer.from(body.file, "base64");

    await runDeferredInference({
      req,
      res,
      amountWei: modelPrice(model, "audio"),
      execute: () =>
        invokeASR(model, buffer, {
          language: body.language,
          responseFormat: body.response_format,
        }),
      onSuccess: (result) => {
        const response = adaptTranscriptionResponse(result);
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

    const { provider } = requireModel(body.model);
    const isAsyncProvider = ["aiml", "openai", "google", "vertex"].includes(provider);

    await runDeferredInference({
      req,
      res,
      amountWei: modelPrice(body.model, "video"),
      execute: async () => {
        if (isAsyncProvider) {
          return {
            type: "async" as const,
            result: await submitVideoJob(body.model, body.prompt, {
              duration: body.duration,
              aspectRatio: body.aspect_ratio,
              imageUrl: body.image_url || body.image,
            }),
          };
        }

        return {
          type: "sync" as const,
          result: await invokeVideo(body.model, body.prompt, {
            duration: body.duration,
            aspectRatio: body.aspect_ratio,
            resolution: body.size,
            imageUrl: body.image_url || body.image,
          }),
        };
      },
      onSuccess: (payload) => {
        if (payload.type === "async") {
          res.status(202).json({
            id: payload.result.jobId,
            object: "video.generation",
            status: payload.result.status,
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
                  base64: payload.result.buffer.toString("base64"),
                  duration: body.duration,
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
    const status = await checkVideoJobStatus(jobId);
    res.status(200).json({
      id: status.jobId,
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
