import { ensure, rows, stateUpdatedAt } from "../db.js";
import { syncAzureExpenses } from "./azure.js";
import { syncFireworksExpenses } from "./fireworks.js";
import { syncOpenAIExpenses, type ExpenseSyncResult } from "./openai.js";

export { syncAzureExpenses, syncFireworksExpenses, syncOpenAIExpenses };

export async function syncAllExpenses(): Promise<{
    openai: ExpenseSyncResult;
    azure: ExpenseSyncResult;
    fireworks: ExpenseSyncResult;
}> {
    const results = await Promise.allSettled([
        syncOpenAIExpenses(),
        syncAzureExpenses(),
        syncFireworksExpenses(),
    ]);
    const providers = ["openai", "azure", "fireworks"] as const;
    const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [{ provider: providers[index], reason: result.reason }]
        : []);
    if (failures.length > 0) {
        for (const failure of failures) console.error(`[expenses:${failure.provider}]`, failure.reason);
        throw new AggregateError(
            failures.map((failure) => failure.reason),
            `Expense sync failed for: ${failures.map((failure) => failure.provider).join(", ")}`,
        );
    }
    const value = (index: number): ExpenseSyncResult => {
        const result = results[index];
        if (!result || result.status !== "fulfilled") throw new Error(`Missing ${providers[index]} expense result`);
        return result.value;
    };
    return {
        openai: value(0),
        azure: value(1),
        fireworks: value(2),
    };
}

export async function volumeTotals(): Promise<{ total: string; daily: string; updatedAt?: string }> {
    await ensure();
    const [payments, expenses, updatedAt] = await Promise.all([
        rows<{ total_atomic: string; daily_atomic: string }>(`
            SELECT
                COALESCE(sum(amount_atomic), 0)::text AS total_atomic,
                COALESCE(sum(CASE WHEN settled_at >= date_trunc('day', now()) THEN amount_atomic ELSE 0 END), 0)::text AS daily_atomic
             FROM logical_settlements
             WHERE status = 'settled'
        `),
        rows<{ total: string; daily: string }>(`
            SELECT
                COALESCE(sum(cost_usd), 0)::text AS total,
                COALESCE(sum(CASE WHEN day = CURRENT_DATE THEN cost_usd ELSE 0 END), 0)::text AS daily
             FROM expenses
        `),
        stateUpdatedAt("logical-settlements"),
    ]);
    const paymentTotal = Number(payments[0]?.total_atomic ?? "0") / 1e6;
    const paymentDaily = Number(payments[0]?.daily_atomic ?? "0") / 1e6;
    const expenseTotal = Number(expenses[0]?.total ?? "0");
    const expenseDaily = Number(expenses[0]?.daily ?? "0");
    return {
        total: (paymentTotal + expenseTotal).toFixed(6),
        daily: (paymentDaily + expenseDaily).toFixed(6),
        updatedAt,
    };
}
