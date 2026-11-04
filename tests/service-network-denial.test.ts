import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { handler } from "../handler.js";
import { getFacilitatorSupported } from "../x402/facilitator.js";
import { isServiceAllowedNetwork, isServiceBlockedNetwork, isTestnetNetwork } from "../x402/configs/chains.js";

const ORIGINAL_ENV = {
  FACILITATOR_KEY: process.env.FACILITATOR_KEY,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  AVALANCHE_MAINNET_RPC: process.env.AVALANCHE_MAINNET_RPC,
  SOLANA_MAINNET_RPC: process.env.SOLANA_MAINNET_RPC,
  SVM_TREASURY_SERVER_WALLET_PUBLIC: process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC,
};

function createEvent(
  method: string,
  rawPath: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: { ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}