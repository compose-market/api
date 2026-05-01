import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFeedbackInput, toPublicFeedback } from "../feedback/validation.js";
import type { FeedbackRecord } from "../feedback/types.js";

test("normalizeFeedbackInput accepts a model rating with payment and request context", () => {
  const normalized = normalizeFeedbackInput({
    target: { type: "model", id: "openai/dall-e-3" },
    category: "quality",
    rating: 4,
    message: "Image quality was good but slower than expected.",
    labels: ["image", "latency"],
    context: {
      requestId: "req_feedback_1",
      paymentIntentId: "pi_123",
      chainId: 43113,
      modelId: "openai/dall-e-3",
      provider: "openai",
      receipt: {
        network: "eip155:43113",
        txHash: `0x${"12".repeat(32)}`,
        finalAmountWei: "12000",
      },
    },
    metadata: {
      component: "image-grid",
      nested: { ok: true },
    },
  });

  assert.equal(normalized.target.type, "model");
  assert.equal(normalized.target.id, "openai/dall-e-3");
  assert.equal(normalized.category, "quality");
  assert.equal(normalized.rating, 4);
  assert.deepEqual(normalized.labels, ["image", "latency"]);
  assert.equal(normalized.context?.requestId, "req_feedback_1");
  assert.equal(normalized.context?.modelId, "openai/dall-e-3");
});

test("normalizeFeedbackInput rejects feedback with no rating and no message", () => {
  assert.throws(
    () => normalizeFeedbackInput({
      target: { type: "x402", id: "req_123" },
    }),
    /provide at least one of message or rating/,
  );
});

test("toPublicFeedback omits reviewer address but preserves verification kind", () => {
  const record: FeedbackRecord = {
    id: "fb_test",
    target: { type: "agent", id: "0x0000000000000000000000000000000000000001" },
    category: "bug",
    rating: 2,
    message: "Tool call failed.",
    labels: ["tool-use"],
    context: { composeRunId: "run_1" },
    metadata: {},
    reviewer: {
      kind: "compose_key",
      address: "0x0000000000000000000000000000000000000002",
      chainId: 43113,
    },
    createdAt: 1_700_000_000_000,
  };

  const exposed = toPublicFeedback(record);
  assert.equal(exposed.verification, "compose_key");
  assert.equal("reviewer" in exposed, false);
});
