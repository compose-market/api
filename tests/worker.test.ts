import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { clean } from "../inference/catalog/worker/clean.js";
import { rank } from "../inference/catalog/worker/embed.js";
import worker from "../inference/catalog/worker/main.js";
import { test as sql } from "../inference/catalog/worker/sql.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("clean keeps exact catalog fields and prefers richer duplicates", async () => {
  const out = await clean({
    lastUpdated: "2026-05-13T00:00:00.000Z",
    models: [{
      provider: "openai",
      modelId: "gpt-test",
      input: ["text"],
      output: ["text"],
      type: ["chat"],
    }, {
      provider: "openai",
      modelId: "gpt-test",
      name: "GPT Test",
      description: "Tool-capable chat model",
      input: ["text"],
      output: ["text"],
      type: ["chat"],
      capabilities: { tool_usage: true, streaming: true },
      contextWindow: { inputTokens: 128000 },
      pricing: { input: "1" },
    }],
  }, "batch");

  assert.equal(out.count, 1);
  const [item] = out.models;
  assert.equal(item.modelId, "gpt-test");
  assert.equal(item.name, "GPT Test");
  assert.deepEqual(JSON.parse(item.input), ["text"]);
  assert.deepEqual(JSON.parse(item.output), ["text"]);
  assert.deepEqual(JSON.parse(item.operations), ["chat"]);
  assert.equal(item.contextTokens, 128000);
  assert.match(item.text, /capabilities:/);
});

test("clean carries semantic routing data into rows and embedding text", async () => {
  const out = await clean({
    lastUpdated: "2026-05-25T00:00:00.000Z",
    models: [{
      provider: "elevenlabs",
      family: "ElevenLabs",
      modelId: "music-test",
      name: "Music Test",
      description: "Prompted music generation model",
      input: ["text"],
      output: ["audio"],
      type: ["text generation"],
      capabilities: { audio_generation: true },
      semantics: {
        family: "elevenlabs",
        modalities: ["audio"],
        operations: ["text-to-audio"],
        inputs: ["text"],
        outputs: ["audio"],
        sourceTypes: ["music-generation"],
        parameterKeys: ["prompt", "duration_seconds"],
        characteristics: [
          "operation:text-to-audio",
          "modality:audio",
          "source:music-generation",
        ],
        operationCapabilities: [{
          modality: "audio",
          operation: "text-to-audio",
          input: ["text"],
          output: ["audio"],
          sourceTypes: ["music-generation"],
          streamable: false,
          pricingUnits: [],
        }],
      },
    }],
  }, "batch");

  assert.equal(out.count, 1);
  const [item] = out.models;
  assert.deepEqual(JSON.parse(item.modality), ["audio"]);
  assert.deepEqual(JSON.parse(item.operations), ["text-to-audio"]);
  assert.equal(item.family, "elevenlabs");
  assert.deepEqual(JSON.parse(item.semantics).sourceTypes, ["music-generation"]);
  assert.match(item.text, /family: elevenlabs/);
  assert.match(item.text, /semantic operations: text-to-audio/);
  assert.match(item.text, /semantic outputs: audio/);
  assert.match(item.text, /parameters: prompt, duration_seconds/);
  assert.match(item.text, /characteristics: operation:text-to-audio; modality:audio; source:music-generation/);
});

test("rank calls Voyage rerank and returns scored ids", async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://ai.mongodb.com/v1/rerank");
    assert.deepEqual(init?.headers, {
      accept: "application/json",
      authorization: "Bearer mongo-key",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init?.body || "{}"));
    assert.equal(body.model, "rerank-2.5");
    assert.equal(body.query, "video editing");
    assert.deepEqual(body.documents, ["video model", "text model"]);
    assert.equal(body.top_k, 2);
    return new Response(JSON.stringify({
      data: [
        { index: 0, relevance_score: 0.91 },
        { index: 1, relevance_score: 0.12 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const rows = await rank({
    MONGO_DB_API_KEY: "mongo-key",
    EMBEDDING_API_BASE: "https://ai.mongodb.com/v1",
  } as never, "video editing", [
    { id: "video", text: "video model", score: 0.4 },
    { id: "text", text: "text model", score: 0.8 },
  ], 2);

  assert.deepEqual(rows, [
    { id: "video", score: 0.91 },
    { id: "text", score: 0.12 },
  ]);
});

test("model worker schema carries first-class family", () => {
  const text = sql.schema.join("\n");
  assert.match(text, /family\s+TEXT NOT NULL DEFAULT ''/);
  assert.match(text, /idx_models_family/);
});

test("model worker rebind ranks nearest OpenAI GPT minor before suffix preservation", async () => {
  const response = await worker.fetch(new Request("https://models.compose.market/rebind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.2-pro" }),
  }), env([
    modelRow("gpt-5.2-pro", {
      provider: "openai",
      family: "OpenAI",
      active: 0,
      metadata: {
        params: {
          input: { type: "string", required: false },
        },
      },
      semantics: {},
    }),
    modelRow("gpt-5.5-pro", {
      provider: "openai",
      family: "OpenAI",
      metadata: {
        sourceMetadata: {
          api: "https://api.openai.com/v1/models",
          modelPage: "https://platform.openai.com/docs/models/gpt-5.5-pro",
        },
      },
    }),
    modelRow("gpt-5.3-pro", {
      provider: "azure",
      family: "OpenAI",
    }),
    modelRow("gpt-5.3", {
      provider: "azure",
      family: "OpenAI",
    }),
  ]) as never);

  assert.equal(response.status, 200);
  const body = await response.json() as { selected?: { modelId?: string; routeScore?: number[] }; candidates?: Array<{ modelId?: string; routeScore?: number[] }> };
  assert.equal(body.selected?.modelId, "gpt-5.3");
  assert.deepEqual(body.selected?.routeScore?.slice(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(body.candidates?.map((item) => item.modelId).slice(0, 3), [
    "gpt-5.3",
    "gpt-5.3-pro",
    "gpt-5.5-pro",
  ]);
});

test("model worker rebind reads direct row family instead of metadata or name guesses", async () => {
  const response = await worker.fetch(new Request("https://models.compose.market/rebind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.2-pro" }),
  }), env([
    modelRow("gpt-5.2-pro", {
      family: "openai",
      active: 0,
      metadata: {
        sourceMetadata: {
          family: "google",
          modelPage: "https://ai.google.dev/gemini-api/docs/models/gpt-5.2-pro",
        },
      },
      name: "Google GPT 5.2 Pro",
    }),
    modelRow("gpt-5.3", {
      family: "openai",
      metadata: {
        sourceMetadata: {
          family: "google",
        },
      },
      name: "Google GPT 5.3",
    }),
    modelRow("gpt-5.3-pro", {
      family: "google",
      metadata: {
        sourceMetadata: {
          family: "openai",
        },
      },
      name: "OpenAI GPT 5.3 Pro",
    }),
  ]) as never);

  assert.equal(response.status, 200);
  const body = await response.json() as { selected?: { modelId?: string; family?: string; routeScore?: number[] } };
  assert.equal(body.selected?.modelId, "gpt-5.3");
  assert.equal(body.selected?.family, "openai");
  assert.equal(body.selected?.routeScore?.[2], 0);
});

test("model worker rebind hydrates stale original family and modality before scoring", async () => {
  const response = await worker.fetch(new Request("https://models.compose.market/rebind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.2-pro" }),
  }), env([
    modelRow("gpt-5.2-pro", {
      provider: "openai",
      family: "",
      active: 0,
      modality: ["image", "text"],
      semantics: {},
    }),
    modelRow("gpt-5.4", {
      provider: "azure",
      family: "openai",
      modality: ["text"],
    }),
    modelRow("gpt-5.3-chat", {
      provider: "azure",
      family: "openai",
      modality: ["text"],
    }),
    modelRow("gemini-3.1-flash", {
      provider: "gemini",
      family: "google",
      modality: ["text"],
    }),
  ]) as never);

  assert.equal(response.status, 200);
  const body = await response.json() as {
    original?: { family?: string; modality?: string[] };
    selected?: { modelId?: string; routeScore?: number[] };
  };
  assert.equal(body.original?.family, "openai");
  assert.deepEqual(body.original?.modality, ["text"]);
  assert.equal(body.selected?.modelId, "gpt-5.3-chat");
  assert.deepEqual(body.selected?.routeScore?.slice(0, 4), [0, 0, 0, 0]);
});

test("model worker rebind persists hydrated stale original fields to D1 rows", async () => {
  const original = modelRow("gpt-5.2-pro", {
    provider: "openai",
    family: "",
    active: 0,
    modality: ["image", "text"],
    semantics: {},
  });
  const candidate = modelRow("gpt-5.3-chat", {
    provider: "azure",
    family: "openai",
    modality: ["text"],
  });

  const response = await worker.fetch(new Request("https://models.compose.market/rebind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.2-pro" }),
  }), env([original, candidate]) as never);

  assert.equal(response.status, 200);
  assert.equal(original.family, "openai");
  assert.equal(original.modality, JSON.stringify(["text"]));
  assert.deepEqual(JSON.parse(String(original.semantics)), {
    family: "openai",
    modalities: ["text"],
  });
});

test("model worker rebind drops only the terminal Gemini preview suffix first", async () => {
  const response = await worker.fetch(new Request("https://models.compose.market/rebind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.1-flash-lite-preview" }),
  }), env([
    modelRow("gemini-3.1-flash-lite-preview", {
      family: "Gemini",
      provider: "gemini",
      active: 0,
      input: ["text", "image", "video", "audio", "pdf"],
    }),
    modelRow("gemini-3.1-pro", {
      family: "Gemini",
      provider: "gemini",
      input: ["text", "image", "video", "audio", "pdf"],
    }),
    modelRow("gemini-3.2", {
      family: "Gemini",
      provider: "gemini",
      input: ["text", "image", "video", "audio", "pdf"],
    }),
    modelRow("gemini-3.1-flash", {
      family: "Gemini",
      provider: "gemini",
      input: ["text", "image", "video", "audio", "pdf"],
    }),
    modelRow("gemini-3.1-flash-lite", {
      family: "Gemini",
      provider: "gemini",
      input: ["text", "image", "video", "audio", "pdf"],
    }),
  ]) as never);

  assert.equal(response.status, 200);
  const body = await response.json() as { selected?: { modelId?: string }; candidates?: Array<{ modelId?: string }> };
  assert.equal(body.selected?.modelId, "gemini-3.1-flash-lite");
  assert.deepEqual(body.candidates?.map((item) => item.modelId).slice(0, 4), [
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash",
    "gemini-3.1-pro",
    "gemini-3.2",
  ]);
});

test("model worker rebind hydrates stale Gemini preview family before scoring", async () => {
  const response = await worker.fetch(new Request("https://models.compose.market/rebind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.1-flash-lite-preview" }),
  }), env([
    modelRow("gemini-3.1-flash-lite-preview", {
      family: "",
      provider: "gemini",
      active: 0,
      input: ["text", "image", "video", "audio", "pdf"],
      semantics: {},
    }),
    modelRow("gemini-3.1-flash", {
      family: "google",
      provider: "gemini",
      input: ["text", "image", "video", "audio", "pdf"],
    }),
    modelRow("gemini-3.1-flash-lite", {
      family: "google",
      provider: "gemini",
      input: ["text", "image", "video", "audio", "pdf"],
    }),
  ]) as never);

  assert.equal(response.status, 200);
  const body = await response.json() as {
    original?: { family?: string };
    selected?: { modelId?: string; routeScore?: number[] };
  };
  assert.equal(body.original?.family, "google");
  assert.equal(body.selected?.modelId, "gemini-3.1-flash-lite");
  assert.equal(body.selected?.routeScore?.[2], 0);
});

function env(row?: Record<string, unknown> | Array<Record<string, unknown>>) {
  const rows = Array.isArray(row) ? row : row ? [row] : [];
  function prepared(query: string) {
    const stmt = {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        stmt.values = values;
        return stmt;
      },
      async first() {
        return null;
      },
      async raw() {
        return [];
      },
      async all() {
        if (rows.length > 0 && query.includes("FROM models") && query.includes("modelId =")) {
          const modelId = String(stmt.values[0] || "");
          return { success: true, results: rows.filter((item) => String(item.modelId) === modelId) };
        }
        if (rows.length > 0 && query.includes("FROM models") && query.includes("active = 1") && query.includes("available = 1")) {
          return { success: true, results: rows.filter((item) => item.active === 1 && item.available === 1) };
        }
        if (rows.length > 0 && query.includes("FROM models") && query.includes("key IN")) {
          const keys = new Set(stmt.values.map(String));
          return { success: true, results: rows.filter((item) => keys.has(String(item.key))) };
        }
        return { success: true, results: [] };
      },
      async run() {
        if (query.includes("UPDATE models") && query.includes("SET family = ?2")) {
          const [key, family, modality, semantics] = stmt.values;
          for (const item of rows) {
            if (String(item.key) === String(key) && item.active === 0) {
              item.family = family;
              item.modality = modality;
              item.semantics = semantics;
            }
          }
        }
        return { success: true };
      },
    };
    return stmt;
  }

  return {
    MONGO_DB_API_KEY: "mongo-key",
    EMBEDDING_API_BASE: "https://ai.mongodb.com/v1",
    EMBEDDING_MODEL: "voyage-4-large",
    DB: {
      prepare: prepared,
      async batch(statements: Array<ReturnType<typeof prepared>>) {
        for (const statement of statements) {
          await statement.run();
        }
        return statements.map(() => ({ success: true }));
      },
      async exec() {
        return { count: 0, duration: 0 };
      },
    },
    VEC: {
      async query() {
        return {
          matches: rows.map((item, index) => ({
            id: item.key,
            score: typeof item.score === "number" ? item.score : 0.91 - (index * 0.01),
          })),
          count: rows.length,
        };
      },
    },
  };
}

function modelRow(modelId: string, overrides: Partial<Record<string, unknown>> = {}) {
  const family = overrides.family === undefined ? "OpenAI" : overrides.family;
  return row({
    ...overrides,
    key: `${String(family).toLowerCase()}:${modelId}`,
    family: String(family).toLowerCase(),
    modelId,
    provider: String(overrides.provider || String(family).toLowerCase()),
    name: String(overrides.name || `${family} ${modelId}`),
    description: String(overrides.description || ""),
    input: JSON.stringify(overrides.input || ["text", "image"]),
    output: JSON.stringify(overrides.output || ["text"]),
    type: JSON.stringify(overrides.type || ["text-generation"]),
    modality: JSON.stringify(overrides.modality || ["text"]),
    operations: JSON.stringify(overrides.operations || ["chat", "vision-chat"]),
    metadata: JSON.stringify(overrides.metadata || {
      sourceMetadata: {
        azureDeployment: {
          modelFormat: family,
        },
      },
    }),
    semantics: JSON.stringify(overrides.semantics || {
      modalities: overrides.modality || ["text"],
      inputs: overrides.input || ["text", "image"],
      outputs: overrides.output || ["text"],
      operations: overrides.operations || ["chat", "vision-chat"],
    }),
    active: overrides.active ?? 1,
    available: overrides.available ?? 1,
  });
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    key: "cloudflare:@cf/leonardo/lucid-origin",
    modelId: "@cf/leonardo/lucid-origin",
    provider: "cloudflare",
    family: "",
    name: "Lucid Origin",
    description: "Image generation model",
    input: JSON.stringify(["text"]),
    output: JSON.stringify(["image"]),
    type: JSON.stringify(["image"]),
    modality: JSON.stringify(["image"]),
    capabilities: JSON.stringify({ image_generation: true }),
    contextWindow: null,
    contextTokens: null,
    pricing: JSON.stringify({}),
    operations: JSON.stringify(["text-to-image"]),
    metadata: JSON.stringify({}),
    semantics: JSON.stringify({ modalities: ["image"], operations: ["text-to-image"], outputs: ["image"] }),
    stream: 0,
    available: 1,
    active: 1,
    hash: "hash",
    batch: "batch",
    last: null,
    ...overrides,
  };
}

function audio(overrides: Partial<Record<string, unknown>> = {}) {
  return row({
    key: "elevenlabs:eleven_text_to_sound_v2",
    modelId: "eleven_text_to_sound_v2",
    provider: "elevenlabs",
    name: "Eleven Text To Sound V2",
    description: "Sound effects generation from text prompts",
    output: JSON.stringify(["audio"]),
    type: JSON.stringify(["text-to-audio"]),
    modality: JSON.stringify(["audio"]),
    capabilities: JSON.stringify({ audio_generation: true }),
    operations: JSON.stringify(["text-to-audio"]),
    semantics: JSON.stringify({ modalities: ["audio"], operations: ["text-to-audio"], outputs: ["audio"] }),
    ...overrides,
  });
}

test("model worker does not expose runtime planner routes", async () => {
  const response = await worker.fetch(new Request("https://models.compose.market/plan", {
    method: "POST",
    body: JSON.stringify({ prompt: "Generate an image." }),
  }), env(row()) as never);
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.deepEqual(body.error, {
    code: "not_found",
    message: "route not found",
  });
});

test("model worker select exposes candidate modality fields without planning", async () => {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/embeddings")) {
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.2, 0.8] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    assert.equal(url, "https://ai.mongodb.com/v1/rerank");
    const body = JSON.parse(String(init?.body || "{}"));
    assert.equal(body.query, "ocr this receipt");
    assert.ok(body.documents.some((doc: string) => doc.includes("input: image")));
    return new Response(JSON.stringify({
      data: [{ index: 0, relevance_score: 0.96 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const response = await worker.fetch(new Request("https://models.compose.market/select", {
    method: "POST",
    body: JSON.stringify({
      q: "ocr this receipt",
      limit: 8,
    }),
  }), env(row({
    key: "roboflow:doctr-ocr",
    modelId: "roboflow/doctr/ocr",
    provider: "roboflow",
    name: "Doctr OCR",
    description: "OCR over an image input",
    input: JSON.stringify(["image"]),
    output: JSON.stringify(["text"]),
    modality: JSON.stringify(["text"]),
    operations: JSON.stringify(["ocr"]),
  })) as never);
  const body = await response.json() as { selected?: Record<string, unknown> | null };

  assert.equal(response.status, 200);
  assert.deepEqual(body.selected?.input, ["image"]);
  assert.deepEqual(body.selected?.output, ["text"]);
  assert.deepEqual(body.selected?.modality, ["text"]);
  assert.deepEqual(body.selected?.operations, ["ocr"]);
});

test("model worker schema includes item state machine tables", () => {
  const text = sql.schema.join("\n");
  assert.match(text, /CREATE TABLE IF NOT EXISTS states/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS attempts/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS audit/);
  assert.match(text, /state IN \('queued', 'skipped', 'indexed', 'stale', 'failed'\)/);
});

test("model worker repair backfills states for existing rows", async () => {
  const models = [
    { key: "openai:gpt-test", hash: "hash-a", batch: "batch-a", active: 1 },
    { key: "openai:old-test", hash: "hash-b", batch: "batch-a", active: 0 },
    { key: "google:ready-test", hash: "hash-c", batch: "batch-a", active: 1 },
  ];
  const states = new Map<string, { hash: string; state: string; batch: string }>([
    ["google:ready-test", { hash: "hash-c", state: "indexed", batch: "batch-a" }],
  ]);
  const attempts: Array<{ key: string; batch: string; stage: string; state: string }> = [];
  const audits: Array<{ action: string; target: string; data: unknown }> = [];

  function prepared(query: string) {
    const stmt = {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        stmt.values = values;
        return stmt;
      },
      async first() {
        return null;
      },
      async raw() {
        return [];
      },
      async all() {
        if (query.includes("LEFT JOIN states")) {
          return {
            success: true,
            results: models.filter((model) => !states.has(model.key)),
          };
        }
        return { success: true, results: [] };
      },
      async run() {
        const text = query.replace(/\s+/g, " ").trim();
        if (text.startsWith("INSERT OR IGNORE INTO states")) {
          const [key, hash, state, batch] = stmt.values as [string, string, string, string];
          if (!states.has(key)) {
            states.set(key, { hash, state, batch });
          }
        } else if (text.startsWith("INSERT INTO attempts")) {
          const [, key, batch, state] = stmt.values as [string, string, string, string];
          attempts.push({ key, batch, stage: "reconcile", state });
        } else if (text.startsWith("INSERT INTO audit")) {
          const [, action, target, , data] = stmt.values as [string, string, string, string | null, string];
          audits.push({ action, target, data: JSON.parse(data) as unknown });
        }
        return { success: true };
      },
    };
    return stmt;
  }

  const env = {
    DB: {
      prepare: prepared,
      async batch(statements: Array<ReturnType<typeof prepared>>) {
        for (const statement of statements) {
          await statement.run();
        }
        return statements.map(() => ({ success: true }));
      },
      async exec() {
        return { count: 0, duration: 0 };
      },
    },
  };

  assert.equal(await sql.repair(env as never), 2);
  assert.equal(states.get("openai:gpt-test")?.state, "indexed");
  assert.equal(states.get("openai:old-test")?.state, "stale");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((item) => item.state).sort(), ["skipped", "succeeded"]);
  assert.equal(audits[0]?.action, "repair");
  assert.equal(audits[0]?.target, "models");
  assert.deepEqual(audits[0]?.data, { states: 2, indexed: 1, stale: 1 });

  assert.equal(await sql.repair(env as never), 0);
  assert.equal(attempts.length, 2);
  assert.equal(audits.length, 1);
});
