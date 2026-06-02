export interface Card {
  modelId?: unknown;
  upstreamModelId?: unknown;
  name?: unknown;
  provider?: unknown;
  family?: unknown;
  type?: unknown;
  description?: unknown;
  input?: unknown;
  output?: unknown;
  contextWindow?: unknown;
  pricing?: unknown;
  capabilities?: unknown;
  maxOutputTokens?: unknown;
  ownedBy?: unknown;
  createdAt?: unknown;
  modelType?: unknown;
  sourceMetadata?: unknown;
  params?: unknown;
  semantics?: unknown;
  hfInferenceProvider?: unknown;
  hfProviderId?: unknown;
  available?: unknown;
  availableFrom?: unknown;
}

export interface Data {
  lastUpdated?: unknown;
  totalModels?: unknown;
  models?: unknown;
}

export interface Item {
  key: string;
  modelId: string;
  provider: string;
  family: string;
  name: string | null;
  description: string | null;
  input: string;
  output: string;
  type: string;
  modality: string;
  capabilities: string;
  contextWindow: string | null;
  contextTokens: number | null;
  pricing: string;
  operations: string;
  metadata: string;
  semantics: string;
  stream: number;
  available: number;
  active: 1;
  hash: string;
  batch: string;
  last: string | null;
  text: string;
}

export interface Out {
  batch: string;
  last: string | null;
  count: number;
  hash: string;
  models: Item[];
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CANON = ["text", "image", "audio", "video", "embedding"] as const;

const TEXT = new Map<string, string>([
  ["chat", "chat"],
  ["chat-completions", "chat"],
  ["text-to-text", "chat"],
  ["conversational", "chat"],
  ["text-generation", "chat"],
  ["reasoning", "chat"],
  ["responses", "responses"],
  ["completion", "completion"],
  ["completions", "completion"],
  ["search", "search"],
  ["deep-research", "deep-research"],
  ["question-answering", "question-answering"],
  ["summarization", "summarization"],
  ["translation", "translation"],
  ["moderation", "moderation"],
  ["text-classification", "classification"],
  ["token-classification", "classification"],
  ["zero-shot-classification", "classification"],
  ["classification", "classification"],
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function norm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s/]+/g, "-")
    .replace(/--+/g, "-");
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => list(item)))];
  }
  const text = str(value);
  return text ? [norm(text)] : [];
}

function raw(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => raw(item)))];
  }
  const text = str(value);
  return text ? [text] : [];
}

function json(value: unknown, fallback: Json): string {
  return JSON.stringify(value ?? fallback);
}

function positive(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return false;
}

function caps(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(raw(value).map((key) => [key, true]));
  }
  return rec(value) ?? {};
}

function keys(value: Record<string, unknown>): string[] {
  return Object.entries(value)
    .filter(([, item]) => positive(item))
    .map(([key]) => norm(key))
    .sort();
}

function profile(value: unknown): Record<string, unknown> {
  return rec(value) ?? {};
}

function field(value: Record<string, unknown>, key: string): string[] {
  const item = value[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function opset(value: Record<string, unknown>): string[] {
  const direct = field(value, "operations");
  const caps = Array.isArray(value.operationCapabilities)
    ? value.operationCapabilities
      .map((item) => rec(item)?.operation)
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return [...new Set([...direct, ...caps])].sort();
}

function token(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  const root = rec(value);
  if (!root) return null;
  const hits = [
    root.inputTokens,
    root.outputTokens,
    root.maxInputTokens,
    root.maxOutputTokens,
    root.totalTokens,
    root.contextTokens,
    root.contextLength,
    root.maxContextLength,
    root.tokens,
  ].filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0);

  return hits.length > 0 ? Math.max(...hits.map((item) => Math.floor(item))) : null;
}

function mod(type: string[], input: string[], output: string[]): string[] {
  const set = new Set<string>();
  for (const item of [...input, ...output]) {
    if ((CANON as readonly string[]).includes(item)) set.add(item);
  }
  for (const item of type) {
    if (item.includes("embedding") || item === "feature-extraction") set.add("embedding");
    if (item.includes("image") || item === "object-detection" || item === "depth-estimation") set.add("image");
    if (item.includes("audio") || item.includes("speech") || item.includes("music")) set.add("audio");
    if (item.includes("video")) set.add("video");
    if (TEXT.has(item) || item.includes("text") || item.includes("question") || item.includes("translation")) set.add("text");
  }
  if (set.size === 0) set.add("text");
  return [...set].sort();
}

function ops(type: string[], input: string[], output: string[], cap: string[], name: string, id: string): string[] {
  const set = new Set<string>();
  for (const item of type) {
    const text = TEXT.get(item);
    if (text) set.add(text);
    if ((item === "text-classification" || item === "zero-shot-classification") && /rerank/i.test(`${name} ${id}`)) set.add("rerank");
    if (item === "feature-extraction" || item.includes("embedding")) {
      if (input.includes("image") && input.includes("text")) set.add("multimodal-embedding");
      else if (input.includes("image")) set.add("image-to-embedding");
      else if (input.includes("audio")) set.add("audio-to-embedding");
      else set.add("text-to-embedding");
    }
    if (item === "text-to-image" || item === "image-generation" || item === "unconditional-image-generation") set.add("text-to-image");
    if (item === "image-to-image" || item === "image-edit" || item === "inpainting" || item === "outpainting") set.add("image-to-image");
    if (item === "image-to-text" || item === "image-text-to-text") {
      set.add("image-to-text");
      set.add("vision-chat");
    }
    if (item === "object-detection") set.add("object-detection");
    if (item === "image-segmentation") set.add("image-segmentation");
    if (item === "image-classification") set.add("image-classification");
    if (item === "depth-estimation") set.add("depth-estimation");
    if (item === "text-to-video" || item === "video-generation") set.add("text-to-video");
    if (item === "image-to-video") set.add("image-to-video");
    if (item === "video-to-text" || item === "video-classification") set.add("video-to-text");
    if (item === "text-to-speech") set.add("text-to-speech");
    if (item === "speech-to-text" || item === "automatic-speech-recognition") set.add("speech-to-text");
    if (item === "text-to-audio" || item === "music-generation") set.add("text-to-audio");
    if (item === "audio-classification") set.add("audio-classification");
  }
  if (type.includes("videos") && output.includes("video")) {
    if (input.includes("text")) set.add("text-to-video");
    if (input.includes("image")) set.add("image-to-video");
  }
  if (output.includes("image")) {
    if (input.includes("text")) set.add("text-to-image");
    if (input.includes("image")) set.add("image-to-image");
  }
  if (output.includes("video")) {
    if (input.includes("text")) set.add("text-to-video");
    if (input.includes("image")) set.add("image-to-video");
  }
  if (output.includes("audio")) {
    if (input.includes("text")) set.add("text-to-speech");
    if (input.includes("audio")) set.add("speech-to-speech");
  }
  if (input.includes("audio") && output.includes("text")) set.add("speech-to-text");
  if (input.includes("image") && output.includes("text")) {
    set.add("image-to-text");
    set.add("vision-chat");
  }
  if (output.includes("embedding")) {
    if (input.includes("image") && input.includes("text")) set.add("multimodal-embedding");
    else if (input.includes("image")) set.add("image-to-embedding");
    else if (input.includes("audio")) set.add("audio-to-embedding");
    else set.add("text-to-embedding");
  }
  if (cap.includes("tool-use") || cap.includes("tools")) set.add("tool-use");
  if (set.size === 0 && (input.includes("text") || output.includes("text"))) set.add("chat");
  return [...set].sort();
}

function meta(card: Card): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "maxOutputTokens",
    "upstreamModelId",
    "ownedBy",
    "createdAt",
    "modelType",
    "sourceMetadata",
    "params",
    "hfInferenceProvider",
    "hfProviderId",
    "availableFrom",
  ] as const) {
    if (card[key] !== undefined) out[key] = card[key];
  }
  return out;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function key(provider: string, id: string): Promise<string> {
  const base = `${provider}:${id}`;
  if (new TextEncoder().encode(base).length <= 64) return base;
  return `${norm(provider)}:${(await sha(base)).slice(0, 48)}`;
}

function text(item: Omit<Item, "text">, cap: string[]): string {
  const semantic = profile(JSON.parse(item.semantics));
  const characteristics = field(semantic, "characteristics");
  const parameters = field(semantic, "parameterKeys");
  const sourceTypes = field(semantic, "sourceTypes");
  return [
    `modelId: ${item.modelId}`,
    `name: ${item.name ?? item.modelId}`,
    `provider: ${item.provider}`,
    `family: ${item.family}`,
    `description: ${item.description ?? ""}`,
    `type: ${JSON.parse(item.type).join(", ")}`,
    `modality: ${JSON.parse(item.modality).join(", ")}`,
    `input: ${JSON.parse(item.input).join(", ")}`,
    `output: ${JSON.parse(item.output).join(", ")}`,
    `operations: ${JSON.parse(item.operations).join(", ")}`,
    `capabilities: ${cap.join(", ")}`,
    `semantic modalities: ${field(semantic, "modalities").join(", ")}`,
    `semantic operations: ${field(semantic, "operations").join(", ")}`,
    `semantic inputs: ${field(semantic, "inputs").join(", ")}`,
    `semantic outputs: ${field(semantic, "outputs").join(", ")}`,
    `source types: ${sourceTypes.join(", ")}`,
    `parameters: ${parameters.join(", ")}`,
    `characteristics: ${characteristics.join("; ")}`,
    `contextWindow: ${item.contextWindow ?? ""}`,
    `pricing: ${item.pricing}`,
  ].join("\n");
}

function cards(value: unknown): Card[] {
  return Array.isArray(value)
    ? value.filter((item): item is Card => Boolean(rec(item)))
    : [];
}

function weight(item: Item): number {
  return [
    item.name,
    item.description,
    item.contextWindow,
    item.pricing === "{}" ? null : item.pricing,
    item.capabilities === "{}" ? null : item.capabilities,
    item.metadata === "{}" ? null : item.metadata,
  ].filter(Boolean).length;
}

export async function clean(input: Data, batch: string): Promise<Out> {
  const last = str(input.lastUpdated);
  const rows = new Map<string, Item>();

  for (const card of cards(input.models)) {
    const id = str(card.modelId);
    const provider = str(card.provider);
    if (!id || !provider) continue;

    const type = list(card.type);
    const family = str(card.family);
    const inputList = list(card.input);
    const outputList = list(card.output);
    const cap = caps(card.capabilities);
    const capKeys = keys(cap);
    const semantic = profile(card.semantics);
    const semanticModalities = field(semantic, "modalities");
    const modality = semanticModalities.length > 0 ? semanticModalities : mod(type, inputList, outputList);
    const semanticOps = opset(semantic);
    const operations = semanticOps.length > 0 ? semanticOps : ops(type, inputList, outputList, capKeys, str(card.name) ?? "", id);
    const contextTokens = token(card.contextWindow);
    const base = {
      key: await key(provider, id),
      modelId: id,
      provider,
      family: family ? norm(family) : "",
      name: str(card.name),
      description: str(card.description),
      input: json(inputList, []),
      output: json(outputList, []),
      type: json(type, []),
      modality: json(modality, []),
      capabilities: json(cap, {}),
      contextWindow: card.contextWindow === undefined || card.contextWindow === null ? null : json(card.contextWindow, null),
      contextTokens,
      pricing: json(card.pricing, {}),
      operations: json(operations, []),
      metadata: json(meta(card), {}),
      semantics: json(semantic, {}),
      stream: capKeys.includes("streaming") || operations.includes("chat") || operations.includes("responses") ? 1 : 0,
      available: card.available === false ? 0 : 1,
      active: 1 as const,
      hash: await sha(JSON.stringify(card)),
      batch,
      last,
    };
    const item = {
      ...base,
      text: text(base, capKeys),
    };
    const existing = rows.get(item.key);
    if (!existing || weight(item) > weight(existing)) {
      rows.set(item.key, item);
    }
  }

  const models = [...rows.values()].sort((a, b) => `${a.provider}:${a.modelId}`.localeCompare(`${b.provider}:${b.modelId}`));
  return {
    batch,
    last,
    count: models.length,
    hash: await sha(JSON.stringify({ last, models: models.map((item) => [item.key, item.hash]) })),
    models,
  };
}

export const test = { caps, key, list, mod, ops, token };
