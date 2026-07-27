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

import { bufferFromPayload } from "../shared/index.js";
import { buildBriaBody } from "../families/bria.js";
import { rerankBillingMetrics } from "../modalities/rerank.js";

const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;

if (!DEEPINFRA_API_KEY) {
  console.warn("[deepinfra] DEEPINFRA_API_KEY not set — native inference disabled");
}

const OPENAI_BASE = "https://api.deepinfra.com/v1/openai";
const NATIVE_BASE = "https://api.deepinfra.com/v1/inference";

export interface DeepInfraImageOptions {
  size?: string;
  quality?: string;
  n?: number;
  imageUrl?: string;
  maskUrl?: string;
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export async function generateDeepInfraImage(
  modelId: string,
  prompt: string,
  options: DeepInfraImageOptions = {}
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const url = `https://api.deepinfra.com/v1/inference/${modelId}`;
  
  // Build body with Bria protocol translation
  const body = buildBriaBody(modelId, prompt, {
    image: options.imageUrl,
    mask: options.maskUrl,
    size: options.size,
    n: options.n,
    customParams: options.customParams,
  });

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
    const errorBody = await response.text().catch(() => "");
    throw new Error(`DeepInfra Native Inference failed: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const data = (await response.json()) as { images?: string[]; output?: string[] };
  const list = data.images ?? data.output;
  if (!list || list.length === 0) {
    throw new Error(`DeepInfra returned no images: ${JSON.stringify(data)}`);
  }

  const first = list[0];
  const parsed = await bufferFromPayload(first, "image/png", options.signal);
  return parsed;
}

export interface DeepInfraVideoOptions {
  imageUrl?: string;
  videoUrl?: string;
  signal?: AbortSignal;
  customParams?: Record<string, unknown>;
}

export async function generateDeepInfraVideo(
  modelId: string,
  prompt: string,
  options: DeepInfraVideoOptions = {}
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const url = `https://api.deepinfra.com/v1/inference/${modelId}`;

  const body: Record<string, unknown> = {
    prompt,
    ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
    ...(options.videoUrl ? { video_url: options.videoUrl } : {}),
    ...(options.customParams ?? {}),
  };

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
    const errorBody = await response.text().catch(() => "");
    throw new Error(`DeepInfra Native Video Inference failed: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const data = (await response.json()) as { video?: string; output?: string };
  const videoPayload = data.video ?? data.output;
  if (!videoPayload) {
    throw new Error(`DeepInfra returned no video: ${JSON.stringify(data)}`);
  }

  const parsed = await bufferFromPayload(videoPayload, "video/mp4", options.signal);
  return parsed;
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
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!DEEPINFRA_API_KEY) {
    throw new Error("DEEPINFRA_API_KEY not configured");
  }

  const custom = options.customParams ?? {};
  const language = options.language
    ?? (typeof custom.language === "string" ? custom.language : undefined)
    ?? "en";

  const body: Record<string, unknown> = {
    prompt,
    language,
  };

  if (typeof custom.lyrics === "string") body.lyrics = custom.lyrics;
  if (typeof custom.duration === "number") body.duration = custom.duration;
  if (typeof custom.instrumental === "boolean") body.instrumental = custom.instrumental;
  if (typeof custom.bpm === "number") body.bpm = custom.bpm;
  if (typeof custom.guidance_scale === "number") body.guidance_scale = custom.guidance_scale;
  if (typeof custom.seed === "number") body.seed = custom.seed;
  if (typeof custom.think !== "undefined") body.think = custom.think;
  if (typeof custom.negative_prompt === "string") body.negative_prompt = custom.negative_prompt;
  if (typeof custom.task === "string") body.task = custom.task;
  if (typeof custom.response_format === "string") body.response_format = custom.response_format;

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

  const data = (await response.json()) as { audio?: string; output?: string; data?: string };
  const audioPayload = data.audio ?? data.output ?? (typeof data.data === "string" ? data.data : null);
  if (!audioPayload) {
    throw new Error(`DeepInfra returned no audio: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const parsed = await bufferFromPayload(audioPayload, "audio/wav", options.signal);
  return parsed;
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
