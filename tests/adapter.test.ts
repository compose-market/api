import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import type { Request } from "../inference/core.js";

type FetchImpl = typeof fetch;

let generateWithTools: (request: Request, target: { modelId: string; provider: any }) => Promise<{ output: any }>;
let streamWithTools: (request: Request, target: { modelId: string; provider: any }) => AsyncGenerator<any>;
let retrieveJob: (jobId: string) => Promise<{ status: string; url?: string; error?: string; progress?: number }>;
let downloadGoogleFileDataUrl: (uri: string, apiKey: string) => Promise<string>;
let isOpenAIImageStreamingUnsupportedError: (error: unknown) => boolean;
let openaiGenerateImage: (
  modelId: string,
  prompt: string,
  options?: { size?: "1024x1024" | "1792x1024" | "1024x1792" | "256x256" | "512x512"; quality?: "standard" | "hd"; n?: number; imageUrl?: string },
) => Promise<{ buffer: Buffer; mimeType: string }>;
let generateAlibabaImage: (
  modelId: string,
  prompt: string,
  options?: { n?: number; size?: string; quality?: string; imageUrl?: string; customParams?: Record<string, unknown> },
) => Promise<{ buffer: Buffer; mimeType: string }>;
let generateAlibabaSpeech: (
  modelId: string,
  text: string,
  options?: { voice?: string; responseFormat?: string; speed?: number; customParams?: Record<string, unknown> },
) => Promise<{ buffer: Buffer; mimeType: string; usage?: { billingMetrics?: Record<string, unknown> } }>;
let generateElevenLabsMusic: (
  modelId: string,
  prompt: string,
  options?: { musicLengthMs?: number },
) => Promise<{ buffer: Buffer; mimeType: string; usage: { billingMetrics: Record<string, unknown> } }>;
let transcribeAlibabaAudio: (
  modelId: string,
  audioUrl: string | undefined,
  audioBuffer: Buffer | undefined,
  options?: { language?: string; responseFormat?: string; customParams?: Record<string, unknown> },
) => Promise<{ text: string; raw: unknown }>;
let submitAlibabaVideo: (
  modelId: string,
  prompt: string,
  options?: { duration?: number; aspectRatio?: string; resolution?: string; size?: string; imageUrl?: string; imageUrls?: string[]; videoUrl?: string; customParams?: Record<string, unknown> },
) => Promise<{ jobId: string; status: string; raw: unknown }>;
let mapDeepgramSpeakFormat: (format?: string) => {
  encoding?: string;
  container?: string;
};
let googleImageApi: (modelId: string) => "content" | "images";
let normalizeUsage: (usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
}) => {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};
let originalFetch: FetchImpl;

before(async () => {
  process.env.DEEPGRAM_API_KEY = "test-deepgram";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs";
  process.env.ELEVENLABS_DEFAULT_VOICE_ID = "voice_123";
  process.env.CARTESIA_API_KEY = "test-cartesia";
  process.env.CARTESIA_DEFAULT_VOICE_ID = "cartesia_voice";
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google";
  process.env.ROBOFLOW_API_KEY = "test-roboflow";
  process.env.CF_API_TOKEN = "test-cloudflare";
  process.env.CF_ACCOUNT_ID = "test-account";
  process.env.ALIBABA_CLOUD_API_KEY = "test-alibaba";
  process.env.OPENAI_API_KEY = "test-openai";

  originalFetch = globalThis.fetch;
  ({ generateWithTools, streamWithTools, retrieveJob, downloadGoogleFileDataUrl, normalizeUsage } = await import("../inference/catalog/adapter.js"));
  ({ isOpenAIImageStreamingUnsupportedError, openaiGenerateImage } = await import("../inference/catalog/families/openai.js"));
  ({ generateElevenLabsMusic } = await import("../inference/catalog/families/elevenlabs.js"));
  ({ imageApi: googleImageApi } = await import("../inference/catalog/families/google.js"));
  ({ mapDeepgramSpeakFormat } = await import("../inference/catalog/families/deepgram.js"));
  ({ generateAlibabaImage, generateAlibabaSpeech, transcribeAlibabaAudio, submitAlibabaVideo } = await import("../inference/catalog/vendors/alibaba.js"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function wav(seconds: number, sampleRate = 16_000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataSize = Math.max(1, Math.round(seconds * byteRate));
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test("generateWithTools routes image understanding through Roboflow for text requests", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === "https://example.com/scene.png") {
      return new Response(Buffer.from("image-bytes"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (url.startsWith("https://detect.roboflow.com/inventory-cam/4")) {
      return Response.json({
        predictions: [
          { class: "laptop", confidence: 0.97, x: 120, y: 88, width: 320, height: 180 },
          { class: "phone", confidence: 0.92, x: 420, y: 140, width: 90, height: 180 },
        ],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "chat",
    model: "roboflow/inventory-cam/4",
    stream: false,
    modality: "text",
    responseId: "resp_roboflow",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe the workspace." },
          { type: "image_url", image_url: { url: "https://example.com/scene.png" } },
        ],
      },
    ],
  };

  const result = await generateWithTools(request, {
    modelId: "roboflow/inventory-cam/4",
    provider: "roboflow",
  });

  assert.equal(result.output.modality, "text");
  assert.match(result.output.content, /Roboflow detections/i);
  assert.match(result.output.content, /laptop/i);
  assert.deepEqual(calls, [
    "https://example.com/scene.png",
    "https://detect.roboflow.com/inventory-cam/4?api_key=test-roboflow",
  ]);
});

test("generateWithTools routes Roboflow image operations through the vision family", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === "https://example.com/street.jpg") {
      return new Response(Buffer.from("image-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    if (url.startsWith("https://serverless.roboflow.com/coco/36")) {
      return Response.json({
        predictions: [
          { class: "person", confidence: 0.98, x: 100, y: 120, width: 40, height: 180 },
          { class: "bicycle", confidence: 0.91, x: 210, y: 160, width: 150, height: 100 },
        ],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "roboflow/rfdetr-base",
    stream: false,
    modality: "image",
    operation: "object-detection",
    responseId: "resp_roboflow_image",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Find road users." },
        { type: "image_url", image_url: { url: "https://example.com/street.jpg" } },
      ],
    }],
  }, {
    modelId: "roboflow/rfdetr-base",
    provider: "roboflow",
  });

  assert.equal(result.output.modality, "text");
  assert.match(result.output.content, /person/i);
  assert.match(result.output.content, /bicycle/i);
  assert.deepEqual(calls, [
    "https://example.com/street.jpg",
    "https://serverless.roboflow.com/coco/36?api_key=test-roboflow",
  ]);
});

test("generateWithTools sends Roboflow Grounding DINO text as a list", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/fruit.jpg") {
      return new Response(Buffer.from("image-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url.startsWith("https://serverless.roboflow.com/grounding_dino/infer")) {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        predictions: [{ class: "fruit", confidence: 0.88, x: 100, y: 120, width: 80, height: 90 }],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "roboflow/grounding-dino/infer",
    stream: false,
    modality: "image",
    operation: "object-detection",
    responseId: "resp_rf_grounding",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Find fruit." },
        { type: "image_url", image_url: { url: "https://example.com/fruit.jpg" } },
      ],
    }],
  }, {
    modelId: "roboflow/grounding-dino/infer",
    provider: "roboflow",
  });

  assert.deepEqual(requestBody.text, ["Find fruit."]);
  assert.equal(result.output.modality, "text");
  assert.match(result.output.content || "", /fruit/i);
});

test("generateWithTools supports Roboflow SAM image embeddings", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/mask.jpg") {
      return new Response(Buffer.from("image-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url.startsWith("https://serverless.roboflow.com/sam/embed_image")) {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ embeddings: [[0.1, 0.2, 0.3]] });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "roboflow/sam/embed-image",
    stream: false,
    modality: "embedding",
    operation: "image-to-embedding",
    responseId: "resp_rf_sam_embedding",
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/mask.jpg" } }],
    }],
  }, {
    modelId: "roboflow/sam/embed-image",
    provider: "roboflow",
  });

  assert.equal(requestBody.image.type, "base64");
  assert.deepEqual(result.output.embeddings, [[0.1, 0.2, 0.3]]);
});

test("streamWithTools routes Roboflow text analysis through the vision family", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === "https://example.com/stream.jpg") {
      return new Response(Buffer.from("image-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    if (url.startsWith("https://serverless.roboflow.com/coco/36")) {
      assert.equal(init?.body, Buffer.from("image-bytes").toString("base64"));
      return Response.json({ detections: [{ class: "car", confidence: 0.91 }] });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "responses",
    model: "roboflow/rfdetr-base",
    stream: true,
    modality: "text",
    operation: "image-to-text",
    responseId: "resp_rf_stream",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe detected objects." },
        { type: "image_url", image_url: { url: "https://example.com/stream.jpg" } },
      ],
    }],
  };

  const events = [];
  for await (const event of streamWithTools(request, {
    modelId: "roboflow/rfdetr-base",
    provider: "roboflow",
  })) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "text-delta");
  assert.match(events[0]?.text || "", /car/i);
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(calls, [
    "https://example.com/stream.jpg",
    "https://serverless.roboflow.com/coco/36?api_key=test-roboflow",
  ]);
});

test("streamWithTools cleans Gemini tool schemas to the wire subset", async () => {
  let body: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.example.com/frame.jpg") {
      return new Response(new Uint8Array(png(16, 16)), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    body = JSON.parse(String(init?.body));
    return new Response([
      "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1,\"totalTokenCount\":2}}",
      "",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as FetchImpl;

  const request: Request = {
    mode: "chat",
    model: "gemini-3.1-flash-lite-preview",
    stream: true,
    modality: "text",
    responseId: "resp_gemini_tools",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "use a tool" },
        { type: "image_url", image_url: { url: "https://cdn.example.com/frame.jpg" } },
      ],
    }],
    tools: [{
      type: "function",
      function: {
        name: "task",
        description: "Delegate work",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: { type: "string", minLength: 1 },
            budget: {
              type: "object",
              additionalProperties: false,
              properties: {
                maxDepth: { type: "integer", exclusiveMinimum: 0, maximum: 10 },
              },
            },
            value: {
              anyOf: [
                { type: "string" },
                { type: "number" },
              ],
            },
            meta: {
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: {},
            },
          },
          required: ["prompt"],
        },
      },
    }],
  };

  const events = [];
  for await (const event of streamWithTools(request, {
    modelId: "gemini-3.1-flash-lite-preview",
    provider: "gemini",
  })) {
    events.push(event);
  }

  const params = body.tools[0].functionDeclarations[0].parameters;
  assert.equal(params.additionalProperties, undefined);
  assert.equal(params.properties.prompt.minLength, undefined);
  assert.equal(params.properties.budget.additionalProperties, undefined);
  assert.equal(params.properties.budget.properties.maxDepth.exclusiveMinimum, undefined);
  assert.equal(params.properties.budget.properties.maxDepth.maximum, undefined);
  assert.equal(params.properties.value.anyOf, undefined);
  assert.equal(params.properties.value.type, "string");
  assert.equal(params.properties.meta.propertyNames, undefined);
  assert.equal(params.properties.meta.additionalProperties, undefined);
  const parts = body.contents[0].parts;
  assert.equal(parts[1].inlineData.mimeType, "image/jpeg");
  assert.equal(parts[1].inlineData.data, png(16, 16).toString("base64"));
  assert.equal(events.at(-1)?.type, "done");
});

test("generateWithTools routes speech recognition through Deepgram", async () => {
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/audio.wav") {
      return new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }

    if (url.startsWith("https://api.deepgram.com/v1/listen")) {
      return Response.json({
        results: {
          channels: [
            {
              alternatives: [
                { transcript: "schedule a coding session for tomorrow morning" },
              ],
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "chat",
    model: "deepgram/nova-3",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_deepgram",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { url: "https://example.com/audio.wav" } },
        ],
      },
    ],
    audioOptions: {
      language: "en",
      responseFormat: "json",
    },
  };

  const result = await generateWithTools(request, {
    modelId: "deepgram/nova-3",
    provider: "deepgram",
  });

  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "schedule a coding session for tomorrow morning");
});

test("generateWithTools accepts inline audio for buffer-capable speech recognition providers", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.startsWith("https://api.deepgram.com/v1/listen")) {
      const body = init?.body;
      if (body instanceof Blob) {
        assert.equal(await body.text(), "audio-bytes");
      } else {
        assert.equal(Buffer.from(String(body)).toString(), "audio-bytes");
      }
      return Response.json({
        results: {
          channels: [
            {
              alternatives: [
                { transcript: "inline audio works" },
              ],
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "chat",
    model: "deepgram/nova-3",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_deepgram_inline",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              url: `data:audio/wav;base64,${Buffer.from("audio-bytes").toString("base64")}`,
            },
          },
        ],
      },
    ],
    audioOptions: {
      language: "en",
      responseFormat: "json",
    },
  };

  const result = await generateWithTools(request, {
    modelId: "deepgram/nova-3",
    provider: "deepgram",
  });

  assert.deepEqual(calls, ["https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true"]);
  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "inline audio works");
});

test("generateWithTools carries transcript-derived usage for token-priced speech recognition", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://example.com/voice.wav") {
      return new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }

    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return Response.json({
        text: "Compose audio works.",
        usage: {
          type: "duration",
          seconds: 3,
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "whisper-1",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_whisper",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { url: "https://example.com/voice.wav" } }],
    }],
    audioOptions: { responseFormat: "json" },
  }, {
    modelId: "whisper-1",
    provider: "openai",
  });

  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "Compose audio works.");
  assert.deepEqual(result.output.usage, {
    promptTokens: 5,
    completionTokens: 0,
    totalTokens: 5,
    billingMetrics: {
      second: 3,
      input_text_tokens: 5,
    },
  });
  assert.deepEqual(calls, [
    "https://example.com/voice.wav",
    "https://api.openai.com/v1/audio/transcriptions",
  ]);
});

test("generateWithTools uses catalog operation for prompted OpenAI transcription", async () => {
  const calls: string[] = [];
  let formModel = "";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://example.com/meeting.wav") {
      return new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }

    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const form = init?.body as FormData;
      formModel = String(form.get("model"));
      assert.equal(form.get("prompt"), "Use Compose product terms.");
      return Response.json({ text: "Compose product terms were transcribed." });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "gpt-4o-mini-transcribe",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_openai_stt_prompt",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Use Compose product terms." },
        { type: "input_audio", input_audio: { url: "https://example.com/meeting.wav" } },
      ],
    }],
    audioOptions: { responseFormat: "json" },
  }, {
    modelId: "gpt-4o-mini-transcribe",
    provider: "openai",
  });

  assert.equal(formModel, "gpt-4o-mini-transcribe");
  assert.equal(result.output.content, "Compose product terms were transcribed.");
  assert.deepEqual(calls, [
    "https://example.com/meeting.wav",
    "https://api.openai.com/v1/audio/transcriptions",
  ]);
});

test("Deepgram TTS defaults to a currently accepted WAV container", () => {
  assert.deepEqual(mapDeepgramSpeakFormat(), {
    container: "wav",
    encoding: "linear16",
  });
  assert.deepEqual(mapDeepgramSpeakFormat("ogg"), {
    encoding: "opus",
    container: "ogg",
  });
});

test("Google image family selects image API from catalog output shape", () => {
  assert.equal(googleImageApi("imagen-4.0-generate-001"), "images");
  assert.equal(googleImageApi("gemini-2.5-flash-image"), "content");
});

test("generateWithTools sends Cloudflare Whisper audio through the Workers AI byte-array schema", async () => {
  let requestBody: any;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://example.com/cloudflare.wav") {
      return new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }

    if (url.includes("/ai/run/@cf/openai/whisper")) {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { text: "cloudflare transcription works" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/openai/whisper",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_cf_asr",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { url: "https://example.com/cloudflare.wav" } }],
    }],
  }, {
    modelId: "@cf/openai/whisper",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody.audio, Array.from(Buffer.from("audio-bytes").values()));
  assert.equal(result.output.content, "cloudflare transcription works");
  assert.deepEqual(calls, [
    "https://example.com/cloudflare.wav",
    "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/openai/whisper",
  ]);
});

test("generateWithTools sends Cloudflare Nova audio through the Workers AI raw REST body", async () => {
  let requestBody: BodyInit | null | undefined;
  let requestHeaders: HeadersInit | undefined;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://example.com/nova.mp3") {
      return new Response(Buffer.from("nova-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/deepgram/nova-3?language=en-US&smart_format=true") {
      requestBody = init?.body;
      requestHeaders = init?.headers;
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          results: {
            channels: [{
              alternatives: [{ transcript: "nova transcription works" }],
            }],
          },
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/deepgram/nova-3",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_cf_nova",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { url: "https://example.com/nova.mp3" } }],
    }],
    audioOptions: { language: "en-US" },
    customParams: { smart_format: true },
  }, {
    modelId: "@cf/deepgram/nova-3",
    provider: "cloudflare",
  });

  assert.equal(Buffer.from(requestBody as ArrayBuffer).toString(), "nova-audio");
  assert.equal((requestHeaders as Record<string, string>)["Content-Type"], "audio/mpeg");
  assert.equal(result.output.content, "nova transcription works");
  assert.deepEqual(calls, [
    "https://example.com/nova.mp3",
    "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/deepgram/nova-3?language=en-US&smart_format=true",
  ]);
});

test("generateWithTools sends Cloudflare LLaVA vision chat through the Workers AI image schema", async () => {
  let requestBody: any;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://example.com/chart.png") {
      return new Response(Buffer.from([5, 6, 7]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/llava-hf/llava-1.5-7b-hf") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { description: "The chart shows steady growth." },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/llava-hf/llava-1.5-7b-hf",
    stream: false,
    modality: "text",
    operation: "vision-chat",
    responseId: "resp_cf_llava",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe this chart." },
        { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
      ],
    }],
  }, {
    modelId: "@cf/llava-hf/llava-1.5-7b-hf",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody, {
    image: [5, 6, 7],
    prompt: "Describe this chart.",
  });
  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "The chart shows steady growth.");
  assert.deepEqual(calls, [
    "https://example.com/chart.png",
    "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/llava-hf/llava-1.5-7b-hf",
  ]);
});

test("generateWithTools sends Cloudflare image analysis through the Workers AI image schema", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/object.png") {
      return new Response(Buffer.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/facebook/detr-resnet-50") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ label: "book", score: 0.98, box: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 } }],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/facebook/detr-resnet-50",
    stream: false,
    modality: "image",
    operation: "object-detection",
    responseId: "resp_cf_detection",
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/object.png" } }],
    }],
  }, {
    modelId: "@cf/facebook/detr-resnet-50",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody, { image: [1, 2, 3, 4] });
  assert.equal(result.output.modality, "text");
  assert.match(result.output.content, /book/);
});

test("generateWithTools decodes Cloudflare JSON image output before settlement metrics", async () => {
  const image = png(512, 512);
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/black-forest-labs/flux-1-schnell") {
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          image: image.toString("base64"),
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/black-forest-labs/flux-1-schnell",
    stream: false,
    modality: "image",
    operation: "text-to-image",
    responseId: "resp_cf_flux",
    messages: [{ role: "user", content: "A crisp product render of a ceramic cup." }],
  }, {
    modelId: "@cf/black-forest-labs/flux-1-schnell",
    provider: "cloudflare",
  });

  assert.equal(result.output.modality, "image");
  assert.equal(result.output.media?.mimeType, "image/png");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").equals(image), true);
  assert.equal(result.output.media?.billingMetrics.pixel, 512 * 512);
  assert.equal(result.output.media?.billingMetrics.megapixel, (512 * 512) / 1_000_000);
});

test("generateWithTools sends Cloudflare multipart image models as form data", async () => {
  const image = png(768, 512);
  let requestBody: any;
  let requestHeaders: HeadersInit | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/black-forest-labs/flux-2-dev") {
      requestBody = init?.body;
      requestHeaders = init?.headers;
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          image: image.toString("base64"),
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/black-forest-labs/flux-2-dev",
    stream: false,
    modality: "image",
    operation: "text-to-image",
    responseId: "resp_cf_flux2",
    messages: [{ role: "user", content: "A crisp product render of a ceramic cup." }],
    customParams: { steps: 5, width: 768, height: 512 },
  }, {
    modelId: "@cf/black-forest-labs/flux-2-dev",
    provider: "cloudflare",
  });

  assert.equal(requestBody instanceof FormData, true);
  assert.equal(requestBody.get("prompt"), "A crisp product render of a ceramic cup.");
  assert.equal(requestBody.get("steps"), "5");
  assert.equal(requestBody.get("width"), "768");
  assert.equal(requestBody.get("height"), "512");
  assert.equal("Content-Type" in (requestHeaders as Record<string, string>), false);
  assert.equal(result.output.modality, "image");
  assert.equal(result.output.media?.mimeType, "image/png");
});

test("generateWithTools sends Cloudflare translation through model-native text fields", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/ai4bharat/indictrans2-en-indic-1B") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { translations: ["नमस्ते दुनिया"] },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/ai4bharat/indictrans2-en-indic-1B",
    stream: false,
    modality: "text",
    operation: "translation",
    responseId: "resp_cf_translation",
    messages: [{ role: "user", content: "Hello world" }],
    customParams: { target_language: "hin_Deva" },
  }, {
    modelId: "@cf/ai4bharat/indictrans2-en-indic-1B",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody, { text: "Hello world", target_language: "hin_Deva" });
  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "नमस्ते दुनिया");
});

test("generateWithTools sends Cloudflare M2M100 translation through target_lang", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/meta/m2m100-1.2b") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { translated_text: "Hola mundo" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/meta/m2m100-1.2b",
    stream: false,
    modality: "text",
    operation: "translation",
    responseId: "resp_cf_m2m100",
    messages: [{ role: "user", content: "Hello world" }],
    customParams: { target_language: "hin_Deva", target_lang: "es" },
  }, {
    modelId: "@cf/meta/m2m100-1.2b",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody, { text: "Hello world", target_lang: "es" });
  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "Hola mundo");
});

test("generateWithTools sends Cloudflare rerank through the Workers AI rerank schema", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/baai/bge-reranker-base") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          response: [
            { id: 1, score: 0.93 },
            { id: 0, score: 0.21 },
          ],
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/baai/bge-reranker-base",
    stream: false,
    modality: "text",
    operation: "rerank",
    responseId: "resp_cf_rerank",
    messages: [{ role: "user", content: "Which document discusses the Compose SDK?" }],
    customParams: {
      documents: [
        "A billing receipt reference.",
        { text: "The Compose SDK streams universal inference events." },
      ],
      top_k: 2,
    },
  }, {
    modelId: "@cf/baai/bge-reranker-base",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody, {
    query: "Which document discusses the Compose SDK?",
    contexts: [
      { text: "A billing receipt reference." },
      { text: "The Compose SDK streams universal inference events." },
    ],
    top_k: 2,
  });
  assert.equal(result.output.modality, "text");
  assert.match(result.output.content || "", /0.93/);
  assert.deepEqual(result.output.usage?.billingMetrics, {
    request: 1,
    search: 1,
    document: 2,
  });
});

test("streamWithTools sends Cloudflare translation through model-native text fields", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/ai4bharat/indictrans2-en-indic-1B") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { translations: ["नमस्ते दुनिया"] },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const events = [];
  for await (const event of streamWithTools({
    mode: "responses",
    model: "@cf/ai4bharat/indictrans2-en-indic-1B",
    stream: true,
    modality: "text",
    operation: "translation",
    responseId: "resp_cf_translation_stream",
    messages: [{ role: "user", content: "Hello world" }],
    customParams: { target_language: "hin_Deva" },
  }, {
    modelId: "@cf/ai4bharat/indictrans2-en-indic-1B",
    provider: "cloudflare",
  })) {
    events.push(event);
  }

  assert.deepEqual(requestBody, { text: "Hello world", target_language: "hin_Deva" });
  assert.equal(events[0]?.type, "text-delta");
  assert.equal(events[0]?.text, "नमस्ते दुनिया");
  assert.equal(events.at(-1)?.type, "done");
});

test("generateWithTools sends Cloudflare MeloTTS prompt field", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/myshell-ai/melotts") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        result: {
          audio: Buffer.from(wav(2)).toString("base64"),
        },
        success: true,
        errors: [],
        messages: [],
      }, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/myshell-ai/melotts",
    stream: false,
    modality: "audio",
    operation: "text-to-speech",
    responseId: "resp_cf_melotts",
    messages: [{ role: "user", content: "Say this through MeloTTS." }],
  }, {
    modelId: "@cf/myshell-ai/melotts",
    provider: "cloudflare",
  });

  assert.deepEqual(requestBody, { prompt: "Say this through MeloTTS.", lang: "en" });
  assert.equal(result.output.media?.mimeType, "audio/wav");
  assert.equal(result.output.media?.billingMetrics?.audio_minute, 2 / 60);
});

test("generateWithTools sends Cloudflare Smart Turn through native VAD schema", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/speech.wav") {
      return new Response(new Uint8Array(wav(1.5)), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }

    if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/pipecat-ai/smart-turn-v2") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        result: {
          is_complete: true,
          probability: 0.94,
        },
        success: true,
        errors: [],
        messages: [],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "@cf/pipecat-ai/smart-turn-v2",
    stream: false,
    modality: "audio",
    operation: "voice-activity-detection",
    responseId: "resp_cf_smart_turn",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { url: "https://example.com/speech.wav" } }],
    }],
    customParams: { dtype: "uint8" },
  }, {
    modelId: "@cf/pipecat-ai/smart-turn-v2",
    provider: "cloudflare",
  });

  assert.equal(typeof requestBody.audio, "string");
  assert.equal(requestBody.dtype, "uint8");
  assert.deepEqual(JSON.parse(result.output.content || "{}"), { is_complete: true, probability: 0.94 });
  assert.equal(result.output.usage?.billingMetrics?.audio_minute, 1.5 / 60);
});

test("Azure chat lowers audio URLs to OpenAI input_audio data", async () => {
  process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT = "https://azure.example.com";
  process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY = "test-azure";
  process.env.AZURE_MOVZIHPN_ENDPOINT = "https://azure.example.com";
  process.env.AZURE_MOVZIHPN_API_KEY = "test-azure";
  let requestBody: any;
  const calls: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://example.com/speech.wav") {
      return new Response(Buffer.from("wav-bytes"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }

    if (url === "https://azure.example.com/openai/v1/chat/completions") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { content: "heard it" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "gpt-4o",
    stream: false,
    modality: "text",
    operation: "audio-to-text",
    responseId: "resp_azure_audio_chat",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Transcribe this clip." },
        { type: "input_audio", input_audio: { url: "https://example.com/speech.wav" } },
      ],
    }],
  }, {
    modelId: "gpt-4o",
    provider: "azure",
  });

  const audio = requestBody.messages[0].content[1].input_audio;
  assert.equal(audio.url, undefined);
  assert.equal(audio.format, "wav");
  assert.equal(audio.data, Buffer.from("wav-bytes").toString("base64"));
  assert.equal(result.output.content, "heard it");
  assert.deepEqual(calls, [
    "https://example.com/speech.wav",
    "https://azure.example.com/openai/v1/chat/completions",
  ]);
});

test("Azure responses lowers chat-style tools to Responses tool schema", async () => {
  process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT = "https://azure.services.ai.azure.com";
  process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY = "test-azure";
  process.env.AZURE_MOVZIHPN_ENDPOINT = "https://azure.services.ai.azure.com";
  process.env.AZURE_MOVZIHPN_API_KEY = "test-azure";
  let requestBody: any;

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://azure.services.ai.azure.com/openai/v1/responses") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{\"symbol\":\"ETH\"}",
        }],
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "gpt-4o",
    stream: false,
    modality: "text",
    operation: "text-generation",
    responseId: "resp_azure_responses_tools",
    messages: [{ role: "user", content: "look up ETH" }],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup a symbol",
        parameters: {
          type: "object",
          properties: { symbol: { type: "string" } },
          required: ["symbol"],
        },
      },
    }],
    toolChoice: "auto",
  }, {
    modelId: "gpt-4o",
    provider: "azure",
  });

  assert.equal(requestBody.tools[0].type, "function");
  assert.equal(requestBody.tools[0].name, "lookup");
  assert.equal(requestBody.tools[0].function, undefined);
  assert.equal(requestBody.tool_choice, "auto");
  assert.equal(result.output.toolCalls[0].name, "lookup");
});

test("OpenAI diarized transcription omits unsupported prompt field from catalog params", async () => {
  let transcriptionForm: FormData | null = null;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/speech.wav") {
      return new Response(new Uint8Array(wav(1)), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      transcriptionForm = init?.body as FormData;
      return Response.json({ text: "hello from speaker one" });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "gpt-4o-transcribe-diarize",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_openai_diarize",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Transcribe this clip." },
        { type: "input_audio", input_audio: { url: "https://example.com/speech.wav" } },
      ],
    }],
  }, {
    modelId: "gpt-4o-transcribe-diarize",
    provider: "openai",
  });

  const form = transcriptionForm as FormData | null;
  assert.ok(form);
  assert.equal(form.get("model"), "gpt-4o-transcribe-diarize");
  assert.equal(form.has("prompt"), false);
  assert.equal(result.output.content, "hello from speaker one");
});

test("Azure image generation preserves authoritative provider usage", async () => {
  process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT = "https://azure.example.com";
  process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY = "test-azure";
  process.env.AZURE_MOV00XVH_ENDPOINT = "https://azure.example.com";
  process.env.AZURE_MOV00XVH_API_KEY = "test-azure";
  let requestBody: any;

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://azure.example.com/openai/v1/images/generations") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        data: [{ b64_json: Buffer.from("png-image").toString("base64") }],
        usage: {
          input_tokens: 12,
          output_tokens: 24,
          total_tokens: 36,
          input_tokens_details: { text_tokens: 5, image_tokens: 7 },
          output_tokens_details: { image_tokens: 24 },
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "gpt-image-2",
    stream: false,
    modality: "image",
    operation: "text-to-image",
    responseId: "resp_azure_image_usage",
    messages: [{ role: "user", content: "A crisp product photo on a white table." }],
  }, {
    modelId: "gpt-image-2",
    provider: "azure",
  });

  assert.equal(requestBody.model, "gpt-image-2");
  assert.equal(result.output.modality, "image");
  assert.deepEqual(result.output.usage?.billingMetrics, {
    input_tokens: 12,
    output_tokens: 24,
    total_tokens: 36,
    input_text_tokens: 5,
    input_image_tokens: 7,
    output_image_tokens: 24,
  });
});

test("Azure image edits use multipart edit body instead of image_url JSON", async () => {
  process.env.AZURE_MOV00XVH_ENDPOINT = "https://azure.example.com";
  process.env.AZURE_MOV00XVH_API_KEY = "test-azure";
  let editForm: FormData | null = null;

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.example.com/source.png") {
      return new Response(new Uint8Array(png(32, 32)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url === "https://azure.example.com/openai/v1/images/edits") {
      editForm = init?.body as FormData;
      return Response.json({
        data: [{ b64_json: Buffer.from("edited-png").toString("base64") }],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "gpt-image-2",
    stream: false,
    modality: "image",
    operation: "image-to-image",
    responseId: "resp_azure_image_edit",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Make the fruit image look editorial." },
        { type: "image_url", image_url: { url: "https://cdn.example.com/source.png" } },
      ],
    }],
  }, {
    modelId: "gpt-image-2",
    provider: "azure",
  });

  const form = editForm as FormData | null;
  assert.ok(form);
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("prompt"), "Make the fruit image look editorial.");
  assert.ok(form.get("image") instanceof Blob);
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "edited-png");
});

test("Alibaba speech transcription rejects inline audio before provider request", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  await assert.rejects(
    () => transcribeAlibabaAudio(
      "qwen3-asr-flash-filetrans",
      `data:audio/wav;base64,${Buffer.from("audio-bytes").toString("base64")}`,
      Buffer.from("audio-bytes"),
    ),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.match((error as Error).message, /public http\(s\) audio URL/);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test("Alibaba CosyVoice websocket sends caller text to continue-task", async () => {
  const phrase = "Compose should say exactly this English sentence 4937.";
  const sent: any[] = [];
  const loader = Module as unknown as {
    _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
  };
  const originalLoad = loader._load;

  class Socket {
    binaryType: "arraybuffer" = "arraybuffer";
    readyState = 1;
    private handlers = new Map<string, Array<(...args: any[]) => void>>();

    constructor(_url: string, _options?: { headers?: Record<string, string> }) {
      setImmediate(() => this.emit("open"));
    }

    send(data: string): void {
      const parsed = JSON.parse(data);
      sent.push(parsed);
      const action = parsed.header?.action;
      if (action === "run-task") {
        setImmediate(() => this.emit("message", JSON.stringify({
          header: { event: "task-started" },
          payload: {},
        }), false));
      }
      if (action === "continue-task") {
        setImmediate(() => this.emit("message", Buffer.from("mp3-audio"), true));
      }
      if (action === "finish-task") {
        setImmediate(() => this.emit("message", JSON.stringify({
          header: { event: "task-finished" },
          payload: { usage: { characters: Array.from(phrase).length } },
        }), false));
      }
    }

    close(): void {}

    on(event: string, listener: (...args: any[]) => void): void {
      const listeners = this.handlers.get(event) ?? [];
      listeners.push(listener);
      this.handlers.set(event, listeners);
    }

    private emit(event: string, ...args: any[]): void {
      for (const listener of this.handlers.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  loader._load = function patched(request: string, parent?: unknown, isMain?: boolean): unknown {
    if (request === "ws") return Socket;
    return originalLoad.call(loader, request, parent, isMain);
  };

  try {
    const result = await generateAlibabaSpeech("cosyvoice-v3-flash", phrase, {
      responseFormat: "mp3",
    });
    const continueTask = sent.find((message) => message.header?.action === "continue-task");
    assert.equal(continueTask?.payload?.input?.text, phrase);
    assert.equal(result.buffer.toString(), "mp3-audio");
    assert.equal(result.usage?.billingMetrics?.character, Array.from(phrase).length);
  } finally {
    loader._load = originalLoad;
  }
});

test("Alibaba Qwen TTS uses native multimodal speech synthesis", async () => {
  let requestBody: any;
  const audio = Buffer.from("qwen-tts-audio");
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          audio: {
            url: `data:audio/wav;base64,${audio.toString("base64")}`,
          },
        },
        usage: {
          characters: 42,
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateAlibabaSpeech("qwen3-tts-flash", "Today is a useful compatibility check.", {
    customParams: {
      language_type: "English",
    },
  });

  assert.deepEqual(requestBody.input, {
    text: "Today is a useful compatibility check.",
    voice: "Cherry",
    language_type: "English",
  });
  assert.equal(requestBody.model, "qwen3-tts-flash");
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.buffer.toString(), "qwen-tts-audio");
  assert.equal(result.usage?.billingMetrics?.character, 42);
});

test("Alibaba Qwen voice design uses the customization endpoint and preview audio", async () => {
  let requestBody: any;
  const audio = Buffer.from("voice-design-preview");
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          voice: "VoiceA56186",
          preview_audio: {
            data: audio.toString("base64"),
            mime_type: "audio/wav",
          },
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateAlibabaSpeech(
    "qwen-voice-design",
    "A calm middle-aged narrator with a clear warm tone.",
    {
      customParams: {
        preferred_name: "VoiceA56186",
        preview_text: "This is a preview of the designed Compose voice.",
        target_model: "qwen3-tts-vd-2026-01-26",
        language: "en",
      },
    },
  );

  assert.deepEqual(requestBody, {
    model: "qwen-voice-design",
    input: {
      action: "create",
      target_model: "qwen3-tts-vd-2026-01-26",
      voice_prompt: "A calm middle-aged narrator with a clear warm tone.",
      preview_text: "This is a preview of the designed Compose voice.",
      preferred_name: "VoiceA56186",
      language: "en",
    },
  });
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.buffer.toString(), "voice-design-preview");
  assert.equal(result.usage?.billingMetrics?.voice, 1);
});

test("Alibaba Qwen voice design generates a provider-valid preferred name", async () => {
  let requestBody: any;
  const audio = Buffer.from("voice-design-preview");
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          voice: requestBody.input.preferred_name,
          preview_audio: {
            data: audio.toString("base64"),
            mime_type: "audio/wav",
          },
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  await generateAlibabaSpeech(
    "qwen-voice-design",
    "A precise warm narrator voice for product tutorials.",
    {},
  );

  assert.match(requestBody.input.preferred_name, /^VoiceA\d{6}$/);
});

test("Alibaba speech transcription submits public audio URLs to DashScope ASR and reads result files", async () => {
  const calls: string[] = [];
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription") {
      requestBody = JSON.parse(String(init?.body));
      assert.equal((init?.headers as Record<string, string>)["X-DashScope-Async"], "enable");
      return Response.json({
        output: {
          task_id: "task_123",
          task_status: "PENDING",
        },
      });
    }

    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/tasks/task_123") {
      return Response.json({
        output: {
          task_id: "task_123",
          task_status: "SUCCEEDED",
          results: [{
            file_url: "https://cdn.example.com/audio.wav",
            transcription_url: "https://result.example.com/transcript.json",
            subtask_status: "SUCCEEDED",
          }],
        },
        usage: {
          duration: 3,
        },
      });
    }

    if (url === "https://result.example.com/transcript.json") {
      return Response.json({
        properties: {
          original_duration_in_milliseconds: 2500,
        },
        transcripts: [{
          text: "public url works",
          content_duration_in_milliseconds: 2400,
        }],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await transcribeAlibabaAudio(
    "fun-asr",
    "https://cdn.example.com/audio.wav",
    undefined,
    { language: "en", responseFormat: "json" },
  );

  assert.equal(result.text, "public url works");
  assert.deepEqual(requestBody.input.file_urls, ["https://cdn.example.com/audio.wav"]);
  assert.deepEqual((result as any).usage.billingMetrics, {
    second: 3,
    audio_second: 3,
  });
  assert.deepEqual(calls, [
    "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription",
    "https://dashscope-intl.aliyuncs.com/api/v1/tasks/task_123",
    "https://result.example.com/transcript.json",
  ]);
});

test("Alibaba Qwen short ASR uses the synchronous compatible audio message route", async () => {
  let requestBody: any;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{
          message: {
            content: "welcome to alibaba cloud",
            annotations: [{ type: "audio_info", language: "en", emotion: "neutral" }],
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 5,
          total_tokens: 55,
          prompt_tokens_details: {
            audio_tokens: 50,
            text_tokens: 0,
          },
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await transcribeAlibabaAudio(
    "qwen3-asr-flash",
    "https://cdn.example.com/welcome.mp3",
    undefined,
    { language: "en" },
  );

  assert.equal(requestBody.model, "qwen3-asr-flash");
  assert.deepEqual(requestBody.messages, [{
    role: "user",
    content: [{
      type: "input_audio",
      input_audio: { data: "https://cdn.example.com/welcome.mp3" },
    }],
  }]);
  assert.deepEqual(requestBody.asr_options, { language: "en" });
  assert.equal(result.text, "welcome to alibaba cloud");
  assert.deepEqual((result as any).usage.billingMetrics, {
    second: 2,
    audio_second: 2,
  });
  assert.deepEqual(calls, [
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  ]);
});

test("Alibaba image generation converts OpenAI-style sizes after custom params", async () => {
  let requestBody: any;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          image: `data:image/png;base64,${Buffer.from("png-image").toString("base64")}`,
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateAlibabaImage("qwen-image", "A quiet Compose workspace", {
    size: "1328x1328",
    customParams: {
      size: "1328x1328",
      style: "realistic",
    },
  });

  assert.equal(requestBody.parameters.size, "1328*1328");
  assert.equal(requestBody.parameters.style, "realistic");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.buffer.toString(), "png-image");
  assert.deepEqual(calls, [
    "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  ]);
});

test("Alibaba Wan image-to-video sends the native img_url locator", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      assert.equal((init?.headers as Record<string, string>)["X-DashScope-Async"], "enable");
      return Response.json({
        output: {
          task_id: "task_video",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("wan2.1-i2v-turbo", "Animate the frame.", {
    imageUrl: "https://cdn.example.com/frame.jpg",
  });

  assert.equal(requestBody.input.img_url, "https://cdn.example.com/frame.jpg");
  assert.equal("image_url" in requestBody.input, false);
  assert.equal("media" in requestBody.input, false);
  assert.equal(requestBody.parameters.prompt_extend, false);
  assert.equal(result.jobId, "alibaba:task_video");
});

test("Alibaba HappyHorse reference-to-video sends typed reference media", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          task_id: "task_reference_video",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("happyhorse-1.0-r2v", "Keep the product identity stable.", {
    imageUrl: "https://cdn.example.com/product.png",
    aspectRatio: "16:9",
  });

  assert.equal(requestBody.input.prompt, "[Image 1] Keep the product identity stable.");
  assert.deepEqual(requestBody.input.media, [{ type: "reference_image", url: "https://cdn.example.com/product.png" }]);
  assert.equal("img_url" in requestBody.input, false);
  assert.equal("image_url" in requestBody.input, false);
  assert.equal(requestBody.parameters.aspect_ratio, "16:9");
  assert.equal("ratio" in requestBody.parameters, false);
  assert.equal(result.jobId, "alibaba:task_reference_video");
});

test("Alibaba HappyHorse video-edit sends typed input.media and nonempty prompt", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          task_id: "task_edit_video",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("happyhorse-1.0-video-edit", "", {
    imageUrl: "https://cdn.example.com/reference.png",
    videoUrl: "https://cdn.example.com/source.mp4",
  });

  assert.equal(requestBody.input.prompt, "Edit the source media while preserving its main subject and natural motion.");
  assert.deepEqual(requestBody.input.media, [
    { type: "reference_image", url: "https://cdn.example.com/reference.png" },
    { type: "video", url: "https://cdn.example.com/source.mp4" },
  ]);
  assert.equal("img_url" in requestBody.input, false);
  assert.equal("video_url" in requestBody.input, false);
  assert.equal(result.jobId, "alibaba:task_edit_video");
});

test("Alibaba Wan KF2V sends first and last frame URLs", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          task_id: "task_kf2v",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("wan2.1-kf2v-plus", "Transition naturally between these frames.", {
    imageUrl: "https://cdn.example.com/start.jpg",
    imageUrls: [
      "https://cdn.example.com/start.jpg",
      "https://cdn.example.com/end.jpg",
    ],
  });

  assert.deepEqual(requestBody.input, {
    prompt: "Transition naturally between these frames.",
    first_frame_url: "https://cdn.example.com/start.jpg",
    last_frame_url: "https://cdn.example.com/end.jpg",
  });
  assert.equal("img_url" in requestBody.input, false);
  assert.equal(result.jobId, "alibaba:task_kf2v");
});

test("Alibaba Wan VACE selects a documented function from input shape", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          task_id: "task_vace",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("wan2.1-vace-plus", "Repaint this motion with daylight color.", {
    imageUrl: "https://cdn.example.com/reference.jpg",
    videoUrl: "https://cdn.example.com/source.mp4",
  });

  assert.deepEqual(requestBody.input, {
    function: "video_repainting",
    prompt: "Repaint this motion with daylight color.",
    video_url: "https://cdn.example.com/source.mp4",
  });
  assert.deepEqual(requestBody.parameters, {
    prompt_extend: false,
    control_condition: "depth",
  });
  assert.equal(result.jobId, "alibaba:task_vace");
});

test("Alibaba Wan VACE sends reference object markers as parameters", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          task_id: "task_vace_ref",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("wan2.1-vace-plus", "Use this reference style for the motion.", {
    imageUrls: [
      "https://cdn.example.com/reference-a.jpg",
      "https://cdn.example.com/reference-b.jpg",
    ],
  });

  assert.deepEqual(requestBody.input, {
    function: "image_reference",
    prompt: "Use this reference style for the motion.",
    ref_images_url: [
      "https://cdn.example.com/reference-a.jpg",
      "https://cdn.example.com/reference-b.jpg",
    ],
  });
  assert.deepEqual(requestBody.parameters, {
    prompt_extend: false,
    obj_or_bg: ["obj", "obj"],
  });
  assert.equal(result.jobId, "alibaba:task_vace_ref");
});

test("Alibaba video maps size to resolution without sending non-native size", async () => {
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        output: {
          task_id: "task_sized_video",
          task_status: "PENDING",
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await submitAlibabaVideo("wan2.1-i2v-turbo", "Animate the fruit softly.", {
    imageUrl: "https://cdn.example.com/fruit.jpg",
    size: "1280x720",
    customParams: {
      size: "1280x720",
      prompt_extend: true,
    },
  });

  assert.equal(requestBody.parameters.resolution, "720P");
  assert.equal("size" in requestBody.parameters, false);
  assert.equal(requestBody.parameters.prompt_extend, true);
  assert.equal(result.jobId, "alibaba:task_sized_video");
});

test("generateWithTools routes speech synthesis through ElevenLabs", async () => {
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.elevenlabs.io/v1/text-to-speech/voice_123?output_format=mp3_44100_128") {
      return new Response(Buffer.from("mp3-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "chat",
    model: "eleven_multilingual_v2",
    stream: false,
    modality: "audio",
    operation: "text-to-speech",
    responseId: "resp_elevenlabs",
    messages: [
      {
        role: "user",
        content: "Draft a launch update for the new workspace session.",
      },
    ],
    audioOptions: {
      voice: "voice_123",
      responseFormat: "mp3",
    },
  };

  const result = await generateWithTools(request, {
    modelId: "eleven_multilingual_v2",
    provider: "elevenlabs",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/mpeg");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "mp3-audio");
  assert.deepEqual(result.output.media?.billingMetrics, {
    input_text_tokens: 13,
    character: Array.from("Draft a launch update for the new workspace session.").length,
  });
});

test("ElevenLabs music exposes generated audio minute billing evidence", async () => {
  let body: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.elevenlabs.io/v1/music") {
      body = JSON.parse(String(init?.body));
      return new Response(Buffer.from("mp3-music"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateElevenLabsMusic("music_v1", "Warm upbeat electronic loop.", {
    musicLengthMs: 15_000,
  });

  assert.equal(body.model_id, "music_v1");
  assert.equal(body.music_length_ms, 15_000);
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.usage.billingMetrics.generated_audio_minute, 0.25);
});

test("generateWithTools routes ElevenLabs music through the music endpoint", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === "https://api.elevenlabs.io/v1/music") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model_id, "music_v1");
      return new Response(Buffer.from("mp3-music"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "music_v1",
    stream: false,
    modality: "audio",
    operation: "music-generation",
    responseId: "resp_elevenlabs_music",
    messages: [{ role: "user", content: "A short upbeat electronic loop." }],
    customParams: { music_length_ms: 15_000 },
  }, {
    modelId: "music_v1",
    provider: "elevenlabs",
  });

  assert.deepEqual(calls, ["https://api.elevenlabs.io/v1/music"]);
  assert.equal(result.output.media?.billingMetrics?.generated_audio_minute, 0.25);
});

test("generateWithTools sends resolved ElevenLabs music defaults to the provider", async () => {
  let body: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.elevenlabs.io/v1/music") {
      body = JSON.parse(String(init?.body));
      return new Response(Buffer.from("mp3-music"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "music_v1",
    stream: false,
    modality: "audio",
    operation: "music-generation",
    responseId: "resp_elevenlabs_music_default",
    messages: [{ role: "user", content: "A warm synth-pop intro." }],
    billingMetrics: {
      music_length_ms: 3000,
      generated_audio_minute: 0.05,
    },
  }, {
    modelId: "music_v1",
    provider: "elevenlabs",
  });

  assert.equal(body.music_length_ms, 3000);
  assert.equal(result.output.media?.billingMetrics?.generated_audio_minute, 0.05);
});

test("generateWithTools routes ElevenLabs speech transcription through the family bridge", async () => {
  let formModel = "";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/sample.wav") {
      return new Response(Buffer.from("wav-bytes"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    if (url === "https://api.elevenlabs.io/v1/speech-to-text") {
      const form = init?.body as FormData;
      formModel = String(form.get("model_id"));
      return Response.json({ text: "Compose product terms were transcribed.", language_code: "en" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "scribe_v1",
    stream: false,
    modality: "text",
    operation: "speech-to-text",
    responseId: "resp_elevenlabs_stt",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { url: "https://example.com/sample.wav" } }],
    }],
  }, {
    modelId: "scribe_v1",
    provider: "elevenlabs",
  });

  assert.equal(formModel, "scribe_v1");
  assert.equal(result.output.modality, "text");
  assert.equal(result.output.content, "Compose product terms were transcribed.");
});

test("generateWithTools routes ElevenLabs speech-to-speech through the family bridge", async () => {
  let formModel = "";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.com/source.wav") {
      return new Response(new Uint8Array(wav(1.25)), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    if (url === "https://api.elevenlabs.io/v1/speech-to-speech/voice_123?output_format=mp3_44100_128") {
      const form = init?.body as FormData;
      formModel = String(form.get("model_id"));
      return new Response(Buffer.from("converted-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateWithTools({
    mode: "responses",
    model: "eleven_english_sts_v2",
    stream: false,
    modality: "audio",
    operation: "speech-to-speech",
    responseId: "resp_elevenlabs_sts",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { url: "https://example.com/source.wav" } }],
    }],
    audioOptions: { voice: "voice_123", responseFormat: "mp3" },
  }, {
    modelId: "eleven_english_sts_v2",
    provider: "elevenlabs",
  });

  assert.equal(formModel, "eleven_english_sts_v2");
  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/mpeg");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "converted-audio");
  assert.equal(result.output.media?.duration, 1.25);
  assert.equal(result.output.media?.billingMetrics.second, 1.25);
  assert.equal(result.output.media?.billingMetrics.audio_second, 1.25);
});

test("generateWithTools carries request-derived TTS input text tokens for token-priced speech", async () => {
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, "https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "tts-1");
    assert.equal(body.input, "Compose smoke test.");
    return new Response(Buffer.from("mp3-audio"), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }) as FetchImpl;

  const request: Request = {
    mode: "responses",
    model: "tts-1",
    stream: false,
    modality: "audio",
    operation: "text-to-speech",
    responseId: "resp_openai_tts",
    messages: [
      {
        role: "user",
        content: "Compose smoke test.",
      },
    ],
    audioOptions: {
      voice: "alloy",
      responseFormat: "mp3",
    },
  };

  const result = await generateWithTools(request, {
    modelId: "tts-1",
    provider: "openai",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/mpeg");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "mp3-audio");
  assert.deepEqual(result.output.usage, {
    promptTokens: 5,
    completionTokens: 0,
    totalTokens: 5,
    billingMetrics: {
      input_text_tokens: 5,
    },
  });
  assert.deepEqual(result.output.media?.billingMetrics, {
    input_text_tokens: 5,
    character: Array.from("Compose smoke test.").length,
  });
});

test("generateWithTools preserves Gemini TTS usage metadata for settlement", async () => {
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=test-google")) {
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: Buffer.from("wav-audio").toString("base64"),
                    mimeType: "audio/wav",
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 21,
          candidatesTokenCount: 34,
          totalTokenCount: 55,
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 21 }],
          candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 34 }],
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "responses",
    model: "gemini-2.5-flash-preview-tts",
    stream: false,
    modality: "audio",
    operation: "text-to-speech",
    responseId: "resp_gemini_tts",
    messages: [
      {
        role: "user",
        content: "Narrate the deployment summary.",
      },
    ],
    audioOptions: {
      responseFormat: "wav",
    },
  };

  const result = await generateWithTools(request, {
    modelId: "gemini-2.5-flash-preview-tts",
    provider: "gemini",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/wav");
  assert.deepEqual(result.output.usage, {
    promptTokens: 21,
    completionTokens: 34,
    totalTokens: 55,
    billingMetrics: {
      input_text_tokens: 21,
      output_audio_tokens: 34,
    },
  });
  assert.deepEqual(result.output.media?.billingMetrics, {
    input_text_tokens: 21,
    output_audio_tokens: 34,
    character: Array.from("Narrate the deployment summary.").length,
  });
});

test("generateWithTools sends Gemini multimodal embeddings as inline content parts", async () => {
  const image = `data:image/png;base64,${png(16, 16).toString("base64")}`;
  const bodies: any[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        embedding: { values: [0.1, 0.2, 0.3] },
        usageMetadata: {
          promptTokenCount: 7,
          totalTokenCount: 7,
        },
      });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:countTokens")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        totalTokens: 7,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 3 },
          { modality: "IMAGE", tokenCount: 4 },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "responses",
    model: "gemini-embedding-2",
    stream: false,
    modality: "embedding",
    operation: "multimodal-embedding",
    responseId: "resp_gemini_embedding",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Embed this product label." },
          { type: "image_url", image_url: { url: image } },
        ],
      },
    ],
    embeddingInput: "Embed this product label.",
  };

  const result = await generateWithTools(request, {
    modelId: "gemini-embedding-2",
    provider: "gemini",
  });

  const [embedBody, countBody] = bodies;
  assert.equal(embedBody.model, "models/gemini-embedding-2");
  assert.deepEqual(embedBody.content.parts[0], { text: "Embed this product label." });
  assert.equal(embedBody.content.parts[1].inlineData.mimeType, "image/png");
  assert.equal(embedBody.content.parts[1].inlineData.data, png(16, 16).toString("base64"));
  assert.deepEqual(countBody.contents[0].parts, embedBody.content.parts);
  assert.deepEqual(result.output.embeddings, [[0.1, 0.2, 0.3]]);
  assert.equal(result.output.usage?.promptTokens, 7);
  assert.equal(result.output.usage?.completionTokens, 0);
  assert.equal(result.output.usage?.totalTokens, 7);
  assert.deepEqual(result.output.usage?.billingMetrics, {
    input_text_tokens: 3,
    input_image_tokens: 4,
  });
});

test("generateWithTools routes Lyria music generation through Gemini audio output", async () => {
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent")) {
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "Instrumental lo-fi cue." },
                {
                  inlineData: {
                    data: Buffer.from("wav-music").toString("base64"),
                    mimeType: "audio/wav",
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 0,
          totalTokenCount: 9,
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "responses",
    model: "lyria-3-clip-preview",
    stream: false,
    modality: "audio",
    operation: "text-to-audio",
    responseId: "resp_lyria_music",
    messages: [
      {
        role: "user",
        content: "A short warm lo-fi instrumental cue with soft electric piano.",
      },
    ],
  };

  const result = await generateWithTools(request, {
    modelId: "lyria-3-clip-preview",
    provider: "gemini",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/wav");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "wav-music");
  assert.deepEqual(result.output.usage, {
    promptTokens: 9,
    completionTokens: 0,
    totalTokens: 9,
  });
});

test("generateWithTools routes speech synthesis through Cartesia", async () => {
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.cartesia.ai/tts/bytes") {
      return new Response(Buffer.from("wav-audio"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: Request = {
    mode: "chat",
    model: "sonic-2",
    stream: false,
    modality: "audio",
    operation: "text-to-speech",
    responseId: "resp_cartesia",
    messages: [
      {
        role: "user",
        content: "Summarize the current project board.",
      },
    ],
    audioOptions: {
      responseFormat: "wav",
    },
  };

  const result = await generateWithTools(request, {
    modelId: "sonic-2",
    provider: "cartesia",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/wav");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "wav-audio");
});

test("normalizeUsage maps canonical input and output token fields", () => {
  const usage = normalizeUsage({
    inputTokens: 321,
    outputTokens: 89,
    totalTokens: 410,
    outputTokenDetails: {
      reasoningTokens: 13,
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 321,
    completionTokens: 89,
    totalTokens: 410,
    reasoningTokens: 13,
    billingMetrics: {
      reasoning_tokens: 13,
    },
  });
});

test("retrieveJob preserves OpenAI video IDs with colons and downloads completed content", async () => {
  process.env.OPENAI_API_KEY = "test-openai";
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://api.openai.com/v1/videos/video%3Aabc") {
      return Response.json({
        id: "video:abc",
        status: "completed",
        progress: 100,
      });
    }

    if (url === "https://api.openai.com/v1/videos/video%3Aabc/content") {
      return new Response(Buffer.from("mp4-video"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const status = await retrieveJob("openai:video:abc");

  assert.deepEqual(status, {
    status: "completed",
    url: `data:video/mp4;base64,${Buffer.from("mp4-video").toString("base64")}`,
    error: undefined,
    progress: 100,
  });
  assert.deepEqual(calls, [
    "https://api.openai.com/v1/videos/video%3Aabc",
    "https://api.openai.com/v1/videos/video%3Aabc/content",
  ]);
});

test("downloadGoogleFileDataUrl fetches Gemini video files with API key", async () => {
  let requestHeaders: HeadersInit | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://generativelanguage.googleapis.com/v1beta/files/video-file:download?alt=media") {
      requestHeaders = init?.headers;
      return new Response(Buffer.from("mp4-video"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const url = await downloadGoogleFileDataUrl(
    "https://generativelanguage.googleapis.com/v1beta/files/video-file:download?alt=media",
    "test-google",
  );

  assert.deepEqual(requestHeaders, { "x-goog-api-key": "test-google" });
  assert.equal(url, `data:video/mp4;base64,${Buffer.from("mp4-video").toString("base64")}`);
});

test("openaiGenerateImage omits deprecated response_format and downloads URL payloads", async () => {
  const calls: string[] = [];
  let requestBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === "https://api.openai.com/v1/images/generations") {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        data: [{ url: "https://images.example.com/generated.png" }],
      });
    }

    if (url === "https://images.example.com/generated.png") {
      return new Response(Buffer.from("png-image"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await openaiGenerateImage("dall-e-2", "A compose market terminal");

  assert.equal(requestBody.response_format, undefined);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.buffer.toString(), "png-image");
  assert.deepEqual(calls, [
    "https://api.openai.com/v1/images/generations",
    "https://images.example.com/generated.png",
  ]);
});

test("isOpenAIImageStreamingUnsupportedError detects DALL-E stream rejection payloads", () => {
  assert.equal(isOpenAIImageStreamingUnsupportedError(new Error(
    "OpenAI image streaming failed: 400 - { \"error\": { \"message\": \"Unknown parameter: 'stream'.\", \"type\": \"invalid_request_error\", \"param\": \"stream\", \"code\": \"unknown_parameter\" } }",
  )), true);
  assert.equal(isOpenAIImageStreamingUnsupportedError(new Error("OpenAI image streaming failed: 401 - unauthorized")), false);
});
