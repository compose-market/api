import type { Env } from "./env.js";

interface Resp {
  data?: Array<{ embedding?: unknown; index?: unknown }>;
}

interface Ranked {
  data?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
  results?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
}

function url(env: Env): string {
  const base = (env.EMBEDDING_API_BASE || "https://ai.mongodb.com/v1").replace(/\/+$/, "");
  return `${base}/embeddings`;
}

function ranked(env: Env): string {
  const base = (env.EMBEDDING_API_BASE || "https://ai.mongodb.com/v1").replace(/\/+$/, "");
  return `${base}/rerank`;
}

function vector(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? value
    : null;
}

export async function embed(env: Env, input: string[], kind: "document" | "query" = "document"): Promise<number[][]> {
  if (input.length === 0) return [];
  if (!env.MONGO_DB_API_KEY) {
    throw new Error("MONGO_DB_API_KEY is required");
  }

  const response = await fetch(url(env), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.MONGO_DB_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.EMBEDDING_MODEL || "voyage-4-large",
      input,
      input_type: kind,
      output_dimension: 1024,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`embedding ${response.status}: ${body.slice(0, 300)}`);
  }

  const parsed = await response.json() as Resp;
  const data = parsed.data ?? [];
  const out = data
    .map((item, fallback) => ({
      index: typeof item.index === "number" ? item.index : fallback,
      embedding: vector(item.embedding),
    }))
    .filter((item): item is { index: number; embedding: number[] } => Boolean(item.embedding))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  if (out.length !== input.length) {
    throw new Error(`embedding count mismatch: expected ${input.length}, got ${out.length}`);
  }

  return out;
}

export async function rank(
  env: Env,
  query: string,
  documents: Array<{ id: string; text: string; score?: number }>,
  top: number,
): Promise<Array<{ id: string; score: number }>> {
  if (documents.length === 0) return [];
  if (!env.MONGO_DB_API_KEY) {
    throw new Error("MONGO_DB_API_KEY is required");
  }

  const response = await fetch(ranked(env), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.MONGO_DB_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "rerank-2.5",
      query,
      documents: documents.map((item) => item.text),
      top_k: Math.max(1, Math.min(top, documents.length)),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`rerank ${response.status}: ${body.slice(0, 300)}`);
  }

  const parsed = await response.json() as Ranked;
  const rows = parsed.data ?? parsed.results ?? [];
  return rows
    .map((item) => {
      const index = typeof item.index === "number" ? item.index : -1;
      const doc = documents[index];
      const score = typeof item.relevance_score === "number"
        ? item.relevance_score
        : typeof item.score === "number"
          ? item.score
          : doc?.score ?? 0;
      return doc ? { id: doc.id, score } : null;
    })
    .filter((item): item is { id: string; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);
}
