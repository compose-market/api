import type { Env } from "./env.js";

export interface Keys {
  raw: string;
  snap: string;
}

export function keys(id: string): Keys {
  return {
    raw: `imports/${id}.json`,
    snap: `imports/${id}.json`,
  };
}

export async function write(env: Env, id: string, raw: unknown, clean: unknown): Promise<Keys> {
  const out = keys(id);
  await env.RAW.put(out.raw, JSON.stringify(raw), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.SNAP.put(out.snap, JSON.stringify(clean), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return out;
}

export async function read<T>(env: Env, key: string, kind: "raw" | "snap" = "snap"): Promise<T | null> {
  const object = kind === "raw" ? await env.RAW.get(key) : await env.SNAP.get(key);
  return object ? await object.json<T>() : null;
}

export async function text(env: Env, key: string, kind: "raw" | "snap" = "snap"): Promise<string | null> {
  const object = kind === "raw" ? await env.RAW.get(key) : await env.SNAP.get(key);
  return object ? await object.text() : null;
}
