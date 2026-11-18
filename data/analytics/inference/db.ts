import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type { WalletScope } from "../../user/types.js";
import type { Filters, Settlement, StoredRequest } from "./types.js";
import type { InferenceSettlementTelemetry, InferenceTelemetryLifecycle } from "../../../inference/events.js";

type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, unknown>;

export interface Cursor {
  at: string;
  id: string;
}

export interface AnalyticsReadStatement {
  text: string;
  params: readonly unknown[];
}

export interface AnalyticsReadOptions {
  isolationLevel: "RepeatableRead";
  readOnly: true;
}

export interface AnalyticsReadExecutor {
  transaction(
    statements: readonly AnalyticsReadStatement[],
    options: AnalyticsReadOptions,
  ): Promise<Row[][]>;
}

export interface QueryResult {
  requestAggregates: Row[];
  settlementAggregates: Row[];
  requests: Row[];
  settlements: Row[];
}

export type QueryInput = Omit<Filters, "requestCursor" | "settlementCursor" | "networks"> & {
  scopes: readonly WalletScope[];
  interval: NonNullable<Filters["interval"]>;
  limit: number;
  requestCursor?: Cursor;
  settlementCursor?: Cursor;
};

let client: Sql | null = null;

function sql(): Sql {
  if (!client) {
    const url = process.env.ANALYTICS_DATABASE_URL?.trim();
    if (!url) throw new Error("ANALYTICS_DATABASE_URL is required");
    client = neon(url);
  }
  return client;
}

function defaultReadExecutor(): AnalyticsReadExecutor {
  return {
    async transaction(statements, options) {
      return await sql().transaction(
        (transaction) => statements.map((statement) => transaction.query(statement.text, [...statement.params])),
        options,
      ) as Row[][];
    },
  };
}

const REQUEST_UPSERT = `
    INSERT INTO inference.requests (
      id, user_address, response_id, network, family, model, types, operation,
      streamed, status, started_at, completed_at, latency_ms, time_to_first_token_ms,
      usage, inference_amount_atomic, platform_fee_atomic, final_amount_atomic,
      settlement_ids, error
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb
    ) ON CONFLICT (id) DO UPDATE SET
      user_address = EXCLUDED.user_address,
      response_id = EXCLUDED.response_id,
      network = EXCLUDED.network,
      family = EXCLUDED.family,
      model = EXCLUDED.model,
      types = EXCLUDED.types,
      operation = EXCLUDED.operation,
      streamed = EXCLUDED.streamed,
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      latency_ms = EXCLUDED.latency_ms,
      time_to_first_token_ms = COALESCE(EXCLUDED.time_to_first_token_ms, inference.requests.time_to_first_token_ms),
      usage = EXCLUDED.usage,
      inference_amount_atomic = EXCLUDED.inference_amount_atomic,
      platform_fee_atomic = EXCLUDED.platform_fee_atomic,
      final_amount_atomic = EXCLUDED.final_amount_atomic,
      settlement_ids = EXCLUDED.settlement_ids,
      error = EXCLUDED.error
`;

const SETTLEMENT_INSERT = `
    INSERT INTO inference.settlements (
      id, request_id, user_address, network, family, model, types, operation, status, payment_intent_id, transaction_hash,
      claim_transaction_hash, settle_transaction_hash, priced_units,
      inference_amount_atomic, platform_fee_atomic, final_amount_atomic,
      settled_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19)
    ON CONFLICT (id) DO NOTHING
`;

function requestParams(request: StoredRequest): unknown[] {
  return [
    request.id, request.userAddress, request.responseId, request.network,
    request.family, request.model, JSON.stringify(request.types), request.operation, request.streamed,
    request.status, request.startedAt, request.completedAt, request.latencyMs,
    request.timeToFirstTokenMs ?? null, JSON.stringify(request.usage),
    request.billing.inferenceAmountAtomic, request.billing.platformFeeAtomic,
    request.billing.finalAmountAtomic, JSON.stringify(request.settlementIds),
    request.error ? JSON.stringify(request.error) : null,
  ];
}

function settlementParams(request: StoredRequest, settlement: Settlement): unknown[] {
  return [
      settlement.id, request.id, request.userAddress, settlement.network,
      settlement.family, settlement.model, JSON.stringify(settlement.types), settlement.operation,
      settlement.status, settlement.paymentIntentId ?? null, settlement.transactionHash ?? null,
      settlement.claimTransactionHash ?? null, settlement.settleTransactionHash ?? null,
      JSON.stringify(settlement.pricedUnits), settlement.billing.inferenceAmountAtomic,
      settlement.billing.platformFeeAtomic, settlement.billing.finalAmountAtomic,
      settlement.settledAt ?? null, settlement.createdAt,
  ];
}

export function requestForSettlement(request: StoredRequest, settlement: Settlement): StoredRequest {
  const at = settlement.createdAt;
  const startedMs = Date.parse(request.startedAt);
  const atMs = Date.parse(at);
  const derivedLatency = Number.isFinite(request.latencyMs) && request.latencyMs > 0
    ? request.latencyMs
    : Number.isFinite(startedMs) && Number.isFinite(atMs)
      ? Math.max(0, Math.round(atMs - startedMs))
      : 0;
  const usage = "usage" in settlement && settlement.usage
    ? settlement.usage
    : { metrics: {}, units: settlement.pricedUnits.map(({ unitPriceUsd: _, amountAtomic: __, ...unit }) => unit) };
  return {
    ...request,
    id: settlement.id,
    family: settlement.family,
    model: settlement.model,
    types: settlement.types,
    operation: settlement.operation,
    status: settlement.status === "failed" ? "failed" : "succeeded",
    startedAt: request.startedAt || at,
    completedAt: at,
    latencyMs: derivedLatency,
    usage,
    billing: settlement.billing,
    settlementIds: [settlement.id],
    error: undefined,
  };
}

export async function insertRequest(request: StoredRequest, settlements: Settlement[]): Promise<void> {
  if (settlements.length === 0) {
    await sql().query(REQUEST_UPSERT, requestParams(request));
    return;
  }
  for (const settlement of settlements) {
    const call = requestForSettlement(request, settlement);
    await sql().transaction((transaction) => [
      transaction.query(REQUEST_UPSERT, requestParams(call)),
      transaction.query(SETTLEMENT_INSERT, settlementParams(call, settlement)),
    ]);
  }
}

export async function insertSettlementCheckpoint(
  lifecycle: InferenceTelemetryLifecycle,
  settlement: InferenceSettlementTelemetry,
): Promise<void> {
  const request = requestForSettlementCheckpoint(lifecycle, settlement);
  await sql().transaction((transaction) => [
    transaction.query(REQUEST_UPSERT, requestParams(request)),
    transaction.query(SETTLEMENT_INSERT, settlementParams(request, settlement)),
  ]);
}

export function requestForSettlementCheckpoint(
  lifecycle: InferenceTelemetryLifecycle,
  settlement: InferenceSettlementTelemetry,
): StoredRequest {
  const at = settlement.createdAt;
  const atMs = Date.parse(at);
  const latencyMs = Number.isFinite(atMs) && Number.isFinite(lifecycle.startedAt)
    ? Math.max(0, Math.round(atMs - lifecycle.startedAt))
    : 0;
  const startedAtIso = Number.isFinite(lifecycle.startedAt)
    ? new Date(lifecycle.startedAt).toISOString()
    : at;
  return {
    id: settlement.id,
    userAddress: lifecycle.userAddress,
    responseId: lifecycle.request.responseId,
    network: settlement.network,
    family: settlement.family,
    model: settlement.model,
    types: settlement.types,
    operation: settlement.operation,
    streamed: lifecycle.request.stream,
    status: settlement.status === "failed" ? "failed" : "succeeded",
    startedAt: startedAtIso,
    completedAt: at,
    latencyMs,
    timeToFirstTokenMs: lifecycle.firstOutputAt === undefined
      ? undefined
      : lifecycle.firstOutputAt - lifecycle.startedAt,
    usage: settlement.usage,
    billing: settlement.billing,
    settlementIds: [settlement.id],
  };
}

export interface AnalyticsQueryExecutor {
  query(statement: string, params?: unknown[]): Promise<unknown[]>;
}

export type CanonicalPaymentIntentSettlementProjection =
  | { paymentIntentId: string; status: "confirmed"; transactionHash: string; confirmedAt: number }
  | { paymentIntentId: string; status: "failed"; transactionHash?: string };

export async function projectCanonicalPaymentIntentSettlement(
  input: CanonicalPaymentIntentSettlementProjection,
  executor?: AnalyticsQueryExecutor,
): Promise<boolean> {
  let statement: string;
  let params: unknown[];
  if (input.status === "confirmed") {
    if (!input.transactionHash) throw new Error("Confirmed payment intent is missing its transaction identity");
    if (!Number.isFinite(input.confirmedAt)) throw new Error("Confirmed payment intent is missing its confirmation time");
    statement = `
      UPDATE inference.settlements
      SET status = 'settled', transaction_hash = $2, settled_at = $3::timestamptz
      WHERE payment_intent_id = $1
      RETURNING id
    `;
    params = [input.paymentIntentId, input.transactionHash, new Date(input.confirmedAt).toISOString()];
  } else {
    statement = `
      UPDATE inference.settlements
      SET status = 'failed', transaction_hash = COALESCE($2, transaction_hash), settled_at = NULL
      WHERE payment_intent_id = $1
      RETURNING id
    `;
    params = [input.paymentIntentId, input.transactionHash ?? null];
  }
  const db = executor ?? sql();
  return (await db.query(statement, params)).length > 0;
}

function scopeParameters(scopes: readonly WalletScope[]): [string[], string[]] {
  if (scopes.length === 0) {
    const error = new Error("No enabled analytics networks") as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return [
    scopes.map((scope) => scope.network),
    scopes.map((scope) => scope.address),
  ];
}

const SCOPE_CTE = `
  scope(network, address) AS (
    SELECT zipped.network, zipped.address
    FROM unnest($1::text[], $2::text[]) AS zipped(network, address)
  )
`;

type FilterMode = "request" | "settlement-eligible" | "settlement";

function filterWhere(
  input: QueryInput,
  params: unknown[],
  mode: FilterMode,
  cursor?: Cursor,
): string {
  const requestAlias = "r";
  const settlementAlias = "s";
  const conditions: string[] = [];
  const add = (expression: string, value: unknown, cast = "") => {
    if (value === undefined || value === "") return;
    params.push(value);
    conditions.push(`${expression} = $${params.length}${cast}`);
  };

  add(`${requestAlias}.family`, input.family);
  add(`${requestAlias}.model`, input.model);
  if (input.type) {
    params.push(JSON.stringify([input.type]));
    conditions.push(`${requestAlias}.types @> $${params.length}::jsonb`);
  }
  add(`${requestAlias}.operation`, input.operation);
  add(`${requestAlias}.status`, input.status);
  if (mode === "request") conditions.push(`${requestAlias}.status <> 'in_progress'`);
  if (mode === "settlement") add(`${settlementAlias}.status`, input.settlementStatus);

  if (mode !== "settlement-eligible") {
    const time = mode === "request" ? `${requestAlias}.started_at` : `${settlementAlias}.created_at`;
    if (input.from) {
      params.push(input.from);
      conditions.push(`${time} >= $${params.length}`);
    }
    if (input.to) {
      params.push(input.to);
      conditions.push(`${time} <= $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.at, cursor.id);
      const id = mode === "request" ? `${requestAlias}.id` : `${settlementAlias}.id`;
      conditions.push(`(${time}, ${id}) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
  }
  return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}

function requestAggregateStatement(input: QueryInput, scope: [string[], string[]]): AnalyticsReadStatement {
  const params: unknown[] = [...scope, input.interval];
  const where = filterWhere(input, params, "request");
  return {
    params,
    text: `
      WITH ${SCOPE_CTE},
      filtered_requests AS (
        SELECT
          r.id, r.family, r.model, r.types, r.operation, r.streamed, r.status,
          r.started_at, r.completed_at, r.latency_ms, r.usage
        FROM inference.requests r
        JOIN scope
          ON scope.network = r.network
         AND scope.address = r.user_address
        ${where}
      ),
      dimensions AS (
        SELECT
          dimension.kind, dimension.key, r.id, r.family, r.types, r.streamed,
          r.status, r.started_at, r.completed_at, r.latency_ms, r.usage
        FROM filtered_requests r
        CROSS JOIN LATERAL (VALUES
          ('total'::text, ''::text),
          ('family'::text, r.family),
          ('model'::text, r.model),
          ('operation'::text, r.operation),
          ('status'::text, r.status),
          ('timeline'::text, to_char(date_trunc($3, r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ) AS dimension(kind, key)
        UNION ALL
        SELECT
          'type', request_type.value, r.id, r.family, r.types, r.streamed,
          r.status, r.started_at, r.completed_at, r.latency_ms, r.usage
        FROM filtered_requests r
        CROSS JOIN LATERAL jsonb_array_elements_text(r.types) AS request_type(value)
      ),
      request_stats AS (
        SELECT
          kind,
          key,
          COUNT(*)::integer AS total_requests,
          COUNT(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded_requests,
          COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_requests,
          COUNT(*) FILTER (WHERE status = 'aborted')::integer AS aborted_requests,
          COUNT(*) FILTER (WHERE streamed)::integer AS streamed_requests,
          COUNT(latency_ms)::integer AS latency_count,
          COALESCE(AVG(latency_ms), 0)::double precision AS average_ms,
          COALESCE(percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::double precision AS p50_ms,
          COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::double precision AS p95_ms,
          COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::double precision AS p99_ms,
          MAX(completed_at) AS last_at,
          MAX(started_at) AS order_at,
          (array_agg(family ORDER BY started_at DESC, id DESC))[1] AS label,
          (array_agg(types ORDER BY started_at DESC, id DESC))[1] AS types
        FROM dimensions
        GROUP BY kind, key
      ),
      metric_values AS (
        SELECT d.kind, d.key, metric.name,
          SUM(metric.value::numeric) AS quantity
        FROM dimensions d
        CROSS JOIN LATERAL jsonb_each_text(COALESCE(d.usage->'metrics', '{}'::jsonb)) AS metric(name, value)
        GROUP BY d.kind, d.key, metric.name
      ),
      metrics AS (
        SELECT kind, key, jsonb_object_agg(name, quantity ORDER BY name) AS value
        FROM metric_values
        GROUP BY kind, key
      ),
      unit_values AS (
        SELECT d.kind, d.key, unit.value->>'key' AS unit_key, unit.value->>'unit' AS unit_name,
          SUM((unit.value->>'quantity')::numeric) AS quantity
        FROM dimensions d
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.usage->'units', '[]'::jsonb)) AS unit(value)
        GROUP BY d.kind, d.key, unit.value->>'key', unit.value->>'unit'
      ),
      units AS (
        SELECT kind, key,
          jsonb_agg(
            jsonb_build_object('key', unit_key, 'unit', unit_name, 'quantity', quantity)
            ORDER BY unit_key, unit_name
          ) AS value
        FROM unit_values
        GROUP BY kind, key
      )
      SELECT
        stats.kind, stats.key, stats.total_requests, stats.succeeded_requests,
        stats.failed_requests, stats.aborted_requests, stats.streamed_requests,
        COALESCE(metrics.value, '{}'::jsonb) AS metrics,
        COALESCE(units.value, '[]'::jsonb) AS units,
        stats.latency_count, stats.average_ms, stats.p50_ms, stats.p95_ms, stats.p99_ms,
        stats.last_at, stats.order_at, stats.label, stats.types
      FROM request_stats stats
      LEFT JOIN metrics ON metrics.kind = stats.kind AND metrics.key = stats.key
      LEFT JOIN units ON units.kind = stats.kind AND units.key = stats.key
      ORDER BY stats.kind, stats.key
    `,
  };
}

function settlementAggregateStatement(input: QueryInput, scope: [string[], string[]]): AnalyticsReadStatement {
  const params: unknown[] = [...scope, input.interval];
  const eligibleWhere = filterWhere(input, params, "settlement-eligible");
  const requestRangeConditions: string[] = [];
  if (input.from) {
    params.push(input.from);
    requestRangeConditions.push(`r.started_at >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    requestRangeConditions.push(`r.started_at <= $${params.length}`);
  }
  const requestInRange = requestRangeConditions.length
    ? requestRangeConditions.join(" AND ")
    : "TRUE";
  const settlementConditions: string[] = [];
  if (input.settlementStatus) {
    params.push(input.settlementStatus);
    settlementConditions.push(`s.status = $${params.length}`);
  }
  if (input.from) {
    params.push(input.from);
    settlementConditions.push(`s.created_at >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    settlementConditions.push(`s.created_at <= $${params.length}`);
  }
  const settlementWhere = settlementConditions.length ? `WHERE ${settlementConditions.join(" AND ")}` : "";

  return {
    params,
    text: `
      WITH ${SCOPE_CTE},
      eligible_requests AS (
        SELECT r.id, r.family, r.model, r.types, r.operation, r.status,
          (${requestInRange}) AS request_in_range
        FROM inference.requests r
        JOIN scope
          ON scope.network = r.network
         AND scope.address = r.user_address
        ${eligibleWhere}
      ),
      filtered_settlements AS (
        SELECT
          s.id, s.status AS settlement_status, s.created_at,
          s.inference_amount_atomic, s.platform_fee_atomic, s.final_amount_atomic,
          r.family, r.model, r.types, r.operation, r.status AS request_status,
          r.request_in_range
        FROM inference.settlements s
        JOIN eligible_requests r ON r.id = s.request_id
        ${settlementWhere}
      ),
      dimensions AS (
        SELECT
          dimension.kind, dimension.key, s.id, s.created_at,
          s.inference_amount_atomic, s.platform_fee_atomic, s.final_amount_atomic
        FROM filtered_settlements s
        CROSS JOIN LATERAL (VALUES
          ('total'::text, ''::text),
          ('settlement'::text, s.settlement_status),
          ('timeline'::text, to_char(date_trunc($3, s.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ) AS dimension(kind, key)
        UNION ALL
        SELECT
          dimension.kind, dimension.key, s.id, s.created_at,
          s.inference_amount_atomic, s.platform_fee_atomic, s.final_amount_atomic
        FROM filtered_settlements s
        CROSS JOIN LATERAL (VALUES
          ('family'::text, s.family),
          ('model'::text, s.model),
          ('operation'::text, s.operation),
          ('status'::text, s.request_status)
        ) AS dimension(kind, key)
        WHERE s.request_in_range
        UNION ALL
        SELECT DISTINCT
          'type', request_type.value, s.id, s.created_at,
          s.inference_amount_atomic, s.platform_fee_atomic, s.final_amount_atomic
        FROM filtered_settlements s
        CROSS JOIN LATERAL jsonb_array_elements_text(s.types) AS request_type(value)
        WHERE s.request_in_range
      )
      SELECT
        kind,
        key,
        COALESCE(SUM(inference_amount_atomic), 0)::text AS inference_amount_atomic,
        COALESCE(SUM(platform_fee_atomic), 0)::text AS platform_fee_atomic,
        COALESCE(SUM(final_amount_atomic), 0)::text AS final_amount_atomic,
        MAX(created_at) AS last_at
      FROM dimensions
      GROUP BY kind, key
      ORDER BY kind, key
    `,
  };
}

function requestPageStatement(input: QueryInput, scope: [string[], string[]]): AnalyticsReadStatement {
  const params: unknown[] = [...scope];
  const where = filterWhere(input, params, "request", input.requestCursor);
  params.push(input.limit + 1);
  return {
    params,
    text: `
      WITH ${SCOPE_CTE}
      SELECT
        r.id, r.user_address, r.response_id, r.network, r.family, r.model,
        r.types, r.operation, r.streamed, r.status, r.started_at, r.completed_at,
        r.latency_ms, r.time_to_first_token_ms, r.usage,
        r.inference_amount_atomic, r.platform_fee_atomic, r.final_amount_atomic,
        r.settlement_ids, r.error
      FROM inference.requests r
      JOIN scope
        ON scope.network = r.network
       AND scope.address = r.user_address
      ${where}
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT $${params.length}
    `,
  };
}

function settlementPageStatement(input: QueryInput, scope: [string[], string[]]): AnalyticsReadStatement {
  const params: unknown[] = [...scope];
  const where = filterWhere(input, params, "settlement", input.settlementCursor);
  params.push(input.limit + 1);
  return {
    params,
    text: `
      WITH ${SCOPE_CTE}
      SELECT
        s.id, s.request_id, s.network, s.family, s.model, s.types, s.operation,
        s.status, s.payment_intent_id, s.transaction_hash, s.claim_transaction_hash,
        s.settle_transaction_hash, s.priced_units, s.inference_amount_atomic,
        s.platform_fee_atomic, s.final_amount_atomic, s.settled_at, s.created_at
      FROM inference.settlements s
      JOIN inference.requests r ON r.id = s.request_id
      JOIN scope
        ON scope.network = r.network
       AND scope.address = r.user_address
      ${where}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $${params.length}
    `,
  };
}

export async function query(
  input: QueryInput,
  executor: AnalyticsReadExecutor = defaultReadExecutor(),
): Promise<QueryResult> {
  const scope = scopeParameters(input.scopes);
  const statements = [
    requestAggregateStatement(input, scope),
    settlementAggregateStatement(input, scope),
    requestPageStatement(input, scope),
    settlementPageStatement(input, scope),
  ] as const;
  const [requestAggregates, settlementAggregates, requests, settlements] = await executor.transaction(
    statements,
    { isolationLevel: "RepeatableRead", readOnly: true },
  );
  return {
    requestAggregates: requestAggregates ?? [],
    settlementAggregates: settlementAggregates ?? [],
    requests: requests ?? [],
    settlements: settlements ?? [],
  };
}
