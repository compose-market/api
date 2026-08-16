import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import {
  initializeUserDatabase,
  type UserDatabaseExecutor,
} from "../data/user/db.js";
import {
  getUserConsent,
  putUserConsent,
  listUserConsents,
  putWalletPair,
} from "../data/user/store.js";
import { registerUserRoutes } from "../data/user/routes.js";
import {
  DEFAULT_DISCLAIMER_TYPE,
  DEFAULT_POLICY_VERSION,
  parseConsentBody,
  parseConsentLookup,
  ConsentValidationError,
} from "../data/user/validation.js";
import type { UserConsentRecord } from "../data/user/types.js";

const EVM = `0x${"Ab".repeat(20)}`;
const NORMALIZED_EVM = EVM.toLowerCase();
const SVM = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq";

type Row = Record<string, unknown>;

function mockExecutor(
  query: (statement: string, params?: readonly unknown[]) => Promise<Row[]>,
): UserDatabaseExecutor {
  return { query };
}

test("initializeUserDatabase adds consent columns to wallet_pairs and drops user_consents table", async () => {
  const statements: string[] = [];
  await initializeUserDatabase(mockExecutor(async (statement) => {
    statements.push(statement.replace(/\s+/g, " ").trim());
    return [];
  }));

  assert.equal(statements.length, 3);
  assert.match(statements[0]!, /CREATE TABLE IF NOT EXISTS public\.wallet_pairs/);
  assert.match(statements[0]!, /consented_at timestamptz/);
  assert.match(statements[1]!, /ALTER TABLE public\.wallet_pairs ADD COLUMN IF NOT EXISTS consented_at/);
  assert.match(statements[2]!, /DROP TABLE IF EXISTS public\.user_consents/);
});

test("parseConsentBody normalizes addresses and validates required fields", () => {
  const validEvm = parseConsentBody({
    address: EVM,
    signature: "0xsignature123",
    message: "I agree to terms",
  });
  assert.deepEqual(validEvm, {
    address: NORMALIZED_EVM,
    disclaimerType: DEFAULT_DISCLAIMER_TYPE,
    policyVersion: DEFAULT_POLICY_VERSION,
    signature: "0xsignature123",
    message: "I agree to terms",
    metadata: undefined,
  });

  const validSvm = parseConsentBody({
    address: SVM,
    disclaimerType: "ai_passthrough",
    policyVersion: "2.0.0",
    signature: "svm_sig_456",
    message: "I agree to terms SVM",
    metadata: { userAgent: "test-agent" },
  });
  assert.deepEqual(validSvm, {
    address: SVM,
    disclaimerType: "ai_passthrough",
    policyVersion: "2.0.0",
    signature: "svm_sig_456",
    message: "I agree to terms SVM",
    metadata: { userAgent: "test-agent" },
  });

  assert.throws(() => parseConsentBody(null), ConsentValidationError);
  assert.throws(() => parseConsentBody({}), ConsentValidationError);
  assert.throws(() => parseConsentBody({ address: "invalid", signature: "sig", message: "msg" }), Error);
  assert.throws(() => parseConsentBody({ address: EVM, signature: "", message: "msg" }), ConsentValidationError);
  assert.throws(() => parseConsentBody({ address: EVM, signature: "sig", message: "" }), ConsentValidationError);
});

test("parseConsentLookup extracts address and optional query filters", () => {
  assert.deepEqual(parseConsentLookup(EVM), {
    address: NORMALIZED_EVM,
    disclaimerType: undefined,
    policyVersion: undefined,
  });
  assert.deepEqual(parseConsentLookup(SVM, { type: "ai_passthrough", version: "1.0.0" }), {
    address: SVM,
    disclaimerType: "ai_passthrough",
    policyVersion: "1.0.0",
  });
});

test("putUserConsent updates existing wallet_pair with consent fields", async () => {
  const calls: Array<{ statement: string; params?: readonly unknown[] }> = [];
  const db = mockExecutor(async (statement, params) => {
    calls.push({ statement, params });
    return [{
      evm_address: NORMALIZED_EVM,
      svm_address: SVM,
      consented_at: "2026-08-15T12:00:00.000Z",
      consent_version: DEFAULT_POLICY_VERSION,
      consent_signature: "0xsig",
      consent_message: "I agree",
      consent_metadata: { ip: "127.0.0.1" },
    }];
  });

  const record = await putUserConsent({
    address: EVM,
    signature: "0xsig",
    message: "I agree",
    metadata: { ip: "127.0.0.1" },
    policyVersion: DEFAULT_POLICY_VERSION,
  }, db);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.statement, /UPDATE public\.wallet_pairs/);
  assert.match(calls[0]!.statement, /WHERE evm_address = \$1 OR svm_address = \$1/);
  assert.equal(record.evmAddress, NORMALIZED_EVM);
  assert.equal(record.svmAddress, SVM);
  assert.equal(record.signature, "0xsig");
});

test("getUserConsent resolves consent for both EVM and SVM from single wallet_pair row", async () => {
  const db = mockExecutor(async (_statement, params) => {
    if (params?.[0] === NORMALIZED_EVM || params?.[0] === SVM) {
      return [{
        evm_address: NORMALIZED_EVM,
        svm_address: SVM,
        consented_at: "2026-08-15T10:00:00.000Z",
        consent_version: "1.0.0",
        consent_signature: "0xsig42",
        consent_message: "terms",
      }];
    }
    return [];
  });

  // Query by EVM address
  const foundByEvm = await getUserConsent({ address: EVM }, db);
  assert.ok(foundByEvm);
  assert.equal(foundByEvm.evmAddress, NORMALIZED_EVM);
  assert.equal(foundByEvm.svmAddress, SVM);
  assert.equal(foundByEvm.signature, "0xsig42");

  // Query by SVM address - automatically consented without signing twice!
  const foundBySvm = await getUserConsent({ address: SVM }, db);
  assert.ok(foundBySvm);
  assert.equal(foundBySvm.evmAddress, NORMALIZED_EVM);
  assert.equal(foundBySvm.svmAddress, SVM);
  assert.equal(foundBySvm.signature, "0xsig42");

  // Non-matching address returns null
  const notFound = await getUserConsent({ address: "0x1111111111111111111111111111111111111111" }, db);
  assert.equal(notFound, null);
});

async function withConsentServer(
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

test("Consent HTTP routes POST/PUT and GET respond with correct JSON payloads", async () => {
  const storedConsent: UserConsentRecord = {
    evmAddress: NORMALIZED_EVM,
    svmAddress: SVM,
    policyVersion: "1.0.0",
    signature: "0xsig_test",
    message: "Accepted AI Disclaimer",
    signedAt: "2026-08-15T12:00:00.000Z",
  };

  await withConsentServer({
    putConsent: async (input) => ({
      evmAddress: NORMALIZED_EVM,
      svmAddress: SVM,
      policyVersion: input.policyVersion,
      signature: input.signature,
      message: input.message,
      metadata: input.metadata,
      signedAt: "2026-08-15T12:00:00.000Z",
    }),
    findConsent: async (lookup) => {
      if (lookup.address === NORMALIZED_EVM || lookup.address === SVM) return storedConsent;
      return null;
    },
  }, async (origin) => {
    // POST consent
    const postRes = await fetch(`${origin}/api/user/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: EVM,
        policyVersion: "1.0.0",
        signature: "0xsig_test",
        message: "Accepted AI Disclaimer",
      }),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json() as UserConsentRecord;
    assert.equal(postBody.evmAddress, NORMALIZED_EVM);
    assert.equal(postBody.svmAddress, SVM);
    assert.equal(postBody.signature, "0xsig_test");

    // GET consent found by EVM
    const getRes = await fetch(`${origin}/api/user/consent/${EVM}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as { consented: boolean; evmAddress: string; svmAddress: string; record: UserConsentRecord | null };
    assert.equal(getBody.consented, true);
    assert.equal(getBody.evmAddress, NORMALIZED_EVM);
    assert.equal(getBody.svmAddress, SVM);
    assert.equal(getBody.record?.signature, "0xsig_test");

    // GET consent found by SVM (same row)
    const getResSvm = await fetch(`${origin}/api/user/consent/${SVM}`);
    assert.equal(getResSvm.status, 200);
    const getBodySvm = await getResSvm.json() as { consented: boolean; evmAddress: string; svmAddress: string; record: UserConsentRecord | null };
    assert.equal(getBodySvm.consented, true);
    assert.equal(getBodySvm.evmAddress, NORMALIZED_EVM);

    // GET consent not found
    const getResNotFound = await fetch(`${origin}/api/user/consent/0x1111111111111111111111111111111111111111`);
    assert.equal(getResNotFound.status, 200);
    const getBodyNotFound = await getResNotFound.json() as { consented: boolean; record: UserConsentRecord | null };
    assert.equal(getBodyNotFound.consented, false);
    assert.equal(getBodyNotFound.record, null);

    // Invalid body returns 400
    const badRes = await fetch(`${origin}/api/user/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: EVM }),
    });
    assert.equal(badRes.status, 400);
  });
});
