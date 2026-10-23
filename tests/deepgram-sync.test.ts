import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  groupApiModels,
  parseAsyncApiFluxSpec,
  parseDeepgramPricing,
  parseModelsLanguagesDocs,
  parseOpenApiRestSpec,
  parseTtsModelsDocs,
  resolveSttPricing,
} from "../inference/scripts/sync-deepgram.js";

const ROOT = path.join(import.meta.dirname, "..", "inference", "data");

interface Catalog {
  source?: Record<string, unknown>;
  models: Array<{ modelId: string; provider?: string }>;
}

function read(file: string): Catalog {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")) as Catalog;
}

function ids(catalog: Catalog): string[] {
  return catalog.models
    .filter((model) => model.provider === "deepgram" || model.modelId.startsWith("deepgram/"))
    .map((model) => model.modelId)
    .sort();
}

function providerIds(catalog: Catalog): string[] {
  return catalog.models
    .filter((model) => model.provider === "deepgram")
    .map((model) => model.modelId)
    .sort();
}

test("Deepgram sync keeps premium models out of the public compiled catalog", () => {
  const core = read("providers/deepgram.json");
  const premium = read("providers/deepgram_premium.json");
  const compiled = read("models.json");

  const coreIds = ids(core);
  const premiumIds = ids(premium);
  // Deepgram-provider rows in the compiled catalog. Family aliases from other
  // providers (e.g. `deepgram/flux` on cloudflare) share the family namespace
  // legitimately and are not part of this provider-row check.
  const compiledIds = providerIds(compiled);
  const sourceCoreIds = Array.isArray(core.source?.coreModelIds)
    ? [...core.source.coreModelIds].filter((value): value is string => typeof value === "string").sort()
    : [];

  assert.ok(coreIds.length > 0, "core catalog must not be empty");
  assert.ok(premiumIds.length > 0, "premium catalog must not be empty");
  assert.deepEqual(coreIds, sourceCoreIds, "core catalog must equal source-derived core ids");
  assert.deepEqual(compiledIds, coreIds, "compiled models.json must include only core Deepgram ids");
  assert.equal(coreIds.filter((modelId) => premiumIds.includes(modelId)).length, 0, "core/premium catalogs must not overlap");
  assert.equal(compiledIds.filter((modelId) => premiumIds.includes(modelId)).length, 0, "premium ids must not leak into models.json");
});

test("parseOpenApiRestSpec resolves $ref parameters, union enums, numeric bounds, and JSON request bodies", () => {
  const spec = {
    openapi: "3.1.0",
    servers: [{ url: "https://api.deepgram.com/" }],
    paths: {
      "/v1/speak": {
        post: {
          parameters: [
            { $ref: "#/components/parameters/EncodingParam" },
            { $ref: "#/components/parameters/SampleRateParam" },
            {
              name: "speed",
              in: "query",
              schema: { type: "number", minimum: 0.7, maximum: 1.5, default: 1 },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SpeakBody" },
              },
            },
          },
        },
      },
    },
    components: {
      parameters: {
        EncodingParam: {
          name: "encoding",
          in: "query",
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/EncLinear16" },
              { $ref: "#/components/schemas/EncMp3" },
            ],
          },
        },
        SampleRateParam: {
          name: "sample_rate",
          in: "query",
          schema: {
            oneOf: [
              { type: "string", enum: ["8000", "16000"] },
              { type: "string", enum: ["24000"] },
            ],
          },
        },
      },
      schemas: {
        EncLinear16: { type: "string", enum: ["linear16"] },
        EncMp3: { type: "string", enum: ["mp3"] },
        SpeakBody: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
    },
  };

  const parsed = parseOpenApiRestSpec(spec, "/v1/speak");
  assert.equal(parsed.endpoint, "https://api.deepgram.com/v1/speak");
  assert.equal(parsed.method, "POST");
  assert.deepEqual(parsed.query.encoding, ["linear16", "mp3"]);
  assert.deepEqual(parsed.query.sample_rate, [8000, 16000, 24000]);
  assert.deepEqual(parsed.query.speed, { min: 0.7, max: 1.5, default: 1 });
  assert.deepEqual(parsed.request, { text: "string" });
});
