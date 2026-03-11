import type { ModelProvider } from "./types.js";
import type { ModelCard } from "./modelsRegistry.js";

export interface RoutingTarget {
  modelId: string;
  provider: ModelProvider;
  reason: "primary";
}

export interface PolicyContext {
  modelId: string;
  provider: ModelProvider;
  card?: ModelCard | null;
}

export interface PolicyResult<T> {
  result: T;
  attempts: number;
  fallbackUsed: boolean;
  primary: RoutingTarget;
  final: RoutingTarget;
}

export function buildRoutingTargets(context: PolicyContext): RoutingTarget[] {
  return [{ modelId: context.modelId, provider: context.provider, reason: "primary" }];
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const payload = error as Record<string, unknown>;
  const status = payload.status || payload.statusCode;
  return typeof status === "number" ? status : undefined;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("payment") || message.includes("budget") || message.includes("401") || message.includes("403")) {
      return false;
    }
    if (message.includes("timeout") || message.includes("econn") || message.includes("network") || message.includes("rate limit") || message.includes("429")) {
      return true;
    }
  }

  const status = getErrorStatus(error);
  if (typeof status !== "number") {
    return false;
  }

  return status >= 500 || status === 429;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base: number): number {
  return base + Math.floor(Math.random() * 50);
}

export async function runWithPolicy<T>(args: {
  context: PolicyContext;
  retriesPerTarget?: number;
  execute: (target: RoutingTarget, attempt: number) => Promise<T>;
}): Promise<PolicyResult<T>> {
  const retriesPerTarget = typeof args.retriesPerTarget === "number" ? Math.max(0, args.retriesPerTarget) : 2;
  const [primary] = buildRoutingTargets(args.context);
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retriesPerTarget + 1; attempt += 1) {
    attempts += 1;
    try {
      const result = await args.execute(primary, attempt);
      return {
        result,
        attempts,
        fallbackUsed: false,
        primary,
        final: primary,
      };
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < retriesPerTarget + 1 && isRetryable(error);
      if (!shouldRetry) {
        throw (error instanceof Error ? error : new Error(String(error)));
      }

      const backoff = attempt === 1 ? 100 : 300;
      await wait(jitter(backoff));
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError || "routing_failed")));
}
