import type { ModelProvider } from "./types.js";
import { resolveOptionalModelParamValues } from "./params-handler.js";

export type UnifiedMode = "responses" | "chat" | "embeddings";
export type UnifiedModality = "text" | "image" | "audio" | "video" | "embedding";

export interface UnifiedContentPart {
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

export interface UnifiedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | UnifiedContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface UnifiedTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type UnifiedToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface UnifiedRequest {
  mode: UnifiedMode;
  model: string;
  provider?: ModelProvider;
  stream: boolean;
  modality: UnifiedModality;
  messages: UnifiedMessage[];
  instructions?: string;
  tools?: UnifiedTool[];
  toolChoice?: UnifiedToolChoice;
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
  };
  previousResponseId?: string;
  customParams?: Record<string, unknown>;
  billingMetrics?: Record<string, unknown>;
}

export interface UnifiedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  billingMetrics?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface UnifiedToolCall {
  id?: string;
  name: string;
  arguments: string | object;
}

export interface UnifiedOutput {
  modality: UnifiedModality;
  content?: string;
  usage?: UnifiedUsage;
  finishReason?: string;
  toolCalls?: UnifiedToolCall[];
  embeddings?: number[][];
  media?: {
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
  };
}

export interface UnifiedStreamEvent {
  type: "text-delta" | "tool-call" | "tool-call-delta" | "thinking" | "image-partial" | "image-complete" | "done";
  text?: string;
  toolCall?: { id: string; name: string; arguments: string };
  toolCallDelta?: { id?: string; name?: string; arguments?: string; index: number };
  thinking?: string;
  image?: {
    base64: string;
    index?: number;
    mimeType?: string;
    revisedPrompt?: string;
    duration?: number;
    generatedUnits?: number;
    billingMetrics?: Record<string, unknown>;
  };
  usage?: UnifiedUsage;
  finishReason?: string;
}

export interface ResponsesOutputItem {
  type: string;
  role?: "assistant";
  text?: string;
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  embedding?: number[];
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
  };
}

function toResponseId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function parseRole(role: unknown): UnifiedMessage["role"] {
  if (role === "system" || role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

function normalizeContentParts(parts: unknown[]): UnifiedContentPart[] {
  const normalized: UnifiedContentPart[] = [];

  for (const item of parts) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const part = item as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text" && typeof part.text === "string") {
      normalized.push({ type: "text", text: part.text });
      continue;
    }

    if (type === "image_url") {
      const image = part.image_url;
      const url = typeof image === "string" ? image : (image as { url?: string } | undefined)?.url;
      if (url) normalized.push({ type: "image_url", image_url: { url } });
      continue;
    }

    if (type === "input_audio") {
      const audio = part.input_audio;
      const url = typeof audio === "string" ? audio : (audio as { url?: string } | undefined)?.url;
      if (url) normalized.push({ type: "input_audio", input_audio: { url } });
      continue;
    }

    if (type === "video_url") {
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

function normalizeMessages(input: unknown): UnifiedMessage[] {
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
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as UnifiedMessage["tool_calls"] : undefined,
          tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
          name: typeof message.name === "string" ? message.name : undefined,
        } satisfies UnifiedMessage;
      }

      return {
        role,
        content: typeof content === "string" ? content : content == null ? null : String(content),
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls as UnifiedMessage["tool_calls"] : undefined,
        tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
        name: typeof message.name === "string" ? message.name : undefined,
      } satisfies UnifiedMessage;
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
  }

  return undefined;
}

function getPrimaryText(messages: UnifiedMessage[]): string {
  for (const message of messages) {
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    const text = message.content
      .filter((part): part is UnifiedContentPart & { text: string } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function parseMegapixels(size: string | undefined): number | undefined {
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

  return (width * height) / 1_000_000;
}

function buildRequestBillingMetrics(
  modality: UnifiedModality,
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

    const megapixels = parseMegapixels(pickStringValue(
      resolvedParams.size,
      resolvedParams.image_size,
    ));
    if (typeof megapixels === "number" && typeof generatedUnits === "number" && generatedUnits > 0) {
      metrics.megapixel = megapixels * generatedUnits;
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
    const characters = Array.from(promptText).length;
    if (characters > 0) {
      metrics.character = characters;
    }
  }

  return metrics;
}

function normalizeResponsesInput(input: unknown): UnifiedMessage[] {
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

  const parts: UnifiedContentPart[] = [];
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

function pickModality(body: Record<string, unknown>, fallback: UnifiedModality): UnifiedModality {
  const directModalities = Array.isArray(body.modalities)
    ? body.modalities.filter((m): m is string => typeof m === "string")
    : [];
  const responseObj = body.response;
  const nestedModalities = responseObj && typeof responseObj === "object" && Array.isArray((responseObj as Record<string, unknown>).modalities)
    ? ((responseObj as Record<string, unknown>).modalities as unknown[]).filter((m): m is string => typeof m === "string")
    : [];

  const modalities = [...directModalities, ...nestedModalities].map((m) => m.toLowerCase());

  if (modalities.includes("image")) return "image";
  if (modalities.includes("audio")) return "audio";
  if (modalities.includes("video")) return "video";
  if (modalities.includes("embedding") || modalities.includes("embeddings")) return "embedding";
  if (modalities.includes("text")) return "text";

  return fallback;
}

export function normalizeChatRequest(body: Record<string, unknown>): UnifiedRequest {
  const model = typeof body.model === "string" ? body.model : "";
  const messages = normalizeMessages(body.messages);

  return {
    mode: "chat",
    model,
    provider: typeof body.provider === "string" ? body.provider as ModelProvider : undefined,
    stream: Boolean(body.stream),
    modality: "text",
    messages,
    tools: Array.isArray(body.tools) ? body.tools as UnifiedTool[] : undefined,
    toolChoice: body.tool_choice as UnifiedToolChoice | undefined,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    responseId: toResponseId(),
  };
}

export function normalizeEmbeddingsRequest(body: Record<string, unknown>): UnifiedRequest {
  const model = typeof body.model === "string" ? body.model : "";
  const input = body.input;

  return {
    mode: "embeddings",
    model,
    provider: typeof body.provider === "string" ? body.provider as ModelProvider : undefined,
    stream: false,
    modality: "embedding",
    messages: [],
    responseId: toResponseId(),
    embeddingInput: (typeof input === "string" || Array.isArray(input)) ? input as string | string[] : "",
    embeddingDimensions: typeof body.dimensions === "number" ? body.dimensions : undefined,
  };
}

export function normalizeResponsesRequest(body: Record<string, unknown>): UnifiedRequest {
  const model = typeof body.model === "string" ? body.model : "";
  const modality = pickModality(body, "text");
  const messages = normalizeResponsesInput(body.input);
  const promptText = getPrimaryText(messages);
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
  const previousResponseId =
    typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const rawCustomParams = asRecord(body.custom_params);
  const resolvedModelParams = modality === "image" || modality === "video"
    ? resolveOptionalModelParamValues(model, modality, body)
    : null;
  const resolvedParams = {
    ...(rawCustomParams || {}),
    ...(resolvedModelParams?.values ?? {}),
  };
  const customParams = Object.keys(resolvedParams).length > 0 ? resolvedParams : undefined;
  const customParamsRecord = asRecord(customParams);

  return {
    mode: "responses",
    model,
    provider: typeof body.provider === "string" ? body.provider as ModelProvider : undefined,
    stream: Boolean(body.stream),
    modality,
    messages,
    instructions,
    tools: Array.isArray(body.tools) ? body.tools as UnifiedTool[] : undefined,
    toolChoice: body.tool_choice as UnifiedToolChoice | undefined,
    maxTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    responseId: toResponseId(),
    embeddingInput: modality === "embedding"
      ? (typeof body.input === "string" || Array.isArray(body.input) ? body.input as string | string[] : "")
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
    },
    previousResponseId,
    customParams,
    billingMetrics: (modality === "image" || modality === "video" || modality === "audio")
      ? buildRequestBillingMetrics(modality, resolvedParams, promptText)
      : undefined,
  };
}

export function toResponsesResponse(model: string, requestId: string, output: UnifiedOutput): ResponsesResponse {
  const created = Math.floor(Date.now() / 1000);
  const usage = output.usage
    ? {
      input_tokens: output.usage.promptTokens,
      output_tokens: output.usage.completionTokens,
      total_tokens: output.usage.totalTokens,
    }
    : undefined;

  const response: ResponsesResponse = {
    id: requestId,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output: [],
    ...(usage ? { usage } : {}),
  };

  if (output.modality === "embedding") {
    response.output = (output.embeddings || []).map((embedding) => ({
      type: "output_embedding",
      role: "assistant",
      embedding,
    }));
    return response;
  }

  if (output.modality === "image") {
    const url = output.media?.url || (output.media?.base64 ? `data:${output.media.mimeType};base64,${output.media.base64}` : undefined);
    response.output = [{ type: "output_image", role: "assistant", ...(url ? { image_url: url } : {}) }];
    return response;
  }

  if (output.modality === "audio") {
    const url = output.media?.url || (output.media?.base64 ? `data:${output.media.mimeType};base64,${output.media.base64}` : undefined);
    response.output = [{ type: "output_audio", role: "assistant", ...(url ? { audio_url: url } : {}) }];
    return response;
  }

  if (output.modality === "video") {
    const url = output.media?.url || (output.media?.base64 ? `data:${output.media.mimeType};base64,${output.media.base64}` : undefined);
    response.output = [{ type: "output_video", role: "assistant", ...(url ? { video_url: url } : {}) }];
    return response;
  }

  const text = output.content || "";
  response.output.push({ type: "output_text", role: "assistant", text });
  if (output.toolCalls?.length) {
    for (const call of output.toolCalls) {
      response.output.push({
        type: "tool_call",
        call_id: call.id || `call_${Date.now()}`,
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      });
    }
  }
  return response;
}

export function toChatCompletionsResponse(model: string, requestId: string, output: UnifiedOutput): ChatCompletionsResponse {
  const usage = output.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

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
              })),
            }
            : {}),
        },
        finish_reason: output.finishReason || (output.toolCalls?.length ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

export function toEmbeddingsResponse(model: string, output: UnifiedOutput): EmbeddingsResponse {
  const promptTokens = output.usage?.promptTokens || 0;
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
export interface ComposeReceiptStreamPayload {
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
  txHash?: string;
  network?: string;
  settledAt: number;
}

export function toComposeReceiptStreamEvent(
  payload: ComposeReceiptStreamPayload,
): string {
  return formatSSENamedEvent("compose.receipt", payload);
}

export function toComposeErrorStreamEvent(payload: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): string {
  return formatSSENamedEvent("compose.error", payload);
}

export function toComposeVideoStatusStreamEvent(payload: {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress?: number;
  url?: string;
  error?: string;
}): string {
  return formatSSENamedEvent("compose.video.status", payload);
}

export function toResponsesStreamEvent(requestId: string, model: string, event: UnifiedStreamEvent): Record<string, unknown> {
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
    return {
      type: "response.image_generation_call.completed",
      response_id: requestId,
      model,
      image_b64: event.image?.base64 || "",
      mime_type: event.image?.mimeType,
      revised_prompt: event.image?.revisedPrompt,
      usage: event.usage
        ? {
          input_tokens: event.usage.promptTokens,
          output_tokens: event.usage.completionTokens,
          total_tokens: event.usage.totalTokens,
        }
        : undefined,
    };
  }

  return {
    type: "response.completed",
    response_id: requestId,
    model,
    finish_reason: event.finishReason || "stop",
    usage: event.usage
      ? {
        input_tokens: event.usage.promptTokens,
        output_tokens: event.usage.completionTokens,
        total_tokens: event.usage.totalTokens,
      }
      : undefined,
  };
}

export function toChatStreamEvent(
  requestId: string,
  model: string,
  event: UnifiedStreamEvent,
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
        finish_reason: event.finishReason || "stop",
      },
    ],
  };
}

export function toChatUsageStreamEvent(
  requestId: string,
  model: string,
  usage: UnifiedUsage,
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
