export type AgentMetricSource = "cloudflare-d1";

export interface MetricsSnapshot {
    updatedAt: string;
    totals: {
        downloads: number;
        agents: number;
        payments: {
            transactions: number;
            amountAtomic: string;
            amountUsdc: string;
        };
        sessions: number;
    };
    daily: {
        downloads: number;
        agents: number;
        payments: {
            transactions: number;
            amountAtomic: string;
            amountUsdc: string;
        };
        sessions: number;
    };
    sources: {
        downloads: {
            source: "npm";
            package: string;
            updatedAt?: string;
        };
        agents: {
            source: AgentMetricSource;
            updatedAt?: string;
        };
        payments: {
            source: "canonical-x402-receipts";
            cutoff?: string;
            updatedAt?: string;
        };
        sessions: {
            source: "x402-sessions";
            updatedAt?: string;
        };
    };
}

export interface MetricTotals {
    downloads: {
        total: number;
        daily: number;
        updatedAt?: string;
    };
    agents: {
        total: number;
        daily: number;
        source: AgentMetricSource;
        updatedAt?: string;
    };
    payments: {
        transactions: number;
        amountAtomic: string;
        dailyTransactions: number;
        dailyAmountAtomic: string;
        cutoff?: string;
        updatedAt?: string;
    };
    sessions: {
        total: number;
        daily: number;
        updatedAt?: string;
    };
}
