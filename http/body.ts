import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import { buildError } from "./errors.js";

const DEFAULT = 10 * 1024 * 1024;
const MAX = 32 * 1024 * 1024;
type Env = Partial<Record<"API_BODY_LIMIT", string | undefined>>;

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

function parse(value: string | undefined): number {
  if (!value) {
    return DEFAULT;
  }

  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/.exec(trimmed);
  if (!match) {
    return DEFAULT;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return DEFAULT;
  }

  const unit = match[2] || "b";
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  return Math.floor(amount * multiplier);
}

export function bytes(env: Env = process.env): number {
  return Math.min(parse(env.API_BODY_LIMIT), MAX);
}

export function json(env: Env = process.env): RequestHandler {
  return express.json({
    limit: bytes(env),
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  });
}

export function form(env: Env = process.env): RequestHandler {
  return express.urlencoded({
    extended: false,
    limit: bytes(env),
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  });
}

function external(req: Request): boolean {
  return req.originalUrl.startsWith("/external/") || req.path.startsWith("/external/");
}

function openai(message: string, code: string, status: number) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code,
    },
  };
}

function parser(err: unknown): { status: number; message: string; code: string } | null {
  const record = err && typeof err === "object" ? err as Record<string, unknown> : null;
  const status = typeof record?.status === "number"
    ? record.status
    : typeof record?.statusCode === "number"
      ? record.statusCode
      : undefined;
  const type = typeof record?.type === "string" ? record.type : "";
  const message = typeof record?.message === "string" ? record.message : "Invalid request body";

  if (status === 413 || type === "entity.too.large") {
    const limit = typeof record?.limit === "number" && Number.isFinite(record.limit)
      ? record.limit
      : bytes();
    return {
      status: 413,
      message: `Request body exceeds the ${limit} byte limit`,
      code: "request_entity_too_large",
    };
  }

  if (status === 400 || type.startsWith("entity.") || err instanceof SyntaxError) {
    return {
      status: 400,
      message,
      code: "invalid_request_body",
    };
  }

  return null;
}

export function errors(): ErrorRequestHandler {
  return (err, req, res, next) => {
    const parsed = parser(err);
    if (!parsed) {
      next(err);
      return;
    }

    if (res.headersSent) {
      next(err);
      return;
    }

    res.status(parsed.status).json(external(req)
      ? openai(parsed.message, parsed.code, parsed.status)
      : buildError("validation_error", parsed.message, { code: parsed.code }));
  };
}
