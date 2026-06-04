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
        ready = migrate();
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
            chain_id      INTEGER NOT NULL,
            tx_hash       TEXT NOT NULL,
            amount_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0,
            source        TEXT NOT NULL DEFAULT 'settlement' CHECK (source IN ('history', 'settlement')),
            settled_at    TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (chain_id, tx_hash)
        )
    `);
    await db.query(`ALTER TABLE payments ALTER COLUMN source SET DEFAULT 'settlement'`);
    await db.query(`ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_source_check`);
    await db.query(`ALTER TABLE payments ADD CONSTRAINT payments_source_check CHECK (source IN ('history', 'settlement'))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_updated ON payments(updated_at)`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            key_id       TEXT PRIMARY KEY,
            user_address TEXT,
            chain_id     INTEGER,
            created_at   TIMESTAMPTZ,
            recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
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
