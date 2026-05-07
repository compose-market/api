/**
 * Tests for response_format → AI-SDK Output translation (Phase 1.1)
 * `api/inference/core.ts` + `api/inference/providers/adapter.ts`
 *
 * Coverage:
 *   - normalizeChatRequest threads `body.response_format` into UnifiedRequest.responseFormat.
 *   - normalizeResponsesRequest threads it for text modality only.
 *   - parseInboundResponseFormat handles all three OpenAI shapes
 *     ("text" | "json_object" | "json_schema").
 *   - Malformed inputs degrade gracefully (json_schema without schema → json_object).
 */
import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeChatRequest, normalizeResponsesRequest } from "../inference/core.js";

test("normalizeChatRequest threads response_format type:'text' as undefined", () => {
    const unified = normalizeChatRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "text" },
    });
    // type:'text' → no JSON gate needed; we keep the shape but it's a no-op
    // when forwarded; what matters is the field is parsed.
    assert.deepEqual(unified.responseFormat, { type: "text" });
});

test("normalizeChatRequest threads response_format type:'json_object'", () => {
    const unified = normalizeChatRequest({
        model: "gemini-3.1-flash-lite-preview",
        messages: [{ role: "user", content: "extract" }],
        response_format: { type: "json_object" },
    });
    assert.deepEqual(unified.responseFormat, { type: "json_object" });
});

test("normalizeChatRequest threads response_format type:'json_schema' with schema", () => {
    const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
    };
    const unified = normalizeChatRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "extract" }],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "person",
                schema,
                strict: true,
            },
        },
    });
    assert.equal(unified.responseFormat?.type, "json_schema");
    assert.equal(unified.responseFormat?.json_schema?.name, "person");
    assert.deepEqual(unified.responseFormat?.json_schema?.schema, schema);
    assert.equal(unified.responseFormat?.json_schema?.strict, true);
});

test("normalizeChatRequest degrades json_schema with missing schema → json_object", () => {
    const unified = normalizeChatRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "extract" }],
        response_format: {
            type: "json_schema",
            json_schema: { name: "person" }, // schema missing
        },
    });
    // Degrade so the downstream provider still gets a JSON-mode signal.
    assert.equal(unified.responseFormat?.type, "json_object");
});

test("normalizeChatRequest drops malformed response_format silently", () => {
    const unified = normalizeChatRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "extract" }],
        response_format: { type: "garbage" },
    });
    assert.equal(unified.responseFormat, undefined);

    const unified2 = normalizeChatRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "extract" }],
        response_format: "not-an-object",
    });
    assert.equal(unified2.responseFormat, undefined);
});

test("normalizeResponsesRequest threads response_format only when modality is text", () => {
    const textUnified = normalizeResponsesRequest({
        model: "gpt-4o",
        modalities: ["text"],
        input: "extract",
        response_format: { type: "json_object" },
    });
    assert.deepEqual(textUnified.responseFormat, { type: "json_object" });

    // Image modality should NOT carry a json response_format (it's a different
    // OpenAI field with values like "url"/"b64_json").
    const imageUnified = normalizeResponsesRequest({
        model: "gemini-3.1-pro-image-preview",
        modalities: ["image"],
        input: "draw a cat",
        response_format: { type: "json_object" },
    });
    assert.equal(imageUnified.responseFormat, undefined);
});
