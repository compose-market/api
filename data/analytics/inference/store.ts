import {
  insertRequest,
  projectCanonicalPaymentIntentSettlement as projectSettlement,
  type AnalyticsQueryExecutor,
  type CanonicalPaymentIntentSettlementProjection,
} from "./db.js";
import type { Settlement, StoredRequest } from "./types.js";
import type { InferenceTelemetryRecord } from "../../../inference/events.js";
import {
  publishDomainInvalidation,
  type DomainEventName,
  type DomainInvalidationReason,
} from "../../shared/updates.js";

export interface AnalyticsRecordDependencies {
  insert?: typeof insertRequest;
  publish?: (
    domain: DomainEventName,
    address: string,
    reason: DomainInvalidationReason,
  ) => Promise<void>;
  logError?: (message: string, error: unknown) => void;
}

export async function record(
  request: InferenceTelemetryRecord["request"],
  settlements: InferenceTelemetryRecord["settlements"],
  dependencies: AnalyticsRecordDependencies = {},
): Promise<void> {
  const insert = dependencies.insert ?? insertRequest;
  const publish = dependencies.publish ?? publishDomainInvalidation;
  const logError = dependencies.logError ?? ((message, error) => console.error(message, error));
  await insert(request as StoredRequest, settlements as Settlement[]);
  try {
    await publish("inference-analytics", request.userAddress, "telemetry");
  } catch (error) {
    logError("[analytics] Failed to publish telemetry invalidation", error);
  }
}

export async function projectCanonicalPaymentIntentSettlement(
  input: CanonicalPaymentIntentSettlementProjection,
  executor?: AnalyticsQueryExecutor,
): Promise<boolean> {
  return projectSettlement(input, executor);
}
