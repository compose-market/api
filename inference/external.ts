import type { Express, Request, RequestHandler, Response } from "express";
import {
  handleAudioSpeech,
  handleAudioTranscription,
  handleChatCompletions,
  handleEmbeddings,
  handleImageGeneration,
  handleResponses,
  handleVideoGeneration,
} from "./gateway.js";
import { getCompiledModels, getModelById, resolveModel, type ModelCard, type ResolvedModel } from "./catalog/registry.js";
import { extractComposeKeyFromHeader, validateComposeKey } from "../x402/keys/middleware.js";

const URLS = /\bhttps?:\/\/[^\s"'<>)]*/gi;
const OPEN = "compose-market";
const ENV = "COMPOSE_MARKET_API_KEY";
const MODES = new Set(["text", "audio", "image", "video", "pdf"]);
const CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

type Config = Record<string, unknown>;

interface Cached {
  config: Config;
  opencode: string;
  wellknown: string;
}

const configs = new Map<string, Cached>();

function catalog(): ModelCard[] {
  return getCompiledModels().models;
}

function upstream(model: Pick<ModelCard, "modelId" | "upstreamModelId">): string {
  return typeof model.upstreamModelId === "string" && model.upstreamModelId.length > 0
    ? model.upstreamModelId
    : model.modelId;
}

function exact(value: unknown): { id: string; model: ModelCard; resolved: ResolvedModel; upstreamModelId: string } | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const resolved = resolveModel(value);
    if (!resolved.card) {
      return null;
    }

    return {
      id: resolved.modelId,
      model: resolved.card,
      resolved,
      upstreamModelId: upstream(resolved.card),
    };
  } catch {
    return null;
  }
}

function created(model: ModelCard): number {
  if (typeof model.createdAt === "number" && Number.isFinite(model.createdAt)) {
    return model.createdAt;
  }
  if (typeof model.createdAt === "string") {
    const parsed = Date.parse(model.createdAt);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  return 0;
}

function row(model: ModelCard): Record<string, unknown> {
  return {
    id: model.modelId,
    object: "model",
    created: created(model),
    owned_by: model.provider,
    name: model.name || model.modelId,
    metadata: {
      provider: model.provider,
      model_id: model.modelId,
      ...(model.upstreamModelId ? { upstream_model_id: model.upstreamModelId } : {}),
      ...(model.ownedBy ? { owned_by: model.ownedBy } : {}),
      ...meta(model),
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function yes(model: ModelCard, keys: string[]): boolean {
  const caps = record(model.capabilities);
  return keys.some((key) => caps?.[key] === true);
}

function limit(model: ModelCard): Record<string, number> | undefined {
  const context = record(model.contextWindow);
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

function price(model: ModelCard): Record<string, number> | undefined {
  const pricing = record(model.pricing);
  const sections = Array.isArray(pricing?.sections) ? pricing.sections : [];
  const section = record(sections.find((item) => record(item)?.default === true)) || record(sections[0]);
  const entries = record(section?.entries);
  if (!entries) return undefined;
  const out: Record<string, number> = {};
  if (typeof entries.input === "number") out.input = entries.input;
  if (typeof entries.output === "number") out.output = entries.output;
  if (typeof entries.cached_input === "number") out.cache_read = entries.cached_input;
  if (typeof entries.cache_read === "number") out.cache_read = entries.cache_read;
  if (typeof entries.cache_write === "number") out.cache_write = entries.cache_write;
  return Object.keys(out).length > 0 ? out : undefined;
}

function meta(model: ModelCard): Record<string, unknown> {
  const input = list(model.input);
  const output = list(model.output);
  const data: Record<string, unknown> = {
    name: model.name || model.modelId,
  };
  const caps = record(model.capabilities);
  if (caps?.reasoning === true) data.reasoning = true;
  if (yes(model, ["tool_use", "tool_calling", "function_calling", "tools"])) data.tool_call = true;
  if (input.some((item) => item !== "text")) data.attachment = true;
  const bounds = limit(model);
  if (bounds) data.limit = bounds;
  const cost = price(model);
  if (cost) data.cost = cost;
  if (input.length > 0 || output.length > 0) {
    data.modalities = {
      input: input.length > 0 ? input : ["text"],
      output: output.length > 0 ? output : ["text"],
    };
  }
  return data;
}

function olimit(model: ModelCard): Record<string, number> | undefined {
  const bounds = limit(model);
  if (
    !bounds
    || typeof bounds.context !== "number"
    || bounds.context <= 0
    || typeof bounds.output !== "number"
    || bounds.output <= 0
  ) {
    return undefined;
  }

  return {
    context: bounds.context,
    ...(typeof bounds.input === "number" && bounds.input > 0 ? { input: bounds.input } : {}),
    output: bounds.output,
  };
}

function ometa(model: ModelCard): Record<string, unknown> {
  const input = list(model.input);
  const data: Record<string, unknown> = {};
  if (model.name && model.name !== model.modelId) data.name = model.name;
  const caps = record(model.capabilities);
  if (caps?.reasoning === true) data.reasoning = true;
  if (yes(model, ["tool_use", "tool_calling", "function_calling", "tools"])) data.tool_call = true;
  if (input.some((item) => item !== "text" && MODES.has(item))) data.attachment = true;
  const bounds = olimit(model);
  if (bounds) data.limit = bounds;
  return data;
}

function origin(req: Request): string {
  const configured = process.env.API_URL?.trim().replace(/\/+$/u, "");
  if (configured) {
    return configured;
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host") || "api.compose.market";
  return `${proto}://${host}`;
}

function headers(res: Response): void {
  res.setHeader("Cache-Control", CACHE);
  res.setHeader("CDN-Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.setHeader("Surrogate-Control", "max-age=3600, stale-while-revalidate=86400");
}

function send(res: Response, json: string): void {
  headers(res);
  res.status(200).type("application/json").send(json);
}

function fail(res: Response, status: number, message: string, code: string, type = "invalid_request_error"): void {
  res.status(status).json({
    error: {
      message,
      type,
      param: null,
      code,
    },
  });
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function redact(value: string): string {
  return value.replace(URLS, "[redacted-url]");
}

function payload(value: string): Record<string, unknown> | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(value.slice(start));
    const root = record(parsed);
    return record(root?.error) || root;
  } catch {
    return null;
  }
}

function kind(status: number | undefined, code: string | undefined, current: string | undefined): string {
  if (current) return current;
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 402) return "payment_error";
  if (status === 429) return "rate_limit_error";
  if (code === "content_filter") return "invalid_request_error";
  return "invalid_request_error";
}

function code(status: number | undefined, value: string | undefined): string {
  if (value) return value;
  if (status === 401 || status === 403) return "invalid_auth";
  if (status === 402) return "insufficient_funds";
  if (status === 429) return "rate_limit_exceeded";
  return "invalid_request";
}

function error(value: unknown, status?: number): Record<string, unknown> {
  const source = record(value);
  const raw = text(source?.message) || (typeof value === "string" ? value : "Request failed");
  const parsed = payload(raw);
  const upstream = record(parsed?.error) || parsed;
  const resolved = code(status, text(upstream?.code) || text(source?.code));
  const message = resolved === "content_filter"
    ? "The upstream provider rejected the request because it triggered a content filter."
    : redact(text(upstream?.message) || raw);

  return {
    ...(source || {}),
    message,
    type: kind(status, resolved, text(source?.type)),
    param: upstream?.param ?? source?.param ?? null,
    code: resolved,
  };
}

function body(res: Response, value: unknown): unknown {
  const source = record(value);
  if (!source) return value;

  const next: Record<string, unknown> = { ...source };
  const id = text(res.locals.composeExternalModelId);
  if (id && typeof next.model === "string") {
    next.model = id;
  }
  delete next.receipt;

  if ("error" in next) {
    next.error = error(next.error, res.statusCode);
  }

  return next;
}

function data(frame: string): string | null {
  const lines = frame.split(/\r?\n/u);
  const line = lines.find((item) => item.startsWith("data:"));
  return line ? line.slice("data:".length).trim() : null;
}

function frame(res: Response, value: string): string {
  if (/^event:\s*compose\.(receipt|video\.status)/imu.test(value)) {
    return "";
  }

  if (/^event:\s*compose\.error/mu.test(value)) {
    const raw = data(value);
    let parsed: unknown = raw || "Request failed";
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return `data: ${JSON.stringify({ error: error(parsed, res.statusCode) })}\n\n`;
  }

  const raw = data(value);
  if (!raw || raw === "[DONE]") {
    return value.endsWith("\n\n") ? value : `${value}\n\n`;
  }

  try {
    return `data: ${JSON.stringify(body(res, JSON.parse(raw)))}\n\n`;
  } catch {
    return value.endsWith("\n\n") ? value : `${value}\n\n`;
  }
}

function sse(res: Response, value: string): string {
  if (!/^(data|event):/mu.test(value)) {
    return value;
  }
  return value
    .split("\n\n")
    .map((item) => item.trim().length > 0 ? frame(res, item) : "")
    .join("");
}

export function shape(): RequestHandler {
  return (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = ((value?: unknown) => json(body(res, value))) as typeof res.json;

    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : null;
      if (!value || !/^(data|event):/mu.test(value)) {
        return write(chunk, ...args);
      }
      const nextChunk = sse(res, value);
      if (nextChunk.length === 0) {
        const callback = args.find((arg): arg is () => void => typeof arg === "function");
        callback?.();
        return true;
      }
      return write(nextChunk, ...args);
    }) as typeof res.write;

    next();
  };
}

function asyncify(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveExternalModel(): RequestHandler {
  return (req, res, next) => {
    const body = object(req.body);
    const resolved = exact(body?.model);
    if (!resolved) {
      fail(
        res,
        404,
        "Model is required and must match the Compose catalog exactly.",
        "model_not_found",
      );
      return;
    }

    const source = body as Record<string, unknown>;
    source.model = resolved.id;
    source.provider = resolved.resolved.provider;
    res.locals.composeExternalModelId = resolved.id;
    res.locals.composeUpstreamProvider = resolved.resolved.provider;
    res.locals.composeUpstreamModel = resolved.upstreamModelId;
    res.locals.composePublicModel = resolved.id;
    if (!res.headersSent) {
      res.setHeader("x-upstream-provider", resolved.resolved.provider);
      res.setHeader("x-upstream-model", resolved.upstreamModelId);
      res.setHeader("x-public-model", resolved.id);
    }
    next();
  };
}

function auth(): RequestHandler {
  return async (req, res, next) => {
    try {
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const token = extractComposeKeyFromHeader(authorization);
      if (!token) {
        fail(
          res,
          401,
          "ComposeKey authorization is required. Use Authorization: Bearer compose-...",
          "compose_key_required",
          "authentication_error",
        );
        return;
      }

      const validation = await validateComposeKey(token, 0);
      if (!validation.valid || !validation.record) {
        fail(
          res,
          401,
          validation.error || "Invalid ComposeKey",
          "invalid_compose_key",
          "authentication_error",
        );
        return;
      }

      if (!validation.record.chainId) {
        fail(
          res,
          400,
          "ComposeKey is missing a chainId and cannot be used from OpenAI-compatible external clients.",
          "compose_key_chain_required",
        );
        return;
      }

      req.headers["x-chain-id"] = String(validation.record.chainId);
      next();
    } catch (error) {
      fail(
        res,
        500,
        error instanceof Error ? error.message : "ComposeKey validation failed",
        "compose_key_validation_failed",
      );
    }
  };
}

async function models(_req: Request, res: Response): Promise<void> {
  headers(res);
  res.status(200).json({
    object: "list",
    data: catalog().map(row),
  });
}

async function model(req: Request, res: Response): Promise<void> {
  const idParam = req.params.model || req.params.id;
  const id = decode(Array.isArray(idParam) ? idParam[0] : idParam || "");
  const found = getModelById(id);
  if (!found) {
    fail(res, 404, `Model '${id || ""}' not found`, "model_not_found");
    return;
  }
  headers(res);
  res.status(200).json(row(found));
}

function config(base: string, key: boolean): Config {
  const models = Object.fromEntries(catalog().map((model) => [
    model.modelId,
    ometa(model),
  ]));

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPEN]: {
        name: "Compose.Market",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${base}/external/v1`,
          ...(key ? { apiKey: `{env:${ENV}}` } : {}),
          includeUsage: true,
          timeout: false,
          chunkTimeout: 120000,
        },
        models,
      },
    },
  };
}

function cache(req: Request): Cached {
  const base = origin(req);
  const found = configs.get(base);
  if (found) {
    return found;
  }

  const value = config(base, true);
  const clean = config(base, false);
  const next = {
    config: value,
    opencode: JSON.stringify(value),
    wellknown: JSON.stringify({
      config: clean,
    }),
  };
  configs.set(base, next);
  return next;
}

async function opencode(req: Request, res: Response): Promise<void> {
  send(res, cache(req).opencode);
}

async function wellknown(req: Request, res: Response): Promise<void> {
  send(res, cache(req).wellknown);
}

function route(app: Express, method: "get" | "post", path: string, ...handlers: RequestHandler[]): void {
  app[method](path, ...handlers);
}

export function register(app: Express): void {
  const guard = auth();
  const resolve = resolveExternalModel();
  const shaped = shape();

  route(app, "get", "/external/v1/models", asyncify(models));
  route(app, "get", "/external/v1/models/:model", asyncify(model));
  app.get(/^\/external\/v1\/models\/(.+)$/, (req, res, next) => {
    req.params.model = req.params[0];
    void model(req, res).catch(next);
  });
  route(app, "get", "/.well-known/opencode", asyncify(wellknown));
  route(app, "get", "/external/opencode", asyncify(opencode));

  route(app, "post", "/external/v1/chat/completions", resolve, shaped, guard, asyncify(handleChatCompletions));
  route(app, "post", "/external/v1/responses", resolve, shaped, guard, asyncify(handleResponses));
  route(app, "post", "/external/v1/embeddings", resolve, shaped, guard, asyncify(handleEmbeddings));
  route(app, "post", "/external/v1/images/generations", resolve, shaped, guard, asyncify(handleImageGeneration));
  route(app, "post", "/external/v1/audio/speech", resolve, shaped, guard, asyncify(handleAudioSpeech));
  route(app, "post", "/external/v1/audio/transcriptions", resolve, shaped, guard, asyncify(handleAudioTranscription));
  route(app, "post", "/external/v1/videos/generations", resolve, shaped, guard, asyncify(handleVideoGeneration));
}
