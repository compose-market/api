import assert from "node:assert/strict";
import test from "node:test";

import { videoBillingMetricsFromOutput } from "../inference/adapters/modalities/video.js";
import { buildAuthoritativeBilling, buildRequestBilling } from "../inference/telemetry.js";

function box(type: string, payload: Buffer): Buffer {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, "ascii");
  payload.copy(value, 8);
  return value;
}

function track(type: "vide" | "soun", duration: number, samples: number, width = 0, height = 0): Buffer {
  const tkhd = Buffer.alloc(8);
  tkhd.writeUInt32BE(width * 65536, 0);
  tkhd.writeUInt32BE(height * 65536, 4);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(1000, 12);
  mdhd.writeUInt32BE(duration * 1000, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.write(type, 8, "ascii");
  const stsz = Buffer.alloc(12);
  stsz.writeUInt32BE(samples, 8);
  return box("trak", Buffer.concat([
    box("tkhd", tkhd),
    box("mdia", Buffer.concat([
      box("mdhd", mdhd),
      box("hdlr", hdlr),
      box("minf", box("stbl", box("stsz", stsz))),
    ])),
  ]));
}

function completedVideoMetrics(): Record<string, unknown> {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(9000, 16);
  const buffer = box("moov", Buffer.concat([
    box("mvhd", mvhd),
    track("soun", 9, 900),
    track("vide", 2, 48, 1280, 720),
  ]));

  return videoBillingMetricsFromOutput({
    request: {
      mode: "responses",
      model: "video-model",
      stream: false,
      modality: "video",
      messages: [],
      responseId: "video-response",
      billingMetrics: {
        duration: 9,
        second: 9,
        width: 1920,
        height: 1080,
        size: "1920x1080",
        resolution: "1080P",
        pixel: 1920 * 1080,
      },
    },
    buffer,
    generatedUnits: 1,
  });
}

test("completed video bytes override requested duration and dimensions", () => {
  const metrics = completedVideoMetrics();
  assert.equal(metrics.duration, 2);
  assert.equal(metrics.second, 2);
  assert.equal(metrics.width, 1280);
  assert.equal(metrics.height, 720);
  assert.equal(metrics.size, "1280x720");
  assert.equal(metrics.resolution, "720P");
  assert.equal(metrics.pixel, 1280 * 720);
});

test("MP4 frame evidence counts video samples and excludes audio samples", () => {
  assert.equal(completedVideoMetrics().frame, 48);
});

test("per-frame billing uses actual frame count and never falls back to seconds", () => {
  const billed = buildAuthoritativeBilling({
    subject: "video:test",
    modality: "video",
    pricing: { unit: "usd_per_frame", values: { frame: 0.01 } },
    media: { billingMetrics: completedVideoMetrics() },
  });
  assert.deepEqual(billed.lineItems, [{
    key: "frame",
    unit: "usd_per_frame",
    quantity: 48,
    unitPriceUsd: 0.01,
    source: "provider_response",
  }]);

  assert.throws(() => buildAuthoritativeBilling({
    subject: "video:test",
    modality: "video",
    pricing: { unit: "usd_per_frame", values: { frame: 0.01 } },
    media: { generatedSeconds: 2, billingMetrics: { second: 2, duration: 2 } },
  }), /frame/);
});

test("video selectors normalize resolution size aliases and booleans without hiding ambiguity", () => {
  const pricing = {
    sections: [
      { unitKey: "usd_per_video", entries: { generation: 1 }, selector: { resolution: "720P", audio: true } },
      { unitKey: "usd_per_video", entries: { generation: 2 }, selector: { resolution: "1080P", audio: true } },
    ],
  };
  const billed = buildRequestBilling({
    subject: "video:test",
    modality: "video",
    pricing,
    metrics: { video: 1, size: "1280X720", audio: "TRUE" },
  });
  assert.equal(billed.lineItems[0]?.unitPriceUsd, 1);

  assert.throws(() => buildRequestBilling({
    subject: "video:test",
    modality: "video",
    pricing: {
      sections: [
        { unitKey: "usd_per_video", entries: { generation: 1 }, selector: { resolution: "720P" } },
        { unitKey: "usd_per_video", entries: { generation: 2 }, selector: { size: "1280x720" } },
      ],
    },
    metrics: { video: 1, resolution: "720p", size: "1280x720" },
  }), /ambiguous/);
});
