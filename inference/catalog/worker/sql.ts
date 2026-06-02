import type { D1PreparedStatement, Env } from "./env.js";
import type { Item } from "./clean.js";

export interface Row {
  key: string;
  modelId: string;
  provider: string;
  family: string;
  name: string | null;
  description: string | null;
  input: string;
  output: string;
  type: string;
  modality: string;
  capabilities: string;
  contextWindow: string | null;
  contextTokens: number | null;
  pricing: string;
  operations: string;
  metadata: string;
  semantics: string;
  stream: number;
  available: number;
  active: number;
  hash: string;
  batch: string;
  last: string | null;
}

export type ModelState = "queued" | "skipped" | "indexed" | "stale" | "failed";
export type Stage = "clean" | "rows" | "embed" | "prune" | "reconcile";

interface Repair {
  key: string;
  hash: string;
  batch: string;
  active: number;
}

export const schema = [
  `CREATE TABLE IF NOT EXISTS imports (
    id       TEXT PRIMARY KEY,
    raw      TEXT NOT NULL,
    snap     TEXT NOT NULL,
    last     TEXT,
    count    INTEGER NOT NULL DEFAULT 0,
    hash     TEXT NOT NULL,
    state    TEXT NOT NULL DEFAULT 'imported'
               CHECK (state IN ('imported', 'embedded', 'failed')),
    created  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imports_state ON imports(state, updated)`,
  `CREATE TABLE IF NOT EXISTS models (
    key            TEXT PRIMARY KEY,
    modelId        TEXT NOT NULL,
    provider       TEXT NOT NULL,
    family         TEXT NOT NULL DEFAULT '',
    name           TEXT,
    description    TEXT,
    input          TEXT NOT NULL DEFAULT '[]',
    output         TEXT NOT NULL DEFAULT '[]',
    type           TEXT NOT NULL DEFAULT '[]',
    modality       TEXT NOT NULL DEFAULT '[]',
    capabilities   TEXT NOT NULL DEFAULT '{}',
    contextWindow  TEXT,
    contextTokens  INTEGER,
    pricing        TEXT NOT NULL DEFAULT '{}',
    operations     TEXT NOT NULL DEFAULT '[]',
    metadata       TEXT NOT NULL DEFAULT '{}',
    semantics      TEXT NOT NULL DEFAULT '{}',
    stream         INTEGER NOT NULL DEFAULT 0,
    available      INTEGER NOT NULL DEFAULT 1,
    active         INTEGER NOT NULL DEFAULT 1,
    hash           TEXT NOT NULL,
    batch          TEXT NOT NULL,
    last           TEXT,
    created        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (modelId, provider),
    FOREIGN KEY (batch) REFERENCES imports(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider, active)`,
  `CREATE INDEX IF NOT EXISTS idx_models_family ON models(family, active)`,
  `CREATE INDEX IF NOT EXISTS idx_models_stream ON models(stream, active)`,
  `CREATE INDEX IF NOT EXISTS idx_models_context ON models(contextTokens, active)`,
  `CREATE INDEX IF NOT EXISTS idx_models_batch ON models(batch)`,
  `CREATE TABLE IF NOT EXISTS embeds (
    key       TEXT PRIMARY KEY,
    vector    TEXT NOT NULL,
    provider  TEXT NOT NULL,
    model     TEXT NOT NULL,
    dims      INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    text      TEXT NOT NULL,
    hash      TEXT NOT NULL,
    created   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (key) REFERENCES models(key) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_embeds_model ON embeds(model, created)`,
  `CREATE TABLE IF NOT EXISTS states (
    key       TEXT PRIMARY KEY,
    hash      TEXT NOT NULL,
    state     TEXT NOT NULL CHECK (state IN ('queued', 'skipped', 'indexed', 'stale', 'failed')),
    attempts  INTEGER NOT NULL DEFAULT 0,
    batch     TEXT NOT NULL,
    next      TEXT,
    error     TEXT,
    updated   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (key) REFERENCES models(key) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_states_state ON states(state, next, updated)`,
  `CREATE INDEX IF NOT EXISTS idx_states_batch ON states(batch, updated)`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id       TEXT PRIMARY KEY,
    key      TEXT NOT NULL,
    batch    TEXT NOT NULL,
    stage    TEXT NOT NULL,
    state    TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'skipped')),
    error    TEXT,
    created  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_key ON attempts(key, created)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_batch ON attempts(batch, created)`,
  `CREATE TABLE IF NOT EXISTS audit (
    id       TEXT PRIMARY KEY,
    action   TEXT NOT NULL,
    target   TEXT NOT NULL,
    batch    TEXT,
    data     TEXT NOT NULL DEFAULT '{}',
    created  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, created)`,
] as const;

export async function ensure(env: Env): Promise<void> {
  for (const item of schema) {
    try {
      await env.DB.prepare(item).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such column/i.test(message) || !item.includes("idx_models_family")) {
        throw error;
      }
    }
  }
  await column(env, "semantics", `ALTER TABLE models ADD COLUMN semantics TEXT NOT NULL DEFAULT '{}'`);
  await column(env, "family", `ALTER TABLE models ADD COLUMN family TEXT NOT NULL DEFAULT ''`);
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_models_family ON models(family, active)`).run();
  await repair(env);
}

async function column(env: Env, name: string, sql: string): Promise<void> {
  try {
    await env.DB.prepare(`SELECT ${name} FROM models LIMIT 1`).first();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such column/i.test(message)) throw error;
    await env.DB.prepare(sql).run();
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export async function imported(env: Env, item: {
  id: string;
  raw: string;
  snap: string;
  last: string | null;
  count: number;
  hash: string;
  state?: "imported" | "embedded" | "failed";
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO imports (id, raw, snap, last, count, hash, state, updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       raw = excluded.raw,
       snap = excluded.snap,
       last = excluded.last,
       count = excluded.count,
       hash = excluded.hash,
       state = excluded.state,
       updated = CURRENT_TIMESTAMP`,
  ).bind(
    item.id,
    item.raw,
    item.snap,
    item.last,
    item.count,
    item.hash,
    item.state ?? "imported",
  ).run();
}

export async function rows(env: Env, items: Item[]): Promise<void> {
  for (const group of chunk(items, 50)) {
    await env.DB.batch(group.map((item) => env.DB.prepare(
      `INSERT INTO models (
         key, modelId, provider, family, name, description, input, output, type,
         modality, capabilities, contextWindow, contextTokens, pricing,
         operations, metadata, semantics, stream, available, active, hash, batch, last, updated
       )
       VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19, 1, ?20, ?21, ?22, CURRENT_TIMESTAMP
       )
       ON CONFLICT(key) DO UPDATE SET
         modelId = excluded.modelId,
         provider = excluded.provider,
         family = excluded.family,
         name = excluded.name,
         description = excluded.description,
         input = excluded.input,
         output = excluded.output,
         type = excluded.type,
         modality = excluded.modality,
         capabilities = excluded.capabilities,
         contextWindow = excluded.contextWindow,
         contextTokens = excluded.contextTokens,
         pricing = excluded.pricing,
         operations = excluded.operations,
         metadata = excluded.metadata,
         semantics = excluded.semantics,
         stream = excluded.stream,
         available = excluded.available,
         active = 1,
         hash = excluded.hash,
         batch = excluded.batch,
         last = excluded.last,
         updated = CURRENT_TIMESTAMP`,
    ).bind(
      item.key,
      item.modelId,
      item.provider,
      item.family,
      item.name,
      item.description,
      item.input,
      item.output,
      item.type,
      item.modality,
      item.capabilities,
      item.contextWindow,
      item.contextTokens,
      item.pricing,
      item.operations,
      item.metadata,
      item.semantics,
      item.stream,
      item.available,
      item.hash,
      item.batch,
      item.last,
    )));
  }
}

export async function embeds(env: Env, items: Array<{
  key: string;
  vector: string;
  model: string;
  text: string;
  hash: string;
}>): Promise<void> {
  for (const group of chunk(items, 50)) {
    await env.DB.batch(group.map((item) => env.DB.prepare(
      `INSERT INTO embeds (key, vector, provider, model, dims, kind, text, hash, created)
       VALUES (?1, ?2, 'mongodb-voyage', ?3, 1024, 'document', ?4, ?5, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         vector = excluded.vector,
         provider = excluded.provider,
         model = excluded.model,
         dims = excluded.dims,
         kind = excluded.kind,
         text = excluded.text,
         hash = excluded.hash,
         created = CURRENT_TIMESTAMP`,
    ).bind(item.key, item.vector, item.model, item.text, item.hash)));
  }
}

export async function state(env: Env, id: string, value: "imported" | "embedded" | "failed"): Promise<void> {
  await env.DB.prepare(
    `UPDATE imports
     SET state = ?2,
         updated = CURRENT_TIMESTAMP
     WHERE id = ?1`,
  ).bind(id, value).run();
}

export async function latest(env: Env): Promise<{ id: string; hash: string; state: string } | null> {
  return env.DB.prepare(
    `SELECT id, hash, state
     FROM imports
     ORDER BY created DESC
     LIMIT 1`,
  ).first<{ id: string; hash: string; state: string }>();
}

export async function changed(env: Env, items: Item[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const group of chunk(items, 90)) {
    const marks = group.map((_, index) => `?${index + 1}`).join(", ");
    const result = await env.DB.prepare(
      `SELECT m.key, m.hash AS modelHash, e.hash AS embedHash
       FROM models m
       LEFT JOIN embeds e ON e.key = m.key
       WHERE m.key IN (${marks})`,
    ).bind(...group.map((item) => item.key)).all<{ key: string; modelHash: string; embedHash: string | null }>();
    const seen = new Map((result.results ?? []).map((row) => [row.key, row]));
    for (const item of group) {
      const row = seen.get(item.key);
      if (!row || row.modelHash !== item.hash || row.embedHash !== item.hash) {
        out.add(item.key);
      }
    }
  }
  return out;
}

export async function queue(env: Env, batch: string, items: Item[], keys: Set<string>): Promise<void> {
  for (const group of chunk(items, 50)) {
    await env.DB.batch(group.map((item) => {
      const state: ModelState = keys.has(item.key) ? "queued" : "skipped";
      return env.DB.prepare(
        `INSERT INTO states (key, hash, state, attempts, batch, next, error, updated)
         VALUES (?1, ?2, ?3, 0, ?4, NULL, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           hash = excluded.hash,
           state = excluded.state,
           batch = excluded.batch,
           next = NULL,
           error = NULL,
           updated = CURRENT_TIMESTAMP`,
      ).bind(item.key, item.hash, state, batch);
    }));
  }
}

export async function attempt(env: Env, batch: string, keys: string[], stage: Stage, state: "started" | "succeeded" | "failed" | "skipped", error?: string): Promise<void> {
  for (const group of chunk(keys, 50)) {
    await env.DB.batch(group.map((key) => env.DB.prepare(
      `INSERT INTO attempts (id, key, batch, stage, state, error, created)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)`,
    ).bind(crypto.randomUUID(), key, batch, stage, state, error ?? null)));
  }
}

export async function done(env: Env, batch: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await attempt(env, batch, keys, "embed", "succeeded");
  for (const group of chunk(keys, 90)) {
    const marks = group.map((_, index) => `?${index + 1}`).join(", ");
    await env.DB.prepare(
      `UPDATE states
       SET state = 'indexed',
           next = NULL,
           error = NULL,
           updated = CURRENT_TIMESTAMP
       WHERE key IN (${marks})`,
    ).bind(...group).run();
  }
}

export async function fail(env: Env, batch: string, keys: string[], stage: Stage, error: unknown): Promise<void> {
  if (keys.length === 0) return;
  const message = error instanceof Error ? error.message : String(error);
  await attempt(env, batch, keys, stage, "failed", message.slice(0, 1000));
  for (const group of chunk(keys, 90)) {
    const marks = group.map((_, index) => `?${index + 1}`).join(", ");
    await env.DB.prepare(
      `UPDATE states
       SET state = 'failed',
           attempts = attempts + 1,
           next = datetime('now', '+' || MIN(attempts + 1, 60) || ' minutes'),
           error = ?${group.length + 1},
           updated = CURRENT_TIMESTAMP
       WHERE key IN (${marks})`,
    ).bind(...group, message.slice(0, 1000)).run();
  }
}

export async function reconcile(env: Env, batch: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE states
     SET state = 'stale',
         batch = ?1,
         updated = CURRENT_TIMESTAMP
     WHERE key IN (
       SELECT key FROM models WHERE active = 0
     )`,
  ).bind(batch).run();
}

export async function audit(env: Env, action: string, target: string, batch: string | null, data: unknown = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit (id, action, target, batch, data, created)
     VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)`,
  ).bind(crypto.randomUUID(), action, target, batch, JSON.stringify(data ?? {})).run();
}

export async function counts(env: Env): Promise<Record<string, number>> {
  const result = await env.DB.prepare(
    `SELECT state, COUNT(*) AS count
     FROM states
     GROUP BY state`,
  ).all<{ state: string; count: number }>();
  return Object.fromEntries((result.results ?? []).map((row) => [row.state, row.count]));
}

export async function repair(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT m.key, m.hash, m.batch, m.active
     FROM models m
     LEFT JOIN states s ON s.key = m.key
     WHERE s.key IS NULL`,
  ).all<Repair>();
  const items = result.results ?? [];
  if (items.length === 0) return 0;

  for (const group of chunk(items, 40)) {
    const statements: D1PreparedStatement[] = [];
    for (const item of group) {
      const value: ModelState = item.active === 1 ? "indexed" : "stale";
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO states (key, hash, state, attempts, batch, next, error, updated)
         VALUES (?1, ?2, ?3, 0, ?4, NULL, NULL, CURRENT_TIMESTAMP)`,
      ).bind(item.key, item.hash, value, item.batch));
      statements.push(env.DB.prepare(
        `INSERT INTO attempts (id, key, batch, stage, state, error, created)
         VALUES (?1, ?2, ?3, 'reconcile', ?4, NULL, CURRENT_TIMESTAMP)`,
      ).bind(
        crypto.randomUUID(),
        item.key,
        item.batch,
        value === "indexed" ? "succeeded" : "skipped",
      ));
    }
    await env.DB.batch(statements);
  }

  await audit(env, "repair", "models", null, {
    states: items.length,
    indexed: items.filter((item) => item.active === 1).length,
    stale: items.filter((item) => item.active !== 1).length,
  });

  return items.length;
}

export async function find(env: Env, keys: string[]): Promise<Row[]> {
  if (keys.length === 0) return [];
  const out: Row[] = [];
  for (const group of chunk(keys, 90)) {
    const marks = group.map((_, index) => `?${index + 1}`).join(", ");
    const result = await env.DB.prepare(
      `SELECT *
       FROM models
       WHERE active = 1
         AND key IN (${marks})`,
    ).bind(...group).all<Row>();
    out.push(...(result.results ?? []));
  }
  return out;
}

export async function exact(env: Env, modelId: string): Promise<Row | null> {
  const result = await env.DB.prepare(
    `SELECT *
     FROM models
     WHERE modelId = ?1
     ORDER BY active DESC, available DESC, updated DESC
     LIMIT 1`,
  ).bind(modelId).all<Row>();
  return result.results?.[0] ?? null;
}

export async function live(env: Env): Promise<Row[]> {
  const result = await env.DB.prepare(
    `SELECT *
     FROM models
     WHERE active = 1
       AND available = 1
     ORDER BY modelId ASC`,
  ).all<Row>();
  return result.results ?? [];
}

export async function page(env: Env, limit: number, cursor: number): Promise<Row[]> {
  const result = await env.DB.prepare(
    `SELECT *
     FROM models
     WHERE active = 1
     ORDER BY provider ASC, modelId ASC
     LIMIT ?1 OFFSET ?2`,
  ).bind(limit, cursor).all<Row>();
  return result.results ?? [];
}

export function stale(env: Env, batch: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE models
     SET active = 0,
         updated = CURRENT_TIMESTAMP
     WHERE batch != ?1
       AND active = 1`,
  ).bind(batch);
}

export function prune(env: Env): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM embeds
     WHERE key NOT IN (
       SELECT key FROM models WHERE active = 1
     )`,
  );
}

export const test = { schema, repair };
