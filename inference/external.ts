import type { Express, Request, RequestHandler, Response } from "express";
import {
  executeRequest,
  handleAudioSpeech,
  handleAudioTranscription,
  handleEmbeddings,
  handleImageGeneration,
  handleVideoGeneration,
} from "./gateway.js";
import { normalizeChatRequest, normalizeResponsesRequest } from "./core.js";
import {
  getCompiledModels,
  getModalityModels,
  getModelById,
  getModelProtocolProfile,
  resolveModel,
  type ModelCard,
  type ResolvedModel,
} from "./adapters/registry.js";
import { extractKeyFromHeader, validateKey } from "../x402/keys/middleware.js";
import { publicOriginFromRequest } from "../http/public-origin.js";

const URLS = /\bhttps?:\/\/[^\s"'<>)]*/gi;
const OPEN = "compose-market";
const ENV = "COMPOSE_MARKET_API_KEY";
const MODES = new Set(["text", "audio", "image", "video", "pdf"]);
const OPENAI_PACKAGE = "@ai-sdk/openai";
const OPENAI_COMPATIBLE_PACKAGE = "@ai-sdk/openai-compatible";
const CACHE = "public, max-age=0, s-maxage=60, must-revalidate";

type Config = Record<string, unknown>;

interface Cached {
  config: Config;
  opencode: string;
  wellknown: string;
}

function catalog(): ModelCard[] {
  return getCompiledModels().models;
}

function textCatalog(): ModelCard[] {
  return getModalityModels("text").filter((model) => getModelProtocolProfile(model).interactiveText);
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
      ...(Array.isArray(model.availableFrom) && model.availableFrom.length > 0
        ? { available_from: model.availableFrom }
        : {}),
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

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function modes(value: unknown): string[] {
  return list(value).filter((item) => MODES.has(item));
}

function limit(model: ModelCard): Record<string, number> | undefined {
  const context = record(model.contextWindow);
  const contextTokens = positive(model.contextWindow)
    ?? positive(context?.tokens)
    ?? positive(context?.contextTokens)
    ?? positive(context?.context_tokens)
    ?? positive(context?.inputTokens)
    ?? positive(context?.input_tokens);
  const output = positive(context?.outputTokens)
    ?? positive(context?.output_tokens)
    ?? positive(model.maxOutputTokens);
  const out: Record<string, number> = {};
  if (contextTokens !== undefined) out.context = contextTokens;
  if (output !== undefined) out.output = output;
  return Object.keys(out).length > 0 ? out : undefined;
}

function price(model: ModelCard): Record<string, number> | undefined {
  const pricing = record(model.pricing);
  const sections = Array.isArray(pricing?.sections) ? pricing.sections : [];
  const section = record(sections.find((item) => record(item)?.default === true)) || record(sections[0]);
  const entries = record(section?.entries) || pricing;
  if (!entries) return undefined;
  const input = nonNegative(entries.input);
  const output = nonNegative(entries.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = nonNegative(entries.cached_input) ?? nonNegative(entries.cache_read);
  const cacheWrite = nonNegative(entries.cache_write)
    ?? nonNegative(entries.cache_writes)
    ?? nonNegative(entries.input_token_cache_creation_5m);
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
  };
}

function meta(model: ModelCard): Record<string, unknown> {
  const input = list(model.input);
  const output = list(model.output);
  const profile = getModelProtocolProfile(model);
  const data: Record<string, unknown> = {
    name: model.name || model.modelId,
  };
  if (profile.reasoning) data.reasoning = true;
  if (profile.toolCalls) data.tool_call = true;
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
  if (!bounds || typeof bounds.context !== "number" || bounds.context <= 0) {
    return undefined;
  }

  return {
    context: bounds.context,
    output: typeof bounds.output === "number" ? bounds.output : 0,
  };
}

function externalProtocol(model: ModelCard): "chat" | "responses" {
  const capabilities = record(model.capabilities);
  return model.provider === "openai" || capabilities?.responses === true
    ? "responses"
    : "chat";
}

function ometa(model: ModelCard): Record<string, unknown> {
  const input = modes(model.input);
  const output = modes(model.output);
  const profile = getModelProtocolProfile(model);
  const data: Record<string, unknown> = {};
  if (model.name && model.name !== model.modelId) data.name = model.name;
  if (profile.family) data.family = profile.family;
  if (profile.reasoning) data.reasoning = true;
  data.tool_call = profile.toolCalls;
  if (profile.parallelToolCalls) data.options = { parallelToolCalls: true };
  if (externalProtocol(model) === "responses") data.provider = { npm: OPENAI_PACKAGE };
  if (input.length > 0 && output.length > 0) data.modalities = { input, output };
  if (input.some((item) => item !== "text")) data.attachment = true;
  const bounds = olimit(model);
  if (bounds) data.limit = bounds;
  const cost = price(model);
  if (cost) data.cost = cost;
  return data;
}

function origin(req: Request): string {
  return publicOriginFromRequest(req);
}

function headers(res: Response): void {
  res.setHeader("Cache-Control", CACHE);
  res.setHeader("CDN-Cache-Control", "public, s-maxage=60, must-revalidate");
  res.setHeader("Surrogate-Control", "max-age=60");
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
  const id = text(res.locals.externalModelId);
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

type ExternalProtocol = "chat" | "responses";
interface ExternalStreamState {
  sequence: number;
  buffer: string;
  isSse: boolean;
}

function responseFrameBody(
  res: Response,
  value: Record<string, unknown>,
  protocol: ExternalProtocol,
  state: ExternalStreamState,
): Record<string, unknown> {
  const shaped = body(res, value) as Record<string, unknown>;
  if (protocol !== "responses" || typeof shaped.type !== "string" || "sequence_number" in shaped) {
    return shaped;
  }
  return { ...shaped, sequence_number: state.sequence++ };
}

function frame(res: Response, value: string, protocol: ExternalProtocol, state: ExternalStreamState): string {
  if (/^event:\s*(receipt|compose\.receipt|compose\.video\.status|video\.status)/imu.test(value)) {
    return "";
  }

  if (/^event:\s*(compose\.error|error)/mu.test(value)) {
    const raw = data(value);
    let parsed: unknown = raw || "Request failed";
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    const shaped = error(parsed, res.statusCode);
    if (protocol === "responses") {
      return `data: ${JSON.stringify({
        type: "error",
        sequence_number: state.sequence++,
        code: shaped.code,
        message: shaped.message,
        param: shaped.param ?? null,
      })}\n\n`;
    }
    return `data: ${JSON.stringify({ error: shaped })}\n\n`;
  }

  const raw = data(value);
  if (!raw || raw === "[DONE]") {
    return value.endsWith("\n\n") ? value : `${value}\n\n`;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed !== "object"
      || (protocol === "chat" && !parsed.choices && !parsed.error)
    ) {
      return "";
    }
    return `data: ${JSON.stringify(responseFrameBody(res, parsed, protocol, state))}\n\n`;
  } catch {
    return value.endsWith("\n\n") ? value : `${value}\n\n`;
  }
}

export function shape(protocol: ExternalProtocol = "chat"): RequestHandler {
  return (_req, res, next) => {
    const streamState: ExternalStreamState = { sequence: 0, buffer: "", isSse: false };
    const json = res.json.bind(res);
    res.json = ((value?: unknown) => json(body(res, value))) as typeof res.json;

    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => Response;

    const drainSse = (flushAll: boolean): string => {
      let out = "";
      const boundary = /\r?\n\r?\n/;
      let match = boundary.exec(streamState.buffer);
      while (match) {
        const rawFrame = streamState.buffer.slice(0, match.index);
        streamState.buffer = streamState.buffer.slice(match.index + match[0].length);
        if (rawFrame.trim().length > 0) {
          out += frame(res, rawFrame, protocol, streamState);
        }
        match = boundary.exec(streamState.buffer);
      }
      if (flushAll && streamState.buffer.trim().length > 0) {
        const trailing = streamState.buffer;
        streamState.buffer = "";
        out += frame(res, trailing, protocol, streamState);
      }
      return out;
    };

    res.write = ((chunk: unknown, ...args: unknown[]) => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : null;
      if (value === null) {
        return write(chunk, ...args);
      }
      if (!streamState.isSse) {
        if (!/^(data|event):/mu.test(value)) {
          return write(chunk, ...args);
        }
        streamState.isSse = true;
      }
      streamState.buffer += value;
      const nextChunk = drainSse(false);
      if (nextChunk.length === 0) {
        const callback = args.find((arg): arg is () => void => typeof arg === "function");
        callback?.();
        return true;
      }
      return write(nextChunk, ...args);
    }) as typeof res.write;

    res.end = ((chunk?: unknown, ...args: unknown[]) => {
      if (streamState.isSse) {
        const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : "";
        if (value) {
          streamState.buffer += value;
        }
        const trailing = drainSse(true);
        if (trailing.length > 0) {
          write(trailing);
        }
        return end(...(typeof chunk === "function" ? [chunk, ...args] : args));
      }
      return end(chunk, ...args);
    }) as typeof res.end;

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
    // Keep qualified aliases (`openai/gpt-5.5`) intact so downstream routing
    // preserves the provider pin; bare ids resolve to the priority winner.
    source.model = typeof source.model === "string" && source.model.length > 0 ? source.model : resolved.id;
    res.locals.externalModelId = resolved.id;
    res.locals.externalResolvedModel = resolved.resolved;
    res.locals.externalCompatibility = true;
    res.locals.upstreamProvider = resolved.resolved.provider;
    res.locals.upstreamModel = resolved.upstreamModelId;
    res.locals.publicModel = resolved.id;
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
      const token = extractKeyFromHeader(authorization);
      if (!token) {
        fail(
          res,
          401,
          "Key authorization is required. Use Authorization: Bearer compose-...",
          "compose_key_required",
          "authentication_error",
        );
        return;
      }

      const validation = await validateKey(token, 0);
      if (!validation.valid || !validation.record) {
        fail(
          res,
          401,
          validation.error || "Invalid Key",
          "invalid_compose_key",
          "authentication_error",
        );
        return;
      }

      if (!validation.record.network) {
        fail(
          res,
          400,
          "Key is missing a network and cannot be used from OpenAI-compatible external clients.",
          "compose_key_network_required",
        );
        return;
      }

      req.headers["x-network-id"] = validation.record.network;
      req.headers["x-session-user-address"] = validation.record.userAddress;
      next();
    } catch (error) {
      fail(
        res,
        500,
        error instanceof Error ? error.message : "Key validation failed",
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
  const models = Object.fromEntries(textCatalog().map((model) => [
    model.modelId,
    ometa(model),
  ]));

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPEN]: {
        name: "Compose.Market",
        npm: OPENAI_COMPATIBLE_PACKAGE,
        options: {
          baseURL: `${base}/external/v1`,
          setCacheKey: true,
          includeUsage: true,
          ...(key ? { apiKey: `{env:${ENV}}` } : {}),
        },
        models,
      },
    },
  };
}

function cache(req: Request): Cached {
  const base = origin(req);
  const value = config(base, true);
  const clean = config(base, false);
  return {
    config: value,
    opencode: JSON.stringify(value),
    wellknown: JSON.stringify({
      auth: {
        command: ["sh", "-c", "printf 'compose-market'"],
        env: "COMPOSE_MARKET_WELLKNOWN",
      },
      config: clean,
    }),
  };
}

async function opencode(req: Request, res: Response): Promise<void> {
  send(res, cache(req).opencode);
}

async function wellknown(req: Request, res: Response): Promise<void> {
  send(res, cache(req).wellknown);
}

export function normalizeExternalChatRequest(body: Record<string, unknown>) {
  return normalizeChatRequest(body);
}

async function handleExternalChatCompletions(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    fail(res, 400, "messages is required and must be a non-empty array", "missing_messages");
    return;
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    fail(res, 400, "stream must be a boolean when provided", "invalid_stream");
    return;
  }
  const request = normalizeExternalChatRequest(body);
  await executeRequest({ req, res, request, shape: "chat", externalCompatibility: true });
}

async function handleExternalResponses(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    fail(res, 400, "stream must be a boolean when provided", "invalid_stream");
    return;
  }
  const request = normalizeResponsesRequest(body);
  if (request.messages.length === 0 && !request.previousResponseId) {
    fail(res, 400, "input is required", "missing_input");
    return;
  }
  await executeRequest({ req, res, request, shape: "responses", externalCompatibility: true });
}

function route(app: Express, method: "get" | "post", path: string, ...handlers: RequestHandler[]): void {
  app[method](path, ...handlers);
}

export function register(app: Express): void {
  const guard = auth();
  const resolve = resolveExternalModel();
  const shaped = shape("chat");
  const responsesShaped = shape("responses");

  route(app, "get", "/external/v1/models", asyncify(models));
  route(app, "get", "/external/v1/models/:model", asyncify(model));
  app.get(/^\/external\/v1\/models\/(.+)$/, (req, res, next) => {
    req.params.model = req.params[0];
    void model(req, res).catch(next);
  });
  route(app, "get", "/.well-known/opencode", asyncify(wellknown));
  route(app, "get", "/external/opencode", asyncify(opencode));

  route(app, "post", "/external/v1/chat/completions", resolve, shaped, guard, asyncify(handleExternalChatCompletions));
  route(app, "post", "/external/v1/responses", resolve, responsesShaped, guard, asyncify(handleExternalResponses));
  route(app, "post", "/external/v1/embeddings", resolve, shaped, guard, asyncify(handleEmbeddings));
  route(app, "post", "/external/v1/images/generations", resolve, shaped, guard, asyncify(handleImageGeneration));
  route(app, "post", "/external/v1/audio/speech", resolve, shaped, guard, asyncify(handleAudioSpeech));
  route(app, "post", "/external/v1/audio/transcriptions", resolve, shaped, guard, asyncify(handleAudioTranscription));
  route(app, "post", "/external/v1/videos/generations", resolve, shaped, guard, asyncify(handleVideoGeneration));
}
