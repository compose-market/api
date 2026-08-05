import { userDatabase, type UserDatabaseExecutor } from "./db.js";
import type { WalletPair } from "./types.js";
import { parsePairBody, parsePairLookupAddress } from "./validation.js";

export class PairConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = "Wallet address is already paired") {
    super(message);
    this.name = "PairConflictError";
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
  return { evmAddress: row.evm_address, svmAddress: row.svm_address };
}

async function available<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PairConflictError) throw error;
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
      RETURNING evm_address, svm_address
    `, [pair.evmAddress, pair.svmAddress]);
    const created = pairFromRow(inserted[0]);
    if (created) return created;

    const conflicts = await db.query(`
      SELECT evm_address, svm_address
      FROM public.wallet_pairs
      WHERE evm_address = $1 OR svm_address = $2
    `, [pair.evmAddress, pair.svmAddress]);
    const existing = conflicts.map(pairFromRow).filter((value): value is WalletPair => value !== null);
    if (
      existing.length === 1
      && existing[0]!.evmAddress === pair.evmAddress
      && existing[0]!.svmAddress === pair.svmAddress
    ) {
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
  return available(async () => {
    const db = database ?? userDatabase();
    const rows = address.kind === "evm"
      ? await db.query(`
          SELECT evm_address, svm_address
          FROM public.wallet_pairs
          WHERE evm_address = $1
          LIMIT 1
        `, [address.value])
      : await db.query(`
          SELECT evm_address, svm_address
          FROM public.wallet_pairs
          WHERE svm_address = $1
          LIMIT 1
        `, [address.value]);
    return pairFromRow(rows[0]);
  });
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
