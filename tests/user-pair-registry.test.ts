import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import express from "express";

import {
  initializeUserDatabase,
  type UserDatabaseExecutor,
} from "../data/user/db.js";
import {
  PairConflictError,
  PairStoreUnavailableError,
  getWalletPair,
  putWalletPair,
} from "../data/user/store.js";
import { registerUserRoutes } from "../data/user/routes.js";
import {
  buildWalletScopes,
  resolveWalletScopes,
} from "../data/user/scopes.js";
import {
  parsePairBody,
  parsePairLookupAddress,
} from "../data/user/validation.js";
import type { WalletPair } from "../data/user/types.js";
import { getSupportedNetworks } from "../x402/configs/chains.js";

const EVM = `0x${"Ab".repeat(20)}`;
const NORMALIZED_EVM = EVM.toLowerCase();
const OTHER_EVM = `0x${"12".repeat(20)}`;
const SVM = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq";
const OTHER_SVM = "EMhuLpXRZrT4pwfhxeRFQbTmZYyo4Dsq3keNq6tj4PGW";

type Row = Record<string, unknown>;

function executor(
  query: (statement: string, params?: readonly unknown[]) => Promise<Row[]>,
): UserDatabaseExecutor {
  return { query };
}

test("the User DB initializer creates the user database tables", async () => {
  const calls: Array<{ statement: string; params?: readonly unknown[] }> = [];
  await initializeUserDatabase(executor(async (statement, params) => {
    calls.push({ statement, params });
    return [];
  }));

  assert.equal(calls.length, 3);
  assert.match(
    calls[0]?.statement.replace(/\s+/g, " ").trim() ?? "",
    /CREATE TABLE IF NOT EXISTS public\.wallet_pairs/,
  );
  assert.equal(calls[0]?.params, undefined);
});

test("pair parsing accepts exactly two fields, normalizes EVM, and preserves SVM case", () => {
  assert.deepEqual(parsePairBody({ evmAddress: EVM, svmAddress: SVM }), {
    evmAddress: NORMALIZED_EVM,
    svmAddress: SVM,
  });
  assert.deepEqual(parsePairLookupAddress(EVM), { kind: "evm", value: NORMALIZED_EVM });
  assert.deepEqual(parsePairLookupAddress(SVM), { kind: "svm", value: SVM });

  for (const body of [
    null,
    {},
    { evmAddress: EVM },
    { svmAddress: SVM },
    { evmAddress: EVM, svmAddress: SVM, identity: "forbidden" },
    { evmAddress: "not-an-address", svmAddress: SVM },
    { evmAddress: EVM, svmAddress: "not-an-address" },
  ]) {
    assert.throws(() => parsePairBody(body), /wallet pair/i);
  }
  assert.throws(() => parsePairLookupAddress("not-an-address"), /wallet address/i);
});

test("pair insertion uses conflict-safe insert then classifies replay", async () => {
  const calls: Array<{ statement: string; params?: readonly unknown[] }> = [];
  const pair = await putWalletPair({ evmAddress: EVM, svmAddress: SVM }, executor(async (statement, params) => {
    calls.push({ statement, params });
    if (/INSERT INTO public\.wallet_pairs/.test(statement)) return [];
    return [{ evm_address: NORMALIZED_EVM, svm_address: SVM }];
  }));

  assert.deepEqual(pair, { evmAddress: NORMALIZED_EVM, svmAddress: SVM });
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.statement, /ON CONFLICT DO NOTHING/);
  assert.match(calls[0]!.statement, /RETURNING evm_address, svm_address/);
  assert.match(calls[1]!.statement, /WHERE evm_address = \$1 OR svm_address = \$2/);
  assert.deepEqual(calls[0]!.params, [NORMALIZED_EVM, SVM]);
  assert.deepEqual(calls[1]!.params, [NORMALIZED_EVM, SVM]);
});

test("pair insertion returns a fresh row and rejects either conflict direction", async () => {
  const inserted = await putWalletPair({ evmAddress: EVM, svmAddress: SVM }, executor(async () => [
    { evm_address: NORMALIZED_EVM, svm_address: SVM },
  ]));
  assert.deepEqual(inserted, { evmAddress: NORMALIZED_EVM, svmAddress: SVM });

  await assert.rejects(
    putWalletPair({ evmAddress: EVM, svmAddress: OTHER_SVM }, executor(async (statement) => {
      if (/INSERT/.test(statement)) return [];
      return [{ evm_address: NORMALIZED_EVM, svm_address: SVM }];
    })),
    PairConflictError,
  );
  await assert.rejects(
    putWalletPair({ evmAddress: OTHER_EVM, svmAddress: SVM }, executor(async (statement) => {
      if (/INSERT/.test(statement)) return [];
      return [{ evm_address: NORMALIZED_EVM, svm_address: SVM }];
    })),
    PairConflictError,
  );
});

test("concurrent conflicting inserts are classified after the winning insert", async () => {
  const rows: WalletPair[] = [];
  let releaseWinner!: () => void;
  const winnerCommitted = new Promise<void>((resolve) => { releaseWinner = resolve; });

  const shared = executor(async (statement, params) => {
    const evmAddress = String(params?.[0]);
    const svmAddress = String(params?.[1]);
    if (/INSERT/.test(statement)) {
      if (rows.length === 0) {
        rows.push({ evmAddress, svmAddress });
        releaseWinner();
        return [{ evm_address: evmAddress, svm_address: svmAddress }];
      }
      await winnerCommitted;
      return [];
    }
    return rows
      .filter((row) => row.evmAddress === evmAddress || row.svmAddress === svmAddress)
      .map((row) => ({ evm_address: row.evmAddress, svm_address: row.svmAddress }));
  });

  const [winner, loser] = await Promise.allSettled([
    putWalletPair({ evmAddress: EVM, svmAddress: SVM }, shared),
    putWalletPair({ evmAddress: EVM, svmAddress: OTHER_SVM }, shared),
  ]);
  assert.equal(winner.status, "fulfilled");
  assert.equal(loser.status, "rejected");
  assert.equal((loser as PromiseRejectedResult).reason instanceof PairConflictError, true);
});

test("pair lookup is indexed by either exact member and storage failures become 503 errors", async () => {
  const calls: Array<{ statement: string; params?: readonly unknown[] }> = [];
  const db = executor(async (statement, params) => {
    calls.push({ statement, params });
    return [{ evm_address: NORMALIZED_EVM, svm_address: SVM }];
  });

  assert.deepEqual(await getWalletPair(EVM, db), { evmAddress: NORMALIZED_EVM, svmAddress: SVM });
  assert.deepEqual(await getWalletPair(SVM, db), { evmAddress: NORMALIZED_EVM, svmAddress: SVM });
  assert.match(calls[0]!.statement, /evm_address = \$1/);
  assert.doesNotMatch(calls[0]!.statement, /lower\s*\(/i);
  assert.match(calls[1]!.statement, /svm_address = \$1/);
  assert.deepEqual(calls[0]!.params, [NORMALIZED_EVM]);
  assert.deepEqual(calls[1]!.params, [SVM]);

  await assert.rejects(
    getWalletPair(EVM, executor(async () => { throw new Error("database unavailable"); })),
    PairStoreUnavailableError,
  );
});

test("enabled wallet scopes are zipped once with the correct address family", async () => {
  const pair = { evmAddress: NORMALIZED_EVM, svmAddress: SVM };
  const scopes = buildWalletScopes(pair);
  const supported = getSupportedNetworks()
    .map((network) => network.id)
    .filter((id) => id.startsWith("eip155:") || id.startsWith("solana:"))
    .sort();

  assert.deepEqual(scopes.map((scope) => scope.network), supported);
  assert.equal(new Set(scopes.map((scope) => scope.network)).size, supported.length);
  for (const scope of scopes) {
    assert.equal(scope.address, scope.network.startsWith("eip155:") ? NORMALIZED_EVM : SVM);
  }

  const selected = buildWalletScopes(pair, [supported.at(-1)!, supported[0]!, supported[0]!]);
  assert.deepEqual(selected.map((scope) => scope.network), [supported[0], supported.at(-1)]);

  const byEvm = await resolveWalletScopes(EVM, undefined, async () => pair);
  const bySvm = await resolveWalletScopes(SVM, undefined, async () => pair);
  assert.deepEqual(byEvm, bySvm);

  const nearScopes = await resolveWalletScopes("alice.near");
  assert.ok(nearScopes.length > 0);
  assert.equal(nearScopes.every((scope) => scope.network.startsWith("near:") && scope.address === "alice.near"), true);
});

async function withUserServer(
  dependencies: Parameters<typeof registerUserRoutes>[1],
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  registerUserRoutes(app, dependencies);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const value = error as { statusCode?: number; message?: string };
    response.status(value.statusCode ?? 500).json({ error: value.message ?? "error" });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("public User routes expose exact success bodies and 400/404/409/503 statuses", async () => {
  const pair = { evmAddress: NORMALIZED_EVM, svmAddress: SVM };
  await withUserServer({
    putPair: async (input) => {
      if (input.svmAddress === OTHER_SVM) throw new PairConflictError();
      return pair;
    },
    findPair: async (address) => {
      if (address === OTHER_EVM.toLowerCase()) return null;
      if (address === `0x${"34".repeat(20)}`) throw new PairStoreUnavailableError();
      return pair;
    },
  }, async (origin) => {
    const created = await fetch(`${origin}/api/user`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evmAddress: EVM, svmAddress: SVM }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), pair);

    const extra = await fetch(`${origin}/api/user`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evmAddress: EVM, svmAddress: SVM, role: "owner" }),
    });
    assert.equal(extra.status, 400);

    const bySvm = await fetch(`${origin}/api/user/${SVM}`);
    assert.equal(bySvm.status, 200);
    assert.deepEqual(await bySvm.json(), pair);

    const conflict = await fetch(`${origin}/api/user`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evmAddress: EVM, svmAddress: OTHER_SVM }),
    });
    assert.equal(conflict.status, 409);

    assert.equal((await fetch(`${origin}/api/user/${OTHER_EVM}`)).status, 404);
    assert.equal((await fetch(`${origin}/api/user/0x${"34".repeat(20)}`)).status, 503);
    assert.equal((await fetch(`${origin}/api/user/not-an-address`)).status, 400);
  });
});

test("the User registry is wired before generic handlers and through full deployment", async () => {
  const [packageJson, index, readme, cloudBuild] = await Promise.all([
    readFile(join(process.cwd(), "package.json"), "utf8"),
    readFile(join(process.cwd(), "index.ts"), "utf8"),
    readFile(join(process.cwd(), "README.md"), "utf8"),
    readFile(join(process.cwd(), "cloudbuild.yaml"), "utf8"),
  ]);
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["init:user-db"], "tsx data/user/init.ts");

  assert.match(index, /registerUserRoutes/);
  assert.ok(index.indexOf("registerUserRoutes(app)") < index.indexOf("registerHandlerRoutes(app)"));
  assert.match(readme, /USER_DATABASE_URL/);

  const serviceBlock = cloudBuild.slice(
    cloudBuild.indexOf("gcloud run deploy ${_SERVICE_NAME}"),
    cloudBuild.indexOf("waitFor: ['push']"),
  );
  assert.match(serviceBlock, /USER_DATABASE_URL=USER_DATABASE_URL:latest/);
});
