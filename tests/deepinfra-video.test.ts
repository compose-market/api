import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";

type GenerateVideo = typeof import("../inference/catalog/vendors/deepinfra.js").generateDeepInfraVideo;
type FetchImpl = typeof fetch;

let generateDeepInfraVideo: GenerateVideo;
let originalFetch: FetchImpl;

before(async () => {
  process.env.DEEPINFRA_API_KEY = "test-deepinfra";
  originalFetch = globalThis.fetch;
  ({ generateDeepInfraVideo } = await import("../inference/catalog/vendors/deepinfra.js"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function video(value: string): string {
  return `data:video/mp4;base64,${Buffer.from(value).toString("base64")}`;
}

function mockDeepInfra(
  wireModelId: string,
  schema: Record<string, unknown>,
  responses: unknown[],
): { bodies: Array<Record<string, unknown>>; schemaCalls: () => number } {
  const bodies: Array<Record<string, unknown>> = [];
  let schemaCallCount = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `https://api.deepinfra.com/models/${encodeURIComponent(wireModelId)}/schema/default`) {
      schemaCallCount += 1;
      return Response.json(schema);
    }
    if (url === `https://api.deepinfra.com/v1/inference/${wireModelId}`) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(responses[Math.min(bodies.length - 1, responses.length - 1)]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;
  return { bodies, schemaCalls: () => schemaCallCount };
}

test("DeepInfra Bria video uses catalog identity and filters unsupported fields", async () => {
  const mock = mockDeepInfra("Bria/video_mask_by_prompt", {
    schema_in: {
      required: ["video", "prompt"],
      properties: {
        video: { type: "string" },
        prompt: { type: "string" },
        auto_trim: { type: "boolean" },
      },
    },
  }, [{ video_url: video("bria") }]);

  const result = await generateDeepInfraVideo("ignored-wire-id", "Mask the bicycle.", {
    catalogModelId: "video_mask_by_prompt",
    operation: "video-edit",
    videoUrl: "https://cdn.example.com/input.mp4",
    customParams: { auto_trim: true, unsupported: "drop" },
  });

  assert.deepEqual(mock.bodies[0], {
    prompt: "Mask the bicycle.",
    video: "https://cdn.example.com/input.mp4",
    auto_trim: true,
  });
  assert.equal(result.buffer.toString(), "bria");
});

test("DeepInfra Seedance maps multiple image, video, and audio references", async () => {
  const mock = mockDeepInfra("ByteDance/Seedance-2.0", {
    schema_in: {
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        first_frame_image: { type: "string" },
        last_frame_image: { type: "string" },
        reference_images: { type: "array" },
        reference_videos: { type: "array" },
        reference_audios: { type: "array" },
      },
    },
  }, [{ output: video("seedance") }]);

  await generateDeepInfraVideo("ByteDance/Seedance-2.0", "Keep the character consistent.", {
    catalogModelId: "Seedance-2.0",
    operation: "reference-to-video",
    imageUrls: ["image-1", "image-2"],
    videoUrls: ["video-1", "video-2"],
    audioUrls: ["audio-1"],
  });

  assert.deepEqual(mock.bodies[0], {
    prompt: "Keep the character consistent.",
    reference_images: ["image-1", "image-2"],
    reference_videos: ["video-1", "video-2"],
    reference_audios: ["audio-1"],
  });
});

test("DeepInfra FastWan fills required live-schema defaults and caches the schema", async () => {
  const mock = mockDeepInfra("FastVideo/FastWan-QAD-FP8-1.3B", {
    schema_in: {
      required: ["prompt", "seconds", "resolution", "orientation"],
      properties: {
        prompt: { type: "string" },
        seconds: { type: "integer", default: 5 },
        resolution: { type: "string", default: "480p" },
        orientation: { type: "string", default: "landscape" },
      },
    },
  }, [{ output: video("fastwan-1") }, { output: video("fastwan-2") }]);

  await generateDeepInfraVideo("FastVideo/FastWan-QAD-FP8-1.3B", "A fast pan.", {
    catalogModelId: "FastWan-QAD-FP8-1.3B",
  });
  await generateDeepInfraVideo("FastVideo/FastWan-QAD-FP8-1.3B", "A slow tilt.", {
    catalogModelId: "FastWan-QAD-FP8-1.3B",
  });

  assert.equal(mock.schemaCalls(), 1);
  assert.deepEqual(mock.bodies[0], {
    prompt: "A fast pan.",
    seconds: 5,
    resolution: "480p",
    orientation: "landscape",
  });
});

test("DeepInfra Veo extracts the first entry from a videos array", async () => {
  const mock = mockDeepInfra("google/veo-3.1", {
    schema_in: {
      required: ["prompt"],
      properties: { prompt: { type: "string" }, image: { type: "string" } },
    },
  }, [{ videos: [{ video_url: video("veo") }] }]);

  const result = await generateDeepInfraVideo("google/veo-3.1", "A cinematic coast.", {
    catalogModelId: "veo-3.1",
    operation: "image-to-video",
    imageUrl: "image-data",
  });

  assert.equal(mock.bodies[0].image, "image-data");
  assert.equal(result.buffer.toString(), "veo");
  assert.equal(result.url, undefined);
});

test("DeepInfra Wan I2V maps image and audio locators", async () => {
  const mock = mockDeepInfra("Wan-AI/Wan2.6-I2V", {
    schema_in: {
      required: ["img_url"],
      properties: {
        prompt: { type: "string" },
        img_url: { type: "string" },
        audio_url: { type: "string" },
      },
    },
  }, [{ video: video("wan-i2v") }]);

  const result = await generateDeepInfraVideo("Wan-AI/Wan2.6-I2V", "Animate this frame.", {
    catalogModelId: "Wan2.6-I2V",
    operation: "image-to-video",
    imageUrl: "image-data",
    audioUrl: "https://cdn.example.com/audio.mp3",
  });

  assert.equal(mock.bodies[0].img_url, "image-data");
  assert.equal(mock.bodies[0].audio_url, "https://cdn.example.com/audio.mp3");
  assert.equal(result.buffer.toString(), "wan-i2v");
});

test("DeepInfra Wan R2V builds typed media references", async () => {
  const mock = mockDeepInfra("Wan-AI/Wan2.7-R2V", {
    schema_in: {
      required: ["prompt", "media"],
      properties: { prompt: { type: "string" }, media: { type: "array" } },
    },
  }, [{ output: video("wan-r2v") }]);

  await generateDeepInfraVideo("Wan-AI/Wan2.7-R2V", "Video 1 enters Image 1.", {
    catalogModelId: "Wan2.7-R2V",
    operation: "reference-to-video",
    imageUrls: ["image-1"],
    videoUrls: ["video-1"],
    audioUrls: ["voice-1", "voice-2"],
  });

  assert.deepEqual(mock.bodies[0].media, [
    { type: "reference_image", url: "image-1", reference_voice: "voice-1" },
    { type: "reference_video", url: "video-1", reference_voice: "voice-2" },
  ]);
});

test("DeepInfra video reports inference_status token usage and cost", async () => {
  mockDeepInfra("Pixverse/Pixverse-6-T2V", {
    schema_in: {
      required: ["prompt"],
      properties: { prompt: { type: "string" } },
    },
  }, [{
    output: video("usage"),
    inference_status: { tokens_input: 12, out_tokens: 34, cost: 0.56 },
  }]);

  const result = await generateDeepInfraVideo("Pixverse/Pixverse-6-T2V", "A tracking shot.", {
    catalogModelId: "Pixverse-6-T2V",
  });

  assert.deepEqual({
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    cost: result.usage?.billingMetrics?.cost,
    outTokens: result.usage?.billingMetrics?.out_tokens,
  }, { promptTokens: 12, completionTokens: 34, totalTokens: 46, cost: 0.56, outTokens: 34 });
});

test("DeepInfra video exposes structured nonretryable 4xx errors", async () => {
  const wireModelId = "PrunaAI/p-video";
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/models/PrunaAI%2Fp-video/schema/default")) {
      return Response.json({ schema_in: { required: ["prompt"], properties: { prompt: { type: "string" } } } });
    }
    if (url === `https://api.deepinfra.com/v1/inference/${wireModelId}`) {
      return new Response('{"error":"invalid prompt"}', { status: 422, statusText: "Unprocessable Entity" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  await assert.rejects(
    generateDeepInfraVideo(wireModelId, "bad", { catalogModelId: "p-video" }),
    (error: unknown) => {
      const value = error as { statusCode?: number; responseBody?: string };
      assert.equal(value.statusCode, 422);
      assert.match(value.responseBody || "", /invalid prompt/);
      return true;
    },
  );
});

test("DeepInfra video uploads binary fields as multipart and resolves relative output URLs", async () => {
  const wireModelId = "Pixverse/Pixverse-6-I2V";
  let inferenceBody: FormData | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/models/Pixverse%2FPixverse-6-I2V/schema/default")) {
      return Response.json({
        schema_in: {
          required: ["prompt", "image"],
          properties: { prompt: { type: "string" }, image: { type: "string", format: "binary" } },
        },
      });
    }
    if (url === "https://cdn.example.com/source.png") {
      return new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } });
    }
    if (url === `https://api.deepinfra.com/v1/inference/${wireModelId}`) {
      assert.ok(init?.body instanceof FormData);
      inferenceBody = init.body;
      return Response.json({ video_url: "/model/inference/output.mp4" });
    }
    if (url === "https://api.deepinfra.com/model/inference/output.mp4") {
      return new Response(Buffer.from("video"), { headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as FetchImpl;

  const result = await generateDeepInfraVideo(wireModelId, "Animate the portrait.", {
    catalogModelId: "Pixverse-6-I2V",
    operation: "image-to-video",
    imageUrl: "https://cdn.example.com/source.png",
  });

  assert.equal(inferenceBody?.get("prompt"), "Animate the portrait.");
  assert.ok(inferenceBody?.get("image") instanceof Blob);
  assert.equal(result.url, "https://api.deepinfra.com/model/inference/output.mp4");
  assert.equal(result.buffer.toString(), "video");
});
