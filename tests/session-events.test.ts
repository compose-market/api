import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { createSessionEventsHandler } from "../x402/keys/sse.js";
import type { ActiveSessionStatus } from "../x402/keys/types.js";

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../x402/keys/sse.ts"),
  "utf8",
);

test("session events route has a finite lease without single-subscriber gating", () => {
  assert.match(SOURCE, /DEFAULT_LEASE_MS/);
  assert.match(SOURCE, /SESSION_EVENTS_LEASE_MS/);
  assert.match(SOURCE, /event: \$\{event\}/);
  assert.match(SOURCE, /["']session-lease["']/);
  assert.doesNotMatch(SOURCE, /status\s*\(\s*204\s*\)/);
  assert.doesNotMatch(SOURCE, /duplicate/i);
  assert.doesNotMatch(SOURCE, /userAddress.*chainId.*Map|Map.*userAddress.*chainId/s);
});

test("session events route remains a normal SSE stream with lease metadata", () => {
  assert.match(SOURCE, /Content-Type["']\s*,\s*["']text\/event-stream/);
  assert.match(SOURCE, /X-Session-Events-Lease-Ms/);
  assert.match(SOURCE, /X-Session-Events-Retry-Ms/);
  assert.match(SOURCE, /writeEvent\(res,\s*["']ping["']/);
  assert.match(SOURCE, /writeExpiredEvent\(/);
  assert.match(SOURCE, /writeLeaseEvent\(/);
  assert.match(SOURCE, /req\.on\(["']close["'],\s*closeStream\)/);
  assert.match(SOURCE, /res\.on\(["']close["'],\s*closeStream\)/);
});

test("session events close path clears all timers", () => {
  const clearTimersStart = SOURCE.indexOf("const clearTimers = () =>");
  const closeStreamStart = SOURCE.indexOf("const closeStream = () =>");
  assert.ok(clearTimersStart > 0);
  assert.ok(closeStreamStart > clearTimersStart);

  const clearTimersBody = SOURCE.slice(clearTimersStart, closeStreamStart);
  assert.match(clearTimersBody, /clearTimeout\(expiryTimer\)/);
  assert.match(clearTimersBody, /clearInterval\(refreshTimer\)/);
  assert.match(clearTimersBody, /clearInterval\(heartbeatTimer\)/);
  assert.match(clearTimersBody, /clearTimeout\(leaseTimer\)/);
});

const USER = "0x058271e764154c322f3d3ddc18af44f7d91b1c80";
const CHAIN = 43113;

class FakeRequest extends EventEmitter {
  query = { userAddress: USER, chainId: String(CHAIN) };
  destroyed = false;
  complete = true;

  header(name: string): string | undefined {
    if (name.toLowerCase() === "x-session-user-address") return USER;
    if (name.toLowerCase() === "x-chain-id") return String(CHAIN);
    return undefined;
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  headers = new Map<string, string>();
  chunks: string[] = [];

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }

  end(): void {
    this.writableEnded = true;
    this.writableFinished = true;
  }

  json(body: unknown): void {
    this.setHeader("Content-Type", "application/json");
    this.write(JSON.stringify(body));
    this.end();
  }

  flushHeaders(): void {
    // Express compatibility for the route under test.
  }

  text(): string {
    return this.chunks.join("");
  }
}

function active(expiresAt = Date.now() + 10 * 60_000): ActiveSessionStatus {
  return {
    reason: "none",
    session: {
      keyId: "session-test-key",
      token: "compose-test",
      budgetLimit: 100_000,
      budgetUsed: 1_000,
      budgetLocked: 0,
      budgetRemaining: 99_000,
      expiresAt,
      chainId: CHAIN,
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("session events allows multiple subscribers for the same user and chain", async () => {
  const status = async () => active();
  const handle = createSessionEventsHandler(status, { leaseMs: 60_000, retryMs: 1_000, jitterMs: 0 });
  const firstReq = new FakeRequest();
  const firstRes = new FakeResponse();
  const secondReq = new FakeRequest();
  const secondRes = new FakeResponse();

  handle(firstReq as never, firstRes as never);
  handle(secondReq as never, secondRes as never);
  await settle();

  assert.equal(firstRes.statusCode, 200);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(firstRes.headers.get("content-type"), "text/event-stream");
  assert.equal(secondRes.headers.get("content-type"), "text/event-stream");
  assert.equal(firstRes.headers.get("x-session-events-lease-ms"), "60000");
  assert.equal(secondRes.headers.get("x-session-events-retry-ms"), "1000");
  assert.match(firstRes.text(), /event: session-active/);
  assert.match(secondRes.text(), /event: session-active/);
  assert.equal(firstRes.writableEnded, false);
  assert.equal(secondRes.writableEnded, false);

  firstReq.emit("close");
  secondReq.emit("close");
});

test("session events rotates a healthy stream at the finite lease boundary", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  try {
    let calls = 0;
    const handle = createSessionEventsHandler(async () => {
      calls += 1;
      return active(Date.now() + 10 * 60_000);
    }, { leaseMs: 60_000, retryMs: 1_000, jitterMs: 0 });
    const req = new FakeRequest();
    const res = new FakeResponse();

    handle(req as never, res as never);
    await settle();
    assert.match(res.text(), /event: session-active/);

    mock.timers.tick(56_000);
    await settle();

    assert.equal(res.writableEnded, false);
    assert.match(res.text(), /event: ping/);
    assert.ok(calls > 1, "refresh loop should still be alive for healthy sessions");

    mock.timers.tick(4_000);
    await settle();

    assert.equal(res.writableEnded, true);
    assert.match(res.text(), /event: compose\.alert/);
    assert.match(res.text(), /"code":"session_events_lease_rotate"/);
    assert.match(res.text(), /event: session-lease/);
    assert.match(res.text(), /"reason":"lease-expired"/);
    assert.match(res.text(), /"retryAfterMs":1000/);

    const before = calls;
    mock.timers.tick(30_000);
    await settle();
    assert.equal(calls, before);
    assert.equal(res.writableEnded, true);
  } finally {
    mock.timers.reset();
  }
});
