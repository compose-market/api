import type { NetworkId } from "../../x402/configs/chains.js";

export interface WalletPair {
  evmAddress: string;
  svmAddress: string;
  consentedAt?: string | null;
  consentVersion?: string | null;
  consentSignature?: string | null;
  consentMessage?: string | null;
  consentMetadata?: Record<string, unknown> | null;
}

export interface WalletScope {
  network: NetworkId;
  address: string;
}

export interface UserConsentRecord {
  evmAddress: string;
  svmAddress: string;
  policyVersion: string;
  signature: string;
  message: string;
  metadata?: Record<string, unknown>;
  signedAt: string;
}

export interface RecordConsentInput {
  address: string;
  svmAddress?: string;
  disclaimerType?: string;
  policyVersion: string;
  signature: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ConsentLookupQuery {
  address: string;
  disclaimerType?: string;
  policyVersion?: string;
}

export interface ConsentStatusResponse {
  consented: boolean;
  evmAddress?: string | null;
  svmAddress?: string | null;
  record: UserConsentRecord | null;
}
