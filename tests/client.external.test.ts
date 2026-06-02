import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

const MODES = new Set(["text", "audio", "image", "video", "pdf"]);

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function id(model: { provider: string; modelId: string }): string {
  return model.modelId;
}

function duplicate(models: Array<{ modelId: string }>): string | undefined {
  const counts = new Map<string, number>();
  for (const model of models) {
    counts.set(model.modelId, (counts.get(model.modelId) || 0) + 1);
  }
  return [...counts].find(([, count]) => count > 1)?.[0];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function bounds(model: Record<string, unknown>): Record<string, number> | undefined {
  const context = object(model.contextWindow);
  const contextTokens = typeof model.contextWindow === "number"
    ? model.contextWindow
    : typeof context?.tokens === "number"
      ? context.tokens
      : undefined;
  const input = typeof context?.inputTokens === "number"
    ? context.inputTokens
    : typeof context?.input_tokens === "number"
      ? context.input_tokens
      : contextTokens;
  const output = typeof context?.outputTokens === "number"
    ? context.outputTokens
    : typeof context?.output_tokens === "number"
      ? context.output_tokens
      : typeof model.maxOutputTokens === "number"
        ? model.maxOutputTokens
        : undefined;
  const out: Record<string, number> = {};
  if (typeof contextTokens === "number" && contextTokens > 0) out.context = contextTokens;
  if (typeof input === "number" && input > 0) out.input = input;
  if (typeof output === "number" && output > 0) out.output = output;
  return Object.keys(out).length > 0 ? out : undefined;
}

function cost(model: Record<string, unknown>): Record<string, number> | undefined {
  const pricing = object(model.pricing);
  const sections = Array.isArray(pricing?.sections) ? pricing.sections : [];
  const section = object(sections.find((item) => object(item)?.default === true)) || object(sections[0]);
  const entries = object(section?.entries);
  if (!entries) return undefined;
  const out: Record<string, number> = {};
  if (typeof entries.input === "number") out.input = entries.input;
  if (typeof entries.output === "number") out.output = entries.output;
  if (typeof entries.cached_input === "number") out.cache_read = entries.cached_input;
  if (typeof entries.cache_read === "number") out.cache_read = entries.cache_read;
  if (typeof entries.cache_write === "number") out.cache_write = entries.cache_write;
  return Object.keys(out).length > 0 ? out : undefined;
}

function partialLimit(model: Record<string, unknown>): boolean {
  const value = bounds(model);
  return Boolean(value) && (typeof value?.context !== "number" || typeof value?.output !== "number");
}

function partialCost(model: Record<string, unknown>): boolean {
  const value = cost(model);
  return Boolean(value) && (typeof value?.input !== "number" || typeof value?.output !== "number");
}

function badModes(model: Record<string, unknown>): boolean {
  const values = [...strings(model.input), ...strings(model.output)];
  return values.some((value) => !MODES.has(value));
}

function goodLimit(value: unknown): void {
  const limit = object(value);
  assert.ok(limit);
  const context = limit.context;
  const output = limit.output;
  if (typeof context !== "number") assert.fail("limit.context must be a number");
  assert.ok(context > 0);
  if (typeof output !== "number") assert.fail("limit.output must be a number");
  assert.ok(output > 0);
  if ("input" in limit) {
    assert.equal(typeof limit.input, "number");
    assert.ok((limit.input as number) > 0);
  }
}

function goodCost(value: unknown): void {
  const data = object(value);
  assert.ok(data);
  assert.equal(typeof data.input, "number");
  assert.equal(typeof data.output, "number");
  for (const key of ["cache_read", "cache_write"]) {
    if (key in data) {
      assert.equal(typeof data[key], "number");
    }
  }
}

function goodModes(value: unknown): void {
  const modes = object(value);
  assert.ok(modes);
  const input = strings(modes.input);
  const output = strings(modes.output);
  assert.ok(input.length > 0);
  assert.ok(output.length > 0);
  assert.equal(input.every((item) => MODES.has(item)), true);
  assert.equal(output.every((item) => MODES.has(item)), true);
}

test("body parser accepts OpenCode-sized JSON by default", async () => {
  const { json, errors } = await import("../http/body.js");
  const app = express();
  app.use(json());
  app.post("/probe", (req, res) => {
    res.status(200).json({
      ok: true,
      bytes: Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0,
      length: typeof req.body.prompt === "string" ? req.body.prompt.length : 0,
    });
  });
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(130 * 1024) }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; bytes: number; length: number };
    assert.equal(body.ok, true);
    assert.ok(body.bytes > 100 * 1024);
    assert.equal(body.length, 130 * 1024);
  });
});

test("body limit is environment configurable but capped at 32mb", async () => {
  const { bytes } = await import("../http/body.js");

  assert.equal(bytes({ API_BODY_LIMIT: "12mb" }), 12 * 1024 * 1024);
  assert.equal(bytes({ API_BODY_LIMIT: "128mb" }), 32 * 1024 * 1024);
  assert.equal(bytes({ API_BODY_LIMIT: "garbage" }), 10 * 1024 * 1024);
});

test("external models endpoint returns OpenAI-shaped catalog without changing runtime shape", async () => {
  const { json, errors } = await import("../http/body.js");
  const { register: external } = await import("../inference/external.js");
  const { registerInferenceRoutes } = await import("../inference/gateway.js");
  const { getCompiledModels } = await import("../inference/catalog/registry.js");
  const compiled = getCompiledModels().models;
  assert.ok(compiled.length > 0);
  const sample = compiled[0];
  assert.ok(sample);
  const app = express();
  app.use(json());
  external(app);
  registerInferenceRoutes(app);
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const externalResponse = await fetch(`${baseUrl}/external/v1/models`);
    assert.equal(externalResponse.status, 200);
    const externalBody = await externalResponse.json() as { object: string; data: Array<Record<string, unknown>> };
    assert.equal(externalBody.object, "list");
    assert.equal(externalBody.data.length, compiled.length);
    const externalModel = externalBody.data.find((entry) => entry.id === id(sample));
    assert.ok(externalModel);
    assert.equal(externalModel.object, "model");
    assert.equal(externalModel.owned_by, sample.provider);
    assert.equal("modelId" in externalModel, false);
    assert.equal("contextWindow" in externalModel, false);

    assert.equal(duplicate(compiled), undefined);
    assert.equal(externalBody.data.some((entry) => typeof entry.id === "string" && entry.id.includes("|")), false);
    assert.ok(externalBody.data.find((entry) => entry.id === "gpt-5.5"));
    assert.ok(externalBody.data.find((entry) => entry.id === "openai/gpt-5.5"));

    const cloudflare = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const modelResponse = await fetch(`${baseUrl}/external/v1/models/${encodeURIComponent(cloudflare)}`);
    assert.equal(modelResponse.status, 200);
    const modelBody = await modelResponse.json() as { id: string; owned_by: string; metadata?: { model_id?: string } };
    assert.equal(modelBody.id, cloudflare);
    assert.equal(modelBody.owned_by, "cloudflare");
    assert.equal(modelBody.metadata?.model_id, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    const runtimeResponse = await fetch(`${baseUrl}/v1/models`);
    assert.equal(runtimeResponse.status, 200);
    const runtimeBody = await runtimeResponse.json() as { object: string; data: Array<Record<string, unknown>> };
    const runtimeModel = runtimeBody.data.find((entry) => entry.modelId === sample.modelId);
    assert.ok(runtimeModel);
    assert.equal("id" in runtimeModel, false);
    assert.ok("contextWindow" in runtimeModel);
  });
});

test("external chat completions require ComposeKey bearer auth instead of raw x402 challenge", async () => {
  const { json, errors } = await import("../http/body.js");
  const { register } = await import("../inference/external.js");
  const { getCompiledModels } = await import("../inference/catalog/registry.js");
  const sample = getCompiledModels().models[0];
  const model = sample ? id(sample) : "";
  assert.ok(model);
  const app = express();
  app.use(json());
  register(app);
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/external/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
    const body = await response.json() as { error: { message: string; type: string; code: string } };
    assert.equal(body.error.type, "authentication_error");
    assert.equal(body.error.code, "compose_key_required");
    assert.match(body.error.message, /ComposeKey/i);
  });
});

test("external chat completions parse OpenCode-sized payloads before ComposeKey auth", async () => {
  const { json, errors } = await import("../http/body.js");
  const { register } = await import("../inference/external.js");
  const { getCompiledModels } = await import("../inference/catalog/registry.js");
  const sample = getCompiledModels().models[0];
  const model = sample ? id(sample) : "";
  assert.ok(model);
  const app = express();
  app.use(json());
  register(app);
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/external/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "x".repeat(130 * 1024) }],
      }),
    });
    assert.equal(response.status, 401);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "compose_key_required");
  });
});

test("external body limit failures are OpenAI-shaped", async () => {
  const { json, errors } = await import("../http/body.js");
  const { register } = await import("../inference/external.js");
  const { getCompiledModels } = await import("../inference/catalog/registry.js");
  const sample = getCompiledModels().models[0];
  const model = sample ? id(sample) : "";
  assert.ok(model);
  const app = express();
  app.use(json({ API_BODY_LIMIT: "1kb" }));
  register(app);
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/external/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "x".repeat(2 * 1024) }],
      }),
    });
    assert.equal(response.status, 413);
    const body = await response.json() as { error: { type: string; code: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "request_entity_too_large");
  });
});

test("external chat normalization preserves OpenAI and AI SDK options", async () => {
  const { normalizeChatRequest } = await import("../inference/core.js");
  const cleaned = normalizeChatRequest({
    model: "example-model",
    promptCacheKey: "ses_test",
    reasoning_effort: "medium",
    verbosity: "low",
    stream_options: { include_usage: true },
    tools: [{
      type: "function",
      function: {
        name: "repo.inspect",
        parameters: { type: "object", properties: {} },
      },
    }],
    messages: [{ role: "user", content: "Inspect the repository." }],
  });

  assert.equal(cleaned.customParams?.prompt_cache_key, "ses_test");
  assert.equal(cleaned.customParams?.reasoning_effort, "medium");
  assert.deepEqual(cleaned.customParams?.stream_options, { include_usage: true });
  assert.deepEqual(cleaned.customParams?.text, { verbosity: "low" });
  assert.ok(Array.isArray(cleaned.tools));
});

test("external resolver keeps public ids and reports provider/upstream diagnostics", async () => {
  const { resolveExternalModel } = await import("../inference/external.js");
  const middleware = resolveExternalModel();
  const headers: Record<string, string> = {};
  const req = {
    body: { model: "openai/gpt-5.5" },
  } as express.Request;
  const res = {
    locals: {},
    headersSent: false,
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
  } as unknown as express.Response;
  let called = false;

  middleware(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal((req.body as Record<string, unknown>).model, "openai/gpt-5.5");
  assert.equal((req.body as Record<string, unknown>).provider, "openai");
  assert.equal(res.locals.composeExternalModelId, "openai/gpt-5.5");
  assert.equal(headers["x-upstream-provider"], "openai");
  assert.equal(headers["x-upstream-model"], "gpt-5.5");
  assert.equal(headers["x-public-model"], "openai/gpt-5.5");
});

test("external resolver rejects unknown ids", async () => {
  const { resolveExternalModel } = await import("../inference/external.js");
  const middleware = resolveExternalModel();
  const req = { body: { model: "missing-model" } } as express.Request;
  let statusCode = 0;
  let payload: { error?: { code?: string } } = {};
  const res = {
    locals: {},
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (body: typeof payload) => {
      payload = body;
      return res;
    },
  } as unknown as express.Response;

  middleware(req, res, () => assert.fail("invalid external model should not continue"));

  assert.equal(statusCode, 404);
  assert.equal(payload.error?.code, "model_not_found");
});

test("external response shaping hides Compose receipts and preserves public model ids", async () => {
  const { json, errors } = await import("../http/body.js");
  const { resolveExternalModel, shape } = await import("../inference/external.js");
  const app = express();
  app.use(json());
  app.post("/external/probe", resolveExternalModel(), shape(), (req, res) => {
    res.status(200).json({
      id: "chatcmpl_test",
      object: "chat.completion",
      model: req.body.model,
      choices: [],
      receipt: { final_amount_wei: "100" },
    });
  });
  app.post("/external/stream", resolveExternalModel(), shape(), (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ model: req.body.model, choices: [] })}\n\n`);
    res.write("event: compose.receipt\ndata: {\"finalAmountWei\":\"100\"}\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const jsonResponse = await fetch(`${baseUrl}/external/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5" }),
    });
    assert.equal(jsonResponse.status, 200);
    assert.equal(jsonResponse.headers.get("x-upstream-provider"), "openai");
    assert.equal(jsonResponse.headers.get("x-upstream-model"), "gpt-5.5");
    assert.equal(jsonResponse.headers.get("x-public-model"), "openai/gpt-5.5");
    const jsonBody = await jsonResponse.json() as Record<string, unknown>;
    assert.equal(jsonBody.model, "openai/gpt-5.5");
    assert.equal("receipt" in jsonBody, false);

    const streamResponse = await fetch(`${baseUrl}/external/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5" }),
    });
    assert.equal(streamResponse.status, 200);
    const streamBody = await streamResponse.text();
    assert.match(streamBody, /"model":"openai\/gpt-5\.5"/);
    assert.doesNotMatch(streamBody, /event: compose\.receipt/);
    assert.doesNotMatch(streamBody, /"model":"gpt-5\.5"/);
  });
});

test("external response shaping sanitizes upstream content-filter errors", async () => {
  const { json, errors } = await import("../http/body.js");
  const { resolveExternalModel, shape } = await import("../inference/external.js");
  const app = express();
  app.use(json());
  app.post("/external/error", resolveExternalModel(), shape(), (_req, res) => {
    res.status(400).json({
      error: {
        message: "fetchJson HTTP 400 Bad Request @ https://provider.example.invalid/private: {\"error\":{\"message\":\"Private provider policy details at https://provider.example.invalid/docs\",\"param\":\"prompt\",\"code\":\"content_filter\"}}",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
  });
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/external/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-upstream-provider"), "azure");
    assert.equal(response.headers.get("x-upstream-model"), "gpt-5.5");
    const body = await response.json() as { error: { message: string; type: string; code: string; param?: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "content_filter");
    assert.equal(body.error.param, "prompt");
    assert.match(body.error.message, /upstream provider rejected/i);
    assert.doesNotMatch(body.error.message, /provider\.example/);
    assert.doesNotMatch(body.error.message, /https:\/\//);
  });
});

test("external OpenCode config is generated from the catalog", async () => {
  const { json, errors } = await import("../http/body.js");
  const { register } = await import("../inference/external.js");
  const { getCompiledModels } = await import("../inference/catalog/registry.js");
  const app = express();
  app.use(json());
  register(app);
  app.use(errors());

  await withServer(app, async (baseUrl) => {
    for (const path of ["/.well-known/opencode", "/external/opencode"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      const control = response.headers.get("cache-control") || "";
      assert.match(control, /\bpublic\b/);
      assert.match(control, /\bs-maxage=3600\b/);
      assert.match(control, /\bstale-while-revalidate=86400\b/);
      const parsed = await response.json() as {
        auth?: { command?: string[]; env?: string };
        config?: {
          $schema?: string;
          model?: string;
          small_model?: string;
          enabled_providers?: string[];
          provider: Record<string, {
            api?: string;
            npm?: string;
            name?: string;
            options?: {
              apiKey?: string;
              baseURL?: string;
              timeout?: false;
              chunkTimeout?: number;
              includeUsage?: boolean;
            };
            models?: Record<string, Record<string, unknown>>;
          }>;
        };
        $schema?: string;
        model?: string;
        small_model?: string;
        enabled_providers?: string[];
        provider: Record<string, {
          api?: string;
          npm?: string;
          name?: string;
          options?: {
            apiKey?: string;
            baseURL?: string;
            timeout?: false;
            chunkTimeout?: number;
            includeUsage?: boolean;
          };
          models?: Record<string, Record<string, unknown>>;
        }>;
      };
      const body = path === "/.well-known/opencode" ? parsed.config : parsed;
      assert.ok(body);
      if (path === "/.well-known/opencode") {
        assert.equal("auth" in parsed, false);
        assert.equal(JSON.stringify(parsed).includes("command"), false);
        assert.equal(JSON.stringify(parsed).includes("token"), false);
        assert.equal(JSON.stringify(parsed).includes("COMPOSE_MARKET_API_KEY"), false);
      }
      const provider = body.provider["compose-market"];
      const compiled = getCompiledModels().models;
      assert.equal("model" in body, false);
      assert.equal("small_model" in body, false);
      assert.equal("enabled_providers" in body, false);
      assert.ok(provider);
      assert.equal("api" in provider, false);
      assert.equal(provider.npm, "@ai-sdk/openai-compatible");
      assert.equal(provider.options?.baseURL, `${baseUrl}/external/v1`);
      if (path === "/.well-known/opencode") {
        assert.equal("apiKey" in (provider.options || {}), false);
      } else {
        assert.equal(provider.options?.apiKey, "{env:COMPOSE_MARKET_API_KEY}");
      }
      assert.equal(provider.options?.timeout, false);
      assert.equal(provider.options?.chunkTimeout, 120000);
      assert.equal(provider.options?.includeUsage, true);
      assert.equal("setCacheKey" in (provider.options || {}), false);
      const models = provider.models || {};
      assert.equal(Object.keys(models).length, compiled.length);
      for (const model of compiled) {
        assert.ok(models[id(model)]);
      }
      assert.ok(models["gpt-5.5"]);
      assert.ok(models["openai/gpt-5.5"]);
      assert.equal(Boolean(Object.keys(models).some((model) => model.includes("|"))), false);

      for (const model of Object.values(models)) {
        if ("limit" in model) goodLimit(model.limit);
        if ("cost" in model) goodCost(model.cost);
        if ("modalities" in model) goodModes(model.modalities);
      }

      const rawLimit = compiled.find((model) => partialLimit(model as unknown as Record<string, unknown>));
      const rawCost = compiled.find((model) => partialCost(model as unknown as Record<string, unknown>));
      const rawModes = compiled.find((model) => badModes(model as unknown as Record<string, unknown>));
      assert.ok(rawLimit);
      assert.ok(rawCost);
      assert.ok(rawModes);
      assert.equal("limit" in models[id(rawLimit)], false);
      assert.equal("cost" in models[id(rawCost)], false);
      assert.equal("modalities" in models[id(rawModes)], false);
    }
  });
});
