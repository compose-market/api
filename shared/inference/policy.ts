import type { ModelProvider } from "../models/types.js";
import type { ModelCard } from "../models/registry.js";

export interface RoutingTarget {
  modelId: string;
  provider: ModelProvider;
  reason: "primary" | "available_from" | "provider_fallback";
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

const PROVIDER_ORDER: ModelProvider[] = [
  "openai",
  "anthropic",
  "google",
  "vertex",
  "openrouter",
  "huggingface",
  "aiml",
  "asi-cloud",
  "asi-one",
];

const PROVIDER_FALLBACKS: Record<ModelProvider, ModelProvider[]> = {
  openai: ["openrouter", "huggingface"],
  anthropic: ["openrouter", "huggingface"],
  google: ["vertex", "openrouter"],
  vertex: ["google", "openrouter"],
  openrouter: ["huggingface", "openai"],
  huggingface: ["openrouter", "aiml"],
  aiml: ["openrouter", "huggingface"],
  "asi-cloud": ["openrouter", "huggingface"],
  "asi-one": ["openrouter", "huggingface"],
};

function byProviderOrder(a: ModelProvider, b: ModelProvider): number {
  return PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b);
}

export function buildRoutingTargets(context: PolicyContext): RoutingTarget[] {
  const targets: RoutingTarget[] = [{ modelId: context.modelId, provider: context.provider, reason: "primary" }];

  if (context.card?.availableFrom && context.card.availableFrom.length > 0) {
    const extras = [...context.card.availableFrom]
      .filter((provider): provider is ModelProvider => !!provider && provider !== context.provider)
      .sort(byProviderOrder)
      .map((provider) => ({ modelId: context.modelId, provider, reason: "available_from" as const }));

    targets.push(...extras);
  }

  const providerFallbacks = PROVIDER_FALLBACKS[context.provider] || [];
  for (const provider of providerFallbacks) {
    if (targets.some((entry) => entry.provider === provider)) {
      continue;
    }
    targets.push({ modelId: context.modelId, provider, reason: "provider_fallback" });
  }

  return targets;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const payload = error as Record<string, unknown>;
  const status = payload.status || payload.statusCode;
  if (typeof status === "number") {
    return status;
  }

  return undefined;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("econn") || message.includes("network")) {
      return true;
    }
    if (message.includes("rate limit") || message.includes("429")) {
      return true;
    }

    if (message.includes("payment") || message.includes("budget") || message.includes("401") || message.includes("403")) {
      return false;
    }
  }

  const status = getErrorStatus(error);
  if (typeof status === "number") {
    if (status >= 500 || status === 429) {
      return true;
    }
    return false;
  }

  return false;
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
  const targets = buildRoutingTargets(args.context);

  const primary = targets[0];
  let attempts = 0;
  let lastError: unknown;

  for (const target of targets) {
    const maxAttempts = retriesPerTarget + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts += 1;
      try {
        const result = await args.execute(target, attempt);
        return {
          result,
          attempts,
          fallbackUsed: target.provider !== primary.provider,
          primary,
          final: target,
        };
      } catch (error) {
        lastError = error;
        const retryable = isRetryable(error);
        const shouldRetry = attempt < maxAttempts && retryable;
        if (!shouldRetry) {
          // Do not fallback for auth/validation/payment or other non-retryable errors.
          if (!retryable) {
            throw (error instanceof Error ? error : new Error(String(error)));
          }
          break;
        }

        const backoff = attempt === 1 ? 100 : 300;
        await wait(jitter(backoff));
      }
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError || "routing_failed")));
}
