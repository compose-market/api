import { countAgents, countAgentsToday } from "../agents.js";
import { totalDownloads, SDK_PACKAGE } from "./downloads.js";
import { formatUsdcAtomic } from "./format.js";
import { paymentTotals } from "./payments.js";
import { sessionTotals } from "./sessions.js";
import { readSnapshot, writeSnapshot } from "./cache.js";
import type { MetricTotals, MetricsSnapshot } from "./types.js";

function latest(values: Array<string | undefined>): string {
    const times = values
        .map((value) => value ? Date.parse(value) : NaN)
        .filter((value) => Number.isFinite(value));
    if (times.length === 0) {
        return new Date().toISOString();
    }
    return new Date(Math.max(...times)).toISOString();
}

export function buildSnapshot(input: MetricTotals): MetricsSnapshot {
    const amountAtomic = input.payments.amountAtomic || "0";
    return {
        updatedAt: latest([
            input.downloads.updatedAt,
            input.agents.updatedAt,
            input.payments.updatedAt,
            input.sessions.updatedAt,
        ]),
        totals: {
            downloads: input.downloads.total,
            agents: input.agents.total,
            payments: {
                transactions: input.payments.transactions,
                amountAtomic,
                amountUsdc: formatUsdcAtomic(amountAtomic),
            },
            sessions: input.sessions.total,
        },
        daily: {
            downloads: input.downloads.daily,
            agents: input.agents.daily,
            payments: {
                transactions: input.payments.dailyTransactions,
                amountAtomic: input.payments.dailyAmountAtomic,
                amountUsdc: formatUsdcAtomic(input.payments.dailyAmountAtomic),
            },
            sessions: input.sessions.daily,
        },
        sources: {
            downloads: {
                source: "npm",
                package: SDK_PACKAGE,
                updatedAt: input.downloads.updatedAt,
            },
            agents: {
                source: input.agents.source,
                updatedAt: input.agents.updatedAt,
            },
            payments: {
                source: "merchant-wallet-settlements",
                cutoff: input.payments.cutoff,
                updatedAt: input.payments.updatedAt,
            },
            sessions: {
                source: "x402-sessions",
                updatedAt: input.sessions.updatedAt,
            },
        },
    };
}

export async function refreshMetricsSnapshot(): Promise<MetricsSnapshot> {
    const [downloads, agents, agentsDaily, payments, sessions] = await Promise.all([
        totalDownloads(),
        countAgents(),
        countAgentsToday(),
        paymentTotals(),
        sessionTotals(),
    ]);

    return writeSnapshot(buildSnapshot({
        downloads,
        agents: {
            ...agents,
            daily: agentsDaily,
        },
        payments,
        sessions,
    }));
}

export async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
    return await readSnapshot() ?? await refreshMetricsSnapshot();
}
