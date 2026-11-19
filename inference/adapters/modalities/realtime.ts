import type { ModelCard } from "../../types.js";
import type { Message } from "../../core.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

const TYPES = [
  "realtime",
  "realtime-transcription",
  "realtime-translation",
] as const;

const INPUTS = ["text", "image", "audio", "video"] as const;
const OUTPUTS = ["text", "audio", "image", "video"] as const;
const ALIBABA = new Set([
  "Realtime-Omni",
  "Realtime-ASR",
  "Realtime-Audio-Translate",
]);
const RESERVED = new Set([
  "authorization",
  "endpoint_origin",
  "endpoint_path",
  "endpoint_url",
  "family",
  "model",
  "model_id",
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

function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(list);
  }
  return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function skip(value: string): boolean {
  return RESERVED.has(lower(value));
}

function caps(model: ModelCard): Record<string, unknown> {
  return record(model.capabilities) ?? {};
}

function params(model: ModelCard): Record<string, unknown> {
  return record(model.params) ?? {};
}

function query(model?: ModelCard | null): Record<string, unknown> {
  return record(model ? params(model).query : undefined) ?? {};
}

function endpoint(model: ModelCard): Record<string, unknown> {
  return record(params(model).endpoint) ?? {};
}

function hasWss(model: ModelCard): boolean {
  return lower(String(endpoint(model).method ?? "")) === "wss";
}

function hasRealtimeParam(model: ModelCard): boolean {
  const type = record(params(model).type);
  return list(type?.options).some((option) => lower(option) === "realtime");
}

function hasRealtimeCapability(model: ModelCard): boolean {
  const capabilities = caps(model);
  return capabilities.realtime === true
    || capabilities.liveApi === true
    || capabilities.live_api === true
    || capabilities["live-api"] === true;
}

function hasAlibabaRealtime(model: ModelCard): boolean {
  const metadata = record(model.sourceMetadata);
  const alibaba = record(metadata?.alibaba);
  return list(alibaba?.capabilities).some((capability) => ALIBABA.has(capability));
}

function hasBatch(model: ModelCard): boolean {
  return caps(model).batch === true;
}

export function isRealtimeModel(model: ModelCard, source: ModelSourceShape): boolean {
  return hasSourceType(source, TYPES)
    || hasWss(model)
    || hasRealtimeParam(model)
    || hasRealtimeCapability(model)
    || hasAlibabaRealtime(model);
}

export function isRealtimeOnlyModel(model: ModelCard, source: ModelSourceShape): boolean {
  if (!isRealtimeModel(model, source)) {
    return false;
  }
  return !hasBatch(model);
}

function shape(source: ModelSourceShape, values: readonly string[]): string[] {
  return source.input
    .concat(source.output)
    .filter((value, index, all) => values.includes(value as never) && all.indexOf(value) === index);
}

function inputs(source: ModelSourceShape): string[] {
  const values = source.input.filter((value) => INPUTS.includes(value as never));
  return values.length > 0 ? values : shape(source, INPUTS);
}

function outputs(source: ModelSourceShape): string[] {
  const values = source.output.filter((value) => OUTPUTS.includes(value as never));
  return values.length > 0 ? values : ["text", "audio"];
}

function operation(source: ModelSourceShape): string {
  if (hasSourceType(source, ["music-generation"]) && hasOutput(source, "audio")) {
    return "realtime-music";
  }
  if (hasSourceType(source, ["realtime-translation"])) {
    return "realtime-translation";
  }
  if (hasSourceType(source, ["realtime-transcription"])) {
    return "realtime-transcription";
  }
  if (hasInput(source, "audio") && hasOutput(source, "text") && !hasOutput(source, "audio")) {
    return "realtime-transcription";
  }
  if (hasInput(source, "audio") && hasOutput(source, "text") && hasOutput(source, "audio") && !hasInput(source, "text")) {
    return "realtime-translation";
  }
  if (hasInput(source, "text") && hasOutput(source, "audio") && !hasInput(source, "audio") && !hasOutput(source, "text")) {
    return "realtime-speech";
  }
  if (hasOutput(source, "audio") || hasInput(source, "audio")) {
    return "realtime-omni";
  }
  return "realtime-session";
}

export function classifyRealtimeModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  if (!isRealtimeModel(model, source)) {
    return [];
  }

  return uniqueCapabilities([
    buildCapability(model, source, "realtime", operation(source), true, {
      input: inputs(source),
      output: outputs(source),
    }),
  ]);
}

function primitive(value: unknown): "string" | "integer" | "number" | "boolean" | "array" | "object" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  return "string";
}

function options(value: unknown): Array<string | number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string | number =>
    typeof item === "string" || typeof item === "number"
  );
  return values.length > 0 ? values : undefined;
}

function def(name: string, value: unknown): Record<string, unknown> | null {
  if (skip(name)) return null;

  if (Array.isArray(value)) {
    const values = options(value);
    return {
      type: primitive(values?.[0]),
      required: false,
      ...(values ? { options: values } : {}),
    };
  }

  if (typeof value === "string") {
    const type = ["string", "integer", "number", "boolean", "array", "object", "string[]"]
      .includes(lower(value))
      ? lower(value).replace("string[]", "array")
      : "string";
    return {
      type,
      required: false,
      ...(name === "include_timestamps" ? { default: true } : {}),
    };
  }

  const shaped = record(value);
  if (shaped) {
    const fallback = shaped.default ?? shaped.options;
    return {
      type: typeof shaped.type === "string" ? shaped.type : primitive(fallback),
      required: shaped.required === true,
      ...(shaped.default !== undefined ? { default: shaped.default } : {}),
      ...(options(shaped.options) ? { options: options(shaped.options) } : {}),
      ...(typeof shaped.minimum === "number" ? { minimum: shaped.minimum } : {}),
      ...(typeof shaped.maximum === "number" ? { maximum: shaped.maximum } : {}),
      ...(typeof shaped.min === "number" ? { minimum: shaped.min } : {}),
      ...(typeof shaped.max === "number" ? { maximum: shaped.max } : {}),
      ...(typeof shaped.description === "string" ? { description: shaped.description } : {}),
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return {
      type: primitive(value),
      required: false,
      default: value,
    };
  }

  return null;
}

function card(model?: ModelCard | null): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(query(model))) {
    const item = def(name, value);
    if (item) out[name] = item;
  }
  return out;
}

export function getRealtimeParameterCatalog(model?: ModelCard | null): Record<string, Record<string, unknown>> {
  return {
    modalities: {
      type: "array",
      required: false,
      description: "The set of modalities the model can respond with. E.g. ['audio'] or ['text'].",
    },
    instructions: {
      type: "string",
      required: false,
      description: "The system instructions or guidance for the session.",
    },
    voice: {
      type: "string",
      required: false,
      description: "The chosen prebuilt voice for audio output.",
    },
    audio_format: {
      type: "string",
      required: false,
      options: ["pcm_8000", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100", "pcm_48000", "ulaw_8000", "alaw_8000"],
      description: "The audio encoding format for the session.",
    },
    sample_rate: {
      type: "integer",
      required: false,
      description: "The audio sample rate in Hz.",
    },
    temperature: {
      type: "number",
      required: false,
      description: "Sampling temperature.",
    },
    max_output_tokens: {
      type: "integer",
      required: false,
      description: "Maximum output tokens.",
    },
    vad_threshold: {
      type: "number",
      required: false,
      description: "Voice activity detection threshold.",
    },
    vad_silence_threshold_secs: {
      type: "number",
      required: false,
      description: "VAD silence detection threshold in seconds.",
    },
    ...card(model),
  };
}

function audio(messages: Message[]): string | null {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "input_audio") continue;
      const value = part.input_audio;
      if (typeof value === "string") return value;
      if (value?.url) return value.url;
    }
  }
  return null;
}

function data(value: string): Buffer | null {
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/su);
  if (!match) return null;
  const encoded = match[2] || "";
  return value.slice(0, value.indexOf(",")).includes(";base64")
    ? Buffer.from(encoded, "base64")
    : Buffer.from(decodeURIComponent(encoded));
}

function wav(buffer: Buffer): { rate?: number; encoding?: "linear16" } | null {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let rate: number | undefined;
  let format: number | undefined;
  let bits: number | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= buffer.length) {
      format = buffer.readUInt16LE(start);
      rate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
      break;
    }
    offset = start + size + (size % 2);
  }

  return { rate, ...(format === 1 && bits === 16 ? { encoding: "linear16" as const } : {}) };
}

export function realtimeInputParams(model: ModelCard | null, messages: Message[]): Record<string, unknown> {
  const source = audio(messages);
  if (!source) return {};
  const payload = data(source);
  if (!payload) return {};
  const wire = wav(payload);
  if (!wire) return {};

  const params = query(model);
  const out: Record<string, unknown> = {};
  if (params.encoding !== undefined && wire.encoding) {
    out.encoding = wire.encoding;
  }
  if (params.sample_rate !== undefined && wire.rate) {
    out.sample_rate = wire.rate;
  }
  if (params.audio_format !== undefined && wire.encoding === "linear16" && wire.rate) {
    out.audio_format = `pcm_${wire.rate}`;
  }
  return out;
}

export interface RealtimeRequest {
  model: string;
  input?: unknown;
  instructions?: string;
  customParams?: Record<string, unknown>;
}

export interface RealtimeSession {
  id: string;
  model: string;
  transport: "websocket";
}
