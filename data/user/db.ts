import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface UserDatabaseExecutor {
  query(statement: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

type UserSql = NeonQueryFunction<false, false>;

let client: UserSql | null = null;
let executor: UserDatabaseExecutor | null = null;

export function userDatabase(): UserDatabaseExecutor {
  if (executor) return executor;
  const url = process.env.USER_DATABASE_URL?.trim();
  if (!url) throw new Error("USER_DATABASE_URL is required");
  client ??= neon(url);
  executor = {
    async query(statement, params) {
      return await client!.query(statement, params ? [...params] : undefined) as Record<string, unknown>[];
    },
  };
  return executor;
}

export async function initializeUserDatabase(
  database: UserDatabaseExecutor = userDatabase(),
): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS public.wallet_pairs (
      evm_address text PRIMARY KEY,
      svm_address text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      consented_at timestamptz,
      consent_version text,
      consent_signature text,
      consent_message text,
      consent_metadata jsonb
    )
  `);
  await database.query(`
    ALTER TABLE public.wallet_pairs
    ADD COLUMN IF NOT EXISTS consented_at timestamptz,
    ADD COLUMN IF NOT EXISTS consent_version text,
    ADD COLUMN IF NOT EXISTS consent_signature text,
    ADD COLUMN IF NOT EXISTS consent_message text,
    ADD COLUMN IF NOT EXISTS consent_metadata jsonb
  `);
  await database.query(`
    DROP TABLE IF EXISTS public.user_consents CASCADE
  `);
}
