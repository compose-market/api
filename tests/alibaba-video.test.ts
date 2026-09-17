import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildWanVideoSubmission, parseAsyncJobStatus } from "../inference/catalog/families/alibaba.js";
import { retrieveAlibabaVideo } from "../inference/catalog/vendors/alibaba.js";

const originalFetch = globalThis.fetch;
process.env.ALIBABA_CLOUD_API_KEY = "test-alibaba";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function body(modelId: string, options: Parameters<typeof buildWanVideoSubmission>[2] = {}): any {
  return buildWanVideoSubmission(modelId, "Make a cinematic clip.", options).body;
}

test("Alibaba video bodies are shaped only by authoritative request contracts", () => {
  const animate = body("catalog-model", {
    operation: "video-edit",
    imageUrl: "https://cdn.test/character.png",
    videoUrl: "https://cdn.test/performance.mp4",
    duration: 12,
    resolution: "1080P",
    customParams: { mode: "wan-std" },
    requestContract: {
      path: "/api/v1/services/aigc/image2video/video-synthesis",
      inputFields: ["image_url", "video_url", "watermark"],
      parameterFields: ["mode", "check_image"],
      mediaTypes: [],
    },
  });
  assert.equal(animate.input.image_url, "https://cdn.test/character.png");
  assert.equal(animate.input.video_url, "https://cdn.test/performance.mp4");
  assert.equal(animate.parameters.mode, "wan-std");
  assert.equal(animate.parameters.duration, undefined);
  assert.equal(animate.parameters.resolution, undefined);

  const legacyReference = body("catalog-model", {
    operation: "video-edit",
    imageUrl: "https://cdn.test/subject.png",
    videoUrl: "https://cdn.test/subject.mp4",
    size: "1280x720",
    duration: 5,
    customParams: { audio: false },
    requestContract: {
      path: "/api/v1/services/aigc/video-generation/video-synthesis",
      inputFields: ["prompt", "reference_urls"],
      parameterFields: ["size", "duration", "audio"],
      mediaTypes: [],
    },
  });
  assert.deepEqual(legacyReference.input.reference_urls, [
    "https://cdn.test/subject.mp4",
    "https://cdn.test/subject.png",
  ]);
  assert.deepEqual(legacyReference.parameters, { audio: false, duration: 5, size: "1280*720" });

  const referenceMedia = body("catalog-model", {
    operation: "video-edit",
    imageUrl: "https://cdn.test/reference.png",
    videoUrl: "https://cdn.test/reference.mp4",
    requestContract: {
      path: "/api/v1/services/aigc/video-generation/video-synthesis",
      inputFields: ["prompt", "media"],
      parameterFields: ["resolution", "ratio", "duration"],
      mediaTypes: ["reference_image", "reference_video", "first_frame"],
    },
  });
  assert.deepEqual(referenceMedia.input.media, [
    { type: "reference_video", url: "https://cdn.test/reference.mp4" },
    { type: "reference_image", url: "https://cdn.test/reference.png" },
  ]);

  const referenceOperation = body("catalog-model", {
    operation: "reference-to-video",
    imageUrl: "https://cdn.test/reference.png",
    videoUrl: "https://cdn.test/reference.mp4",
    requestContract: {
      path: "/api/v1/services/aigc/video-generation/video-synthesis",
      inputFields: ["prompt", "media"],
      parameterFields: [],
      mediaTypes: ["reference_image", "reference_video"],
    },
  });
  assert.deepEqual(referenceOperation.input.media, [
    { type: "reference_video", url: "https://cdn.test/reference.mp4" },
    { type: "reference_image", url: "https://cdn.test/reference.png" },
  ]);
});

test("Alibaba video models without request contracts fail before provider work", () => {
  assert.throws(() => body("incomplete-model"), /no authoritative request contract/i);
});

test("Alibaba video polling uses the submitted origin and exposes authoritative usage", async () => {
  const apiBase = "https://dashscope-us.aliyuncs.com/api/v1";
  const providerJobId = `${Buffer.from(apiBase).toString("base64url")}:task-us`;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Response.json({
      output: { task_status: "SUCCEEDED", video_url: "https://cdn.test/output.mp4" },
      usage: {
        duration: 13.24,
        input_video_duration: 6.62,
        output_video_duration: 6.62,
        SR: 720,
        size: "1280*720",
        ratio: "16:9",
        video_count: 1,
      },
    });
  }) as typeof fetch;

  const result = await retrieveAlibabaVideo(providerJobId);
  assert.equal(requestedUrl, `${apiBase}/tasks/task-us`);
  assert.equal(result.status, "completed");
  assert.equal(result.duration, 13.24);
  assert.deepEqual(result.usage?.billingMetrics, {
    duration: 13.24,
    second: 13.24,
    video_second: 13.24,
    SR: 720,
    resolution: "720P",
    size: "1280*720",
    ratio: "16:9",
    video_count: 1,
    video: 1,
  });
  assert.deepEqual(result.usage?.raw, (result.raw as any).usage);
});

test("UNKNOWN video tasks fail instead of polling forever", async () => {
  globalThis.fetch = (async () => Response.json({ output: { task_status: "UNKNOWN" } })) as typeof fetch;
  const result = await retrieveAlibabaVideo("expired-task");
  assert.equal(result.status, "failed");
  assert.match(result.error || "", /unknown or expired/i);
  assert.equal(parseAsyncJobStatus({ output: { task_status: "UNKNOWN" } }).status, "failed");
});

test("Alibaba video polling extracts completion URLs from result arrays", async () => {
  globalThis.fetch = (async () => Response.json({
    output: {
      task_status: "SUCCEEDED",
      results: [{ video_url: "https://cdn.test/result.mp4" }],
    },
  })) as typeof fetch;

  const result = await retrieveAlibabaVideo("task-results");
  assert.equal(result.status, "completed");
  assert.equal(result.url, "https://cdn.test/result.mp4");
});
