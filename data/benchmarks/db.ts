import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type {
    BenchmarkModelLink,
    BenchmarkObservationRow,
    BenchmarkOperation,
    BenchmarkVariant,
} from "./types.js";

type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, unknown>;

let client: Sql | null = null;
let ready: Promise<void> | null = null;

export function benchmarkDatabaseUrl(): string {
    const url = process.env.BENCHMARKS_DATABASE_URL?.trim();
    if (!url) throw new Error("BENCHMARKS_DATABASE_URL is required");
    return url;
}

function sql(): Sql {
    if (!client) client = neon(benchmarkDatabaseUrl());
    return client;
}

export async function ensureBenchmarkDatabase(): Promise<void> {
    if (!ready) {
        ready = migrateBenchmarkDatabase().catch((error) => {
            ready = null;
            throw error;
        });
    }
    await ready;
}

async function migrateBenchmarkDatabase(): Promise<void> {
    const db = sql();

    await db.query(`
        CREATE TABLE IF NOT EXISTS benchmark_runs (
            id TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            completed_at TIMESTAMPTZ,
            fetched_at TIMESTAMPTZ,
            source_version TEXT,
            intelligence_index_version NUMERIC,
            payload_hash TEXT,
            request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
            model_count INTEGER NOT NULL DEFAULT 0 CHECK (model_count >= 0),
            error_code TEXT,
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_latest
        ON benchmark_runs(endpoint, completed_at DESC)
        WHERE status = 'succeeded'
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS benchmark_source_models (
            source TEXT NOT NULL,
            source_model_id TEXT NOT NULL,
            source_slug TEXT,
            source_name TEXT NOT NULL,
            source_creator_name TEXT NOT NULL,
            source_creator_slug TEXT NOT NULL,
            release_date TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (source_model_id)
        )
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_benchmark_source_models_slug
        ON benchmark_source_models(source, source_slug)
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS benchmark_observations (
            run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
            source_model_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            variant TEXT,
            power_group TEXT NOT NULL,
            is_best_variant BOOLEAN NOT NULL DEFAULT false,
            metrics JSONB NOT NULL,
            payload JSONB NOT NULL,
            observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (run_id, source_model_id),
            FOREIGN KEY (source_model_id)
                REFERENCES benchmark_source_models(source_model_id)
                ON DELETE CASCADE
        )
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_benchmark_observations_current
        ON benchmark_observations(operation, variant, is_best_variant, observed_at DESC)
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS benchmark_model_links (
            operation TEXT NOT NULL,
            source_model_id TEXT NOT NULL,
            catalog_model_id TEXT,
            catalog_provider TEXT,
            match_method TEXT NOT NULL,
            match_confidence NUMERIC NOT NULL DEFAULT 0,
            reviewed BOOLEAN NOT NULL DEFAULT false,
            catalog_version TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (operation, source_model_id),
            FOREIGN KEY (source_model_id)
                REFERENCES benchmark_source_models(source_model_id)
                ON DELETE CASCADE
        )
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_benchmark_model_links_catalog
        ON benchmark_model_links(catalog_provider, catalog_model_id)
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS benchmark_ingestion_locks (
            name TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

export interface LatestObservationRecord {
    sourceModelId: string;
    sourceSlug: string | null;
    sourceName: string;
    sourceCreatorName: string;
    sourceCreatorSlug: string;
    releaseDate: string | null;
    operation: BenchmarkOperation;
    variant: BenchmarkVariant;
    metrics: Record<string, number | null>;
    payload: Record<string, unknown>;
    observedAt: string;
    fetchedAt: string | null;
    sourceVersion: string | null;
    intelligenceIndexVersion: number | null;
    catalogModelId: string | null;
    catalogProvider: string | null;
    matchMethod: string;
    matchConfidence: number;
}

export async function beginBenchmarkRun(id: string, endpoint: string): Promise<void> {
    await ensureBenchmarkDatabase();
    await sql().query(
        `INSERT INTO benchmark_runs (id, endpoint, status)
         VALUES ($1, $2, 'running')`,
        [id, endpoint],
    );
}

export async function completeBenchmarkRun(input: {
    id: string;
    endpoint: string;
    operation: BenchmarkOperation;
    fetchedAt: string;
    sourceVersion: string | null;
    intelligenceIndexVersion: number | null;
    payloadHash: string;
    requestCount: number;
    records: Array<{
        source: string;
        sourceModelId: string;
        sourceSlug: string | null;
        sourceName: string;
        sourceCreatorName: string;
        sourceCreatorSlug: string;
        releaseDate: string | null;
    }>;
    observations: BenchmarkObservationRow[];
    links: BenchmarkModelLink[];
}): Promise<void> {
    await ensureBenchmarkDatabase();
    await sql().transaction((transaction) => [
        // Source identities are upserted before observations to satisfy FKs.
        ...input.records.map((record) => transaction.query(
            `INSERT INTO benchmark_source_models (
                source, source_model_id, source_slug, source_name,
                source_creator_name, source_creator_slug, release_date, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
             ON CONFLICT (source_model_id) DO UPDATE SET
                source_slug = EXCLUDED.source_slug,
                source_name = EXCLUDED.source_name,
                source_creator_name = EXCLUDED.source_creator_name,
                source_creator_slug = EXCLUDED.source_creator_slug,
                release_date = EXCLUDED.release_date,
                updated_at = now()`,
            [
                record.source,
                record.sourceModelId,
                record.sourceSlug,
                record.sourceName,
                record.sourceCreatorName,
                record.sourceCreatorSlug,
                record.releaseDate,
            ],
        )),
        ...input.observations.map((observation) => transaction.query(
            `INSERT INTO benchmark_observations (
                run_id, source_model_id, operation, variant, power_group,
                is_best_variant, metrics, payload
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
            [
                observation.runId,
                observation.sourceModelId,
                observation.operation,
                observation.variant,
                observation.powerGroup,
                observation.isBestVariant,
                JSON.stringify(observation.metrics),
                JSON.stringify(observation.payload),
            ],
        )),
        ...input.links.map((link) => transaction.query(
            `INSERT INTO benchmark_model_links (
                operation, source_model_id, catalog_model_id, catalog_provider,
                match_method, match_confidence, reviewed, catalog_version, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
             ON CONFLICT (operation, source_model_id) DO UPDATE SET
                catalog_model_id = EXCLUDED.catalog_model_id,
                catalog_provider = EXCLUDED.catalog_provider,
                match_method = EXCLUDED.match_method,
                match_confidence = EXCLUDED.match_confidence,
                reviewed = benchmark_model_links.reviewed,
                catalog_version = EXCLUDED.catalog_version,
                updated_at = now()`,
            [
                link.operation,
                link.sourceModelId,
                link.catalogModelId,
                link.catalogProvider,
                link.matchMethod,
                link.matchConfidence,
                link.reviewed,
                link.catalogVersion,
            ],
        )),
        // Mark this run succeeded BEFORE purging stale links: the purge's
        // NOT EXISTS guard only counts best-variants from latest SUCCESSFUL
        // runs, so the current run must be visible to it — otherwise links
        // for models ingested for the first time in this run are deleted
        // immediately after being inserted.
        transaction.query(
            `UPDATE benchmark_runs SET
                status = 'succeeded',
                completed_at = now(),
                fetched_at = $2,
                source_version = $3,
                intelligence_index_version = $4,
                payload_hash = $5,
                request_count = $6,
                model_count = $7
             WHERE id = $1`,
            [
                input.id,
                input.fetchedAt,
                input.sourceVersion,
                input.intelligenceIndexVersion,
                input.payloadHash,
                input.requestCount,
                input.records.length,
            ],
        ),
        // Purge link rows for models that are no longer best-variants in any
        // endpoint's latest successful run for this operation, so stale
        // unmatched rows (old power-variant selections) do not accumulate.
        transaction.query(
            `DELETE FROM benchmark_model_links l
             WHERE l.operation = $1
               AND NOT EXISTS (
                    SELECT 1
                    FROM benchmark_observations o
                    WHERE o.operation = l.operation
                      AND o.source_model_id = l.source_model_id
                      AND o.is_best_variant = true
                      AND o.run_id IN (
                          SELECT DISTINCT ON (r.endpoint) r.id
                          FROM benchmark_runs r
                          WHERE r.status = 'succeeded'
                            AND r.completed_at IS NOT NULL
                          ORDER BY r.endpoint, r.completed_at DESC
                      )
               )`,
            [input.operation],
        ),
    ]);
}

export async function failBenchmarkRun(id: string, error: unknown): Promise<void> {
    await ensureBenchmarkDatabase();
    const message = error instanceof Error ? error.message : String(error);
    await sql().query(
        `UPDATE benchmark_runs SET
            status = 'failed',
            completed_at = now(),
            error_code = 'ingestion_failed',
            error_message = left($2, 1000)
         WHERE id = $1`,
        [id, message],
    );
}

export async function latestBenchmarkObservations(): Promise<LatestObservationRecord[]> {
    await ensureBenchmarkDatabase();
    const rows = await sql().query(`
        WITH latest AS (
            SELECT DISTINCT ON (endpoint)
                id, endpoint, fetched_at, completed_at, source_version, intelligence_index_version
            FROM benchmark_runs
            WHERE status = 'succeeded'
            ORDER BY endpoint, completed_at DESC
        )
        SELECT
            sm.source_model_id,
            sm.source_slug,
            sm.source_name,
            sm.source_creator_name,
            sm.source_creator_slug,
            sm.release_date,
            o.operation,
            o.variant,
            o.metrics,
            o.payload,
            o.observed_at,
            l.fetched_at,
            l.completed_at AS published_at,
            l.source_version,
            l.intelligence_index_version,
            links.catalog_model_id,
            links.catalog_provider,
            links.match_method,
            links.match_confidence
        FROM latest l
        JOIN benchmark_observations o ON o.run_id = l.id
        JOIN benchmark_source_models sm ON sm.source_model_id = o.source_model_id
        LEFT JOIN benchmark_model_links links
            ON links.operation = o.operation
           AND links.source_model_id = o.source_model_id
        WHERE o.is_best_variant = true
    `) as Row[];

    return rows.map((row) => ({
        sourceModelId: String(row.source_model_id),
        sourceSlug: row.source_slug == null ? null : String(row.source_slug),
        sourceName: String(row.source_name),
        sourceCreatorName: String(row.source_creator_name),
        sourceCreatorSlug: String(row.source_creator_slug),
        releaseDate: row.release_date == null ? null : String(row.release_date),
        operation: row.operation as BenchmarkOperation,
        variant: row.variant == null ? null : row.variant as BenchmarkVariant,
        metrics: typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics as Record<string, number | null>,
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload as Record<string, unknown>,
        observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at),
        fetchedAt: row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at == null ? null : String(row.fetched_at),
        sourceVersion: row.source_version == null ? null : String(row.source_version),
        intelligenceIndexVersion: row.intelligence_index_version == null ? null : Number(row.intelligence_index_version),
        catalogModelId: row.catalog_model_id == null ? null : String(row.catalog_model_id),
        catalogProvider: row.catalog_provider == null ? null : String(row.catalog_provider),
        matchMethod: String(row.match_method ?? "unmatched"),
        matchConfidence: Number(row.match_confidence ?? 0),
    }));
}

export async function tryAcquireIngestionLock(name: string, owner: string): Promise<boolean> {
    await ensureBenchmarkDatabase();
    await sql().query(
        `DELETE FROM benchmark_ingestion_locks
         WHERE name = $1 AND acquired_at < now() - interval '30 minutes'`,
        [name],
    );
    const rows = await sql().query(
        `INSERT INTO benchmark_ingestion_locks (name, owner)
         VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING
         RETURNING name`,
        [name, owner],
    ) as Row[];
    return rows.length > 0;
}

export async function releaseIngestionLock(name: string, owner: string): Promise<void> {
    await ensureBenchmarkDatabase();
    await sql().query(
        `DELETE FROM benchmark_ingestion_locks WHERE name = $1 AND owner = $2`,
        [name, owner],
    );
}
