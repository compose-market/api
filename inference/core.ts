import {
  resolveOptionalModelParamValues,
  resolveProvidedOptionalModelParamValues,
} from "./params-handler.js";
import { getModelById, getModelProtocolProfile } from "./catalog/registry.js";
import {
  getModelCapabilities,
  type ModelOperationCapability,
} from "./catalog/modalities/index.js";
import { realtimeInputParams } from "./catalog/modalities/realtime.js";
import {
  normalizeChatToolChoice,
  normalizeChatTools,
  normalizeResponsesToolChoice,
  normalizeResponsesTools,
  type ResponsesFunctionTool,
  type ResponsesInputItem,
  type ResponsesOutputItem as ProtocolResponsesOutputItem,
  type ResponsesToolChoice,
} from "./responses.js";

export type Mode = "responses" | "chat" | "embeddings";
export type Modality = "text" | "image" | "audio" | "video" | "embedding" | "realtime";
export type Schema = Record<string, unknown>;

export interface Part {
  type: "text" | "image_url" | "input_audio" | "video_url" | "tool-call" | "tool-result";
  text?: string;
  image_url?: { url: string; detail?: "auto" | "low" | "high" } | string;
  input_audio?: { url: string } | string;
  video_url?: { url: string } | string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  args?: unknown;
  cache_control?: Record<string, unknown>;
  prompt_cache_breakpoint?: unknown;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Part[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    providerMetadata?: Record<string, unknown>;
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
  partial?: boolean;
  cache_control?: Record<string, unknown>;
}

export type Tool = ResponsesFunctionTool;
export type Choice = ResponsesToolChoice;

export interface Format {
  type: "text" | "json_object" | "json_schema";
  json_schema?: {
    name: string;
    schema: Schema;
    strict?: boolean;
  };
}

export interface Request {
  mode: Mode;
  model: string;
  stream: boolean;
  modality: Modality;
  operation?: string;
  messages: Message[];
  inputItems?: ResponsesInputItem[];
  instructions?: string;
  tools?: Tool[];
  toolChoice?: Choice;
  maxTokens?: number;
  temperature?: number;
  responseId: string;
  embeddingInput?: string | string[];
  embeddingDimensions?: number;
  imageOptions?: {
    n?: number;
    size?: string;
    quality?: string;
    imageUrl?: string;
  };
  audioOptions?: {
    voice?: string;
    language?: string;
    speed?: number;
    responseFormat?: string;
  };
  videoOptions?: {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    imageUrl?: string;
    videoUrl?: string;
  };
  previousResponseId?: string;
  store?: boolean;
  truncation?: "auto" | "disabled";
  contextManagement?: unknown;
  customParams?: Record<string, unknown>;
  billingMetrics?: Record<string, unknown>;
  /**
   * OpenAI-shaped response_format on inbound chat / responses requests.
   * Provider modules lower this canonical value to native flags such as
   * Gemini `responseMimeType` + `responseSchema` or OpenAI `response_format`.
   */
  responseFormat?: Format;
}

export function normalizeAudioTranscriptionFile(file: string): string {
  const trimmed = file.trim();
  return /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)
    ? trimmed
    : `data:application/octet-stream;base64,${trimmed}`;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  billingMetrics?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface Call {
  id?: string;
  itemId?: string;
  callId?: string;
  outputIndex?: number;
  name: string;
  arguments: string | object;
  providerMetadata?: Record<string, unknown>;
}

export interface Media {
  mimeType: string;
  base64?: string;
  url?: string;
  revisedPrompt?: string;
  duration?: number;
  generatedUnits?: number;
  jobId?: string;
  status?: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  billingMetrics?: Record<string, unknown>;
}

export interface Output {
  modality: Modality;
  content?: string;
  reasoning?: string;
  usage?: Usage;
  finishReason?: string;
  toolCalls?: Call[];
  outputItems?: ProtocolResponsesOutputItem[];
  embeddings?: number[][];
  media?: Media;
}

export interface Event {
  type:
  | "created"
  | "text-delta"
  | "reasoning-delta"
  | "tool-call"
  | "tool-call-delta"
  | "thinking"
  | "citation"
  | "warning"
  | "error"
  | "image-partial"
  | "image-complete"
  | "audio-chunk"
  | "subtitle"
  | "output-item"
  | "status"
  | "video-status"
  | "video-complete"
  | "done";
  text?: string;
  itemId?: string;
  toolCall?: {
    id: string;
    itemId?: string;
    callId?: string;
    name: string;
    arguments: string;
    index?: number;
    providerMetadata?: Record<string, unknown>;
  };
  toolCallDelta?: {
    id?: string;
    itemId?: string;
    callId?: string;
    name?: string;
    arguments?: string;
    index: number;
  };
  thinking?: string;
  citation?: Record<string, unknown>;
  warning?: { code: string; message: string };
  error?: { code: string; message: string; details?: Record<string, unknown> };
  outputIndex?: number;
  item?: ResponsesOutputItem;
  audio?: {
    base64?: string;
    sequenceIndex?: number;
    mimeType?: string;
    sampleRate?: number;
    channels?: number;
    format?: string;
  };
  subtitle?: {
    start: number;
    end: number;
    text: string;
  };
  videoStatus?: {
    jobId: string;
    status: "queued" | "processing" | "completed" | "failed";
    progress?: number;
    url?: string;
    error?: string;
  };
  image?: {
    base64: string;
    index?: number;
    mimeType?: string;
    revisedPrompt?: string;
    duration?: number;
    generatedUnits?: number;
    billingMetrics?: Record<string, unknown>;
  };
  video?: {
    url?: string;
    base64?: string;
    jobId?: string;
    status?: "queued" | "processing" | "completed" | "failed";
    progress?: number;
    mimeType?: string;
  };
  usage?: Usage;
  media?: Media;
  finishReason?: string;
}

export type Result = Output;

export interface Model {
  generate(request: Request): Promise<Output>;
  stream?(request: Request): AsyncIterable<Event>;
}

export type ResponsesOutputItem = ProtocolResponsesOutputItem;

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "in_progress" | "failed" | "cancelled";
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens: number };
    billingMetrics?: Record<string, unknown>;
  };
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

export interface ChatCompletionsResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens: number };
    billingMetrics?: Record<string, unknown>;
  };
}

export interface EmbeddingsResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
    billingMetrics?: Record<string, unknown>;
  };
}

function mergeBillingMetrics(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...sources.filter((source): source is Record<string, unknown> => Boolean(source)));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function nonNegativeMetric(metrics: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageCacheReadTokens(usage: Usage): number {
  return usage.cachedInputTokens ?? nonNegativeMetric(usage.billingMetrics, "cached_input_tokens") ?? 0;
}

function usageCacheWriteTokens(usage: Usage): number | undefined {
  return usage.cacheWriteTokens ?? nonNegativeMetric(usage.billingMetrics, "cache_write_input_tokens");
}

function responseUsage(usage: Usage | undefined, extraMetrics?: Record<string, unknown>): ResponsesResponse["usage"] {
  if (!usage) return undefined;
  const billingMetrics = mergeBillingMetrics(usage.billingMetrics, extraMetrics);
  const cacheWriteTokens = usageCacheWriteTokens(usage);
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: {
      cached_tokens: usageCacheReadTokens(usage),
      ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
    },
    output_tokens_details: {
      reasoning_tokens: usage.reasoningTokens ?? nonNegativeMetric(usage.billingMetrics, "reasoning_tokens") ?? 0,
    },
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

function toResponseId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function toItemId(prefix: "msg" | "rs" | "fc" | "call"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function parseRole(role: unknown): Message["role"] {
  if (role === "developer") {
    return "system";
  }
  if (role === "system" || role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

const PASS = [
  "candidate_labels",
  "context_management",
  "contexts",
  "documents",
  "examples",
  "frequency_penalty",
  "include",
  "labels",
  "logit_bias",
  "metadata",
  "multi_label",
  "parallel_tool_calls",
  "partial",
  "presence_penalty",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "query",
  "reasoning",
  "reasoning_effort",
  "reasoning_history",
  "return_documents",
  "seed",
  "service_tier",
  "safety_identifier",
  "store",
  "stream_options",
  "texts",
  "threshold",
  "thinking",
  "text",
  "top_k",
  "top_n",
  "top_p",
  "truncate",
  "truncation",
  "user",
] as const;

function safeIntegerParam(name: string, value: unknown): unknown {
  if (name !== "seed" || value === undefined) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(parsed);
    }
  }
  throw Object.assign(new Error("seed must be a safe integer"), {
    statusCode: 400,
    code: "unsafe_seed",
  });
}

function validatedCustomParams(value: unknown): Record<string, unknown> | null {
  const custom = asRecord(value);
  if (!custom) return null;
  return {
    ...custom,
    ...(custom.seed !== undefined ? { seed: safeIntegerParam("seed", custom.seed) } : {}),
  };
}

function params(body: Record<string, unknown>): Record<string, unknown> | null {
  const output: Record<string, unknown> = {};
  for (const key of PASS) {
    const value = body[key];
    if (value !== undefined) {
      output[key] = safeIntegerParam(key, value);
    }
  }

  const cache = pickStringValue(body.promptCacheKey);
  if (cache) output.prompt_cache_key = cache;
  const cacheOptions = asRecord(body.promptCacheOptions);
  if (cacheOptions) output.prompt_cache_options = cacheOptions;
  const retention = pickStringValue(body.promptCacheRetention);
  if (retention) output.prompt_cache_retention = retention;
  const effort = pickStringValue(body.reasoningEffort);
  if (effort) output.reasoning_effort = effort;
  const verbosity = pickStringValue(body.textVerbosity, body.verbosity);
  if (verbosity) {
    output.text = {
      ...(asRecord(output.text) || {}),
      verbosity,
    };
  }

  return Object.keys(output).length > 0 ? output : null;
}

function normalizeContentParts(parts: unknown[]): Part[] {
  const normalized: Part[] = [];

  for (const item of parts) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const part = item as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";

    if ((type === "text" || type === "input_text" || type === "output_text") && typeof part.text === "string") {
      normalized.push({
        type: "text",
        text: part.text,
        ...(asRecord(part.cache_control) ? { cache_control: part.cache_control as Record<string, unknown> } : {}),
        ...(part.prompt_cache_breakpoint !== undefined ? { prompt_cache_breakpoint: part.prompt_cache_breakpoint } : {}),
      });
      continue;
    }

    if (type === "image_url" || type === "input_image") {
      const image = part.image_url;
      const url = typeof image === "string" ? image : (image as { url?: string } | undefined)?.url;
      if (url) normalized.push({ type: "image_url", image_url: { url } });
      continue;
    }

    if (type === "input_audio") {
      const audio = part.input_audio ?? part.audio_url;
      const url = typeof audio === "string" ? audio : (audio as { url?: string } | undefined)?.url;
      if (url) normalized.push({ type: "input_audio", input_audio: { url } });
      continue;
    }

    if (type === "video_url" || type === "input_video") {
      const video = part.video_url;
      const url = typeof video === "string" ? video : (video as { url?: string } | undefined)?.url;
      if (url) normalized.push({ type: "video_url", video_url: { url } });
      continue;
    }

    if (type === "tool-call" || type === "tool_call") {
      normalized.push({
        type: "tool-call",
        toolCallId: pickStringValue(part.toolCallId, part.tool_call_id, part.call_id, part.id),
        toolName: pickStringValue(part.toolName, part.tool_name, part.name),
        input: part.input ?? part.args ?? part.arguments ?? {},
      });
      continue;
    }

    if (type === "tool-result" || type === "tool_result") {
      normalized.push({
        type: "tool-result",
        toolCallId: pickStringValue(part.toolCallId, part.tool_call_id, part.call_id, part.id),
        toolName: pickStringValue(part.toolName, part.tool_name, part.name, part.tool),
        output: part.output ?? part.result,
      });
      continue;
    }

    normalized.push({ type: "text", text: JSON.stringify(part) });
  }

  return normalized;
}

function embeddedToolCalls(parts: Part[]): Message["tool_calls"] {
  return parts.flatMap((part): NonNullable<Message["tool_calls"]> => {
    if (part.type !== "tool-call" || !part.toolCallId || !part.toolName) return [];
    return [{
      id: part.toolCallId,
      type: "function",
      function: {
        name: part.toolName,
        arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
      },
    }];
  });
}

function enrichToolHistory(messages: Message[]): Message[] {
  const names = new Map<string, string>();
  const pending: Array<{ id: string; name: string }> = [];
  return messages.map((message) => {
    for (const call of message.tool_calls || []) {
      if (!call.id || !call.function.name) continue;
      names.set(call.id, call.function.name);
      pending.push({ id: call.id, name: call.function.name });
    }
    if (message.role !== "tool") return message;

    const matched = (message.tool_call_id
      ? pending.find((call) => call.id === message.tool_call_id)
      : undefined) ?? pending[0];
    const toolCallId = message.tool_call_id || matched?.id;
    const name = message.name || (toolCallId ? names.get(toolCallId) : undefined) || matched?.name;
    if (matched) pending.splice(pending.indexOf(matched), 1);
    return {
      ...message,
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(name ? { name } : {}),
    };
  });
}

function normalizeMessages(input: unknown): Message[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const messages = input
    .filter((msg) => !!msg && typeof msg === "object")
    .map((msg) => {
      const message = msg as Record<string, unknown>;
      const role = parseRole(message.role);
      const content = message.content;

      if (Array.isArray(content)) {
        const normalizedContent = normalizeContentParts(content);
        const contentCalls = role === "assistant" ? embeddedToolCalls(normalizedContent) : undefined;
        const resultPart = role === "tool"
          ? normalizedContent.find((part) => part.type === "tool-result")
          : undefined;
        const visibleContent = normalizedContent.filter((part) => part.type !== "tool-call" && part.type !== "tool-result");
        return {
          role,
          content: resultPart
            ? responseItemOutput(resultPart.output)
            : visibleContent.length > 0
              ? visibleContent
              : role === "assistant"
                ? null
                : [],
          tool_calls: Array.isArray(message.tool_calls)
            ? message.tool_calls as Message["tool_calls"]
            : contentCalls?.length
              ? contentCalls
              : undefined,
          tool_call_id: pickStringValue(message.tool_call_id, resultPart?.toolCallId),
          name: pickStringValue(message.name, resultPart?.toolName),
          reasoning_content: typeof message.reasoning_content === "string" ? message.reasoning_content : undefined,
          partial: message.partial === true ? true : undefined,
          cache_control: asRecord(message.cache_control) || undefined,
        } satisfies Message;
      }

      return {
        role,
        content: typeof content === "string" ? content : content == null ? null : String(content),
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as Message["tool_calls"] : undefined,
        tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
        name: typeof message.name === "string" ? message.name : undefined,
        reasoning_content: typeof message.reasoning_content === "string" ? message.reasoning_content : undefined,
        partial: message.partial === true ? true : undefined,
        cache_control: asRecord(message.cache_control) || undefined,
      } satisfies Message;
    });
  return enrichToolHistory(messages);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function pickStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function pickNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function normalizeAttachmentList(body: Record<string, unknown>): Part[] {
  const raw: unknown[] = [];
  if (Array.isArray(body.attachments)) {
    raw.push(...body.attachments);
  }
  if (body.attachment !== undefined && body.attachment !== null) {
    raw.push(body.attachment);
  }

  return raw
    .map(attachmentToContentPart)
    .filter((part): part is Part => part !== null);
}

function attachmentToContentPart(value: unknown): Part | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return attachmentRecordToContentPart({ url: value.trim() });
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return attachmentRecordToContentPart(record);
}

function attachmentRecordToContentPart(record: Record<string, unknown>): Part | null {
  const url = pickStringValue(
    record.url,
    record.uri,
    record.href,
    record.image_url,
    record.audio_url,
    record.video_url,
    record.dataUrl,
    record.data_url,
  );
  const mimeType = pickStringValue(record.mimeType, record.mime_type, record.contentType, record.content_type);
  const base64 = pickStringValue(record.base64, record.b64_json);
  const data = pickStringValue(record.data);
  const locator = url
    ?? (base64 ? `data:${mimeType || "application/octet-stream"};base64,${base64}` : undefined)
    ?? data;
  const text = pickStringValue(record.text, record.content);
  const name = pickStringValue(record.name, record.filename);
  const kind = inferAttachmentKind(record, locator, mimeType, name);

  if (kind === "image" && locator) {
    return {
      type: "image_url",
      image_url: {
        url: locator,
        detail: record.detail === "low" || record.detail === "high" ? record.detail : "auto",
      },
    };
  }

  if (kind === "audio" && locator) {
    return { type: "input_audio", input_audio: { url: locator } };
  }

  if (kind === "video" && locator) {
    return { type: "video_url", video_url: { url: locator } };
  }

  if (text) {
    return { type: "text", text };
  }

  if (locator) {
    const label = name ? `${kind}:${name}` : kind;
    return { type: "text", text: `Attachment ${label}: ${locator}` };
  }

  if (Object.keys(record).length > 0) {
    return { type: "text", text: `Attachment: ${JSON.stringify(record)}` };
  }

  return null;
}

function inferAttachmentKind(
  record: Record<string, unknown>,
  locator: string | undefined,
  mimeType: string | undefined,
  name: string | undefined,
): "image" | "audio" | "video" | "pdf" | "text" | "json" | "file" | "url" {
  const explicit = pickStringValue(record.type, record.kind, record.mediaType, record.media_type)?.toLowerCase();
  const haystack = [explicit, mimeType, name, locator].filter(Boolean).join(" ").toLowerCase();

  if (haystack.includes("image/") || /\.(png|jpe?g|gif|webp|avif|heic|svg)(?:[?#].*)?$/.test(haystack) || explicit === "image") {
    return "image";
  }
  if (haystack.includes("audio/") || /\.(mp3|m4a|wav|ogg|opus|flac|aac|aiff?)(?:[?#].*)?$/.test(haystack) || explicit === "audio") {
    return "audio";
  }
  if (haystack.includes("video/") || /\.(mp4|mov|webm|mkv|avi|mpeg|mpg)(?:[?#].*)?$/.test(haystack) || explicit === "video") {
    return "video";
  }
  if (haystack.includes("application/pdf") || /\.pdf(?:[?#].*)?$/.test(haystack) || explicit === "pdf") {
    return "pdf";
  }
  if (haystack.includes("application/json") || explicit === "json") {
    return "json";
  }
  if (haystack.includes("text/") || explicit === "text") {
    return "text";
  }
  if (locator && /^https?:\/\//i.test(locator)) {
    return "url";
  }

  return "file";
}

function appendAttachmentParts(messages: Message[], attachments: Part[]): Message[] {
  if (attachments.length === 0) {
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
    next.push({ role: "user", content: attachments });
    return next;
  }

  const target = next[targetIndex];
  const parts: Part[] = [];
  if (Array.isArray(target.content)) {
    parts.push(...target.content);
  } else if (typeof target.content === "string" && target.content.trim().length > 0) {
    parts.push({ type: "text", text: target.content });
  }
  parts.push(...attachments);
  next[targetIndex] = { ...target, content: parts };
  return next;
}

function getPrimaryText(messages: Message[]): string {
  for (const message of messages) {
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    const text = message.content
      .filter((part): part is Part & { text: string } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function parseDimensions(size: string | undefined): { width: number; height: number; pixels: number; megapixels: number } | undefined {
  if (!size) {
    return undefined;
  }

  const match = size.trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) {
    return undefined;
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  const pixels = width * height;
  return {
    width,
    height,
    pixels,
    megapixels: pixels / 1_000_000,
  };
}

function buildRequestBillingMetrics(
  modality: Modality,
  resolvedParams: Record<string, unknown>,
  promptText?: string,
): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    request: 1,
  };

  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metrics[key] = value;
    }
  }

  if (modality === "image") {
    const generatedUnits = pickNumberValue(resolvedParams.n, resolvedParams.num_images);
    if (typeof generatedUnits === "number" && generatedUnits > 0) {
      metrics.generation = generatedUnits;
      metrics.image = generatedUnits;
    }

    const dimensions = parseDimensions(pickStringValue(
      resolvedParams.size,
      resolvedParams.image_size,
    ));
    if (dimensions && typeof generatedUnits === "number" && generatedUnits > 0) {
      metrics.width = dimensions.width;
      metrics.height = dimensions.height;
      metrics.pixel = dimensions.pixels * generatedUnits;
      metrics.megapixel = dimensions.megapixels * generatedUnits;
    }
  }

  if (modality === "video") {
    const duration = pickNumberValue(resolvedParams.duration);
    if (typeof duration === "number" && duration > 0) {
      metrics.second = duration;
      metrics.minute = duration / 60;
      metrics.duration = duration;
    }

    const resolution = pickStringValue(resolvedParams.resolution, resolvedParams.size);
    if (resolution) {
      metrics.resolution = resolution;
    }

    const aspectRatio = pickStringValue(resolvedParams.aspect_ratio, resolvedParams.aspectRatio);
    if (aspectRatio) {
      metrics.aspect_ratio = aspectRatio;
    }

    metrics.video = 1;
    metrics.generation = 1;
  }

  if (modality === "audio" && promptText) {
    const musicLengthMs = pickNumberValue(resolvedParams.music_length_ms);
    const seconds = typeof musicLengthMs === "number" && musicLengthMs > 0
      ? musicLengthMs / 1000
      : pickNumberValue(resolvedParams.duration_seconds, resolvedParams.duration);
    if (typeof seconds === "number" && seconds > 0) {
      metrics.second = seconds;
      metrics.audio_second = seconds;
      metrics.minute = seconds / 60;
      metrics.audio_minute = seconds / 60;
      metrics.generated_audio_second = seconds;
      metrics.generated_audio_minute = seconds / 60;
      metrics.duration = seconds;
    }

    const characters = Array.from(promptText).length;
    if (characters > 0) {
      metrics.character = characters;
    }
  }

  return metrics;
}

interface NormalizedResponsesInput {
  items: ResponsesInputItem[];
  messages: Message[];
}

function canonicalResponsesInputItem(item: Record<string, unknown>): ResponsesInputItem {
  const role = typeof item.role === "string" ? item.role : undefined;
  if (!Array.isArray(item.content)) return { ...item };

  const content = item.content.map((rawPart) => {
    if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) return rawPart;
    const part = rawPart as Record<string, unknown>;
    if (part.type !== "text") return { ...part };
    return {
      ...part,
      type: role === "assistant" ? "output_text" : "input_text",
    };
  });
  return { ...item, content };
}

function responseItemOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeResponsesInput(input: unknown): NormalizedResponsesInput {
  if (typeof input === "string") {
    return {
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input }],
      }],
      messages: [{ role: "user", content: input }],
    };
  }

  if (!Array.isArray(input)) {
    return { items: [], messages: [] };
  }

  if (input.length === 0) {
    return { items: [], messages: [] };
  }

  const items = input
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map(canonicalResponsesInputItem);
  const messages: Message[] = [];
  let parts: Part[] = [];
  let pendingReasoning: string | undefined;
  const flushParts = () => {
    if (parts.length > 0) {
      messages.push({ role: "user", content: parts });
      parts = [];
    }
  };

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if ("role" in record || type === "message") {
      flushParts();
      const normalized = normalizeMessages([record]);
      if (pendingReasoning !== undefined && normalized[0]?.role === "assistant") {
        normalized[0].reasoning_content = pendingReasoning;
        pendingReasoning = undefined;
      }
      messages.push(...normalized);
      continue;
    }

    if (type === "function_call") {
      const callId = typeof record.call_id === "string" && record.call_id.length > 0
        ? record.call_id
        : typeof record.id === "string" && record.id.length > 0
          ? record.id
          : toItemId("call");
      const name = typeof record.name === "string" ? record.name : "";
      if (!name) continue;
      flushParts();
      messages.push({
        role: "assistant",
        content: null,
        ...(pendingReasoning !== undefined ? { reasoning_content: pendingReasoning } : {}),
        tool_calls: [{
          id: callId,
          type: "function",
          function: {
            name,
            arguments: typeof record.arguments === "string" ? record.arguments : responseItemOutput(record.arguments || {}),
          },
        }],
      });
      pendingReasoning = undefined;
      continue;
    }

    if (type === "function_call_output") {
      const callId = typeof record.call_id === "string" ? record.call_id : "";
      if (!callId) continue;
      flushParts();
      messages.push({
        role: "tool",
        content: responseItemOutput(record.output),
        tool_call_id: callId,
        ...(pickStringValue(record.name, record.tool) ? { name: pickStringValue(record.name, record.tool) } : {}),
      });
      continue;
    }

    if (type === "reasoning") {
      flushParts();
      const summary = Array.isArray(record.summary) ? record.summary : [];
      pendingReasoning = summary
        .map((part) => asRecord(part)?.text)
        .filter((value): value is string => typeof value === "string")
        .join("");
      continue;
    }

    if (type === "input_text" && typeof record.text === "string") {
      parts.push({ type: "text", text: record.text });
      continue;
    }

    if (type === "input_image") {
      const url = typeof record.image_url === "string" ? record.image_url : undefined;
      if (url) parts.push({ type: "image_url", image_url: { url } });
      continue;
    }

    if (type === "input_audio") {
      const url = typeof record.audio_url === "string" ? record.audio_url : undefined;
      if (url) parts.push({ type: "input_audio", input_audio: { url } });
      continue;
    }

    if (type === "input_video") {
      const url = typeof record.video_url === "string" ? record.video_url : undefined;
      if (url) parts.push({ type: "video_url", video_url: { url } });
      continue;
    }
  }

  flushParts();
  return { items, messages: enrichToolHistory(messages) };
}

function requestedModalities(body: Record<string, unknown>): Modality[] {
  const directModalities = Array.isArray(body.modalities)
    ? body.modalities.filter((m): m is string => typeof m === "string")
    : [];
  const responseObj = body.response;
  const nestedModalities = responseObj && typeof responseObj === "object" && Array.isArray((responseObj as Record<string, unknown>).modalities)
    ? ((responseObj as Record<string, unknown>).modalities as unknown[]).filter((m): m is string => typeof m === "string")
    : [];

  const out: Modality[] = [];
  const push = (value: string) => {
    const normalized = value.toLowerCase();
    if ((normalized === "embedding" || normalized === "embeddings") && !out.includes("embedding")) {
      out.push("embedding");
      return;
    }
    if ((normalized === "text" || normalized === "image" || normalized === "audio" || normalized === "video" || normalized === "realtime") && !out.includes(normalized)) {
      out.push(normalized);
    }
  };

  for (const modality of [...directModalities, ...nestedModalities]) {
    push(modality);
  }

  return out;
}

function pickExplicitOperation(body: Record<string, unknown>): string | null {
  const operation = pickStringValue(body.operation);
  if (operation) return operation;

  const responseObj = body.response;
  if (responseObj && typeof responseObj === "object") {
    return pickStringValue((responseObj as Record<string, unknown>).operation) ?? null;
  }

  return null;
}

function inputKindsFromMessages(messages: Message[]): Modality[] {
  const kinds: Modality[] = [];
  const push = (kind: Modality) => {
    if (!kinds.includes(kind)) kinds.push(kind);
  };

  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.trim().length > 0) push("text");
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        push("text");
        continue;
      }
      if (part.type === "image_url") {
        push("image");
        continue;
      }
      if (part.type === "input_audio") {
        push("audio");
        continue;
      }
      if (part.type === "video_url") {
        push("video");
      }
    }
  }

  return kinds;
}

function inputKindsFromRequest(body: Record<string, unknown>, messages: Message[]): Modality[] {
  const kinds = inputKindsFromMessages(messages);
  const push = (kind: Modality) => {
    if (!kinds.includes(kind)) kinds.push(kind);
  };

  if (pickStringValue(body.image_url, body.image)) push("image");
  if (pickStringValue(body.audio_url, body.file)) push("audio");
  if (pickStringValue(body.video_url, body.video)) push("video");

  return kinds;
}

function arrayParam(body: Record<string, unknown>, keys: readonly string[]): boolean {
  const custom = asRecord(body.custom_params);
  return keys.some((key) => Array.isArray(body[key]) || Array.isArray(custom?.[key]));
}

function rerankInput(body: Record<string, unknown>): boolean {
  return arrayParam(body, ["documents", "contexts", "texts"]);
}

function classificationInput(body: Record<string, unknown>): boolean {
  return arrayParam(body, ["candidate_labels", "labels", "examples"]);
}

interface PromptClassification {
  candidateLabels: string[];
  query?: string;
}

function cleanLabel(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'`[(\]-]+/u, "")
    .replace(/[\s"'`\])]+$/u, "")
    .trim();
}

function labelsFromSegment(segment: string): string[] {
  const trimmed = segment.trim();
  if (!trimmed) return [];

  const arrayMatch = trimmed.match(/\[[\s\S]*?\]/u);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        return [...new Set(parsed
          .map((entry) => typeof entry === "string" ? cleanLabel(entry) : "")
          .filter(Boolean))];
      }
    } catch {
      // Fall through to delimiter parsing below.
    }
  }

  return [...new Set(trimmed
    .replace(/[\[\]]/gu, "")
    .split(/[,;|\n]/u)
    .map(cleanLabel)
    .filter((label) => label.length > 0))];
}

function promptClassification(messages: Message[]): PromptClassification | null {
  const source = getPrimaryText(messages);
  if (!source) return null;

  const jsonMatch = source.match(/\{[\s\S]*\}/u);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      const record = asRecord(parsed);
      const rawLabels = Array.isArray(record?.candidate_labels)
        ? record.candidate_labels
        : Array.isArray(record?.labels)
          ? record.labels
          : [];
      const candidateLabels = [...new Set(rawLabels
        .map((entry) => typeof entry === "string" ? cleanLabel(entry) : "")
        .filter(Boolean))];
      const query = pickStringValue(record?.message, record?.text, record?.input, record?.query);
      if (candidateLabels.length >= 2) {
        return { candidateLabels, ...(query ? { query } : {}) };
      }
    } catch {
      // Fall through to label-field parsing below.
    }
  }

  const labels = source.match(/\b(?:candidate\s+labels|labels)\s*:\s*/iu);
  if (!labels?.index && labels?.index !== 0) return null;

  const after = source.slice(labels.index + labels[0].length);
  const target = after.match(/\b(?:message|text|input|utterance|content)\s*:\s*/iu);
  if (!target?.index && target?.index !== 0) return null;

  const labelSegment = after.slice(0, target.index).replace(/[.。]\s*$/u, "");
  const query = after.slice(target.index + target[0].length).trim();
  const candidateLabels = labelsFromSegment(labelSegment);
  if (candidateLabels.length < 2) return null;

  return {
    candidateLabels,
    ...(query ? { query } : {}),
  };
}

function capabilityAcceptsInput(capability: ModelOperationCapability, inputKinds: Modality[]): boolean {
  const meaningfulInputs = inputKinds.filter((kind) => kind !== "text");
  const requestInputs = meaningfulInputs.length > 0 ? meaningfulInputs : inputKinds;

  for (const kind of requestInputs) {
    if (!capability.input.includes(kind)) return false;
  }

  return true;
}

function resolveCatalogCapability(
  body: Record<string, unknown>,
  model: string,
  messages: Message[],
  fallback: Modality,
): ModelOperationCapability | { modality: Modality; operation?: string } {
  const card = model ? getModelById(model) : null;
  const explicitModalities = requestedModalities(body);
  const explicitOperation = pickExplicitOperation(body);
  if (!card) return { modality: explicitModalities[0] ?? fallback, ...(explicitOperation ? { operation: explicitOperation } : {}) };

  const capabilities = getModelCapabilities(card);
  if (capabilities.length === 0) {
    return { modality: explicitModalities[0] ?? fallback, ...(explicitOperation ? { operation: explicitOperation } : {}) };
  }

  const inputKinds = inputKindsFromRequest(body, messages);
  const promptLabels = promptClassification(messages);
  const candidates = capabilities
    .filter((capability) => explicitModalities.length === 0 || explicitModalities.includes(capability.modality))
    .filter((capability) => !explicitOperation || capability.operation === explicitOperation)
    .filter((capability) => capabilityAcceptsInput(capability, inputKinds));
  const nonTextInputs = inputKinds.filter((kind) => kind !== "text");

  if (!explicitOperation && (classificationInput(body) || promptLabels)) {
    const classification = candidates.find((capability) =>
      capability.operation === "classification"
      || capability.operation === "classify"
      || capability.operation === "zero-shot-classification"
    );
    if (classification) {
      return classification;
    }
  }

  if (!explicitOperation && rerankInput(body)) {
    const rerank = candidates.find((capability) => capability.operation === "rerank");
    if (rerank) {
      return rerank;
    }
  }

  if (!explicitOperation && nonTextInputs.length > 0) {
    const operationSpecific = candidates.find((capability) =>
      capability.operation !== "chat"
      && capability.operation !== "responses"
      && capability.operation !== "completion"
    );
    if (operationSpecific) {
      return operationSpecific;
    }
  }

  if (candidates[0]) {
    return candidates[0];
  }

  const modalityMatch = explicitModalities.length > 0
    ? capabilities.find((capability) => explicitModalities.includes(capability.modality))
    : null;
  return modalityMatch ?? capabilities[0] ?? { modality: fallback, ...(explicitOperation ? { operation: explicitOperation } : {}) };
}

function pickCatalogRoute(body: Record<string, unknown>, model: string, messages: Message[], fallback: Modality): {
  modality: Modality;
  operation?: string;
} {
  const resolved = resolveCatalogCapability(body, model, messages, fallback);
  return {
    modality: resolved.modality,
    ...(resolved.operation ? { operation: resolved.operation } : {}),
  };
}

/**
 * Parse the inbound OpenAI-shape `response_format` field into our typed
 * Request.responseFormat. Accepts:
 *   { type: "text" }                                          → text
 *   { type: "json_object" }                                   → json (no schema)
 *   { type: "json_schema", json_schema: { name, schema } }    → json (with schema)
 *
 * Strings, malformed objects, and unknown types are dropped (returns undefined).
 * Provider modules lower this value to their native response-format fields.
 */
function parseInboundResponseFormat(value: unknown): Request["responseFormat"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const t = obj.type;
  if (t !== "text" && t !== "json_object" && t !== "json_schema") return undefined;
  if (t === "text" || t === "json_object") return { type: t };
  const schemaContainer = obj.json_schema;
  if (!schemaContainer || typeof schemaContainer !== "object") {
    // json_schema requested but payload missing — degrade to json_object so the
    // downstream provider still receives a JSON-mode signal.
    return { type: "json_object" };
  }
  const sc = schemaContainer as Record<string, unknown>;
  const name = typeof sc.name === "string" && sc.name.length > 0 ? sc.name : "compose_response";
  const schema = sc.schema && typeof sc.schema === "object" && !Array.isArray(sc.schema)
    ? (sc.schema as Record<string, unknown>)
    : null;
  if (!schema) return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema,
      strict: typeof sc.strict === "boolean" ? sc.strict : undefined,
    },
  };
}

export function normalizeChatRequest(body: Record<string, unknown>): Request {
  const model = typeof body.model === "string" ? body.model : "";
  const messages = appendAttachmentParts(
    normalizeMessages(body.messages),
    normalizeAttachmentList(body),
  );
  const rawCustomParams = validatedCustomParams(body.custom_params);
  const merged = {
    ...(params(body) || {}),
    ...(rawCustomParams || {}),
  };
  const customParams = Object.keys(merged).length > 0 ? merged : undefined;

  return {
    mode: "chat",
    model,
    stream: body.stream === true,
    modality: "text",
    operation: "chat",
    messages,
    tools: normalizeChatTools(body.tools),
    toolChoice: normalizeChatToolChoice(body.tool_choice),
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    responseId: toResponseId(),
    customParams,
    responseFormat: parseInboundResponseFormat(body.response_format),
  };
}

export function normalizeEmbeddingsRequest(body: Record<string, unknown>): Request {
  const model = typeof body.model === "string" ? body.model : "";
  const input = body.input;

  return {
    mode: "embeddings",
    model,
    stream: false,
    modality: "embedding",
    operation: "text-to-embedding",
    messages: [],
    responseId: toResponseId(),
    embeddingInput: (typeof input === "string" || Array.isArray(input)) ? input as string | string[] : "",
    embeddingDimensions: typeof body.dimensions === "number" ? body.dimensions : undefined,
  };
}

export function normalizeResponsesRequest(body: Record<string, unknown>): Request {
  const model = typeof body.model === "string" ? body.model : "";
  const normalizedInput = normalizeResponsesInput(body.input);
  const messages = appendAttachmentParts(
    normalizedInput.messages,
    normalizeAttachmentList(body),
  );
  const route = pickCatalogRoute(body, model, messages, "text");
  const modality = route.modality;
  const derivedClassification = route.operation === "classification" && !classificationInput(body)
    ? promptClassification(messages)
    : null;
  const derivedParams = derivedClassification
    ? {
      candidate_labels: derivedClassification.candidateLabels,
      ...(derivedClassification.query ? { query: derivedClassification.query } : {}),
    }
    : {};
  const promptText = getPrimaryText(messages);
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
  const previousResponseId =
    typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const rawCustomParams = validatedCustomParams(body.custom_params);
  const passParams = params(body);
  const resolvedModelParams = resolveOptionalModelParamValues(model, modality, body);
  const providedModelParams = resolveProvidedOptionalModelParamValues(model, modality, body);
  const inputParams = modality === "realtime"
    ? realtimeInputParams(getModelById(model), messages)
    : {};
  const providedParams = modality === "realtime"
    ? {
      ...(resolvedModelParams?.values ?? {}),
      ...inputParams,
      ...derivedParams,
      ...(passParams || {}),
      ...(rawCustomParams || {}),
      ...(providedModelParams?.values ?? {}),
    }
    : {
      ...derivedParams,
      ...(passParams || {}),
      ...(rawCustomParams || {}),
      ...(providedModelParams?.values ?? {}),
    };
  const billingParams = {
    ...derivedParams,
    ...(passParams || {}),
    ...(rawCustomParams || {}),
    ...(resolvedModelParams?.values ?? {}),
  };
  const customParams = Object.keys(providedParams).length > 0 ? providedParams : undefined;
  const customParamsRecord = asRecord(customParams);
  const truncation = body.truncation === "auto" || body.truncation === "disabled"
    ? body.truncation
    : undefined;
  if (body.truncation !== undefined && truncation === undefined) {
    throw Object.assign(new Error("truncation must be 'auto' or 'disabled'"), {
      statusCode: 400,
      code: "invalid_truncation",
    });
  }

  return {
    mode: "responses",
    model,
    stream: body.stream === true,
    modality,
    ...(route.operation ? { operation: route.operation } : {}),
    messages,
    inputItems: normalizedInput.items,
    instructions,
    tools: normalizeResponsesTools(body.tools),
    toolChoice: normalizeResponsesToolChoice(body.tool_choice),
    maxTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    responseId: toResponseId(),
    embeddingInput: modality === "embedding"
      ? (typeof body.input === "string"
        ? body.input
        : Array.isArray(body.input) && body.input.every((item) => typeof item === "string")
          ? body.input as string[]
          : promptText)
      : undefined,
    imageOptions: {
      n: pickNumberValue(body.n, customParamsRecord?.n, customParamsRecord?.num_images),
      size: pickStringValue(
        typeof body.size === "string" ? body.size : undefined,
        customParamsRecord?.size,
      ),
      quality: pickStringValue(
        typeof body.quality === "string" ? body.quality : undefined,
        customParamsRecord?.quality,
      ),
      imageUrl: pickStringValue(
        typeof body.image_url === "string" ? body.image_url : undefined,
        customParamsRecord?.image_url,
      ),
    },
    audioOptions: {
      voice: typeof body.voice === "string" ? body.voice : undefined,
      language: typeof body.language === "string" ? body.language : undefined,
      speed: typeof body.speed === "number" ? body.speed : undefined,
      responseFormat: typeof body.response_format === "string" ? body.response_format : undefined,
    },
    videoOptions: {
      duration: pickNumberValue(
        typeof body.duration === "number" ? body.duration : undefined,
        customParamsRecord?.duration,
      ),
      aspectRatio: pickStringValue(
        typeof body.aspect_ratio === "string" ? body.aspect_ratio : undefined,
        customParamsRecord?.aspect_ratio,
      ),
      resolution: pickStringValue(
        typeof body.resolution === "string" ? body.resolution : undefined,
        typeof body.size === "string" ? body.size : undefined,
        customParamsRecord?.resolution,
        customParamsRecord?.size,
      ),
      imageUrl: pickStringValue(
        typeof body.image_url === "string" ? body.image_url : undefined,
        customParamsRecord?.image_url,
      ),
      videoUrl: pickStringValue(
        typeof body.video_url === "string" ? body.video_url : undefined,
        customParamsRecord?.video_url,
      ),
    },
    previousResponseId,
    store: body.store !== false,
    truncation,
    ...(body.context_management !== undefined ? { contextManagement: body.context_management } : {}),
    customParams,
    responseFormat: modality === "text" ? parseInboundResponseFormat(body.response_format) : undefined,
    billingMetrics: (modality === "image" || modality === "video" || modality === "audio")
      ? buildRequestBillingMetrics(modality, billingParams, promptText)
      : undefined,
  };
}

export function validateParallelToolCalls(request: Request): void {
  const value = request.customParams?.parallel_tool_calls;
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw Object.assign(new Error("parallel_tool_calls must be a boolean"), {
      statusCode: 400,
      code: "invalid_parallel_tool_calls",
    });
  }
  const model = getModelById(request.model);
  if (!model || getModelProtocolProfile(model).parallelToolCalls) return;
  throw Object.assign(
    new Error(`Model '${request.model}' does not support parallel_tool_calls`),
    { statusCode: 400, code: "unsupported_parallel_tool_calls" },
  );
}

export function toResponsesOutputItems(output: Output): ResponsesOutputItem[] {
  if (Array.isArray(output.outputItems)) {
    return output.outputItems.map((item) => ({ ...item }));
  }
  if (output.modality === "embedding") {
    return (output.embeddings || []).map((embedding) => ({
      type: "output_embedding",
      role: "assistant",
      embedding,
    }));
  }

  if (output.media) {
    if (output.modality === "image") {
      const url = output.media.url || (output.media.base64 ? `data:${output.media.mimeType};base64,${output.media.base64}` : undefined);
      return [{
        type: "output_image",
        role: "assistant",
        ...(url ? { image_url: url } : {}),
        ...(output.media.mimeType ? { mime_type: output.media.mimeType } : {}),
      }];
    }

    if (output.modality === "audio") {
      const url = output.media.url || (output.media.base64 ? `data:${output.media.mimeType};base64,${output.media.base64}` : undefined);
      return [{
        type: "output_audio",
        role: "assistant",
        ...(url ? { audio_url: url } : {}),
        ...(output.media.mimeType ? { mime_type: output.media.mimeType } : {}),
        ...(output.media.status ? { status: output.media.status } : {}),
      }];
    }

    if (output.modality === "video") {
      const url = output.media.url || (output.media.base64 ? `data:${output.media.mimeType};base64,${output.media.base64}` : undefined);
      return [{
        type: "output_video",
        role: "assistant",
        ...(url ? { video_url: url } : {}),
        ...(output.media.mimeType ? { mime_type: output.media.mimeType } : {}),
        ...(output.media.jobId ? { job_id: output.media.jobId } : {}),
        ...(output.media.status ? { status: output.media.status } : {}),
        ...(typeof output.media.progress === "number" ? { progress: output.media.progress } : {}),
      }];
    }
  }

  const items: ResponsesOutputItem[] = [];
  if (output.reasoning) {
    items.push({
      id: toItemId("rs"),
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: output.reasoning }],
    });
  }
  const text = output.content || "";
  if (text.length > 0) {
    items.push({
      id: toItemId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (output.toolCalls?.length) {
    for (const call of output.toolCalls) {
      items.push({
        id: call.itemId || toItemId("fc"),
        type: "function_call",
        status: "completed",
        call_id: call.callId || call.id || toItemId("call"),
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      });
    }
  }

  return items;
}

export function toResponsesResponse(model: string, requestId: string, output: Output): ResponsesResponse {
  const created = Math.floor(Date.now() / 1000);
  const usage = responseUsage(output.usage, output.media?.billingMetrics);

  const response: ResponsesResponse = {
    id: requestId,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output: [],
    ...(usage ? { usage } : {}),
  };

  response.output = toResponsesOutputItems(output);
  return response;
}

export function toChatCompletionsResponse(model: string, requestId: string, output: Output): ChatCompletionsResponse {
  const usage = output.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const billingMetrics = mergeBillingMetrics(usage.billingMetrics, output.media?.billingMetrics);
  const cacheWriteTokens = usageCacheWriteTokens(usage);

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
          content: output.content || "",
          ...(output.reasoning !== undefined ? { reasoning_content: output.reasoning } : {}),
          ...(output.toolCalls?.length
            ? {
              tool_calls: output.toolCalls.map((call, idx) => ({
                id: call.id || `call_${idx}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
                },
                ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
              })),
            }
            : {}),
        },
        finish_reason: toOpenAIChatFinishReason(
          output.finishReason,
          output.toolCalls?.length ? "tool_calls" : "stop",
        ),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: usageCacheReadTokens(usage),
        ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
      },
      completion_tokens_details: {
        reasoning_tokens: usage.reasoningTokens ?? 0,
      },
      ...(billingMetrics ? { billingMetrics } : {}),
    },
  };
}

type OpenAIChatFinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export function toOpenAIChatFinishReason(
  reason?: string | null,
  fallback: OpenAIChatFinishReason = "stop",
): OpenAIChatFinishReason {
  switch (reason || fallback) {
    case "tool-calls":
    case "tool_calls":
      return "tool_calls";
    case "content-filter":
    case "content_filter":
      return "content_filter";
    case "length":
      return "length";
    case "stop":
      return "stop";
    default:
      return fallback;
  }
}

export function toEmbeddingsResponse(model: string, output: Output): EmbeddingsResponse {
  const promptTokens = output.usage?.promptTokens || 0;
  const billingMetrics = output.usage?.billingMetrics;
  return {
    object: "list",
    data: (output.embeddings || []).map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model,
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens,
      ...(billingMetrics ? { billingMetrics } : {}),
    },
  };
}

export function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function formatSSEDone(): string {
  return "data: [DONE]\n\n";
}

/**
 * Format a named-event SSE frame:
 *
 *   event: <name>
 *   data: <json>
 *
 * Used for out-of-band events like `receipt`, `compose.error`,
 * `video.status`, and `compose.budget` that are semantically distinct
 * from regular streaming deltas and which integrator SDKs should recognise
 * via `event:` rather than by parsing the shape of the JSON body.
 */
export function formatSSENamedEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Compose-specific SSE event payloads. These are emitted in addition to the
 * OpenAI-shaped chunks on both /v1/chat/completions and /v1/responses streams
 * so SDK consumers can react to:
 *   - reasoning/thinking deltas (model internal reasoning where the provider
 *     exposes it)
 *   - structured tool-call deltas assembled across chunks
 *   - cost receipts after settlement completes
 *   - structured error frames when the stream fails mid-flight
 *   - video-job poll status updates when clients ask for SSE polling
 */
export interface BillPayload {
  kind: "agent" | "workflow" | "model" | "tool" | "search" | "memory" | "connector";
  source?: string;
  name?: string;
  action?: string;
  subject?: string;
  amountWei: string;
  lineItems: Array<{
    key: string;
    unit: string;
    quantity: number;
    unitPriceUsd: number;
    amountWei: string;
  }>;
  agent?: string;
  agentWallet?: string;
  depth?: number;
  model?: string;
  tokens?: Record<string, number>;
  tools?: string[];
  total?: string;
  duration?: string;
  txId?: string;
  fees?: {
    total: {
      percent: string;
      amount: string;
    };
    distribution: Record<string, string>;
  };
  children?: BillPayload[];
}

export interface ReceiptStreamPayload {
  id?: string;
  service?: string;
  action?: string;
  resource?: string;
  userAddress?: string;
  finalAmountWei: string;
  providerAmountWei?: string;
  platformFeeWei?: string;
  meterSubject?: string;
  lineItems?: Array<{
    key: string;
    unit: string;
    quantity: number;
    unitPriceUsd: number;
    amountWei: string;
  }>;
  bills?: BillPayload[];
  txHash?: string;
  settlementStatus?: "queued" | "claimed" | "settled" | "failed";
  claimTxHash?: string;
  settleTxHash?: string;
  paymentChannelId?: string;
  paymentCumulativeAmountWei?: string;
  network?: string;
  settledAt: number;
  cumulative?: {
    totalAmountWei: string;
    providerAmountWei?: string;
    platformFeeWei?: string;
    receiptCount: number;
  };
}

export function toReceiptStreamEvent(
  payload: ReceiptStreamPayload,
): string {
  return formatSSENamedEvent("receipt", payload);
}

export function toErrorStreamEvent(payload: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): string {
  return formatSSENamedEvent("compose.error", payload);
}

export function toVideoStatusStreamEvent(payload: {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  url?: string;
  error?: string;
}): string {
  return formatSSENamedEvent("video.status", payload);
}

export function toResponsesStreamEvent(requestId: string, model: string, event: Event): Record<string, unknown> {
  if (event.type === "created") {
    return {
      type: "response.created",
      response: {
        id: requestId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        model,
        output: [],
      },
    };
  }

  if (event.type === "text-delta") {
    return {
      type: "response.output_text.delta",
      response_id: requestId,
      item_id: event.itemId || toItemId("msg"),
      output_index: event.outputIndex ?? 0,
      content_index: 0,
      delta: event.text || "",
    };
  }

  if (event.type === "thinking" || event.type === "reasoning-delta") {
    return {
      type: "response.reasoning_summary_text.delta",
      response_id: requestId,
      item_id: event.itemId || toItemId("rs"),
      output_index: event.outputIndex ?? 0,
      summary_index: 0,
      delta: event.thinking || event.text || "",
    };
  }

  if (event.type === "citation") {
    return {
      type: "response.citation",
      response_id: requestId,
      model,
      citation: event.citation || {},
    };
  }

  if (event.type === "warning") {
    return {
      type: "response.warning",
      response_id: requestId,
      model,
      warning: event.warning || { code: "warning", message: "" },
    };
  }

  if (event.type === "error") {
    return {
      type: "error",
      error: event.error || { code: "upstream_error", message: "" },
    };
  }

  if (event.type === "tool-call") {
    const itemId = event.toolCall?.itemId || toItemId("fc");
    const callId = event.toolCall?.callId || event.toolCall?.id || toItemId("call");
    return {
      type: "response.output_item.done",
      response_id: requestId,
      output_index: event.toolCall?.index ?? event.outputIndex ?? 0,
      item: {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: event.toolCall?.name || "",
        arguments: event.toolCall?.arguments || "{}",
      },
    };
  }

  if (event.type === "tool-call-delta") {
    return {
      type: "response.function_call_arguments.delta",
      response_id: requestId,
      item_id: event.toolCallDelta?.itemId || toItemId("fc"),
      output_index: event.toolCallDelta?.index ?? 0,
      delta: event.toolCallDelta?.arguments || "",
    };
  }

  if (event.type === "image-partial") {
    return {
      type: "response.image_generation_call.partial_image",
      response_id: requestId,
      model,
      output_index: event.outputIndex ?? 0,
      partial_image_index: event.image?.index ?? 0,
      partial_image_b64: event.image?.base64 || "",
    };
  }

  if (event.type === "image-complete") {
    const usage = responseUsage(event.usage, event.image?.billingMetrics);
    return {
      type: "response.image_generation_call.completed",
      response_id: requestId,
      model,
      output_index: event.outputIndex ?? 0,
      image_b64: event.image?.base64 || "",
      mime_type: event.image?.mimeType,
      revised_prompt: event.image?.revisedPrompt,
      usage,
    };
  }

  if (event.type === "audio-chunk") {
    return {
      type: "response.output_audio.delta",
      response_id: requestId,
      model,
      delta: event.audio?.base64 || "",
      sequence_index: event.audio?.sequenceIndex ?? 0,
      mime_type: event.audio?.mimeType,
      ...(event.audio?.sampleRate ? { sample_rate: event.audio.sampleRate } : {}),
      ...(event.audio?.channels ? { channels: event.audio.channels } : {}),
      ...(event.audio?.format ? { format: event.audio.format } : {}),
    };
  }

  if (event.type === "subtitle") {
    return {
      type: "response.output_audio.subtitle",
      response_id: requestId,
      model,
      subtitle: event.subtitle,
    };
  }

  if (event.type === "output-item") {
    return {
      type: "response.output_item.done",
      response_id: requestId,
      output_index: event.outputIndex ?? 0,
      item: event.item ?? { type: "output_text", role: "assistant", text: "" },
    };
  }

  if (event.type === "status") {
    const isVideo = Boolean(event.videoStatus || event.video);
    if (isVideo) {
      return {
        type: "response.output_video.status",
        response_id: requestId,
        model,
        job_id: event.videoStatus?.jobId || event.video?.jobId || "",
        status: event.videoStatus?.status || event.video?.status || "processing",
        progress: event.videoStatus?.progress ?? event.video?.progress,
        url: event.videoStatus?.url || event.video?.url,
        error: event.videoStatus?.error,
      };
    }
    return {
      type: "response.status",
      response_id: requestId,
      model,
      status: "processing",
      usage: event.usage ? responseUsage(event.usage) : undefined,
    };
  }

  if (event.type === "video-status") {
    return {
      type: "response.output_video.status",
      response_id: requestId,
      model,
      job_id: event.videoStatus?.jobId || "",
      status: event.videoStatus?.status || "processing",
      progress: event.videoStatus?.progress,
      url: event.videoStatus?.url,
      error: event.videoStatus?.error,
    };
  }

  if (event.type === "video-complete") {
    return {
      type: "response.output_item.done",
      response_id: requestId,
      output_index: event.outputIndex ?? 0,
      item: {
        type: "output_video",
        role: "assistant",
        video_url: event.video?.url,
        job_id: event.video?.jobId,
        status: event.video?.status || "completed",
        progress: event.video?.progress ?? 100,
        mime_type: event.video?.mimeType,
      },
    };
  }

  return {
    type: "response.completed",
    response_id: requestId,
    model,
    finish_reason: event.finishReason || "stop",
    usage: responseUsage(event.usage),
  };
}

export function toChatStreamEvent(
  requestId: string,
  model: string,
  event: Event,
  isFirstToken = false,
): Record<string, unknown> {
  if (event.type === "text-delta") {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirstToken ? { role: "assistant" } : {}),
            content: event.text || "",
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "thinking" || event.type === "reasoning-delta") {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirstToken ? { role: "assistant" } : {}),
            reasoning_content: event.thinking || event.text || "",
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "citation" || event.type === "warning" || event.type === "error" || event.type === "audio-chunk" || event.type === "subtitle" || event.type === "status" || event.type === "video-status" || event.type === "video-complete") {
    return toResponsesStreamEvent(requestId, model, event);
  }

  if (event.type === "tool-call") {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirstToken ? { role: "assistant" } : {}),
            tool_calls: [
              {
                index: event.toolCall?.index ?? 0,
                id: event.toolCall?.id,
                type: "function",
                function: {
                  name: event.toolCall?.name,
                  arguments: event.toolCall?.arguments,
                },
                ...(event.toolCall?.providerMetadata ? { providerMetadata: event.toolCall.providerMetadata } : {}),
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === "tool-call-delta") {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            ...(isFirstToken ? { role: "assistant" } : {}),
            tool_calls: [
              {
                index: event.toolCallDelta?.index ?? 0,
                ...(event.toolCallDelta?.id ? { id: event.toolCallDelta.id } : {}),
                type: "function",
                function: {
                  ...(event.toolCallDelta?.name ? { name: event.toolCallDelta.name } : {}),
                  ...(event.toolCallDelta?.arguments ? { arguments: event.toolCallDelta.arguments } : {}),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: toOpenAIChatFinishReason(event.finishReason),
      },
    ],
  };
}

export function toChatUsageStreamEvent(
  requestId: string,
  model: string,
  usage: Usage,
): Record<string, unknown> {
  const cacheWriteTokens = usageCacheWriteTokens(usage);
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: usageCacheReadTokens(usage),
        ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
      },
      completion_tokens_details: {
        reasoning_tokens: usage.reasoningTokens ?? 0,
      },
    },
  };
}

export function createErrorResponse(message: string, type: string, code?: string, param?: string): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = { message, type };
  if (code) error.code = code;
  if (param) error.param = param;
  return { error };
}
