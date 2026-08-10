import type { Application, NextFunction, Request, Response } from "express";

import { build } from "./aggregate.js";
import type { Filters, Interval, RequestStatus, SettlementStatus } from "./types.js";
import { isNetworkId, type NetworkId } from "../../../x402/configs/chains.js";
import { validateSvmAddress } from "@x402/svm";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const REQUEST_STATUSES = new Set<RequestStatus>(["succeeded", "failed", "aborted"]);
const SETTLEMENT_STATUSES = new Set<SettlementStatus>(["queued", "submitted", "claimed", "settled", "failed"]);
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

function networks(input: unknown): NetworkId[] | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") throw Object.assign(new Error("Invalid networks"), { statusCode: 400 });
  const raw = input.trim();
  if (!raw) return undefined;
  const parsed = raw.split(",").map((network) => network.trim());
  if (parsed.some((network) => !network || !isNetworkId(network))) {
    throw Object.assign(new Error("Invalid networks"), { statusCode: 400 });
  }
  return [...new Set(parsed)].sort() as NetworkId[];
}

export function parseFilters(query: Request["query"]): Filters {
  if (query.network !== undefined) {
    throw Object.assign(new Error("Invalid network filter; use networks"), { statusCode: 400 });
  }
  return {
    networks: networks(query.networks), family: value(query.family), model: value(query.model),
    type: value(query.type), operation: value(query.operation),
    status: member(query.status, REQUEST_STATUSES, "status"),
    settlementStatus: member(query.settlementStatus, SETTLEMENT_STATUSES, "settlementStatus"),
    from: value(query.from), to: value(query.to), interval: member(query.interval, INTERVALS, "interval"),
    limit: positiveInteger(query.limit), requestCursor: value(query.requestCursor),
    settlementCursor: value(query.settlementCursor),
  };
}

function handler(req: Request, res: Response, next: NextFunction): void {
  const address = value(req.get("x-session-user-address"));
  const validAddress = EVM_ADDRESS.test(address || "") || validateSvmAddress(address || "");
  if (!validAddress) {
    res.status(401).json({ error: "Validated wallet session required" });
    return;
  }
  void build(address!, parseFilters(req.query))
    .then((result) => res.status(200).json(result)).catch(next);
}

export function register(app: Application): void {
  app.get("/api/analytics/inference", handler);
}
