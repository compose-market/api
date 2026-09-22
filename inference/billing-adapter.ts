import type { Output, Request } from "./core.js";
import { resolveModel } from "./catalog/registry.js";
import {
  buildAuthoritativeBilling,
  buildRequestBilling,
} from "./telemetry.js";
import type { ModelCard, ModelProvider } from "./types.js";
import {
  differenceMeteredAmount,
  quoteMeteredAuthorization,
  quoteMeteredSettlement,
  type MeteredAmountBreakdown,
  type MeteredAuthorizationInput,
  type MeteredSettlementInput,
  type MeterLineItem,
  type MeteredQuotedLineItem,
} from "../x402/metering.js";

export type ResolvedBillingModel = ReturnType<typeof resolveModel>;

export interface ResolvedAuthorizationInput {
  useBudgetCap: true;
  scheme?: "batch-settlement";
}

export interface MeteredModelQuote extends MeteredAmountBreakdown {
  modelId: string;
  provider: ModelProvider;
  known: boolean;
}