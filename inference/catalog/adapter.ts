import { performance } from "node:perf_hooks";
import { GenerateVideosOperation, GoogleGenAI } from "@google/genai";

import { getModelById } from "./registry.js";
import type { ModelProvider } from "../types.js";
import type {
  Message,
  Output,
  Request,
  Event,
  Usage,
} from "../core.js";
import * as openaiFamily from "./families/openai.js";
import * as googleFamily from "./families/google.js";
import {
  generateImage as googleGenerateImage,
  streamImage as googleStreamImage,
  generateMusic as googleGenerateMusic,
  generateSpeech as googleGenerateSpeech,
  generateVideo as googleGenerateVideo,
} from "./families/google.js";
import {
  openaiGenerateImage,
  isOpenAIImageStreamingUnsupportedError,
  openaiStreamImage,
  openaiGenerateSpeech,
  openaiGenerateVideo,
  openaiTranscribeAudio,
} from "./families/openai.js";
import {
  executeHFInference,
  type HFInferenceInput,
} from "./vendors/huggingface.js";
import {
  generateVertexChat,
  generateVertexEmbeddings,
  generateVertexImage,
  generateVertexSpeech,
  generateVertexVideo,
  streamVertexChat,
  transcribeVertexAudio,
} from "./vendors/vertex.js";
import {
  generateFireworksImage,
  transcribeFireworksAudio,
} from "./vendors/fireworks.js";
import {
  generateAzureChat,
  generateAzureEmbeddings,
  generateAzureImage,
} from "./vendors/azure.js";
import {
  generateAlibabaChat,
  generateAlibabaEmbeddings,
  generateAlibabaImage,
  generateAlibabaSpeech,
  retrieveAlibabaVideo,
  submitAlibabaVideo,
  transcribeAlibabaAudio,
} from "./vendors/alibaba.js";
import {
  analyzeCloudflareImage,
  analyzeCloudflareVision,
  detectCloudflareTurn,
  generateCloudflareImage,
  generateCloudflareSpeech,
  rerankCloudflareText,
  translateCloudflareText,
  transcribeCloudflareAudio,
} from "./vendors/cloudflare.js";
import {
  generateDeepgramSpeech,
  transcribeDeepgramAudio,
} from "./families/deepgram.js";
import {
  generateElevenLabsMusic,
  generateElevenLabsSpeech,
  generateElevenLabsSpeechToSpeech,
  generateElevenLabsSound,
  transcribeElevenLabsAudio,
} from "./families/elevenlabs.js";
import { generateCartesiaSpeech } from "./families/cartesia.js";
import { analyzeRoboflowImage, generateRoboflowEmbeddings } from "./families/roboflow.js";
import {
  elapsedSecondsSince,
  generatedImageCount,
  imageBillingMetricsFromOutput,
  selectImageTaskForInput,
  supportsOpenAINativeImageStreaming,
} from "./modalities/image.js";
import {
  buildGoogleVideoGenerationRequest,
  buildOpenAIVideoSubmissionBody,
  buildVertexVideoParameters,
  parseAsyncVideoJobId,
  selectVideoTaskForInput,
  videoBillingMetricsFromOutput,
} from "./modalities/video.js";
import {
  embeddingInputValues,
  normalizeFeatureExtractionEmbeddings,
} from "./modalities/embeddings.js";
import { audioDurationSeconds } from "./modalities/speech.js";
import { bufferFromPayload } from "./shared/media.js";

export interface AdapterTarget {
  modelId: string;
  provider: ModelProvider;
  signal?: AbortSignal;
}

export interface AdapterResult {
  output: Output;
}

export interface AdapterStatus {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  error?: string;
  progress?: number;
}

function normalizeContentToString(content: unknown): string {
  if (content == null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content);
  }

  const textParts = content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => (part as { text?: unknown }).text)
    .filter((value): value is string => typeof value === "string");

  if (textParts.length) {
    return textParts.join("\n");
  }

  return JSON.stringify(content);
}

function normalizeContentParts(contentArray: unknown[]): unknown[] {
  const normalized: unknown[] = [];

  for (const rawPart of contentArray) {
    if (!rawPart || typeof rawPart !== "object") {
      continue;
    }

    const part = rawPart as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text" && typeof part.text === "string") {
      normalized.push({ type: "text", text: part.text });
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
        input: part.input ?? part.args ?? {},
      });
      continue;
    }

    if (type === "tool-result" || type === "tool_result") {
      normalized.push({
        type: "tool-result",
        toolCallId: part.toolCallId || "",
        toolName: part.toolName || "",
        output: normalizeToolOutput(part.output ?? part.result),
      });
      continue;
    }

    normalized.push({ type: "text", text: JSON.stringify(part) });
  }

  return normalized;
}

function normalizeToolOutput(value: unknown): unknown {
  if (value && typeof value === "object" && "type" in (value as Record<string, unknown>)) {
    return value;
  }

  if (typeof value === "string") {
    return {
      type: "text",
      value,
    };
  }

  return {
    type: "json",
    value: value ?? null,
  };
}

// =============================================================================
// Gemini thought_signature round-trip cache
// =============================================================================
//
// Gemini 3+ (and 2.5 reasoning models) require that every functionCall part
// returned in a previous turn be sent back with its `thoughtSignature` when
// the next turn carries the tool result. The signature is an opaque blob the
// model uses to reconstruct its own reasoning state.
//
// The OpenAI-compatible wire format we use between runtime, api, and provider
// has no slot for `thoughtSignature` on a `tool_calls[i]` entry, and legacy
// tool-call converters strip unknown fields before they hit the wire. So we
// cannot piggyback on the wire; we cache server-side, keyed by the
// api-generated `toolCallId`, which DOES survive the round trip unchanged.
//
// In-process Map only. A multi-step Gemini tool loop is held inside ONE
// SSE response on ONE api instance for the entire turn — tool calls
// within that turn never cross instances. Cross-turn continuity is
// handled by the persisted message history (Responses API).
//
// TTL is 10m: a regular multi-step tool loop completes in seconds.

const THOUGHT_SIGNATURE_TTL_MS = 10 * 60_000;
const thoughtSignatures = new Map<string, { signature: string; expiresAt: number }>();

function rememberThoughtSignature(toolCallId: string | undefined, signature: string | undefined): void {
  if (!toolCallId || typeof signature !== "string" || signature.length === 0) return;
  thoughtSignatures.set(toolCallId, {
    signature,
    expiresAt: Date.now() + THOUGHT_SIGNATURE_TTL_MS,
  });
  // Cheap GC pass: when the map gets large, prune everything expired.
  if (thoughtSignatures.size > 2_000) {
    const now = Date.now();
    for (const [key, entry] of thoughtSignatures) {
      if (entry.expiresAt <= now) thoughtSignatures.delete(key);
    }
  }
}

function recallThoughtSignature(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const entry = thoughtSignatures.get(toolCallId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    thoughtSignatures.delete(toolCallId);
    return undefined;
  }
  return entry.signature;
}

function mapMessagesForVertex(messages: Message[]): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((message) => {
    if (Array.isArray(message.content)) {
      return { role: message.role, content: message.content };
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

// Endpoint resolution for OpenAI-compatible aggregators that piggyback on
// families/openai.ts (chat / streamChat / embeddings / responses). Each entry
// returns the wire-level `{ baseURL, apiKey, authStyle, paths? }` used to
// reach that provider's OpenAI-compat surface.
function openaiCompatEndpointFor(provider: ModelProvider): openaiFamily.OpenAIWireEndpoint {
  switch (provider) {
    case "openai":
      return openaiFamily.openaiEndpoint();
    case "cloudflare": {
      const accountId = process.env.CF_ACCOUNT_ID || "";
      return {
        baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
        apiKey: process.env.CF_API_TOKEN || "",
        authStyle: "bearer",
      };
    }
    case "fireworks":
      return {
        baseURL: "https://api.fireworks.ai/inference/v1",
        apiKey: process.env.FIREWORKS_API_KEY || "",
        authStyle: "bearer",
      };
    case "asicloud":
      return {
        baseURL: "https://inference.asicloud.cudos.org/v1",
        apiKey: process.env.ASI_INFERENCE_API_KEY || "",
        authStyle: "bearer",
      };
    case "hugging face":
      return {
        baseURL: "https://router.huggingface.co/v1",
        apiKey: process.env.HUGGING_FACE_INFERENCE_TOKEN || "",
        authStyle: "bearer",
      };
    default:
      throw new Error(`No OpenAI-compatible endpoint configured for provider: ${provider}`);
  }
}

function hasFunctionTools(request: Request): boolean {
  return Array.isArray(request.tools)
    && request.tools.some((tool) => tool?.type === "function" && Boolean(tool.function?.name));
}

function hasReasoning(request: Request): boolean {
  const custom = request.customParams || {};
  return custom.reasoning !== undefined || custom.reasoning_effort !== undefined;
}

function useOpenAIResponsesWire(request: Request, target: AdapterTarget): boolean {
  return target.provider === "openai"
    && request.modality === "text"
    && (request.mode === "responses" || (hasFunctionTools(request) && hasReasoning(request)));
}

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "request aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (aborted(signal)) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

function withRetry<T>(operation: () => Promise<T>, retries = 3, signal?: AbortSignal): Promise<T> {
  return (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      if (aborted(signal)) {
        throw abortError(signal);
      }
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= retries || aborted(signal) || isAbort(error)) {
          break;
        }
        await wait(250 * attempt, signal);
      }
    }
    throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
  })();
}

function getPrimaryText(messages: Message[]): string {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      const textPart = message.content.find((part) => part.type === "text" && typeof part.text === "string");
      if (textPart?.text) {
        return textPart.text;
      }
    }
  }

  return "";
}

function findUrl(messages: Message[], type: "image_url" | "input_audio" | "video_url"): string | undefined {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (!part || part.type !== type) {
        continue;
      }

      if (type === "image_url") {
        const value = part.image_url;
        return typeof value === "string" ? value : value?.url;
      }

      if (type === "input_audio") {
        const value = part.input_audio;
        return typeof value === "string" ? value : value?.url;
      }

      if (type === "video_url") {
        const value = part.video_url;
        return typeof value === "string" ? value : value?.url;
      }
    }
  }

  return undefined;
}

function findUrls(messages: Message[], type: "image_url" | "input_audio" | "video_url"): string[] {
  const urls: string[] = [];
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (!part || part.type !== type) continue;
      const value = type === "image_url"
        ? part.image_url
        : type === "input_audio"
          ? part.input_audio
          : part.video_url;
      const url = typeof value === "string" ? value : value?.url;
      if (url) urls.push(url);
    }
  }
  return urls;
}

async function fetchRemoteBuffer(url?: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (!url) {
    return null;
  }

  return (await bufferFromPayload(url, "application/octet-stream", signal)).buffer;
}

async function fetchRemoteMedia(url?: string, signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!url) {
    return null;
  }

  return bufferFromPayload(url, "application/octet-stream", signal);
}

function findPositiveNumericField(value: unknown, keys: Set<string>, depth = 0): number | undefined {
  if (depth > 5 || !value || typeof value !== "object") {
    return undefined;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (keys.has(normalizedKey)) {
      const numeric = typeof child === "number"
        ? child
        : typeof child === "string"
          ? Number(child)
          : undefined;
      if (typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0) {
        return numeric;
      }
    }

    const nested = findPositiveNumericField(child, keys, depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function findProviderDurationSeconds(value: unknown): number | undefined {
  return findPositiveNumericField(value, new Set(["seconds", "duration", "durationseconds", "videodurationseconds"]));
}

function usageFromResult(result: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): Usage {
  return normalizeUsage(result);
}

type Tokens = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
  raw?: Record<string, unknown>;
};

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function assignMetric(metrics: Record<string, unknown>, key: string, value: unknown): void {
  const numericValue = readTokenCount(value);
  if (numericValue !== undefined) {
    metrics[key] = numericValue;
  }
}

function extractUsageBillingMetrics(result: Tokens): Record<string, unknown> | undefined {
  const metrics: Record<string, unknown> = {};
  const raw = asRecord(result.raw);

  assignMetric(metrics, "cached_input_tokens", result.cachedInputTokens ?? result.inputTokenDetails?.cacheReadTokens);
  assignMetric(metrics, "uncached_input_tokens", result.inputTokenDetails?.noCacheTokens);
  assignMetric(metrics, "output_text_tokens", result.outputTokenDetails?.textTokens);
  assignMetric(metrics, "reasoning_tokens", result.reasoningTokens ?? result.outputTokenDetails?.reasoningTokens);

  const inputDetails = asRecord(
    raw?.prompt_tokens_details
    ?? raw?.promptTokenDetails
    ?? raw?.input_tokens_details
    ?? raw?.inputTokenDetails,
  );
  const cachedInputDetails = asRecord(inputDetails?.cached_tokens_details ?? inputDetails?.cachedTokensDetails);
  assignMetric(metrics, "cached_input_tokens", inputDetails?.cached_tokens ?? inputDetails?.cachedTokens);
  assignMetric(metrics, "input_text_tokens", inputDetails?.text_tokens ?? inputDetails?.textTokens);
  assignMetric(metrics, "input_audio_tokens", inputDetails?.audio_tokens ?? inputDetails?.audioTokens);
  assignMetric(metrics, "input_image_tokens", inputDetails?.image_tokens ?? inputDetails?.imageTokens);
  assignMetric(metrics, "cached_input_text_tokens", cachedInputDetails?.text_tokens ?? cachedInputDetails?.textTokens);
  assignMetric(metrics, "cached_input_audio_tokens", cachedInputDetails?.audio_tokens ?? cachedInputDetails?.audioTokens);
  assignMetric(metrics, "cached_input_image_tokens", cachedInputDetails?.image_tokens ?? cachedInputDetails?.imageTokens);

  const outputDetails = asRecord(
    raw?.completion_tokens_details
    ?? raw?.completionTokenDetails
    ?? raw?.output_tokens_details
    ?? raw?.outputTokenDetails,
  );
  assignMetric(metrics, "output_text_tokens", outputDetails?.text_tokens ?? outputDetails?.textTokens);
  assignMetric(metrics, "output_audio_tokens", outputDetails?.audio_tokens ?? outputDetails?.audioTokens);
  assignMetric(metrics, "output_image_tokens", outputDetails?.image_tokens ?? outputDetails?.imageTokens);
  assignMetric(metrics, "reasoning_tokens", outputDetails?.reasoning_tokens ?? outputDetails?.reasoningTokens);

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function normalizeUsage(result: Tokens): Usage {
  const promptTokens = readTokenCount(result.promptTokens) ?? readTokenCount(result.inputTokens) ?? 0;
  const completionTokens = readTokenCount(result.completionTokens) ?? readTokenCount(result.outputTokens) ?? 0;
  const totalTokens = readTokenCount(result.totalTokens) ?? (promptTokens + completionTokens);
  const reasoningTokens =
    readTokenCount(result.reasoningTokens)
    ?? readTokenCount(result.outputTokenDetails?.reasoningTokens);
  const cachedInputTokens =
    readTokenCount(result.cachedInputTokens)
    ?? readTokenCount(result.inputTokenDetails?.cacheReadTokens);
  const billingMetrics = extractUsageBillingMetrics(result);
  const raw = asRecord(result.raw);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    ...(billingMetrics ? { billingMetrics } : {}),
    ...(raw ? { raw } : {}),
  };
}

function canonicalUsage(value: unknown): Usage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const promptTokens = readTokenCount(record.promptTokens ?? record.prompt_tokens ?? record.inputTokens ?? record.input_tokens);
  const completionTokens = readTokenCount(record.completionTokens ?? record.completion_tokens ?? record.outputTokens ?? record.output_tokens);
  const totalTokens = readTokenCount(record.totalTokens ?? record.total_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const metrics = asRecord(record.billingMetrics);
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens ?? promptTokens + completionTokens,
    ...(metrics ? { billingMetrics: metrics } : {}),
    ...(asRecord(record.raw) ? { raw: asRecord(record.raw)! } : {}),
  };
}

function numericMetrics(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const metrics: Record<string, unknown> = {};
  if (!record) return metrics;
  for (const [key, raw] of Object.entries(record)) {
    const value = readTokenCount(raw);
    if (value === undefined) continue;
    metrics[key === "seconds" ? "second" : key] = value;
  }
  return metrics;
}

function hasType(card: ReturnType<typeof getModelById>, expected: string): boolean {
  const raw = card?.type;
  const types = Array.isArray(raw) ? raw : [raw];
  return types
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .includes(expected);
}

function catalogParamDescription(card: ReturnType<typeof getModelById>, key: string): string {
  const params = asRecord(card?.params);
  const param = asRecord(params?.[key]);
  return typeof param?.description === "string" ? param.description : "";
}

function supportsTranscriptionPrompt(card: ReturnType<typeof getModelById>): boolean {
  const description = catalogParamDescription(card, "prompt");
  const modelId = typeof card?.modelId === "string" ? card.modelId : "";
  return !(modelId && description.includes(modelId) && /not supported/i.test(description));
}

function speechMimeType(format?: string, fallback = "audio/mpeg"): string {
  switch ((format || "").toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/pcm";
    case "mp3":
      return "audio/mpeg";
    default:
      return fallback;
  }
}

function operation(request: Request): string {
  return typeof request.operation === "string" ? request.operation : "";
}

function isSpeechToTextOperation(request: Request): boolean {
  return operation(request) === "speech-to-text"
    || operation(request) === "realtime-transcription";
}

function isTextToAudioOperation(request: Request): boolean {
  const value = operation(request);
  return value === "text-to-speech"
    || value === "text-to-audio"
    || value === "music-generation"
    || value === "voice-design"
    || value === "sound-effects"
    || value === "text-to-sound-effects"
    || value === "speech-to-speech";
}

function isImageAnalysisOperation(request: Request): boolean {
  const value = operation(request);
  return value === "object-detection"
    || value === "image-classification"
    || value === "image-segmentation"
    || value === "keypoint-detection"
    || value === "gaze-detection"
    || value === "zero-shot-classification"
    || value === "classify"
    || value === "ocr"
    || value === "image-to-text"
    || value === "vision-chat";
}

function estimatedEmbeddingUsage(values: string[]): Usage {
  const promptTokens = values.reduce((total, value) => total + estimateTokens(value), 0);
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    billingMetrics: {
      input_text_tokens: promptTokens,
    },
  };
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private ended = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.ended || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  end(): void {
    if (this.ended || this.failure) {
      return;
    }
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ value: undefined as T, done: true });
    }
  }

  error(error: unknown): void {
    if (this.ended || this.failure) {
      return;
    }
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.failure) {
      throw this.failure;
    }

    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      return { value, done: false };
    }

    if (this.ended) {
      return { value: undefined as T, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }
}

async function transcribe(request: Request, target: AdapterTarget): Promise<Output> {
  const audioUrl = findUrl(request.messages, "input_audio");
  const prompt = getPrimaryText(request.messages);
  const card = getModelById(target.modelId, target.provider);
  const audioMedia = await fetchRemoteMedia(audioUrl, target.signal);
  if (!audioMedia) {
    throw new Error("No audio data available for transcription");
  }
  const audioBuffer = audioMedia.buffer;

  const asrResult = await withRetry(async () => {
    switch (target.provider) {
      case "openai":
        return openaiTranscribeAudio(target.modelId, audioBuffer, {
          language: request.audioOptions?.language,
          responseFormat: request.audioOptions?.responseFormat as any,
          prompt: supportsTranscriptionPrompt(card) ? prompt : undefined,
        });
      case "vertex":
        return transcribeVertexAudio(target.modelId, audioBuffer, {
          language: request.audioOptions?.language,
        });
      case "hugging face": {
        const payload: HFInferenceInput = {
          modelId: target.modelId,
          task: "automatic-speech-recognition",
          audio: audioBuffer.toString("base64"),
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(payload);
        return { text: (result.data as { text?: string }).text || "" };
      }
      case "fireworks":
        return transcribeFireworksAudio(target.modelId, audioBuffer, {
          responseFormat: request.audioOptions?.responseFormat,
        });
      case "cloudflare":
        return transcribeCloudflareAudio(target.modelId, audioBuffer, {
          mimeType: audioMedia.mimeType,
          language: request.audioOptions?.language,
          customParams: request.customParams,
        });
      case "deepgram":
        return transcribeDeepgramAudio(target.modelId, audioBuffer, {
          language: request.audioOptions?.language,
        });
      case "elevenlabs":
        return transcribeElevenLabsAudio(target.modelId, audioBuffer, {
          language: request.audioOptions?.language,
        });
      case "alibaba":
        return transcribeAlibabaAudio(target.modelId, audioUrl, audioBuffer, {
          language: request.audioOptions?.language,
          responseFormat: request.audioOptions?.responseFormat,
          customParams: request.customParams,
        });
      default:
        throw new Error(`Speech-to-text not supported for provider: ${target.provider}`);
    }
  }, 3, target.signal);

  const providerUsage = (asrResult as { usage?: unknown }).usage;
  const asrUsage = canonicalUsage(providerUsage);
  const text = asrResult.text || "";
  const transcriptTokens = text ? estimateTokens(text) : 0;
  const inputSeconds = audioDurationSeconds(audioBuffer, audioMedia.mimeType);
  const inputMetrics = typeof inputSeconds === "number" && Number.isFinite(inputSeconds) && inputSeconds > 0
    ? {
      second: inputSeconds,
      duration: inputSeconds,
      minute: inputSeconds / 60,
      audio_second: inputSeconds,
      audio_minute: inputSeconds / 60,
    }
    : {};
  const usage = asrUsage ? {
    ...asrUsage,
    billingMetrics: {
      ...(asrUsage.billingMetrics || {}),
      ...inputMetrics,
    },
  } : {
    promptTokens: transcriptTokens,
    completionTokens: 0,
    totalTokens: transcriptTokens,
    ...(transcriptTokens > 0 || Object.keys(inputMetrics).length > 0
      ? {
        billingMetrics: {
          ...numericMetrics(providerUsage),
          input_text_tokens: transcriptTokens,
          ...inputMetrics,
        },
      }
      : {}),
  };

  return {
    modality: "text",
    content: text,
    usage,
    finishReason: "stop",
  };
}

async function invokeText(request: Request, target: AdapterTarget): Promise<Output> {
  if (isSpeechToTextOperation(request)) {
    return transcribe(request, target);
  }

  if (target.provider === "roboflow") {
    const prompt = getPrimaryText(request.messages);
    const imageUrl = findUrl(request.messages, "image_url");
    const imageBuffer = await fetchRemoteBuffer(imageUrl, target.signal);

    if (!imageBuffer) {
      throw new Error("Roboflow text analysis requires an image input");
    }

    const result = await analyzeRoboflowImage({
      modelId: target.modelId,
      imageBuffer,
      prompt,
      customParams: request.customParams,
    });

    const completionTokens = estimateTokens(result.text);
    return {
      modality: "text",
      content: result.text,
      usage: {
        promptTokens: estimateTokens(prompt),
        completionTokens,
        totalTokens: estimateTokens(prompt) + completionTokens,
        billingMetrics: result.billingMetrics,
      },
      media: {
        mimeType: "application/json",
        duration: result.billableSeconds,
        billingMetrics: result.billingMetrics,
      },
      finishReason: "stop",
    };
  }

  if (target.provider === "vertex") {
    const text = await generateVertexChat(target.modelId, mapMessagesForVertex(request.messages), {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    });

    const completionTokens = estimateTokens(text);
    return {
      modality: "text",
      content: text,
      usage: {
        promptTokens: 0,
        completionTokens,
        totalTokens: completionTokens,
      },
      finishReason: "stop",
    };
  }

  if (target.provider === "azure") {
    const result = await generateAzureChat(target.modelId, request.messages, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat,
      customParams: request.customParams,
    });

    return {
      modality: "text",
      content: result.text,
      usage: result.usage || {
        promptTokens: 0,
        completionTokens: estimateTokens(result.text),
        totalTokens: estimateTokens(result.text),
      },
      finishReason: result.finishReason || "stop",
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  }

  if (target.provider === "alibaba") {
    const result = await generateAlibabaChat(target.modelId, request.messages, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat,
      customParams: request.customParams,
    });

    return {
      modality: "text",
      content: result.text,
      usage: result.usage || {
        promptTokens: 0,
        completionTokens: estimateTokens(result.text),
        totalTokens: estimateTokens(result.text),
      },
      finishReason: result.finishReason || "stop",
    };
  }

  if (target.provider === "cloudflare" && operation(request) === "translation") {
    const result = await translateCloudflareText(target.modelId, getPrimaryText(request.messages), request.customParams);
    const promptTokens = estimateTokens(getPrimaryText(request.messages));
    const completionTokens = estimateTokens(result.text);
    return {
      modality: "text",
      content: result.text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: "stop",
    };
  }

  if (target.provider === "cloudflare" && operation(request) === "rerank") {
    const custom = request.customParams || {};
    const documents = Array.isArray(custom.documents)
      ? custom.documents
      : Array.isArray(custom.contexts)
        ? custom.contexts
        : [];
    const result = await rerankCloudflareText(
      target.modelId,
      typeof custom.query === "string" ? custom.query : getPrimaryText(request.messages),
      documents as Array<string | Record<string, unknown>>,
      custom,
    );
    return {
      modality: "text",
      content: result.text,
      usage: result.usage,
      finishReason: "stop",
    };
  }

  if (target.provider === "cloudflare" && isImageAnalysisOperation(request)) {
    const imageBuffer = await fetchRemoteBuffer(findUrl(request.messages, "image_url"), target.signal);
    if (!imageBuffer) {
      throw new Error("Cloudflare vision requires an image input");
    }

    const result = await analyzeCloudflareVision(
      target.modelId,
      imageBuffer,
      getPrimaryText(request.messages),
      request.customParams,
    );
    const promptTokens = estimateTokens(getPrimaryText(request.messages));
    const completionTokens = estimateTokens(result.text);
    return {
      modality: "text",
      content: result.text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        billingMetrics: { request: 1 },
      },
      media: {
        mimeType: "application/json",
        billingMetrics: { request: 1 },
      },
      finishReason: "stop",
    };
  }

  // Gemini chat: direct against the Google Generative Language wire family.
  if (target.provider === "gemini") {
    const result = await googleFamily.chat(googleFamily.geminiEndpoint(), target.modelId, request.messages, {
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      thoughtSignatureLookup: recallThoughtSignature,
      onThoughtSignature: rememberThoughtSignature,
      customParams: request.customParams,
      signal: target.signal,
    });
    return result;
  }

  // OpenAI Chat Completions wire family fall-through (openai, cloudflare,
  // fireworks, asicloud, hugging face router).
  const endpoint = openaiCompatEndpointFor(target.provider);
  if (useOpenAIResponsesWire(request, target)) {
    return openaiFamily.responses(endpoint, target.modelId, openaiFamily.mapMessagesForResponsesWire(request.messages), {
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      customParams: request.customParams,
      signal: target.signal,
    });
  }
  return openaiFamily.chat(endpoint, target.modelId, request.messages, {
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(target.provider === "openai" ? { maxTokensField: "max_completion_tokens" as const } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
    customParams: request.customParams,
    signal: target.signal,
  });
}

async function invokeEmbedding(request: Request, target: AdapterTarget): Promise<Output> {
  const values = embeddingInputValues(request);
  const estimatedUsage = estimatedEmbeddingUsage(values);

  if (target.provider === "roboflow") {
    const imageBuffer = await fetchRemoteBuffer(findUrl(request.messages, "image_url"), target.signal);
    const result = await generateRoboflowEmbeddings({
      modelId: target.modelId,
      text: values.join("\n"),
      ...(imageBuffer ? { imageBuffer } : {}),
      customParams: request.customParams,
    });
    return {
      modality: "embedding",
      embeddings: result.embeddings,
      usage: {
        ...estimatedUsage,
        billingMetrics: {
          ...(estimatedUsage.billingMetrics || {}),
          ...result.billingMetrics,
        },
      },
    };
  }

  if (target.provider === "vertex") {
    const result = await generateVertexEmbeddings(target.modelId, values);
    return {
      modality: "embedding",
      embeddings: result.embeddings,
      usage: estimatedUsage,
    };
  }

  if (target.provider === "hugging face") {
    const card = getModelById(target.modelId, target.provider);
    const result = await executeHFInference({
      modelId: target.modelId,
      task: "feature-extraction",
      text: values.length === 1 ? values[0] : values,
      inferenceProvider: card?.hfInferenceProvider,
    });
    const embeddings = normalizeFeatureExtractionEmbeddings(result.data);
    return {
      modality: "embedding",
      embeddings,
      usage: estimatedUsage,
    };
  }

  if (target.provider === "azure") {
    const result = await generateAzureEmbeddings(target.modelId, values);
    return {
      modality: "embedding",
      embeddings: result.embeddings,
      usage: result.usage || estimatedUsage,
    };
  }

  if (target.provider === "alibaba") {
    const result = await generateAlibabaEmbeddings(target.modelId, values);
    return {
      modality: "embedding",
      embeddings: result.embeddings,
      usage: result.usage || estimatedUsage,
    };
  }

  // Gemini embeddings: direct against the Google embedContent / batchEmbedContents wire.
  if (target.provider === "gemini") {
    const contents = await googleFamily.embeddingContentsFromMessages(request.messages, values);
    const result = await googleFamily.embeddings(googleFamily.geminiEndpoint(), target.modelId, values, {
      contents,
      signal: target.signal,
    });
    return {
      modality: "embedding",
      embeddings: result.embeddings,
      usage: result.usage || estimatedUsage,
    };
  }

  // OpenAI Chat Completions wire family fall-through (openai, cloudflare,
  // fireworks, asicloud, hugging face router).
  const endpoint = openaiCompatEndpointFor(target.provider);
  const result = await openaiFamily.embeddings(endpoint, target.modelId, values, {
    customParams: request.customParams,
    signal: target.signal,
  });

  return {
    modality: "embedding",
    embeddings: result.embeddings,
    usage: result.usage || estimatedUsage,
  };
}

async function invokeImage(request: Request, target: AdapterTarget): Promise<Output> {
  const prompt = getPrimaryText(request.messages);
  const imageUrl = request.imageOptions?.imageUrl || findUrl(request.messages, "image_url");
  const card = getModelById(target.modelId, target.provider);
  const customParams = request.customParams || {};
  const imageCount = generatedImageCount(request);

  if (target.provider === "roboflow" && isImageAnalysisOperation(request)) {
    const imageBuffer = await fetchRemoteBuffer(imageUrl, target.signal);
    if (!imageBuffer) {
      throw new Error("Roboflow image analysis requires an image input");
    }

    const result = await analyzeRoboflowImage({
      modelId: target.modelId,
      imageBuffer,
      prompt,
      customParams,
    });
    const completionTokens = estimateTokens(result.text);
    const promptTokens = estimateTokens(prompt);
    return {
      modality: "text",
      content: result.text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        billingMetrics: result.billingMetrics,
      },
      media: {
        mimeType: "application/json",
        duration: result.billableSeconds,
        billingMetrics: result.billingMetrics,
      },
      finishReason: "stop",
    };
  }

  if (target.provider === "cloudflare" && isImageAnalysisOperation(request)) {
    const imageBuffer = await fetchRemoteBuffer(imageUrl, target.signal);
    if (!imageBuffer) {
      throw new Error("Cloudflare image analysis requires an image input");
    }

    const result = await analyzeCloudflareImage(target.modelId, imageBuffer);
    return {
      modality: "text",
      content: result.text,
      usage: {
        promptTokens: 0,
        completionTokens: estimateTokens(result.text),
        totalTokens: estimateTokens(result.text),
        billingMetrics: { request: 1 },
      },
      media: {
        mimeType: "application/json",
        billingMetrics: { request: 1 },
      },
      finishReason: "stop",
    };
  }

  const startedAt = performance.now();
  const output = await withRetry(async (): Promise<{
    buffer: Buffer;
    mimeType: string;
    usage?: Usage;
    duration?: number;
    billingMetrics?: Record<string, unknown>;
  }> => {
    switch (target.provider) {
      case "gemini": {
        const result = await googleGenerateImage(target.modelId, prompt, {
          numberOfImages: request.imageOptions?.n,
          aspectRatio: request.customParams?.aspect_ratio as "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | undefined,
          outputMimeType: request.customParams?.output_mime_type as "image/png" | "image/jpeg" | "image/webp" | undefined,
        });
        return {
          buffer: result.buffer,
          mimeType: "image/png",
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      case "openai": {
        const result = await openaiGenerateImage(target.modelId, prompt, {
          size: request.imageOptions?.size as any,
          quality: request.imageOptions?.quality as any,
          n: request.imageOptions?.n,
          imageUrl,
          signal: target.signal,
        });
        return {
          buffer: result.buffer,
          mimeType: result.mimeType,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      case "vertex": {
        const result = await generateVertexImage(target.modelId, prompt, {
          size: request.imageOptions?.size,
          n: request.imageOptions?.n,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      case "azure": {
        const result = await generateAzureImage(target.modelId, prompt, {
          size: request.imageOptions?.size,
          quality: request.imageOptions?.quality,
          n: request.imageOptions?.n,
          imageUrl,
          customParams,
        });
        return {
          buffer: result.buffer,
          mimeType: result.mimeType,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      case "alibaba": {
        const result = await generateAlibabaImage(target.modelId, prompt, {
          size: request.imageOptions?.size,
          quality: request.imageOptions?.quality,
          n: request.imageOptions?.n,
          imageUrl,
          customParams,
        });
        return {
          buffer: result.buffer,
          mimeType: result.mimeType,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      case "hugging face": {
        const imageBuffer = await fetchRemoteBuffer(imageUrl, target.signal);
        const input: HFInferenceInput = {
          modelId: target.modelId,
          task: selectImageTaskForInput(imageUrl),
          prompt,
          ...(imageBuffer ? { image: imageBuffer.toString("base64") } : {}),
          parameters: customParams,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(input);
        return { buffer: result.data as Buffer, mimeType: "image/png" };
      }
      case "fireworks": {
        const steps = typeof request.customParams?.steps === "number"
          ? request.customParams.steps
          : typeof request.customParams?.num_steps === "number"
            ? request.customParams.num_steps
            : typeof request.customParams?.num_inference_steps === "number"
              ? request.customParams.num_inference_steps
              : 4;
        const result = await generateFireworksImage(target.modelId, prompt, {
          parameters: request.customParams,
          steps,
          guidanceScale: typeof request.customParams?.guidance_scale === "number"
            ? request.customParams.guidance_scale
            : typeof request.customParams?.guidance === "number"
              ? request.customParams.guidance
              : undefined,
          width: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[0]) : undefined,
          height: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[1]) : undefined,
        });
        return {
          buffer: result.buffer,
          mimeType: result.mimeType,
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            billingMetrics: { step: steps },
          },
        };
      }
      case "cloudflare": {
        const steps = typeof request.customParams?.num_steps === "number"
          ? request.customParams.num_steps
          : typeof request.customParams?.steps === "number"
            ? request.customParams.steps
            : 4;
        const result = await generateCloudflareImage(target.modelId, prompt, {
          parameters: request.customParams,
          num_steps: steps,
          guidance: typeof request.customParams?.guidance === "number"
            ? request.customParams.guidance
            : typeof request.customParams?.guidance_scale === "number"
              ? request.customParams.guidance_scale
              : undefined,
          width: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[0]) : undefined,
          height: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[1]) : undefined,
          signal: target.signal,
        });
        return {
          buffer: result.buffer,
          mimeType: result.mimeType,
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            billingMetrics: { step: steps },
          },
        };
      }
      default:
        throw new Error(`Image generation not supported for provider: ${target.provider}`);
    }
  }, 3, target.signal);
  const elapsedSeconds = elapsedSecondsSince(startedAt);

  return {
    modality: "image",
    media: {
      mimeType: output.mimeType,
      base64: output.buffer.toString("base64"),
      generatedUnits: imageCount,
      status: "completed",
      billingMetrics: imageBillingMetricsFromOutput({
        request,
        buffer: output.buffer,
        usage: output.usage,
        generatedUnits: imageCount,
        elapsedSeconds,
      }),
    },
    usage: output.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function submitVideoJob(target: AdapterTarget, prompt: string, options?: {
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  size?: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  customParams?: Record<string, unknown>;
}): Promise<{ jobId: string; status: "queued" | "processing"; duration?: number; usage?: Usage }> {
  switch (target.provider) {
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
        body: JSON.stringify(buildOpenAIVideoSubmissionBody(target.modelId, prompt, options)),
      });

      if (!response.ok) {
        throw new Error(`OpenAI video submission failed: ${response.status} - ${await response.text()}`);
      }

      const data = (await response.json()) as { id?: string; status?: string; seconds?: string | number };
      if (!data.id) {
        throw new Error("OpenAI returned no job id");
      }

      const duration = findProviderDurationSeconds(data);
      return {
        jobId: `openai:${data.id}`,
        status: data.status === "queued" ? "queued" : "processing",
        ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      };
    }

    case "gemini": {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
      }

      const genai = new GoogleGenAI({ apiKey });
      const imageBuffer = await fetchRemoteBuffer(options?.imageUrl, target.signal);
      const operation = await genai.models.generateVideos(buildGoogleVideoGenerationRequest(
        target.modelId,
        prompt,
        options,
        imageBuffer ? { imageBytes: imageBuffer.toString("base64"), mimeType: "image/png" } : undefined,
      ) as any);
      if (!operation.name) {
        throw new Error("Google returned no operation name");
      }

      const duration = findProviderDurationSeconds(operation);
      return {
        jobId: `gemini:${operation.name}`,
        status: "processing",
        ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
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

      const normalizedModel = target.modelId.includes("/") ? target.modelId.split("/").pop() : target.modelId;
      const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${normalizedModel}:predictLongRunning`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: buildVertexVideoParameters(options),
        }),
      });

      if (!response.ok) {
        throw new Error(`Vertex video submission failed: ${response.status} - ${await response.text()}`);
      }

      const data = (await response.json()) as { name?: string };
      if (!data.name) {
        throw new Error("Vertex returned no operation name");
      }

      const duration = findProviderDurationSeconds(data);
      return {
        jobId: `vertex:${data.name}`,
        status: "processing",
        ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      };
    }

    case "alibaba": {
      return submitAlibabaVideo(target.modelId, prompt, {
        duration: options?.duration,
        aspectRatio: options?.aspectRatio,
        resolution: options?.resolution,
        size: options?.size,
        imageUrl: options?.imageUrl,
        imageUrls: options?.imageUrls,
        videoUrl: options?.videoUrl,
        customParams: options?.customParams,
      });
    }

    default:
      throw new Error(`Async video generation not supported for provider: ${target.provider}`);
  }
}

async function invokeVideo(request: Request, target: AdapterTarget): Promise<Output> {
  const prompt = getPrimaryText(request.messages);
  const imageUrl = request.videoOptions?.imageUrl || findUrl(request.messages, "image_url");
  const imageUrls = findUrls(request.messages, "image_url");
  const videoUrl = request.videoOptions?.videoUrl || findUrl(request.messages, "video_url");
  const card = getModelById(target.modelId, target.provider);
  const customParams = request.customParams || {};

  if (["openai", "gemini", "vertex", "alibaba", "azure", "fireworks", "fal", "huggingface"].includes(target.provider)) {
    const job = await submitVideoJob(target, prompt, {
      duration: request.videoOptions?.duration,
      aspectRatio: request.videoOptions?.aspectRatio,
      resolution: request.videoOptions?.resolution,
      size: typeof request.customParams?.size === "string" ? request.customParams.size : undefined,
      imageUrl,
      imageUrls: request.videoOptions?.imageUrl ? [request.videoOptions.imageUrl, ...imageUrls.filter((url) => url !== request.videoOptions?.imageUrl)] : imageUrls,
      videoUrl,
      customParams,
    });

    return {
      modality: "video",
      media: {
        mimeType: "video/mp4",
        jobId: job.jobId,
        status: job.status,
        progress: job.status === "queued" ? 0 : 1,
        duration: request.videoOptions?.duration ?? job.duration,
        generatedUnits: 1,
        billingMetrics: {
          ...(request.billingMetrics || {}),
          ...(job.usage?.billingMetrics || {}),
          ...(typeof job.duration === "number" && job.duration > 0 ? {
            second: job.duration,
            duration: job.duration,
            minute: job.duration / 60,
          } : {}),
        },
      },
      usage: job.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  const output = await withRetry(async () => {
    switch (target.provider) {
      case "gemini": {
        const result = await googleGenerateVideo(target.modelId, prompt, {
          duration: request.videoOptions?.duration,
          aspectRatio: request.videoOptions?.aspectRatio as "16:9" | "9:16" | undefined,
          resolution: request.videoOptions?.resolution as "720p" | "1080p" | undefined,
          negativePrompt: typeof request.customParams?.negative_prompt === "string" ? request.customParams.negative_prompt : undefined,
        });
        return { buffer: result.videoBuffer, mimeType: result.mimeType };
      }
      case "openai": {
        const result = await openaiGenerateVideo(target.modelId, prompt, {
          duration: request.videoOptions?.duration,
          size: typeof request.customParams?.size === "string" ? request.customParams.size : undefined,
          imageUrl,
        });
        return { buffer: result.videoBuffer, mimeType: result.mimeType };
      }
      case "vertex": {
        const result = await generateVertexVideo(target.modelId, prompt, {
          duration: request.videoOptions?.duration,
          aspectRatio: request.videoOptions?.aspectRatio,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      case "hugging face": {
        const imageBuffer = await fetchRemoteBuffer(imageUrl, target.signal);
        const input: HFInferenceInput = {
          modelId: target.modelId,
          task: selectVideoTaskForInput(imageUrl),
          prompt,
          ...(imageBuffer ? { image: imageBuffer.toString("base64") } : {}),
          parameters: customParams,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(input);
        return { buffer: result.data as Buffer, mimeType: "video/mp4" };
      }
      default:
        throw new Error(`Video generation not supported for provider: ${target.provider}`);
    }
  }, 3, target.signal);

  return {
    modality: "video",
    media: {
      mimeType: output.mimeType,
      base64: output.buffer.toString("base64"),
      status: "completed",
      duration: request.videoOptions?.duration,
      generatedUnits: 1,
      billingMetrics: videoBillingMetricsFromOutput({
        request,
        buffer: output.buffer,
        generatedUnits: 1,
      }),
    },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function invokeAudio(request: Request, target: AdapterTarget): Promise<Output> {
  const prompt = getPrimaryText(request.messages);
  const card = getModelById(target.modelId, target.provider);
  const promptCharacterCount = prompt ? Array.from(prompt).length : 0;

  if (isSpeechToTextOperation(request)) {
    return transcribe(request, target);
  }

  if (operation(request) === "voice-activity-detection" && target.provider === "cloudflare") {
    const audioUrl = findUrl(request.messages, "input_audio");
    const audioMedia = await fetchRemoteMedia(audioUrl, target.signal);
    if (!audioMedia) {
      throw new Error("Cloudflare voice activity detection requires an audio input");
    }
    const result = await detectCloudflareTurn(target.modelId, audioMedia.buffer, {
      customParams: request.customParams,
    });
    const content = JSON.stringify({
      is_complete: result.isComplete,
      probability: result.probability,
    });
    const duration = audioDurationSeconds(audioMedia.buffer, audioMedia.mimeType);
    const billingMetrics = typeof duration === "number" && duration > 0
      ? {
        second: duration,
        audio_second: duration,
        minute: duration / 60,
        audio_minute: duration / 60,
      }
      : { request: 1 };
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    return {
      modality: "text",
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        billingMetrics,
        ...(asRecord(result.raw) ? { raw: asRecord(result.raw) as Record<string, unknown> } : {}),
      },
      finishReason: "stop",
    };
  }

  if (!isTextToAudioOperation(request)) {
    throw new Error(`Audio operation is not supported: ${operation(request) || "unknown"}`);
  }

  const output = await withRetry(async (): Promise<{
    buffer: Buffer;
    mimeType: string;
    usage?: Usage;
    duration?: number;
    billingMetrics?: Record<string, unknown>;
  }> => {
    switch (target.provider) {
      case "openai":
        return {
          buffer: await openaiGenerateSpeech(target.modelId, prompt, {
            voice: request.audioOptions?.voice as any,
            speed: request.audioOptions?.speed,
            responseFormat: request.audioOptions?.responseFormat as any,
          }),
          mimeType: speechMimeType(request.audioOptions?.responseFormat),
        };
      case "gemini":
        {
          const imageBuffer = await fetchRemoteBuffer(findUrl(request.messages, "image_url"), target.signal);
          if (operation(request) === "text-to-audio" || operation(request) === "music-generation" || hasType(card, "music-generation") || hasType(card, "text-to-audio")) {
            const result = await googleGenerateMusic(target.modelId, prompt, imageBuffer ? { image: imageBuffer } : undefined);
            return {
              buffer: result.buffer,
              ...(result.usage ? { usage: result.usage } : {}),
              mimeType: result.mimeType,
            };
          }
          const result = await googleGenerateSpeech(target.modelId, prompt);
          return {
            buffer: result.buffer,
            ...(result.usage ? { usage: result.usage } : {}),
            mimeType: speechMimeType(request.audioOptions?.responseFormat, "audio/wav"),
          };
        }
      case "vertex": {
        const result = await generateVertexSpeech(target.modelId, prompt, {
          voice: request.audioOptions?.voice as any,
          language: request.audioOptions?.language,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      case "hugging face": {
        const payload: HFInferenceInput = {
          modelId: target.modelId,
          task: "text-to-speech",
          text: prompt,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(payload);
        return {
          buffer: result.data as Buffer,
          mimeType: speechMimeType(request.audioOptions?.responseFormat, "audio/wav"),
        };
      }
      case "cloudflare":
        {
          const speech = await generateCloudflareSpeech(target.modelId, prompt, request.customParams);
          const buffer = speech.buffer;
          const mimeType = speech.mimeType || speechMimeType(request.audioOptions?.responseFormat);
          const duration = audioDurationSeconds(buffer, mimeType);
          return {
            buffer,
            mimeType,
            ...(typeof duration === "number" && duration > 0
              ? {
                duration,
                billingMetrics: {
                  second: duration,
                  duration,
                  minute: duration / 60,
                  audio_second: duration,
                  audio_minute: duration / 60,
                  generated_audio_second: duration,
                  generated_audio_minute: duration / 60,
                },
              }
              : {}),
          };
        }
      case "deepgram":
        return generateDeepgramSpeech(target.modelId, prompt, {
          voice: request.audioOptions?.voice,
          responseFormat: request.audioOptions?.responseFormat,
        });
      case "elevenlabs":
        if (operation(request) === "speech-to-speech") {
          const audioBuffer = await fetchRemoteBuffer(findUrl(request.messages, "input_audio"), target.signal);
          if (!audioBuffer) {
            throw new Error("ElevenLabs speech-to-speech requires an audio input");
          }
          return generateElevenLabsSpeechToSpeech(target.modelId, audioBuffer, {
            voiceId: request.audioOptions?.voice,
            responseFormat: request.audioOptions?.responseFormat,
          });
        }
        if (operation(request) === "music-generation" || hasType(card, "music-generation")) {
          return generateElevenLabsMusic(target.modelId, prompt, {
            compositionPlan: request.customParams?.composition_plan && typeof request.customParams.composition_plan === "object"
              ? request.customParams.composition_plan as Record<string, unknown>
              : undefined,
            musicLengthMs: number(request.customParams?.music_length_ms) ?? number(request.billingMetrics?.music_length_ms),
            outputFormat: typeof request.customParams?.output_format === "string"
              ? request.customParams.output_format as any
              : undefined,
          });
        }
        if (operation(request) === "text-to-audio" || hasType(card, "text-to-audio")) {
          return generateElevenLabsSound(prompt, {
            durationSeconds: typeof request.customParams?.duration_seconds === "number"
              ? request.customParams.duration_seconds
              : typeof request.customParams?.duration === "number"
                ? request.customParams.duration
                : undefined,
            promptInfluence: typeof request.customParams?.prompt_influence === "number"
              ? request.customParams.prompt_influence
              : undefined,
            loop: typeof request.customParams?.loop === "boolean" ? request.customParams.loop : undefined,
          });
        }
        return generateElevenLabsSpeech(target.modelId, prompt, {
          voiceId: request.audioOptions?.voice,
          responseFormat: request.audioOptions?.responseFormat,
          speed: request.audioOptions?.speed,
        });
      case "cartesia":
        return generateCartesiaSpeech(target.modelId, prompt, {
          voiceId: request.audioOptions?.voice,
          responseFormat: request.audioOptions?.responseFormat,
          speed: request.audioOptions?.speed,
        });
      case "alibaba":
        return generateAlibabaSpeech(target.modelId, prompt, {
          voice: request.audioOptions?.voice,
          responseFormat: request.audioOptions?.responseFormat,
          speed: request.audioOptions?.speed,
          customParams: request.customParams,
        });
      default:
        throw new Error(`Text-to-speech not supported for provider: ${target.provider}`);
    }
  }, 3, target.signal);
  const promptTokens = prompt ? estimateTokens(prompt) : 0;
  const usage = output.usage || {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    ...(promptTokens > 0
      ? {
        billingMetrics: {
          input_text_tokens: promptTokens,
        },
      }
      : {}),
  };

  return {
    modality: "audio",
    media: {
      mimeType: output.mimeType,
      base64: output.buffer.toString("base64"),
      status: "completed",
      ...(typeof output.duration === "number" ? { duration: output.duration } : {}),
      ...((request.billingMetrics || usage.billingMetrics || output.billingMetrics || promptCharacterCount > 0)
        ? {
          billingMetrics: {
            ...(request.billingMetrics || {}),
            ...(usage.billingMetrics || {}),
            ...(output.billingMetrics || {}),
            ...(promptCharacterCount > 0 ? { character: promptCharacterCount } : {}),
          },
        }
        : {}),
    },
    usage,
  };
}

async function* streamFinalImageFromInvoke(
  request: Request,
  target: AdapterTarget,
): AsyncGenerator<Event> {
  const output = await invokeImage(request, target);
  yield {
    type: "image-complete",
    image: {
      base64: output.media?.base64 || "",
      mimeType: output.media?.mimeType,
      ...(typeof output.media?.generatedUnits === "number" ? { generatedUnits: output.media.generatedUnits } : {}),
      ...(typeof output.media?.duration === "number" ? { duration: output.media.duration } : {}),
      ...(output.media?.billingMetrics ? { billingMetrics: output.media.billingMetrics } : {}),
    },
    ...(output.usage ? { usage: output.usage } : {}),
  };
  yield {
    type: "done",
    finishReason: output.finishReason || "stop",
    ...(output.usage ? { usage: output.usage } : { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
  };
}

/**
 * Canonical non-streaming entry point.
 *
 * Asks the model and returns the model's reply, including any
 * canonical `tool-call` entries on `output.toolCalls`. The caller is
 * responsible for executing tools and feeding results back via a
 * follow-up call.
 *
 * Non-execution guarantee: even when a passed-in tool descriptor
 * carries an `execute` function, this helper does NOT invoke it.
 */
export async function generateWithTools(request: Request, target: AdapterTarget): Promise<AdapterResult> {
  if (request.modality === "realtime") {
    throw new Error("Realtime models require a realtime WebSocket session.");
  }

  switch (request.modality) {
    case "embedding": {
      const output = await invokeEmbedding(request, target);
      return { output };
    }
    case "image": {
      const output = await invokeImage(request, target);
      return { output };
    }
    case "audio": {
      const output = await invokeAudio(request, target);
      return { output };
    }
    case "video": {
      const output = await invokeVideo(request, target);
      return { output };
    }
    default: {
      const output = await invokeText(request, target);
      return { output };
    }
  }
}

/**
 * Canonical streaming entry point.
 *
 * Streams the model's reply as a sequence of `Event`s.
 * When the model decides to call a tool, a `tool-call` event is
 * emitted. The caller is responsible for tool execution and the
 * follow-up turn.
 *
 * Non-execution guarantee: even when a passed-in tool descriptor
 * carries an `execute` function, this helper does NOT invoke it.
 */
export async function* streamWithTools(
  request: Request,
  target: AdapterTarget,
): AsyncGenerator<Event> {
  if (request.modality === "realtime") {
    throw new Error("Realtime models require a realtime WebSocket session.");
  }

  if (request.modality === "image") {
    // Provider-native partial-image streaming where available.
    if (target.provider === "openai") {
      const card = getModelById(target.modelId, target.provider);
      if (!supportsOpenAINativeImageStreaming(card)) {
        yield* streamFinalImageFromInvoke(request, target);
        return;
      }

      const prompt = getPrimaryText(request.messages);
      let lastUsage: Usage | undefined;
      const startedAt = performance.now();
      try {
        for await (const event of openaiStreamImage(target.modelId, prompt, {
          size: request.imageOptions?.size as any,
          quality: request.imageOptions?.quality as any,
          n: request.imageOptions?.n,
          partialImages: typeof request.customParams?.partial_images === "number"
            ? request.customParams.partial_images
            : typeof request.customParams?.partialImages === "number"
              ? request.customParams.partialImages
              : 2,
          signal: target.signal,
        })) {
          if (event.type === "image-partial") {
            yield {
              type: "image-partial",
              image: {
                base64: event.b64,
                index: event.index,
                mimeType: "image/png",
              },
            };
            continue;
          }

          const completionTokens = event.usage?.completionTokens ?? 0;
          const promptTokens = event.usage?.promptTokens ?? 0;
          lastUsage = event.usage ?? {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          };

          const imageBuffer = Buffer.from(event.b64, "base64");
          const generatedUnits = generatedImageCount(request);
          yield {
            type: "image-complete",
            image: {
              base64: event.b64,
              mimeType: "image/png",
              revisedPrompt: event.revisedPrompt,
              generatedUnits,
              billingMetrics: imageBillingMetricsFromOutput({
                request,
                buffer: imageBuffer,
                usage: lastUsage,
                generatedUnits,
                elapsedSeconds: elapsedSecondsSince(startedAt),
              }),
            },
            ...(lastUsage ? { usage: lastUsage } : {}),
          };
        }
      } catch (error) {
        if (isOpenAIImageStreamingUnsupportedError(error)) {
          yield* streamFinalImageFromInvoke(request, target);
          return;
        }
        throw error;
      }

      yield {
        type: "done",
        finishReason: "stop",
        ...(lastUsage ? { usage: lastUsage } : { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      };
      return;
    }

    if (target.provider === "gemini") {
      const prompt = getPrimaryText(request.messages);
      const imageUrl = request.imageOptions?.imageUrl || findUrl(request.messages, "image_url");
      const imageBuffer = await fetchRemoteBuffer(imageUrl, target.signal);
      const refs = imageBuffer ? [imageBuffer] : undefined;
      let lastUsage: Usage | undefined;
      const startedAt = performance.now();

      for await (const event of googleStreamImage(target.modelId, prompt, {
        referenceImages: refs,
        aspectRatio: request.customParams?.aspect_ratio as any,
        numberOfImages: request.imageOptions?.n,
        outputMimeType: request.customParams?.output_mime_type as any,
        includeThoughts: typeof request.customParams?.include_thoughts === "boolean"
          ? request.customParams.include_thoughts
          : typeof request.customParams?.includeThoughts === "boolean"
            ? request.customParams.includeThoughts
            : true,
        signal: target.signal,
      })) {
        if (event.type === "thinking") {
          yield { type: "thinking", thinking: event.text };
          continue;
        }
        if (event.type === "image-partial") {
          yield {
            type: "image-partial",
            image: {
              base64: event.base64,
              index: event.index,
              mimeType: event.mimeType || "image/png",
            },
          };
          continue;
        }
        lastUsage = event.usage
          ? {
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
            ...(event.usage.billingMetrics ? { billingMetrics: event.usage.billingMetrics } : {}),
          }
          : undefined;
        const finalImageBuffer = Buffer.from(event.base64, "base64");
        const generatedUnits = generatedImageCount(request);
        yield {
          type: "image-complete",
          image: {
            base64: event.base64,
            mimeType: event.mimeType || "image/png",
            generatedUnits,
            billingMetrics: imageBillingMetricsFromOutput({
              request,
              buffer: finalImageBuffer,
              usage: lastUsage,
              generatedUnits,
              elapsedSeconds: elapsedSecondsSince(startedAt),
            }),
          },
          ...(lastUsage ? { usage: lastUsage } : {}),
        };
      }

      yield {
        type: "done",
        finishReason: "stop",
        ...(lastUsage ? { usage: lastUsage } : { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      };
      return;
    }

    // Universal fallback: reuse the already-correct final image generation
    // path and simply surface its terminal image through the request stream
    // contract. No duplicated generation logic, no duplicated metering.
    yield* streamFinalImageFromInvoke(request, target);
    return;
  }

  if (request.modality !== "text") {
    throw new Error(`Streaming is only supported for text and image modalities. Requested: ${request.modality}`);
  }

  if (isSpeechToTextOperation(request)) {
    const output = await transcribe(request, target);
    if (output.content) {
      yield { type: "text-delta", text: output.content };
    }
    yield {
      type: "done",
      finishReason: output.finishReason || "stop",
      usage: output.usage || {
        promptTokens: 0,
        completionTokens: estimateTokens(output.content || ""),
        totalTokens: estimateTokens(output.content || ""),
      },
    };
    return;
  }

  if (target.provider === "roboflow") {
    const output = await invokeText(request, target);
    if (output.content) {
      yield { type: "text-delta", text: output.content };
    }
    yield {
      type: "done",
      finishReason: output.finishReason || "stop",
      usage: output.usage || {
        promptTokens: 0,
        completionTokens: estimateTokens(output.content || ""),
        totalTokens: estimateTokens(output.content || ""),
      },
    };
    return;
  }

  if (target.provider === "cloudflare" && operation(request) === "translation") {
    const output = await invokeText(request, target);
    if (output.content) {
      yield { type: "text-delta", text: output.content };
    }
    yield {
      type: "done",
      finishReason: output.finishReason || "stop",
      usage: output.usage || {
        promptTokens: estimateTokens(getPrimaryText(request.messages)),
        completionTokens: estimateTokens(output.content || ""),
        totalTokens: estimateTokens(getPrimaryText(request.messages)) + estimateTokens(output.content || ""),
      },
    };
    return;
  }

  if (target.provider === "cloudflare" && (operation(request) === "rerank" || isImageAnalysisOperation(request))) {
    const output = await invokeText(request, target);
    if (output.content) {
      yield { type: "text-delta", text: output.content };
    }
    yield {
      type: "done",
      finishReason: output.finishReason || "stop",
      usage: output.usage || {
        promptTokens: estimateTokens(getPrimaryText(request.messages)),
        completionTokens: estimateTokens(output.content || ""),
        totalTokens: estimateTokens(getPrimaryText(request.messages)) + estimateTokens(output.content || ""),
      },
    };
    return;
  }

  if (target.provider === "vertex") {
    const queue = new AsyncEventQueue<Event>();

    void (async () => {
      let fullText = "";
      try {
        await streamVertexChat(target.modelId, mapMessagesForVertex(request.messages), {
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          onToken: async (token) => {
            fullText += token;
            queue.push({ type: "text-delta", text: token });
          },
          onComplete: async () => {
            const completionTokens = estimateTokens(fullText);
            queue.push({
              type: "done",
              finishReason: "stop",
              usage: {
                promptTokens: 0,
                completionTokens,
                totalTokens: completionTokens,
              },
            });
            queue.end();
          },
          onError: async (error) => {
            queue.error(error);
          },
        });
      } catch (error) {
        queue.error(error);
      }
    })();

    for await (const event of queue) {
      yield event;
    }

    return;
  }

  if (target.provider === "azure") {
    const result = await generateAzureChat(target.modelId, request.messages, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat,
      customParams: request.customParams,
    });
    if (result.text) {
      yield { type: "text-delta", text: result.text };
    }
    let callIndex = 0;
    for (const call of result.toolCalls || []) {
      yield {
        type: "tool-call",
        toolCall: {
          id: call.id || `call_${callIndex}`,
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
          ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
        },
      };
      callIndex += 1;
    }
    yield {
      type: "done",
      finishReason: result.finishReason || "stop",
      usage: result.usage || {
        promptTokens: 0,
        completionTokens: estimateTokens(result.text),
        totalTokens: estimateTokens(result.text),
      },
    };
    return;
  }

  if (target.provider === "alibaba") {
    const result = await generateAlibabaChat(target.modelId, request.messages, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat,
      customParams: request.customParams,
    });
    if (result.text) {
      yield { type: "text-delta", text: result.text };
    }
    yield {
      type: "done",
      finishReason: result.finishReason || "stop",
      usage: result.usage || {
        promptTokens: 0,
        completionTokens: estimateTokens(result.text),
        totalTokens: estimateTokens(result.text),
      },
    };
    return;
  }

  // Gemini streaming chat: direct against the Google Generative Language wire
  // family. The thoughtSignature round-trip is wired through callbacks so the
  // adapter-level cache (rememberThoughtSignature / recallThoughtSignature)
  // remains the single source of truth across non-streaming + streaming calls.
  if (target.provider === "gemini") {
    for await (const event of googleFamily.streamChat(googleFamily.geminiEndpoint(), target.modelId, request.messages, {
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      thoughtSignatureLookup: recallThoughtSignature,
      onThoughtSignature: rememberThoughtSignature,
      customParams: request.customParams,
      signal: target.signal,
    })) {
      yield event;
    }
    return;
  }

  // OpenAI Chat Completions wire family streaming fall-through (openai,
  // cloudflare, fireworks, asicloud, hugging face router).
  const endpoint = openaiCompatEndpointFor(target.provider);
  if (useOpenAIResponsesWire(request, target)) {
    yield* openaiFamily.streamResponses(endpoint, target.modelId, openaiFamily.mapMessagesForResponsesWire(request.messages), {
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      customParams: request.customParams,
      signal: target.signal,
    });
    return;
  }
  for await (const event of openaiFamily.streamChat(endpoint, target.modelId, request.messages, {
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(target.provider === "openai" ? { maxTokensField: "max_completion_tokens" as const } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
    customParams: request.customParams,
    signal: target.signal,
  })) {
    yield event;
  }
}

/**
 * Polls a previously submitted async job (video / long-running media).
 *
 * Job IDs carry their provider as a `provider:job-id` prefix, parsed
 * by `parseAsyncVideoJobId`.
 */
export async function retrieveJob(jobId: string): Promise<AdapterStatus> {
  const { provider, providerJobId } = parseAsyncVideoJobId(jobId);

  switch (provider) {
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
        progress?: number;
        video?: { url?: string };
        output_url?: string;
        error?: string | { message?: string };
      };
      const status =
        data.status === "completed" || data.status === "success"
          ? "completed"
          : data.status === "failed"
            ? "failed"
            : data.status === "queued"
              ? "queued"
              : "processing";

      let url = data.video?.url || data.output_url;
      if (status === "completed" && !url) {
        const contentResponse = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(providerJobId)}/content`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!contentResponse.ok) {
          throw new Error(`OpenAI video download failed: ${contentResponse.status}`);
        }
        const contentType = contentResponse.headers.get("content-type") || "video/mp4";
        const buffer = Buffer.from(await contentResponse.arrayBuffer());
        url = `data:${contentType};base64,${buffer.toString("base64")}`;
      }

      const error = typeof data.error === "string" ? data.error : data.error?.message;

      return {
        status,
        url,
        error,
        progress: typeof data.progress === "number" ? data.progress : undefined,
      };
    }

    case "gemini": {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
      }

      const genai = new GoogleGenAI({ apiKey });
      const operation = new GenerateVideosOperation();
      operation.name = providerJobId;
      const updated = await genai.operations.getVideosOperation({ operation });

      if (!updated.done) {
        return { status: "processing" };
      }

      if (updated.error) {
        return { status: "failed", error: typeof updated.error.message === "string" ? updated.error.message : String(updated.error.message || "Google video generation failed") };
      }

      const video = updated.response?.generatedVideos?.[0]?.video as { uri?: string; videoBytes?: string; mimeType?: string } | undefined;
      const url = video?.videoBytes
        ? `data:${video.mimeType || "video/mp4"};base64,${video.videoBytes}`
        : video?.uri
          ? await downloadGoogleFileDataUrl(video.uri, apiKey)
          : undefined;
      return { status: "completed", url };
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
        return { status: "processing" };
      }

      if (operation.error) {
        return { status: "failed", error: operation.error.message };
      }

      const base64 = operation.response?.predictions?.[0]?.bytesBase64Encoded;
      if (!base64) {
        return { status: "completed" };
      }

      return {
        status: "completed",
        url: `data:video/mp4;base64,${base64}`,
      };
    }

    case "alibaba":
      return retrieveAlibabaVideo(providerJobId);

    default:
      throw new Error(`Unsupported async status provider: ${provider}`);
  }
}

export async function downloadGoogleFileDataUrl(uri: string, apiKey: string): Promise<string> {
  const response = await fetch(uri, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`Google video download failed: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "video/mp4";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

/**
 * Cancels a previously submitted async job. Provider-side cancellation
 * is not yet implemented for any provider, so this currently only
 * returns a sentinel and the gateway marks the local record cancelled.
 */
export async function cancelJob(_jobId: string): Promise<{ cancelled: boolean; message?: string }> {
  return {
    cancelled: false,
    message: "Underlying provider cancel is not available. Marking response as cancelled locally only.",
  };
}
