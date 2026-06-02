import { getModelById } from "../registry.js";
import type { Message, Usage } from "../../core.js";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { buildWanVideoSubmission } from "../families/alibaba.js";

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
  usage?: Usage;
  finishReason?: string;
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

function sourceProvider(modelId: string): string {
  return clean(sourceMetadata(modelId).provider).toLowerCase();
}

function isHappyHorse(modelId: string): boolean {
  return sourceProvider(modelId) === "happyhorse";
}

function isHappyHorseReferenceToVideo(modelId: string): boolean {
  return isHappyHorse(modelId) && /\br2v\b/i.test(modelId);
}

function isHappyHorseVideoEdit(modelId: string): boolean {
  return isHappyHorse(modelId) && /video-edit/i.test(modelId);
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

async function postEmptyJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential()}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Alibaba provider HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

function usageFromOpenAI(value: unknown): Usage | undefined {
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
    ...(usage ? { raw: usage } : {}),
  };
}

function usageFromDashScope(raw: unknown): Usage | undefined {
  const root = asRecord(raw);
  const usage = asRecord(root?.usage) || asRecord(asRecord(root?.output)?.usage);
  return usageFromOpenAI(usage);
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function primaryText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      const text = messageText(messages[index]);
      if (text) return text;
    }
  }
  return "";
}

function promptWithReferenceMarkers(modelId: string, prompt: string, mediaCount: number): string {
  const value = clean(prompt);
  if (!isHappyHorseReferenceToVideo(modelId) || mediaCount <= 0) return value;
  if (/\[Image\s+\d+\]/i.test(value)) return value;
  const refs = Array.from({ length: mediaCount }, (_, index) => `[Image ${index + 1}]`).join(" ");
  return clean(`${refs} ${value}`) || refs;
}

function defaultVideoEditPrompt(modelId: string, prompt: string): string {
  const value = clean(prompt);
  if (value || !isHappyHorseVideoEdit(modelId)) return value;
  return "Edit the source media while preserving its main subject and natural motion.";
}

function urlFromPart(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return clean(record?.url) || undefined;
}

function findUrl(messages: Message[], type: "image_url" | "input_audio" | "video_url"): string | undefined {
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

function dashscopeContent(message: Message): Array<Record<string, unknown>> {
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

function dashscopeMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages
    .map((message) => ({
      role: message.role === "tool" ? "assistant" : message.role,
      content: dashscopeContent(message),
    }))
    .filter((message) => Array.isArray(message.content) && message.content.length > 0);
}

function textFromOpenAIChat(raw: unknown): { text: string; finishReason?: string; usage?: Usage } {
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

function audioSecondsFromOpenAIUsage(value: unknown): number | undefined {
  const usage = asRecord(value);
  const details = asRecord(usage?.prompt_tokens_details) || asRecord(usage?.promptTokensDetails);
  const audioTokens = readPositiveNumber(details, ["audio_tokens", "audioTokens"]);
  if (audioTokens === undefined) return undefined;
  return audioTokens / 25;
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

export async function generateAlibabaChat(
  modelId: string,
  messages: Message[],
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
        ...customParams,
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(dashscopeImageSize(options.size) ? { size: dashscopeImageSize(options.size) } : {}),
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
    const parsed = textFromOpenAIChat(raw);
    const root = asRecord(raw) || {};
    const usage = parsed.usage;
    const seconds = audioSecondsFromOpenAIUsage(root.usage);
    const billingMetrics = seconds !== undefined ? { second: seconds, audio_second: seconds } : undefined;
    return {
      text: parsed.text,
      usage: usage
        ? {
          ...usage,
          billingMetrics: {
            ...(usage.billingMetrics || {}),
            ...(billingMetrics || {}),
          },
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
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    size?: string;
    imageUrl?: string;
    imageUrls?: string[];
    videoUrl?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<AlibabaVideoSubmission> {
  const bases = basesForModel(modelId);
  const media = isHappyHorse(modelId)
    ? [
      ...(clean(options.imageUrl) ? [{
        type: "reference_image",
        url: clean(options.imageUrl),
      }] : []),
      ...(clean(options.videoUrl) ? [{ type: "video", url: clean(options.videoUrl) }] : []),
    ]
    : undefined;
  const submission = buildWanVideoSubmission(modelId, prompt, {
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    size: options.size,
    imageUrl: options.imageUrl,
    imageUrls: options.imageUrls,
    videoUrl: options.videoUrl,
    media,
    customParams: options.customParams,
  });
  if (isHappyHorse(modelId)) {
    const input = asRecord(submission.body.input);
    if (input) {
      input.prompt = promptWithReferenceMarkers(modelId, defaultVideoEditPrompt(modelId, prompt), media?.length ?? 0);
    }
  }
  const raw = await postJson(`${bases.origin}${submission.path}`, submission.body, { "X-DashScope-Async": "enable" });

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
