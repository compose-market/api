import { performance } from "node:perf_hooks";
import { embedMany, generateText, jsonSchema, streamText } from "ai";
import { GoogleGenAI } from "@google/genai";

import { getEmbeddingModel, getLanguageModel, getModelById } from "../models-registry.js";
import type { ModelProvider } from "../types.js";
import type {
  UnifiedMessage,
  UnifiedOutput,
  UnifiedRequest,
  UnifiedStreamEvent,
  UnifiedTool,
  UnifiedToolChoice,
  UnifiedUsage,
} from "../core.js";
import {
  generateImage as googleGenerateImage,
  streamImage as googleStreamImage,
  generateSpeech as googleGenerateSpeech,
  generateVideo as googleGenerateVideo,
} from "./genai.js";
import {
  openaiGenerateImage,
  openaiStreamImage,
  openaiGenerateSpeech,
  openaiGenerateVideo,
  openaiTranscribeAudio,
} from "./openai.js";
import {
  executeHFInference,
  type HFInferenceInput,
} from "./huggingface.js";
import {
  generateVertexChat,
  generateVertexEmbeddings,
  generateVertexImage,
  generateVertexSpeech,
  generateVertexVideo,
  streamVertexChat,
  transcribeVertexAudio,
} from "./vertex.js";
import {
  generateFireworksImage,
  transcribeFireworksAudio,
} from "./fireworks.js";
import {
  generateCloudflareImage,
  generateCloudflareSpeech,
  transcribeCloudflareAudio,
} from "./cloudflare.js";
import {
  generateDeepgramSpeech,
  transcribeDeepgramAudio,
} from "./deepgram.js";
import { generateElevenLabsSpeech } from "./elevenlabs.js";
import { generateCartesiaSpeech } from "./cartesia.js";
import { analyzeRoboflowImage } from "./roboflow.js";

export interface AdapterTarget {
  modelId: string;
  provider: ModelProvider;
}

export interface AdapterResult {
  output: UnifiedOutput;
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

export function mapMessagesForAISDK(messages: UnifiedMessage[]): Array<{ role: string; content: unknown }> {
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
            toolName: message.name || "tool",
            output: normalizeToolOutput(normalizeContentToString(message.content)),
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
          input: args,
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

    return { role: message.role, content: normalizeContentToString(message.content) };
  });
}

function mapMessagesForVertex(messages: UnifiedMessage[]): Array<{ role: string; content: string | unknown[] }> {
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

function convertToolsForAISDK(tools: UnifiedTool[] | undefined) {
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
  toolChoice: UnifiedToolChoice | undefined,
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

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

function withRetry<T>(operation: () => Promise<T>, retries = 3): Promise<T> {
  return (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
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
  })();
}

function getPrimaryText(messages: UnifiedMessage[]): string {
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

function findUrl(messages: UnifiedMessage[], type: "image_url" | "input_audio" | "video_url"): string | undefined {
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

async function fetchRemoteBuffer(url?: string): Promise<Buffer | null> {
  if (!url) {
    return null;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media URL: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function usageFromResult(result: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): UnifiedUsage {
  return normalizeLanguageModelUsage(result);
}

type LanguageModelUsageLike = {
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

function extractUsageBillingMetrics(result: LanguageModelUsageLike): Record<string, unknown> | undefined {
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

export function normalizeLanguageModelUsage(result: LanguageModelUsageLike): UnifiedUsage {
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

function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const blockLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += blockLength + 2;
    }
  }

  return null;
}

function generatedImageCount(request: UnifiedRequest): number {
  return typeof request.imageOptions?.n === "number" && request.imageOptions.n > 0
    ? request.imageOptions.n
    : 1;
}

function elapsedSecondsSince(startedAt: number): number {
  const elapsed = (performance.now() - startedAt) / 1000;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0.000001;
}

function imageBillingMetricsFromOutput(args: {
  request: UnifiedRequest;
  buffer: Buffer;
  usage?: UnifiedUsage;
  generatedUnits: number;
  elapsedSeconds?: number;
}): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    ...(args.request.billingMetrics || {}),
  };

  if (typeof args.elapsedSeconds === "number" && Number.isFinite(args.elapsedSeconds) && args.elapsedSeconds > 0) {
    if (metrics.second === undefined) metrics.second = args.elapsedSeconds;
    if (metrics.duration === undefined) metrics.duration = args.elapsedSeconds;
    if (metrics.compute_second === undefined) metrics.compute_second = args.elapsedSeconds;
  }

  Object.assign(metrics, args.usage?.billingMetrics || {});

  const imageDimensions = readImageDimensions(args.buffer);
  if (imageDimensions) {
    const outputMegapixels = (imageDimensions.width * imageDimensions.height * args.generatedUnits) / 1_000_000;
    const outputPixels = imageDimensions.width * imageDimensions.height * args.generatedUnits;
    metrics.megapixel = outputMegapixels;
    if (metrics.processed_megapixel === undefined) metrics.processed_megapixel = outputMegapixels;
    if (metrics.pixel === undefined) metrics.pixel = outputPixels;
    if (metrics.processed_pixel === undefined) metrics.processed_pixel = outputPixels;
  }

  return metrics;
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

async function invokeText(request: UnifiedRequest, target: AdapterTarget): Promise<UnifiedOutput> {
  if (target.provider === "roboflow") {
    const prompt = getPrimaryText(request.messages);
    const imageUrl = findUrl(request.messages, "image_url");
    const imageBuffer = await fetchRemoteBuffer(imageUrl);

    if (!imageBuffer) {
      throw new Error("Roboflow text analysis requires an image input");
    }

    const result = await analyzeRoboflowImage({
      modelId: target.modelId,
      imageBuffer,
      prompt,
    });

    const completionTokens = estimateTokens(result.text);
    return {
      modality: "text",
      content: result.text,
      usage: {
        promptTokens: estimateTokens(prompt),
        completionTokens,
        totalTokens: estimateTokens(prompt) + completionTokens,
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

  const model = getLanguageModel(target.modelId, target.provider);
  const result = await generateText({
    model,
    messages: mapMessagesForAISDK(request.messages) as any,
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(request.tools ? { tools: convertToolsForAISDK(request.tools) } : {}),
    ...(request.toolChoice ? { toolChoice: convertToolChoice(request.toolChoice) } : {}),
  });

  return {
    modality: "text",
    content: result.text,
    usage: usageFromResult(result.usage || {}),
    finishReason: result.finishReason,
    toolCalls: result.toolCalls?.map((call, index) => ({
      id: (call as { toolCallId?: string }).toolCallId || `call_${index}`,
      name: (call as { toolName: string }).toolName,
      arguments: JSON.stringify((call as { args?: unknown }).args || {}),
    })),
  };
}

async function invokeEmbedding(request: UnifiedRequest, target: AdapterTarget): Promise<UnifiedOutput> {
  const values = Array.isArray(request.embeddingInput) ? request.embeddingInput : [request.embeddingInput || ""];

  if (target.provider === "vertex") {
    const result = await generateVertexEmbeddings(target.modelId, values);
    return {
      modality: "embedding",
      embeddings: result.embeddings,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  const model = getEmbeddingModel(target.modelId, target.provider);
  const result = await embedMany({ model, values });

  return {
    modality: "embedding",
    embeddings: result.embeddings,
    usage: {
      promptTokens: result.usage?.tokens ?? 0,
      completionTokens: 0,
      totalTokens: result.usage?.tokens ?? 0,
    },
  };
}

async function invokeImage(request: UnifiedRequest, target: AdapterTarget): Promise<UnifiedOutput> {
  const prompt = getPrimaryText(request.messages);
  const imageUrl = request.imageOptions?.imageUrl || findUrl(request.messages, "image_url");
  const card = getModelById(target.modelId);
  const customParams = request.customParams || {};
  const imageCount = generatedImageCount(request);

  const startedAt = performance.now();
  const output = await withRetry(async (): Promise<{
    buffer: Buffer;
    mimeType: string;
    usage?: UnifiedUsage;
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
      case "hugging face": {
        const input: HFInferenceInput = {
          modelId: target.modelId,
          task: "text-to-image",
          prompt,
          parameters: customParams,
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
            model: target.modelId,
            prompt,
            ...customParams,
            ...(request.imageOptions?.n !== undefined ? { n: request.imageOptions.n } : {}),
            ...(request.imageOptions?.size ? { size: request.imageOptions.size } : {}),
            ...(imageUrl ? { image_url: imageUrl } : {}),
          }),
        });

        if (!response.ok) {
          throw new Error(`AIML image generation failed: ${response.status} - ${await response.text()}`);
        }

        const data = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
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

        return { buffer: Buffer.from(await imageResponse.arrayBuffer()), mimeType: "image/png" };
      }
      case "fireworks": {
        const result = await generateFireworksImage(target.modelId, prompt, {
          parameters: request.customParams,
          steps: typeof request.customParams?.steps === "number"
            ? request.customParams.steps
            : typeof request.customParams?.num_steps === "number"
              ? request.customParams.num_steps
              : undefined,
          guidanceScale: typeof request.customParams?.guidance_scale === "number"
            ? request.customParams.guidance_scale
            : typeof request.customParams?.guidance === "number"
              ? request.customParams.guidance
              : undefined,
          width: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[0]) : undefined,
          height: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[1]) : undefined,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      case "cloudflare": {
        const result = await generateCloudflareImage(target.modelId, prompt, {
          parameters: request.customParams,
          num_steps: typeof request.customParams?.num_steps === "number"
            ? request.customParams.num_steps
            : typeof request.customParams?.steps === "number"
              ? request.customParams.steps
              : undefined,
          guidance: typeof request.customParams?.guidance === "number"
            ? request.customParams.guidance
            : typeof request.customParams?.guidance_scale === "number"
              ? request.customParams.guidance_scale
              : undefined,
          width: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[0]) : undefined,
          height: request.imageOptions?.size ? parseInt(request.imageOptions.size.split("x")[1]) : undefined,
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      }
      default:
        throw new Error(`Image generation not supported for provider: ${target.provider}`);
    }
  });
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
  customParams?: Record<string, unknown>;
}): Promise<{ jobId: string; status: "queued" | "processing" }> {
  const customParams = options?.customParams || {};

  switch (target.provider) {
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
          model: target.modelId,
          prompt,
          ...customParams,
          ...(options?.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
          ...(options?.duration ? { duration: String(options.duration) } : {}),
          ...(options?.resolution ? { resolution: options.resolution } : {}),
          ...(options?.size ? { size: options.size } : {}),
          ...(options?.imageUrl ? { image_url: options.imageUrl } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`AIML video submission failed: ${response.status} - ${await response.text()}`);
      }

      const data = (await response.json()) as { id?: string; status?: string };
      if (!data.id) {
        throw new Error("AIML returned no job id");
      }

      return { jobId: `aiml:${data.id}`, status: data.status === "queued" ? "queued" : "processing" };
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
          model: target.modelId,
          prompt,
          ...customParams,
          ...(options?.size ? { size: options.size } : {}),
          ...(options?.duration ? { seconds: String(options.duration) } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI video submission failed: ${response.status} - ${await response.text()}`);
      }

      const data = (await response.json()) as { id?: string; status?: string };
      if (!data.id) {
        throw new Error("OpenAI returned no job id");
      }

      return { jobId: `openai:${data.id}`, status: data.status === "queued" ? "queued" : "processing" };
    }

    case "gemini": {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
      }

      const genai = new GoogleGenAI({ apiKey }) as any;
      const operation = await genai.videos.generate({ model: target.modelId, prompt });
      if (!operation.name) {
        throw new Error("Google returned no operation name");
      }

      return { jobId: `google:${operation.name}`, status: "processing" };
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
          parameters: {
            ...customParams,
            ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
            ...(options?.duration ? { durationSeconds: options.duration } : {}),
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Vertex video submission failed: ${response.status} - ${await response.text()}`);
      }

      const data = (await response.json()) as { name?: string };
      if (!data.name) {
        throw new Error("Vertex returned no operation name");
      }

      return { jobId: `vertex:${data.name}`, status: "processing" };
    }

    default:
      throw new Error(`Async video generation not supported for provider: ${target.provider}`);
  }
}

async function invokeVideo(request: UnifiedRequest, target: AdapterTarget): Promise<UnifiedOutput> {
  const prompt = getPrimaryText(request.messages);
  const imageUrl = request.videoOptions?.imageUrl || findUrl(request.messages, "image_url");
  const card = getModelById(target.modelId);
  const customParams = request.customParams || {};

  if (["aiml", "openai", "gemini", "vertex"].includes(target.provider)) {
    const job = await submitVideoJob(target, prompt, {
      duration: request.videoOptions?.duration,
      aspectRatio: request.videoOptions?.aspectRatio,
      resolution: request.videoOptions?.resolution,
      size: typeof request.customParams?.size === "string" ? request.customParams.size : undefined,
      imageUrl,
      customParams,
    });

    return {
      modality: "video",
      media: {
        mimeType: "video/mp4",
        jobId: job.jobId,
        status: job.status,
        progress: job.status === "queued" ? 0 : 1,
        duration: request.videoOptions?.duration,
        generatedUnits: 1,
        billingMetrics: request.billingMetrics,
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
        const input: HFInferenceInput = {
          modelId: target.modelId,
          task: "text-to-video",
          prompt,
          parameters: customParams,
          inferenceProvider: card?.hfInferenceProvider,
        };
        const result = await executeHFInference(input);
        return { buffer: result.data as Buffer, mimeType: "video/mp4" };
      }
      default:
        throw new Error(`Video generation not supported for provider: ${target.provider}`);
    }
  });

  return {
    modality: "video",
    media: {
      mimeType: output.mimeType,
      base64: output.buffer.toString("base64"),
      status: "completed",
      duration: request.videoOptions?.duration,
      generatedUnits: 1,
      billingMetrics: request.billingMetrics,
    },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function invokeAudio(request: UnifiedRequest, target: AdapterTarget): Promise<UnifiedOutput> {
  const audioUrl = findUrl(request.messages, "input_audio");
  const prompt = getPrimaryText(request.messages);
  const card = getModelById(target.modelId);
  const promptCharacterCount = prompt ? Array.from(prompt).length : 0;

  if (audioUrl && !prompt) {
    const audioBuffer = await fetchRemoteBuffer(audioUrl);
    if (!audioBuffer) {
      throw new Error("No audio data available for transcription");
    }

    const asrResult = await withRetry(async () => {
      switch (target.provider) {
        case "openai":
          return openaiTranscribeAudio(target.modelId, audioBuffer, {
            language: request.audioOptions?.language,
            responseFormat: request.audioOptions?.responseFormat as any,
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
          return transcribeCloudflareAudio(target.modelId, audioBuffer);
        case "deepgram":
          return transcribeDeepgramAudio(target.modelId, audioBuffer, {
            language: request.audioOptions?.language,
          });
        default:
          throw new Error(`Speech-to-text not supported for provider: ${target.provider}`);
      }
    });

    const text = asrResult.text || "";
    return {
      modality: "audio",
      content: text,
      usage: {
        promptTokens: 0,
        completionTokens: estimateTokens(text),
        totalTokens: estimateTokens(text),
      },
      finishReason: "stop",
    };
  }

  const output = await withRetry(async (): Promise<{
    buffer: Buffer;
    mimeType: string;
    usage?: UnifiedUsage;
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
        return {
          buffer: await generateCloudflareSpeech(target.modelId, prompt),
          mimeType: speechMimeType(request.audioOptions?.responseFormat),
        };
      case "deepgram":
        return generateDeepgramSpeech(target.modelId, prompt, {
          voice: request.audioOptions?.voice,
          responseFormat: request.audioOptions?.responseFormat,
        });
      case "elevenlabs":
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
      default:
        throw new Error(`Text-to-speech not supported for provider: ${target.provider}`);
    }
  });

  return {
    modality: "audio",
    media: {
      mimeType: output.mimeType,
      base64: output.buffer.toString("base64"),
      status: "completed",
      ...((request.billingMetrics || output.usage?.billingMetrics || promptCharacterCount > 0)
        ? {
            billingMetrics: {
              ...(request.billingMetrics || {}),
              ...(output.usage?.billingMetrics || {}),
              ...(promptCharacterCount > 0 ? { character: promptCharacterCount } : {}),
            },
          }
        : {}),
    },
    usage: output.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

export async function invokeAdapter(request: UnifiedRequest, target: AdapterTarget): Promise<AdapterResult> {
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

export async function* streamAdapter(
  request: UnifiedRequest,
  target: AdapterTarget,
): AsyncGenerator<UnifiedStreamEvent> {
  if (request.modality === "image") {
    // Provider-native partial-image streaming where available.
    if (target.provider === "openai") {
      const prompt = getPrimaryText(request.messages);
      let lastUsage: UnifiedUsage | undefined;
      const startedAt = performance.now();
      for await (const event of openaiStreamImage(target.modelId, prompt, {
        size: request.imageOptions?.size as any,
        quality: request.imageOptions?.quality as any,
        n: request.imageOptions?.n,
        partialImages: typeof request.customParams?.partial_images === "number"
          ? request.customParams.partial_images
          : typeof request.customParams?.partialImages === "number"
            ? request.customParams.partialImages
            : 2,
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
      const imageBuffer = await fetchRemoteBuffer(imageUrl);
      const refs = imageBuffer ? [imageBuffer] : undefined;
      let lastUsage: UnifiedUsage | undefined;
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
    // path and simply surface its terminal image through the unified stream
    // contract. No duplicated generation logic, no duplicated metering.
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
    return;
  }

  if (request.modality !== "text") {
    throw new Error(`Streaming is only supported for text and image modalities. Requested: ${request.modality}`);
  }

  if (target.provider === "vertex") {
    const queue = new AsyncEventQueue<UnifiedStreamEvent>();

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

  const model = getLanguageModel(target.modelId, target.provider);
  const result = streamText({
    model,
    messages: mapMessagesForAISDK(request.messages) as any,
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(request.tools ? { tools: convertToolsForAISDK(request.tools) } : {}),
    ...(request.toolChoice ? { toolChoice: convertToolChoice(request.toolChoice) } : {}),
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      yield { type: "text-delta", text: (part as { text?: string }).text || "" };
      continue;
    }

    if (part.type === "tool-call") {
      const payload = part as { toolCallId?: string; toolName?: string; input?: unknown; args?: unknown };
      yield {
        type: "tool-call",
        toolCall: {
          id: payload.toolCallId || `call_${Date.now()}`,
          name: payload.toolName || "",
          arguments: JSON.stringify(payload.input ?? payload.args ?? {}),
        },
      };
      continue;
    }

    if (part.type === "error") {
      const payload = part as { error?: unknown };
      throw new Error(String(payload.error ?? "Unknown stream error"));
    }
  }

  const usage = await result.usage;
  yield {
    type: "done",
    finishReason: "stop",
    usage: usageFromResult(usage as any),
  };
}

export async function retrieveAdapter(jobId: string): Promise<AdapterStatus> {
  const [provider, providerJobId] = jobId.split(":");
  if (!provider || !providerJobId) {
    throw new Error(`Invalid async job id: ${jobId}`);
  }

  switch (provider) {
    case "aiml": {
      const apiKey = process.env.AI_ML_API_KEY;
      if (!apiKey) {
        throw new Error("AI_ML_API_KEY not configured");
      }

      const response = await fetch(`https://api.aimlapi.com/v2/video/generations?generation_id=${encodeURIComponent(providerJobId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

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

      const data = (await response.json()) as { status?: string; video?: { url?: string }; error?: string };
      const status =
        data.status === "completed" || data.status === "success"
          ? "completed"
          : data.status === "failed"
            ? "failed"
            : data.status === "queued"
              ? "queued"
              : "processing";

      return {
        status,
        url: data.video?.url,
        error: data.error,
      };
    }

    case "gemini": {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
      }

      const genai = new GoogleGenAI({ apiKey }) as any;
      const operation = await genai.operations.get({ operationName: providerJobId });

      if (!operation.done) {
        return { status: "processing" };
      }

      if (operation.error) {
        return { status: "failed", error: operation.error.message };
      }

      const url = operation.response?.videos?.[0]?.uri as string | undefined;
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

    default:
      throw new Error(`Unsupported async status provider: ${provider}`);
  }
}

export async function cancelAdapter(_jobId: string): Promise<{ cancelled: boolean; message?: string }> {
  return {
    cancelled: false,
    message: "Underlying provider cancel is not available. Marking response as cancelled locally only.",
  };
}
