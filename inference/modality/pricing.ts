import { normalizeCompiledPricing } from "../telemetry.js";
import type { ModelPricing } from "../types.js";
import type { PricingUnit } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumericEntries(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  const entries: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      entries[key] = rawValue;
    }
  }
  return entries;
}

function unitFromSection(section: Record<string, unknown>): PricingUnit | null {
  const unitKey = typeof section.unitKey === "string"
    ? section.unitKey
    : typeof section.unit === "string"
      ? section.unit
      : null;
  if (!unitKey) {
    return null;
  }

  const entries = readNumericEntries(section.entries ?? section.values);
  if (Object.keys(entries).length === 0) {
    return null;
  }

  return {
    unitKey,
    ...(typeof section.unit === "string" ? { unit: section.unit } : {}),
    ...(typeof section.header === "string" ? { header: section.header } : {}),
    entries,
    valueKeys: Object.keys(entries),
    ...(section.default === true ? { default: true } : {}),
  };
}

function dedupePricingUnits(units: PricingUnit[]): PricingUnit[] {
  const byKey = new Map<string, PricingUnit>();
  for (const unit of units) {
    const key = [
      unit.header || "",
      unit.unitKey,
      unit.unit || "",
      unit.default === true ? "default" : "",
      unit.valueKeys.join(","),
      JSON.stringify(unit.entries),
    ].join("\u0000");
    if (!byKey.has(key)) {
      byKey.set(key, {
        ...unit,
        entries: { ...unit.entries },
        valueKeys: [...unit.valueKeys],
      });
    }
  }
  return [...byKey.values()];
}

export function extractPricingUnits(pricing: ModelPricing | null | undefined): PricingUnit[] {
  if (!pricing) {
    return [];
  }

  const normalized = normalizeCompiledPricing(pricing);
  const record = asRecord(normalized);
  if (!record) {
    return [];
  }

  if (Array.isArray(record.sections)) {
    return dedupePricingUnits(
      record.sections
        .map((section) => asRecord(section))
        .filter((section): section is Record<string, unknown> => Boolean(section))
        .map(unitFromSection)
        .filter((unit): unit is PricingUnit => Boolean(unit)),
    );
  }

  if (typeof record.unit === "string") {
    const unit = unitFromSection(record);
    return unit ? [unit] : [];
  }

  return [];
}

export function mergePricingUnits(units: PricingUnit[]): PricingUnit[] {
  const merged = new Map<string, PricingUnit>();
  for (const unit of units) {
    const key = [
      unit.header || "",
      unit.unitKey,
      unit.unit || "",
      unit.default === true ? "default" : "",
      unit.valueKeys.join(","),
    ].join("\u0000");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        unitKey: unit.unitKey,
        ...(unit.unit ? { unit: unit.unit } : {}),
        ...(unit.header ? { header: unit.header } : {}),
        ...(unit.default === true ? { default: true } : {}),
        entries: {},
        valueKeys: [...unit.valueKeys],
      });
      continue;
    }

    const valueKeys = [...new Set([...existing.valueKeys, ...unit.valueKeys])].sort();
    merged.set(key, {
      ...existing,
      entries: {},
      valueKeys,
      default: existing.default === true || unit.default === true ? true : undefined,
    });
  }

  return [...merged.values()];
}
