import { ensure, getState, rows, setState } from "../db.js";
import type { ExpenseSyncResult } from "./openai.js";

const PROVIDER = "fireworks";
const ACCOUNTS_URL = "https://api.fireworks.ai/v1/accounts";
const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_DAY = "2025-06-12";
const REPLAY_DAYS = 7;
const DAILY_VERSION = "1";

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
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(`${ACCOUNTS_URL}/${account}/billing/summary?${query}`, {
            headers: { Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return await response.json() as BillingSummary;
        const body = await response.text().catch(() => "");
        lastError = new Error(`Fireworks billing/summary returned ${response.status}: ${body}`);
        if (attempt >= 3 || (response.status !== 429 && response.status < 500)) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
    throw lastError ?? new Error("Fireworks billing/summary failed after retries");
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
    if (!apiKey && !account) {
        console.warn("[expenses:fireworks] FIREWORKS_API_KEY and FIREWORKS_ID not set, skipping");
        return { days: 0, totalCost: 0 };
    }
    if (!apiKey || !account) throw new Error("FIREWORKS_API_KEY and FIREWORKS_ID must both be set");
    await ensure();
    const lastDay = await getState(`expenses:${PROVIDER}:last_day`);
    const dailyVersion = await getState(`expenses:${PROVIDER}:daily_version`);
    const endDay = yesterday();
    const replayDay = dailyVersion === DAILY_VERSION && lastDay
        ? addDays(lastDay, 1 - REPLAY_DAYS)
        : FIRST_DAY;
    const startDay = replayDay < FIRST_DAY ? FIRST_DAY : replayDay;
    if (startDay > endDay) return { days: 0, totalCost: 0 };

    let days = 0;
    let totalCost = 0;
    let cursor = startDay;
    while (cursor <= endDay) {
        const summary = await billingSummary(account, cursor, addDays(cursor, 1));
        let total = 0;
        const items: Record<string, number> = {};
        for (const lineItem of summary.lineItems ?? []) {
            const cost = money(lineItem.totalCost);
            if (cost <= 0) continue;
            const item = lineItem.groupingValue ?? lineItem.category ?? "unknown";
            total += cost;
            items[item] = (items[item] ?? 0) + cost;
        }
        await upsertDay(cursor, total, items);
        days += 1;
        totalCost += total;
        cursor = addDays(cursor, 1);
    }
    await setState(`expenses:${PROVIDER}:last_day`, endDay);
    await setState(`expenses:${PROVIDER}:daily_version`, DAILY_VERSION);
    return { days, totalCost };
}
