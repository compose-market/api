/**
 * DeepInfra Native Inference Vendor Client
 *
 * Handles capabilities NOT covered by the OpenAI-compatible surface:
 *   - Image generation/editing (Bria protocol via native /v1/inference)
 *   - Video generation (native /v1/inference)
 *   - Text-to-speech (OpenAI-compatible /v1/openai/audio/speech)
 *   - Speech-to-text (OpenAI-compatible /v1/openai/audio/transcriptions)
 *   - Reranking (native /v1/inference with query + documents)
 *
 * Text chat/completion and embeddings use the OpenAI-compatible wire
 * via openaiCompatEndpointFor("deepinfra") in the adapter.
 */

import { asRecord, audioMimeType, bufferFromPayload, imagesFromResponse, normalizeOpenAIUsage, sizeToDimensions, throwHttpError } from "../shared/index.js";
import { buildBriaBody } from "../families/bria.js";
import { buildFluxBody } from "../families/bfl.js";
import * as minimaxFamily from "../families/minimax.js";
import * as stabilityaiFamily from "../families/stabilityai.js";
import { rerankBillingMetrics } from "../modalities/rerank.js";
import { audioDurationSeconds } from "../modalities/audio.js";
import { getModelById } from "../registry.js";
import { pricingHasTokenSections } from "../../telemetry.js";
import type { Usage } from "../../core.js";

const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;

if (!DEEPINFRA_API_KEY) {
  console.warn("[deepinfra] DEEPINFRA_API_KEY not set — native inference disabled");
}

const OPENAI_BASE = "https://api.deepinfra.com/v1/openai";
const NATIVE_BASE = "https://api.deepinfra.com/v1/inference";
const MODEL_BASE = "https://api.deepinfra.com/models";

interface DeepInfraSchema {
  schema_in?: Record<string, unknown>;
  schema_out?: Record<string, unknown>;
}

const schemaCache = new Map<string, Promise<DeepInfraSchema | null>>();

async function modelSchema(modelId: string, variant: string, signal?: AbortSignal): Promise<DeepInfraSchema | null> {
  const key = `${modelId}\u0000${variant}`;
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const url = `${MODEL_BASE}/${encodeURIComponent(modelId)}/schema/${variant}`;
    const response = await fetch(url, { signal });
    if (response.status === 404) return null;
    if (!response.ok) await throwHttpError("DeepInfra model schema", url, response);
    return await response.json() as DeepInfraSchema;
  })();
  schemaCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    schemaCache.delete(key);
    throw error;
  }
}

function schemaProperties(schema: DeepInfraSchema | null): Record<string, Record<string, unknown>> {
  const properties = asRecord(schema?.schema_in?.properties) || {};
  return Object.fromEntries(Object.entries(properties)
    .map(([key, value]) => [key, asRecord(value)])
    .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null));
}

function requiredFields(schema: DeepInfraSchema | null): Set<string> {
  return new Set(Array.isArray(schema?.schema_in?.required)
    ? schema.schema_in.required.filter((value): value is string => typeof value === "string")
    : []);
}

function schemaReturnsImages(schema: DeepInfraSchema | null): boolean {
  const properties = asRecord(schema?.schema_out?.properties) || {};
  return ["images", "image", "image_url", "data", "output"].some((key) => key in properties);
}

function imageInputFields(schema: DeepInfraSchema | null): string[] {
  const properties = schemaProperties(schema);
  return Object.entries(properties)
    .filter(([key, definition]) => definition.is_image === true
      || ["image", "images", "image_url", "image_urls", "input_image", "input_images", "init_image", "mask", "mask_image", "ref_images"].includes(key))
    .map(([key]) => key);
}

function aspectRatio(size: string | undefined): string | undefined {
  const match = size?.match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const divisor = (left: number, right: number): number => right === 0 ? left : divisor(right, left % right);
  const common = divisor(width, height);
  return `${width / common}:${height / common}`;
}

function usageFromCost(card: ReturnType<typeof getModelById>, cost: number): Usage | undefined {
  const pricing = asRecord(card?.pricing);
  const sections = Array.isArray(pricing?.sections) ? pricing.sections : [];
  for (const rawSection of sections) {
    const section = asRecord(rawSection);
    const entries = asRecord(section?.entries);
    const unitKey = typeof section?.unitKey === "string" ? section.unitKey : "";
    const unitPrice = typeof entries?.input === "number" ? entries.input : undefined;
    const scale = unitKey === "per_1m_tokens_usd" || unitKey === "usd_per_1m_tokens" ? 1_000_000
      : unitKey === "per_1k_tokens_usd" || unitKey === "usd_per_1k_tokens" ? 1_000
        : undefined;
    if (!scale || !unitPrice || unitPrice <= 0 || cost <= 0) continue;
    const tokens = Math.round((cost * scale) / unitPrice);
    if (tokens <= 0) continue;
    return {
      promptTokens: tokens,
      completionTokens: 0,
      totalTokens: tokens,
      billingMetrics: {
        input_tokens: tokens,
        total_tokens: tokens,
        cost,
      },
      raw: { source: "deepinfra_inference_status_cost", cost },
    };
  }
  return undefined;
}

export interface DeepInfraImageOptions {
  catalogModelId?: string;
  operation?: string;
  size?: string;
  quality?: string;
  n?: number;
  imageUrl?: string;
  imageUrls?: string[];
  maskUrl?: string;
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export async function analyzeDeepInfraVision(
  modelId: string,
  imageUrl: string,
  question: string,
  options: {
    catalogModelId?: string;
    signal?: AbortSignal;
    customParams?: Record<string, unknown>;
  } = {},
): Promise<{ text: string; usage: Usage; raw: unknown }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const card = getModelById(options.catalogModelId || modelId, "deepinfra");
  const wireModelId = card?.upstreamModelId || modelId;
  const schema = await modelSchema(wireModelId, "default", options.signal);
  const accepted = new Set(Object.keys(schemaProperties(schema)));
  const customParams = Object.fromEntries(Object.entries(options.customParams || {})
    .filter(([key, value]) => accepted.has(key) && value !== undefined));
  const body = { ...customParams, image: imageUrl, question };
  const missing = [...requiredFields(schema)].filter((key) => body[key as keyof typeof body] === undefined);
  if (missing.length > 0) {
    throw Object.assign(new Error(`DeepInfra model ${wireModelId} requires: ${missing.join(", ")}`), {
      statusCode: 400,
      retryable: false,
    });
  }

  const url = `${NATIVE_BASE}/${wireModelId}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) await throwHttpError("DeepInfra vision inference", url, response);

  const raw = await response.json() as unknown;
  const root = asRecord(raw) || {};
  const text = typeof root.response === "string" ? root.response : "";
  if (!text) throw new Error(`DeepInfra returned no vision response: ${JSON.stringify(raw)}`);

  const status = asRecord(root.inference_status);
  const inputTokens = typeof status?.tokens_input === "number" ? status.tokens_input : 0;
  const outputTokens = typeof status?.tokens_generated === "number" ? status.tokens_generated : 0;
  const cost = typeof status?.cost === "number" ? status.cost : undefined;
  return {
    text,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      billingMetrics: {
        image: 1,
        request: 1,
        ...(cost !== undefined ? { cost } : {}),
      },
      raw: root,
    },
    raw,
  };
}

export async function generateDeepInfraImage(
  modelId: string,
  prompt: string,
  options: DeepInfraImageOptions = {}
): Promise<{
  buffer: Buffer;
  mimeType: string;
  images: Array<{ buffer: Buffer; mimeType: string; revisedPrompt?: string }>;
  usage?: Usage;
}> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const card = getModelById(options.catalogModelId || modelId, "deepinfra");
  const source = asRecord(card?.sourceMetadata);
  const metadata = asRecord(source?.deepinfra);
  const catalogSchema = asRecord(card?.params) || {};
  const tags = Array.isArray(metadata?.tags) ? metadata.tags : [];
  const openAIImages = tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "openai");
  const tokenPriced = pricingHasTokenSections(card?.pricing);
  const wireModelId = card?.upstreamModelId || modelId;
  const imageUrls = options.imageUrls?.length
    ? options.imageUrls
    : options.imageUrl ? [options.imageUrl] : [];
  const defaultSchema = imageUrls.length > 0 || !openAIImages || tokenPriced
    ? await modelSchema(wireModelId, "default", options.signal)
    : null;
  const defaultImageFields = imageInputFields(defaultSchema);
  const defaultRequired = requiredFields(defaultSchema);
  const defaultRequiresImage = defaultImageFields.some((key) => defaultRequired.has(key));
  const openAISchema = !openAIImages
    && imageUrls.length === 0
    && options.operation === "text-to-image"
    && (!schemaReturnsImages(defaultSchema) || defaultRequiresImage)
    ? await modelSchema(wireModelId, "openai-images", options.signal)
    : null;
  const useOpenAI = !tokenPriced && (
    (openAIImages && imageUrls.length === 0)
    || (openAISchema !== null && schemaReturnsImages(openAISchema))
  );
  const native = !useOpenAI;
  const activeSchema = native ? defaultSchema : null;
  const properties = native ? schemaProperties(activeSchema) : Object.fromEntries(
    Object.entries(catalogSchema)
      .map(([key, value]) => [key, asRecord(value)])
      .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null),
  );
  const accepted = new Set(Object.keys(properties));
  const customParams = Object.fromEntries(Object.entries(options.customParams || {})
    .filter(([key, value]) => accepted.has(key) && value !== undefined));
  const url = native ? `${NATIVE_BASE}/${wireModelId}` : `${OPENAI_BASE}/images/generations`;
  let body: Record<string, unknown>;

  if (!native) {
    body = {
      model: wireModelId,
      prompt,
      ...(typeof options.n === "number" ? { n: options.n } : {}),
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...customParams,
    };
  } else {
    if (!activeSchema || !schemaReturnsImages(activeSchema)) {
      throw Object.assign(new Error(`DeepInfra model ${wireModelId} does not expose image output through its live API schema`), {
        statusCode: 400,
        retryable: false,
      });
    }
    const family = card?.family?.toLowerCase();
    const dims = sizeToDimensions(options.size);
    const ratio = aspectRatio(options.size);
    if (family === "stabilityai") {
      const built = stabilityaiFamily.buildCoreGenerateRequest(prompt, {
        ...(typeof customParams.negative_prompt === "string" ? { negativePrompt: customParams.negative_prompt } : {}),
        ...(typeof customParams.seed === "number" ? { seed: customParams.seed } : {}),
        ...(typeof customParams.cfg_scale === "number" ? { cfgScale: customParams.cfg_scale } : {}),
        ...(ratio ? { aspectRatio: ratio as stabilityaiFamily.StabilityAspectRatio } : {}),
      });
      body = { ...customParams, ...built.fields };
    } else if (family === "blackforestlabs") {
      body = buildFluxBody({
        prompt,
        ...(typeof dims.width === "number" && dims.width > 0 ? { width: dims.width } : {}),
        ...(typeof dims.height === "number" && dims.height > 0 ? { height: dims.height } : {}),
        ...(ratio ? { aspectRatio: ratio } : {}),
        ...(typeof options.n === "number" ? { n: options.n } : {}),
        ...(imageUrls.length > 0 ? { images: imageUrls.map((url) => ({ type: "url" as const, url })) } : {}),
        customParams,
      });
    } else if (family === "minimax") {
      body = {
        ...customParams,
        ...minimaxFamily.buildImageBody(wireModelId, prompt, {
          ...(typeof options.n === "number" ? { n: options.n } : {}),
          ...(ratio ? { aspectRatio: ratio as minimaxFamily.MinimaxImageOptions["aspectRatio"] } : {}),
          ...(typeof dims.width === "number" && dims.width > 0 ? { width: dims.width } : {}),
          ...(typeof dims.height === "number" && dims.height > 0 ? { height: dims.height } : {}),
        }),
      };
    } else {
      body = buildBriaBody(wireModelId, prompt, {
        image: imageUrls[0],
        mask: options.operation === "inpainting" ? options.maskUrl : undefined,
        size: options.size,
        n: options.n,
        customParams,
      });
    }
    for (const key of Object.keys(body)) {
      if (!accepted.has(key)) delete body[key];
    }
    if (accepted.has("prompt")) body.prompt = prompt;
    if (accepted.has("instruction")) body.instruction = prompt;
    if (accepted.has("question")) body.question = prompt;
    if (accepted.has("num_images") && typeof options.n === "number") body.num_images = options.n;
    for (const key of ["images", "image_urls", "input_images"]) {
      if (accepted.has(key) && imageUrls.length > 0) body[key] = imageUrls;
    }
    const singular = ["image", "image_url", "input_image", "init_image"].find((key) => accepted.has(key));
    if (singular && imageUrls[0]) body[singular] = imageUrls[0];
    for (let index = 1; index < imageUrls.length; index += 1) {
      const key = `input_image_${index + 1}`;
      if (accepted.has(key)) body[key] = imageUrls[index];
    }
    if (accepted.has("ref_images") && imageUrls.length > 1) {
      body.ref_images = properties.ref_images?.type === "array" ? imageUrls.slice(1) : imageUrls[1];
    }
    const required = requiredFields(activeSchema);
    if (required.has("aspect_ratio") && body.aspect_ratio === undefined) {
      body.aspect_ratio = aspectRatio(options.size) || "1:1";
    }
    if (required.has("ref_images") && body.ref_images !== undefined && !required.has("prompt")) {
      delete body.prompt;
    }
    if (options.maskUrl && (options.operation === "inpainting" || required.has("mask"))) {
      if (accepted.has("mask")) body.mask = options.maskUrl;
      if (accepted.has("mask_image")) body.mask_image = options.maskUrl;
    }
    const missing = [...required].filter((key) => body[key] === undefined);
    if (missing.length > 0) {
      throw Object.assign(new Error(`DeepInfra model ${wireModelId} requires: ${missing.join(", ")}`), {
        statusCode: 400,
        retryable: false,
      });
    }
    if (required.has("images") && Array.isArray(body.images)) {
      if (body.aspect_ratio !== "custom") {
        delete body.width;
        delete body.height;
      }
      body.input = { ...body };
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    await throwHttpError("DeepInfra image inference", url, response);
  }

  const data = await response.json() as unknown;
  const images = await imagesFromResponse(data, "image/png", options.signal);
  if (images.length === 0) {
    throw new Error(`DeepInfra returned no images: ${JSON.stringify(data)}`);
  }
  const root = asRecord(data) || {};
  const usage = normalizeOpenAIUsage(root.usage);
  const inferenceStatus = asRecord(root.inference_status);
  const cost = typeof inferenceStatus?.cost === "number" && Number.isFinite(inferenceStatus.cost)
    ? inferenceStatus.cost
    : undefined;
  const costUsage = cost !== undefined && tokenPriced ? usageFromCost(card, cost) : undefined;
  const normalizedUsage = usage || costUsage || cost !== undefined ? {
    ...(usage || costUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    ...(cost !== undefined ? {
      billingMetrics: { ...((usage || costUsage)?.billingMetrics || {}), cost },
    } : {}),
  } : undefined;
  return { ...images[0], images, ...(normalizedUsage ? { usage: normalizedUsage } : {}) };
}

export interface DeepInfraVideoOptions {
  catalogModelId?: string;
  operation?: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  audioUrl?: string;
  audioUrls?: string[];
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export interface DeepInfraVideoResult {
  buffer: Buffer;
  mimeType: string;
  url?: string;
  usage?: Usage;
}

export async function generateDeepInfraVideo(
  modelId: string,
  prompt: string,
  options: DeepInfraVideoOptions = {}
): Promise<DeepInfraVideoResult> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const card = getModelById(options.catalogModelId || modelId, "deepinfra");
  const wireModelId = card?.upstreamModelId || modelId;
  const schema = await modelSchema(wireModelId, "default", options.signal);
  if (!schema) {
    throw Object.assign(new Error(`DeepInfra model ${wireModelId} does not expose a live default schema`), {
      statusCode: 400,
      retryable: false,
    });
  }

  const properties = schemaProperties(schema);
  const accepted = new Set(Object.keys(properties));
  const required = requiredFields(schema);
  const imageUrls = options.imageUrls?.length ? options.imageUrls : options.imageUrl ? [options.imageUrl] : [];
  const videoUrls = options.videoUrls?.length ? options.videoUrls : options.videoUrl ? [options.videoUrl] : [];
  const audioUrls = options.audioUrls?.length ? options.audioUrls : options.audioUrl ? [options.audioUrl] : [];
  const referenceOperation = options.operation === "reference-to-video" || options.operation === "video-edit";
  const imageOperation = options.operation === "image-to-video";
  const videoOperation = options.operation === "video-to-video";
  const family = card?.family?.toLowerCase();
  const baseBody = family === "minimax"
    ? Object.fromEntries(Object.entries(minimaxFamily.buildVideoBody(wireModelId, prompt, {
      ...(imageUrls[0] ? { firstFrameImage: imageUrls[0] } : {}),
      ...(imageUrls[1] ? { lastFrameImage: imageUrls[1] } : {}),
    })).filter(([key, value]) => accepted.has(key) && value !== undefined))
    : {};
  const body: Record<string, unknown> = {
    ...baseBody,
    ...Object.fromEntries(Object.entries(options.customParams || {})
      .filter(([key, value]) => accepted.has(key) && value !== undefined)),
  };

  if (accepted.has("prompt") && prompt) body.prompt = prompt;
  else if (accepted.has("instruction") && prompt) body.instruction = prompt;
  else if (accepted.has("voice_script") && prompt) body.voice_script = prompt;

  const assignFirst = (keys: string[], value: string | undefined): void => {
    if (!value) return;
    const key = keys.find((candidate) => accepted.has(candidate));
    if (key) body[key] = value;
  };

  if (accepted.has("media") && (imageUrls.length > 0 || videoUrls.length > 0)) {
    body.media = [
      ...imageUrls.map((url, index) => ({
        type: !referenceOperation && index === 0 ? "first_frame" : "reference_image",
        url,
        ...(audioUrls[index] ? { reference_voice: audioUrls[index] } : {}),
      })),
      ...videoUrls.map((url, index) => ({
        type: "reference_video",
        url,
        ...(audioUrls[imageUrls.length + index] ? { reference_voice: audioUrls[imageUrls.length + index] } : {}),
      })),
    ];
  } else {
    if (accepted.has("reference_images") && imageUrls.length > 0) {
      body.reference_images = referenceOperation ? imageUrls : imageUrls.slice(2);
      if ((body.reference_images as string[]).length === 0) delete body.reference_images;
    }
    if (accepted.has("reference_videos") && videoUrls.length > 0) body.reference_videos = videoUrls;
    if (accepted.has("reference_audios") && audioUrls.length > 0) body.reference_audios = audioUrls;
    if (accepted.has("images") && imageUrls.length > 0) body.images = imageUrls;
    if (accepted.has("videos") && videoUrls.length > 0) body.videos = videoUrls;
    if (accepted.has("audios") && audioUrls.length > 0) body.audios = audioUrls;

    if ((!referenceOperation || !accepted.has("reference_images")) && !videoOperation) {
      assignFirst(["first_frame_image", "first_frame", "img_url", "image", "image_url", "input_image"], imageUrls[0]);
      assignFirst(["last_frame_image", "last_frame"], imageUrls[1]);
    }
    if ((!referenceOperation || !accepted.has("reference_videos")) && !imageOperation) {
      assignFirst(["video", "video_url", "first_clip", "input_video"], videoUrls[0]);
    }
    if (!referenceOperation || !accepted.has("reference_audios")) {
      assignFirst(["driving_audio", "audio", "audio_url", "input_audio"], audioUrls[0]);
    }
    if (accepted.has("mask") && body.mask === undefined) {
      body.mask = videoUrls[1] || imageUrls[0];
    }
  }

  for (const key of required) {
    if (body[key] === undefined && properties[key]?.default !== undefined) body[key] = properties[key].default;
  }
  const missing = [...required].filter((key) => body[key] === undefined);
  if (missing.length > 0) {
    throw Object.assign(new Error(`DeepInfra model ${wireModelId} requires: ${missing.join(", ")}`), {
      statusCode: 400,
      retryable: false,
    });
  }

  const url = `${NATIVE_BASE}/${wireModelId}`;
  const binaryFields = new Set(Object.entries(properties)
    .filter(([, property]) => property.format === "binary")
    .map(([key]) => key));
  const usesMultipart = Object.entries(body).some(([key, value]) => binaryFields.has(key) && typeof value === "string");
  let requestBody: BodyInit;
  let headers: Record<string, string>;

  if (usesMultipart) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (binaryFields.has(key) && typeof value === "string") {
        const media = await bufferFromPayload(value, "application/octet-stream", options.signal);
        const extension = media.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "bin";
        form.append(key, new Blob([new Uint8Array(media.buffer)], { type: media.mimeType }), `${key}.${extension}`);
      } else {
        form.append(key, typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    requestBody = form;
    headers = { Authorization: `Bearer ${DEEPINFRA_API_KEY}` };
  } else {
    requestBody = JSON.stringify(body);
    headers = {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
      "Content-Type": "application/json",
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: requestBody,
    signal: options.signal,
  });

  if (!response.ok) {
    await throwHttpError("DeepInfra video inference", url, response);
  }

  const data = await response.json() as unknown;
  const root = asRecord(data) || {};
  const payloadFrom = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const payload = payloadFrom(item);
        if (payload) return payload;
      }
      return undefined;
    }
    const record = asRecord(value);
    if (!record) return undefined;
    for (const key of ["video_url", "video", "url", "output", "data", "b64_json"]) {
      const payload = payloadFrom(record[key]);
      if (payload) return payload;
    }
    return undefined;
  };
  const videoPayload = payloadFrom(root.video_url)
    || payloadFrom(root.mask_url)
    || payloadFrom(root.video)
    || payloadFrom(root.output)
    || payloadFrom(root.videos);
  if (!videoPayload) {
    throw new Error(`DeepInfra returned no video: ${JSON.stringify(data)}`);
  }

  const resolvedVideoPayload = videoPayload.startsWith("/") ? `https://api.deepinfra.com${videoPayload}` : videoPayload;
  const parsed = await bufferFromPayload(resolvedVideoPayload, "video/mp4", options.signal);
  const openAIUsage = normalizeOpenAIUsage(root.usage);
  const status = asRecord(root.inference_status);
  const inputTokens = typeof status?.tokens_input === "number" ? status.tokens_input
    : typeof status?.input_tokens === "number" ? status.input_tokens
      : undefined;
  const outputTokens = typeof status?.out_tokens === "number" ? status.out_tokens
    : typeof status?.tokens_generated === "number" ? status.tokens_generated
      : typeof status?.output_tokens === "number" ? status.output_tokens
        : undefined;
  const cost = typeof status?.cost === "number" && Number.isFinite(status.cost) ? status.cost : undefined;
  const costUsage = cost !== undefined && pricingHasTokenSections(card?.pricing) ? usageFromCost(card, cost) : undefined;
  const baseUsage = costUsage || openAIUsage || (inputTokens !== undefined || outputTokens !== undefined ? {
    promptTokens: inputTokens || 0,
    completionTokens: outputTokens || 0,
    totalTokens: (inputTokens || 0) + (outputTokens || 0),
  } : costUsage);
  const usage = baseUsage || cost !== undefined ? {
    ...(baseUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    billingMetrics: {
      ...(baseUsage?.billingMetrics || {}),
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined ? { output_tokens: outputTokens, out_tokens: outputTokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
    },
    ...(status ? { raw: status } : {}),
  } : undefined;
  return {
    ...parsed,
    ...(/^https?:\/\//i.test(resolvedVideoPayload) ? { url: resolvedVideoPayload } : {}),
    ...(usage ? { usage } : {}),
  };
}

// =============================================================================
// Music Generation — native /v1/inference/{modelId}
// =============================================================================

export interface DeepInfraMusicOptions {
  language?: string;
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export async function generateDeepInfraMusic(
  modelId: string,
  prompt: string,
  options: DeepInfraMusicOptions = {},
): Promise<{ buffer: Buffer; mimeType: string; duration?: number; usage?: Usage }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const custom = options.customParams ?? {};
  // The native surface speaks `language_code`; `language` is a request-side alias.
  const languageCode = options.language
    ?? (typeof custom.language === "string" ? custom.language : undefined)
    ?? (typeof custom.language_code === "string" ? custom.language_code : undefined);

  const body: Record<string, unknown> = { prompt };
  if (languageCode) body.language_code = languageCode;

  // Required by the live schema — empty values are documented-valid (the model
  // writes its own lyrics / ignores the negative prompt then).
  body.lyrics = typeof custom.lyrics === "string" ? custom.lyrics : "";
  body.negative_prompt = typeof custom.negative_prompt === "string" ? custom.negative_prompt : "";
  body.response_format = typeof custom.response_format === "string" ? custom.response_format : "mp3";

  if (typeof custom.duration === "number") body.duration = custom.duration;
  if (typeof custom.instrumental === "boolean") body.instrumental = custom.instrumental;
  if (typeof custom.bpm === "number") body.bpm = custom.bpm;
  if (typeof custom.guidance_scale === "number") body.guidance_scale = custom.guidance_scale;
  if (typeof custom.seed === "number") body.seed = custom.seed;
  if (typeof custom.think !== "undefined") body.think = custom.think;
  if (typeof custom.task === "string") body.task = custom.task;

  for (const [key, value] of Object.entries(custom)) {
    if (!(key in body) && key !== "language") {
      body[key] = value;
    }
  }

  const response = await fetch(`${NATIVE_BASE}/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`DeepInfra music generation failed: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const data = asRecord(await response.json()) ?? {};
  const audioPayload = typeof data.audio === "string" ? data.audio
    : typeof data.output === "string" ? data.output
      : typeof data.data === "string" ? data.data
        : null;
  if (!audioPayload) {
    throw new Error(`DeepInfra returned no audio: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const responseFormat = typeof body.response_format === "string" ? body.response_format : "mp3";
  const parsed = await bufferFromPayload(audioPayload, audioMimeType(responseFormat), options.signal);

  // Authoritative billable quantity.
  const status = asRecord(data.inference_status) ?? {};
  const reportedSeconds = typeof status.output_length === "number" && Number.isFinite(status.output_length)
    ? status.output_length
    : typeof data.duration_seconds === "number" && Number.isFinite(data.duration_seconds)
      ? data.duration_seconds
      : undefined;
  const duration = typeof reportedSeconds === "number" && reportedSeconds > 0
    ? reportedSeconds
    : audioDurationSeconds(parsed.buffer, parsed.mimeType);

  const billingMetrics: Record<string, number> = {};
  if (typeof duration === "number" && duration > 0) {
    billingMetrics.second = duration;
    billingMetrics.audio_second = duration;
    billingMetrics.generated_audio_second = duration;
    billingMetrics.minute = duration / 60;
    billingMetrics.audio_minute = duration / 60;
    billingMetrics.generated_audio_minute = duration / 60;
    billingMetrics.duration = duration;
  }

  return {
    ...parsed,
    ...(typeof duration === "number" && duration > 0 ? { duration } : {}),
    ...(Object.keys(billingMetrics).length > 0 ? {
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        billingMetrics,
      },
    } : {}),
  };
}

// =============================================================================
// Text-to-Speech (TTS) — OpenAI-compatible /v1/openai/audio/speech
// =============================================================================

export interface DeepInfraSpeechOptions {
  voice?: string;
  responseFormat?: string;
  speed?: number;
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export async function generateDeepInfraSpeech(
  modelId: string,
  text: string,
  options: DeepInfraSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const format = options.responseFormat || "mp3";
  const body: Record<string, unknown> = {
    model: modelId,
    input: text,
    ...(options.voice ? { voice: options.voice } : {}),
    response_format: format,
    ...(typeof options.speed === "number" ? { speed: options.speed } : {}),
    ...(options.customParams ?? {}),
  };

  const response = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`DeepInfra TTS failed: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || `audio/${format}`;
  return { buffer, mimeType: contentType };
}

// =============================================================================
// Speech-to-Text (STT) — OpenAI-compatible /v1/openai/audio/transcriptions
// =============================================================================

export interface DeepInfraTranscriptionOptions {
  language?: string;
  responseFormat?: string;
  temperature?: number;
  prompt?: string;
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export async function transcribeDeepInfraAudio(
  modelId: string,
  audioBuffer: Buffer,
  mimeType: string,
  options: DeepInfraTranscriptionOptions = {},
): Promise<{ text: string; usage?: unknown }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const formData = new FormData();
  const blob = new Blob(
    [audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer],
    { type: mimeType || "audio/wav" },
  );
  formData.append("file", blob, "audio.wav");
  formData.append("model", modelId);

  if (options.responseFormat) formData.append("response_format", options.responseFormat);
  if (options.language) formData.append("language", options.language);
  if (options.prompt) formData.append("prompt", options.prompt);
  if (typeof options.temperature === "number") formData.append("temperature", String(options.temperature));

  const response = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
    },
    body: formData,
    signal: options.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`DeepInfra STT failed: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = (await response.json()) as { text?: string; usage?: unknown };
    return { text: data.text || "", ...(data.usage ? { usage: data.usage } : {}) };
  }

  const text = await response.text();
  return { text };
}

// =============================================================================
// Reranking — native /v1/inference/{modelId}
// =============================================================================

export interface DeepInfraRerankResult {
  text: string;
  raw: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    billingMetrics: Record<string, unknown>;
  };
}

export async function rerankDeepInfraText(
  modelId: string,
  query: string,
  documents: Array<string | Record<string, unknown>>,
  options: Record<string, unknown> = {},
): Promise<DeepInfraRerankResult> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const docs = documents
    .map((doc) => {
      if (typeof doc === "string") return doc;
      const text = (doc as Record<string, unknown>)?.text;
      return typeof text === "string" ? text : JSON.stringify(doc);
    })
    .filter((text) => text.length > 0);

  if (!query) {
    throw Object.assign(new Error("DeepInfra rerank requires query"), { statusCode: 400 });
  }
  if (docs.length === 0) {
    throw Object.assign(new Error("DeepInfra rerank requires documents"), { statusCode: 400 });
  }

  const body: Record<string, unknown> = {
    query,
    documents: docs,
    ...(typeof options.top_n === "number" ? { top_n: options.top_n } : {}),
    ...(typeof options.return_documents === "boolean" ? { return_documents: options.return_documents } : {}),
  };

  const response = await fetch(`${NATIVE_BASE}/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`DeepInfra rerank failed: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const data = (await response.json()) as { scores?: number[]; results?: unknown };
  return {
    text: JSON.stringify(data),
    raw: data,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      billingMetrics: rerankBillingMetrics(docs.length),
    },
  };
}
