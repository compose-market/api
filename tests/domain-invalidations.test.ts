import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  publishInvalidationBestEffort,
} from "../data/shared/updates.js";

test("domain invalidation publication is best effort and retains sanitized metadata", async () => {
  const calls: unknown[][] = [];
  await publishInvalidationBestEffort("keys", `0x${"AB".repeat(20)}`, "created", {
    publish: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [["keys", `0x${"AB".repeat(20)}`, "created"]]);

  const errors: unknown[] = [];
  await assert.doesNotReject(publishInvalidationBestEffort(
    "inference-analytics",
    "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq",
    "telemetry",
    {
      publish: async () => { throw new Error("broker unavailable"); },
      logError: (error) => { errors.push(error); },
    },
  ));
  assert.equal(errors.length, 1);
});

test("Keys mutations publish only after their existing durable success outcomes", async () => {
  const [storage, intents, expiry] = await Promise.all([
    readFile(join(process.cwd(), "x402/keys/storage.ts"), "utf8"),
    readFile(join(process.cwd(), "x402/intents.ts"), "utf8"),
    readFile(join(process.cwd(), "x402/keys/expiry.ts"), "utf8"),
  ]);

  const created = storage.indexOf('publishInvalidationBestEffort("keys", normalizedAddress, "created")');
  assert.ok(created > storage.indexOf("await valkeySAdd("));
  const revoked = storage.indexOf('publishInvalidationBestEffort("keys", normalizedAddress, "revoked")');
  assert.ok(revoked > storage.indexOf("Number(result) === 1", storage.indexOf("export async function revokeKey")));

  const reserved = intents.indexOf('if (reservation === "reserved")');
  assert.ok(reserved > intents.indexOf("await valkeyReserveAndQueuePaymentIntent"));
  assert.match(intents.slice(reserved, reserved + 220), /publishInvalidationBestEffort\("keys", intent\.userAddress, "budget"\)/);
  const commitCall = intents.indexOf("const committed = await valkeyCommitReservedBudget");
  const committed = intents.indexOf('publishInvalidationBestEffort("keys", intent.userAddress, "budget")', commitCall);
  assert.ok(committed > intents.indexOf('if (committed !== "committed")', commitCall));
  assert.equal(intents.match(/publishInvalidationBestEffort\("keys", intent\.userAddress, "budget"\)/g)?.length, 4);

  assert.match(expiry, /const removed = await valkeySRem\(userKeyIndex, keyId\)/);
  assert.match(expiry, /if \(removed > 0\)[^]*publishInvalidationBestEffort\("keys", ownerAddress, "expired"\)/);
});
