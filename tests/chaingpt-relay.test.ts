/**
 * Tests for the ChainGPT chat relay route (`POST /chaingpt/chat`,
 * `api/handler.ts:handleChaingptRoutes` + `api/chaingpt.ts`).
 *
 * The connectors Worker cannot reach api.chaingpt.org (its Cloudflare-zone
 * edge rejects Worker-originated requests with TLS version "none"), so it
 * relays edge-gated ChainGPT calls through the api's GCP egress. The route
 * is internal-token gated with the same machinery as `/gated/resolve`;
 * first-party CHAIN_GPT_SECRET_KEY only.
 */
import "dotenv/config";

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { handler } from "../handler.js";
import { callChainGptChat } from "../chaingpt.js";

const ORIGINAL_FETCH = globalThis.fetch;
let lastFetchUrl: string | null = null;
let lastFetchBody: string | null = null;
let lastFetchHeaders: Record<string, string> | null = null;
let lastFetchStatuses: number[] = [];

function mockChainGptFetch(payload: unknown, status = 200, contentType = "text/plain"): void {
    lastFetchStatuses = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        lastFetchUrl = url;
        lastFetchBody = typeof init?.body === "string" ? init.body : null;
        lastFetchHeaders = (init?.headers ?? {}) as Record<string, string>;
        lastFetchStatuses.push(status);
        const body = typeof payload === "string" ? payload : JSON.stringify(payload);
        return new Response(body, { status, headers: { "Content-Type": contentType } });
    }) as typeof fetch;
}

function restoreFetch(): void {
    globalThis.fetch = ORIGINAL_FETCH;
}

function createEvent(method: string, rawPath: string, body?: unknown, headers?: Record<string, string>) {
    return {
        rawPath,
        requestContext: { http: { method } },
        headers: headers ?? {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
}