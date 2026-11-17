import { bumpCacheVersion } from "../../cache.js";
import { getValkeyClient } from "../../x402/keys/valkey.js";
import { getWalletPair } from "../user/store.js";

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
  const normalized = EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
  const addresses = new Set<string>([normalized]);
  const pair = await getWalletPair(normalized).catch(() => null);
  if (pair) {
    addresses.add(pair.evmAddress.toLowerCase());
    addresses.add(pair.svmAddress);
  }
  await Promise.all(
    [...addresses].map((owner) => bumpCacheVersion(`${domain}:${owner}`).catch(() => undefined)),
  );
  const event: InvalidateEvent = {
    type: "invalidate",
    domain,
    reason,
    timestamp: new Date().toISOString(),
  };
  const payload = JSON.stringify(event);
  const valkey = await getValkeyClient();
  await Promise.all(
    [...addresses].map((owner) => valkey.publish(domainEventChannel(domain, owner), payload)),
  );
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
