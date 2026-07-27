import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("api ValKey clients use bounded request-critical options", () => {
  for (const file of ["x402/keys/valkey.ts", "backpack/storage.ts"]) {
    const source = readFileSync(resolve(root, file), "utf8");

    assert.match(source, /commandTimeout\s*:/, file);
    assert.match(source, /enableOfflineQueue\s*:\s*false/, file);
    assert.match(source, /enableAutoPipelining\s*:\s*true/, file);
    assert.match(source, /lazyConnect\s*:\s*true/, file);
    assert.match(source, /keepAlive\s*:/, file);
    assert.match(source, /maxRetriesPerRequest\s*:\s*1/, file);
  }
});

test("keys ValKey client consumes deployed auth and TLS secrets", () => {
  const source = readFileSync(resolve(root, "x402/keys/valkey.ts"), "utf8");

  assert.match(source, /VALKEY_KEYS_PASSWORD/, "keys ValKey password secret must be read");
  assert.match(source, /password\s*:/, "keys ValKey password must be passed to ioredis");
  assert.match(source, /VALKEY_TLS/, "keys ValKey TLS secret must be read");
  assert.match(source, /tls\s*:/, "keys ValKey TLS option must be passed to ioredis");
});
