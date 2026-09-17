import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutingTargets, runWithPolicy, type PolicyContext } from "../inference/policy.js";
import type { ModelCard } from "../inference/types.js";

function card(routes: NonNullable<ModelCard["providerRoutes"]>): ModelCard {
    return {
        modelId: "glm-5.2",
        name: "GLM 5.2",
        provider: routes[0]!.provider,
        type: "text generation",
        description: null,
        input: null,
        output: null,
        contextWindow: null,
        pricing: null,
        providerRoutes: routes,
    };
}

const GLM_ROUTES = [
    { provider: "fireworks" as const, upstreamModelId: "accounts/fireworks/models/glm-5p2", pricing: null },
    { provider: "cloudflare" as const, upstreamModelId: "@cf/zai-org/glm-5.2", pricing: null },
    { provider: "deepinfra" as const, upstreamModelId: "zai-org/GLM-5.2", pricing: null },
    { provider: "alibaba" as const, upstreamModelId: "glm-5.2", pricing: null },
];

test("buildRoutingTargets orders the priority winner first and caps the chain at three", () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };

    const targets = buildRoutingTargets(context);

    assert.deepEqual(targets.map((target) => [target.provider, target.wireModelId, target.reason]), [
        ["fireworks", "accounts/fireworks/models/glm-5p2", "primary"],
        ["cloudflare", "@cf/zai-org/glm-5.2", "fallback"],
        ["deepinfra", "zai-org/GLM-5.2", "fallback"],
    ]);
});

test("buildRoutingTargets starts the chain at a pinned provider from a qualified request", () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "alibaba",
        wireModelId: "glm-5.2",
        card: card(GLM_ROUTES),
    };

    const targets = buildRoutingTargets(context);

    assert.equal(targets[0]?.provider, "alibaba");
    assert.equal(targets[0]?.reason, "primary");
    assert.equal(targets[0]?.wireModelId, "glm-5.2");
    // Remaining targets follow the priority matrix.
    assert.deepEqual(targets.slice(1).map((target) => target.provider), ["fireworks", "cloudflare"]);
});

test("buildRoutingTargets falls back to a single primary target for route-less cards", () => {
    const context: PolicyContext = {
        modelId: "qwen-max",
        provider: "alibaba",
        wireModelId: "qwen-max",
        card: null,
    };

    const targets = buildRoutingTargets(context);

    assert.deepEqual(targets, [{
        modelId: "qwen-max",
        wireModelId: "qwen-max",
        provider: "alibaba",
        reason: "primary",
    }]);
});

test("runWithPolicy advances to the next provider only after transient retries are exhausted", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const calls: Array<{ provider: string; wireModelId: string; attempt: number }> = [];
    const attemptsPerProvider = new Map<string, number>();

    const result = await runWithPolicy({
        context,
        retriesPerTarget: 1,
        execute: async (target, attempt) => {
            calls.push({ provider: target.provider, wireModelId: target.wireModelId, attempt });
            const seen = (attemptsPerProvider.get(target.provider) ?? 0) + 1;
            attemptsPerProvider.set(target.provider, seen);
            if (target.provider === "fireworks") {
                throw Object.assign(new Error("upstream 503"), { status: 503 });
            }
            return `served by ${target.provider}`;
        },
    });

    assert.equal(result.result, "served by cloudflare");
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.final.provider, "cloudflare");
    assert.equal(result.primary.provider, "fireworks");
    assert.equal(attemptsPerProvider.get("fireworks"), 2); // 1 retry, then fallback
    assert.equal(attemptsPerProvider.get("cloudflare"), 1);
    assert.equal(result.attempts, 3);
    // The fallback target must receive that provider's own wire ID.
    assert.equal(calls[2]?.wireModelId, "@cf/zai-org/glm-5.2");
});

test("runWithPolicy fails fast on payment and authentication errors without fallback", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    await assert.rejects(
        runWithPolicy({
            context,
            retriesPerTarget: 1,
            execute: async (target) => {
                providers.push(target.provider);
                throw new Error("payment required: budget exceeded");
            },
        }),
        /payment required/,
    );

    assert.deepEqual(providers, ["fireworks"]);
});

test("runWithPolicy does not fall back for non-transient client errors", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    await assert.rejects(
        runWithPolicy({
            context,
            retriesPerTarget: 1,
            execute: async (target) => {
                providers.push(target.provider);
                throw Object.assign(new Error("invalid request"), { status: 400 });
            },
        }),
        /invalid request/,
    );

    assert.deepEqual(providers, ["fireworks"]);
});

test("runWithPolicy honors explicit non-retryable errors", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    await assert.rejects(runWithPolicy({
        context,
        retriesPerTarget: 2,
        execute: async (target) => {
            providers.push(target.provider);
            throw Object.assign(new Error("generation deadline elapsed"), { statusCode: 504, retryable: false });
        },
    }), /generation deadline elapsed/);

    assert.deepEqual(providers, ["fireworks"]);
});

test("zero retries still advances to a fallback provider for transient statuses", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    const result = await runWithPolicy({
        context,
        retriesPerTarget: 0,
        execute: async (target) => {
            providers.push(target.provider);
            if (target.provider === "fireworks") {
                throw Object.assign(new Error("request timeout"), { statusCode: 408 });
            }
            return target.provider;
        },
    });

    assert.equal(result.result, "cloudflare");
    assert.deepEqual(providers, ["fireworks", "cloudflare"]);
});

test("runWithPolicy retries the primary and succeeds without fallback", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    let calls = 0;

    const result = await runWithPolicy({
        context,
        retriesPerTarget: 2,
        execute: async (target) => {
            calls += 1;
            if (calls === 1) {
                throw Object.assign(new Error("rate limit hit"), { status: 429 });
            }
            return "primary output";
        },
    });

    assert.equal(result.result, "primary output");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.final.provider, "fireworks");
    assert.equal(calls, 2);
});

test("plain vendor errors carrying a 5xx only in the message text advance to the fallback provider", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    const result = await runWithPolicy({
        context,
        retriesPerTarget: 1,
        execute: async (target) => {
            providers.push(target.provider);
            if (target.provider === "fireworks") {
                // Shape thrown by catalog/vendors/fireworks.ts, deepinfra.ts, vertex.ts.
                throw new Error("Fireworks image generation failed: 503 Service Unavailable — {\"error\":{\"code\":\"overloaded\"}}");
            }
            return "served by cloudflare";
        },
    });

    assert.equal(result.result, "served by cloudflare");
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.final.provider, "cloudflare");
    // One retry on the primary (text-level 5xx detection), then fallback.
    assert.deepEqual(providers, ["fireworks", "fireworks", "cloudflare"]);
});

test("plain vendor errors carrying a 4xx in the message text fail without fallback", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    await assert.rejects(
        runWithPolicy({
            context,
            retriesPerTarget: 0,
            execute: async (target) => {
                providers.push(target.provider);
                throw new Error("DeepInfra TTS failed: 400 - {\"error\":{\"message\":\"invalid voice\"}}");
            },
        }),
        /DeepInfra TTS failed: 400/,
    );

    assert.deepEqual(providers, ["fireworks"]);
});

test("streaming fallback engages when the primary provider fails before its first event", async () => {
    const { primedStream } = await import("../inference/engine.js");
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    const route = await runWithPolicy({
        context,
        retriesPerTarget: 1,
        execute: async (target) => {
            providers.push(target.provider);
            // Mirrors engine.stream: the generator is lazy, so the first
            // event is primed inside the policy to surface setup failures.
            const generator = (async function* () {
                if (target.provider === "fireworks") {
                    throw new Error("Fireworks chat stream failed: 503 Service Unavailable — overloaded");
                }
                yield { type: "started" };
                yield { type: "delta", text: "hello" };
            })();
            const first = await generator.next();
            return { stream: primedStream(first, generator) };
        },
    });

    assert.equal(route.fallbackUsed, true);
    assert.equal(route.final.provider, "cloudflare");
    // One retry on the primary, then the fallback provider serves the stream.
    assert.deepEqual(providers, ["fireworks", "fireworks", "cloudflare"]);

    const events: Array<Record<string, unknown>> = [];
    for await (const event of route.result.stream as AsyncGenerator<Record<string, unknown>>) {
        events.push(event);
    }
    assert.deepEqual(events, [{ type: "started" }, { type: "delta", text: "hello" }]);
});

test("zero retries disables same-provider retries but preserves the fallback chain", async () => {
    const context: PolicyContext = {
        modelId: "glm-5.2",
        provider: "fireworks",
        wireModelId: "accounts/fireworks/models/glm-5p2",
        card: card(GLM_ROUTES),
    };
    const providers: string[] = [];

    await assert.rejects(
        runWithPolicy({
            context,
            retriesPerTarget: 0,
            execute: async (target) => {
                providers.push(target.provider);
                throw Object.assign(new Error("server_is_overloaded"), { status: 503 });
            },
        }),
        /server_is_overloaded/,
    );

    assert.deepEqual(providers, ["fireworks", "cloudflare", "deepinfra"]);
});

test("primedStream replays valid events and rejects pre-output stream failures", async () => {
    const { primedStream, requireStreamStart } = await import("../inference/engine.js");

    const full = (async function* () {
        yield "one";
        yield "two";
    })();
    const first = await full.next();
    const replayed: string[] = [];
    for await (const event of primedStream(first, full)) {
        replayed.push(event as string);
    }
    assert.deepEqual(replayed, ["one", "two"]);

    assert.throws(() => requireStreamStart({ value: undefined, done: true }), /ended without output/);
    assert.throws(
        () => requireStreamStart({ value: { type: "error", error: { code: "overloaded", message: "overloaded" } }, done: false }),
        /overloaded/,
    );
});
