import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import { KeyPair } from "@near-js/crypto";
import { base58 } from "@scure/base";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { validateNearBatchPayment } from "../x402/batch.js";
import {
  getExplorerUrl,
  getNetwork,
  getNetworkRpcUrl,
  isAddressValidForNetwork,
  isNearNetwork,
  isServiceAllowedNetwork,
  isServiceBlockedNetwork,
  isTestnetNetwork,
  NETWORK_IDS,
  validateNearAddress,
  validateSolanaAddress,
  type NearNetworkId,
} from "../x402/configs/chains.js";
import {
  BatchSettlementNearFacilitator,
  createPaymentRequirement,
  getFacilitatorSupported,
  UptoNearFacilitator,
} from "../x402/facilitator.js";
import { getSessionFundingReadiness } from "../x402/session/allowance.js";

const FACILITATOR_SOURCE = await readFile(new URL("../x402/facilitator.ts", import.meta.url), "utf8");
const BATCH_SOURCE = await readFile(new URL("../x402/batch.ts", import.meta.url), "utf8");
const SETTLEMENT_SOURCE = await readFile(new URL("../x402/settlement.ts", import.meta.url), "utf8");
const ALLOWANCE_SOURCE = await readFile(new URL("../x402/session/allowance.ts", import.meta.url), "utf8");