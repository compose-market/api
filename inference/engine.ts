import type { PolicyResult } from "./policy.js";
import { runWithPolicy } from "./policy.js";
import type { AdapterResult, AdapterStatus } from "./catalog/adapter.js";
import {
  resolveModel,
  type ResolvedModel,
} from "./catalog/registry.js";
import type { Event, Request } from "./core.js";

export interface Run<T> {
  resolved: ResolvedModel;
  route: PolicyResult<T>;
  result: T;
}

export interface Cancel {
  cancelled: boolean;
  message?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  retriesPerTarget?: number;
  allowFallback?: boolean;
}

function defaultRetries(request: Request): number {
  return request.modality === "text" || request.modality === "embedding" ? 2 : 0;
}

function load() {
  return import("./catalog/adapter.js");
}

export function resolve(request: Pick<Request, "model">): ResolvedModel {
  return resolveModel(request.model);
}

function upstream(resolved: ResolvedModel): string {
  return typeof resolved.card?.upstreamModelId === "string" && resolved.card.upstreamModelId.length > 0
    ? resolved.card.upstreamModelId
    : resolved.modelId;
}

/**
 * Billing view of a resolved model after routing: when a fallback provider
 * served the call, settlement must price with that provider's route pricing
 * (and subject), not the primary's. Authorization already used the primary.
 */
export function resolvedForRoute(resolved: ResolvedModel, route: PolicyResult<unknown>): ResolvedModel {
  if (!route.fallbackUsed) return resolved;
  const final = route.final;
  const card = resolved.card;
  const routePricing = final.pricing ?? null;
  return {
    ...resolved,
    provider: final.provider,
    ...(card
      ? {
        card: {
          ...card,
          provider: final.provider,
          upstreamModelId: final.wireModelId,
          ...(routePricing ? { pricing: routePricing } : {}),
        },
      }
      : {}),
  };
}

export async function generate(request: Request, options: RunOptions = {}): Promise<Run<AdapterResult>> {
  const resolved = resolve(request);
  const upstreamModelId = upstream(resolved);
  const route = await runWithPolicy({
    context: {
      modelId: resolved.modelId,
      provider: resolved.provider,
      wireModelId: upstreamModelId,
      card: resolved.card,
    },
    retriesPerTarget: options.retriesPerTarget ?? defaultRetries(request),
    allowFallback: options.allowFallback,
    execute: async (target) => {
      const { generateWithTools } = await load();
      return generateWithTools(request, {
        modelId: target.wireModelId,
        catalogModelId: resolved.modelId,
        provider: target.provider,
        family: resolved.card?.family,
        signal: options.signal,
      });
    },
  });

  return { resolved, route, result: route.result };
}

/**
 * Replay a stream's primed first event, then delegate to the provider
 * generator. The first event is pulled inside the routing policy (see
 * `stream`), so provider setup and first-response failures — connect
 * errors, 5xx on the opening request — surface where the fallback chain
 * can retry or switch providers. Failures after the first delivered event
 * happen mid-stream, when the response is already committed to the client;
 * those cannot switch providers.
 */
export async function* primedStream<Event>(
  first: IteratorResult<Event>,
  rest: AsyncGenerator<Event>,
): AsyncGenerator<Event> {
  if (!first.done) {
    yield first.value;
  }
  yield* rest;
}

export function requireStreamStart(first: IteratorResult<Event>): IteratorResult<Event> {
  if (first.done) {
    throw Object.assign(new Error("upstream stream ended without output"), { statusCode: 502 });
  }
  if (first.value.type === "error") {
    throw Object.assign(new Error(first.value.error?.message || "upstream stream failed before output"), {
      statusCode: 502,
      code: first.value.error?.code,
    });
  }
  return first;
}

export async function stream(request: Request, options: RunOptions = {}): Promise<Run<{ stream: AsyncGenerator<Event> }>> {
  const resolved = resolve(request);
  const upstreamModelId = upstream(resolved);
  const route = await runWithPolicy({
    context: {
      modelId: resolved.modelId,
      provider: resolved.provider,
      wireModelId: upstreamModelId,
      card: resolved.card,
    },
    retriesPerTarget: options.retriesPerTarget ?? defaultRetries(request),
    allowFallback: options.allowFallback,
    execute: async (target) => {
      const { streamWithTools } = await load();
      const generator = streamWithTools(request, {
        modelId: target.wireModelId,
        catalogModelId: resolved.modelId,
        provider: target.provider,
        family: resolved.card?.family,
        signal: options.signal,
      });
      // Provider generators are lazy: without priming, the policy would
      // accept the primary target before any provider contact and every
      // failure would surface outside the fallback chain.
      const first = requireStreamStart(await generator.next());
      return { stream: primedStream(first, generator) };
    },
  });

  return { resolved, route, result: route.result };
}

export async function retrieve(jobId: string): Promise<AdapterStatus> {
  const { retrieveJob } = await load();
  return retrieveJob(jobId);
}

export async function cancel(jobId: string): Promise<Cancel> {
  const { cancelJob } = await load();
  return cancelJob(jobId);
}

export async function appendRealtime(responseId: string, data: Record<string, unknown>): Promise<boolean> {
  const { appendRealtime } = await load();
  return appendRealtime(responseId, data);
}

export async function closeRealtime(responseId: string): Promise<boolean> {
  const { closeRealtime } = await load();
  return closeRealtime(responseId);
}
