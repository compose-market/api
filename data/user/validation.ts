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

export const DEFAULT_DISCLAIMER_TYPE = "ai_passthrough";
export const DEFAULT_POLICY_VERSION = "1.0.0";

export class ConsentValidationError extends Error {
  readonly statusCode = 400;

  constructor(message = "Invalid consent data") {
    super(message);
    this.name = "ConsentValidationError";
  }
}

export function parseConsentBody(input: unknown): import("./types.js").RecordConsentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConsentValidationError("Consent body must be an object");
  }

  const record = input as Record<string, unknown>;
  let address: string;
  try {
    address = parsePairLookupAddress(record.address).value;
  } catch (err) {
    throw new ConsentValidationError(err instanceof Error ? err.message : "Invalid wallet address");
  }
  const disclaimerType = stringValue(record.disclaimerType) ?? DEFAULT_DISCLAIMER_TYPE;
  const policyVersion = stringValue(record.policyVersion) ?? DEFAULT_POLICY_VERSION;
  const signature = stringValue(record.signature);
  const message = stringValue(record.message);

  if (!signature) {
    throw new ConsentValidationError("signature is required");
  }
  if (!message) {
    throw new ConsentValidationError("message is required");
  }

  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? (record.metadata as Record<string, unknown>)
    : undefined;

  return {
    address,
    disclaimerType,
    policyVersion,
    signature,
    message,
    metadata,
  };
}

export function parseConsentLookup(
  addressInput: unknown,
  query?: Record<string, unknown>,
): import("./types.js").ConsentLookupQuery {
  const address = parsePairLookupAddress(addressInput).value;
  const disclaimerType = query?.type ? stringValue(query.type) ?? undefined : undefined;
  const policyVersion = query?.version ? stringValue(query.version) ?? undefined : undefined;

  return {
    address,
    disclaimerType,
    policyVersion,
  };
}
