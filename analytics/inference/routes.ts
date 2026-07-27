import type { Application, NextFunction, Request, Response } from "express";

import { build } from "./aggregate.js";
import type { Filters, Interval, RequestStatus, SettlementStatus } from "./types.js";
import { isNetworkId } from "../../x402/configs/chains.js";
import { validateSvmAddress } from "@x402/svm";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const REQUEST_STATUSES = new Set<RequestStatus>(["succeeded", "failed", "aborted"]);
const SETTLEMENT_STATUSES = new Set<SettlementStatus>(["queued", "claimed", "settled", "failed"]);
const INTERVALS = new Set<Interval>(["minute", "hour", "day"]);

function value(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function positiveInteger(input: unknown): number | undefined {
  const raw = value(input);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw Object.assign(new Error("Expected a positive integer"), { statusCode: 400 });
  return parsed;
}

function member<T extends string>(input: unknown, values: Set<T>, name: string): T | undefined {
  const raw = value(input);
  if (!raw) return undefined;
  if (!values.has(raw as T)) throw Object.assign(new Error(`Invalid ${name}`), { statusCode: 400 });
  return raw as T;
}

function filters(req: Request): Filters {
  const network = value(req.query.network);
  if (network && !isNetworkId(network)) throw Object.assign(new Error("Invalid network"), { statusCode: 400 });
  return {
    network: network as Filters["network"], family: value(req.query.family), model: value(req.query.model),
    type: value(req.query.type), operation: value(req.query.operation),
    status: member(req.query.status, REQUEST_STATUSES, "status"),
    settlementStatus: member(req.query.settlementStatus, SETTLEMENT_STATUSES, "settlementStatus"),
    from: value(req.query.from), to: value(req.query.to), interval: member(req.query.interval, INTERVALS, "interval"),
    limit: positiveInteger(req.query.limit), requestCursor: value(req.query.requestCursor),
    settlementCursor: value(req.query.settlementCursor),
  };
}

function handler(req: Request, res: Response, next: NextFunction): void {
  const address = value(req.get("x-session-user-address"));
  const validAddress = EVM_ADDRESS.test(address || "") || validateSvmAddress(address || "");
  if (!validAddress) {
    res.status(401).json({ error: "Validated wallet session required" });
    return;
  }
  void build(address!, filters(req))
    .then((result) => res.status(200).json(result)).catch(next);
}

export function register(app: Application): void {
  app.get("/api/analytics/inference", handler);
}
