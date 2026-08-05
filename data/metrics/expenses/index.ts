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
    const empty = (): ExpenseSyncResult => ({ days: 0, totalCost: 0 });
    const openai = results[0].status === "fulfilled" ? results[0].value : empty();
    const azure = results[1].status === "fulfilled" ? results[1].value : empty();
    const fireworks = results[2].status === "fulfilled" ? results[2].value : empty();
    if (results[0].status === "rejected") console.error("[expenses:openai]", results[0].reason);
    if (results[1].status === "rejected") console.error("[expenses:azure]", results[1].reason);
    if (results[2].status === "rejected") console.error("[expenses:fireworks]", results[2].reason);
    return { openai, azure, fireworks };
}

export async function volumeTotals(): Promise<{ total: string; daily: string; updatedAt?: string }> {
    await ensure();
    const [payments, expenses, updatedAt] = await Promise.all([
        rows<{ total_atomic: string; daily_atomic: string }>(`
            SELECT
                COALESCE(sum(amount_atomic), 0)::text AS total_atomic,
                COALESCE(sum(CASE WHEN settled_at >= date_trunc('day', now()) THEN amount_atomic ELSE 0 END), 0)::text AS daily_atomic
             FROM payments
        `),
        rows<{ total: string; daily: string }>(`
            SELECT
                COALESCE(sum(cost_usd), 0)::text AS total,
                COALESCE(sum(CASE WHEN day = CURRENT_DATE THEN cost_usd ELSE 0 END), 0)::text AS daily
             FROM expenses
        `),
        stateUpdatedAt("payments"),
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
