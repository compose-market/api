import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

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

test("Deepgram sync keeps premium models out of the public compiled catalog", () => {
  const core = read("providers/deepgram.json");
  const premium = read("providers/deepgram_premium.json");
  const compiled = read("models.json");

  const coreIds = ids(core);
  const premiumIds = ids(premium);
  const compiledIds = ids(compiled);
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
