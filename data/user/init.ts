import "dotenv/config";
import { pathToFileURL } from "node:url";

import { initializeUserDatabase } from "./db.js";

export async function main(): Promise<void> {
  await initializeUserDatabase();
  console.log("Initialized public.wallet_pairs with consent columns in the User database.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
