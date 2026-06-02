import {
  resolveOptionalModelParamValues,
  resolveProvidedOptionalModelParamValues,
} from "./params-handler.js";
import { getModelById } from "./catalog/registry.js";
import {
  getModelCapabilities,
  type ModelOperationCapability,
} from "./catalog/modalities/index.js";

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
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Schema;
  };
}

export type Choice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

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
  billingMetrics?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface Call {
  id?: string;
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
  usage?: Usage;
  finishReason?: string;
  toolCalls?: Call[];
  embeddings?: number[][];
  media?: Media;
}

export interface Event {
  type:
  | "created"
  | "text-delta"
  | "tool-call"
  | "tool-call-delta"
  | "thinking"
  | "image-partial"
  | "image-complete"
  | "output-item"
  | "video-status"
  | "done";
  text?: string;
  toolCall?: { id: string; name: string; arguments: string; providerMetadata?: Record<string, unknown> };
  toolCallDelta?: { id?: string; name?: string; arguments?: string; index: number };
  thinking?: string;
  outputIndex?: number;
  item?: ResponsesOutputItem;
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
  usage?: Usage;
  finishReason?: string;
}

export type Result = Output;

export interface Model {
  generate(request: Request): Promise<Output>;
  stream?(request: Request): AsyncIterable<Event>;
}

export interface ResponsesOutputItem {
  type: string;
  role?: "assistant";
  text?: string;
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  embedding?: number[];
  job_id?: string;
  status?: string;
  progress?: number;
  mime_type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

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

function responseUsage(usage: Usage | undefined, extraMetrics?: Record<string, unknown>): ResponsesResponse["usage"] {
  if (!usage) return undefined;
  const billingMetrics = mergeBillingMetrics(usage.billingMetrics, extraMetrics);
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    ...(billingMetrics ? { billingMetrics } : {}),
  };
}

function toResponseId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
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
  "frequency_penalty",
  "include",
  "logit_bias",
  "metadata",
  "parallel_tool_calls",
  "presence_penalty",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "reasoning_effort",
  "seed",
  "service_tier",
  "store",
  "stream_options",
  "text",
  "top_p",
  "user",
] as const;

function params(body: Record<string, unknown>): Record<string, unknown> | null {
  const output: Record<string, unknown> = {};
  for (const key of PASS) {
    const value = body[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }

  const cache = pickStringValue(body.promptCacheKey);
  if (cache) output.prompt_cache_key = cache;
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
      normalized.push({ type: "text", text: part.text });
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
        toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : undefined,
        toolName: typeof part.toolName === "string" ? part.toolName : typeof part.name === "string" ? part.name : undefined,
        input: part.input ?? part.args ?? {},
      });
      continue;
    }

    if (type === "tool-result" || type === "tool_result") {
      normalized.push({
        type: "tool-result",
        toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : undefined,
        toolName: typeof part.toolName === "string" ? part.toolName : undefined,
        output: part.output ?? part.result,
      });
      continue;
    }

    normalized.push({ type: "text", text: JSON.stringify(part) });
  }

  return normalized;
}

function normalizeMessages(input: unknown): Message[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((msg) => !!msg && typeof msg === "object")
    .map((msg) => {
      const message = msg as Record<string, unknown>;
      const role = parseRole(message.role);
      const content = message.content;

      if (Array.isArray(content)) {
        return {
          role,
          content: normalizeContentParts(content),
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as Message["tool_calls"] : undefined,
          tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
          name: typeof message.name === "string" ? message.name : undefined,
        } satisfies Message;
      }

      return {
        role,
        content: typeof content === "string" ? content : content == null ? null : String(content),
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as Message["tool_calls"] : undefined,
        tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
        name: typeof message.name === "string" ? message.name : undefined,
      } satisfies Message;
    });
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

function normalizeResponsesInput(input: unknown): Message[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  if (input.length === 0) {
    return [];
  }

  const first = input[0];
  if (first && typeof first === "object" && "role" in (first as Record<string, unknown>)) {
    return normalizeMessages(input);
  }

  const parts: Part[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

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

  if (parts.length === 0) {
    return [];
  }

  return [{ role: "user", content: parts }];
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
  const candidates = capabilities
    .filter((capability) => explicitModalities.length === 0 || explicitModalities.includes(capability.modality))
    .filter((capability) => !explicitOperation || capability.operation === explicitOperation)
    .filter((capability) => capabilityAcceptsInput(capability, inputKinds));

  const nonTextInputs = inputKinds.filter((kind) => kind !== "text");
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
  const rawCustomParams = asRecord(body.custom_params);
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
    tools: Array.isArray(body.tools) ? body.tools as Tool[] : undefined,
    toolChoice: body.tool_choice as Choice | undefined,
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
  const messages = appendAttachmentParts(
    normalizeResponsesInput(body.input),
    normalizeAttachmentList(body),
  );
  const route = pickCatalogRoute(body, model, messages, "text");
  const modality = route.modality;
  const promptText = getPrimaryText(messages);
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
  const previousResponseId =
    typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const rawCustomParams = asRecord(body.custom_params);
  const passParams = params(body);
  const resolvedModelParams = resolveOptionalModelParamValues(model, modality, body);
  const providedModelParams = resolveProvidedOptionalModelParamValues(model, modality, body);
  const providedParams = {
    ...(passParams || {}),
    ...(rawCustomParams || {}),
    ...(providedModelParams?.values ?? {}),
  };
  const billingParams = {
    ...(passParams || {}),
    ...(rawCustomParams || {}),
    ...(resolvedModelParams?.values ?? {}),
  };
  const customParams = Object.keys(providedParams).length > 0 ? providedParams : undefined;
  const customParamsRecord = asRecord(customParams);

  return {
    mode: "responses",
    model,
    stream: body.stream === true,
    modality,
    ...(route.operation ? { operation: route.operation } : {}),
    messages,
    instructions,
    tools: Array.isArray(body.tools) ? body.tools as Tool[] : undefined,
    toolChoice: body.tool_choice as Choice | undefined,
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
    customParams,
    responseFormat: modality === "text" ? parseInboundResponseFormat(body.response_format) : undefined,
    billingMetrics: (modality === "image" || modality === "video" || modality === "audio")
      ? buildRequestBillingMetrics(modality, billingParams, promptText)
      : undefined,
  };
}

export function toResponsesOutputItems(output: Output): ResponsesOutputItem[] {
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
  const text = output.content || "";
  items.push({ type: "output_text", role: "assistant", text });

  if (output.toolCalls?.length) {
    for (const call of output.toolCalls) {
      items.push({
        type: "tool_call",
        call_id: call.id || `call_${Date.now()}`,
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
        ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
      } as ResponsesOutputItem);
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
 * Used for out-of-band events like `compose.receipt`, `compose.error`,
 * `compose.video.status`, and `compose.budget` that are semantically distinct
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
export interface ReceiptBillPayload {
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
  children?: ReceiptBillPayload[];
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
  bills?: ReceiptBillPayload[];
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
  return formatSSENamedEvent("compose.receipt", payload);
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
  return formatSSENamedEvent("compose.video.status", payload);
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
      model,
      delta: event.text || "",
    };
  }

  if (event.type === "thinking") {
    return {
      type: "response.reasoning.delta",
      response_id: requestId,
      model,
      delta: event.thinking || "",
    };
  }

  if (event.type === "tool-call") {
    return {
      type: "response.tool_call",
      response_id: requestId,
      model,
      tool_call: event.toolCall,
    };
  }

  if (event.type === "tool-call-delta") {
    return {
      type: "response.tool_call.delta",
      response_id: requestId,
      model,
      index: event.toolCallDelta?.index ?? 0,
      delta: {
        ...(event.toolCallDelta?.id ? { id: event.toolCallDelta.id } : {}),
        ...(event.toolCallDelta?.name ? { name: event.toolCallDelta.name } : {}),
        ...(event.toolCallDelta?.arguments ? { arguments: event.toolCallDelta.arguments } : {}),
      },
    };
  }

  if (event.type === "image-partial") {
    return {
      type: "response.image_generation_call.partial_image",
      response_id: requestId,
      model,
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
      image_b64: event.image?.base64 || "",
      mime_type: event.image?.mimeType,
      revised_prompt: event.image?.revisedPrompt,
      usage,
    };
  }

  if (event.type === "output-item") {
    return {
      type: "response.output_item.completed",
      response_id: requestId,
      model,
      output_index: event.outputIndex ?? 0,
      item: event.item ?? { type: "output_text", role: "assistant", text: "" },
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

  if (event.type === "thinking") {
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
            reasoning_content: event.thinking || "",
          },
          finish_reason: null,
        },
      ],
    };
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
                index: 0,
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
    },
  };
}

export function createErrorResponse(message: string, type: string, code?: string, param?: string): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = { message, type };
  if (code) error.code = code;
  if (param) error.param = param;
  return { error };
}
