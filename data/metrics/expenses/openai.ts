import { ensure, getState, rows, setState } from "../db.js";

const PROVIDER = "openai";
const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 180;

interface OpenAICostAmount {
    value?: number | string;
}

interface OpenAICostResult {
    amount?: OpenAICostAmount;
    api_key_id?: string;
    line_item?: string;
}

interface OpenAICostBucket {
    start_time: number;
    start_time_iso?: string;
    results?: OpenAICostResult[];
}

interface OpenAICostPage {
    data?: OpenAICostBucket[];
    has_more?: boolean;
    next_page?: string | null;
}

export interface ExpenseSyncResult {
    days: number;
    totalCost: number;
}

function dayStartSeconds(day: string): number {
    return Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1_000);
}

function dayEndSeconds(day: string): number {
    const value = new Date(`${day}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return Math.floor(value.getTime() / 1_000);
}

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

async function fetchCosts(startTime: number, page?: string): Promise<OpenAICostPage> {
    const query = new URLSearchParams({
        start_time: String(startTime),
        limit: String(PAGE_LIMIT),
        group_by: "api_key_id",
    });
    if (page) query.set("page", page);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(`${COSTS_URL}?${query}`, {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_ADMIN_KEY}`,
                    "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (response.status >= 500 && attempt < 2) {
                const body = await response.text().catch(() => "");
                lastError = new Error(`OpenAI costs API returned ${response.status}: ${body}`);
                await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
                continue;
            }
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`OpenAI costs API returned ${response.status}: ${body}`);
            }
            return await response.json() as OpenAICostPage;
        } catch (error) {
            if (attempt < 2 && error instanceof Error && !error.message.includes("returned 4")) {
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error("OpenAI costs API failed after retries");
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

export async function syncOpenAIExpenses(): Promise<ExpenseSyncResult> {
    if (!process.env.OPENAI_ADMIN_KEY) {
        console.warn("[expenses:openai] OPENAI_ADMIN_KEY not set, skipping");
        return { days: 0, totalCost: 0 };
    }
    await ensure();
    const lastDay = await getState(`expenses:${PROVIDER}:last_day`);
    const endDay = yesterday();
    const startDay = lastDay ? addDays(lastDay, 1) : "2024-01-01";
    if (startDay > endDay) return { days: 0, totalCost: 0 };

    const startTime = dayStartSeconds(startDay);
    dayEndSeconds(endDay);
    let page: string | undefined;
    const daily = new Map<string, { total: number; items: Record<string, number> }>();
    do {
        const response = await fetchCosts(startTime, page);
        for (const bucket of response.data ?? []) {
            const day = bucket.start_time_iso
                ? bucket.start_time_iso.slice(0, 10)
                : new Date(bucket.start_time * 1_000).toISOString().slice(0, 10);
            if (!daily.has(day)) daily.set(day, { total: 0, items: {} });
            const entry = daily.get(day)!;
            for (const result of bucket.results ?? []) {
                const amount = Number(result.amount?.value ?? 0);
                entry.total += amount;
                const item = result.api_key_id ?? result.line_item ?? "unknown";
                entry.items[item] = (entry.items[item] ?? 0) + amount;
            }
        }
        page = response.has_more ? response.next_page ?? undefined : undefined;
    } while (page);

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
