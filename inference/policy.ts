import { PROVIDER_PRIORITY, type ModelProvider } from "./types.js";
import type { ModelCard, ModelPricing } from "./catalog/registry.js";

/** Primary + fallback attempts, matching the documented routing contract. */
const MAX_ROUTING_TARGETS = 3;

export interface RoutingTarget {
  /** Canonical catalog model ID. */
  modelId: string;
  /** Provider-wire model ID sent to this provider's adapter. */
  wireModelId: string;
  provider: ModelProvider;
  reason: "primary" | "fallback";
  /** This provider's pricing for the model, when it differs from the card. */
  pricing?: ModelPricing | null;
}

export interface PolicyContext {
  modelId: string;
  provider: ModelProvider;
  /** Primary wire ID when the card carries no provider routes. */
  wireModelId?: string;
  card?: ModelCard | null;
}

export interface PolicyResult<T> {
  result: T;
  attempts: number;
  fallbackUsed: boolean;
  primary: RoutingTarget;
  final: RoutingTarget;
}

function routeRank(route: { provider: ModelProvider }, primaryProvider: ModelProvider): number {
  if (route.provider === primaryProvider) return 0;
  return PROVIDER_PRIORITY[route.provider] ?? 99;
}

/**
 * Build the ordered routing chain for a catalog model: the primary provider
 * (the pinned provider for qualified requests, otherwise the priority
 * winner) first, then the remaining providers by PROVIDER_PRIORITY. Fallback
 * providers are only used when the previous one failed transiently.
 */
export function buildRoutingTargets(context: PolicyContext): RoutingTarget[] {
  const routes = Array.isArray(context.card?.providerRoutes) ? context.card!.providerRoutes! : [];
  if (routes.length === 0) {
    return [{
      modelId: context.modelId,
      wireModelId: context.wireModelId ?? context.modelId,
      provider: context.provider,
      reason: "primary",
    }];
  }

  const ordered = [...routes]
    .filter((route) => typeof route.upstreamModelId === "string" && route.upstreamModelId.length > 0)
    .sort((left, right) =>
      routeRank(left, context.provider) - routeRank(right, context.provider)
      || left.provider.localeCompare(right.provider));

  if (!ordered.some((route) => route.provider === context.provider)) {
    ordered.unshift({
      provider: context.provider,
      upstreamModelId: context.wireModelId ?? context.modelId,
      pricing: context.card?.pricing ?? null,
    });
  }

  return ordered.slice(0, MAX_ROUTING_TARGETS).map((route, index) => ({
    modelId: context.modelId,
    wireModelId: route.upstreamModelId,
    provider: route.provider,
    reason: index === 0 ? "primary" as const : "fallback" as const,
    ...(route.pricing !== undefined ? { pricing: route.pricing } : {}),
  }));
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const payload = error as Record<string, unknown>;
  const status = payload.status || payload.statusCode;
  return typeof status === "number" ? status : undefined;
}

function explicitRetryability(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>).retryable;
  return typeof value === "boolean" ? value : undefined;
}

function errorText(error: unknown): string {
  const values: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) values.push(current.message);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string") values.push(record.code);
    current = record.cause;
  }
  return values.join(" ").toLowerCase();
}

/**
 * Vendor adapters throw plain errors carrying the HTTP status only in the
 * message text ("Fireworks image generation failed: 503 Service
 * Unavailable — …"), without a status property. Detect transient classes
 * at the text level too: any standalone 5xx number or a well-known
 * provider-outage phrase.
 */
const TRANSIENT_STATUS_TEXT = /\b5\d{2}\b/u;
const TRANSIENT_PHRASE_TEXT = /(internal server error|bad gateway|service unavailable|gateway timeout|overloaded)/u;

function isRetryable(error: unknown): boolean {
  const explicit = explicitRetryability(error);
  if (explicit !== undefined) return explicit;

  const status = getErrorStatus(error);
  if (typeof status === "number") return status >= 500 || [408, 409, 425, 429].includes(status);

  const message = errorText(error);
  if (message.includes("payment") || message.includes("budget") || message.includes("401") || message.includes("403")) return false;
  if (message.includes("timeout") || message.includes("econn") || message.includes("network") || message.includes("fetch failed") || message.includes("rate limit") || message.includes("429")) return true;
  return TRANSIENT_STATUS_TEXT.test(message) || TRANSIENT_PHRASE_TEXT.test(message);
}

function canFallback(error: unknown): boolean {
  return isRetryable(error) || getErrorStatus(error) === 404;
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
  allowFallback?: boolean;
  execute: (target: RoutingTarget, attempt: number) => Promise<T>;
}): Promise<PolicyResult<T>> {
  const retriesPerTarget = typeof args.retriesPerTarget === "number" ? Math.max(0, args.retriesPerTarget) : 2;
  const targets = buildRoutingTargets(args.context);
  const targetCount = args.allowFallback === false ? Math.min(1, targets.length) : targets.length;
  const [primary] = targets;
  let attempts = 0;
  let lastError: unknown;

  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    const target = targets[targetIndex]!;
    const isLastTarget = targetIndex === targets.length - 1;

    for (let attempt = 1; attempt <= retriesPerTarget + 1; attempt += 1) {
      attempts += 1;
      try {
        const result = await args.execute(target, attempt);
        return {
          result,
          attempts,
          fallbackUsed: targetIndex > 0,
          primary,
          final: target,
        };
      } catch (error) {
        lastError = error;
        const canRetry = attempt < retriesPerTarget + 1 && isRetryable(error);
        if (canRetry) {
          const backoff = attempt === 1 ? 100 : 300;
          await wait(jitter(backoff));
          continue;
        }

        // Only transient-class failures (5xx, 429, timeouts, network) advance
        // to the next provider. Payment/auth/budget and other 4xx errors fail
        // the request immediately.
        const shouldFallback = !isLastTarget && canFallback(error);
        if (shouldFallback) {
          break;
        }

        throw (error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError || "routing_failed")));
}
