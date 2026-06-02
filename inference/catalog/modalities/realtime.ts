import type { ModelCard } from "../../types.js";
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

function caps(model: ModelCard): Record<string, unknown> {
  return record(model.capabilities) ?? {};
}

function params(model: ModelCard): Record<string, unknown> {
  return record(model.params) ?? {};
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
  return list(alibaba?.capabilities).some((capability) => lower(capability).startsWith("realtime-"));
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

export function getRealtimeParameterCatalog(): Record<string, Record<string, unknown>> {
  return {};
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
