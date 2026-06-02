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

export async function generate(request: Request, options: RunOptions = {}): Promise<Run<AdapterResult>> {
  const resolved = resolve(request);
  const upstreamModelId = upstream(resolved);
  const route = await runWithPolicy({
    context: {
      modelId: resolved.modelId,
      provider: resolved.provider,
      card: resolved.card,
    },
    execute: async (target) => {
      const { generateWithTools } = await load();
      return generateWithTools(request, {
        modelId: upstreamModelId,
        provider: target.provider,
        signal: options.signal,
      });
    },
  });

  return { resolved, route, result: route.result };
}

export async function stream(request: Request, options: RunOptions = {}): Promise<Run<{ stream: AsyncGenerator<Event> }>> {
  const resolved = resolve(request);
  const upstreamModelId = upstream(resolved);
  const route = await runWithPolicy({
    context: {
      modelId: resolved.modelId,
      provider: resolved.provider,
      card: resolved.card,
    },
    execute: async (target) => {
      const { streamWithTools } = await load();
      return {
        stream: streamWithTools(request, {
          modelId: upstreamModelId,
          provider: target.provider,
          signal: options.signal,
        }),
      };
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
