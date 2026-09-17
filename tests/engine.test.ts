import test from "node:test";
import assert from "node:assert/strict";

test("inference engine resolves models without loading provider adapters", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const engine = await import("../inference/engine.js");

    // Bare id resolves to the priority winner.
    const primary = engine.resolve({ model: "gpt-5.4" });
    assert.equal(primary.known, true);
    assert.equal(primary.modelId, "gpt-5.4");

    // Qualified alias resolves to the same model with the provider pinned.
    const pinned = engine.resolve({ model: "openai/gpt-5.4" });
    assert.equal(pinned.known, true);
    assert.equal(pinned.modelId, "gpt-5.4");
    assert.equal(pinned.provider, "openai");
    assert.equal(pinned.card?.provider, "openai");
    assert.equal(pinned.card?.upstreamModelId, "gpt-5.4");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(
    warnings.some((warning) => warning.includes("[genai]") || warning.includes("[openai]") || warning.includes("[huggingface]") || warning.includes("[vertex]") || warning.includes("[fireworks]") || warning.includes("[cloudflare]") || warning.includes("[deepinfra]")),
    false,
  );
});
