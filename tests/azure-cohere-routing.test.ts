import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { normalizeResponsesRequest } from "../inference/core.js";
import { streamWithTools } from "../inference/catalog/adapter.js";
import { generateAzureChat } from "../inference/catalog/vendors/azure.js";

const env = {
  AZURE_MICROSOFT_FOUNDRY_ENDPOINT: process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT,
  AZURE_MICROSOFT_FOUNDRY_API_KEY: process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY,
};
const fetcher = globalThis.fetch;

afterEach(() => {
  process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT = env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT;
  process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY = env.AZURE_MICROSOFT_FOUNDRY_API_KEY;
  globalThis.fetch = fetcher;
});

test("Cohere prompts with embedded candidate labels route classification", () => {
  const request = normalizeResponsesRequest({
    model: "Cohere-rerank-v4.0-fast",
    input: "Classify this short message. Labels: greeting, complaint, question. Message: yo",
  });

  assert.equal(request.modality, "text");
  assert.equal(request.operation, "classification");
  assert.deepEqual(request.customParams?.candidate_labels, ["greeting", "complaint", "question"]);
  assert.equal(request.customParams?.query, "yo");
});

test("Cohere operationless rerank deployments keep bare text on rerank", () => {
  const request = normalizeResponsesRequest({
    model: "Cohere-rerank-v4.0-fast",
    input: "yo",
  });

  assert.equal(request.modality, "text");
  assert.equal(request.operation, "rerank");
  assert.equal(request.customParams?.documents, undefined);
});

test("Cohere rerank requests keep top-level documents and route as rerank", () => {
  const request = normalizeResponsesRequest({
    model: "Cohere-rerank-v4.0-fast",
    input: "Which note mentions launch risk?",
    documents: [
      "A budget receipt.",
      "Launch risk needs product and engineering review.",
    ],
  });

  assert.equal(request.modality, "text");
  assert.equal(request.operation, "rerank");
  assert.deepEqual(request.customParams?.documents, [
    "A budget receipt.",
    "Launch risk needs product and engineering review.",
  ]);
});

test("Azure Cohere classification adapts labels through native rerank", async () => {
  process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT = "https://example.azure.com";
  process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY = "test-key";

  let body: any;
  let url = "";
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return Response.json({
      results: [
        { index: 1, relevance_score: 0.88 },
        { index: 0, relevance_score: 0.2 },
      ],
    });
  }) as typeof fetch;

  const result = await generateAzureChat("Cohere-rerank-v4.0-fast", [{
    role: "user",
    content: "Should this be handled by one agent or several?",
  }], {
    operation: "classification",
    customParams: { candidate_labels: ["solo", "swarm"] },
  });

  assert.ok(url.endsWith("/providers/cohere/v2/rerank"));
  assert.equal(body?.model, "Cohere-rerank-v4.0-fast");
  assert.equal(body?.query, "Should this be handled by one agent or several?");
  assert.deepEqual(body?.documents, [
    { label: "solo", text: "solo" },
    { label: "swarm", text: "swarm" },
  ]);

  const parsed = JSON.parse(result.text) as { labels: Array<{ label: string; score: number }> };
  assert.equal(parsed.labels[0]?.label, "swarm");
  assert.equal(parsed.labels[1]?.label, "solo");
  assert.ok(parsed.labels[0]!.score > 0.81);
  assert.ok(parsed.labels[1]!.score < 0.19);
});

test("Azure Cohere streaming derives prompt-contained labels for classification", async () => {
  process.env.AZURE_MICROSOFT_FOUNDRY_ENDPOINT = "https://example.azure.com";
  process.env.AZURE_MICROSOFT_FOUNDRY_API_KEY = "test-key";

  let body: any;
  let url = "";
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    if (url.includes("/openai/v1/chat/completions")) {
      const sse = [
        'data: {"choices":[{"delta":{"content":"greeting"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":1,"total_tokens":13}}',
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.1 },
      ],
    });
  }) as typeof fetch;

  const request = normalizeResponsesRequest({
    model: "Cohere-rerank-v4.0-fast",
    stream: true,
    input: "Classify this short message. Labels: greeting, complaint, question. Message: yo",
  });

  const events = [];
  for await (const event of streamWithTools(request, {
    modelId: "Cohere-rerank-v4.0-fast",
    provider: "azure",
  })) {
    events.push(event);
  }

  assert.ok(url.endsWith("/providers/cohere/v2/rerank"));
  assert.equal(body?.model, "Cohere-rerank-v4.0-fast");
  assert.equal(body?.query, "yo");
  assert.deepEqual(body?.documents, [
    { label: "greeting", text: "greeting" },
    { label: "complaint", text: "complaint" },
    { label: "question", text: "question" },
  ]);
  assert.equal(events.at(-1)?.type, "done");
});

test("Azure Cohere classification reports labels as the missing input", async () => {
  await assert.rejects(
    () => generateAzureChat("Cohere-rerank-v4.0-fast", [{
      role: "user",
      content: "Should this be handled by one agent or several?",
    }], {
      operation: "classification",
    }),
    /candidate_labels/u,
  );
});
