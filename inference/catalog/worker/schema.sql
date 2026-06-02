-- catalog worker D1 schema
-- D1 rows serve the cleaned model catalog. Exact raw and cleaned JSON
-- snapshots live in R2.

CREATE TABLE IF NOT EXISTS imports (
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
);

CREATE INDEX IF NOT EXISTS idx_imports_state ON imports(state, updated);

CREATE TABLE IF NOT EXISTS models (
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
);

CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider, active);
CREATE INDEX IF NOT EXISTS idx_models_stream ON models(stream, active);
CREATE INDEX IF NOT EXISTS idx_models_context ON models(contextTokens, active);
CREATE INDEX IF NOT EXISTS idx_models_batch ON models(batch);

CREATE TABLE IF NOT EXISTS embeds (
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
);

CREATE INDEX IF NOT EXISTS idx_embeds_model ON embeds(model, created);

CREATE TABLE IF NOT EXISTS states (
  key       TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('queued', 'skipped', 'indexed', 'stale', 'failed')),
  attempts  INTEGER NOT NULL DEFAULT 0,
  batch     TEXT NOT NULL,
  next      TEXT,
  error     TEXT,
  updated   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (key) REFERENCES models(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_states_state ON states(state, next, updated);
CREATE INDEX IF NOT EXISTS idx_states_batch ON states(batch, updated);

CREATE TABLE IF NOT EXISTS attempts (
  id       TEXT PRIMARY KEY,
  key      TEXT NOT NULL,
  batch    TEXT NOT NULL,
  stage    TEXT NOT NULL,
  state    TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'skipped')),
  error    TEXT,
  created  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attempts_key ON attempts(key, created);
CREATE INDEX IF NOT EXISTS idx_attempts_batch ON attempts(batch, created);

CREATE TABLE IF NOT EXISTS audit (
  id       TEXT PRIMARY KEY,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL,
  batch    TEXT,
  data     TEXT NOT NULL DEFAULT '{}',
  created  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, created);
