import { getValkeyClient } from "../../x402/keys/valkey.js";

export type EventName = "keys" | "inference-analytics";
export type InvalidationReason = "created" | "revoked" | "budget" | "expired" | "telemetry";

export interface InvalidateEvent {
  type: "invalidate";
  domain: EventName;
  reason: InvalidationReason;
  timestamp: string;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function domainEventChannel(domain: EventName, address: string): string {
  const normalized = EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
  return `compose:domain-events:${domain}:${normalized}`;
}

export async function publishInvalidation(
  domain: EventName,
  address: string,
  reason: InvalidationReason,
): Promise<void> {
  const event: InvalidateEvent = {
    type: "invalidate",
    domain,
    reason,
    timestamp: new Date().toISOString(),
  };
  const valkey = await getValkeyClient();
  await valkey.publish(domainEventChannel(domain, address), JSON.stringify(event));
}

export async function publishInvalidationBestEffort(
  domain: EventName,
  address: string,
  reason: InvalidationReason,
  dependencies: {
    publish?: typeof publishInvalidation;
    logError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  try {
    await (dependencies.publish ?? publishInvalidation)(domain, address, reason);
  } catch (error) {
    (dependencies.logError ?? ((cause: unknown) => {
      console.error("[domain-events] invalidation publish failed", {
        domain,
        reason,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }))(error);
  }
}
