import { getModelById } from "../registry.js";
import type { Call, Choice, Event, Message, Tool, Usage } from "../../core.js";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  asRecord,
  bufferFromPayload,
  clean,
  imagesFromResponse,
  normalizeOpenAIUsage,
  primaryText,
  throwHttpError,
} from "../shared/index.js";
import {
  buildChatBody as buildAlibabaChatBody,
  buildEmbeddingsBody as buildAlibabaEmbeddingsBody,
  buildRerankBody as buildAlibabaRerankBody,
  buildWanVideoSubmission,
  findMediaPayload,
  parseChatResponse as parseAlibabaChatResponse,
  parseEmbeddingsResponse as parseAlibabaEmbeddingsResponse,
  readAsyncTaskId,
  textFromDashScope,
  usageFromDashScope,
  type AlibabaVideoRequestContract,
} from "../families/alibaba.js";
import * as zaiFamily from "../families/zai.js";

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
  | "dashscope_image_synthesis"
  | "dashscope_image_edit_synthesis"
  | "dashscope_multimodal_generation"
  | "dashscope_multimodal_embeddings"
  | "dashscope_rerank"
  | "dashscope_speech_generation"
  | "dashscope_speech_transcription"
  | "dashscope_video_synthesis";

export interface AlibabaChatResult {
  text: string;
  reasoning?: string;
  usage?: Usage;
  finishReason?: string;
  toolCalls?: Call[];
  raw: unknown;
}

export interface AlibabaEmbeddingResult {
  embeddings: number[][];
  usage?: Usage;
  raw: unknown;
}

export interface AlibabaImageResult {
  buffer: Buffer;
  mimeType: string;
  images: Array<{ buffer: Buffer; mimeType: string; revisedPrompt?: string }>;
  usage?: Usage;
  raw: unknown;
}

export interface AlibabaSpeechResult {
  buffer: Buffer;
  mimeType: string;
  usage?: Usage;
  raw: unknown;
}

export interface AlibabaTranscriptionResult {
  text: string;
  usage?: Usage;
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
  duration?: number;
  billingMetrics?: Record<string, unknown>;
  usage?: Usage;
  raw: unknown;
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

function videoRequestContractForModel(modelId: string): AlibabaVideoRequestContract | undefined {
  const contract = asRecord(sourceMetadata(modelId).requestContract);
  const contractPath = clean(contract?.path);
  if (!contractPath) return undefined;
  return {
    path: contractPath,
    inputFields: stringList(contract?.inputFields),
    parameterFields: stringList(contract?.parameterFields),
    mediaTypes: stringList(contract?.mediaTypes),
  };
}

function deriveVideoOperation(contract: AlibabaVideoRequestContract, modelId: string): string {
  if (modelId.includes("video-edit") || contract.mediaTypes.includes("video")) return "video-edit";
  if (contract.mediaTypes.includes("reference_image") && !contract.mediaTypes.includes("first_frame")) {
    return "reference-to-video";
  }
  if (modelId.includes("r2v")) return "reference-to-video";
  if (contract.mediaTypes.includes("first_frame")
    || contract.inputFields.some((field) => field === "img_url" || field === "image_url" || field === "first_frame_url")) {
    return "image-to-video";
  }
  return "text-to-video";
}

function videoOperationForModel(modelId: string): string | undefined {
  const explicit = clean(sourceMetadata(modelId).operation);
  if (explicit) return explicit;
  const contract = videoRequestContractForModel(modelId);
  return contract ? deriveVideoOperation(contract, modelId) : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => clean(entry)).filter(Boolean);
}

function modelTypes(modelId: string): string[] {
  const card = getModelById(modelId, "alibaba");
  const rawTypes = [
    ...(Array.isArray(card?.type) ? card.type : [card?.type]),
    card?.modelType,
  ];
  return rawTypes
    .map((type) => clean(type).toLowerCase().replace(/[\s_]+/g, "-"))
    .filter(Boolean);
}

function pricingSections(modelId: string): Record<string, unknown>[] {
  const card = getModelById(modelId, "alibaba");
  const sections = Array.isArray(asRecord(card?.pricing)?.sections)
    ? asRecord(card?.pricing)?.sections as unknown[]
    : [];
  return sections
    .map((section) => asRecord(section))
    .filter((section): section is Record<string, unknown> => Boolean(section));
}

function hasVoicePricing(modelId: string): boolean {
  return pricingSections(modelId).some((section) => {
    const unitKey = clean(section.unitKey);
    const entries = asRecord(section.entries);
    return unitKey === "per_voice_usd" || unitKey === "usd_per_voice" || typeof entries?.voice === "number";
  });
}

function isQwenNativeTts(modelId: string): boolean {
  const metadata = sourceMetadata(modelId);
  const capabilities = new Set(stringList(metadata.capabilities));
  return capabilities.has("TTS") && metadata.openAICompatible === true && !hasVoicePricing(modelId);
}

function routeForModel(modelId: string): AlibabaRoute {
  const metadata = sourceMetadata(modelId);
  const capabilities = new Set(stringList(metadata.capabilities));
  const types = new Set(modelTypes(modelId));
  const compatible = metadata.openAICompatible === true;

  if (capabilities.has("TR") && compatible) return "openai_embeddings";
  if (capabilities.has("ME")) return "dashscope_multimodal_embeddings";
  if (capabilities.has("TR")) return "dashscope_rerank";
  if (capabilities.has("ASR") && compatible) return "openai_chat";
  if (capabilities.has("ASR")) return "dashscope_speech_transcription";
  if (types.has("feature-extraction") && compatible) return "openai_embeddings";
  if (types.has("image-generation") && /^wan2\.5-i2i/i.test(modelId)) return "dashscope_image_edit_synthesis";
  if (types.has("image-generation") && /^wan2\.(?:6-(?:image|t2i)|7-image(?:-pro)?)/i.test(modelId)) return "dashscope_multimodal_generation";
  if (types.has("image-generation") && clean(metadata.provider).toLowerCase() === "wan") return "dashscope_image_synthesis";
  if (types.has("image-generation")) return "dashscope_multimodal_generation";
  if (types.has("videos")) return "dashscope_video_synthesis";
  if (types.has("text-to-speech")) return "dashscope_speech_generation";
  if (types.has("automatic-speech-recognition")) return "dashscope_speech_transcription";
  if (compatible) return "openai_chat";
  return "dashscope_multimodal_generation";
}

function asrConnection(modelId: string): "compatible" | "async" {
  const metadata = sourceMetadata(modelId);
  const capabilities = new Set(stringList(metadata.capabilities));
  const card = getModelById(modelId, "alibaba");
  const marker = `${modelId} ${card?.name || ""}`.toLowerCase();
  if (!capabilities.has("ASR")) return "async";
  if (marker.includes("filetrans") || marker.includes("realtime")) return "async";
  if (metadata.openAICompatible === true) return "compatible";
  if (marker.includes("qwen3-asr-flash")) return "compatible";
  return "async";
}

function asrUsesSingleFileUrl(modelId: string): boolean {
  const card = getModelById(modelId, "alibaba");
  return `${modelId} ${card?.name || ""}`.toLowerCase().includes("filetrans");
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential()}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Alibaba provider HTTP ${response.status}: ${text.slice(0, 500)}`), {
      statusCode: response.status,
      retryAfter: response.headers.get("retry-after") || undefined,
    });
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

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${credential()}` },
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Alibaba provider HTTP ${response.status}: ${text.slice(0, 500)}`), {
      statusCode: response.status,
      retryAfter: response.headers.get("retry-after") || undefined,
    });
  }
  return text ? JSON.parse(text) : {};
}

async function postEmptyJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential()}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Alibaba provider HTTP ${response.status}: ${text.slice(0, 500)}`), {
      statusCode: response.status,
      retryAfter: response.headers.get("retry-after") || undefined,
    });
  }
  return text ? JSON.parse(text) : {};
}

function audioSecondsFromOpenAIUsage(value: unknown): number | undefined {
  const usage = asRecord(value);
  const details = asRecord(usage?.prompt_tokens_details) || asRecord(usage?.promptTokensDetails);
  const audioTokens = readPositiveNumber(details, ["audio_tokens", "audioTokens"]);
  if (audioTokens === undefined) return undefined;
  return audioTokens / 25;
}

function readPositiveNumber(record: Record<string, unknown> | null | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function alibabaSpeechFormat(format: string | undefined): string {
  const value = clean(format).toLowerCase();
  return value === "wav" || value === "pcm" || value === "mp3" ? value : "mp3";
}

function alibabaSpeechMimeType(format: string | undefined): string {
  switch (alibabaSpeechFormat(format)) {
    case "wav":
      return "audio/wav";
    case "pcm":
      return "audio/pcm";
    default:
      return "audio/mpeg";
  }
}

function speechUsage(raw: unknown, fallbackCharacters: number): Usage {
  const root = asRecord(raw) || {};
  const usage = asRecord(root.usage) || asRecord(asRecord(root.output)?.usage);
  const characters = readPositiveNumber(usage, ["characters", "character"]) || fallbackCharacters;
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    billingMetrics: { character: characters },
    ...(usage ? { raw: usage } : {}),
  };
}

async function synthesizeAlibabaQwenSpeech(
  modelId: string,
  text: string,
  options: {
    operation?: string;
    voice?: string;
    responseFormat?: string;
    speed?: number;
    customParams?: Record<string, unknown>;
  },
): Promise<{ buffer: Buffer; mimeType: string; usage?: Usage; raw: unknown }> {
  const bases = basesForModel(modelId);
  const customParams = options.customParams || {};
  const voice = options.voice || clean(customParams.voice) || "Cherry";
  const input: Record<string, unknown> = {
    text,
    voice,
  };
  for (const key of ["language_type", "language", "instructions", "emotion"]) {
    const value = customParams[key];
    if (typeof value === "string" && value.trim()) input[key] = value.trim();
  }

  const parameters: Record<string, unknown> = {};
  if (options.responseFormat) parameters.format = options.responseFormat;
  if (typeof options.speed === "number") parameters.speed = options.speed;
  for (const [key, value] of Object.entries(customParams)) {
    if (["voice", "language_type", "language", "instructions", "emotion"].includes(key)) continue;
    parameters[key] = value;
  }

  const raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, {
    model: modelId,
    input,
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  });
  const payload = findMediaPayload(raw, ["audio", "audio_url", "url"]);
  if (!payload) throw new Error("Alibaba Qwen TTS returned no audio data");
  const audio = await bufferFromPayload(payload, alibabaSpeechMimeType(options.responseFormat));
  return {
    ...audio,
    usage: speechUsage(raw, Array.from(text).length),
    raw,
  };
}

function voiceName(customParams: Record<string, unknown>): string {
  const explicit = clean(customParams.preferred_name) || clean(customParams.voice_id);
  if (explicit) return explicit.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "VoiceA1";
  const suffix = randomUUID().replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
  return `VoiceA${suffix}`;
}

async function designAlibabaVoice(
  modelId: string,
  text: string,
  options: {
    responseFormat?: string;
    customParams?: Record<string, unknown>;
  },
): Promise<{ buffer: Buffer; mimeType: string; usage?: Usage; raw: unknown }> {
  const bases = basesForModel(modelId);
  const customParams = options.customParams || {};
  const raw = await postJson(`${bases.apiBase}/services/audio/tts/customization`, {
    model: modelId,
    input: {
      action: "create",
      target_model: clean(customParams.target_model) || "qwen3-tts-vd-2026-01-26",
      voice_prompt: text,
      preview_text: clean(customParams.preview_text) || "Hello, this is a preview of the designed Compose voice.",
      preferred_name: voiceName(customParams),
      ...(clean(customParams.language) ? { language: clean(customParams.language) } : {}),
    },
  });
  const output = asRecord(asRecord(raw)?.output) || {};
  const preview = asRecord(output.preview_audio);
  const payload = clean(preview?.data) || clean(preview?.url) || clean(output.preview_audio);
  if (!payload) throw new Error("Alibaba voice design returned no preview audio");
  const mimeType = clean(preview?.mime_type) || clean(preview?.content_type) || alibabaSpeechMimeType(options.responseFormat);
  const audio = await bufferFromPayload(payload, mimeType);
  return {
    ...audio,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { voice: 1 },
      ...(asRecord(asRecord(raw)?.usage) ? { raw: asRecord(asRecord(raw)?.usage) as Record<string, unknown> } : {}),
    },
    raw,
  };
}

function alibabaWebSocketUrl(modelId: string): string {
  const metadata = sourceMetadata(modelId);
  const endpoint = asRecord(metadata.endpoint);
  const origin = clean(endpoint?.origin) || "https://dashscope-intl.aliyuncs.com";
  return `${origin.replace(/^http/i, "ws")}/api-ws/v1/inference`;
}

type WebSocketMessage = string | ArrayBuffer | Buffer | Blob;

async function synthesizeAlibabaSpeech(
  modelId: string,
  text: string,
  options: {
    voice?: string;
    responseFormat?: string;
    speed?: number;
    customParams?: Record<string, unknown>;
  },
): Promise<{ buffer: Buffer; usage?: Usage; raw: unknown[] }> {
  const require = createRequire(`${process.cwd()}/package.json`);
  const WebSocket = require("ws") as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => {
    binaryType: "arraybuffer";
    readyState: number;
    send(data: string): void;
    close(): void;
    on(event: "open", listener: () => void): void;
    on(event: "message", listener: (data: WebSocketMessage, isBinary: boolean) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  };

  const taskId = randomUUID();
  const chunks: Buffer[] = [];
  const events: unknown[] = [];
  const sourceText = text;
  const format = alibabaSpeechFormat(options.responseFormat || clean(options.customParams?.format));
  const customParams = options.customParams || {};
  const parameters: Record<string, unknown> = {
    text_type: "PlainText",
    voice: options.voice || clean(customParams.voice) || "longanyang",
    format,
    sample_rate: typeof customParams.sample_rate === "number" ? customParams.sample_rate : 22050,
    volume: typeof customParams.volume === "number" ? customParams.volume : 50,
    rate: typeof options.speed === "number" ? options.speed : typeof customParams.rate === "number" ? customParams.rate : 1,
    pitch: typeof customParams.pitch === "number" ? customParams.pitch : 1,
    enable_ssml: customParams.enable_ssml === true,
  };
  for (const [key, value] of Object.entries(customParams)) {
    if (!(key in parameters)) {
      parameters[key] = value;
    }
  }

  const ws = new WebSocket(alibabaWebSocketUrl(modelId), {
    headers: {
      Authorization: `bearer ${credential()}`,
    },
  });
  ws.binaryType = "arraybuffer";

  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close races after task completion.
      }
      fn();
    };
    const fail = (error: Error): void => done(() => reject(error));
    const timer = setTimeout(() => fail(new Error("Alibaba speech synthesis timed out")), 90_000);

    const send = (action: string, payload: Record<string, unknown>): void => {
      ws.send(JSON.stringify({
        header: { action, task_id: taskId, streaming: "duplex" },
        payload,
      }));
    };

    ws.on("open", () => {
      send("run-task", {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: modelId,
        parameters,
        input: {},
      });
    });

    ws.on("message", async (data, isBinary) => {
      if (typeof data === "string" || isBinary === false) {
        const messageText = typeof data === "string"
          ? data
          : data instanceof Blob
            ? await data.text()
            : data instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(data)).toString("utf8")
              : Buffer.from(data).toString("utf8");
        const event = JSON.parse(messageText) as unknown;
        events.push(event);
        const header = asRecord(asRecord(event)?.header);
        const name = clean(header?.event);
        if (name === "task-started") {
          send("continue-task", { input: { text: sourceText } });
          send("finish-task", { input: {} });
          return;
        }
        if (name === "task-failed") {
          const payload = asRecord(asRecord(event)?.payload);
          const message = clean(payload?.message) || clean(payload?.error_message) || clean(asRecord(event)?.message);
          fail(new Error(`Alibaba speech synthesis failed: ${message || messageText}`));
          return;
        }
        if (name === "task-finished") {
          const usage = events
            .map((item) => asRecord(asRecord(item)?.payload))
            .map((payload) => asRecord(payload?.usage))
            .filter((usageRecord): usageRecord is Record<string, unknown> => Boolean(usageRecord))
            .at(-1);
          const characters = readPositiveNumber(usage, ["characters", "character"]) || Array.from(sourceText).length;
          done(() => resolve({
            buffer: Buffer.concat(chunks),
            usage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              billingMetrics: { character: characters },
              raw: usage,
            },
            raw: events,
          }));
        }
        return;
      }

      if (data instanceof Blob) {
        chunks.push(Buffer.from(await data.arrayBuffer()));
      } else if (data instanceof ArrayBuffer) {
        chunks.push(Buffer.from(data));
      } else {
        chunks.push(Buffer.from(data));
      }
    });

    ws.on("error", fail);
    ws.on("close", (code, reason) => {
      if (!settled && code !== 1000) {
        fail(new Error(`Alibaba speech synthesis WebSocket closed: ${code} ${reason.toString()}`.trim()));
      }
    });
  });
}

function transcriptionText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const direct = clean(record.text) || clean(record.content);
  if (direct) return direct;

  const transcripts = Array.isArray(record.transcripts) ? record.transcripts : [];
  return transcripts
    .map((item) => clean(asRecord(item)?.text))
    .filter(Boolean)
    .join("\n");
}

function transcriptionSeconds(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const properties = asRecord(record.properties);
  const originalMs = readPositiveNumber(properties, ["original_duration_in_milliseconds", "originalDurationInMilliseconds"]);
  if (originalMs !== undefined) return originalMs / 1000;
  const transcripts = Array.isArray(record.transcripts) ? record.transcripts : [];
  let maxMs = 0;
  for (const transcript of transcripts) {
    const transcriptRecord = asRecord(transcript);
    const duration = readPositiveNumber(transcriptRecord, ["content_duration_in_milliseconds", "contentDurationInMilliseconds"]);
    if (duration !== undefined) maxMs = Math.max(maxMs, duration);
  }
  return maxMs > 0 ? maxMs / 1000 : undefined;
}

function dashscopeImageSize(size: string | undefined): string | undefined {
  const value = clean(size);
  if (!value) return undefined;
  return value.replace(/^(\d+)x(\d+)$/i, "$1*$2");
}

async function waitForAlibabaImageTask(
  bases: AlibabaBases,
  taskId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let status: unknown = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    status = await getJson(`${bases.apiBase}/tasks/${encodeURIComponent(taskId)}`, signal);
    const output = asRecord(asRecord(status)?.output);
    const state = clean(output?.task_status).toUpperCase();
    if (["SUCCEEDED", "SUCCESS", "COMPLETED"].includes(state)) return status;
    if (["FAILED", "CANCELED", "CANCELLED", "UNKNOWN"].includes(state)) {
      throw Object.assign(
        new Error(`Alibaba image generation failed: ${JSON.stringify(status).slice(0, 500)}`),
        { statusCode: 400, retryable: false },
      );
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
      }, { once: true });
    });
  }
  throw Object.assign(new Error(`Alibaba image generation did not complete before the request deadline: ${JSON.stringify(status).slice(0, 500)}`), {
    statusCode: 504,
    retryable: false,
  });
}

export async function generateAlibabaChat(
  modelId: string,
  messages: Message[],
  options: {
    temperature?: number;
    maxTokens?: number;
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: unknown;
    customParams?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<AlibabaChatResult> {
  const route = routeForModel(modelId);
  if (route === "dashscope_rerank") {
    return generateAlibabaRerank(modelId, messages, options.customParams);
  }

  const bases = basesForModel(modelId);
  const isZai = getModelById(modelId, "alibaba")?.family === "zai";
  if (route === "openai_chat") {
    if (isZai) {
      const body = zaiFamily.buildChatBody(modelId, messages, {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        ...(options.responseFormat ? { responseFormat: options.responseFormat as { type: "text" | "json_object" } } : {}),
        ...(options.customParams ? { customParams: options.customParams } : {}),
      });
      const raw = await postJson(`${bases.compatibleBase}/chat/completions`, body, {}, options.signal);
      const parsed = zaiFamily.parseChatResponse(raw);
      return {
        text: parsed.text,
        ...(parsed.reasoningContent ? { reasoning: parsed.reasoningContent } : {}),
        ...(parsed.toolCalls ? { toolCalls: parsed.toolCalls } : {}),
        finishReason: parsed.finishReason,
        usage: parsed.usage,
        raw,
      };
    }
    const request = buildAlibabaChatBody(modelId, messages, {
      wire: "openai_chat",
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
      ...(options.customParams ? { customParams: options.customParams } : {}),
    });
    const raw = await postJson(`${bases.compatibleBase}/chat/completions`, request.body, {}, options.signal);
    return parseAlibabaChatResponse(raw, "openai_chat");
  }

  const request = buildAlibabaChatBody(modelId, messages, {
    wire: "multimodal",
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
    ...(options.customParams ? { customParams: options.customParams } : {}),
  });
  const raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, request.body, {}, options.signal);
  return parseAlibabaChatResponse(raw, "multimodal");
}

interface AlibabaToolAccumulator {
  id: string;
  name: string;
  arguments: string;
  index: number;
}

async function* alibabaSseJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.ok) {
    await throwHttpError("Alibaba provider stream", response.url || "alibaba-stream", response);
  }
  const body = response.body;
  if (!body) await throwHttpError("Alibaba provider stream", response.url || "alibaba-stream", response);
  const reader = body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const parse = (lines: string[]): Record<string, unknown> | null | "done" => {
    if (lines.length === 0) return null;
    const data = lines.join("\n");
    if (data.trim() === "[DONE]") return "done";
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error(`Alibaba stream returned invalid SSE JSON: ${data.slice(0, 500)}`);
    }
  };

  let reachedEof = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const parsed = parse(dataLines);
          dataLines = [];
          if (parsed === "done") {
            try { await reader.cancel(); } catch { /* best effort */ }
            return;
          }
          if (parsed) yield parsed;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        newline = buffer.indexOf("\n");
      }
      if (done) {
        reachedEof = true;
        break;
      }
    }

    if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    const parsed = parse(dataLines);
    if (parsed && parsed !== "done") yield parsed;
  } finally {
    if (!reachedEof) {
      try { await reader.cancel(); } catch { /* best effort */ }
    }
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
}

export async function* streamAlibabaChat(
  modelId: string,
  messages: Message[],
  options: Parameters<typeof generateAlibabaChat>[2] = {},
): AsyncGenerator<Event> {
  if (routeForModel(modelId) !== "openai_chat") {
    const result = await generateAlibabaChat(modelId, messages, options);
    if (result.reasoning) yield { type: "reasoning-delta", text: result.reasoning };
    if (result.text) yield { type: "text-delta", text: result.text };
    yield { type: "done", finishReason: result.finishReason || "stop", usage: result.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    return;
  }

  const bases = basesForModel(modelId);
  const isZai = getModelById(modelId, "alibaba")?.family === "zai";
  const body = isZai
    ? zaiFamily.buildChatBody(modelId, messages, {
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      ...(options.responseFormat ? { responseFormat: options.responseFormat as { type: "text" | "json_object" } } : {}),
      ...(options.customParams ? { customParams: options.customParams } : {}),
    }, true)
    : (() => {
      const request = buildAlibabaChatBody(modelId, messages, {
        wire: "openai_chat",
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
        ...(options.customParams ? { customParams: options.customParams } : {}),
      });
      const existingStreamOptions = asRecord(request.body.stream_options) || {};
      return {
        ...request.body,
        stream: true,
        stream_options: { ...existingStreamOptions, include_usage: true },
      };
    })();
  const response = await fetch(`${bases.compatibleBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const tools = new Map<number, AlibabaToolAccumulator>();
  if (isZai) {
    const parser = zaiFamily.createStreamParser();
    for await (const chunk of alibabaSseJson(response)) {
      for (const parsed of parser.feed(chunk)) {
        if (parsed.type === "text-delta") {
          yield { type: "text-delta", text: parsed.text };
        } else if (parsed.type === "reasoning-delta") {
          yield { type: "reasoning-delta", text: parsed.text };
        } else if (parsed.type === "tool-call-delta") {
          const current = tools.get(parsed.index) || { id: parsed.id || `call_${parsed.index}`, name: "", arguments: "", index: parsed.index };
          if (parsed.id) current.id = parsed.id;
          if (parsed.name) current.name += parsed.name;
          if (parsed.argumentsDelta) current.arguments += parsed.argumentsDelta;
          tools.set(parsed.index, current);
          yield {
            type: "tool-call-delta",
            toolCallDelta: {
              index: parsed.index,
              ...(parsed.id ? { id: parsed.id } : {}),
              ...(parsed.name ? { name: parsed.name } : {}),
              ...(parsed.argumentsDelta ? { arguments: parsed.argumentsDelta } : {}),
            },
          };
        }
      }
    }
    for (const call of [...tools.values()].sort((left, right) => left.index - right.index)) {
      yield { type: "tool-call", toolCall: { ...call, arguments: call.arguments || "{}" } };
    }
    const final = parser.finalize();
    if (!final.usage) throw new Error(`Alibaba stream returned no authoritative usage for ${modelId}`);
    yield { type: "done", finishReason: final.finishReason || "stop", usage: final.usage };
    return;
  }
  let usage: Usage | undefined;
  let finishReason = "";

  for await (const chunk of alibabaSseJson(response)) {
    usage = normalizeOpenAIUsage(chunk.usage) || usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      const delta = asRecord(choice?.delta);
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        yield { type: "reasoning-delta", text: delta.reasoning_content };
      }
      if (typeof delta?.content === "string" && delta.content) {
        yield { type: "text-delta", text: delta.content };
      }
      for (const rawCall of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const index = typeof call.index === "number" ? call.index : 0;
        const fn = asRecord(call.function);
        const id = clean(call.id);
        const name = typeof fn?.name === "string" ? fn.name : "";
        const argumentsDelta = typeof fn?.arguments === "string" ? fn.arguments : "";
        const current = tools.get(index) || { id: id || `call_${index}`, name: "", arguments: "", index };
        if (id) current.id = id;
        current.name += name;
        current.arguments += argumentsDelta;
        tools.set(index, current);
        yield {
          type: "tool-call-delta",
          toolCallDelta: {
            index,
            ...(id ? { id } : {}),
            ...(name ? { name } : {}),
            ...(argumentsDelta ? { arguments: argumentsDelta } : {}),
          },
        };
      }
      const reason = clean(choice?.finish_reason);
      if (reason) finishReason = reason;
    }
  }

  for (const call of [...tools.values()].sort((left, right) => left.index - right.index)) {
    yield { type: "tool-call", toolCall: { ...call, arguments: call.arguments || "{}" } };
  }
  if (!usage) throw new Error(`Alibaba stream returned no authoritative usage for ${modelId}`);
  yield {
    type: "done",
    finishReason: tools.size > 0 || finishReason === "tool_calls" ? "tool-calls" : finishReason || "stop",
    usage,
  };
}

async function generateAlibabaRerank(
  modelId: string,
  messages: Message[],
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
  const req = buildAlibabaRerankBody(modelId, {
    model: modelId,
    query,
    documents: documents as string[],
    ...(typeof customParams.top_n === "number" ? { top_n: customParams.top_n } : {}),
    ...(typeof customParams.return_documents === "boolean" ? { return_documents: customParams.return_documents } : {}),
  });
  const raw = await postJson(`${bases.compatibleApiBase}/reranks`, req.body);

  const root = asRecord(raw) || {};
  return {
    text: JSON.stringify(raw),
    usage: normalizeOpenAIUsage(root.usage) || {
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
  const multimodal = route !== "openai_embeddings";
  const req = buildAlibabaEmbeddingsBody(modelId, input, { multimodal });
  const url = multimodal
    ? `${bases.apiBase}/services/embeddings/multimodal-embedding/multimodal-embedding`
    : `${bases.compatibleBase}/embeddings`;
  const raw = await postJson(url, req.body);
  return parseAlibabaEmbeddingsResponse(raw, multimodal);
}

export async function generateAlibabaImage(
  modelId: string,
  prompt: string,
  options: {
    n?: number;
    size?: string;
    quality?: string;
    imageUrl?: string;
    imageUrls?: string[];
    customParams?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<AlibabaImageResult> {
  const route = routeForModel(modelId);
  const bases = basesForModel(modelId);
  const customParams = options.customParams || {};
  const card = getModelById(modelId, "alibaba");
  const acceptsImage = Array.isArray(card?.input) && card.input.some((value) => typeof value === "string" && value.toLowerCase() === "image");
  const suppliedImageUrls = options.imageUrls?.length
    ? options.imageUrls
    : options.imageUrl ? [options.imageUrl] : [];
  const imageUrls = acceptsImage ? suppliedImageUrls : [];
  let raw: unknown;

  if (route === "openai_image") {
    raw = await postJson(`${bases.compatibleBase}/images/generations`, {
      model: modelId,
      prompt,
      ...(typeof options.n === "number" ? { n: options.n } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...(imageUrls.length > 0 ? { image: imageUrls.length === 1 ? imageUrls[0] : imageUrls } : {}),
      ...customParams,
    }, {}, options.signal);
  } else if (route === "dashscope_image_synthesis" || route === "dashscope_image_edit_synthesis") {
    const editing = route === "dashscope_image_edit_synthesis";
    raw = await postJson(`${bases.apiBase}/services/aigc/${editing ? "image2image" : "text2image"}/image-synthesis`, {
      model: modelId,
      input: editing
        ? { prompt, images: imageUrls }
        : { prompt },
      parameters: {
        ...customParams,
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(dashscopeImageSize(options.size) ? { size: dashscopeImageSize(options.size) } : {}),
      },
    }, { "X-DashScope-Async": "enable" }, options.signal);
    const taskId = clean(asRecord(asRecord(raw)?.output)?.task_id);
    if (taskId) {
      raw = await waitForAlibabaImageTask(bases, taskId, options.signal);
    }
  } else {
    raw = await postJson(`${bases.apiBase}/services/aigc/multimodal-generation/generation`, {
      model: modelId,
      input: {
        messages: [{
          role: "user",
          content: [
            { text: prompt },
            ...imageUrls.map((image) => ({ image })),
          ],
        }],
      },
      parameters: {
        ...customParams,
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(dashscopeImageSize(options.size) ? { size: dashscopeImageSize(options.size) } : {}),
      },
    }, {}, options.signal);
  }

  const images = await imagesFromResponse(raw, "image/png", options.signal);
  if (images.length === 0) throw new Error("Alibaba returned no image data");
  const providerUsage = usageFromDashScope(raw);
  return {
    ...images[0],
    images,
    usage: providerUsage || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { request: 1, image: images.length },
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
  if (hasVoicePricing(modelId)) {
    const result = await designAlibabaVoice(modelId, text, options);
    return {
      buffer: result.buffer,
      mimeType: result.mimeType,
      usage: result.usage,
      raw: result.raw,
    };
  }

  if (isQwenNativeTts(modelId)) {
    const result = await synthesizeAlibabaQwenSpeech(modelId, text, options);
    return {
      buffer: result.buffer,
      mimeType: result.mimeType,
      usage: result.usage,
      raw: result.raw,
    };
  }

  const result = await synthesizeAlibabaSpeech(modelId, text, options);
  return {
    buffer: result.buffer,
    mimeType: alibabaSpeechMimeType(options.responseFormat),
    usage: result.usage,
    raw: result.raw,
  };
}

export async function transcribeAlibabaAudio(
  modelId: string,
  audioUrl: string | undefined,
  _audioBuffer: Buffer | undefined,
  options: { language?: string; responseFormat?: string; customParams?: Record<string, unknown> } = {},
): Promise<AlibabaTranscriptionResult> {
  const bases = basesForModel(modelId);
  if (asrConnection(modelId) === "compatible") {
    const audio = clean(audioUrl);
    if (!audio || (!/^https?:\/\//i.test(audio) && !/^data:/i.test(audio))) {
      throw Object.assign(
        new Error("Alibaba Qwen ASR requires a public http(s) audio URL or a base64 data URL"),
        { statusCode: 400 },
      );
    }

    const asrOptions: Record<string, unknown> = {};
    if (options.language) asrOptions.language = options.language;
    const custom = options.customParams || {};
    if (typeof custom.enable_itn === "boolean") asrOptions.enable_itn = custom.enable_itn;
    const nativeOptions = asRecord(custom.asr_options);
    if (nativeOptions) Object.assign(asrOptions, nativeOptions);

    const raw = await postJson(`${bases.compatibleBase}/chat/completions`, {
      model: modelId,
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: { data: audio },
        }],
      }],
      ...(Object.keys(asrOptions).length > 0 ? { asr_options: asrOptions } : {}),
    });
    const parsed = parseAlibabaChatResponse(raw, "openai_chat");
    const root = asRecord(raw) || {};
    const usage = parsed.usage;
    const seconds = audioSecondsFromOpenAIUsage(root.usage);
    const billingMetrics = seconds !== undefined ? { second: seconds, audio_second: seconds } : undefined;
    return {
      text: parsed.text,
      usage: usage
        ? {
          ...usage,
          ...(billingMetrics ? { billingMetrics } : {}),
        }
        : undefined,
      raw,
    };
  }

  const audio = audioUrl && /^https?:\/\//i.test(audioUrl) ? audioUrl : "";
  if (!audio) {
    throw Object.assign(
      new Error("Alibaba speech transcription requires a public http(s) audio URL"),
      { statusCode: 400 },
    );
  }

  const raw = await postJson(`${bases.apiBase}/services/audio/asr/transcription`, {
    model: modelId,
    input: asrUsesSingleFileUrl(modelId) ? { file_url: audio } : { file_urls: [audio] },
    parameters: {
      ...(options.language ? { language: options.language } : {}),
      ...(options.responseFormat ? { format: options.responseFormat } : {}),
      ...(options.customParams || {}),
    },
  }, { "X-DashScope-Async": "enable" });

  const taskId = clean(asRecord(asRecord(raw)?.output)?.task_id);
  if (!taskId) {
    throw new Error("Alibaba speech transcription returned no task id");
  }

  let statusRaw: unknown = raw;
  let completed = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    statusRaw = await postEmptyJson(`${bases.apiBase}/tasks/${encodeURIComponent(taskId)}`);
    const output = asRecord(asRecord(statusRaw)?.output);
    const status = clean(output?.task_status).toUpperCase();
    if (status === "SUCCEEDED") {
      completed = true;
      break;
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(`Alibaba speech transcription failed: ${JSON.stringify(statusRaw).slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!completed) {
    throw new Error(`Alibaba speech transcription timed out: ${JSON.stringify(statusRaw).slice(0, 500)}`);
  }

  const output = asRecord(asRecord(statusRaw)?.output);
  const results = Array.isArray(output?.results) ? output.results : [];
  const transcriptPayloads: unknown[] = [];
  const directResult = asRecord(output?.result);
  const directTranscriptionUrl = clean(directResult?.transcription_url);
  if (directTranscriptionUrl) {
    transcriptPayloads.push(await getJson(directTranscriptionUrl));
  }
  for (const item of results) {
    const result = asRecord(item);
    const url = clean(result?.transcription_url);
    if (!url || clean(result?.subtask_status).toUpperCase() === "FAILED") continue;
    transcriptPayloads.push(await getJson(url));
  }

  const text = transcriptPayloads.map(transcriptionText).filter(Boolean).join("\n") || textFromDashScope(statusRaw);
  const usage = usageFromDashScope(statusRaw);
  const statusUsage = asRecord(asRecord(statusRaw)?.usage);
  const providerSeconds = readPositiveNumber(statusUsage, ["duration", "seconds", "second"]);
  const seconds = providerSeconds ?? transcriptPayloads
    .map(transcriptionSeconds)
    .filter((value): value is number => typeof value === "number" && value > 0)
    .reduce((total, value) => total + value, 0);
  const billingMetrics = seconds > 0 ? { second: seconds, audio_second: seconds } : undefined;
  return {
    text,
    usage: usage
      ? {
        ...usage,
        billingMetrics: {
          ...(usage.billingMetrics || {}),
          ...(billingMetrics || {}),
        },
      }
      : {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        billingMetrics: billingMetrics || { request: 1 },
      },
    raw: { submit: raw, status: statusRaw, transcripts: transcriptPayloads },
  };
}

export async function submitAlibabaVideo(
  modelId: string,
  prompt: string,
  options: {
    operation?: string;
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    imageUrl?: string;
    imageUrls?: string[];
    videoUrl?: string;
    videoUrls?: string[];
    audioUrl?: string;
    audioUrls?: string[];
    customParams?: Record<string, unknown>;
    requestContract?: AlibabaVideoRequestContract;
  } = {},
): Promise<AlibabaVideoSubmission> {
  const bases = basesForModel(modelId);
  const requestContract = options.requestContract ?? videoRequestContractForModel(modelId);
  const submission = buildWanVideoSubmission(modelId, prompt, {
    operation: options.operation ?? videoOperationForModel(modelId),
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    size: options.size,
    imageUrl: options.imageUrl,
    imageUrls: options.imageUrls,
    videoUrl: options.videoUrl,
    videoUrls: options.videoUrls,
    audioUrl: options.audioUrl,
    audioUrls: options.audioUrls,
    customParams: options.customParams,
    requestContract,
  });
  const origin = bases.origin;
  const apiBase = `${origin}/api/v1`;
  const raw = await postJson(`${origin}${submission.path}`, submission.body, { "X-DashScope-Async": "enable" });

  const output = asRecord(asRecord(raw)?.output) || {};
  const taskId = readAsyncTaskId(raw);
  if (!taskId) {
    throw new Error("Alibaba video submission returned no task id");
  }

  const status = clean(output.task_status).toUpperCase() === "PENDING" ? "queued" : "processing";
  const defaultApiBase = "https://dashscope-intl.aliyuncs.com/api/v1";
  const providerJobId = apiBase === defaultApiBase
    ? taskId
    : `${Buffer.from(apiBase, "utf8").toString("base64url")}:${taskId}`;
  return { jobId: `alibaba:${providerJobId}`, status, raw };
}

function alibabaVideoJob(providerJobId: string): { apiBase: string; taskId: string } {
  const separator = providerJobId.indexOf(":");
  if (separator < 0) {
    return { apiBase: "https://dashscope-intl.aliyuncs.com/api/v1", taskId: providerJobId };
  }
  const encodedBase = providerJobId.slice(0, separator);
  const taskId = providerJobId.slice(separator + 1);
  let apiBase = "";
  try {
    apiBase = Buffer.from(encodedBase, "base64url").toString("utf8");
    const url = new URL(apiBase);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".aliyuncs.com")) throw new Error("invalid host");
  } catch {
    throw new Error("Invalid Alibaba video job origin");
  }
  if (!taskId) throw new Error("Invalid Alibaba video task id");
  return { apiBase: apiBase.replace(/\/$/, ""), taskId };
}

function videoCompletionUsage(raw: unknown): { duration?: number; billingMetrics?: Record<string, unknown>; usage?: Usage } {
  const providerUsage = asRecord(asRecord(raw)?.usage) || asRecord(asRecord(asRecord(raw)?.output)?.usage);
  if (!providerUsage) return {};
  const numeric = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = providerUsage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return undefined;
  };
  const duration = numeric(["duration", "video_duration", "output_video_duration"]);
  const sr = providerUsage.SR ?? providerUsage.sr;
  const size = providerUsage.size;
  const ratio = providerUsage.ratio ?? providerUsage.video_ratio;
  const videoCount = numeric(["video_count"]);
  const billingMetrics: Record<string, unknown> = {};
  if (duration !== undefined) Object.assign(billingMetrics, { duration, second: duration, video_second: duration });
  if (sr !== undefined && sr !== "") {
    billingMetrics.SR = sr;
    billingMetrics.resolution = /^\d+$/.test(String(sr)) ? `${sr}P` : sr;
  }
  if (size !== undefined && size !== "") billingMetrics.size = size;
  if (ratio !== undefined && ratio !== "") billingMetrics.ratio = ratio;
  if (videoCount !== undefined) {
    billingMetrics.video_count = videoCount;
    billingMetrics.video = videoCount;
  }
  return {
    ...(duration !== undefined ? { duration } : {}),
    billingMetrics,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics,
      raw: providerUsage,
    },
  };
}

export async function retrieveAlibabaVideo(providerJobId: string): Promise<AlibabaVideoStatus> {
  const job = alibabaVideoJob(providerJobId);
  const raw = await getJson(`${job.apiBase}/tasks/${encodeURIComponent(job.taskId)}`);
  const root = asRecord(raw) || {};
  const output = asRecord(root.output) || root;
  const taskStatus = clean(output.task_status || root.task_status).toUpperCase();
  const error = clean(output.message) || clean(root.message) || clean(asRecord(output.task_metrics)?.failed);
  const videoUrlFrom = (value: unknown): string => {
    const direct = clean(value);
    if (direct) return direct;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = videoUrlFrom(item);
        if (found) return found;
      }
      return "";
    }
    const record = asRecord(value);
    if (!record) return "";
    for (const key of ["video_url", "output_video_url", "file_url", "download_url", "url", "video", "results", "result", "output", "data"]) {
      const found = videoUrlFrom(record[key]);
      if (found) return found;
    }
    return "";
  };
  const url = videoUrlFrom(output);

  if (taskStatus === "SUCCEEDED" || taskStatus === "SUCCESS" || taskStatus === "COMPLETED") {
    if (!url) return { status: "failed", error: "Alibaba video task completed without a video URL", raw };
    return { status: "completed", url, ...videoCompletionUsage(raw), raw };
  }
  if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "CANCELLED") {
    return { status: "failed", error: error || "Alibaba video generation failed", raw };
  }
  if (taskStatus === "UNKNOWN") {
    return { status: "failed", error: error || "Alibaba video task is unknown or expired", raw };
  }
  if (taskStatus === "PENDING") {
    return { status: "queued", progress: 0, raw };
  }
  return { status: "processing", raw };
}
