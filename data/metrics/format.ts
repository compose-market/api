const USDC_DECIMALS = 6;

export function normalizeAtomic(value: string | number | bigint): string {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error("USDC atomic amount must be a non-negative safe integer");
        }
        return String(value);
    }

    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error("USDC atomic amount must be a non-negative integer string");
    }

    return trimmed.replace(/^0+(?=\d)/, "") || "0";
}

export function formatUsdcAtomic(value: string | number | bigint): string {
    const normalized = normalizeAtomic(value);
    const padded = normalized.padStart(USDC_DECIMALS + 1, "0");
    const whole = padded.slice(0, -USDC_DECIMALS).replace(/^0+(?=\d)/, "") || "0";
    const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
}

export function iso(value: unknown): string | undefined {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "string" && value.length > 0) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    return undefined;
}
