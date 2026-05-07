/**
 * Tests for the /api/agentverse/agents route (Phase 1.6)
 * `api/routes.ts:handlePublicRoute`
 *
 * The route was advertised in the startup banner but never registered.
 * We register it on the Express app via handler.ts and route the request
 * through `handlePublicRoute`, which calls `searchAgents` from
 * `api/external/agentverse.ts` and returns the upstream payload verbatim.
 */
import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { handlePublicRoute } from "../routes.js";

const ORIGINAL_FETCH = globalThis.fetch;
let lastFetchUrl: string | null = null;
let lastFetchBody: string | null = null;

function mockAgentverseFetch(payload: unknown, status = 200): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        lastFetchUrl = url;
        lastFetchBody = typeof init?.body === "string" ? init.body : null;
        return new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

function restoreFetch(): void {
    globalThis.fetch = ORIGINAL_FETCH;
}

test("GET /api/agentverse/agents returns agents from upstream", async () => {
    const upstream = {
        agents: [
            {
                address: "agent1",
                name: "Test Agent",
                description: "An agent",
                readme: "",
                protocols: [],
                avatar_href: null,
                total_interactions: 0,
                recent_interactions: 0,
                rating: 0,
                status: "active",
                type: "hosted",
                featured: false,
                category: "test",
                system_wide_tags: [],
                last_updated: "",
                created_at: "",
                owner: "",
            },
        ],
        total: 1,
        offset: 0,
        limit: 30,
    };
    mockAgentverseFetch(upstream);

    const result = await handlePublicRoute(
        {
            rawPath: "/api/agentverse/agents",
            requestContext: { http: { method: "GET" } },
            queryStringParameters: { search: "test" },
        },
        { "Content-Type": "application/json" },
    );
    restoreFetch();

    assert.ok(result, "expected a result, got null");
    assert.equal(result!.statusCode, 200);
    assert.equal(lastFetchUrl, "https://agentverse.ai/v1/search/agents");
    const body = JSON.parse(result!.body);
    assert.equal(body.total, 1);
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].name, "Test Agent");
    // Outbound search payload must include search_text.
    assert.ok(lastFetchBody);
    const sent = JSON.parse(lastFetchBody!);
    assert.equal(sent.search_text, "test");
});

test("GET /api/agentverse/agents accepts ?q= alias for search", async () => {
    mockAgentverseFetch({ agents: [], total: 0, offset: 0, limit: 30 });

    await handlePublicRoute(
        {
            rawPath: "/api/agentverse/agents",
            requestContext: { http: { method: "GET" } },
            queryStringParameters: { q: "weather" },
        },
        {},
    );
    restoreFetch();

    const sent = JSON.parse(lastFetchBody!);
    assert.equal(sent.search_text, "weather");
});

test("GET /api/agentverse/agents passes limit / offset / sort", async () => {
    mockAgentverseFetch({ agents: [], total: 0, offset: 5, limit: 10 });

    await handlePublicRoute(
        {
            rawPath: "/api/agentverse/agents",
            requestContext: { http: { method: "GET" } },
            queryStringParameters: {
                limit: "10",
                offset: "5",
                sort: "interactions",
                direction: "desc",
            },
        },
        {},
    );
    restoreFetch();

    const sent = JSON.parse(lastFetchBody!);
    assert.equal(sent.limit, 10);
    assert.equal(sent.offset, 5);
    assert.equal(sent.sort, "interactions");
    assert.equal(sent.direction, "desc");
});

test("GET /api/agentverse/agents tolerates missing query parameters", async () => {
    mockAgentverseFetch({ agents: [], total: 0, offset: 0, limit: 30 });

    const result = await handlePublicRoute(
        {
            rawPath: "/api/agentverse/agents",
            requestContext: { http: { method: "GET" } },
            // queryStringParameters intentionally omitted
        },
        {},
    );
    restoreFetch();

    assert.ok(result);
    assert.equal(result!.statusCode, 200);
});
