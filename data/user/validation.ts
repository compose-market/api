import { validateSvmAddress } from "@x402/svm";

import type { WalletPair } from "./types.js";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export class PairValidationError extends Error {
  readonly statusCode = 400;

  constructor(message = "Invalid wallet pair") {
    super(message);
    this.name = "PairValidationError";
  }
}

export type PairLookupAddress =
  | { kind: "evm"; value: string }
  | { kind: "svm"; value: string };

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parsePairLookupAddress(input: unknown): PairLookupAddress {
  const address = stringValue(input);
  if (!address) throw new PairValidationError("Invalid wallet address");
  if (EVM_ADDRESS.test(address)) {
    return { kind: "evm", value: address.toLowerCase() };
  }
  if (validateSvmAddress(address)) {
    return { kind: "svm", value: address };
  }
  throw new PairValidationError("Invalid wallet address");
}

export function parsePairBody(input: unknown): WalletPair {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PairValidationError();
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "evmAddress" || keys[1] !== "svmAddress") {
    throw new PairValidationError();
  }

  let evm: PairLookupAddress;
  let svm: PairLookupAddress;
  try {
    evm = parsePairLookupAddress(record.evmAddress);
    svm = parsePairLookupAddress(record.svmAddress);
  } catch {
    throw new PairValidationError();
  }
  if (evm.kind !== "evm" || svm.kind !== "svm") {
    throw new PairValidationError();
  }
  return { evmAddress: evm.value, svmAddress: svm.value };
}
