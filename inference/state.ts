import { valkeyGet, valkeySet } from "../x402/keys/valkey.js";
import type { Message, Output } from "./core.js";
import type { ResponsesInputItem } from "./responses.js";
import type { ModelProvider } from "./types.js";

export interface StoredResponseRecord {
  id: string;
  model: string;
  provider: ModelProvider;
  operation?: string;
  createdAt: number;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  store: boolean;
  inputItems?: ResponsesInputItem[];
  inputMessages?: Message[];
  previousResponseId?: string;
  output?: Output;
  jobId?: string;
  error?: string;
}

export interface ResponseStateBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

const RESPONSE_RECORD_TTL_SECONDS = 24 * 60 * 60;

export function responseRecordKey(id: string): string {
  return `responses:record:${id}`;
}

export class ResponseStateUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "response_state_unavailable";

  constructor(operation: "read" | "write", cause?: unknown) {
    super(`Response state is unavailable during ${operation}`);
    this.name = "ResponseStateUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class ResponseStateStore {
  constructor(private readonly backend: ResponseStateBackend) {}

  async save(record: StoredResponseRecord): Promise<void> {
    if (record.store === false) return;
    try {
      await this.backend.set(
        responseRecordKey(record.id),
        JSON.stringify(record),
        RESPONSE_RECORD_TTL_SECONDS,
      );
    } catch (error) {
      throw new ResponseStateUnavailableError("write", error);
    }
  }

  async get(id: string): Promise<StoredResponseRecord | null> {
    let raw: string | null;
    try {
      raw = await this.backend.get(responseRecordKey(id));
    } catch (error) {
      throw new ResponseStateUnavailableError("read", error);
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredResponseRecord;
    } catch (error) {
      throw new ResponseStateUnavailableError("read", error);
    }
  }
}

export const responseStateStore = new ResponseStateStore({
  get: valkeyGet,
  set: valkeySet,
});
