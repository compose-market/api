import { getModelById } from "../models-registry.js";
import type { UnifiedMessage, UnifiedUsage } from "../core.js";

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
  usage?: UnifiedUsage;
  finishReason?: string;
  raw: unknown;
}

export interface AzureEmbeddingResult {
  embeddings: number[][];
  usage?: UnifiedUsage;
  raw: unknown;
}

export interface AzureImageResult {
  buffer: Buffer;
  mimeType: string;
  usage?: UnifiedUsage;
  raw: unknown;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  if (joined.includes("gpt-5.4-pro")) return "openai_responses";
  if (capabilities.responses === true && capabilities.chat_completion !== true) return "openai_responses";
  return "openai_chat";
}

function azureUrl(credential: AzureCredential, path: string): string {
  return `${credential.baseUrl}/${path.replace(/^\/+/, "")}`;
}

function usageFromAzure(value: unknown): UnifiedUsage | undefined {
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
    ...(typeof usage.reasoning_tokens === "number" ? { reasoningTokens: usage.reasoning_tokens } : {}),
    ...(typeof usage.cached_input_tokens === "number" ? { cachedInputTokens: usage.cached_input_tokens } : {}),
    raw: usage,
  };
}

async function postAzureJson(
  credential: AzureCredential,
  path: string,
  body: Record<string, unknown>,
  auth: "api-key" | "bearer" = "api-key",
): Promise<unknown> {
  const response = await fetch(azureUrl(credential, path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth === "bearer" ? { Authorization: `Bearer ${credential.apiKey}` } : { "api-key": credential.apiKey }),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Azure provider HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  return response.json();
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

function imageUrlFromMessages(messages: UnifiedMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index].content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== "image_url") continue;
      const value = part.image_url;
      return typeof value === "string" ? value : value?.url;
    }
  }
  return undefined;
}

function responseInputFromMessages(messages: UnifiedMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role === "system" ? "developer" : message.role,
    content: messageText(message),
  }));
}

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

function chatText(raw: unknown): { text: string; finishReason?: string; usage?: UnifiedUsage } {
  const root = asRecord(raw) || {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]) || {};
  const message = asRecord(first.message) || {};
  return {
    text: clean(message.content),
    finishReason: clean(first.finish_reason) || undefined,
    usage: usageFromAzure(root.usage),
  };
}

function sizeToDimensions(size: string | undefined): { width?: number; height?: number } {
  const match = clean(size).match(/^(\d+)x(\d+)$/);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function bufferFromImagePayload(value: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (/^data:/i.test(value)) {
    const match = value.match(/^data:([^;,]+)?;base64,(.+)$/i);
    if (!match) throw new Error("Azure image response contained an invalid data URL");
    return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] || "image/png" };
  }
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`Failed to download Azure image URL: ${response.status}`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") || "image/png",
    };
  }
  return { buffer: Buffer.from(value, "base64"), mimeType: "image/png" };
}

async function azureImageFromRaw(raw: unknown): Promise<{ buffer: Buffer; mimeType: string }> {
  const root = asRecord(raw) || {};
  const data = Array.isArray(root.data) ? root.data : [];
  const first = asRecord(data[0]) || root;
  const payload = clean(first.b64_json) || clean(first.base64) || clean(first.image) || clean(first.url);
  if (!payload) throw new Error("Azure returned no image data");
  return bufferFromImagePayload(payload);
}

async function generateAzureResponses(
  modelId: string,
  messages: UnifiedMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    tools?: unknown;
    toolChoice?: unknown;
    responseFormat?: unknown;
  },
): Promise<AzureChatResult> {
  const credential = credentialForModel(modelId);
  const raw = await postAzureJson(credential, "/openai/v1/responses", {
    model: deploymentNameForModel(modelId),
    input: responseInputFromMessages(messages),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" ? { max_output_tokens: options.maxTokens } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
  });
  const root = asRecord(raw) || {};
  const text = textFromResponses(raw);
  return {
    text,
    usage: usageFromAzure(root.usage),
    finishReason: clean(root.status) || "stop",
    raw,
  };
}

async function generateAzureRerank(
  modelId: string,
  messages: UnifiedMessage[],
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
  const raw = await postAzureJson(credential, "/providers/cohere/v2/rerank", {
    model: deploymentNameForModel(modelId),
    query,
    documents,
    ...(typeof customParams.top_n === "number" ? { top_n: customParams.top_n } : {}),
    ...(typeof customParams.max_chunks_per_doc === "number" ? { max_chunks_per_doc: customParams.max_chunks_per_doc } : {}),
  });

  return {
    text: JSON.stringify(raw),
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: {
        request: 1,
        search: 1,
        document: documents.length,
      },
    },
    finishReason: "stop",
    raw,
  };
}

async function generateAzureOcr(
  modelId: string,
  messages: UnifiedMessage[],
  customParams: Record<string, unknown> = {},
): Promise<AzureChatResult> {
  const document = asRecord(customParams.document) || {
    type: "image_url",
    image_url: clean(customParams.image_url) || imageUrlFromMessages(messages),
  };
  if (!document.image_url) {
    throw new Error("Azure Mistral document OCR requires an image_url document");
  }

  const credential = credentialForModel(modelId);
  const raw = await postAzureJson(credential, "/providers/mistral/azure/ocr", {
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
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: {
        request: 1,
        page: pages.length || 1,
      },
    },
    finishReason: "stop",
    raw,
  };
}

export async function generateAzureChat(
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
): Promise<AzureChatResult> {
  const route = routeForModel(modelId);
  if (route === "openai_responses") return generateAzureResponses(modelId, messages, options);
  if (route === "cohere_rerank") return generateAzureRerank(modelId, messages, options.customParams);
  if (route === "mistral_ocr") return generateAzureOcr(modelId, messages, options.customParams);

  const credential = credentialForModel(modelId);
  const joined = `${modelId} ${deploymentMetadata(modelId).deploymentName || ""} ${deploymentMetadata(modelId).modelName || ""}`.toLowerCase();
  const omitMaxCompletionTokens = joined.includes("grok-4-20-non-reasoning") || joined.includes("mistral-large-3");
  const raw = await postAzureJson(credential, "/openai/v1/chat/completions", {
    model: deploymentNameForModel(modelId),
    messages,
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.maxTokens === "number" && !omitMaxCompletionTokens ? { max_completion_tokens: options.maxTokens } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
  });

  return {
    ...chatText(raw),
    raw,
  };
}

export async function generateAzureEmbeddings(modelId: string, input: string[]): Promise<AzureEmbeddingResult> {
  const credential = credentialForModel(modelId);
  const raw = await postAzureJson(credential, "/openai/v1/embeddings", {
    model: deploymentNameForModel(modelId),
    input,
  });

  const root = asRecord(raw) || {};
  const data = Array.isArray(root.data) ? root.data : [];
  const embeddings = data
    .map((item) => asRecord(item)?.embedding)
    .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((value) => typeof value === "number"));

  return {
    embeddings,
    usage: usageFromAzure(root.usage),
    raw,
  };
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
    raw = await postAzureJson(credential, path, {
      model: deploymentNameForModel(modelId),
      prompt,
      ...(dimensions.width ? { width: dimensions.width } : {}),
      ...(dimensions.height ? { height: dimensions.height } : {}),
      output_format: "png",
      ...customParams,
    }, "bearer");
  } else if (route === "mai_image") {
    raw = await postAzureJson(credential, "/mai/v1/images/generations", {
      model: deploymentNameForModel(modelId),
      prompt,
      ...(options.size ? { size: options.size } : {}),
      ...(dimensions.width ? { width: dimensions.width } : {}),
      ...(dimensions.height ? { height: dimensions.height } : {}),
      ...customParams,
    });
  } else {
    raw = await postAzureJson(credential, "/openai/v1/images/generations", {
      model: deploymentNameForModel(modelId),
      prompt,
      ...(typeof options.n === "number" ? { n: options.n } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
      ...customParams,
    });
  }

  const image = await azureImageFromRaw(raw);
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
