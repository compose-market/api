import { cacheDel, cached, cacheSet } from "../../cache.js";
import { userDatabase, type UserDatabaseExecutor } from "./db.js";
import type { WalletPair, UserConsentRecord, RecordConsentInput, ConsentLookupQuery } from "./types.js";
import { parsePairBody, parsePairLookupAddress, parseConsentBody, parseConsentLookup } from "./validation.js";

const USER_L2_TTL_S = 300;
const USER_L1_TTL_MS = 60_000;

function pairCacheKey(address: string): string {
  return `user:pair:${address}`;
}

function consentCacheKey(address: string, policyVersion?: string): string {
  return `user:consent:${address}:${policyVersion ?? ""}`;
}

export class PairConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = "Wallet address is already paired") {
    super(message);
    this.name = "PairConflictError";
  }
}

export class PairNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message = "Wallet pair not found") {
    super(message);
    this.name = "PairNotFoundError";
  }
}

export class PairStoreUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(message = "Wallet pair storage is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "PairStoreUnavailableError";
  }
}

function pairFromRow(row: Record<string, unknown> | undefined): WalletPair | null {
  if (!row || typeof row.evm_address !== "string" || typeof row.svm_address !== "string") {
    return null;
  }
  const result: WalletPair = {
    evmAddress: row.evm_address,
    svmAddress: row.svm_address,
  };
  if (row.consented_at) {
    result.consentedAt = row.consented_at instanceof Date
      ? row.consented_at.toISOString()
      : String(row.consented_at);
    if (typeof row.consent_version === "string") result.consentVersion = row.consent_version;
    if (typeof row.consent_signature === "string") result.consentSignature = row.consent_signature;
    if (typeof row.consent_message === "string") result.consentMessage = row.consent_message;
    if (row.consent_metadata && typeof row.consent_metadata === "object") {
      result.consentMetadata = row.consent_metadata as Record<string, unknown>;
    }
  }
  return result;
}

function consentFromRow(row: Record<string, unknown> | undefined): UserConsentRecord | null {
  if (!row || typeof row.evm_address !== "string" || typeof row.svm_address !== "string" || !row.consented_at) {
    return null;
  }
  return {
    evmAddress: row.evm_address,
    svmAddress: row.svm_address,
    policyVersion: typeof row.consent_version === "string" ? row.consent_version : "1.0.0",
    signature: typeof row.consent_signature === "string" ? row.consent_signature : "",
    message: typeof row.consent_message === "string" ? row.consent_message : "",
    metadata: row.consent_metadata && typeof row.consent_metadata === "object"
      ? (row.consent_metadata as Record<string, unknown>)
      : undefined,
    signedAt: row.consented_at instanceof Date
      ? row.consented_at.toISOString()
      : String(row.consented_at),
  };
}

async function available<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof PairConflictError
      || error instanceof PairNotFoundError
      || (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number")
    ) {
      throw error;
    }
    throw new PairStoreUnavailableError(undefined, { cause: error });
  }
}

export async function putWalletPair(
  input: WalletPair,
  database?: UserDatabaseExecutor,
): Promise<WalletPair> {
  const pair = parsePairBody(input);
  return available(async () => {
    const db = database ?? userDatabase();
    const inserted = await db.query(`
      INSERT INTO public.wallet_pairs (evm_address, svm_address)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
    `, [pair.evmAddress, pair.svmAddress]);
    const created = pairFromRow(inserted[0]);
    if (created) {
      if (!database) {
        await Promise.all([
          cacheSet(pairCacheKey(created.evmAddress), created, USER_L2_TTL_S, USER_L1_TTL_MS),
          cacheSet(pairCacheKey(created.svmAddress), created, USER_L2_TTL_S, USER_L1_TTL_MS),
        ]);
      }
      return created;
    }

    const conflicts = await db.query(`
      SELECT evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
      FROM public.wallet_pairs
      WHERE evm_address = $1 OR svm_address = $2
    `, [pair.evmAddress, pair.svmAddress]);
    const existing = conflicts.map(pairFromRow).filter((value): value is WalletPair => value !== null);
    if (
      existing.length === 1
      && existing[0]!.evmAddress === pair.evmAddress
      && existing[0]!.svmAddress === pair.svmAddress
    ) {
      if (!database) {
        await Promise.all([
          cacheSet(pairCacheKey(existing[0]!.evmAddress), existing[0]!, USER_L2_TTL_S, USER_L1_TTL_MS),
          cacheSet(pairCacheKey(existing[0]!.svmAddress), existing[0]!, USER_L2_TTL_S, USER_L1_TTL_MS),
        ]);
      }
      return existing[0]!;
    }
    throw new PairConflictError();
  });
}

export async function getWalletPair(
  input: string,
  database?: UserDatabaseExecutor,
): Promise<WalletPair | null> {
  const address = parsePairLookupAddress(input);
  const load = () => available(async () => {
    const db = database ?? userDatabase();
    const rows = address.kind === "evm"
      ? await db.query(`
          SELECT evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
          FROM public.wallet_pairs
          WHERE evm_address = $1
          LIMIT 1
        `, [address.value])
      : await db.query(`
          SELECT evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
          FROM public.wallet_pairs
          WHERE svm_address = $1
          LIMIT 1
        `, [address.value]);
    return pairFromRow(rows[0]);
  });
  if (database) return load();
  return cached(pairCacheKey(address.value), USER_L2_TTL_S, USER_L1_TTL_MS, load);
}

export async function resolveWalletPair(
  address: string,
  database?: UserDatabaseExecutor,
): Promise<WalletPair> {
  const pair = await getWalletPair(address, database);
  if (pair) return pair;
  const error = new Error("Wallet pair not found") as Error & { statusCode: number };
  error.statusCode = 404;
  throw error;
}

export async function putUserConsent(
  input: RecordConsentInput,
  database?: UserDatabaseExecutor,
): Promise<UserConsentRecord> {
  const consent = parseConsentBody(input);
  return available(async () => {
    const db = database ?? userDatabase();
    const parsedAddr = parsePairLookupAddress(consent.address);

    // 1. Try updating an existing wallet_pairs row by either EVM or SVM address
    const updated = await db.query(`
      UPDATE public.wallet_pairs
      SET consented_at = now(),
          consent_version = $2,
          consent_signature = $3,
          consent_message = $4,
          consent_metadata = $5
      WHERE evm_address = $1 OR svm_address = $1
      RETURNING evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
    `, [
      parsedAddr.value,
      consent.policyVersion,
      consent.signature,
      consent.message,
      consent.metadata ? JSON.stringify(consent.metadata) : null,
    ]);

    let record = consentFromRow(updated[0]);
    if (record) {
      if (!database) {
        await cacheDel(
          pairCacheKey(record.evmAddress),
          pairCacheKey(record.svmAddress),
          consentCacheKey(record.evmAddress),
          consentCacheKey(record.svmAddress),
          consentCacheKey(record.evmAddress, record.policyVersion),
          consentCacheKey(record.svmAddress, record.policyVersion),
        );
      }
      return record;
    }

    // 2. If no pair row matched, extract paired counterpart from input or metadata and insert
    const svmAddr = typeof input.svmAddress === "string" && input.svmAddress.trim()
      ? input.svmAddress.trim()
      : (consent.metadata?.svmAddress && typeof consent.metadata.svmAddress === "string" ? consent.metadata.svmAddress.trim() : null);
    const evmAddr = parsedAddr.kind === "evm"
      ? parsedAddr.value
      : (consent.metadata?.evmAddress && typeof consent.metadata.evmAddress === "string" ? consent.metadata.evmAddress.toLowerCase().trim() : null);

    if (evmAddr && svmAddr) {
      const inserted = await db.query(`
        INSERT INTO public.wallet_pairs (
          evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
        )
        VALUES ($1, $2, now(), $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
        RETURNING evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
      `, [
        evmAddr,
        svmAddr,
        consent.policyVersion,
        consent.signature,
        consent.message,
        consent.metadata ? JSON.stringify(consent.metadata) : null,
      ]);
      record = consentFromRow(inserted[0]);
      if (!record) {
        const conflicts = await db.query(`
          SELECT evm_address, svm_address
          FROM public.wallet_pairs
          WHERE evm_address = $1 OR svm_address = $2
        `, [evmAddr, svmAddr]);
        const exactMatch = conflicts.length === 1
          && conflicts[0]?.evm_address === evmAddr
          && conflicts[0]?.svm_address === svmAddr;
        if (!exactMatch) {
          throw new PairConflictError("Wallet address is already paired with a different counterpart");
        }
        const reupdated = await db.query(`
          UPDATE public.wallet_pairs
          SET consented_at = now(),
              consent_version = $3,
              consent_signature = $4,
              consent_message = $5,
              consent_metadata = $6
          WHERE evm_address = $1 AND svm_address = $2
          RETURNING evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
        `, [
          evmAddr,
          svmAddr,
          consent.policyVersion,
          consent.signature,
          consent.message,
          consent.metadata ? JSON.stringify(consent.metadata) : null,
        ]);
        record = consentFromRow(reupdated[0]);
      }
      if (record) {
        if (!database) {
          await cacheDel(
            pairCacheKey(record.evmAddress),
            pairCacheKey(record.svmAddress),
            consentCacheKey(record.evmAddress),
            consentCacheKey(record.svmAddress),
            consentCacheKey(record.evmAddress, record.policyVersion),
            consentCacheKey(record.svmAddress, record.policyVersion),
          );
        }
        return record;
      }
    }

    throw new PairNotFoundError("Wallet pair not found. Please connect your wallet to pair your EVM and SVM accounts before signing.");
  });
}

export async function getUserConsent(
  input: ConsentLookupQuery | string,
  database?: UserDatabaseExecutor,
): Promise<UserConsentRecord | null> {
  const lookup = typeof input === "string"
    ? parseConsentLookup(input)
    : parseConsentLookup(input.address, { type: input.disclaimerType, version: input.policyVersion });

  return available(async () => {
    const db = database ?? userDatabase();
    const rows = await db.query(`
      SELECT evm_address, svm_address, consented_at, consent_version, consent_signature, consent_message, consent_metadata
      FROM public.wallet_pairs
      WHERE evm_address = $1 OR svm_address = $1
      LIMIT 1
    `, [lookup.address]);

    const record = consentFromRow(rows[0]);
    if (!record) return null;

    if (lookup.policyVersion && record.policyVersion !== lookup.policyVersion) {
      return null;
    }
    return record;
  });
}

export async function listUserConsents(
  addressInput: string,
  database?: UserDatabaseExecutor,
): Promise<UserConsentRecord[]> {
  const record = await getUserConsent(addressInput, database);
  return record ? [record] : [];
}
