import { ensure, getState, rows, setState } from "../db.js";
import type { ExpenseSyncResult } from "./openai.js";

const PROVIDER = "fireworks";
const ACCOUNTS_URL = "https://api.fireworks.ai/v1/accounts";
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_DAYS = 31;
const FIRST_DAY = "2025-06-12";

interface MoneyValue { units?: string | number; nanos?: number }
interface BillingLineItem {
    totalCost?: MoneyValue;
    groupingValue?: string;
    category?: string;
}
interface BillingSummary { lineItems?: BillingLineItem[] }

function yesterday(): string {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
    const value = new Date(`${day}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
}

function money(value?: MoneyValue): number {
    if (!value) return 0;
    return Number(value.units ?? "0") + Number(value.nanos ?? 0) / 1e9;
}

async function billingSummary(account: string, from: string, to: string): Promise<BillingSummary> {
    const query = new URLSearchParams({
        startTime: `${from}T00:00:00Z`,
        endTime: `${to}T00:00:00Z`,
    });
    const response = await fetch(`${ACCOUNTS_URL}/${account}/billing/summary?${query}`, {
        headers: { Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Fireworks billing/summary returned ${response.status}: ${body}`);
    }
    return await response.json() as BillingSummary;
}

async function upsertDay(day: string, total: number, details: Record<string, number>): Promise<void> {
    const value = Number.isFinite(total) ? total : 0;
    await rows(
        `INSERT INTO expenses (provider, day, cost_usd, currency, details)
         VALUES ($1, $2, $3, 'USD', $4)
         ON CONFLICT (provider, day) DO UPDATE SET
           cost_usd = EXCLUDED.cost_usd,
           details = EXCLUDED.details,
           recorded_at = now()`,
        [PROVIDER, day, value.toFixed(6), JSON.stringify(details)],
    );
}

export async function syncFireworksExpenses(): Promise<ExpenseSyncResult> {
    const apiKey = process.env.FIREWORKS_API_KEY;
    const account = process.env.FIREWORKS_ID;
    if (!apiKey || !account) {
        console.warn("[expenses:fireworks] FIREWORKS_API_KEY or FIREWORKS_ID not set, skipping");
        return { days: 0, totalCost: 0 };
    }
    await ensure();
    const lastDay = await getState(`expenses:${PROVIDER}:last_day`);
    const endDay = yesterday();
    const startDay = lastDay ? addDays(lastDay, 1) : FIRST_DAY;
    if (startDay > endDay) return { days: 0, totalCost: 0 };

    const daily = new Map<string, { total: number; items: Record<string, number> }>();
    let cursor = startDay;
    while (cursor <= endDay) {
        const candidate = addDays(cursor, BATCH_DAYS - 1);
        const rangeEnd = candidate > endDay ? endDay : candidate;
        try {
            const summary = await billingSummary(account, cursor, rangeEnd);
            for (const lineItem of summary.lineItems ?? []) {
                const cost = money(lineItem.totalCost);
                if (cost <= 0) continue;
                const item = lineItem.groupingValue ?? lineItem.category ?? "unknown";
                if (!daily.has(cursor)) daily.set(cursor, { total: 0, items: {} });
                const entry = daily.get(cursor)!;
                entry.total += cost;
                entry.items[item] = (entry.items[item] ?? 0) + cost;
            }
        } catch (error) {
            console.warn(`[expenses:fireworks] failed for ${cursor} to ${rangeEnd}:`, error instanceof Error ? error.message : String(error));
        }
        cursor = addDays(rangeEnd, 1);
    }

    let days = 0;
    let totalCost = 0;
    for (const [day, value] of daily) {
        await upsertDay(day, value.total, value.items);
        await setState(`expenses:${PROVIDER}:last_day`, day);
        days += 1;
        totalCost += value.total;
    }
    if (days === 0) await setState(`expenses:${PROVIDER}:last_day`, endDay);
    return { days, totalCost };
}
