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

const INTERNAL_TOKEN = process.env.BACKPACK_INTERNAL_TOKEN?.trim();

test("POST /chaingpt/chat requires the internal token", async () => {
    if (!INTERNAL_TOKEN) return;

    const wrong = await handler(createEvent("POST", "/chaingpt/chat", { model: "smart_contract_auditor", question: "x" }, { "x-backpack-internal-token": "wrong" }), {});
    assert.equal(wrong.statusCode, 401);

    const missing = await handler(createEvent("POST", "/chaingpt/chat", { model: "smart_contract_auditor", question: "x" }), {});
    assert.equal(missing.statusCode, 401);
});

test("POST /chaingpt/chat validates model and question", async () => {
    if (!INTERNAL_TOKEN) return;
    const headers = { "x-backpack-internal-token": INTERNAL_TOKEN };

    const missingQuestion = await handler(createEvent("POST", "/chaingpt/chat", { model: "smart_contract_auditor" }, headers), {});
    assert.equal(missingQuestion.statusCode, 400);

    const unsupportedModel = await handler(createEvent("POST", "/chaingpt/chat", { model: "some_other_model", question: "x" }, headers), {});
    assert.equal(unsupportedModel.statusCode, 400);
    assert.equal(JSON.parse(String(unsupportedModel.body)).error, "unsupported model: some_other_model");
});

test("POST /chaingpt/chat relays the chat call with the api-side key", async () => {
    if (!INTERNAL_TOKEN || !process.env.CHAIN_GPT_SECRET_KEY?.trim()) return;
    const headers = { "x-backpack-internal-token": INTERNAL_TOKEN };

    // Live plain-text shape (HTTP 201).
    mockChainGptFetch("The contract is safe.", 201);
    const ok = await handler(
        createEvent("POST", "/chaingpt/chat", { model: "smart_contract_auditor", question: "Audit:\n```solidity\ncontract X {}\n```" }, headers),
        {},
    );
    assert.equal(ok.statusCode, 200);
    const payload = JSON.parse(String(ok.body));
    assert.equal(payload.ok, true);
    assert.equal(payload.answer, "The contract is safe.");
    assert.equal(lastFetchUrl, "https://api.chaingpt.org/chat/stream");
    assert.equal(lastFetchHeaders?.Authorization, `Bearer ${process.env.CHAIN_GPT_SECRET_KEY.trim()}`);
    const sentBody = JSON.parse(String(lastFetchBody));
    assert.equal(sentBody.model, "smart_contract_auditor");
    assert.equal(sentBody.chatHistory, "off");
    assert.equal(sentBody.question.includes("contract X {}"), true);
    restoreFetch();

    // Documented JSON blob shape.
    mockChainGptFetch({ status: true, message: "OK", data: { bot: "contract Token {}" } }, 200, "application/json");
    const blob = await handler(createEvent("POST", "/chaingpt/chat", { model: "smart_contract_generator", question: "a token" }, headers), {});
    assert.equal(blob.statusCode, 200);
    assert.equal(JSON.parse(String(blob.body)).answer, "contract Token {}");
    restoreFetch();

    // Provider error body maps to the relay error envelope.
    mockChainGptFetch({ status: false, message: "Insufficient credits. Your balance is 0.0 credits." }, 200, "application/json");
    const error = await handler(createEvent("POST", "/chaingpt/chat", { model: "smart_contract_auditor", question: "x" }, headers), {});
    assert.equal(error.statusCode, 200);
    const errorPayload = JSON.parse(String(error.body));
    assert.equal(errorPayload.ok, false);
    assert.equal(errorPayload.error, "Insufficient credits. Your balance is 0.0 credits.");
    restoreFetch();
});

test("callChainGptChat handles a missing api key", async () => {
    const previous = process.env.CHAIN_GPT_SECRET_KEY;
    process.env.CHAIN_GPT_SECRET_KEY = "";
    try {
        const result = await callChainGptChat({ model: "general_assistant", question: "hi" });
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error.includes("CHAIN_GPT_SECRET_KEY"), true);
        }
    } finally {
        process.env.CHAIN_GPT_SECRET_KEY = previous;
    }
});

after(() => {
    restoreFetch();
});
