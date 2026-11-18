import { cacheDel } from "../../cache.js";
import { totalDownloads, SDK_PACKAGE } from "./downloads.js";
import { formatUsdcAtomic } from "./format.js";
import { settlementTotals } from "./settlements.js";
import { sessionTotals } from "./sessions.js";
import { readSnapshot, writeSnapshot } from "./cache.js";
import type { MetricTotals, MetricsSnapshot } from "./types.js";

interface AgentCounts {
    total: number;
    daily: number;
    source: "cloudflare-d1";
    updatedAt?: string;
}

function agentsUrl(): string {
    return (process.env.AGENTS_URL || "https://agents.compose.market").replace(/\/+$/, "");
}

async function agentCounts(): Promise<AgentCounts> {
    const response = await fetch(`${agentsUrl()}/counts`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
    });
    const body = await response.json().catch(() => ({})) as Partial<AgentCounts> & { error?: unknown };
    if (!response.ok) {
        const message = typeof body.error === "string" ? body.error : `status ${response.status}`;
        throw new Error(`agents worker counts failed: ${message}`);
    }
    return {
        total: Number(body.total ?? 0),
        daily: Number(body.daily ?? 0),
        source: "cloudflare-d1",
        updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : undefined,
    };
}

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
                source: "canonical-x402-receipts",
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
    const [downloads, agents, payments, sessions] = await Promise.all([
        totalDownloads(),
        agentCounts(),
        settlementTotals(),
        sessionTotals(),
    ]);

    await cacheDel("metrics:volume");
    return writeSnapshot(buildSnapshot({
        downloads,
        agents,
        payments,
        sessions,
    }));
}

export async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
    return await readSnapshot() ?? await refreshMetricsSnapshot();
}
