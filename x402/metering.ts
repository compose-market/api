const MICRO_SCALE = 1_000_000n;
const PLATFORM_FEE_BASIS_POINTS = 100n; // 1%

export type MeterPriceUnit = string;

export interface MeterLineItem {
  key: string;
  unit: MeterPriceUnit;
  quantity: number;
  unitPriceUsd: number;
}

export interface MeteredAuthorizationInput {
  subject: string;
  lineItems: MeterLineItem[];
}

type Scheme = "exact" | "upto" | "batch-settlement";

export interface MeteredSettlementInput {
  subject: string;
  lineItems: MeterLineItem[];
}

export interface MeteredQuotedLineItem extends MeterLineItem {
  amountWei: string;
}

export interface MeteredAmountBreakdown {
  subject: string;
  lineItems: MeteredQuotedLineItem[];
  providerAmountWei: string;
  platformFeeWei: string;
  finalAmountWei: string;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be greater than zero");
  }

  if (numerator === 0n) {
    return 0n;
  }

  return ((numerator - 1n) / denominator) + 1n;
}

function decimalToMicros(value: number, fieldName: string): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }

  const micros = Math.round(value * Number(MICRO_SCALE));
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new Error(`${fieldName} cannot be represented safely`);
  }

  return BigInt(micros);
}

function unitScale(unit: MeterPriceUnit): bigint {
  const normalized = unit.trim().toLowerCase();

  if (/_per_1m_/.test(normalized)) {
    return 1_000_000n;
  }

  const scaledMetric = normalized.match(/_per_(\d+)(k|m)_/);
  if (scaledMetric) {
    const value = BigInt(scaledMetric[1]);
    return scaledMetric[2] === "m" ? value * 1_000_000n : value * 1_000n;
  }

  const scaledSeconds = normalized.match(/_per_(\d+)_seconds$/);
  if (scaledSeconds) {
    return BigInt(scaledSeconds[1]);
  }

  return 1n;
}

function validateLineItem(item: MeterLineItem, index: number): void {
  if (!item.key) {
    throw new Error(`lineItems[${index}].key is required`);
  }
  if (!item.unit) {
    throw new Error(`lineItems[${index}].unit is required`);
  }
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
    throw new Error(`lineItems[${index}].quantity must be a positive finite number`);
  }
  if (!Number.isFinite(item.unitPriceUsd) || item.unitPriceUsd <= 0) {
    throw new Error(`lineItems[${index}].unitPriceUsd must be a positive finite number`);
  }
}

function quoteLineItem(item: MeterLineItem, index: number): MeteredQuotedLineItem {
  validateLineItem(item, index);

  const quantityMicros = decimalToMicros(item.quantity, `lineItems[${index}].quantity`);
  const unitPriceWei = decimalToMicros(item.unitPriceUsd, `lineItems[${index}].unitPriceUsd`);
  const amountWei = ceilDiv(quantityMicros * unitPriceWei, MICRO_SCALE * unitScale(item.unit));

  if (amountWei <= 0n) {
    throw new Error(`lineItems[${index}] resolves to zero amount`);
  }

  return {
    ...item,
    amountWei: amountWei.toString(),
  };
}

function quoteMeteredAmount(subject: string, lineItems: MeterLineItem[]): MeteredAmountBreakdown {
  if (!subject) {
    throw new Error("meter.subject is required");
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("lineItems must contain at least one priced quantity");
  }

  const quotedLineItems = lineItems.map((item, index) => quoteLineItem(item, index));
  const providerAmountWei = quotedLineItems.reduce((total, item) => total + BigInt(item.amountWei), 0n);

  if (providerAmountWei <= 0n) {
    throw new Error(`Metered amount resolved to zero for ${subject}`);
  }

  const platformFeeWei = ceilDiv(providerAmountWei, PLATFORM_FEE_BASIS_POINTS);
  const finalAmountWei = providerAmountWei + platformFeeWei;

  return {
    subject,
    lineItems: quotedLineItems,
    providerAmountWei: providerAmountWei.toString(),
    platformFeeWei: platformFeeWei.toString(),
    finalAmountWei: finalAmountWei.toString(),
  };
}


export function quoteMeteredAuthorization(input: MeteredAuthorizationInput): MeteredAmountBreakdown {
  return quoteMeteredAmount(input.subject, input.lineItems);
}

export function quoteMeteredSettlement(input: MeteredSettlementInput): MeteredAmountBreakdown {
  return quoteMeteredAmount(input.subject, input.lineItems);
}

function quotedLineItemIdentity(item: Pick<MeterLineItem, "key" | "unit" | "unitPriceUsd">): string {
  return JSON.stringify([item.key, item.unit, item.unitPriceUsd]);
}

function aggregateQuotedLineItems(
  lineItems: MeteredQuotedLineItem[],
): Map<string, MeteredQuotedLineItem> {
  const aggregated = new Map<string, MeteredQuotedLineItem>();
  for (const item of lineItems) {
    const identity = quotedLineItemIdentity(item);
    const existing = aggregated.get(identity);
    if (!existing) {
      aggregated.set(identity, { ...item });
      continue;
    }
    aggregated.set(identity, {
      ...existing,
      quantity: existing.quantity + item.quantity,
      amountWei: (BigInt(existing.amountWei) + BigInt(item.amountWei)).toString(),
    });
  }
  return aggregated;
}

/**
 * Return the exact atomic charge introduced by a new authoritative cumulative
 * quote. Rounding is applied to the cumulative quote before subtraction, so a
 * provider cannot change the total price by splitting identical usage across
 * more streaming checkpoints.
 */
export function differenceMeteredAmount(
  current: MeteredAmountBreakdown,
  previous?: MeteredAmountBreakdown,
): MeteredAmountBreakdown {
  if (!previous) {
    return {
      ...current,
      lineItems: current.lineItems.map((item) => ({ ...item })),
    };
  }
  if (current.subject !== previous.subject) {
    throw new Error("cumulative metered subject changed");
  }

  const difference = (field: "providerAmountWei" | "platformFeeWei" | "finalAmountWei"): bigint => {
    const currentValue = BigInt(current[field]);
    const previousValue = BigInt(previous[field]);
    if (currentValue < previousValue) {
      throw new Error(`cumulative metered amount regressed: ${field}`);
    }
    return currentValue - previousValue;
  };
  const providerAmountWei = difference("providerAmountWei");
  const platformFeeWei = difference("platformFeeWei");
  const finalAmountWei = difference("finalAmountWei");
  if (providerAmountWei + platformFeeWei !== finalAmountWei) {
    throw new Error("cumulative metered amount components are inconsistent");
  }

  const currentItems = aggregateQuotedLineItems(current.lineItems);
  const previousItems = aggregateQuotedLineItems(previous.lineItems);
  const lineItems: MeteredQuotedLineItem[] = [];
  let lineItemAmountWei = 0n;

  for (const [identity, currentItem] of currentItems) {
    const previousItem = previousItems.get(identity);
    const previousAmountWei = previousItem ? BigInt(previousItem.amountWei) : 0n;
    const currentAmountWei = BigInt(currentItem.amountWei);
    const previousQuantity = previousItem?.quantity ?? 0;
    const quantity = currentItem.quantity - previousQuantity;
    if (currentAmountWei < previousAmountWei || quantity < -Number.EPSILON) {
      throw new Error(`cumulative metered amount regressed: ${currentItem.key}`);
    }
    previousItems.delete(identity);

    const amountWei = currentAmountWei - previousAmountWei;
    if (amountWei === 0n) continue;
    if (!(quantity > 0)) {
      throw new Error(`cumulative metered quantity did not increase: ${currentItem.key}`);
    }
    lineItemAmountWei += amountWei;
    lineItems.push({
      ...currentItem,
      quantity,
      amountWei: amountWei.toString(),
    });
  }

  if (previousItems.size > 0) {
    throw new Error("cumulative metered amount regressed: priced unit disappeared");
  }
  if (lineItemAmountWei !== providerAmountWei) {
    throw new Error("cumulative metered line items are inconsistent");
  }

  return {
    subject: current.subject,
    lineItems,
    providerAmountWei: providerAmountWei.toString(),
    platformFeeWei: platformFeeWei.toString(),
    finalAmountWei: finalAmountWei.toString(),
  };
}

function positiveMetricDifference(
  current: Record<string, number>,
  previous: Record<string, number>,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(current)) {
    const prior = previous[key] || 0;
    if (value < prior) {
      throw new Error(`cumulative metered telemetry regressed: ${key}`);
    }
    if (value > prior) metrics[key] = value - prior;
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value > 0 && current[key] === undefined) {
      throw new Error(`cumulative metered telemetry regressed: ${key}`);
    }
  }
  return metrics;
}

export {
  differenceMeteredModelQuote,
  resolveBillingModel,
  meterSubject,
  buildResolvedAuthorizationMeter,
  buildResolvedAuthorizationInput,
  buildResolvedSettlementMeter,
  buildSettlementMeterFromOutput,
  requestBillingMetricsForCheckpoint,
  buildUsageRecordSettlementMeter,
  type ResolvedBillingModel,
  type ResolvedAuthorizationInput,
  type SettlementMeterArgs,
  type MeteredModelQuote,
  type UsageRecord,
} from "../inference/billing-adapter.js";
