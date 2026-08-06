import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  KEY_RECORD_LIST_FIELDS,
  listUserKeys,
  type KeyListClient,
  type KeyListPipeline,
} from "../x402/keys/storage.js";
import { buildWalletScopes } from "../data/user/scopes.js";
import type { WalletPair } from "../data/user/types.js";

const PAIR: WalletPair = {
  evmAddress: `0x${"11".repeat(20)}`,
  svmAddress: "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq",
};

type PipelineResult = [Error | null, unknown];

class FakePipeline implements KeyListPipeline {
  readonly commands: Array<{ name: "smembers" | "hmget"; key: string; fields: string[] }> = [];

  constructor(private readonly results: () => PipelineResult[]) { }

  smembers(key: string): this {
    this.commands.push({ name: "smembers", key, fields: [] });
    return this;
  }

  hmget(key: string, ...fields: string[]): this {
    this.commands.push({ name: "hmget", key, fields });
    return this;
  }

  async exec(): Promise<PipelineResult[]> {
    return this.results();
  }
}

function storedRecord(input: {
  keyId: string;
  userAddress: string;
  network: string;
  createdAt: number;
  purpose?: string;
  budgetLimit?: string;
}): Array<string | null> {
  const values: Record<(typeof KEY_RECORD_LIST_FIELDS)[number], string | null> = {
    keyId: input.keyId,
    userAddress: input.userAddress,
    purpose: input.purpose ?? "api",
    budgetLimit: input.budgetLimit ?? "1000",
    budgetUsed: "10",
    budgetReserved: "5",
    createdAt: String(input.createdAt),
    expiresAt: "1999999999999",
    revokedAt: null,
    name: "test",
    lastUsedAt: null,
    network: input.network,
  };
  return KEY_RECORD_LIST_FIELDS.map((field) => values[field]);
}

test("Keys list pipelines every enabled pair scope, hydrates once without tokens, and filters records", async () => {
  const scopes = buildWalletScopes(PAIR);
  const svmScope = scopes.find((scope) => scope.network.startsWith("solana:"))!;
  const evmScope = scopes.find((scope) => scope.network.startsWith("eip155:"))!;
  const pipelines: FakePipeline[] = [];
  let phase = 0;
  let hydratedIds: string[] = [];

  const client: KeyListClient = {
    pipeline() {
      const currentPhase = phase++;
      const pipeline = new FakePipeline(() => {
        if (currentPhase === 0) {
          return scopes.map((scope) => [null,
            scope.network === evmScope.network
              ? ["evm-new", "shared", "malformed", "foreign"]
              : scope.network === svmScope.network
                ? ["shared", "svm-old", "missing"]
                : [],
          ]);
        }
        hydratedIds = pipeline.commands.map((command) => command.key.replace(/^key:/, ""));
        return hydratedIds.map((keyId) => {
          if (keyId === "evm-new") return [null, storedRecord({
            keyId, userAddress: evmScope.address, network: evmScope.network, createdAt: 300,
          })];
          if (keyId === "shared") return [null, storedRecord({
            keyId, userAddress: svmScope.address, network: svmScope.network, createdAt: 200,
          })];
          if (keyId === "svm-old") return [null, storedRecord({
            keyId, userAddress: svmScope.address, network: svmScope.network, createdAt: 100,
            purpose: "session",
          })];
          if (keyId === "malformed") return [null, storedRecord({
            keyId, userAddress: evmScope.address, network: evmScope.network, createdAt: 50,
            budgetLimit: "not-an-integer",
          })];
          if (keyId === "foreign") return [null, storedRecord({
            keyId, userAddress: `0x${"22".repeat(20)}`, network: evmScope.network, createdAt: 400,
          })];
          return [null, KEY_RECORD_LIST_FIELDS.map(() => null)];
        });
      });
      pipelines.push(pipeline);
      return pipeline;
    },
  };

  const keys = await listUserKeys(scopes, client);

  assert.equal(pipelines.length, 2);
  assert.equal(pipelines[0]!.commands.length, scopes.length);
  assert.deepEqual(
    pipelines[0]!.commands.map((command) => command.key),
    scopes.map((scope) => `user-keys:${scope.network}:${scope.address}`),
  );
  assert.equal(new Set(hydratedIds).size, hydratedIds.length);
  assert.equal(hydratedIds.filter((id) => id === "shared").length, 1);
  assert.equal(pipelines[1]!.commands.every((command) => command.name === "hmget"), true);
  assert.equal(pipelines[1]!.commands.every((command) => !command.fields.includes("token")), true);
  assert.deepEqual(keys.map((key) => key.keyId), ["evm-new", "shared", "svm-old"]);
  assert.deepEqual(keys.map((key) => key.network), [evmScope.network, svmScope.network, svmScope.network]);
  assert.equal(keys.every((key) => typeof key.network === "string"), true);
  assert.equal("token" in keys[0]!, false);
});

test("Keys list fails the whole read on a pipeline command error", async () => {
  const scopes = buildWalletScopes(PAIR).slice(0, 1);
  const client: KeyListClient = {
    pipeline() {
      return new FakePipeline(() => [[new Error("Valkey failed"), null]]);
    },
  };
  await assert.rejects(listUserKeys(scopes, client), /Valkey failed/);
});

test("GET /api/keys resolves the pair and never reads x-network-id", async () => {
  const source = await readFile(join(process.cwd(), "handler.ts"), "utf8");
  const start = source.indexOf("async function handleListKeys");
  const end = source.indexOf("async function handleGetKeyDetails", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.match(handler, /resolveWalletScopes\(userAddress\)/);
  assert.match(handler, /listUserKeys\(scopes\)/);
  assert.doesNotMatch(handler, /requireNetworkHeader|x-network-id/);
});
