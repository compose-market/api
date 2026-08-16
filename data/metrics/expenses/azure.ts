import { exec } from "node:child_process";
import { promisify } from "node:util";

import { ensure, getState, rows, setState } from "../db.js";
import type { ExpenseSyncResult } from "./openai.js";

const PROVIDER = "azure";
const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_DAY = "2024-01-01";
const REPLAY_DAYS = 7;
const execAsync = promisify(exec);

interface AzureColumn { name?: string }
interface AzureCostResponse {
    error?: { message?: string };
    properties?: { columns?: AzureColumn[]; rows?: unknown[][] };
}
interface AzureTokenResponse {
    access_token?: string;
    error?: string;
    error_description?: string;
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
    const tenantId = process.env.AZURE_TENANT_ID?.trim();
    const clientId = process.env.AZURE_CLIENT_ID?.trim();
    const clientSecret = process.env.AZURE_CLIENT_SECRET?.trim();
    if (tenantId && clientId && clientSecret) {
        const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                scope: "https://management.azure.com/.default",
                grant_type: "client_credentials",
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const payload = await response.json() as AzureTokenResponse;
        if (!response.ok || !payload.access_token) {
            throw new Error(`Azure OAuth token request returned ${response.status}: ${payload.error_description ?? payload.error ?? response.statusText}`);
        }
        return payload.access_token;
    }
    const { stdout } = await execAsync(
        "az account get-access-token --resource https://management.azure.com --query accessToken -o tsv",
        { timeout: 15_000 },
    );
    const token = stdout.trim();
    if (!token) throw new Error("az returned an empty Azure access token");
    return token;
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
            if (response.status === 204) return [];
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
    const token = await accessToken();
    const lastDay = await getState(`expenses:${PROVIDER}:last_day`);
    const endDay = yesterday();
    const replayDay = lastDay ? addDays(lastDay, 1 - REPLAY_DAYS) : FIRST_DAY;
    const startDay = replayDay < FIRST_DAY ? FIRST_DAY : replayDay;
    if (startDay > endDay) return { days: 0, totalCost: 0 };

    let days = 0;
    let totalCost = 0;
    let cursor = startDay;
    while (cursor <= endDay) {
        const yearEnd = `${cursor.slice(0, 4)}-12-31`;
        const rangeEnd = yearEnd > endDay ? endDay : yearEnd;
        const daily = new Map<string, { total: number; items: Record<string, number> }>();
        for (const { day, costUsd, meter } of await queryCosts(token, cursor, rangeEnd)) {
            if (costUsd <= 0 || day < cursor || day > rangeEnd) continue;
            if (!daily.has(day)) daily.set(day, { total: 0, items: {} });
            const entry = daily.get(day)!;
            entry.total += costUsd;
            entry.items[meter] = (entry.items[meter] ?? 0) + costUsd;
        }
        let day = cursor;
        while (day <= rangeEnd) {
            const value = daily.get(day) ?? { total: 0, items: {} };
            await upsertDay(day, value.total, value.items);
            days += 1;
            totalCost += value.total;
            day = addDays(day, 1);
        }
        cursor = addDays(rangeEnd, 1);
    }
    await setState(`expenses:${PROVIDER}:last_day`, endDay);
    return { days, totalCost };
}
