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
import type { Call, Choice, Format, Message, Tool, Usage } from "../../core.js";
import {
  buildBodyChat,
  buildBodyResponses,
  mapMessagesForResponsesWire,
} from "../families/openai.js";
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
  usage?: Usage;
  finishReason?: string;
  toolCalls?: Call[];
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

function routeForModel(modelId: string): AzureRoute {
  const card = getModelById(modelId, "azure");
  const deployment = deploymentMetadata(modelId);
  const format = (deployment.modelFormat || "").toLowerCase();
  const joined = `${modelId} ${deployment.deploymentName || ""} ${deployment.modelName || ""}`.toLowerCase();
  const capabilities = asRecord(card?.capabilities) || {};
  const type = clean(card?.type).toLowerCase();
  if (format === "cohere" && joined.includes("rerank")) return "cohere_rerank";
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
): Promise<unknown> {
  return postJson(azureUrl(credential, path), body, azureHeaders(credential, auth));
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

function audioFormat(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("ogg") || normalized.includes("opus")) return "opus";
  return "wav";
}

async function inlineAudio(messages: Message[]): Promise<Message[]> {
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

      const media = await bufferFromPayload(locator, "audio/wav");
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
    calls.push({
      id: clean(item.call_id) || clean(item.id) || `call_${i}`,
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

function chatText(raw: unknown): { text: string; finishReason?: string; usage?: Usage; toolCalls?: Call[] } {
  const root = asRecord(raw) || {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  const toolCalls = callsFromChat(raw);
  return {
    text: clean(message.content),
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
  },
): Promise<AzureChatResult> {
  const credential = credentialForModel(modelId);
  const body = buildBodyResponses(modelId, mapMessagesForResponsesWire(messages), {
    wireModelId: deploymentNameForModel(modelId),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    customParams: omit(options.customParams, ["stream", "stream_options"]),
  });
  const raw = await postAzure(credential, "/openai/v1/responses", body);
  const root = asRecord(raw) || {};
  const toolCalls = callsFromResponses(raw);
  return {
    text: textFromResponses(raw),
    usage: normalizeOpenAIUsage(root.usage),
    finishReason: toolCalls ? "tool-calls" : clean(root.status) || "stop",
    ...(toolCalls ? { toolCalls } : {}),
    raw,
  };
}

async function generateAzureRerank(
  modelId: string,
  messages: Message[],
  customParams: Record<string, unknown> = {},
): Promise<AzureChatResult> {
  const documents = Array.isArray(customParams.documents)
    ? customParams.documents
    : Array.isArray(customParams.texts)
      ? customParams.texts
      : [];
  if (documents.length === 0) {
    throw new Error("Azure Cohere rerank requires custom_params.documents");
  }
  const credential = credentialForModel(modelId);
  const query = clean(customParams.query) || primaryText(messages);
  const raw = await postAzure(credential, "/providers/cohere/v2/rerank", {
    model: deploymentNameForModel(modelId),
    query,
    documents,
    ...(typeof customParams.top_n === "number" ? { top_n: customParams.top_n } : {}),
    ...(typeof customParams.max_chunks_per_doc === "number" ? { max_chunks_per_doc: customParams.max_chunks_per_doc } : {}),
  });
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
  } = {},
): Promise<AzureChatResult> {
  const route = routeForModel(modelId);
  if (route === "openai_responses") return generateAzureResponses(modelId, messages, options);
  if (route === "cohere_rerank") return generateAzureRerank(modelId, messages, options.customParams);
  if (route === "mistral_ocr") return generateAzureOcr(modelId, messages, options.customParams);

  const credential = credentialForModel(modelId);
  const card = getModelById(modelId, "azure");
  const capabilities = asRecord(card?.capabilities) || {};
  if (servicesEndpoint(credential) && capabilities.responses === true) {
    return generateAzureResponses(modelId, messages, options);
  }
  const joined = `${modelId} ${deploymentMetadata(modelId).deploymentName || ""} ${deploymentMetadata(modelId).modelName || ""}`.toLowerCase();
  const omitMaxCompletionTokens = joined.includes("grok-4-20-non-reasoning") || joined.includes("mistral-large-3");
  const wireMessages = await inlineAudio(messages);
  const raw = await postAzure(credential, "/openai/v1/chat/completions", buildBodyChat(modelId, wireMessages, {
    wireModelId: deploymentNameForModel(modelId),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" && !omitMaxCompletionTokens ? { maxTokens: options.maxTokens } : {}),
    maxTokensField: "max_completion_tokens",
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
    customParams: omit(options.customParams, ["stream", "stream_options"]),
  }));
  return { ...chatText(raw), raw };
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
    raw = await postAzure(credential, "/mai/v1/images/generations", {
      model: deploymentNameForModel(modelId),
      prompt,
      ...(options.size ? { size: options.size } : {}),
      ...(dimensions.width ? { width: dimensions.width } : {}),
      ...(dimensions.height ? { height: dimensions.height } : {}),
      ...customParams,
    });
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
