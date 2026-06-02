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
    const resolved = engine.resolve({ model: "o4-mini-deep-research" });

    assert.equal(resolved.known, true);
    assert.equal(resolved.provider, "openai");
    assert.equal(resolved.modelId, "o4-mini-deep-research");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(
    warnings.some((warning) => warning.includes("[genai]") || warning.includes("[openai]") || warning.includes("[huggingface]") || warning.includes("[vertex]") || warning.includes("[fireworks]") || warning.includes("[cloudflare]")),
    false,
  );
});
