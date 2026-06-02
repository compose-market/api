export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  SNAP: R2Bucket;
  VEC: VectorizeIndex;
  ROUTES?: VectorizeIndex;
  EMBEDDING_MODEL: string;
  EMBEDDING_API_BASE: string;
  MONGO_DB_API_KEY: string;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: {
    duration: number;
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
  };
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: R2PutOptions): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
  head(key: string): Promise<R2Object | null>;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

export interface VectorizeIndex {
  insert(vectors: Vector[]): Promise<Mutation>;
  upsert(vectors: Vector[]): Promise<Mutation>;
  query(vector: number[], options?: Query): Promise<Matches>;
  deleteByIds(ids: string[]): Promise<Mutation>;
}

export interface Vector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface Query {
  topK?: number;
  returnMetadata?: boolean | "all";
  filter?: Record<string, unknown>;
}

export interface Matches {
  matches: Array<{
    id: string;
    score: number;
    values?: number[];
    metadata?: Record<string, unknown>;
  }>;
  count: number;
}

export interface Mutation {
  mutationId: string;
}
