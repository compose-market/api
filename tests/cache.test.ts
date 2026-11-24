import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  bumpCacheVersion,
  cached,
  cacheDel,
  cacheGet,
  cacheMGet,
  cacheSet,
  cacheVersion,
  l1Clear,
  l1Del,
  l1Get,
  l1Set,
  setCacheStore,
  singleFlight,
  type Store,
} from "../cache.js";

function createMockStore(): Store & {
  data: Map<string, { value: string; ttl: number }>;
  gets: string[];
  sets: string[];
  dels: string[];
} {
  const data = new Map<string, { value: string; ttl: number }>();
  const gets: string[] = [];
  const sets: string[] = [];
  const dels: string[] = [];

  return {
    data,
    gets,
    sets,
    dels,
    async get(key: string) {
      gets.push(key);
      return data.get(key)?.value ?? null;
    },
    async mget(...keys: string[]) {
      gets.push(...keys);
      return keys.map((key) => data.get(key)?.value ?? null);
    },
    async set(key: string, value: string, _mode: "EX", seconds: number) {
      sets.push(key);
      data.set(key, { value, ttl: seconds });
      return "OK";
    },
    async del(...keys: string[]) {
      dels.push(...keys);
      let count = 0;
      for (const key of keys) {
        if (data.delete(key)) count += 1;
      }
      return count;
    },
    async incr(key: string) {
      const next = Number(data.get(key)?.value ?? "0") + 1;
      data.set(key, { value: String(next), ttl: data.get(key)?.ttl ?? 0 });
      return next;
    },
    async expire(key: string, seconds: number) {
      const existing = data.get(key);
      if (!existing) return 0;
      existing.ttl = seconds;
      return 1;
    },
  };
}

afterEach(() => {
  setCacheStore(null);
  l1Clear();
});

test("L1 serves cached entries until TTL expires and respects deletion", async () => {
  process.env.TEST_CACHE_ENABLED = "true";
  try {
    l1Set("k1", { ok: true }, 50);
    assert.deepEqual(l1Get("k1"), { ok: true });

    l1Del("k1");
    assert.equal(l1Get("k1"), undefined);

    l1Set("k2", "short", 15);
    assert.equal(l1Get("k2"), "short");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(l1Get("k2"), undefined);
  } finally {
    delete process.env.TEST_CACHE_ENABLED;
  }
});