import type { Application, NextFunction, Request, Response as ExpressResponse } from "express";

import { isNetworkId, isServiceBlockedNetwork, type NetworkId } from "./x402/configs/chains.js";
import {
  buildModelsPaymentRequired,
  buildOpenApiDocument,
  buildWellKnownX402,
  listModelCatalog,
  MODELS_ENTRYPOINT,
  MODELS_CATALOG,
} from "./x402/discovery.js";
import { encodePaymentRequiredHeader } from "./x402/facilitator.js";
import { publicOriginFromHost } from "./http/public-origin.js";
import { listReceipts } from "./x402/receipts.js";
import { searchAgents as searchAgentverseAgents } from "./agentverse.js";

interface PublicRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
}

interface PublicRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const FRAMEWORKS = [
  {
    id: "manowar",
    name: "Manowar",
    description: "Manowar agent framework",
  },
  {
    id: "other",
    name: "Other",
    description: "Compatibility category for agents minted with another framework",
  },
] as const;

function jsonResult(statusCode: number, headers: Record<string, string>, body: unknown): PublicRouteResult {
  return {
    statusCode,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function eventHeader(event: PublicRouteEvent, name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}

function eventSignedWithoutNetwork(event: PublicRouteEvent): boolean {
  const paymentSignature = eventHeader(event, "payment-signature");
  const network = eventHeader(event, "x-network-id");
  return Boolean(paymentSignature?.trim()) && !network?.trim();
}

function paymentRequiredResult(
  headers: Record<string, string>,
  paymentRequired: Awaited<ReturnType<typeof buildModelsPaymentRequired>>,
): PublicRouteResult {
  return jsonResult(402, {
    ...headers,
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
  }, paymentRequired);
}

function isEntrypoint(path: string, value: string): boolean {
  return path === value || path === `${value}/`;
}

export async function handlePublicRoute(
  event: PublicRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<PublicRouteResult | null> {
  const { rawPath: path } = event;
  const method = event.requestContext.http.method.toUpperCase();
  const publicOrigin = publicOriginFromHost(eventHeader(event, "host"));

  try {
    if (method === "GET" && path === "/openapi.json") {
      return jsonResult(200, corsHeaders, await buildOpenApiDocument(publicOrigin));
    }

    if (method === "GET" && path === "/.well-known/x402") {
      return jsonResult(200, corsHeaders, await buildWellKnownX402(publicOrigin));
    }

    if (method === "GET" && path === MODELS_CATALOG) {
      return jsonResult(200, corsHeaders, listModelCatalog(event.queryStringParameters, publicOrigin));
    }

    if (method === "POST" && isEntrypoint(path, MODELS_ENTRYPOINT)) {
      if (eventSignedWithoutNetwork(event)) {
        return jsonResult(400, corsHeaders, { error: "x-network-id header is required" });
      }
      const network = eventHeader(event, "x-network-id");
      if (network && isNetworkId(network) && isServiceBlockedNetwork(network)) {
        return jsonResult(400, corsHeaders, {
          error: `Network ${network} is not supported for this service. Use a Mainnet, or ask for Testnet access.`,
        });
      }
      return paymentRequiredResult(corsHeaders, await buildModelsPaymentRequired(publicOrigin));
    }

    if (method === "GET" && path === "/health") {
      return jsonResult(200, corsHeaders, {
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    if (method === "GET" && path === "/api/models") {
      return jsonResult(200, corsHeaders, listModelCatalog(event.queryStringParameters, publicOrigin));
    }

    if (method === "GET" && path === "/api/agentverse/agents") {
      const q = event.queryStringParameters || {};
      const result = await searchAgentverseAgents({
        search: q.search ?? q.q ?? undefined,
        category: q.category ?? undefined,
        tags: q.tags ? q.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        limit: q.limit ? Math.max(1, Math.min(100, Number.parseInt(q.limit, 10) || 30)) : undefined,
        offset: q.offset ? Math.max(0, Number.parseInt(q.offset, 10) || 0) : undefined,
        sort: q.sort as "relevancy" | "created-at" | "last-modified" | "interactions" | undefined,
        direction: q.direction === "asc" ? "asc" : "desc",
      });
      return jsonResult(200, corsHeaders, result);
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[public-routes] Error:", message);
    return jsonResult(500, corsHeaders, { error: message });
  }
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function receiptNetwork(req: Request): NetworkId | null {
  const raw = queryValue(req.query.network) ?? getHeader(req, "x-network-id");
  return raw && isNetworkId(raw) ? raw : null;
}

function receiptLimit(req: Request): number {
  const parsed = Number.parseInt(queryValue(req.query.limit) || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

function receiptIdentity(req: Request): { userAddress: string; network: NetworkId } | { error: string; status: number } {
  const raw = getHeader(req, "x-session-user-address");
  if (!raw) {
    return { error: "x-session-user-address header required", status: 401 };
  }
  const userAddress = raw.trim();
  const network = receiptNetwork(req);
  if (!userAddress || !network) return { error: "Valid x-network-id header required", status: 401 };
  return { userAddress, network };
}

function receiptsRoute() {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    const identity = receiptIdentity(req);
    if ("error" in identity) {
      res.status(identity.status).json({ error: identity.error });
      return;
    }

    void listReceipts({
      userAddress: identity.userAddress,
      network: identity.network,
      limit: receiptLimit(req),
      rootRunId: queryValue(req.query.rootRunId),
      executionRunId: queryValue(req.query.executionRunId),
    }).then((result) => res.status(200).json(result)).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Server-side Pinata pin proxy.
//
// Keeps PINATA_JWT server-side and forwards only the three pin operations
// the UI needs.
// ---------------------------------------------------------------------------

const PINATA_PIN_API_URL = "https://api.pinata.cloud";
const PIN_PROXY_LIMIT_BYTES = 10 * 1024 * 1024;

function pinataJwt(): string | null {
  const jwt = (process.env.PINATA_JWT || "").trim();
  return jwt.length > 0 ? jwt : null;
}

function readCappedBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PIN_PROXY_LIMIT_BYTES) {
        reject(new Error("pin_proxy_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyPinataPin(req: Request, res: ExpressResponse, pinataPath: string): Promise<void> {
  const jwt = pinataJwt();
  if (!jwt) {
    res.status(503).json({ error: "IPFS pinning is not configured" });
    return;
  }
  try {
    const rawBody = (req as Request & { rawBody?: unknown }).rawBody;
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : await readCappedBody(req);
    const body = new Uint8Array(buffer.byteLength);
    body.set(buffer);
    const contentType = req.headers["content-type"];
    const response = await fetch(`${PINATA_PIN_API_URL}${pinataPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(typeof contentType === "string" && contentType.length > 0
          ? { "Content-Type": contentType }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    res.status(response.status);
    if (response.headers.get("content-type")?.includes("application/json")) {
      res.type("application/json");
    }
    res.send(text);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error && error.message === "pin_proxy_body_too_large"
        ? "Upload exceeds the pin proxy size limit"
        : "IPFS pinning failed",
    });
  }
}

function payableJsonRoute(config: {
  service: string;
  action: string;
  pathAndQuery?: (req: Request) => string;
  resolveSettlement: (body: Record<string, unknown>, req: Request) => RouteSettlement | Promise<RouteSettlement>;
}) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      let prepared: PaymentPreparation | null = null;
      prepared = await prepareRoutePayment(req, res, config.service, config.action);
      if (!prepared) {
        lifecycle.cleanup();
        return;
      }

      try {
        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }

        const runtimeResponse = await callRuntime(
          req,
          config.pathAndQuery ? config.pathAndQuery(req) : req.originalUrl,
          prepared.runtimeHeaders,
          lifecycle.signal,
        );
        const { text, body } = await readRuntimeJson<Record<string, unknown>>(runtimeResponse);

        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }

        let settlement: RouteSettlement | null = null;
        if (body) {
          try {
            settlement = await config.resolveSettlement(body, req);
          } catch {
            settlement = null;
          }
        }

        if (!runtimeResponse.ok) {
          if (settlement) {
            await settlePreparedPayment(prepared, res, settlement);
          } else {
            await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
          }
          applyRuntimeHeaders(res, runtimeResponse);
          res.status(runtimeResponse.status).send(text);
          lifecycle.done();
          return;
        }

        if (!body) {
          await abortPreparedPayment(prepared, "runtime_missing_json_body");
          res.status(502).json({ error: "Runtime JSON body is required for metered settlement" });
          lifecycle.done();
          return;
        }

        if (!settlement) {
          try {
            settlement = await config.resolveSettlement(body, req);
          } catch (error) {
            await abortPreparedPayment(prepared, error instanceof Error ? error.message : "invalid_runtime_settlement");
            res.status(502).json({ error: error instanceof Error ? error.message : "invalid_runtime_settlement" });
            lifecycle.done();
            return;
          }
        }

        await settlePreparedPayment(prepared, res, settlement);
        applyRuntimeHeaders(res, runtimeResponse);
        res.status(runtimeResponse.status).send(text);
        lifecycle.done();
      } catch (error) {
        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }
        throw error;
      } finally {
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

function payableStreamRoute(config: {
  service: string;
  action: string;
  pathAndQuery?: (req: Request) => string;
  isSettlementEvent: (eventName: string, data: Record<string, unknown>) => boolean;
  resolveSettlement: (eventName: string, data: Record<string, unknown>, req: Request) => RouteSettlement | null | Promise<RouteSettlement | null>;
}) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void (async () => {
      const lifecycle = createRequestAbort(req, res);
      const requestReceivedAt = Date.now();
      const markTiming = createTimingLogger("api-stream-timing", {
        service: config.service,
        action: config.action,
        path: req.originalUrl,
      }, requestReceivedAt);
      markTiming("request_received", requestReceivedAt);
      const prepared = await prepareRoutePayment(req, res, config.service, config.action);
      if (!prepared) {
        lifecycle.cleanup();
        return;
      }
      markTiming("payment_prepared");

      if (lifecycle.aborted()) {
        await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
        lifecycle.cleanup();
        return;
      }

      writeSseOpen(res);
      markTiming("gateway_headers_flushed");
      markTiming("gateway_open_written");
      res.on("close", () => markTiming("close"));

      const writeGatewayError = (status: number, error: string) => {
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ error, status })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
        lifecycle.done();
      };

      let runtimeResponse: globalThis.Response;
      try {
        runtimeResponse = await callRuntime(
          req,
          config.pathAndQuery ? config.pathAndQuery(req) : req.originalUrl,
          prepared.runtimeHeaders,
          lifecycle.signal,
        );
      } catch (error) {
        if (lifecycle.aborted() || isAbortError(error)) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          lifecycle.cleanup();
          return;
        }
        const message = error instanceof Error ? error.message : "runtime_stream_unavailable";
        await abortPreparedPayment(prepared, message);
        writeGatewayError(502, message);
        return;
      }
      markTiming("runtime_response_headers");
      if (!runtimeResponse.ok) {
        const { text } = await readRuntimeJson(runtimeResponse);
        await abortPreparedPayment(prepared, `runtime_${runtimeResponse.status}`);
        writeGatewayError(runtimeResponse.status, text || `runtime_${runtimeResponse.status}`);
        return;
      }

      if (!runtimeResponse.body) {
        await abortPreparedPayment(prepared, "runtime_stream_missing_body");
        writeGatewayError(502, "Runtime stream body is missing");
        return;
      }

      applyRuntimeHeaders(res, runtimeResponse);

      const reader = runtimeResponse.body.getReader();
      const cancelReader = () => {
        void reader.cancel().catch(() => {
          // Best effort: the fetch signal already carries the shutdown reason.
        });
      };
      lifecycle.signal.addEventListener("abort", cancelReader, { once: true });
      let ended = false;
      let settlement: RouteSettlement | null = null;
      let terminalSettlementPromise: Promise<RouteSettlement | null> | null = null;
      let settlementPromise: Promise<Receipt | null> | null = null;
      let settlementDone = false;
      let receiptWritten = false;
      let sawExplicitErrorEvent = false;
      let buffer = "";
      const decoder = new TextDecoder();
      const networkHeader = getHeader(req, "x-network-id");
      const resolvedNetwork = networkHeader && isNetworkId(networkHeader) ? networkHeader : undefined;

      const canWrite = () => !res.destroyed && !res.writableEnded;
      const settleOnce = async () => {
        if (!settlement) {
          throw new Error("authoritative stream settlement is required");
        }
        settlementPromise ??= settlePreparedPayment(
          prepared,
          res,
          settlement,
          resolvedNetwork,
        ).then((receipt) => {
          settlementDone = true;
          markTiming("settled");
          return receipt;
        });
        return settlementPromise;
      };
      const writeReceipt = (receipt: Receipt | null) => {
        if (!receipt || receiptWritten || !canWrite()) {
          return;
        }
        // Streaming receipts must be emitted in-band. The underlying
        // Node response flushes headers on the first `res.write`, so any
        // settlement headers set after the stream starts are not visible to
        // clients. The gateway solves this by writing `event: receipt`
        // before ending the stream; the generic runtime paywall must do the
        // same for agent/workflow SSE routes.
        res.write(toReceiptStreamEvent(receiptStreamPayload(receipt)));
        receiptWritten = true;
        markTiming("receipt_written");
      };
      const takeSseBlock = (): string | null => {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) {
          return null;
        }
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        return rawEvent;
      };

      try {
        while (!ended) {
          if (lifecycle.aborted()) {
            await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            markTiming("runtime_stream_done");
            break;
          }

          markTiming("first_runtime_chunk");
          buffer += decoder.decode(value, { stream: true });
          let sawTerminalSettlement = false;
          let sawTerminalAbort = false;
          let terminalSettlementError: unknown = null;
          let terminalAbortData: Record<string, unknown> | null = null;
          while (true) {
            const rawEvent = takeSseBlock();
            if (rawEvent === null) {
              break;
            }
            const parsed = parseSseEventBlock(rawEvent);
            if (!parsed) {
              continue;
            }
            markTiming("first_upstream_sse_frame");
            if (
              parsed.data.type === "model_start"
              || (parsed.data.type === "timing" && parsed.data.mark === "model_start")
              || (parsed.data.domain === "model" && parsed.data.type === "model.start")
            ) {
              markTiming("first_runtime_model_start");
            }
            if (
              sseDataHasTextDelta(parsed.data)
              || (parsed.data.type === "timing" && parsed.data.mark === "first_text_delta")
            ) {
              markTiming("first_runtime_text_delta");
            }

            if (parsed.eventName === "error" || parsed.data.type === "error") {
              sawExplicitErrorEvent = true;
            }

            if (config.isSettlementEvent(parsed.eventName, parsed.data)) {
              terminalSettlementPromise ??= Promise.resolve().then(() =>
                config.resolveSettlement(parsed.eventName, parsed.data, req),
              );
              sawTerminalSettlement = true;
              markTiming("terminal_settlement_event");
            } else if (terminal(parsed.data)) {
              terminalAbortData = parsed.data;
              sawTerminalAbort = true;
              markTiming("terminal_abort_event");
            }
          }

          if (sawTerminalAbort && !settlement) {
            const text = Buffer.from(value).toString("utf8");
            markTiming("first_downstream_write");
            if (terminalAbortData && failclosed(terminalAbortData, terminalSettlementError)) {
              await abortPreparedPayment(prepared, terminalSettlementError instanceof Error ? terminalSettlementError.message : "invalid_runtime_settlement");
              if (canWrite()) {
                res.write(`event: error\ndata: ${JSON.stringify({
                  error: terminalSettlementError instanceof Error ? terminalSettlementError.message : "invalid_runtime_settlement",
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
              }
              lifecycle.done();
              ended = true;
              try {
                await reader.cancel();
              } catch {
                // best-effort; payment has already been aborted
              }
              break;
            }
            if (canWrite()) {
              res.write(text);
            }
            await abortPreparedPayment(prepared, "runtime_terminal_without_billable_usage");
            if (canWrite() && !text.includes("data: [DONE]")) {
              res.write("data: [DONE]\n\n");
            }
            if (canWrite()) {
              res.end();
            }
            lifecycle.done();
            ended = true;
            try {
              await reader.cancel();
            } catch {
              // best-effort; payment has already been aborted
            }
            break;
          }

          if (sawTerminalSettlement && terminalSettlementPromise) {
            const text = Buffer.from(value).toString("utf8");
            markTiming("first_downstream_write");
            if (canWrite()) {
              res.write(text);
            }
            if (canWrite() && !text.includes("data: [DONE]")) {
              res.write("data: [DONE]\n\n");
            }
            if (canWrite()) {
              res.end();
            }
            lifecycle.done();
            ended = true;
            try {
              await reader.cancel();
            } catch {
              // best-effort; the client stream is already complete
            }

            settlement = await terminalSettlementPromise;
            if (!settlement) {
              await abortPreparedPayment(prepared, "runtime_terminal_without_billable_usage");
              break;
            }
            await settleOnce();
            break;
          }

          markTiming("first_downstream_write");
          res.write(Buffer.from(value));
        }

        if (lifecycle.aborted()) {
          await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          return;
        }

        if (buffer.trim().length > 0) {
          const parsed = parseSseEventBlock(buffer);
          if (parsed) {
            if (parsed.eventName === "error" || parsed.data.type === "error") {
              sawExplicitErrorEvent = true;
            }
            let resolved: RouteSettlement | null = null;
            let terminalSettlementError: unknown = null;
            try {
              resolved = await config.resolveSettlement(parsed.eventName, parsed.data, req);
            } catch (error) {
              if (!terminal(parsed.data)) {
                throw error;
              }
              terminalSettlementError = error;
              markTiming("terminal_abort_event");
            }
            if (resolved) {
              settlement = resolved;
              markTiming("terminal_settlement_event");
            } else if (failclosed(parsed.data, terminalSettlementError)) {
              throw terminalSettlementError instanceof Error ? terminalSettlementError : new Error("invalid_runtime_settlement");
            }
          }
        }

        if (!settlement) {
          await abortPreparedPayment(prepared, "missing_authoritative_stream_settlement");
          if (!sawExplicitErrorEvent) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: "authoritative stream settlement is required" })}\n\n`);
          }
          res.end();
          lifecycle.done();
          return;
        }

        const receipt = await settleOnce();
        writeReceipt(receipt);
        if (canWrite()) {
          res.end();
        }
        lifecycle.done();
      } catch (error) {
        if (lifecycle.aborted() || isAbortError(error)) {
          if (!settlementDone) {
            await abortPreparedPayment(prepared, abortReason(lifecycle.signal));
          }
          try {
            await reader.cancel();
          } catch {
            // best-effort cleanup after a client abort
          }
          return;
        }
        if (settlement && !settlementDone) {
          const receipt = await settleOnce();
          writeReceipt(receipt);
        }
        if (!settlementDone) {
          await abortPreparedPayment(prepared, error instanceof Error ? error.message : "runtime_stream_failed");
        }
        try {
          await reader.cancel();
        } catch {
          // best-effort cleanup after a stream failure
        }
        if (!canWrite()) {
          return;
        }
        if (res.headersSent) {
          const message = error instanceof Error ? error.message : "runtime_stream_failed";
          res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        throw error;
      } finally {
        lifecycle.signal.removeEventListener("abort", cancelReader);
        lifecycle.cleanup();
      }
    })().catch(next);
  };
}

export function registerManowarRoutes(app: Application): void {
  app.use("/api/mcps", connectorsProxyRoute());
  app.use("/api/onchain", connectorsProxyRoute());
  app.get("/api/receipts", receiptsRoute());

  app.post("/api/ipfs/pin/file", (req, res) => {
    void proxyPinataPin(req, res, "/pinning/pinFileToIPFS");
  });
  app.post("/api/ipfs/pin/json", (req, res) => {
    void proxyPinataPin(req, res, "/pinning/pinJSONToIPFS");
  });
  app.delete("/api/ipfs/unpin/:cid", (req, res) => {
    const jwt = pinataJwt();
    if (!jwt) {
      res.status(503).json({ error: "IPFS pinning is not configured" });
      return;
    }
    const cid = req.params.cid || "";
    if (!/^[A-Za-z0-9]{20,128}$/.test(cid)) {
      res.status(400).json({ error: "Invalid CID" });
      return;
    }
    void fetch(`${PINATA_PIN_API_URL}/pinning/unpin/${cid}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(30_000),
    })
      .then(async (response) => {
        if (response.ok) {
          res.json({ ok: true, cid });
          return;
        }
        const text = await response.text().catch(() => "");
        res.status(response.status).json({ error: `Unpin failed (${response.status})`, detail: text.slice(0, 300) });
      })
      .catch(() => res.status(502).json({ error: "IPFS unpin failed" }));
  });

  app.post(
    "/agent/:walletAddress/stream",
    payableStreamRoute({
      service: "agent",
      action: "stream",
      isSettlementEvent: (_eventName, data) => (
        data.domain === "activity"
          ? (data.type === "activity.run" || data.type === "activity.error") && data.status !== "running"
          : data.type === "done" || data.type === "stopped" || data.type === "error"
      ),
      resolveSettlement: (_eventName, data, req) => {
        // Settle on any terminal event. The domain protocol closes every
        // stream with a non-running `activity.run` (completed/cancelled) or an
        // `activity.error`, both carrying `payload.usage`/`payload.agent` —
        // the runtime's opening `activity.run` frame has status `running` and
        // is NOT a terminal. The legacy wire names remain accepted so
        // pre-cutover runtimes still settle.
        const domainTerminal = data.domain === "activity"
          && (data.type === "activity.run" || data.type === "activity.error")
          && data.status !== "running";
        const legacyTerminal = data.type === "done" || data.type === "stopped" || data.type === "error";
        if (!domainTerminal && !legacyTerminal) {
          return null;
        }
        return resolveAgentTextSettlement(data, req, "stream");
      },
    }),
  );
  app.post(
    "/agent/:walletAddress/responses",
    payableJsonRoute({
      service: "agent",
      action: "responses",
      resolveSettlement: (body, req) => resolveAgentResponsesSettlement(body, req),
    }),
  );
  app.get("/agent/:walletAddress/runs/:runId/state", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/approval", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/connector", passthroughJsonRoute());
  app.post("/agent/:walletAddress/runs/:runId/stop", passthroughJsonRoute());
  app.get("/agent/:walletAddress/runs/:runId/events", passthroughStreamRoute());

  app.post(
    "/workflow/execute",
    payableJsonRoute({
      service: "workflow",
      action: "workflow-execute",
      resolveSettlement: (body, req) => resolveWorkflowSettlement(body, workflowSettlementSubject(req)),
    }),
  );
  app.get("/workflow/prices", passthroughJsonRoute());
  app.post("/api/workflow/triggers/parse", passthroughJsonRoute());
  app.get("/api/workflow/:walletAddress/triggers", passthroughJsonRoute());
  app.post("/api/workflow/:walletAddress/triggers", passthroughJsonRoute());
  app.put("/api/workflow/:walletAddress/triggers/:triggerId", passthroughJsonRoute());
  app.delete("/api/workflow/:walletAddress/triggers/:triggerId", passthroughJsonRoute());

  app.post("/api/workspace/index", passthroughJsonRoute());
  app.post("/api/workspace/search", passthroughJsonRoute());

  mount(app, memory);

  app.post(
    "/workflow/:walletAddress/stream",
    payableStreamRoute({
      service: "workflow",
      action: "workflow-stream",
      isSettlementEvent: (eventName) => eventName === "result",
      resolveSettlement: (eventName, data, req) => (
        eventName === "result"
          ? resolveWorkflowSettlement(data, workflowSettlementSubject(req))
          : null
      ),
    }),
  );
  app.post("/workflow/:walletAddress/stop", passthroughJsonRoute());
  app.get("/workflow/:walletAddress/runs/:runId/state", passthroughJsonRoute());
  app.post("/workflow/:walletAddress/runs/:runId/approval", passthroughJsonRoute());
  app.post(
    "/workflow/:id/run",
    payableStreamRoute({
      service: "workflow",
      action: "workflow-stream",
      isSettlementEvent: (eventName) => eventName === "result",
      resolveSettlement: (eventName, data, req) => (
        eventName === "result"
          ? resolveWorkflowSettlement(data, workflowSettlementSubject(req))
          : null
      ),
    }),
  );
  app.get("/frameworks", (_req, res) => {
    res.json({ frameworks: FRAMEWORKS });
  });
}
