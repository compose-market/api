import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type { Filters, Settlement, StoredRequest } from "./types.js";

type Sql = NeonQueryFunction<false, false>;

export interface Cursor {
  at: string;
  id: string;
}

let client: Sql | null = null;
let ready: Promise<void> | null = null;

function sql(): Sql {
  if (!client) {
    const url = process.env.ANALYTICS_DATABASE_URL?.trim();
    if (!url) throw new Error("ANALYTICS_DATABASE_URL is required");
    client = neon(url);
  }
  return client;
}

export async function ensure(): Promise<void> {
  ready ??= migrate();
  return ready;
}

async function migrate(): Promise<void> {
  const db = sql();
  await db.query("CREATE SCHEMA IF NOT EXISTS inference");
  await db.query(`
    CREATE TABLE IF NOT EXISTS inference.requests (
      id TEXT PRIMARY KEY,
      user_address TEXT NOT NULL,
      response_id TEXT NOT NULL,
      network TEXT NOT NULL,
      family TEXT NOT NULL,
      model TEXT NOT NULL,
      types JSONB NOT NULL,
      operation TEXT NOT NULL,
      streamed BOOLEAN NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      latency_ms INTEGER NOT NULL,
      time_to_first_token_ms INTEGER,
      usage JSONB NOT NULL,
      inference_amount_atomic NUMERIC(78, 0) NOT NULL,
      platform_fee_atomic NUMERIC(78, 0) NOT NULL,
      final_amount_atomic NUMERIC(78, 0) NOT NULL,
      settlement_ids JSONB NOT NULL,
      error JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS inference_requests_owner_time ON inference.requests(user_address, started_at DESC, id DESC)");
  await db.query("ALTER TABLE inference.requests ADD COLUMN IF NOT EXISTS network TEXT");
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'inference' AND table_name = 'requests' AND column_name = 'chain_id'
      ) THEN
        UPDATE inference.requests SET network = 'eip155:' || chain_id::text WHERE network IS NULL AND chain_id IS NOT NULL;
        ALTER TABLE inference.requests DROP COLUMN chain_id;
      END IF;
    END $$
  `);
  await db.query("ALTER TABLE inference.requests ALTER COLUMN network SET NOT NULL");
  await db.query("DROP INDEX IF EXISTS inference.inference_requests_dimensions");
  await db.query("CREATE INDEX IF NOT EXISTS inference_requests_dimensions ON inference.requests(user_address, network, family, model, operation, status)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS inference.settlements (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES inference.requests(id) ON DELETE CASCADE,
      user_address TEXT NOT NULL,
      network TEXT NOT NULL,
      family TEXT NOT NULL,
      model TEXT NOT NULL,
      types JSONB NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      transaction_hash TEXT,
      claim_transaction_hash TEXT,
      settle_transaction_hash TEXT,
      priced_units JSONB NOT NULL,
      inference_amount_atomic NUMERIC(78, 0) NOT NULL,
      platform_fee_atomic NUMERIC(78, 0) NOT NULL,
      final_amount_atomic NUMERIC(78, 0) NOT NULL,
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS inference_settlements_owner_time ON inference.settlements(user_address, created_at DESC, id DESC)");
  await db.query("ALTER TABLE inference.settlements ADD COLUMN IF NOT EXISTS network TEXT");
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'inference' AND table_name = 'settlements' AND column_name = 'chain_id'
      ) THEN
        UPDATE inference.settlements SET network = 'eip155:' || chain_id::text WHERE network IS NULL AND chain_id IS NOT NULL;
        ALTER TABLE inference.settlements DROP COLUMN chain_id;
      END IF;
    END $$
  `);
  await db.query("ALTER TABLE inference.settlements ALTER COLUMN network SET NOT NULL");
  await db.query("DROP INDEX IF EXISTS inference.inference_settlements_status");
  await db.query("CREATE INDEX IF NOT EXISTS inference_settlements_status ON inference.settlements(user_address, network, status)");
}

export async function insertRequest(request: StoredRequest, settlements: Settlement[]): Promise<void> {
  await ensure();
  await sql().query(`
    INSERT INTO inference.requests (
      id, user_address, response_id, network, family, model, types, operation,
      streamed, status, started_at, completed_at, latency_ms, time_to_first_token_ms,
      usage, inference_amount_atomic, platform_fee_atomic, final_amount_atomic,
      settlement_ids, error
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb
    )
  `, [
    request.id, request.userAddress, request.responseId, request.network,
    request.family, request.model, JSON.stringify(request.types), request.operation, request.streamed,
    request.status, request.startedAt, request.completedAt, request.latencyMs,
    request.timeToFirstTokenMs ?? null, JSON.stringify(request.usage),
    request.billing.inferenceAmountAtomic, request.billing.platformFeeAtomic,
    request.billing.finalAmountAtomic, JSON.stringify(request.settlementIds),
    request.error ? JSON.stringify(request.error) : null,
  ]);

  for (const settlement of settlements) {
    await sql().query(`
      INSERT INTO inference.settlements (
        id, request_id, user_address, network, family, model, types, operation, status, transaction_hash,
        claim_transaction_hash, settle_transaction_hash, priced_units,
        inference_amount_atomic, platform_fee_atomic, final_amount_atomic,
        settled_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
    `, [
      settlement.id, settlement.requestId, request.userAddress, settlement.network,
      settlement.family, settlement.model, JSON.stringify(settlement.types), settlement.operation,
      settlement.status, settlement.transactionHash ?? null,
      settlement.claimTransactionHash ?? null, settlement.settleTransactionHash ?? null,
      JSON.stringify(settlement.pricedUnits), settlement.billing.inferenceAmountAtomic,
      settlement.billing.platformFeeAtomic, settlement.billing.finalAmountAtomic,
      settlement.settledAt ?? null, settlement.createdAt,
    ]);
  }
}

export interface QueryResult {
  allRequests: StoredRequest[];
  allSettlements: Settlement[];
  requests: StoredRequest[];
  settlements: Settlement[];
}

type QueryInput = Omit<Filters, "requestCursor" | "settlementCursor"> & {
  userAddress: string;
  limit: number;
  requestCursor?: Cursor;
  settlementCursor?: Cursor;
};

export async function query(input: QueryInput): Promise<QueryResult> {
  await ensure();
  const requestParams: unknown[] = [input.userAddress.toLowerCase()];
  const requestWhere = where(input, requestParams, "request", undefined);
  const allRequestRows = await sql().query(
    `SELECT * FROM inference.requests WHERE ${requestWhere} ORDER BY started_at DESC, id DESC`,
    requestParams,
  ) as Record<string, unknown>[];

  const settlementParams: unknown[] = [input.userAddress.toLowerCase()];
  const settlementWhere = where(input, settlementParams, "settlement", undefined);
  const allSettlementRows = await sql().query(
    `SELECT settlements.* FROM inference.settlements settlements JOIN inference.requests requests ON requests.id = settlements.request_id WHERE ${settlementWhere} ORDER BY settlements.created_at DESC, settlements.id DESC`,
    settlementParams,
  ) as Record<string, unknown>[];

  const pagedRequestParams: unknown[] = [input.userAddress.toLowerCase()];
  const pagedRequestWhere = where(input, pagedRequestParams, "request", input.requestCursor);
  const requestRows = await sql().query(
    `SELECT * FROM inference.requests WHERE ${pagedRequestWhere} ORDER BY started_at DESC, id DESC LIMIT ${input.limit + 1}`,
    pagedRequestParams,
  ) as Record<string, unknown>[];

  const pagedSettlementParams: unknown[] = [input.userAddress.toLowerCase()];
  const pagedSettlementWhere = where(input, pagedSettlementParams, "settlement", input.settlementCursor);
  const settlementRows = await sql().query(
    `SELECT settlements.* FROM inference.settlements settlements JOIN inference.requests requests ON requests.id = settlements.request_id WHERE ${pagedSettlementWhere} ORDER BY settlements.created_at DESC, settlements.id DESC LIMIT ${input.limit + 1}`,
    pagedSettlementParams,
  ) as Record<string, unknown>[];

  return {
    allRequests: allRequestRows.map(mapRequest),
    allSettlements: allSettlementRows.map(mapSettlement),
    requests: requestRows.map(mapRequest),
    settlements: settlementRows.map(mapSettlement),
  };
}

function where(input: Omit<Filters, "requestCursor" | "settlementCursor">, params: unknown[], kind: "request" | "settlement", cursor?: Cursor): string {
  const requestPrefix = kind === "settlement" ? "requests." : "";
  const settlementPrefix = kind === "settlement" ? "settlements." : "";
  const parts = [`${requestPrefix}user_address = $1`];
  const add = (column: string, value: unknown) => {
    if (value === undefined || value === "") return;
    params.push(value);
    parts.push(`${column} = $${params.length}`);
  };
  add(`${requestPrefix}network`, input.network);
  add(`${requestPrefix}family`, input.family);
  add(`${requestPrefix}model`, input.model);
  if (input.type) {
    params.push(JSON.stringify([input.type]));
    parts.push(`${requestPrefix}types @> $${params.length}::jsonb`);
  }
  add(`${requestPrefix}operation`, input.operation);
  add(`${requestPrefix}status`, input.status);
  if (kind === "settlement") add(`${settlementPrefix}status`, input.settlementStatus);
  const time = kind === "request" ? "started_at" : `${settlementPrefix}created_at`;
  if (input.from) {
    params.push(input.from);
    parts.push(`${time} >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    parts.push(`${time} <= $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.at, cursor.id);
    parts.push(`(${time}, ${kind === "settlement" ? settlementPrefix : ""}id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  return parts.join(" AND ");
}

function text(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapRequest(row: Record<string, unknown>): StoredRequest {
  return {
    id: String(row.id), userAddress: String(row.user_address), responseId: String(row.response_id),
    network: String(row.network) as StoredRequest["network"], family: String(row.family), model: String(row.model),
    types: Array.isArray(row.types) ? row.types as string[] : [], operation: String(row.operation), streamed: Boolean(row.streamed),
    status: String(row.status) as StoredRequest["status"], startedAt: text(row.started_at)!,
    completedAt: text(row.completed_at)!, latencyMs: number(row.latency_ms),
    timeToFirstTokenMs: row.time_to_first_token_ms == null ? undefined : number(row.time_to_first_token_ms),
    usage: row.usage as StoredRequest["usage"],
    billing: {
      inferenceAmountAtomic: String(row.inference_amount_atomic), platformFeeAtomic: String(row.platform_fee_atomic),
      finalAmountAtomic: String(row.final_amount_atomic), currency: "USDC", decimals: 6,
    },
    settlementIds: Array.isArray(row.settlement_ids) ? row.settlement_ids as string[] : [],
    error: row.error && typeof row.error === "object" ? row.error as StoredRequest["error"] : undefined,
  };
}

function mapSettlement(row: Record<string, unknown>): Settlement {
  return {
    id: String(row.id), requestId: String(row.request_id), network: String(row.network) as Settlement["network"],
    family: String(row.family), model: String(row.model),
    types: Array.isArray(row.types) ? row.types as string[] : [], operation: String(row.operation),
    status: String(row.status) as Settlement["status"], transactionHash: text(row.transaction_hash),
    claimTransactionHash: text(row.claim_transaction_hash), settleTransactionHash: text(row.settle_transaction_hash),
    pricedUnits: Array.isArray(row.priced_units) ? row.priced_units as Settlement["pricedUnits"] : [],
    billing: {
      inferenceAmountAtomic: String(row.inference_amount_atomic), platformFeeAtomic: String(row.platform_fee_atomic),
      finalAmountAtomic: String(row.final_amount_atomic), currency: "USDC", decimals: 6,
    },
    settledAt: text(row.settled_at), createdAt: text(row.created_at)!,
  };
}
