import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type Sql = NeonQueryFunction<false, false>;

let client: Sql | null = null;
let ready: Promise<void> | null = null;

function url(): string {
    const value = process.env.METRICS_DATABASE_URL?.trim();
    if (!value) {
        throw new Error("METRICS_DATABASE_URL is required");
    }
    return value;
}

export function sql(): Sql {
    if (!client) {
        client = neon(url());
    }
    return client;
}

export async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    return await sql().query(query, params) as T[];
}

export async function ensure(): Promise<void> {
    if (!ready) {
        ready = migrate().catch((error) => {
            ready = null;
            throw error;
        });
    }
    return ready;
}

async function migrate(): Promise<void> {
    const db = sql();

    await db.query(`
        CREATE TABLE IF NOT EXISTS downloads (
            package    TEXT NOT NULL,
            day        DATE NOT NULL,
            downloads  INTEGER NOT NULL CHECK (downloads >= 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (package, day)
        )
    `);

    await db.query(`DROP TABLE IF EXISTS invoices`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS payments (
            network       TEXT NOT NULL,
            tx_hash       TEXT NOT NULL,
            amount_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0,
            source        TEXT NOT NULL DEFAULT 'settlement' CHECK (source IN ('history', 'settlement')),
            settled_at    TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (network, tx_hash)
        )
    `);
    await db.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'chain_id') THEN
            ALTER TABLE payments ADD COLUMN IF NOT EXISTS network TEXT;
            UPDATE payments
               SET network = 'eip155:' || chain_id::text
             WHERE network IS NULL OR network = '';
            ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_pkey;
            ALTER TABLE payments ALTER COLUMN network SET NOT NULL;
            ALTER TABLE payments ADD CONSTRAINT payments_pkey PRIMARY KEY (network, tx_hash);
            ALTER TABLE payments DROP COLUMN chain_id;
          END IF;
        END $$
    `);
    await db.query(`ALTER TABLE payments ALTER COLUMN source SET DEFAULT 'settlement'`);
    await db.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'payments_source_check'
              AND conrelid = 'payments'::regclass
          ) THEN
            ALTER TABLE payments ADD CONSTRAINT payments_source_check CHECK (source IN ('history', 'settlement'));
          END IF;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_updated ON payments(updated_at)`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS logical_settlements (
            receipt_id         TEXT PRIMARY KEY,
            network            TEXT NOT NULL,
            status             TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'claimed', 'settled', 'failed')),
            amount_atomic      NUMERIC(78, 0) NOT NULL CHECK (amount_atomic >= 0),
            settled_at         TIMESTAMPTZ,
            transaction_hash   TEXT,
            payment_intent_id  TEXT,
            payment_channel_id TEXT,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logical_settlements_status_settled ON logical_settlements(status, settled_at)`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            key_id       TEXT PRIMARY KEY,
            user_address TEXT,
            network      TEXT,
            created_at   TIMESTAMPTZ,
            recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await db.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS network TEXT`);
    await db.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'chain_id') THEN
            UPDATE sessions SET network = 'eip155:' || chain_id::text WHERE network IS NULL AND chain_id IS NOT NULL;
            ALTER TABLE sessions DROP COLUMN chain_id;
          END IF;
        END $$
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_recorded ON sessions(recorded_at)`);
    await db.query(`DROP TABLE IF EXISTS intents`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS state (
            name       TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS expenses (
            provider    TEXT NOT NULL,
            day         DATE NOT NULL,
            cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
            currency    TEXT NOT NULL DEFAULT 'USD',
            details     JSONB,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (provider, day)
        )
    `);
}

export async function getState(name: string): Promise<string | undefined> {
    await ensure();
    const result = await rows<{ value: string }>(
        `SELECT value FROM state WHERE name = $1 LIMIT 1`,
        [name],
    );
    return result[0]?.value;
}

export async function setState(name: string, value: string): Promise<void> {
    await ensure();
    await sql().query(
        `INSERT INTO state (name, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET
           value = EXCLUDED.value,
           updated_at = now()`,
        [name, value],
    );
}

export async function stateUpdatedAt(name: string): Promise<string | undefined> {
    await ensure();
    const result = await rows<{ updated_at: Date | string }>(
        `SELECT updated_at FROM state WHERE name = $1 LIMIT 1`,
        [name],
    );
    const value = result[0]?.updated_at;
    return value instanceof Date ? value.toISOString() : value;
}
