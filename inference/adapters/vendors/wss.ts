import WebSocket, { type RawData } from "ws";

import { getModelCapabilities } from "../modalities/index.js";
import { isRealtimeModel } from "../modalities/realtime.js";
import { DEEPGRAM_FLUX_LISTEN_PATH } from "../families/deepgram.js";
import { ELEVENLABS_STT_REALTIME_PATH } from "../families/elevenlabs.js";
import { resolveModel, type ResolvedModel } from "../registry.js";
import { getModelSourceShape } from "../source.js";
import { normalizeOpenAIUsage } from "../shared/usage.js";
import type { ModelProvider } from "../../types.js";
import type { Event, Media, Output, Request, Usage } from "../../core.js";

export interface Target {
  path: string;
  operation: string;
  query: URLSearchParams;
}

export interface Adapter {
  modelId: string;
  provider: ModelProvider;
  signal?: AbortSignal;
  params?: Record<string, unknown>;
}

interface Frame {
  json?: Record<string, unknown>;
  binary?: Buffer;
}

class Queue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  private ended = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  error(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.failure) return Promise.reject(this.failure);
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

const ALIBABA = new Set([
  "Realtime-Omni",
  "Realtime-ASR",
  "Realtime-Audio-Translate",
]);

const SCHEMA = new Set([
  "array",
  "boolean",
  "integer",
  "number",
  "object",
  "string",
  "string[]",
]);

const RESERVED = new Set([
  "authorization",
  "endpoint_origin",
  "endpoint_path",
  "endpoint_url",
  "family",
  "model",
  "operation",
  "response_id",
  "responseid",
  "token",
  "upstream_model",
  "upstreammodelid",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function millis(value: unknown): number | null {
  const raw = number(value);
  return raw === null ? null : raw / 1000;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(list);
  }
  const valueText = text(value);
  return valueText ? [valueText] : [];
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

function skip(name: string): boolean {
  return RESERVED.has(key(name));
}

function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean || SCHEMA.has(key(clean))) return null;
    return clean;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function add(params: URLSearchParams, name: string, value: unknown): void {
  if (skip(name) || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) add(params, name, entry);
    return;
  }
  const item = scalar(value);
  if (item !== null) {
    params.append(name, String(item));
  }
}

function base(): URL {
  const raw = process.env.REALTIME_URL;
  if (!raw) throw new Error("REALTIME_URL not set");
  const url = new URL(raw);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url;
}

function join(root: URL, route: string): URL {
  const url = new URL(root.toString());
  const left = url.pathname.replace(/\/+$/u, "");
  const right = route.replace(/^\/+/u, "");
  url.pathname = `${left}/${right}`;
  return url;
}

function wire(item: Target): URL {
  const url = join(base(), item.path);
  for (const [name, value] of item.query) {
    url.searchParams.append(name, value);
  }
  return url;
}

function root(): URL {
  const url = base();
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url;
}

function service(route: string): URL {
  return join(root(), route);
}

function internalRealtimeHeaders(): Record<string, string> {
  const token = (process.env.BACKPACK_INTERNAL_TOKEN || "").trim();
  return token ? { "x-backpack-internal-token": token } : {};
}

async function post(responseId: string, route: "input" | "close", frames?: Frame[]): Promise<boolean> {
  const url = service(`/sessions/${encodeURIComponent(responseId)}/${route}`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...internalRealtimeHeaders() },
    body: JSON.stringify({
      responseId,
      ...(frames ? {
        frames: frames.map((frame) => frame.json
          ? { json: frame.json }
          : { binaryBase64: frame.binary?.toString("base64") || "" }),
      } : {}),
    }),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Realtime service ${route} failed with HTTP ${response.status}`);
  }
  return true;
}

function endpoint(resolved: ResolvedModel): {
  url?: string;
  origin?: string;
  path?: string;
  method?: string;
} {
  const params = record(resolved.card?.params);
  const raw = params?.endpoint;
  if (typeof raw === "string") {
    return { url: raw, method: text(params?.method) ?? undefined };
  }

  const shaped = record(raw);
  const metadata = record(resolved.card?.sourceMetadata);
  const alibaba = record(metadata?.alibaba);
  const ali = record(alibaba?.endpoint);
  return {
    origin: text(shaped?.origin) ?? text(ali?.origin) ?? undefined,
    path: text(shaped?.path) ?? undefined,
    method: text(shaped?.method) ?? text(params?.method) ?? undefined,
  };
}

function operation(resolved: ResolvedModel, req: Request): string | null {
  const card = resolved.card;
  if (!card) return req.operation ?? null;

  const capabilities = getModelCapabilities(card)
    .filter((capability) => capability.modality === "realtime");
  if (req.operation) {
    const match = capabilities.find((capability) => capability.operation === req.operation);
    if (match) return match.operation;
  }
  return capabilities[0]?.operation ?? req.operation ?? null;
}

function alibaba(resolved: ResolvedModel): boolean {
  const metadata = record(resolved.card?.sourceMetadata);
  const source = record(metadata?.alibaba);
  return list(source?.capabilities).some((capability) => ALIBABA.has(capability));
}

function path(resolved: ResolvedModel, op: string): string | null {
  const card = resolved.card;
  if (!card) return null;

  const source = getModelSourceShape(card);
  if (!isRealtimeModel(card, source)) return null;

  if (resolved.provider === "openai") {
    if (op === "realtime-translation") return "/realtime-translate";
    if (op === "realtime-transcription") return "/whisper";
    return "/realtime-2";
  }

  const caps = record(card.capabilities);
  if (
    resolved.provider === "gemini"
    && op === "realtime-speech"
    && caps?.liveApi === true
    && caps?.audioGeneration === true
    && source.input.includes("text")
    && source.output.includes("audio")
  ) {
    return "/lyria";
  }

  const ep = endpoint(resolved);
  if (resolved.provider === "deepgram" && ep.url) {
    const url = new URL(ep.url);
    if (url.protocol === "wss:" && url.pathname === DEEPGRAM_FLUX_LISTEN_PATH) {
      return "/flux";
    }
  }

  if (
    resolved.provider === "elevenlabs"
    && key(ep.method || "") === "wss"
    && ep.path === ELEVENLABS_STT_REALTIME_PATH
  ) {
    return "/scribe";
  }

  if (resolved.provider === "alibaba" && alibaba(resolved)) {
    return "/qwen-omni";
  }

  return null;
}

export function target(resolved: ResolvedModel, req: Request, params?: Record<string, unknown>): Target | null {
  const card = resolved.card;
  if (!card) return null;

  const op = operation(resolved, req);
  if (!op) return null;

  const route = path(resolved, op);
  if (!route) return null;

  const ep = endpoint(resolved);
  const upstream = text(card.upstreamModelId) ?? text(card.modelId) ?? resolved.modelId;
  const query = new URLSearchParams();
  query.set("model", upstream);
  query.set("upstream_model", upstream);
  query.set("family", card.family || resolved.provider);
  query.set("operation", op);
  query.set("response_id", req.responseId);
  if (ep.url) query.set("endpoint_url", ep.url);
  if (ep.origin) query.set("endpoint_origin", ep.origin);
  if (ep.path) query.set("endpoint_path", ep.path);

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      add(query, name, value);
    }
  }

  const cardQuery = record(record(card.params)?.query);
  const model = text(cardQuery?.model);
  if (model) {
    query.set("model", model);
    query.set("upstream_model", model);
  }
  const modelId = text(cardQuery?.model_id);
  if (modelId) {
    query.set("model_id", modelId);
  }

  return { path: route, operation: op, query };
}

function body(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

interface Pcm {
  data: Buffer;
  rate?: number;
  encoding?: "linear16";
}

function pcm(data: Buffer): Pcm {
  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    return { data };
  }

  let offset = 12;
  let rate: number | undefined;
  let format: number | undefined;
  let bits: number | undefined;
  let audio = data;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= data.length) {
      format = data.readUInt16LE(start);
      rate = data.readUInt32LE(start + 4);
      bits = data.readUInt16LE(start + 14);
    }
    if (id === "data") {
      audio = data.subarray(start, Math.min(start + size, data.length));
      break;
    }
    offset = start + size + (size % 2);
  }
  return { data: audio, rate, ...(format === 1 && bits === 16 ? { encoding: "linear16" as const } : {}) };
}

function parse(data: RawData): Record<string, unknown> | null {
  try {
    return JSON.parse(body(data).toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function input(req: Request): string {
  const chunks: string[] = [];
  if (req.instructions) chunks.push(req.instructions);
  for (const message of req.messages) {
    const content = message.content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text" && part.text) chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim() || "Hello.";
}

function payloadText(value: Record<string, unknown>): string {
  const direct = text(value.prompt) ?? text(value.text) ?? text(value.message);
  if (direct) return direct;

  const inputValue = value.input;
  if (typeof inputValue === "string") return inputValue.trim();
  if (Array.isArray(inputValue)) {
    const pieces: string[] = [];
    for (const item of inputValue) {
      if (typeof item === "string") pieces.push(item);
      else if (record(item)) pieces.push(payloadText(item));
    }
    const joined = pieces.join("\n").trim();
    if (joined) return joined;
  }

  const messages = Array.isArray(value.messages) ? value.messages : [];
  const pieces: string[] = [];
  for (const message of messages) {
    const data = record(message);
    const content = data?.content;
    if (typeof content === "string") {
      pieces.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const item = record(part);
        const piece = text(item?.text) ?? text(item?.content);
        if (piece) pieces.push(piece);
      }
    }
  }
  return pieces.join("\n").trim();
}

function payloadParams(value: Record<string, unknown>): Record<string, unknown> | null {
  return record(value.params)
    ?? record(value.custom_params)
    ?? record(value["custom" + "Params"])
    ?? record(value.config);
}

function sendJson(ws: WebSocket, value: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(value));
  }
}

function sendFrame(ws: WebSocket, frame: Frame): void {
  if (frame.json) {
    sendJson(ws, frame.json);
    return;
  }
  if (frame.binary && ws.readyState === WebSocket.OPEN) {
    ws.send(frame.binary, { binary: true });
  }
}

async function liveFrames(item: Target, value: Record<string, unknown>): Promise<Frame[]> {
  const prompt = payloadText(value);
  const params = payloadParams(value);
  const action = text(value.action) ?? text(value.type);
  const out: Frame[] = [];

  if (item.path === "/lyria") {
    if (params) {
      out.push({ json: { type: "config", config: params } });
    }
    if (prompt) {
      out.push({ json: { type: "prompt", prompt } });
    }
    if (action === "pause" || action === "stop" || action === "reset" || action === "play") {
      out.push({ json: { type: action } });
    } else if (prompt || params) {
      out.push({ json: { type: "play" } });
    }
    return out;
  }

  const bytes = await payloadAudio(value);
  if (bytes) {
    const audio = pcm(bytes);
    if (item.path === "/flux" || item.path === "/scribe") {
      out.push({ binary: audio.data });
      return out;
    }

    const input = item.operation === "realtime-translation"
      ? "session.input_audio_buffer"
      : "input_audio_buffer";
    out.push({ json: {
      type: `${input}.append`,
      audio: audio.data.toString("base64"),
    } });
    out.push({ json: { type: `${input}.commit` } });
    if (item.path !== "/whisper" && item.operation !== "realtime-transcription") {
      out.push({ json: { type: "response.create" } });
    }
    if (!prompt) return out;
  }

  if (!prompt) return out;

  out.push({ json: {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  } });
  out.push({ json: { type: "response.create" } });
  return out;
}

function locator(req: Request): string | null {
  for (const message of req.messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== "input_audio") continue;
      const value = part.input_audio;
      if (typeof value === "string") return value;
      if (value?.url) return value.url;
    }
  }
  return null;
}

async function audio(req: Request, signal?: AbortSignal): Promise<Buffer | null> {
  const value = locator(req);
  if (!value) return null;

  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/su);
  if (match) {
    const encoded = match[2] || "";
    return value.slice(0, value.indexOf(",")).includes(";base64")
      ? Buffer.from(encoded, "base64")
      : Buffer.from(decodeURIComponent(encoded));
  }

  if (/^https?:\/\//iu.test(value)) {
    const response = await fetch(value, { signal });
    if (!response.ok) {
      throw new Error(`Realtime audio fetch failed with HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return Buffer.from(value, "base64");
}

function payloadAudioLocator(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = payloadAudioLocator(item);
      if (found) return found;
    }
    return null;
  }

  const data = record(value);
  if (!data) return null;

  const typed = text(data.type);
  if (typed === "input_audio") {
    const audioValue = data.input_audio;
    if (typeof audioValue === "string") return audioValue;
    const audioData = record(audioValue);
    const url = text(audioData?.url) ?? text(audioData?.data) ?? text(audioData?.base64);
    if (url) return url;
  }

  for (const key of ["input_audio", "audio", "audioUrl", "audio_url"] as const) {
    const nested = data[key];
    if (typeof nested === "string") return nested;
    const nestedData = record(nested);
    const url = text(nestedData?.url) ?? text(nestedData?.data) ?? text(nestedData?.base64);
    if (url) return url;
  }

  return payloadAudioLocator(data.input) ?? payloadAudioLocator(data.messages) ?? payloadAudioLocator(data.content);
}

async function payloadAudio(value: Record<string, unknown>): Promise<Buffer | null> {
  const located = payloadAudioLocator(value);
  if (!located) return null;

  const match = located.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/su);
  if (match) {
    const encoded = match[2] || "";
    return located.slice(0, located.indexOf(",")).includes(";base64")
      ? Buffer.from(encoded, "base64")
      : Buffer.from(decodeURIComponent(encoded));
  }

  if (/^https?:\/\//iu.test(located)) {
    const response = await fetch(located);
    if (!response.ok) {
      throw new Error(`Realtime audio fetch failed with HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return Buffer.from(located, "base64");
}

function usage(value: unknown): Usage | undefined {
  const normalized = normalizeOpenAIUsage(value);
  if (!normalized) return undefined;
  const metrics = normalized.billingMetrics || {};
  const useful = normalized.promptTokens > 0
    || normalized.completionTokens > 0
    || normalized.totalTokens > 0
    || Object.values(metrics).some((entry) => typeof entry === "number" && entry > 0);
  return useful ? normalized : undefined;
}

function media(value: unknown): Media | undefined {
  const data = record(value);
  if (!data) return undefined;
  const seconds = number(data.duration)
    ?? number(data.generatedSeconds)
    ?? number(data.generated_seconds)
    ?? number(data.seconds)
    ?? number(data.audio_seconds)
    ?? millis(data.audio_end_ms)
    ?? millis(data.audioEndMs)
    ?? millis(data.elapsed_ms)
    ?? millis(data.elapsedMs)
    ?? number(data.audio_window_end)
    ?? number(data.audioWindowEnd)
    ?? number(record(data.usage)?.duration)
    ?? number(record(data.usage)?.duration_seconds)
    ?? number(record(data.usage)?.audio_duration_seconds);
  if (seconds === null) return undefined;
  return {
    mimeType: text(data.mimeType) ?? text(data.mime_type) ?? "application/octet-stream",
    duration: seconds,
    status: "completed",
    billingMetrics: {
      duration: seconds,
      second: seconds,
      audio_second: seconds,
      minute: seconds / 60,
      audio_minute: seconds / 60,
      hour: seconds / 3600,
      audio_hour: seconds / 3600,
      generation: seconds / 3600,
      transcription: seconds / 3600,
    },
  };
}

function timed(data: Record<string, unknown>): Media | undefined {
  const direct = media(data);
  if (direct) return direct;

  const words = Array.isArray(data.words) ? data.words : [];
  let end = 0;
  for (const word of words) {
    const item = record(word);
    const value = number(item?.end) ?? number(item?.end_time) ?? number(item?.endTime);
    if (value !== null && value > end) end = value;
  }
  return end > 0 ? media({ duration: end }) : undefined;
}

function audioEvent(data: Record<string, unknown>, sequenceIndex: number): Event | null {
  const type = text(data.type) ?? text(data.event) ?? "";
  const source = record(data.audio) ?? data;
  const base64 = text(source.data)
    ?? text(source.delta)
    ?? text(source.audio)
    ?? text(source.base64)
    ?? text(source.audio_base_64)
    ?? text(source.audioBase64);
  if (!base64) return null;
  if (
    type !== "audio"
    && type !== "response.output_audio.delta"
    && type !== "response.audio.delta"
    && !type.includes("audio.delta")
    && !text(data.provider)
  ) {
    return null;
  }
  return {
    type: "audio-chunk",
    audio: {
      base64,
      sequenceIndex: number(data.sequence_index) ?? number(data.sequenceIndex) ?? sequenceIndex,
      mimeType: text(data.mimeType)
        ?? text(data.mime_type)
        ?? text(source.mimeType)
        ?? text(source.mime_type)
        ?? (text(data.format) === "pcm16" ? "audio/l16" : undefined),
      sampleRate: number(data.sampleRate)
        ?? number(data.sample_rate)
        ?? number(data.sampleRateHz)
        ?? number(source.sampleRate)
        ?? number(source.sample_rate)
        ?? undefined,
      channels: number(data.channels) ?? number(source.channels) ?? undefined,
      format: text(data.format) ?? text(source.format) ?? undefined,
    },
    media: media(data.media) ?? timed(data),
  };
}

function content(data: Record<string, unknown>): string {
  const type = text(data.type) ?? text(data.message_type) ?? text(data.event) ?? "";
  if (type === "response.output_text.delta" || type === "response.text.delta") {
    return text(data.delta) ?? "";
  }
  if (
    type === "conversation.item.input_audio_transcription.completed"
    || type === "session.output_transcript.delta"
    || type === "committed_transcript_with_timestamps"
    || type.includes("transcript")
  ) {
    return text(data.transcript) ?? text(data.text) ?? text(data.delta) ?? "";
  }
  if (
    type === "response.output_text.done"
    || type === "response.content_part.done"
    || type === "conversation.item.added"
    || type === "conversation.item.done"
    || type === "response.output_item.done"
  ) {
    return "";
  }
  const direct = text(data.text) ?? text(data.transcript);
  if (direct) return direct;
  const item = record(data.item);
  if (text(item?.role) && text(item?.role) !== "assistant") return "";
  const itemContent = Array.isArray(item?.content) ? item.content : [];
  const pieces = itemContent
    .map((part) => record(part))
    .map((part) => text(part?.text) ?? text(part?.transcript))
    .filter((part): part is string => Boolean(part));
  return pieces.join("");
}

function done(data: Record<string, unknown>, responseId: string): boolean {
  const id = text(data.response_id) ?? text(data.responseId);
  if (id !== responseId) return false;
  const type = text(data.type);
  return type === "done" || type === "stopped" || type === "error";
}

function closed(data: Record<string, unknown>): boolean {
  const type = text(data.type) ?? text(data.message_type) ?? text(data.event);
  if (type === "audio" && text(data.provider) === "lyria" && record(data.media)) {
    return true;
  }
  if (
    type === "response.done"
    || type === "conversation.item.input_audio_transcription.completed"
    || type === "committed_transcript_with_timestamps"
    || type === "session.closed"
    || type === "TurnInfo"
  ) {
    return true;
  }
  return Boolean(record(record(data.output)?.usage) ?? record(data.usage));
}

function openai(ws: WebSocket, req: Request, bytes: Buffer | null): void {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["text"],
    },
  }));

  if (bytes) {
    const audio = pcm(bytes);
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["text"],
        audio: {
          input: {
            ...(audio.rate ? { format: { type: "audio/pcm", rate: audio.rate } } : {}),
          },
        },
      },
    }));
    ws.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: audio.data.toString("base64"),
    }));
    if (audio.rate) {
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.alloc(audio.rate * 2).toString("base64"),
      }));
    }
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  } else {
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input(req) }],
      },
    }));
  }
  ws.send(JSON.stringify({
    type: "response.create",
    response: {
      ...(req.instructions ? { instructions: req.instructions } : {}),
      ...(typeof req.maxTokens === "number" ? { max_output_tokens: req.maxTokens } : {}),
    },
  }));
}

function whisper(ws: WebSocket, item: Target, req: Request, bytes: Buffer): void {
  const audio = pcm(bytes);
  const model = item.query.get("transcription_model") || item.query.get("model") || item.query.get("upstream_model");
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          ...(audio.rate ? { format: { type: "audio/pcm", rate: audio.rate } } : {}),
          transcription: {
            ...(model ? { model } : {}),
            ...(text(item.query.get("language")) ? { language: text(item.query.get("language")) } : {}),
            ...(text(item.query.get("prompt")) ? { prompt: text(item.query.get("prompt")) } : {}),
          },
        },
      },
    },
  }));
  ws.send(JSON.stringify({
    type: "input_audio_buffer.append",
    audio: audio.data.toString("base64"),
  }));
  if (audio.rate) {
    ws.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(audio.rate * 2).toString("base64"),
    }));
  }
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
}

function translate(ws: WebSocket, item: Target, req: Request, bytes: Buffer): void {
  const audio = pcm(bytes);
  const language = text(item.query.get("target_language"))
    ?? text(item.query.get("targetLanguage"))
    ?? text(item.query.get("language"));
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      audio: {
        input: {
          ...(audio.rate ? { format: { type: "audio/pcm", rate: audio.rate } } : {}),
        },
        ...(language ? { output: { language } } : {}),
      },
    },
  }));
  ws.send(JSON.stringify({
    type: "session.input_audio_buffer.append",
    audio: audio.data.toString("base64"),
  }));
  if (audio.rate) {
    ws.send(JSON.stringify({
      type: "session.input_audio_buffer.append",
      audio: Buffer.alloc(audio.rate * 2).toString("base64"),
    }));
  }
  ws.send(JSON.stringify({ type: "session.close" }));
}

function lyria(ws: WebSocket, req: Request): void {
  ws.send(JSON.stringify({ type: "connect" }));
  ws.send(JSON.stringify({ type: "prompt", prompt: input(req) }));
  ws.send(JSON.stringify({ type: "play" }));
}

async function boot(ws: WebSocket, item: Target, req: Request, bytes: Buffer | null, continuous = false): Promise<void> {
  if (item.path === "/flux") {
    if (!bytes) throw new Error("Realtime transcription requires input audio");
    ws.send(bytes, { binary: true });
    if (!continuous) {
      ws.send(JSON.stringify({ type: "CloseStream" }));
    }
    return;
  }

  if (item.path === "/scribe") {
    if (!bytes) throw new Error("Realtime transcription requires input audio");
    ws.send(bytes, { binary: true });
    return;
  }

  if (item.path === "/whisper") {
    if (!bytes) throw new Error("Realtime transcription requires input audio");
    whisper(ws, item, req, bytes);
    return;
  }

  if (item.path === "/lyria") {
    lyria(ws, req);
    return;
  }

  if (item.operation === "realtime-translation") {
    if (!bytes) throw new Error("Realtime audio operation requires input audio");
    translate(ws, item, req, bytes);
    return;
  }

  if (item.operation === "realtime-transcription" && !bytes) {
    throw new Error("Realtime audio operation requires input audio");
  }
  openai(ws, req, bytes);
}

function connect(url: URL, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers = internalRealtimeHeaders();
    const ws = Object.keys(headers).length > 0
      ? new WebSocket(url.toString(), { headers })
      : new WebSocket(url.toString());
    const abort = () => {
      ws.close();
      reject(new Error("Realtime execution aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    ws.once("open", () => {
      signal?.removeEventListener("abort", abort);
      resolve(ws);
    });
    ws.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

async function run(item: Target, req: Request, signal?: AbortSignal): Promise<Output> {
  let bytes = await audio(req, signal);
  if (item.path === "/flux" && bytes) {
    bytes = pcm(bytes).data;
  }
  const ws = await connect(wire(item), signal);
  let closedSent = false;
  let transcript = "";
  let lastUsage: Usage | undefined;
  let lastMedia: Media | undefined;
  const timeoutMs = Math.max(1, Number(process.env.REALTIME_TIMEOUT_MS || 30000));

  return await new Promise<Output>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { }
      reject(new Error("Realtime execution timed out before terminal provider evidence"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      ws.removeAllListeners();
      ws.on("error", () => {});
    };
    const abort = () => {
      cleanup();
      try { ws.close(); } catch { }
      reject(new Error("Realtime execution aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    ws.on("message", (raw) => {
      const data = parse(raw);
      if (!data) return;

      if (done(data, req.responseId)) {
        cleanup();
        if (data.type === "error" || data.status === "failed") {
          reject(new Error(text(data.error) ?? "Realtime execution failed"));
          return;
        }
        const finalUsage = usage(data.usage) ?? lastUsage;
        const finalMedia = media(data.media) ?? lastMedia;
        if (!finalUsage && !finalMedia) {
          reject(new Error("Realtime execution ended without provider usage or media evidence"));
          return;
        }
        resolve({
          modality: "realtime",
          content: transcript,
          ...(finalUsage ? { usage: finalUsage } : {}),
          ...(finalMedia ? { media: finalMedia } : {}),
          finishReason: "stop",
        });
        return;
      }

      const piece = content(data);
      if (piece) transcript += piece;
      lastUsage = usage(data.usage) ?? usage(record(data.response)?.usage) ?? usage(record(data.output)?.usage) ?? lastUsage;
      lastMedia = media(data.media) ?? timed(data) ?? lastMedia;

      if (!closedSent && closed(data)) {
        closedSent = true;
        ws.send(JSON.stringify({ type: "close" }));
        if (lastUsage || lastMedia) {
          cleanup();
          try { ws.close(); } catch { }
          resolve({
            modality: "realtime",
            content: transcript,
            ...(lastUsage ? { usage: lastUsage } : {}),
            ...(lastMedia ? { media: lastMedia } : {}),
            finishReason: "stop",
          });
        }
      }
    });

    ws.on("close", () => {
      cleanup();
      reject(new Error("Realtime service closed before terminal provider evidence"));
    });
    ws.on("error", (error) => {
      cleanup();
      reject(error);
    });

    void boot(ws, item, req, bytes).catch((error) => {
      cleanup();
      try { ws.close(); } catch { }
      reject(error);
    });
  });
}

async function* runStream(item: Target, req: Request, signal?: AbortSignal): AsyncGenerator<Event> {
  let bytes = await audio(req, signal);
  if (item.path === "/flux" && bytes) {
    bytes = pcm(bytes).data;
  }

  const ws = await connect(wire(item), signal);
  const queue = new Queue<Event>();
  let sequence = 0;
  let lastUsage: Usage | undefined;
  let lastMedia: Media | undefined;
  let terminal = false;

  const cleanup = () => {
    signal?.removeEventListener("abort", abort);
    ws.removeAllListeners();
    ws.on("error", () => {});
  };

  const finish = () => {
    if (terminal) return;
    terminal = true;
    cleanup();
    queue.end();
  };

  const fail = (error: unknown) => {
    if (terminal) return;
    terminal = true;
    cleanup();
    queue.error(error);
  };

  const abort = () => {
    try { ws.close(); } catch { }
    fail(new Error("Realtime execution aborted"));
  };

  signal?.addEventListener("abort", abort, { once: true });

  ws.on("message", (raw) => {
    const data = parse(raw);
    if (!data) return;

    if (done(data, req.responseId)) {
      if (data.type === "error" || data.status === "failed") {
        fail(new Error(text(data.error) ?? "Realtime execution failed"));
        return;
      }
      const finalUsage = usage(data.usage) ?? lastUsage;
      const finalMedia = media(data.media) ?? lastMedia;
      if (!finalUsage && !finalMedia) {
        fail(new Error("Realtime execution ended without provider usage or media evidence"));
        return;
      }
      queue.push({
        type: "done",
        finishReason: "stop",
        ...(finalUsage ? { usage: finalUsage } : {}),
        ...(finalMedia ? { media: finalMedia } : {}),
      });
      finish();
      return;
    }

    const audioChunk = audioEvent(data, sequence);
    if (audioChunk) {
      sequence += 1;
      lastMedia = audioChunk.media ?? lastMedia;
      queue.push(audioChunk);
    }

    const piece = content(data);
    if (piece) {
      queue.push({ type: "text-delta", text: piece });
    }

    const nextUsage = usage(data.usage) ?? usage(record(data.response)?.usage) ?? usage(record(data.output)?.usage);
    const nextMedia = media(data.media) ?? timed(data);
    if (nextUsage || nextMedia) {
      lastUsage = nextUsage ?? lastUsage;
      lastMedia = nextMedia ?? lastMedia;
      queue.push({
        type: "status",
        ...(nextUsage ? { usage: nextUsage } : {}),
        ...(nextMedia ? { media: nextMedia } : {}),
      });
    }
  });

  ws.on("close", () => {
    if (terminal) return;
    fail(new Error("Realtime service closed before terminal provider evidence"));
  });
  ws.on("error", fail);

  void boot(ws, item, req, bytes, true).catch(fail);

  try {
    for await (const event of queue) {
      yield event;
    }
  } finally {
    if (!terminal) {
      try { sendJson(ws, { type: "close" }); } catch { }
      try { ws.close(); } catch { }
      finish();
    }
  }
}

export async function append(responseId: string, data: Record<string, unknown>): Promise<boolean> {
  const model = text(data.model) ?? text(data.model_id) ?? text(data.modelId);
  if (!model) return false;
  const req: Request = {
    mode: "responses",
    model,
    stream: true,
    modality: "realtime",
    ...(text(data.operation) ? { operation: text(data.operation)! } : {}),
    responseId,
    messages: [],
  };
  const resolved = resolveModel(model);
  const item = target(resolved, req, payloadParams(data) ?? undefined);
  if (!item) return false;
  return post(responseId, "input", await liveFrames(item, data));
}

export async function close(responseId: string): Promise<boolean> {
  return post(responseId, "close");
}

export async function open(req: Request, adapter: Adapter): Promise<Output> {
  const resolved = resolveModel(adapter.modelId);
  const item = target(resolved, req, adapter.params);
  if (!item) {
    throw new Error(`No catalog-resolved realtime handler found for model '${adapter.modelId}'`);
  }

  return run(item, req, adapter.signal);
}

export async function* stream(req: Request, adapter: Adapter): AsyncGenerator<Event> {
  const resolved = resolveModel(adapter.modelId);
  const item = target(resolved, req, adapter.params);
  if (!item) {
    throw new Error(`No catalog-resolved realtime handler found for model '${adapter.modelId}'`);
  }

  yield* runStream(item, req, adapter.signal);
}
