import { getModelById } from "../models-registry.js";
import type { UnifiedMessage, UnifiedUsage } from "../core.js";

interface AlibabaBases {
  origin: string;
  apiBase: string;
  compatibleBase: string;
  compatibleApiBase: string;
}

type AlibabaRoute =
  | "openai_chat"
  | "openai_embeddings"
  | "openai_image"
  | "dashscope_multimodal_generation"
  | "dashscope_multimodal_embeddings"
  | "dashscope_rerank"
  | "dashscope_speech_generation"
  | "dashscope_speech_transcription"
  | "dashscope_video_synthesis";

export interface AlibabaChatResult {
  text: string;
  usage?: UnifiedUsage;
  finishReason?: string;
  raw: unknown;
}

export interface AlibabaEmbeddingResult {
  embeddings: number[][];
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface AlibabaImageResult {
  buffer: Buffer;
  mimeType: string;
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface AlibabaSpeechResult {
  buffer: Buffer;
  mimeType: string;
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface AlibabaTranscriptionResult {
  text: string;
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface AlibabaVideoSubmission {
  jobId: string;
  status: "queued" | "processing";
  duration?: number;
  raw: unknown;
}

export interface AlibabaVideoStatus {
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

function credential(): string {
  const apiKey = clean(process.env.ALIBABA_CLOUD_API_KEY);
  if (!apiKey) {
    throw new Error("ALIBABA_CLOUD_API_KEY is not configured");
  }
  return apiKey;
}

function sourceMetadata(modelId: string): Record<string, unknown> {
  const card = getModelById(modelId, "alibaba");
  const source = asRecord(card?.sourceMetadata);
  const alibaba = asRecord(source?.alibaba);
  if (!alibaba) {
    throw new Error(`Alibaba metadata is missing for model: ${modelId}`);
  }
  return alibaba;
}

function basesForModel(modelId: string): AlibabaBases {
  const metadata = sourceMetadata(modelId);
  const endpoint = asRecord(metadata.endpoint);
  const origin = clean(endpoint?.origin) || "https://dashscope-intl.aliyuncs.com";
  return {
    origin,
    apiBase: clean(endpoint?.apiBase) || `${origin}/api/v1`,
    compatibleBase: clean(endpoint?.compatibleBase) || `${origin}/compatible-mode/v1`,
    compatibleApiBase: clean(endpoint?.compatibleApiBase) || `${origin}/compatible-api/v1`,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => clean(entry)).filter(Boolean);
}

function modelTypes(modelId: string): string[] {
  const card = getModelById(modelId, "alibaba");
  const rawTypes = Array.isArray(card?.type) ? card.type : [card?.type];
  return rawTypes.map((type) => clean(type).toLowerCase()).filter(Boolean);
}

function routeForModel(modelId: string): AlibabaRoute {
  const metadata = sourceMetadata(modelId);
  const capabilities = new Set(stringList(metadata.capabilities));
  const types = new Set(modelTypes(modelId));
  const compatible = metadata.openAICompatible === true;

  if (capabilities.has("TR") && compatible) return "openai_embeddings";
  if (capabilities.has("ME")) return "dashscope_multimodal_embeddings";
  if (capabilities.has("TR")) return "dashscope_rerank";
  if (types.has("feature-extraction") && compatible) return "openai_embeddings";
  if (types.has("image-generation")) return "dashscope_multimodal_generation";
  if (types.has("videos")) return "dashscope_video_synthesis";
  if (types.has("text-to-speech")) return "dashscope_speech_generation";
  if (types.has("automatic-speech-recognition")) return "dashscope_speech_transcription";
  if (compatible) return "openai_chat";
  return "dashscope_multimodal_generation";
}

async function postJson(url: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential()}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Alibaba provider HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  const record = asRecord(parsed);
  const code = clean(record?.code);
  if (code && code.toLowerCase() !== "success" && code.toLowerCase() !== "ok") {
    throw new Error(`Alibaba provider error ${code}: ${clean(record?.message) || text.slice(0, 500)}`);
  }
  return parsed;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${credential()}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Alibaba provider HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

function usageFromOpenAI(value: unknown): UnifiedUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const promptTokens = typeof usage.prompt_tokens === "number"
    ? usage.prompt_tokens
    : typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : 0;
  const completionTokens = typeof usage.completion_tokens === "number"
    ? usage.completion_tokens
    : typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    raw: usage,
  };
}

function usageFromDashScope(raw: unknown): UnifiedUsage | undefined {
  const root = asRecord(raw);
  const usage = asRecord(root?.usage) || asRecord(asRecord(root?.output)?.usage);
  return usageFromOpenAI(usage);
}

function messageText(message: UnifiedMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function primaryText(messages: UnifiedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      const text = messageText(messages[index]);
      if (text) return text;
    }
  }
  return "";
}

function urlFromPart(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return clean(record?.url) || undefined;
}

function findUrl(messages: UnifiedMessage[], type: "image_url" | "input_audio" | "video_url"): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index].content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== type) continue;
      if (type === "image_url") return urlFromPart(part.image_url);
      if (type === "input_audio") return urlFromPart(part.input_audio);
      return urlFromPart(part.video_url);
    }
  }
  return undefined;
}

function dashscopeContent(message: UnifiedMessage): Array<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return message.content ? [{ text: message.content }] : [];
  }
  if (!Array.isArray(message.content)) return [];

  const content: Array<Record<string, unknown>> = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) {
      content.push({ text: part.text });
    } else if (part.type === "image_url") {
      const url = urlFromPart(part.image_url);
      if (url) content.push({ image: url });
    } else if (part.type === "input_audio") {
      const url = urlFromPart(part.input_audio);
      if (url) content.push({ audio: url });
    } else if (part.type === "video_url") {
      const url = urlFromPart(part.video_url);
      if (url) content.push({ video: url });
    }
  }
  return content;
}

function dashscopeMessages(messages: UnifiedMessage[]): Array<Record<string, unknown>> {
  return messages
    .map((message) => ({
      role: message.role === "tool" ? "assistant" : message.role,
      content: dashscopeContent(message),
    }))
    .filter((message) => Array.isArray(message.content) && message.content.length > 0);
}

function textFromOpenAIChat(raw: unknown): { text: string; finishReason?: string; usage?: UnifiedUsage } {
  const root = asRecord(raw) || {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  return {
    text: clean(message.content),
    finishReason: clean(first.finish_reason) || undefined,
    usage: usageFromOpenAI(root.usage),
  };
}

function dashscopeContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      return clean(record?.text) || clean(record?.content);
    })
    .filter(Boolean)
    .join("\n");
}

function textFromDashScope(raw: unknown): string {
  const root = asRecord(raw) || {};
  const output = asRecord(root.output) || root;
  const text = clean(output.text) || clean(output.output_text);
  if (text) return text;

  const choices = Array.isArray(output.choices) ? output.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  return clean(message.content) || dashscopeContentText(message.content);
}

async function bufferFromPayload(payload: string, fallbackMimeType = "application/octet-stream"): Promise<{ buffer: Buffer; mimeType: string }> {
  if (/^data:/i.test(payload)) {
    const match = payload.match(/^data:([^;,]+)?;base64,(.+)$/i);
    if (!match) throw new Error("Alibaba response contained an invalid data URL");
    return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] || fallbackMimeType };
  }

  if (/^https?:\/\//i.test(payload)) {
    const response = await fetch(payload);
    if (!response.ok) throw new Error(`Failed to download Alibaba media URL: ${response.status}`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") || fallbackMimeType,
    };
  }

  return { buffer: Buffer.from(payload, "base64"), mimeType: fallbackMimeType };
}

function findMediaPayload(raw: unknown, keys: string[]): string {
  const root = asRecord(raw) || {};
  const output = asRecord(root.output) || root;

  for (const key of keys) {
    const value = clean(output[key]) || clean(root[key]);
    if (value) return value;
  }

  const data = Array.isArray(root.data) ? root.data : [];
  for (const item of data) {
    const record = asRecord(item);
    if (!record) continue;
    for (const key of keys) {
      const value = clean(record[key]);
      if (value) return value;
    }
  }

  for (const container of [asRecord(output.audio), asRecord(output.image), asRecord(output.video)]) {
    if (!container) continue;
    for (const key of keys) {
      const value = clean(container[key]);
      if (value) return value;
    }
  }

  const choices = Array.isArray(output.choices) ? output.choices : [];
  for (const choice of choices) {
    const message = asRecord(asRecord(choice)?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const record = asRecord(part);
      if (!record) continue;
      for (const key of keys) {
        const value = clean(record[key]);
        if (value) return value;
      }
    }
  }

  return "";
}

function dashscopeImageSize(size: string | undefined): string | undefined {
  const value = clean(size);
  if (!value) return undefined;
  return value.replace(/^(\d+)x(\d+)$/i, "$1*$2");
}

export async function generateAlibabaChat(
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
): Promise<AlibabaChatResult> {
  const route = routeForModel(modelId);
  if (route === "dashscope_rerank") {
    return generateAlibabaRerank(modelId, messages, options.customParams);
  }

  const bases = basesForModel(modelId);
  if (route === "openai_chat") {
    const raw = await postJson(`${bases.compatibleBase}/chat/completions`, {
      model: modelId,
      messages,
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    });
    return { ...textFromOpenAIChat(raw), raw };
  }

  const raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, {
    model: modelId,
    input: { messages: dashscopeMessages(messages) },
    parameters: {
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { max_tokens: options.maxTokens } : {}),
      ...(options.customParams || {}),
    },
  });

  const text = textFromDashScope(raw);
  return {
    text,
    usage: usageFromDashScope(raw),
    finishReason: "stop",
    raw,
  };
}

async function generateAlibabaRerank(
  modelId: string,
  messages: UnifiedMessage[],
  customParams: Record<string, unknown> = {},
): Promise<AlibabaChatResult> {
  const documents = Array.isArray(customParams.documents)
    ? customParams.documents
    : Array.isArray(customParams.texts)
      ? customParams.texts
      : [];
  if (documents.length === 0) {
    throw new Error("Alibaba rerank requires custom_params.documents");
  }

  const bases = basesForModel(modelId);
  const query = clean(customParams.query) || primaryText(messages);
  const raw = await postJson(`${bases.compatibleApiBase}/reranks`, {
    model: modelId,
    query,
    documents,
    ...(typeof customParams.top_n === "number" ? { top_n: customParams.top_n } : {}),
    ...(typeof customParams.return_documents === "boolean" ? { return_documents: customParams.return_documents } : {}),
  });

  const root = asRecord(raw) || {};
  return {
    text: JSON.stringify(raw),
    usage: usageFromOpenAI(root.usage) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { request: 1, document: documents.length },
    },
    finishReason: "stop",
    raw,
  };
}

export async function generateAlibabaEmbeddings(modelId: string, input: string[]): Promise<AlibabaEmbeddingResult> {
  const route = routeForModel(modelId);
  const bases = basesForModel(modelId);

  if (route === "openai_embeddings") {
    const raw = await postJson(`${bases.compatibleBase}/embeddings`, {
      model: modelId,
      input,
    });
    const root = asRecord(raw) || {};
    const data = Array.isArray(root.data) ? root.data : [];
    const embeddings = data
      .map((item) => asRecord(item)?.embedding)
      .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((value) => typeof value === "number"));
    return { embeddings, usage: usageFromOpenAI(root.usage), raw };
  }

  const raw = await postJson(`${bases.apiBase}/services/embeddings/multimodal-embedding/multimodal-embedding`, {
    model: modelId,
    input: {
      contents: input.map((text) => ({ text })),
    },
  });
  const output = asRecord(asRecord(raw)?.output) || {};
  const embeddings = (Array.isArray(output.embeddings) ? output.embeddings : [])
    .map((item) => asRecord(item)?.embedding)
    .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((value) => typeof value === "number"));
  return { embeddings, usage: usageFromDashScope(raw), raw };
}

export async function generateAlibabaImage(
  modelId: string,
  prompt: string,
  options: {
    n?: number;
    size?: string;
    quality?: string;
    imageUrl?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<AlibabaImageResult> {
  const route = routeForModel(modelId);
  const bases = basesForModel(modelId);
  const customParams = options.customParams || {};
  let raw: unknown;

  if (route === "openai_image") {
    raw = await postJson(`${bases.compatibleBase}/images/generations`, {
      model: modelId,
      prompt,
      response_format: "b64_json",
      ...(typeof options.n === "number" ? { n: options.n } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
      ...customParams,
    });
  } else {
    raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, {
      model: modelId,
      input: {
        messages: [{
          role: "user",
          content: [
            { text: prompt },
            ...(options.imageUrl ? [{ image: options.imageUrl }] : []),
          ],
        }],
      },
      parameters: {
        ...(dashscopeImageSize(options.size) ? { size: dashscopeImageSize(options.size) } : {}),
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...customParams,
      },
    });
  }

  const payload = findMediaPayload(raw, ["b64_json", "image", "image_url", "url"]);
  if (!payload) throw new Error("Alibaba returned no image data");
  const image = await bufferFromPayload(payload, "image/png");
  return {
    ...image,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { request: 1, image: options.n || 1 },
    },
    raw,
  };
}

export async function generateAlibabaSpeech(
  modelId: string,
  text: string,
  options: {
    voice?: string;
    responseFormat?: string;
    speed?: number;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<AlibabaSpeechResult> {
  const bases = basesForModel(modelId);
  const customParams = options.customParams || {};
  const raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, {
    model: modelId,
    input: {
      text,
      ...(options.voice ? { voice: options.voice } : {}),
    },
    parameters: {
      ...(options.responseFormat ? { format: options.responseFormat } : {}),
      ...(typeof options.speed === "number" ? { speed: options.speed } : {}),
      ...customParams,
    },
  });

  const payload = findMediaPayload(raw, ["audio", "audio_url", "url"]);
  if (!payload) throw new Error("Alibaba returned no audio data");
  const audio = await bufferFromPayload(payload, "audio/mpeg");
  return {
    ...audio,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { character: Array.from(text).length },
    },
    raw,
  };
}

export async function transcribeAlibabaAudio(
  modelId: string,
  audioUrl: string | undefined,
  audioBuffer: Buffer | undefined,
  options: { language?: string; responseFormat?: string; customParams?: Record<string, unknown> } = {},
): Promise<AlibabaTranscriptionResult> {
  const bases = basesForModel(modelId);
  const audio = audioUrl || (audioBuffer ? `data:audio/mpeg;base64,${audioBuffer.toString("base64")}` : "");
  if (!audio) throw new Error("Alibaba speech transcription requires audio input");

  const raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, {
    model: modelId,
    input: {
      messages: [{
        role: "user",
        content: [{ audio }],
      }],
    },
    parameters: {
      ...(options.language ? { language: options.language } : {}),
      ...(options.responseFormat ? { format: options.responseFormat } : {}),
      ...(options.customParams || {}),
    },
  });

  const text = textFromDashScope(raw);
  return {
    text,
    usage: usageFromDashScope(raw) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { request: 1 },
    },
    raw,
  };
}

export async function submitAlibabaVideo(
  modelId: string,
  prompt: string,
  options: {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    imageUrl?: string;
    videoUrl?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<AlibabaVideoSubmission> {
  const bases = basesForModel(modelId);
  const raw = await postJson(`${bases.apiBase}/services/aigc/video-generation/video-synthesis`, {
    model: modelId,
    input: {
      prompt,
      ...(options.imageUrl ? { img_url: options.imageUrl, image_url: options.imageUrl } : {}),
      ...(options.videoUrl ? { video_url: options.videoUrl } : {}),
    },
    parameters: {
      ...(typeof options.duration === "number" ? { duration: options.duration } : {}),
      ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
      ...(options.resolution ? { resolution: options.resolution } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.customParams || {}),
    },
  }, { "X-DashScope-Async": "enable" });

  const output = asRecord(asRecord(raw)?.output) || {};
  const taskId = clean(output.task_id) || clean(output.taskId) || clean(asRecord(raw)?.task_id);
  if (!taskId) {
    throw new Error("Alibaba video submission returned no task id");
  }

  const status = clean(output.task_status).toUpperCase() === "PENDING" ? "queued" : "processing";
  return { jobId: `alibaba:${taskId}`, status, raw };
}

export async function retrieveAlibabaVideo(providerJobId: string): Promise<AlibabaVideoStatus> {
  const bases: AlibabaBases = {
    origin: "https://dashscope-intl.aliyuncs.com",
    apiBase: "https://dashscope-intl.aliyuncs.com/api/v1",
    compatibleBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    compatibleApiBase: "https://dashscope-intl.aliyuncs.com/compatible-api/v1",
  };
  const raw = await getJson(`${bases.apiBase}/tasks/${encodeURIComponent(providerJobId)}`);
  const root = asRecord(raw) || {};
  const output = asRecord(root.output) || root;
  const taskStatus = clean(output.task_status || root.task_status).toUpperCase();
  const error = clean(output.message) || clean(root.message) || clean(asRecord(output.task_metrics)?.failed);
  const url = clean(output.video_url)
    || clean(output.output_video_url)
    || clean(output.url)
    || clean(asRecord(output.results)?.video_url);

  if (taskStatus === "SUCCEEDED" || taskStatus === "SUCCESS" || taskStatus === "COMPLETED") {
    return { status: "completed", url };
  }
  if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "CANCELLED") {
    return { status: "failed", error: error || "Alibaba video generation failed" };
  }
  if (taskStatus === "PENDING") {
    return { status: "queued", progress: 0 };
  }
  return { status: "processing" };
}
