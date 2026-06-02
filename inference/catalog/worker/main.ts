import type { Env } from "./env.js";
import { aggregateCanonicalFamily, normalizeFamily } from "../families/index.js";
import { clean, type Data, type Item } from "./clean.js";
import { embed, rank } from "./embed.js";
import { write } from "./snap.js";
import { attempt, audit, changed, counts, done, embeds, ensure, exact, fail, find, imported, latest, live, page, prune, queue, reconcile, rows, stale, state, type Row } from "./sql.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=30, s-maxage=300",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function cors(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("access-control-allow-origin", "*");
  next.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  next.headers.set("access-control-allow-headers", "content-type, authorization");
  return next;
}

function list(value: string): string[] {
  return JSON.parse(value) as string[];
}

function value(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function caps(row: Row): string[] {
  const value = model(row).capabilities;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, item]) => item === true || (typeof item === "number" && item > 0) || (typeof item === "string" && item.length > 0))
    .map(([key]) => norm(key));
}

function num(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function limit(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function same(left: string, right: string): boolean {
  const a = bytes(left);
  const b = bytes(right);
  let diff = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

async function gate(request: Request, env: Env): Promise<Response | null> {
  void request;
  void env;
  return null;
}

function vectors(items: Item[], values: number[][]) {
  return items.map((item, index) => {
    const vector = values[index];
    if (!vector) {
      throw new Error(`missing vector for ${item.key}`);
    }
    return {
      id: item.key,
      values: vector,
      metadata: {
        modelId: item.modelId,
        provider: item.provider,
        family: item.family,
        name: item.name,
        modality: list(item.modality),
        operations: list(item.operations),
        contextTokens: item.contextTokens,
        active: true,
      },
    };
  });
}

function labelNorm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function routeId(domain: string, ref: string, label: string): string {
  const base = `${domain}:${ref}:${labelNorm(label)}`;
  return base.length <= 64 ? base : `${domain}:${hashText(base)}`;
}

function routeLabels(item: Item): string[] {
  return [...new Set([item.modelId, item.name || ""]
    .map((label) => label.trim())
    .filter(Boolean))];
}

function routeEvidence(item: Item): string {
  return [
    item.name ? `${item.name} (${item.modelId})` : item.modelId,
    `provider ${item.provider}`,
    `family ${item.family}`,
    item.description || "",
    `input ${list(item.input).join(", ")}`,
    `output ${list(item.output).join(", ")}`,
    `operations ${list(item.operations).join(", ")}`,
  ].filter(Boolean).join("; ").slice(0, 500);
}

function routeVectors(items: Item[], values: number[][]) {
  return items.flatMap((item, index) => {
    const vector = values[index];
    if (!vector) {
      throw new Error(`missing route vector for ${item.key}`);
    }
    return routeLabels(item).map((label) => ({
      id: routeId("models", item.modelId, label),
      values: vector,
      metadata: {
        domain: "models",
        ref: item.modelId,
        label,
        labelNorm: labelNorm(label),
        family: item.family,
        evidence: routeEvidence(item),
        version: item.hash,
        ...(item.last ? { updated: item.last } : {}),
      },
    }));
  });
}

function model(row: Row, score?: number) {
  return {
    key: row.key,
    modelId: row.modelId,
    provider: row.provider,
    family: row.family,
    name: row.name,
    description: row.description,
    input: list(row.input),
    output: list(row.output),
    type: list(row.type),
    modality: list(row.modality),
    capabilities: value(row.capabilities) ?? {},
    contextWindow: value(row.contextWindow),
    contextTokens: row.contextTokens,
    pricing: value(row.pricing) ?? {},
    operations: list(row.operations),
    metadata: value(row.metadata) ?? {},
    semantics: value(row.semantics) ?? {},
    stream: row.stream === 1,
    available: row.available === 1,
    ...(score === undefined ? {} : { score }),
  };
}

function text(row: Row): string {
  const capabilities = value(row.capabilities);
  const keys = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? Object.keys(capabilities)
    : [];
  return [
    `provider: ${row.provider}`,
    `family: ${row.family}`,
    `modelId: ${row.modelId}`,
    `name: ${row.name || ""}`,
    `description: ${row.description || ""}`,
    `input: ${list(row.input).join(", ")}`,
    `output: ${list(row.output).join(", ")}`,
    `type: ${list(row.type).join(", ")}`,
    `modality: ${list(row.modality).join(", ")}`,
    `operations: ${list(row.operations).join(", ")}`,
    `capabilities: ${keys.join(", ")}`,
    `semantics: ${row.semantics}`,
  ].join("\n");
}

function has(row: Row, key: "input" | "output" | "modality" | "operations", want?: string): boolean {
  if (!want) return true;
  return list(row[key]).includes(want);
}

function first(value: unknown): string | undefined {
  return Array.isArray(value)
    ? value.find((item): item is string => typeof item === "string" && item.trim().length > 0)
    : typeof value === "string" && value.trim().length > 0
      ? value
      : undefined;
}

function ok(row: Row, filters: {
  provider?: string;
  modality?: string;
  operation?: string;
  capability?: string;
  input?: string;
  output?: string;
}): boolean {
  if (filters.provider && row.provider !== filters.provider) return false;
  if (!has(row, "modality", filters.modality)) return false;
  if (!has(row, "operations", filters.operation)) return false;
  if (!has(row, "input", filters.input)) return false;
  if (!has(row, "output", filters.output)) return false;
  if (filters.capability && !caps(row).includes(norm(filters.capability))) return false;
  return true;
}

type Id = {
  model: string;
  major: number | null;
  minor: number | null;
  suffixes: string[];
};

type Mark = {
  row: Row | null;
  id: Id;
  modality: string[];
  input: string[];
  output: string[];
  family: string;
};

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim().length > 0))].sort();
}

function field(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === "string" && item.trim().length > 0 ? [norm(item)] : [])
    : [];
}

function fam(row: Row | null, modelId: string): string {
  if (row) {
    const direct = normalizeFamily(row.family);
    if (direct) return direct;
    return aggregateCanonicalFamily(row.modelId, row.name) ?? "";
  }
  return aggregateCanonicalFamily(modelId) ?? "";
}

function mods(row: Row | null): string[] {
  if (!row) return [];
  const semantics = rec(value(row.semantics));
  const direct = field(semantics?.modalities);
  if (direct.length > 0) return uniq(direct);
  return list(row.modality);
}

function shape(rows: Row[], from: Mark): string[] {
  const groups = [
    rows.filter((row) => {
      const target = mark(row, row.modelId);
      return target.family === from.family
        && target.id.model === from.id.model
        && delta(target.input, from.input) === 0
        && delta(target.output, from.output) === 0;
    }),
    rows.filter((row) => {
      const target = mark(row, row.modelId);
      return target.family === from.family
        && delta(target.input, from.input) === 0
        && delta(target.output, from.output) === 0;
    }),
    rows.filter((row) => {
      const target = mark(row, row.modelId);
      return delta(target.input, from.input) === 0
        && delta(target.output, from.output) === 0;
    }),
  ];

  for (const group of groups) {
    if (group.length === 0) continue;
    const counts = new Map<string, { value: string[]; count: number }>();
    for (const row of group) {
      const value = mods(row);
      if (value.length === 0) continue;
      const key = JSON.stringify(value);
      const current = counts.get(key);
      counts.set(key, { value, count: (current?.count ?? 0) + 1 });
    }
    const [best] = [...counts.values()].sort((left, right) => right.count - left.count || left.value.join(",").localeCompare(right.value.join(",")));
    if (best) return best.value;
  }

  return from.modality;
}

function ident(modelId: string): Id {
  const base = (modelId.split("/").pop() || modelId).toLowerCase();
  const tokens = base.split("-").filter(Boolean);
  const index = tokens.findIndex((item) => /^\d+(?:\.\d+)?$/.test(item));
  if (index === -1) {
    return { model: base, major: null, minor: null, suffixes: [] };
  }
  const version = tokens[index] || "";
  const parts = version.split(".").map((item) => Number.parseInt(item, 10));
  const major = parts[0] ?? Number.NaN;
  const minor = parts[1] ?? Number.NaN;
  return {
    model: tokens.slice(0, index).join("-"),
    major: Number.isFinite(major) ? major : null,
    minor: Number.isFinite(minor) ? minor : 0,
    suffixes: tokens.slice(index + 1),
  };
}

function mark(row: Row | null, modelId: string): Mark {
  const id = ident(row?.modelId || modelId);
  const family = fam(row, modelId);
  return {
    row,
    id,
    modality: mods(row),
    input: row ? list(row.input) : [],
    output: row ? list(row.output) : [],
    family,
  };
}

function view(row: Row, mark: Mark): ReturnType<typeof model> {
  const semantics = rec(value(row.semantics)) ?? {};
  return {
    ...model(row),
    family: mark.family,
    modality: mark.modality,
    semantics: {
      ...semantics,
      ...(mark.family ? { family: mark.family } : {}),
      ...(mark.modality.length > 0 ? { modalities: mark.modality } : {}),
    },
  };
}

async function save(env: Env, row: Row | null, mark: Mark): Promise<void> {
  if (!row || row.active === 1) return;
  const modality = JSON.stringify(mark.modality);
  const semantics = {
    ...(rec(value(row.semantics)) ?? {}),
    ...(mark.family ? { family: mark.family } : {}),
    ...(mark.modality.length > 0 ? { modalities: mark.modality } : {}),
  };
  const next = JSON.stringify(semantics);
  if (row.family === mark.family && row.modality === modality && row.semantics === next) return;
  await env.DB.prepare(
    `UPDATE models
     SET family = ?2,
         modality = ?3,
         semantics = ?4,
         updated = CURRENT_TIMESTAMP
     WHERE key = ?1
       AND active = 0`,
  ).bind(row.key, mark.family, modality, next).run();
}

function delta(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  let score = 0;
  for (const item of a) {
    if (!b.has(item)) score += 1;
  }
  for (const item of b) {
    if (!a.has(item)) score += 1;
  }
  return score;
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function common(left: string[], right: string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function ahead(from: number | null, to: number | null): number[] {
  if (from === null || to === null) return [from === to ? 0 : 1, 0];
  return [to >= from ? 0 : 1, Math.abs(to - from)];
}

function suffixes(from: string[], to: string[]): number[] {
  const trimmed = from.slice(0, Math.max(0, from.length - 1));
  if (sameList(trimmed, to)) return [0, 0, 0, 0];
  if (sameList(from, to)) return [3, 0, 0, 0];
  const prefix = common(from, to);
  return [1, from.length - prefix, Math.abs(from.length - to.length), to.length];
}

function routeScore(from: Mark, to: Mark): number[] {
  return [
    delta(from.modality, to.modality),
    delta(from.input, to.input) + delta(from.output, to.output),
    from.family && to.family && from.family === to.family ? 0 : 1,
    from.id.model && to.id.model && from.id.model === to.id.model ? 0 : 1,
    ...ahead(from.id.major, to.id.major),
    ...ahead(from.id.minor, to.id.minor),
    ...suffixes(from.id.suffixes, to.id.suffixes),
  ];
}

function compareScore(left: number[], right: number[]): number {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function rebind(request: Request, env: Env): Promise<Response> {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const url = new URL(request.url);
  const modelId = first(body.model) || first(body.modelId) || url.searchParams.get("model")?.trim() || "";
  const take = limit(typeof body.limit === "number" ? String(body.limit) : url.searchParams.get("limit"), 8, 50);
  if (!modelId) {
    return json({
      error: {
        code: "invalid_model",
        message: "model is required",
      },
    }, 400);
  }

  await ensure(env);
  const original = await exact(env, modelId);
  const candidates = await live(env);
  const base = mark(original, modelId);
  const from = original && original.active !== 1
    ? { ...base, modality: shape(candidates, base) }
    : base;
  await save(env, original, from);
  const ranked = candidates
    .filter((row) => row.modelId !== modelId)
    .map((row) => {
      const score = routeScore(from, mark(row, row.modelId));
      return { row, score };
    })
    .sort((left, right) => compareScore(left.score, right.score) || left.row.modelId.localeCompare(right.row.modelId));

  const data = ranked.slice(0, take).map((item) => ({
    ...model(item.row),
    routeScore: item.score,
  }));

  return json({
    selected: data[0] ?? null,
    candidates: data,
    data,
    total: data.length,
    query: modelId,
    original: original ? view(original, from) : { modelId, family: from.family, modality: from.modality },
    reason: "deterministic model rebind ranked by modality, input/output, family, model, major, minor, suffixes",
  });
}

function read(request: Request, body: Record<string, unknown>) {
  const url = new URL(request.url);
  const str = (key: string): string | undefined => {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    return url.searchParams.get(key)?.trim() || undefined;
  };
  const q = str("q") || str("query") || str("prompt") || "";
  return {
    q,
    take: limit(typeof body.limit === "number" ? String(body.limit) : url.searchParams.get("limit"), 10, 50),
    filters: {
      provider: str("provider"),
      modality: str("modality"),
      operation: str("operation"),
      capability: str("capability"),
      input: str("input"),
      output: str("output"),
    },
  };
}

async function chooseData(env: Env, q: string, take: number, filters: ReturnType<typeof read>["filters"]) {
  await ensure(env);

  const [query] = await embed(env, [q], "query");
  if (!query) throw new Error("query embedding returned empty vector");

  const result = await env.VEC.query(query, {
    topK: Math.min(Math.max(take * 8, 24), 50),
    returnMetadata: "all",
  });
  const scores = new Map(result.matches.map((item) => [item.id, item.score]));
  const rows = await find(env, result.matches.map((item) => item.id));
  const candidates = rows
    .filter((row) => ok(row, filters))
    .sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0))
    .slice(0, 50);
  const ranked = await rank(env, q, candidates.map((row) => ({
    id: row.key,
    text: text(row),
    score: scores.get(row.key),
  })), take);
  const byKey = new Map(candidates.map((row) => [row.key, row]));
  const data = ranked
    .map((item) => {
      const row = byKey.get(item.id);
      return row ? model(row, item.score) : null;
    })
    .filter((item): item is ReturnType<typeof model> => Boolean(item));

  return {
    data,
    total: data.length,
    query: q,
    filters,
  };
}

async function choose(request: Request, env: Env, mode: "search" | "select"): Promise<Response> {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const { q, take, filters } = read(request, body);
  if (!q) {
    return json({
      error: {
        code: "invalid_query",
        message: "q is required",
      },
    }, 400);
  }

  const result = await chooseData(env, q, take, filters);
  const data = result.data;

  if (mode === "select") {
    return json({
      selected: data[0] ?? null,
      alternates: data.slice(1, Math.min(data.length, 4)),
      data,
      total: data.length,
      query: result.query,
      filters: result.filters,
    });
  }

  return json({
    data,
    total: data.length,
    query: result.query,
    filters: result.filters,
  });
}

async function ingest(request: Request, env: Env): Promise<Response> {
  const denied = await gate(request, env);
  if (denied) return denied;

  await ensure(env);

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
  const body = await request.json() as Data;
  const batch = crypto.randomUUID();
  const cleaned = await clean(body, batch);
  const previous = await latest(env);
  if (!force && previous?.hash === cleaned.hash && previous.state === "embedded") {
    await audit(env, "skip", "models", previous.id, {
      reason: "unchanged",
      hash: cleaned.hash,
      count: cleaned.count,
    });
    return json({
      ok: true,
      skipped: true,
      batch: previous.id,
      count: cleaned.count,
      embedded: 0,
      hash: cleaned.hash,
      lastUpdated: cleaned.last,
    });
  }

  const dirty = await changed(env, cleaned.models);
  const loc = await write(env, batch, body, cleaned);

  await imported(env, {
    id: batch,
    raw: loc.raw,
    snap: loc.snap,
    last: cleaned.last,
    count: cleaned.count,
    hash: cleaned.hash,
  });
  await rows(env, cleaned.models);
  await queue(env, batch, cleaned.models, dirty);
  await stale(env, batch).run();
  await reconcile(env, batch);
  await prune(env).run();
  await audit(env, "import", "models", batch, {
    hash: cleaned.hash,
    count: cleaned.count,
    changed: dirty.size,
    raw: loc.raw,
    snap: loc.snap,
  });

  let embedded = 0;
  try {
    const models = cleaned.models.filter((item) => dirty.has(item.key));
    for (const group of chunk(models, 32)) {
      const keys = group.map((item) => item.key);
      try {
        await attempt(env, batch, keys, "embed", "started");
        const values = await embed(env, group.map((item) => item.text), "document");
        await env.VEC.upsert(vectors(group, values));
        if (env.ROUTES) {
          await env.ROUTES.upsert(routeVectors(group, values));
        }
        await embeds(env, group.map((item) => ({
          key: item.key,
          vector: item.key,
          model: env.EMBEDDING_MODEL || "voyage-4-large",
          text: item.text,
          hash: item.hash,
        })));
        await done(env, batch, keys);
        embedded += group.length;
      } catch (error) {
        await fail(env, batch, keys, "embed", error);
        throw error;
      }
    }
    await audit(env, "embed", "models", batch, { embedded });
    await state(env, batch, "embedded");
  } catch (error) {
    await audit(env, "fail", "models", batch, {
      stage: "embed",
      error: error instanceof Error ? error.message : String(error),
    });
    await state(env, batch, "failed");
    throw error;
  }

  return json({
    ok: true,
    batch,
    count: cleaned.count,
    embedded,
    states: await counts(env),
    raw: loc.raw,
    snap: loc.snap,
    hash: cleaned.hash,
    lastUpdated: cleaned.last,
  });
}

async function index(request: Request, env: Env): Promise<Response> {
  await ensure(env);
  const url = new URL(request.url);
  const take = limit(url.searchParams.get("limit"), 50, 200);
  const cursor = num(url.searchParams.get("cursor"), 0);
  const rows = await page(env, take, cursor);
  return json({
    data: rows.map((row) => model(row)),
    next_cursor: rows.length === take ? String(cursor + rows.length) : null,
    total: rows.length,
  });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    await ensure(env);
    return json({
      service: "models",
      ok: true,
      model: env.EMBEDDING_MODEL || "voyage-4-large",
      states: await counts(env),
      time: new Date().toISOString(),
    });
  }

  if (request.method === "POST" && url.pathname === "/import") {
    return ingest(request, env);
  }

  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/search") {
    return choose(request, env, "search");
  }

  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/select") {
    return choose(request, env, "select");
  }

  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/rebind") {
    return rebind(request, env);
  }

  if (request.method === "GET" && url.pathname === "/models") {
    return index(request, env);
  }

  return json({
    error: {
      code: "not_found",
      message: "route not found",
    },
  }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return cors(await handle(request, env));
    } catch (error) {
      return cors(json({
        error: {
          code: "models_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }, 500));
    }
  },
};
