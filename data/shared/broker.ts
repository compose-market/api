import { getValkeyClient } from "../../x402/keys/valkey.js";
import type { InvalidateEvent } from "./updates.js";

const DOMAINS = new Set(["keys", "inference-analytics"]);
const REASONS = new Set(["created", "revoked", "budget", "expired", "telemetry"]);

export interface SubscriberClient {
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
}

export type EventListener = (event: InvalidateEvent) => void;
export type EventRelease = () => Promise<void>;
type SubscriberFactory = () => Promise<SubscriberClient>;

function parseEvent(message: string): InvalidateEvent | null {
  try {
    const input = JSON.parse(message) as Record<string, unknown>;
    if (
      input.type !== "invalidate"
      || typeof input.domain !== "string"
      || !DOMAINS.has(input.domain)
      || typeof input.reason !== "string"
      || !REASONS.has(input.reason)
      || typeof input.timestamp !== "string"
      || !input.timestamp
    ) {
      return null;
    }
    return {
      type: "invalidate",
      domain: input.domain as InvalidateEvent["domain"],
      reason: input.reason as InvalidateEvent["reason"],
      timestamp: input.timestamp,
    };
  } catch {
    return null;
  }
}

async function createSubscriber(): Promise<SubscriberClient> {
  const commands = await getValkeyClient();
  const subscriber = commands.duplicate({
    lazyConnect: true,
    enableAutoPipelining: false,
  });
  subscriber.on("error", (error) => {
    console.error("[domain-events] subscriber error", error);
  });
  if (subscriber.status === "wait") await subscriber.connect();
  return subscriber as unknown as SubscriberClient;
}

export class EventBroker {
  private subscriberPromise: Promise<SubscriberClient> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Map<EventListener, number>>();

  constructor(private readonly factory: SubscriberFactory = createSubscriber) { }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private subscriber(): Promise<SubscriberClient> {
    if (!this.subscriberPromise) {
      this.subscriberPromise = this.factory().then((subscriber) => {
        subscriber.on("message", (channel, message) => {
          const event = parseEvent(message);
          if (!event) return;
          for (const listener of this.listeners.get(channel)?.keys() ?? []) {
            try {
              listener(event);
            } catch (error) {
              console.error("[domain-events] listener failed", error);
            }
          }
        });
        subscriber.on("error", (error) => {
          console.error("[domain-events] subscriber connection error", error);
        });
        return subscriber;
      }).catch((error) => {
        this.subscriberPromise = null;
        throw error;
      });
    }
    return this.subscriberPromise;
  }

  private removeReferences(channels: readonly string[], listener: EventListener): void {
    for (const channel of channels) {
      const channelListeners = this.listeners.get(channel);
      const count = channelListeners?.get(listener);
      if (!channelListeners || !count) continue;
      if (count === 1) channelListeners.delete(listener);
      else channelListeners.set(listener, count - 1);
    }
  }

  subscribe(channels: readonly string[], listener: EventListener): Promise<EventRelease> {
    const uniqueChannels = [...new Set(channels)];
    if (uniqueChannels.length === 0) return Promise.reject(new Error("At least one domain channel is required"));

    return this.enqueue(async () => {
      const subscriber = await this.subscriber();
      const newChannels: string[] = [];
      for (const channel of uniqueChannels) {
        let channelListeners = this.listeners.get(channel);
        if (!channelListeners) {
          channelListeners = new Map();
          this.listeners.set(channel, channelListeners);
          newChannels.push(channel);
        }
        channelListeners.set(listener, (channelListeners.get(listener) ?? 0) + 1);
      }

      try {
        if (newChannels.length > 0) await subscriber.subscribe(...newChannels);
      } catch (error) {
        this.removeReferences(uniqueChannels, listener);
        for (const channel of newChannels) {
          if (this.listeners.get(channel)?.size === 0) this.listeners.delete(channel);
        }
        await subscriber.unsubscribe(...newChannels).catch(() => undefined);
        throw error;
      }

      let released = false;
      return () => {
        if (released) return Promise.resolve();
        released = true;
        this.removeReferences(uniqueChannels, listener);
        return this.enqueue(async () => {
          const emptyChannels = uniqueChannels.filter((channel) => this.listeners.get(channel)?.size === 0);
          for (const channel of emptyChannels) this.listeners.delete(channel);
          if (emptyChannels.length > 0) await (await this.subscriber()).unsubscribe(...emptyChannels);
        });
      };
    });
  }
}

let processBroker: EventBroker | null = null;

export function getEventBroker(): EventBroker {
  processBroker ??= new EventBroker();
  return processBroker;
}
