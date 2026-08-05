import { exec } from "node:child_process";
import { promisify } from "node:util";

import { ensure, getState, rows, setState } from "../db.js";
import type { ExpenseSyncResult } from "./openai.js";

const PROVIDER = "azure";
const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_DAY = "2024-01-01";
const execAsync = promisify(exec);

interface AzureColumn { name?: string }
interface AzureCostResponse {
    error?: { message?: string };
    properties?: { columns?: AzureColumn[]; rows?: unknown[][] };
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

async function accessToken(): Promise<string> {
    const { stdout } = await execAsync(
        "az account get-access-token --resource https://management.azure.com --query accessToken -o tsv",
        { timeout: 15_000 },
    );
    return stdout.trim();
}

async function queryCosts(token: string, from: string, to: string): Promise<Array<{ day: string; costUsd: number; meter: string }>> {
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    if (!subscriptionId) throw new Error("AZURE_SUBSCRIPTION_ID is required for Azure expense tracking");
    const body = JSON.stringify({
        type: "Usage",
        timeframe: "Custom",
        timePeriod: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
        dataset: {
            granularity: "Daily",
            aggregation: { totalCostUSD: { name: "CostUSD", function: "Sum" } },
            grouping: [{ type: "Dimension", name: "Meter" }],
            filter: { dimensions: { name: "ServiceName", operator: "In", values: ["Foundry Models"] } },
        },
    });
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const response = await fetch(
                `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`,
                {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                },
            );
            const payload = await response.json() as AzureCostResponse;
            if (response.status === 429 && attempt < 4) {
                const retryAfter = Number(response.headers.get("x-ms-ratelimit-microsoft.costmanagement-entity-retry-after") ?? "15");
                lastError = new Error("Azure CostManagement rate limited (429)");
                await new Promise((resolve) => setTimeout(resolve, (retryAfter || 15) * 1_000));
                continue;
            }
            if (!response.ok) {
                throw new Error(`Azure CostManagement query returned ${response.status}: ${payload.error?.message ?? response.statusText}`);
            }
            const properties = payload.properties;
            if (!properties?.rows) return [];
            const columns = properties.columns ?? [];
            const costIndex = columns.findIndex((column) => column.name === "CostUSD");
            const dayIndex = columns.findIndex((column) => column.name === "UsageDate");
            const meterIndex = columns.findIndex((column) => column.name === "Meter");
            return properties.rows.map((row) => ({
                day: dayIndex >= 0 ? String(row[dayIndex]).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : from,
                costUsd: Number(row[costIndex] ?? 0),
                meter: meterIndex >= 0 ? String(row[meterIndex] ?? "unknown") : "unknown",
            }));
        } catch (error) {
            if (attempt < 4 && error instanceof Error) {
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, 15_000));
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error("Azure CostManagement query failed after retries");
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

export async function syncAzureExpenses(): Promise<ExpenseSyncResult> {
    if (!process.env.AZURE_SUBSCRIPTION_ID) {
        console.warn("[expenses:azure] AZURE_SUBSCRIPTION_ID not set, skipping");
        return { days: 0, totalCost: 0 };
    }
    await ensure();
    let token: string;
    try {
        token = await accessToken();
    } catch (error) {
        console.warn("[expenses:azure] Failed to get Azure access token:", error instanceof Error ? error.message : String(error));
        return { days: 0, totalCost: 0 };
    }
    const lastDay = await getState(`expenses:${PROVIDER}:last_day`);
    const endDay = yesterday();
    const startDay = lastDay ? addDays(lastDay, 1) : FIRST_DAY;
    if (startDay > endDay) return { days: 0, totalCost: 0 };

    const daily = new Map<string, { total: number; items: Record<string, number> }>();
    let cursor = startDay;
    while (cursor <= endDay) {
        const yearEnd = `${cursor.slice(0, 4)}-12-31`;
        const rangeEnd = yearEnd > endDay ? endDay : yearEnd;
        try {
            for (const { day, costUsd, meter } of await queryCosts(token, cursor, rangeEnd)) {
                if (costUsd <= 0) continue;
                if (!daily.has(day)) daily.set(day, { total: 0, items: {} });
                const entry = daily.get(day)!;
                entry.total += costUsd;
                entry.items[meter] = (entry.items[meter] ?? 0) + costUsd;
            }
        } catch (error) {
            console.warn(`[expenses:azure] failed for ${cursor} to ${rangeEnd}:`, error instanceof Error ? error.message : String(error));
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
