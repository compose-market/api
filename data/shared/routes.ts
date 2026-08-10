import type { Application, NextFunction, Request, RequestHandler, Response } from "express";

import {
  domainEventChannel,
  type EventName,
  type InvalidateEvent,
} from "./updates.js";
import { resolveWalletPair } from "../user/store.js";
import type { WalletPair } from "../user/types.js";
import {
  getEventBroker,
  type EventListener,
  type EventRelease,
} from "./broker.js";

const HEARTBEAT_MS = 25_000;
const LEASE_MS = 110_000;

export interface EventSubscriptionBroker {
  subscribe(channels: readonly string[], listener: EventListener): Promise<EventRelease>;
}

export interface EventRouteDependencies {
  resolvePair?: (address: string) => Promise<WalletPair>;
  broker?: EventSubscriptionBroker;
  heartbeatMs?: number;
  leaseMs?: number;
  retryAfterMs?: number;
}

function writeData(response: Response, data: unknown): void {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamError(error: unknown): Error & { statusCode: number } {
  if (error && typeof error === "object" && "statusCode" in error) {
    return error as Error & { statusCode: number };
  }
  return Object.assign(new Error("Domain event broker is unavailable", { cause: error }), { statusCode: 503 });
}

export function createEventsHandler(
  domain: EventName,
  dependencies: EventRouteDependencies = {},
): RequestHandler {
  const resolvePair = dependencies.resolvePair ?? resolveWalletPair;
  const broker = dependencies.broker ?? getEventBroker();
  const heartbeatMs = dependencies.heartbeatMs ?? HEARTBEAT_MS;
  const leaseMs = dependencies.leaseMs ?? LEASE_MS;
  const retryAfterMs = dependencies.retryAfterMs ?? 1_000 + Math.floor(Math.random() * 2_000);

  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      const lookupAddress = typeof request.query.userAddress === "string"
        ? request.query.userAddress.trim()
        : "";
      if (!lookupAddress) {
        throw Object.assign(new Error("userAddress query parameter required"), { statusCode: 400 });
      }

      const pair = await resolvePair(lookupAddress);
      const channels = [
        domainEventChannel(domain, pair.evmAddress),
        domainEventChannel(domain, pair.svmAddress),
      ];
      let ready = false;
      const pending: InvalidateEvent[] = [];
      let closed = false;
      let release: EventRelease;
      const onInvalidate: EventListener = (event) => {
        if (closed || event.domain !== domain) return;
        const sanitized: InvalidateEvent = {
          type: "invalidate",
          domain,
          reason: event.reason,
          timestamp: event.timestamp,
        };
        if (!ready) pending.push(sanitized);
        else writeData(response, sanitized);
      };

      try {
        release = await broker.subscribe(channels, onInvalidate);
      } catch (error) {
        throw streamError(error);
      }

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();

      let heartbeat: NodeJS.Timeout | null = null;
      let lease: NodeJS.Timeout | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lease) clearTimeout(lease);
        void release().catch((error) => console.error("[domain-events] unsubscribe failed", error));
        if (!response.writableEnded) response.end();
      };
      request.once("aborted", close);
      response.once("close", close);

      writeData(response, {
        type: "ready",
        domain,
        timestamp: new Date().toISOString(),
      });
      ready = true;
      for (const event of pending.splice(0)) writeData(response, event);

      heartbeat = setInterval(() => {
        if (!response.writableEnded) response.write(": heartbeat\n\n");
      }, heartbeatMs);
      lease = setTimeout(() => {
        writeData(response, {
          type: "lease",
          domain,
          timestamp: new Date().toISOString(),
          leaseMs,
          retryAfterMs,
        });
        close();
      }, leaseMs);
    })().catch(next);
  };
}

export function registerEventRoutes(app: Application): void {
  app.get("/api/keys/events", createEventsHandler("keys"));
  app.get("/api/analytics/inference/events", createEventsHandler("inference-analytics"));
}
