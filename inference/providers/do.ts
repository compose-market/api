import { getModelById } from "../models-registry.js";
import type { UnifiedMessage, UnifiedToolCall, UnifiedUsage } from "../core.js";

const BASE_URL = "https://inference.do-ai.run";

type DORouteKind = "chat" | "messages" | "responses" | "embeddings" | "image" | "audio_speech" | "video";

interface DORouteMetadata {
  kind: DORouteKind;
  path: string;
  method: "GET" | "POST";
  statusPath?: string;
  contentPath?: string;
}

export interface DOChatResult {
  text: string;
  usage?: UnifiedUsage;
  finishReason?: string;
  toolCalls?: UnifiedToolCall[];
  raw: unknown;
}

export interface DOEmbeddingResult {
  embeddings: number[][];
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface DOImageResult {
  buffer: Buffer;
  mimeType: string;
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface DOSpeechResult {
  buffer: Buffer;
  mimeType: string;
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface DOVideoJobResult {
  jobId: string;
  status: "queued" | "processing";
  duration?: number;
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface DOVideoStatusResult {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  error?: string;
  progress?: number;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNumber(record: Record<string, unknown> | null | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function assignMetric(metrics: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    metrics[key] = value;
  }
}

function apiKey(): string {
  const key = process.env.DIGITAL_OCEAN_INFERENCE?.trim();
  if (!key) {
    throw new Error("DIGITAL_OCEAN_INFERENCE is not configured");
  }
  return key;
}

function digitalOceanRoute(modelId: string): DORouteMetadata {
  const card = getModelById(modelId, "digitalocean");
  const source = asRecord(card?.sourceMetadata);
  const digitalOcean = asRecord(source?.digitalOcean);
  const route = asRecord(digitalOcean?.route);
  const kind = clean(route?.kind) as DORouteKind;
  const path = clean(route?.path);
  const method = clean(route?.method).toUpperCase() === "GET" ? "GET" : "POST";

  if (!kind || !path) {
    throw new Error(`DigitalOcean route metadata is missing for model: ${modelId}`);
  }

  return {
    kind,
    path,
    method,
    ...(clean(route?.statusPath) ? { statusPath: clean(route?.statusPath) } : {}),
    ...(clean(route?.contentPath) ? { contentPath: clean(route?.contentPath) } : {}),
  };
}

function requireRoute(modelId: string, allowed: DORouteKind[]): DORouteMetadata {
  const route = digitalOceanRoute(modelId);
  if (!allowed.includes(route.kind)) {
    throw new Error(`DigitalOcean model ${modelId} is routed for ${route.kind}, not ${allowed.join("/")}`);
  }
  return route;
}

function doUrl(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`DigitalOcean returned non-JSON response: ${text.slice(0, 300)}`);
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(doUrl(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`DigitalOcean provider HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`);
  }

  return parseJsonResponse(response);
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(doUrl(path), {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`DigitalOcean provider HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`);
  }

  return parseJsonResponse(response);
}

function normalizeContentPart(part: unknown): Record<string, unknown> | null {
  const record = asRecord(part);
  if (!record) return null;
  const type = clean(record.type);

  if (type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }

  if (type === "image_url") {
    const image = record.image_url;
    const url = typeof image === "string" ? image : clean(asRecord(image)?.url);
    if (!url) return null;
    return { type: "image_url", image_url: { url, ...(clean(asRecord(image)?.detail) ? { detail: clean(asRecord(image)?.detail) } : {}) } };
  }

  if (type === "input_audio") {
    const audio = record.input_audio;
    const url = typeof audio === "string" ? audio : clean(asRecord(audio)?.url);
    if (!url) return null;
    return { type: "input_audio", input_audio: { url } };
  }

  return null;
}

function normalizeChatMessages(messages: UnifiedMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const content = Array.isArray(message.content)
      ? message.content.map(normalizeContentPart).filter(Boolean)
      : message.content;
    return {
      role: message.role,
      content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  });
}

function messageText(message: UnifiedMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function responsesInputFromMessages(messages: UnifiedMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role === "system" ? "developer" : message.role,
    content: messageText(message),
  }));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return clean(content);
  return content
    .map((part) => {
      const record = asRecord(part);
      return clean(record?.text) || clean(record?.value);
    })
    .filter(Boolean)
    .join("\n");
}

function textFromResponses(raw: unknown): string {
  const root = asRecord(raw);
  if (!root) return "";
  if (typeof root.output_text === "string") return root.output_text;
  const output = Array.isArray(root.output) ? root.output : [];
  return output.flatMap((item) => {
    const record = asRecord(item);
    const content = Array.isArray(record?.content) ? record.content : [];
    return content.map((part) => {
      const partRecord = asRecord(part);
      return clean(partRecord?.text) || clean(partRecord?.value);
    });
  }).filter(Boolean).join("\n");
}

function toolCallsFromChat(message: Record<string, unknown>): UnifiedToolCall[] | undefined {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const parsed = calls
    .map((call, index) => {
      const record = asRecord(call) || {};
      const fn = asRecord(record.function) || {};
      return {
        id: clean(record.id) || `call_${index}`,
        name: clean(fn.name),
        arguments: clean(fn.arguments) || "{}",
      };
    })
    .filter((call) => call.name);
  return parsed.length > 0 ? parsed : undefined;
}

function chatResult(raw: unknown): DOChatResult {
  const root = asRecord(raw) || {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  return {
    text: textFromContent(message.content),
    usage: usageFromDO(root.usage, "chat"),
    finishReason: clean(first.finish_reason) || undefined,
    toolCalls: toolCallsFromChat(message),
    raw,
  };
}

function messagesResult(raw: unknown): DOChatResult {
  const root = asRecord(raw) || {};
  return {
    text: textFromContent(root.content),
    usage: usageFromDO(root.usage, "messages"),
    finishReason: clean(root.stop_reason) || clean(root.stop_sequence) || undefined,
    raw,
  };
}

function usageFromDO(value: unknown, routeKind?: DORouteKind): UnifiedUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const promptTokens = readNumber(usage, ["prompt_tokens", "input_tokens", "inputTokens"]) ?? 0;
  const completionTokens = readNumber(usage, ["completion_tokens", "output_tokens", "outputTokens"]) ?? 0;
  const totalTokens = readNumber(usage, ["total_tokens", "totalTokens"]) ?? promptTokens + completionTokens;
  const metrics: Record<string, unknown> = {};

  const inputDetails = asRecord(usage.prompt_tokens_details) || asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.completion_tokens_details) || asRecord(usage.output_tokens_details);
  const cachedDetails = asRecord(inputDetails?.cached_tokens_details) || asRecord(inputDetails?.cache_read_tokens_details);

  assignMetric(metrics, "input_text_tokens", inputDetails?.text_tokens ?? inputDetails?.textTokens ?? usage.input_text_tokens);
  assignMetric(metrics, "input_image_tokens", inputDetails?.image_tokens ?? inputDetails?.imageTokens ?? usage.input_image_tokens);
  assignMetric(metrics, "input_video_tokens", inputDetails?.video_tokens ?? inputDetails?.videoTokens ?? usage.input_video_tokens);
  assignMetric(metrics, "cached_input_tokens", inputDetails?.cached_tokens ?? usage.cached_input_tokens);
  assignMetric(metrics, "cached_input_text_tokens", cachedDetails?.text_tokens ?? cachedDetails?.textTokens ?? usage.cached_input_text_tokens);
  assignMetric(metrics, "cached_input_image_tokens", cachedDetails?.image_tokens ?? cachedDetails?.imageTokens ?? usage.cached_input_image_tokens);
  assignMetric(metrics, "output_text_tokens", outputDetails?.text_tokens ?? outputDetails?.textTokens ?? usage.output_text_tokens);
  assignMetric(metrics, "output_image_tokens", outputDetails?.image_tokens ?? outputDetails?.imageTokens ?? usage.output_image_tokens);
  assignMetric(metrics, "output_video_tokens", outputDetails?.video_tokens ?? outputDetails?.videoTokens ?? usage.output_video_tokens);
  assignMetric(metrics, "reasoning_tokens", outputDetails?.reasoning_tokens ?? outputDetails?.reasoningTokens ?? usage.reasoning_tokens);

  if (routeKind === "image") {
    if (metrics.output_image_tokens === undefined && completionTokens > 0) metrics.output_image_tokens = completionTokens;
    if (metrics.input_text_tokens === undefined && metrics.input_image_tokens === undefined && promptTokens > 0) {
      metrics.input_text_tokens = promptTokens;
    }
  }

  if (routeKind === "video") {
    const videoTokens = readNumber(usage, ["video_tokens", "videoTokens"]);
    if (metrics.output_video_tokens === undefined) metrics.output_video_tokens = videoTokens ?? (completionTokens > 0 ? completionTokens : totalTokens);
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(readNumber(usage, ["reasoning_tokens", "reasoningTokens"]) !== undefined ? { reasoningTokens: readNumber(usage, ["reasoning_tokens", "reasoningTokens"]) } : {}),
    ...(readNumber(usage, ["cached_input_tokens", "cachedInputTokens"]) !== undefined ? { cachedInputTokens: readNumber(usage, ["cached_input_tokens", "cachedInputTokens"]) } : {}),
    ...(Object.keys(metrics).length > 0 ? { billingMetrics: metrics } : {}),
    raw: usage,
  };
}

async function bufferFromPayload(value: string, fallbackMimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (/^data:/i.test(value)) {
    const match = value.match(/^data:([^;,]+)?;base64,(.+)$/i);
    if (!match) throw new Error("DigitalOcean media response contained an invalid data URL");
    return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] || fallbackMimeType };
  }
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`Failed to download DigitalOcean media URL: ${response.status}`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") || fallbackMimeType,
    };
  }
  return { buffer: Buffer.from(value, "base64"), mimeType: fallbackMimeType };
}

function firstDataItem(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw) || {};
  const data = Array.isArray(root.data) ? root.data : [];
  return asRecord(data[0]) || root;
}

async function imageFromRaw(raw: unknown): Promise<{ buffer: Buffer; mimeType: string }> {
  const first = firstDataItem(raw);
  const payload = clean(first.b64_json) || clean(first.base64) || clean(first.image) || clean(first.url);
  if (!payload) {
    throw new Error("DigitalOcean returned no image data");
  }
  return bufferFromPayload(payload, "image/png");
}

function speechMimeType(format: string | undefined, contentType?: string | null): string {
  if (contentType && !contentType.includes("application/json")) return contentType;
  switch ((format || "mp3").toLowerCase()) {
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
    default:
      return "audio/mpeg";
  }
}

async function postSpeech(path: string, body: Record<string, unknown>, responseFormat?: string): Promise<{ buffer: Buffer; mimeType: string; raw: unknown }> {
  const response = await fetch(doUrl(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`DigitalOcean provider HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`);
  }

  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    const raw = await parseJsonResponse(response);
    const first = firstDataItem(raw);
    const payload = clean(first.b64_json) || clean(first.base64) || clean(first.audio) || clean(first.url);
    if (!payload) {
      throw new Error("DigitalOcean returned no audio data");
    }
    const media = await bufferFromPayload(payload, speechMimeType(responseFormat));
    return { ...media, raw };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const sniffedMimeType = buffer.toString("ascii", 0, 4) === "RIFF" ? "audio/wav" : speechMimeType(responseFormat, contentType);
  return {
    buffer,
    mimeType: sniffedMimeType,
    raw: {},
  };
}

function statusFromProvider(value: unknown): "queued" | "processing" | "completed" | "failed" {
  const normalized = clean(value).toLowerCase();
  if (["completed", "complete", "succeeded", "success", "done"].includes(normalized)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(normalized)) return "failed";
  if (["queued", "pending"].includes(normalized)) return "queued";
  return "processing";
}

function findUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = clean(record.url) || clean(record.output_url) || clean(record.video_url);
  if (direct) return direct;
  const output = asRecord(record.output);
  const video = asRecord(record.video);
  const result = asRecord(record.result);
  return clean(output?.url) || clean(output?.video_url) || clean(asRecord(output?.video)?.url)
    || clean(video?.url) || clean(result?.url) || clean(result?.video_url) || undefined;
}

function findError(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.error === "string") return record.error;
  const error = asRecord(record.error);
  return clean(error?.message) || undefined;
}

export async function generateDOChat(
  modelId: string,
  messages: UnifiedMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    tools?: unknown;
    toolChoice?: unknown;
    responseFormat?: unknown;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<DOChatResult> {
  const route = requireRoute(modelId, ["chat", "messages", "responses"]);
  const customParams = options.customParams || {};

  if (route.kind === "messages") {
    const raw = await postJson(route.path, {
      model: modelId,
      messages: normalizeChatMessages(messages).filter((message) => message.role !== "system"),
      max_tokens: options.maxTokens || 1024,
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...(messages.find((message) => message.role === "system") ? { system: messageText(messages.find((message) => message.role === "system")!) } : {}),
      ...customParams,
    });
    return messagesResult(raw);
  }

  if (route.kind === "responses") {
    const raw = await postJson(route.path, {
      model: modelId,
      input: responsesInputFromMessages(messages),
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { max_output_tokens: options.maxTokens } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
      ...customParams,
    });
    const root = asRecord(raw) || {};
    const text = textFromResponses(raw);
    return {
      text,
      usage: usageFromDO(root.usage, route.kind),
      finishReason: clean(root.status) || "stop",
      raw,
    };
  }

  const raw = await postJson(route.path, {
    model: modelId,
    messages: normalizeChatMessages(messages),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...customParams,
  });
  return chatResult(raw);
}

export async function generateDOEmbeddings(modelId: string, input: string[]): Promise<DOEmbeddingResult> {
  const route = requireRoute(modelId, ["embeddings"]);
  const raw = await postJson(route.path, {
    model: modelId,
    input,
  });
  const root = asRecord(raw) || {};
  const data = Array.isArray(root.data) ? root.data : [];
  const embeddings = data
    .map((item) => asRecord(item)?.embedding)
    .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((value) => typeof value === "number"));

  return {
    embeddings,
    usage: usageFromDO(root.usage, route.kind),
    raw,
  };
}

export async function generateDOImage(
  modelId: string,
  prompt: string,
  options: {
    n?: number;
    size?: string;
    quality?: string;
    imageUrl?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<DOImageResult> {
  const route = requireRoute(modelId, ["image"]);
  const raw = await postJson(route.path, {
    model: modelId,
    prompt,
    n: options.n || 1,
    response_format: "b64_json",
    ...(options.size ? { size: options.size } : {}),
    ...(options.quality ? { quality: options.quality } : {}),
    ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
    ...(options.customParams || {}),
  });
  const root = asRecord(raw) || {};
  const image = await imageFromRaw(raw);
  return {
    ...image,
    usage: usageFromDO(root.usage, route.kind),
    raw,
  };
}

export async function generateDOSpeech(
  modelId: string,
  input: string,
  options: {
    voice?: string;
    speed?: number;
    responseFormat?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<DOSpeechResult> {
  const route = requireRoute(modelId, ["audio_speech"]);
  const responseFormat = options.responseFormat || "mp3";
  const result = await postSpeech(route.path, {
    model: modelId,
    input,
    voice: options.voice || "alloy",
    response_format: responseFormat,
    instructions: "Speak naturally.",
    ...(typeof options.speed === "number" ? { speed: options.speed } : {}),
    ...(options.customParams || {}),
  }, responseFormat);
  const root = asRecord(result.raw) || {};
  return {
    ...result,
    usage: usageFromDO(root.usage, route.kind),
  };
}

export async function submitDOVideoJob(
  modelId: string,
  prompt: string,
  options: {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    imageUrl?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<DOVideoJobResult> {
  const route = requireRoute(modelId, ["video"]);
  const raw = await postJson(route.path, {
    model: modelId,
    prompt,
    fps: 16,
    ...(typeof options.duration === "number" ? { duration: options.duration } : {}),
    ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.size ? { size: options.size } : {}),
    ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
    ...(options.customParams || {}),
  });
  const root = asRecord(raw) || {};
  const id = clean(root.id) || clean(root.job_id) || clean(root.generation_id);
  if (!id) {
    throw new Error("DigitalOcean returned no video job id");
  }

  const status = statusFromProvider(root.status);
  return {
    jobId: `digitalocean:${modelId}:${id}`,
    status: status === "queued" ? "queued" : "processing",
    ...(readNumber(root, ["duration", "seconds"]) ? { duration: readNumber(root, ["duration", "seconds"]) } : {}),
    usage: usageFromDO(root.usage, route.kind),
    raw,
  };
}

export async function retrieveDOVideoJob(providerJobId: string): Promise<DOVideoStatusResult> {
  const separatorIndex = providerJobId.indexOf(":");
  const modelId = separatorIndex >= 0 ? providerJobId.slice(0, separatorIndex) : "";
  const id = separatorIndex >= 0 ? providerJobId.slice(separatorIndex + 1) : providerJobId;
  if (!modelId || !id) {
    throw new Error("DigitalOcean video job id is missing model route metadata");
  }

  const route = requireRoute(modelId, ["video"]);
  const statusPath = route?.statusPath;
  if (!statusPath) {
    throw new Error("DigitalOcean video status route metadata is missing");
  }

  const raw = await getJson(statusPath.replace("{id}", encodeURIComponent(id)));
  const root = asRecord(raw) || {};
  const status = statusFromProvider(root.status);
  let url = findUrl(root);

  if (status === "completed" && !url && route.contentPath) {
    const response = await fetch(doUrl(route.contentPath.replace("{id}", encodeURIComponent(id))), {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean video download failed: ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "video/mp4";
    const buffer = Buffer.from(await response.arrayBuffer());
    url = `data:${contentType};base64,${buffer.toString("base64")}`;
  }

  return {
    status,
    url,
    error: findError(root),
    progress: readNumber(root, ["progress"]),
  };
}
