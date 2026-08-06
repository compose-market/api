import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import express from "express";

import {
  DomainEventBroker,
  type DomainSubscriberClient,
} from "../data/shared/broker.js";
import {
  createDomainEventsHandler,
} from "../data/shared/routes.js";
import { domainEventChannel } from "../data/shared/updates.js";

class FakeSubscriber implements DomainSubscriberClient {
  readonly subscribed: string[][] = [];
  readonly unsubscribed: string[][] = [];
  private message?: (channel: string, message: string) => void;

  on(event: "message" | "error", listener: (...args: any[]) => void): this {
    if (event === "message") this.message = listener;
    return this;
  }

  async subscribe(...channels: string[]): Promise<unknown> {
    this.subscribed.push(channels);
    return channels.length;
  }

  async unsubscribe(...channels: string[]): Promise<unknown> {
    this.unsubscribed.push(channels);
    return channels.length;
  }

  emit(channel: string, message: unknown): void {
    this.message?.(channel, typeof message === "string" ? message : JSON.stringify(message));
  }
}

test("one domain broker multiplexes channels, sanitizes messages, and reference-counts unsubscription", async () => {
  const client = new FakeSubscriber();
  let factories = 0;
  const broker = new DomainEventBroker(async () => {
    factories += 1;
    return client;
  });
  const first: unknown[] = [];
  const second: unknown[] = [];

  const releaseFirst = await broker.subscribe(["channel:a", "channel:b"], (event) => first.push(event));
  const releaseSecond = await broker.subscribe(["channel:a"], (event) => second.push(event));
  assert.equal(factories, 1);
  assert.deepEqual(client.subscribed, [["channel:a", "channel:b"]]);

  client.emit("channel:a", {
    type: "invalidate",
    domain: "keys",
    reason: "budget",
    timestamp: "2026-08-02T12:00:00.000Z",
    token: "must-not-pass",
  });
  assert.deepEqual(first, [{
    type: "invalidate",
    domain: "keys",
    reason: "budget",
    timestamp: "2026-08-02T12:00:00.000Z",
  }]);
  assert.deepEqual(second, first);

  await releaseFirst();
  assert.deepEqual(client.unsubscribed, [["channel:b"]]);
  await releaseSecond();
  assert.deepEqual(client.unsubscribed, [["channel:b"], ["channel:a"]]);
});

test("domain SSE subscribes to both pair aliases before ready and emits sanitized heartbeat and lease frames", async () => {
  const evmAddress = `0x${"11".repeat(20)}`;
  const svmAddress = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq";
  let subscribed = false;
  let released = 0;
  let listener: ((event: any) => void) | undefined;
  let channels: readonly string[] = [];
  const app = express();
  app.get("/api/keys/events", createDomainEventsHandler("keys", {
    resolvePair: async () => ({ evmAddress, svmAddress }),
    broker: {
      async subscribe(nextChannels, nextListener) {
        channels = nextChannels;
        listener = nextListener;
        subscribed = true;
        setTimeout(() => nextListener({
          type: "invalidate",
          domain: "keys",
          reason: "created",
          timestamp: "2026-08-02T12:00:00.000Z",
          signature: "must-not-pass",
        } as any), 0);
        return async () => { released += 1; };
      },
    },
    heartbeatMs: 5,
    leaseMs: 30,
    retryAfterMs: 7,
  }));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/keys/events?userAddress=${evmAddress}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const body = await response.text();
    assert.equal(subscribed, true);
    assert.deepEqual(channels, [
      domainEventChannel("keys", evmAddress),
      domainEventChannel("keys", svmAddress),
    ]);
    assert.match(body, /: heartbeat\n\n/);
    const frames = body.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    assert.deepEqual(frames.map((frame) => frame.type), ["ready", "invalidate", "lease"]);
    assert.deepEqual(Object.keys(frames[0]!).sort(), ["domain", "timestamp", "type"]);
    assert.deepEqual(Object.keys(frames[1]!).sort(), ["domain", "reason", "timestamp", "type"]);
    assert.deepEqual(Object.keys(frames[2]!).sort(), ["domain", "leaseMs", "retryAfterMs", "timestamp", "type"]);
    assert.equal(frames[2]!.leaseMs, 30);
    assert.equal(frames[2]!.retryAfterMs, 7);
    assert.equal(released, 1);
    assert.equal(listener !== undefined, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("domain stream routes are mounted before generic key handling without changing session SSE", async () => {
  const [index, sessionSse] = await Promise.all([
    readFile(join(process.cwd(), "index.ts"), "utf8"),
    readFile(join(process.cwd(), "x402/keys/sse.ts"), "utf8"),
  ]);
  assert.match(index, /registerDomainEventRoutes/);
  assert.ok(index.indexOf("registerDomainEventRoutes(app)") < index.indexOf("registerHandlerRoutes(app)"));
  assert.doesNotMatch(sessionSse, /DomainEventBroker|inference-analytics|\/api\/keys\/events/);
});
