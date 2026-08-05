import { getValkeyClient } from "../../x402/keys/valkey.js";

export type DomainEventName = "keys" | "inference-analytics";
export type DomainInvalidationReason = "created" | "revoked" | "budget" | "expired" | "telemetry";

export interface DomainInvalidateEvent {
  type: "invalidate";
  domain: DomainEventName;
  reason: DomainInvalidationReason;
  timestamp: string;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function domainEventChannel(domain: DomainEventName, address: string): string {
  const normalized = EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
  return `compose:domain-events:${domain}:${normalized}`;
}

export async function publishDomainInvalidation(
  domain: DomainEventName,
  address: string,
  reason: DomainInvalidationReason,
): Promise<void> {
  const event: DomainInvalidateEvent = {
    type: "invalidate",
    domain,
    reason,
    timestamp: new Date().toISOString(),
  };
  const valkey = await getValkeyClient();
  await valkey.publish(domainEventChannel(domain, address), JSON.stringify(event));
}

export async function publishDomainInvalidationBestEffort(
  domain: DomainEventName,
  address: string,
  reason: DomainInvalidationReason,
  dependencies: {
    publish?: typeof publishDomainInvalidation;
    logError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  try {
    await (dependencies.publish ?? publishDomainInvalidation)(domain, address, reason);
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
