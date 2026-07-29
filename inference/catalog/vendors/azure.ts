/**
 * Azure Foundry vendor shim.
 *
 * Azure aggregates several model families behind one OpenAI-compatible
 * surface, plus a handful of provider-native routes (Cohere rerank,
 * BlackForestLabs FLUX, MAI image, Mistral OCR). The OpenAI-shaped
 * routes (chat / embeddings / images / responses) reuse
 * `families/openai.ts` wire helpers; this module only carries the
 * Azure-specific routing + credentials + provider-native routes.
 */

import { getModelById } from "../registry.js";
import { pricingHasTokenSections } from "../../telemetry.js";
import type { Call, Choice, Event, Format, Message, ResponsesOutputItem, Tool, Usage } from "../../core.js";
import {
  buildBodyChat,
  buildBodyResponses,
  mapMessagesForResponsesWire,
} from "../families/openai.js";
import {
  MAI_PATH_IMAGES,
  buildImageBody as buildMaiImageBody,
  meteredImageUsage as meteredMaiImageUsage,
  parseImageResponse as parseMaiImageResponse,
} from "../families/microsoft.js";
import {
  asRecord,
  audioMimeType as _audioMimeType,
  bufferFromPayload,
  clean,
  findAttachmentUrl,
  normalizeOpenAIUsage,
  postJson,
  primaryText,
  sizeToDimensions,
} from "../shared/index.js";

void _audioMimeType;

interface AzureCredential {
  label: string;
  endpoint: string;
  apiKey: string;
  baseUrl: string;
}

interface AzureDeploymentMetadata {
  resource?: string;
  deploymentName?: string;
  modelName?: string;
  modelVersion?: string;
  modelFormat?: string;
}

type AzureRoute =
  | "openai_chat"
  | "openai_responses"
  | "openai_embeddings"
  | "openai_image"
  | "cohere_rerank"
  | "blackforestlabs_image"
  | "mai_image"
  | "mistral_ocr";

export interface AzureChatResult {
  text: string;
  reasoning?: string;
  usage?: Usage;
  finishReason?: string;
  toolCalls?: Call[];
  outputItems?: ResponsesOutputItem[];
  raw: unknown;
}

export interface AzureEmbeddingResult {
  embeddings: number[][];
  usage?: Usage;
  raw: unknown;
}

export interface AzureImageResult {
  buffer: Buffer;
  mimeType: string;
  usage?: Usage;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Endpoint / credentials
// ---------------------------------------------------------------------------

function baseUrl(endpoint: string): string {
  return endpoint
    .replace(/\/+$/, "")
    .replace(/\/api\/projects\/[^/]+$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/openai\/v1$/i, "");
}

function azureCredentials(): AzureCredential[] {
  return [
    {
      label: "Microsoft",
      endpoint: clean(process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT),
      apiKey: clean(process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY || process.env.AZURE_FOUNDRY_API_KEY),
    },
    {
      label: "Movzihpn",
      endpoint: clean(process.env.AZURE_MOVZIHPN_ENDPOINT),
      apiKey: clean(process.env.AZURE_MOVZIHPN_API_KEY),
    },
    {
      label: "Mov00xvh",
      endpoint: clean(process.env.AZURE_MOV00XVH_ENDPOINT),
      apiKey: clean(process.env.AZURE_MOV00XVH_API_KEY),
    },
  ].filter((credential) => credential.endpoint && credential.apiKey)
    .map((credential) => ({
      ...credential,
      baseUrl: baseUrl(credential.endpoint),
    }));
}

function deploymentMetadata(modelId: string): AzureDeploymentMetadata {
  const card = getModelById(modelId, "azure");
  const source = asRecord(card?.sourceMetadata);
  const deployment = asRecord(source?.azureDeployment);
  if (!deployment) return {};
  return {
    resource: clean(deployment.resource),
    deploymentName: clean(deployment.deploymentName),
    modelName: clean(deployment.modelName),
    modelVersion: clean(deployment.modelVersion),
    modelFormat: clean(deployment.modelFormat),
  };
}

function credentialForModel(modelId: string): AzureCredential {
  const credentials = azureCredentials();
  if (credentials.length === 0) {
    throw new Error("Azure provider credentials are not configured");
  }
  const deployment = deploymentMetadata(modelId);
  const matched = deployment.resource
    ? credentials.find((credential) => credential.label === deployment.resource)
    : undefined;
  if (deployment.resource && !matched) {
    throw new Error(`Azure credential not configured for deployed resource: ${deployment.resource}`);
  }
  return matched || credentials[0];
}

function deploymentNameForModel(modelId: string): string {
  return deploymentMetadata(modelId).deploymentName || modelId;
}

function routeForModel(modelId: string, operation?: string): AzureRoute {
  const card = getModelById(modelId, "azure");
  const deployment = deploymentMetadata(modelId);
  const format = (deployment.modelFormat || "").toLowerCase();
  const joined = `${modelId} ${deployment.deploymentName || ""} ${deployment.modelName || ""}`.toLowerCase();
  const capabilities = asRecord(card?.capabilities) || {};
  const type = clean(card?.type).toLowerCase();
  if (
    format === "cohere"
    && joined.includes("rerank")
    && (operation === "rerank" || operation === "classification" || operation === "classify")
  ) {
    return "cohere_rerank";
  }
  if (format === "mistral ai" && joined.includes("mistral-document-ai")) return "mistral_ocr";
  if (format === "black forest labs" && joined.includes("flux.2")) return "blackforestlabs_image";
  if (joined.includes("mai-image-2")) return "mai_image";
  if (type === "feature-extraction" || capabilities.embeddings === true) return "openai_embeddings";
  if (type === "text-to-image" || type === "image-to-image" || capabilities.image_generation === true || capabilities.image_generations === true) {
    return "openai_image";
  }
  if (capabilities.responses === true && capabilities.chat_completion !== true) return "openai_responses";
  return "openai_chat";
}

function azureUrl(credential: AzureCredential, path: string): string {
  return `${credential.baseUrl}/${path.replace(/^\/+/, "")}`;
}

function azureHeaders(credential: AzureCredential, auth: "api-key" | "bearer"): Record<string, string> {
  return auth === "bearer"
    ? { Authorization: `Bearer ${credential.apiKey}` }
    : { "api-key": credential.apiKey };
}

function postAzure(
  credential: AzureCredential,
  path: string,
  body: Record<string, unknown>,
  auth: "api-key" | "bearer" = "api-key",
  signal?: AbortSignal,
): Promise<unknown> {
  return postJson(azureUrl(credential, path), body, azureHeaders(credential, auth), signal);
}

async function postAzureForm(
  credential: AzureCredential,
  path: string,
  form: FormData,
  auth: "api-key" | "bearer" = "api-key",
): Promise<unknown> {
  const response = await fetch(azureUrl(credential, path), {
    method: "POST",
    headers: azureHeaders(credential, auth),
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`fetchJson HTTP ${response.status} ${response.statusText} @ ${azureUrl(credential, path)}: ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) : {};
}

function omit(
  customParams: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!customParams) return undefined;
  const blocked = new Set(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(customParams)) {
    if (value !== undefined && !blocked.has(key)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function servicesEndpoint(credential: AzureCredential): boolean {
  try {
    return new URL(credential.baseUrl).hostname.endsWith(".services.ai.azure.com");
  } catch {
    return credential.baseUrl.includes(".services.ai.azure.com");
  }
}

function tokenPriced(modelId: string): boolean {
  return pricingHasTokenSections(getModelById(modelId, "azure")?.pricing);
}

function missingMaiUsage(modelId: string): Error {
  return Object.assign(
    new Error(`Azure MAI image response is missing authoritative token usage for token-priced model ${modelId}; cannot settle this generation`),
    { statusCode: 400, code: "missing_authoritative_usage", retryable: false },
  );
}

function audioFormat(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("ogg") || normalized.includes("opus")) return "opus";
  return "wav";
}

async function inlineAudio(messages: Message[], signal?: AbortSignal): Promise<Message[]> {
  let changed = false;
  const mapped: Message[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      mapped.push(message);
      continue;
    }

    const content: unknown[] = [];
    for (const raw of message.content) {
      const part = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as unknown as Record<string, unknown> : null;
      if (part?.type !== "input_audio") {
        content.push(raw);
        continue;
      }

      const value = part.input_audio;
      const record = asRecord(value);
      const locator = typeof value === "string" ? clean(value) : clean(record?.url);
      if (!locator) {
        content.push(raw);
        continue;
      }

      const media = await bufferFromPayload(locator, "audio/wav", signal);
      content.push({
        type: "input_audio",
        input_audio: {
          data: media.buffer.toString("base64"),
          format: audioFormat(media.mimeType),
        },
      });
      changed = true;
    }

    mapped.push(changed ? { ...message, content } as unknown as Message : message);
  }

  return changed ? mapped : messages;
}

// ---------------------------------------------------------------------------
// Response shape readers
// ---------------------------------------------------------------------------

function textFromResponses(raw: unknown): string {
  const root = asRecord(raw);
  if (!root) return "";
  if (typeof root.output_text === "string") return root.output_text;
  const output = Array.isArray(root.output) ? root.output : [];
  return output.flatMap((item) => {
    const record = asRecord(item);
    const content = Array.isArray(record?.content) ? record.content : [];
    return content.map((part) => {
      const partRecord = asRecord(part);
      return clean(partRecord?.text) || clean(partRecord?.value);
    });
  }).filter(Boolean).join("\n");
}

function callsFromResponses(raw: unknown): Call[] | undefined {
  const root = asRecord(raw);
  const output = Array.isArray(root?.output) ? root.output : [];
  const calls: Call[] = [];
  for (let i = 0; i < output.length; i += 1) {
    const item = asRecord(output[i]);
    if (!item) continue;
    const type = clean(item.type);
    if (type !== "function_call" && type !== "tool_call") continue;
    const name = clean(item.name);
    if (!name) continue;
    const itemId = clean(item.id) || `fc_${i}`;
    const callId = clean(item.call_id) || `call_${i}`;
    calls.push({
      id: callId,
      itemId,
      callId,
      outputIndex: i,
      name,
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function callsFromChat(raw: unknown): Call[] | undefined {
  const root = asRecord(raw) || {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: Call[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const item = asRecord(calls[i]);
    if (!item) continue;
    const fn = asRecord(item.function);
    const name = clean(fn?.name);
    if (!name) continue;
    out.push({
      id: clean(item.id) || `call_${i}`,
      name,
      arguments: clean(fn?.arguments) || "{}",
    });
  }
  return out.length > 0 ? out : undefined;
}

function chatText(raw: unknown): { text: string; reasoning?: string; finishReason?: string; usage?: Usage; toolCalls?: Call[] } {
  const root = asRecord(raw) || {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  const toolCalls = callsFromChat(raw);
  return {
    text: clean(message.content),
    ...(clean(message.reasoning_content) ? { reasoning: clean(message.reasoning_content) } : {}),
    finishReason: toolCalls ? "tool-calls" : clean(first.finish_reason) || undefined,
    usage: normalizeOpenAIUsage(root.usage),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

async function azureImageFromRaw(raw: unknown): Promise<{ buffer: Buffer; mimeType: string }> {
  const root = asRecord(raw) || {};
  const data = Array.isArray(root.data) ? root.data : [];
  const first = asRecord(data[0]) || root;
  const payload = clean(first.b64_json) || clean(first.base64) || clean(first.image) || clean(first.url);
  if (!payload) throw new Error("Azure returned no image data");
  return bufferFromPayload(payload, "image/png");
}

// ---------------------------------------------------------------------------
// Provider-native routes
// ---------------------------------------------------------------------------

export async function generateAzureResponses(
  modelId: string,
  messages: Message[],
  options: {
    temperature?: number;
    maxTokens?: number;
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: Format;
    customParams?: Record<string, unknown>;
    inputItems?: Array<Record<string, unknown>>;
    signal?: AbortSignal;
  },
): Promise<AzureChatResult> {
  const credential = credentialForModel(modelId);
  const body = buildBodyResponses(modelId, options.inputItems?.length ? options.inputItems : mapMessagesForResponsesWire(messages), {
    wireModelId: deploymentNameForModel(modelId),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    customParams: omit(options.customParams, ["stream", "stream_options"]),
  });
  const raw = await postAzure(credential, "/openai/v1/responses", body, "api-key", options.signal);
  const root = asRecord(raw) || {};
  const toolCalls = callsFromResponses(raw);
  const outputItems = (Array.isArray(root.output) ? root.output : [])
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null && typeof item.type === "string")
    .map((item) => ({ ...item } as ResponsesOutputItem));
  return {
    text: textFromResponses(raw),
    usage: normalizeOpenAIUsage(root.usage),
    finishReason: toolCalls ? "tool-calls" : clean(root.status) || "stop",
    ...(toolCalls ? { toolCalls } : {}),
    ...(outputItems.length > 0 ? { outputItems } : {}),
    raw,
  };
}

async function generateAzureRerank(
  modelId: string,
  messages: Message[],
  customParams: Record<string, unknown> = {},
  operation?: string,
): Promise<AzureChatResult> {
  const labels = Array.isArray(customParams.candidate_labels)
    ? customParams.candidate_labels
    : Array.isArray(customParams.labels)
      ? customParams.labels
      : [];
  const labelDocs = labels
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    .map((label) => ({ label, text: label }));
  const query = clean(customParams.query) || primaryText(messages);
  const documents = Array.isArray(customParams.documents)
    ? customParams.documents
    : Array.isArray(customParams.texts)
      ? customParams.texts
      : Array.isArray(customParams.contexts)
        ? customParams.contexts
        : labelDocs;
  if (documents.length === 0) {
    throw new Error(operation === "classification" || operation === "classify"
      ? "Azure Cohere classification requires candidate_labels"
      : "Azure Cohere rerank requires documents");
  }
  const credential = credentialForModel(modelId);
  const raw = await postAzure(credential, "/providers/cohere/v2/rerank", {
    model: deploymentNameForModel(modelId),
    query,
    documents,
    ...(typeof customParams.top_n === "number" ? { top_n: customParams.top_n } : {}),
    ...(typeof customParams.top_k === "number" ? { top_n: customParams.top_k } : {}),
    ...(typeof customParams.max_chunks_per_doc === "number" ? { max_chunks_per_doc: customParams.max_chunks_per_doc } : {}),
  });
  if (labelDocs.length > 0 && documents === labelDocs) {
    const root = asRecord(raw) || {};
    const results = Array.isArray(root.results) ? root.results : [];
    const ranked = results
      .map((entry) => {
        const item = asRecord(entry);
        const index = typeof item?.index === "number" ? item.index : -1;
        const doc = index >= 0 ? labelDocs[index] : undefined;
        const score = typeof item?.relevance_score === "number" ? item.relevance_score : 0;
        return doc ? { label: doc.label, score } : null;
      })
      .filter((item): item is { label: string; score: number } => item !== null);
    const total = ranked.reduce((sum, item) => sum + Math.max(0, item.score), 0);
    const labels = ranked.map((item) => ({
      label: item.label,
      score: total > 0 ? item.score / total : item.score,
    }));
    return {
      text: JSON.stringify({ labels, raw }),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: { request: 1, search: 1, document: documents.length } },
      finishReason: "stop",
      raw,
    };
  }
  return {
    text: JSON.stringify(raw),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: { request: 1, search: 1, document: documents.length } },
    finishReason: "stop",
    raw,
  };
}

async function generateAzureOcr(
  modelId: string,
  messages: Message[],
  customParams: Record<string, unknown> = {},
): Promise<AzureChatResult> {
  const document = asRecord(customParams.document) || {
    type: "image_url",
    image_url: clean(customParams.image_url) || findAttachmentUrl(messages, "image_url"),
  };
  if (!document.image_url) {
    throw new Error("Azure Mistral document OCR requires an image_url document");
  }
  const credential = credentialForModel(modelId);
  const raw = await postAzure(credential, "/providers/mistral/azure/ocr", {
    model: deploymentNameForModel(modelId),
    document,
  });
  const root = asRecord(raw) || {};
  const pages = Array.isArray(root.pages) ? root.pages : [];
  const text = pages.map((page) => {
    const record = asRecord(page) || {};
    return clean(record.markdown) || clean(record.text);
  }).filter(Boolean).join("\n\n") || JSON.stringify(raw);
  return {
    text,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, billingMetrics: { request: 1, page: pages.length || 1 } },
    finishReason: "stop",
    raw,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function generateAzureChat(
  modelId: string,
  messages: Message[],
  options: {
    temperature?: number;
    maxTokens?: number;
    tools?: Tool[];
    toolChoice?: Choice;
    responseFormat?: Format;
    customParams?: Record<string, unknown>;
    operation?: string;
    inputItems?: Array<Record<string, unknown>>;
    signal?: AbortSignal;
  } = {},
): Promise<AzureChatResult> {
  const route = routeForModel(modelId, options.operation);
  if (route === "openai_responses") return generateAzureResponses(modelId, messages, options);
  if (route === "cohere_rerank") return generateAzureRerank(modelId, messages, options.customParams, options.operation);
  if (route === "mistral_ocr") return generateAzureOcr(modelId, messages, options.customParams);

  const credential = credentialForModel(modelId);
  const card = getModelById(modelId, "azure");
  const capabilities = asRecord(card?.capabilities) || {};
  if (servicesEndpoint(credential) && capabilities.responses === true) {
    return generateAzureResponses(modelId, messages, options);
  }
  const joined = `${modelId} ${deploymentMetadata(modelId).deploymentName || ""} ${deploymentMetadata(modelId).modelName || ""}`.toLowerCase();
  const omitMaxCompletionTokens = joined.includes("grok-4-20-non-reasoning") || joined.includes("mistral-large-3");
  const wireMessages = await inlineAudio(messages, options.signal);
  const raw = await postAzure(credential, "/openai/v1/chat/completions", buildBodyChat(modelId, wireMessages, {
    wireModelId: deploymentNameForModel(modelId),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" && !omitMaxCompletionTokens ? { maxTokens: options.maxTokens } : {}),
    maxTokensField: "max_completion_tokens",
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    customParams: omit(options.customParams, ["stream", "stream_options"]),
  }), "api-key", options.signal);
  return { ...chatText(raw), raw };
}

interface AzureToolAccumulator {
  id: string;
  itemId?: string;
  callId?: string;
  name: string;
  arguments: string;
  index: number;
}

type AzureChatOptions = NonNullable<Parameters<typeof generateAzureChat>[2]>;

async function* sseJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(`Azure stream HTTP ${response.status}: ${detail.slice(0, 1000)}`);
  }

  const reader = response.body.getReader();
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
      throw new Error(`Azure stream returned invalid SSE JSON: ${data.slice(0, 500)}`);
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

function streamFinishReason(value: unknown, hasTools: boolean): string {
  const reason = clean(value).toLowerCase();
  if (hasTools || reason === "tool_calls" || reason === "tool-calls") return "tool-calls";
  if (!reason || reason === "completed" || reason === "stop") return "stop";
  if (reason === "incomplete") return "length";
  if (reason === "content_filter") return "content-filter";
  return reason;
}

async function* streamAzureChatWire(
  modelId: string,
  messages: Message[],
  options: AzureChatOptions,
  credential: AzureCredential,
): AsyncGenerator<Event> {
  const joined = `${modelId} ${deploymentMetadata(modelId).deploymentName || ""} ${deploymentMetadata(modelId).modelName || ""}`.toLowerCase();
  const omitMaxCompletionTokens = joined.includes("grok-4-20-non-reasoning") || joined.includes("mistral-large-3");
  const wireMessages = await inlineAudio(messages, options.signal);
  const baseBody = buildBodyChat(modelId, wireMessages, {
    wireModelId: deploymentNameForModel(modelId),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" && !omitMaxCompletionTokens ? { maxTokens: options.maxTokens } : {}),
    maxTokensField: "max_completion_tokens",
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    customParams: omit(options.customParams, ["stream", "stream_options"]),
  });
  const response = await fetch(azureUrl(credential, "/openai/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...azureHeaders(credential, "api-key") },
    body: JSON.stringify({
      ...baseBody,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: options.signal,
  });
  const tools = new Map<number, AzureToolAccumulator>();
  let usage: Usage | undefined;
  let finishReason: unknown;

  for await (const chunk of sseJson(response)) {
    usage = normalizeOpenAIUsage(chunk.usage) || usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      const delta = asRecord(choice?.delta);
      if (typeof delta?.content === "string" && delta.content) {
        yield { type: "text-delta", text: delta.content };
      }
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        yield { type: "reasoning-delta", text: delta.reasoning_content };
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
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    }
  }

  for (const call of [...tools.values()].sort((left, right) => left.index - right.index)) {
    yield { type: "tool-call", toolCall: { ...call, arguments: call.arguments || "{}" } };
  }
  if (!usage) throw new Error(`Azure chat stream returned no authoritative usage for ${modelId}`);
  yield { type: "done", finishReason: streamFinishReason(finishReason, tools.size > 0), usage };
}

async function* streamAzureResponsesWire(
  modelId: string,
  messages: Message[],
  options: AzureChatOptions,
  credential: AzureCredential,
): AsyncGenerator<Event> {
  const body = buildBodyResponses(
    modelId,
    options.inputItems?.length ? options.inputItems : mapMessagesForResponsesWire(messages),
    {
      wireModelId: deploymentNameForModel(modelId),
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxTokens === "number" ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
      customParams: omit(options.customParams, ["stream", "stream_options"]),
      stream: true,
    },
  );
  const response = await fetch(azureUrl(credential, "/openai/v1/responses"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...azureHeaders(credential, "api-key") },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const tools = new Map<number, AzureToolAccumulator>();
  const outputItems = new Map<number, ResponsesOutputItem>();
  let usage: Usage | undefined;
  let status: unknown;

  for await (const event of sseJson(response)) {
    usage = normalizeOpenAIUsage(event.usage) || usage;
    const type = clean(event.type);
    const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
    if (type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
      yield { type: "text-delta", text: event.delta, itemId: clean(event.item_id) || undefined, outputIndex };
      continue;
    }
    if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && typeof event.delta === "string" && event.delta) {
      yield { type: "reasoning-delta", text: event.delta, itemId: clean(event.item_id) || undefined, outputIndex };
      continue;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = asRecord(event.item);
      if (item && (clean(item.type) === "function_call" || clean(item.type) === "tool_call")) {
        const current = tools.get(outputIndex) || { id: `call_${outputIndex}`, name: "", arguments: "", index: outputIndex };
        current.itemId = clean(item.id) || current.itemId || `fc_${outputIndex}`;
        current.callId = clean(item.call_id) || current.callId || `call_${outputIndex}`;
        current.id = current.callId;
        current.name = clean(item.name) || current.name;
        if (typeof item.arguments === "string" && item.arguments) current.arguments = item.arguments;
        tools.set(outputIndex, current);
      }
      if (type === "response.output_item.done" && item && typeof item.type === "string") {
        outputItems.set(outputIndex, { ...item } as ResponsesOutputItem);
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const current = tools.get(outputIndex) || {
        id: `call_${outputIndex}`,
        itemId: clean(event.item_id) || `fc_${outputIndex}`,
        callId: `call_${outputIndex}`,
        name: "",
        arguments: "",
        index: outputIndex,
      };
      current.arguments += delta;
      tools.set(outputIndex, current);
      yield {
        type: "tool-call-delta",
        toolCallDelta: {
          index: outputIndex,
          id: current.id,
          itemId: current.itemId,
          callId: current.callId,
          ...(current.name ? { name: current.name } : {}),
          ...(delta ? { arguments: delta } : {}),
        },
      };
      continue;
    }
    if (type === "response.function_call_arguments.done") {
      const current = tools.get(outputIndex) || {
        id: `call_${outputIndex}`,
        itemId: clean(event.item_id) || `fc_${outputIndex}`,
        callId: `call_${outputIndex}`,
        name: "",
        arguments: "",
        index: outputIndex,
      };
      current.name = clean(event.name) || current.name;
      if (typeof event.arguments === "string") current.arguments = event.arguments;
      tools.set(outputIndex, current);
      continue;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const completed = asRecord(event.response);
      usage = normalizeOpenAIUsage(completed?.usage) || usage;
      status = completed?.status;
      for (const [index, rawItem] of (Array.isArray(completed?.output) ? completed.output : []).entries()) {
        const item = asRecord(rawItem);
        if (!item || typeof item.type !== "string") continue;
        outputItems.set(index, { ...item } as ResponsesOutputItem);
        if (clean(item.type) === "function_call" || clean(item.type) === "tool_call") {
          const current = tools.get(index) || { id: `call_${index}`, name: "", arguments: "", index };
          current.itemId = clean(item.id) || current.itemId || `fc_${index}`;
          current.callId = clean(item.call_id) || current.callId || `call_${index}`;
          current.id = current.callId;
          current.name = clean(item.name) || current.name;
          if (typeof item.arguments === "string") current.arguments = item.arguments;
          tools.set(index, current);
        }
      }
      continue;
    }
    if (type === "response.failed" || type === "error") {
      const root = asRecord(event.response) || event;
      const error = asRecord(root.error) || root;
      throw new Error(clean(error.message) || "Azure Responses stream failed");
    }
  }

  for (const call of [...tools.values()].sort((left, right) => left.index - right.index)) {
    yield {
      type: "tool-call",
      toolCall: {
        id: call.id,
        itemId: call.itemId,
        callId: call.callId,
        name: call.name,
        arguments: call.arguments || "{}",
        index: call.index,
      },
    };
  }
  for (const [outputIndex, item] of [...outputItems.entries()].sort(([left], [right]) => left - right)) {
    yield { type: "output-item", outputIndex, item };
  }
  if (!usage) throw new Error(`Azure Responses stream returned no authoritative usage for ${modelId}`);
  yield { type: "done", finishReason: streamFinishReason(status, tools.size > 0), usage };
}

export async function* streamAzureChat(
  modelId: string,
  messages: Message[],
  options: AzureChatOptions = {},
): AsyncGenerator<Event> {
  const route = routeForModel(modelId, options.operation);
  const credential = credentialForModel(modelId);
  const capabilities = asRecord(getModelById(modelId, "azure")?.capabilities) || {};
  const nativeResponsesStream = route === "openai_responses" || capabilities.responses === true;
  if (route === "cohere_rerank") {
    const result = await generateAzureChat(modelId, messages, options);
    if (result.reasoning) yield { type: "reasoning-delta", text: result.reasoning };
    if (result.text) yield { type: "text-delta", text: result.text };
    for (const [index, call] of (result.toolCalls || []).entries()) {
      yield {
        type: "tool-call",
        toolCall: {
          ...call,
          id: call.id || `call_${index}`,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
          index: call.outputIndex ?? index,
        },
      };
    }
    yield { type: "done", finishReason: result.finishReason || "stop", usage: result.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    return;
  }
  if (!nativeResponsesStream) {
    yield* streamAzureChatWire(modelId, messages, options, credential);
    return;
  }

  yield* streamAzureResponsesWire(modelId, messages, options, credential);
}

export async function generateAzureEmbeddings(modelId: string, input: string[]): Promise<AzureEmbeddingResult> {
  const credential = credentialForModel(modelId);
  const raw = await postAzure(credential, "/openai/v1/embeddings", {
    model: deploymentNameForModel(modelId),
    input,
  });
  const root = asRecord(raw) || {};
  const data = Array.isArray(root.data) ? root.data : [];
  const embeddings = data
    .map((item) => asRecord(item)?.embedding)
    .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((value) => typeof value === "number"));
  return { embeddings, usage: normalizeOpenAIUsage(root.usage), raw };
}

export async function generateAzureImage(
  modelId: string,
  prompt: string,
  options: {
    n?: number;
    size?: string;
    quality?: string;
    imageUrl?: string;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<AzureImageResult> {
  const credential = credentialForModel(modelId);
  const route = routeForModel(modelId);
  const dimensions = sizeToDimensions(options.size);
  const customParams = options.customParams || {};
  let raw: unknown;

  if (route === "blackforestlabs_image") {
    const path = modelId.toLowerCase().includes("flux.2-flex")
      ? "/providers/blackforestlabs/v1/flux-2-flex?api-version=preview"
      : "/providers/blackforestlabs/v1/flux-2-pro?api-version=preview";
    raw = await postAzure(credential, path, {
      model: deploymentNameForModel(modelId),
      prompt,
      ...(dimensions.width ? { width: dimensions.width } : {}),
      ...(dimensions.height ? { height: dimensions.height } : {}),
      output_format: "png",
      ...customParams,
    }, "bearer");
  } else if (route === "mai_image") {
    const maiOptions = {
      n: options.n,
      size: options.size,
      width: dimensions.width,
      height: dimensions.height,
      customParams,
    };
    raw = await postAzure(credential, MAI_PATH_IMAGES, buildMaiImageBody(deploymentNameForModel(modelId), prompt, maiOptions));
    const image = await parseMaiImageResponse(raw, { n: options.n });
    const usage = image.usage || (tokenPriced(modelId) ? meteredMaiImageUsage(prompt, raw, maiOptions) : undefined);
    if (!usage && tokenPriced(modelId)) {
      throw missingMaiUsage(modelId);
    }
    return {
      ...image,
      ...(usage ? { usage } : {}),
    };
  } else if (options.imageUrl) {
    const media = await bufferFromPayload(options.imageUrl, "image/png");
    const form = new FormData();
    form.append("model", deploymentNameForModel(modelId));
    form.append("prompt", prompt);
    form.append("image", new Blob([new Uint8Array(media.buffer)], { type: media.mimeType }), "input-image");
    if (typeof options.n === "number") form.append("n", String(options.n));
    if (options.size) form.append("size", options.size);
    if (options.quality) form.append("quality", options.quality);
    for (const [key, value] of Object.entries(customParams)) {
      if (["model", "prompt", "image", "image_url", "n", "size", "quality"].includes(key)) continue;
      if (scalar(value)) form.append(key, String(value));
    }
    raw = await postAzureForm(credential, "/openai/v1/images/edits", form);
  } else {
    raw = await postAzure(credential, "/openai/v1/images/generations", {
      model: deploymentNameForModel(modelId),
      prompt,
      ...(typeof options.n === "number" ? { n: options.n } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...customParams,
    });
  }

  const image = await azureImageFromRaw(raw);
  const root = asRecord(raw) || {};
  return {
    ...image,
    usage: normalizeOpenAIUsage(root.usage) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: { request: 1, image: options.n || 1 },
    },
    raw,
  };
}
