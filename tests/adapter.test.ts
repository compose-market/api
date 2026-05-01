import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";

import type { UnifiedRequest } from "../inference/core.js";
import { standardizePrompt } from "ai/internal";
import { isOpenAIImageStreamingUnsupportedError } from "../inference/providers/openai.js";

type FetchImpl = typeof fetch;

let invokeAdapter: (request: UnifiedRequest, target: { modelId: string; provider: any }) => Promise<{ output: any }>;
let mapMessagesForAISDK: (messages: UnifiedRequest["messages"]) => Array<{ role: string; content: unknown }>;
let retrieveAdapter: (jobId: string) => Promise<{ status: string; url?: string; error?: string; progress?: number }>;
let normalizeLanguageModelUsage: (usage: {
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

  originalFetch = globalThis.fetch;
  ({ invokeAdapter, mapMessagesForAISDK, retrieveAdapter, normalizeLanguageModelUsage } = await import("../inference/providers/adapter.js"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("invokeAdapter routes image understanding through Roboflow for text requests", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
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

  const request: UnifiedRequest = {
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

  const result = await invokeAdapter(request, {
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

test("invokeAdapter routes speech recognition through Deepgram", async () => {
  globalThis.fetch = (async (input) => {
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

  const request: UnifiedRequest = {
    mode: "chat",
    model: "deepgram/nova-3",
    stream: false,
    modality: "audio",
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

  const result = await invokeAdapter(request, {
    modelId: "deepgram/nova-3",
    provider: "deepgram",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.content, "schedule a coding session for tomorrow morning");
});

test("invokeAdapter routes speech synthesis through ElevenLabs", async () => {
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.elevenlabs.io/v1/text-to-speech/voice_123") {
      return new Response(Buffer.from("mp3-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const request: UnifiedRequest = {
    mode: "chat",
    model: "eleven_multilingual_v2",
    stream: false,
    modality: "audio",
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

  const result = await invokeAdapter(request, {
    modelId: "eleven_multilingual_v2",
    provider: "elevenlabs",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/mpeg");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "mp3-audio");
  assert.deepEqual(result.output.media?.billingMetrics, {
    character: Array.from("Draft a launch update for the new workspace session.").length,
  });
});

test("invokeAdapter preserves Gemini TTS usage metadata for settlement", async () => {
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

  const request: UnifiedRequest = {
    mode: "responses",
    model: "gemini-2.5-flash-preview-tts",
    provider: "gemini",
    stream: false,
    modality: "audio",
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

  const result = await invokeAdapter(request, {
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

test("invokeAdapter routes speech synthesis through Cartesia", async () => {
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

  const request: UnifiedRequest = {
    mode: "chat",
    model: "sonic-2",
    stream: false,
    modality: "audio",
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

  const result = await invokeAdapter(request, {
    modelId: "sonic-2",
    provider: "cartesia",
  });

  assert.equal(result.output.modality, "audio");
  assert.equal(result.output.media?.mimeType, "audio/wav");
  assert.equal(Buffer.from(result.output.media?.base64 || "", "base64").toString(), "wav-audio");
});

test("normalizeLanguageModelUsage maps AI SDK v6 input and output token fields", () => {
  const usage = normalizeLanguageModelUsage({
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

test("retrieveAdapter preserves OpenAI video IDs with colons and downloads completed content", async () => {
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

  const status = await retrieveAdapter("openai:video:abc");

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

test("isOpenAIImageStreamingUnsupportedError detects DALL-E stream rejection payloads", () => {
  assert.equal(isOpenAIImageStreamingUnsupportedError(new Error(
    "OpenAI image streaming failed: 400 - { \"error\": { \"message\": \"Unknown parameter: 'stream'.\", \"type\": \"invalid_request_error\", \"param\": \"stream\", \"code\": \"unknown_parameter\" } }",
  )), true);
  assert.equal(isOpenAIImageStreamingUnsupportedError(new Error("OpenAI image streaming failed: 401 - unauthorized")), false);
});

test("mapMessagesForAISDK emits tool-call and tool-result parts that satisfy the AI SDK prompt schema", async () => {
  const messages = mapMessagesForAISDK([
    {
      role: "user",
      content: "Search the web for chess candidates predictions.",
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "perplexity_research",
            arguments: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: "Search the web for chess candidates predictions.",
                },
              ],
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_123",
      name: "perplexity_research",
      content: "Top prediction markets favor Carlsen.",
    },
  ]);

  const standardized = await standardizePrompt({ messages: messages as any });
  assert.equal(standardized.messages.length, 3);
});
