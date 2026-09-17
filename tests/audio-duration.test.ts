import assert from "node:assert/strict";
import test from "node:test";

import { audioDurationSeconds } from "../inference/catalog/modalities/audio.js";

function wav(seconds: number, sampleRate = 16_000): Buffer {
  const byteRate = sampleRate * 2; // mono, 16-bit
  const dataSize = Math.max(1, Math.round(seconds * byteRate));
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test("audioDurationSeconds estimates MPEG1 Layer III CBR duration from byte size and bitrate", () => {
  // MPEG1 Layer III, 128 kbps, 44100 Hz — 16000 bytes → exactly 1 second.
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(15996)]);
  assert.equal(audioDurationSeconds(buffer, "audio/mpeg"), 1);
  // Bare buffer without a MIME hint still parses via the frame sync.
  assert.equal(audioDurationSeconds(buffer), 1);
});

test("audioDurationSeconds estimates MPEG2 Layer III CBR duration", () => {
  // MPEG2 Layer III, 64 kbps, 22050 Hz — 8000 bytes → exactly 1 second.
  const buffer = Buffer.concat([Buffer.from([0xff, 0xf3, 0x80, 0x00]), Buffer.alloc(7996)]);
  assert.equal(audioDurationSeconds(buffer, "audio/mpeg"), 1);
});

test("audioDurationSeconds skips ID3v2 tags before the first frame", () => {
  const id3 = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([0x04, 0x00, 0x00]), // v2.4, no flags
    Buffer.from([0x00, 0x00, 0x00, 0x0a]), // syncsafe size = 10
    Buffer.alloc(10),
  ]);
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(15996)]);
  assert.equal(audioDurationSeconds(Buffer.concat([id3, frame]), "audio/mpeg"), 1);
});

test("audioDurationSeconds uses the Xing frame count for exact VBR duration", () => {
  const xing = Buffer.concat([
    Buffer.from("Xing", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // frames flag
    Buffer.from([0x00, 0x00, 0x00, 0xc8]), // 200 frames
  ]);
  const buffer = Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    Buffer.alloc(32), // side info
    xing,
  ]);
  assert.equal(audioDurationSeconds(buffer, "audio/mpeg"), (200 * 1152) / 44100);
});

test("audioDurationSeconds rejects non-Layer-III and unsynchronized buffers", () => {
  // Layer II sync (layer bits 10) — the parser is Layer III only.
  const layer2 = Buffer.concat([Buffer.from([0xff, 0xfd, 0x90, 0x00]), Buffer.alloc(4092)]);
  assert.equal(audioDurationSeconds(layer2, "audio/mpeg"), undefined);
  // No frame sync anywhere.
  assert.equal(audioDurationSeconds(Buffer.from("not an audio file at all"), "audio/mpeg"), undefined);
  assert.equal(audioDurationSeconds(Buffer.alloc(0), "audio/mpeg"), undefined);
});

test("audioDurationSeconds still parses WAV and ignores other formats", () => {
  assert.equal(audioDurationSeconds(wav(2), "audio/wav"), 2);
  assert.equal(audioDurationSeconds(wav(2)), 2);
  assert.equal(audioDurationSeconds(Buffer.from("plain text"), "text/plain"), undefined);
});
