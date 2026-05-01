import { z } from "zod";

const RoutescanEnvelope = z.object({
    status: z.string(),
    message: z.string(),
    result: z.unknown(),
});

const RoutescanLogRow = z.object({
    address: z.string(),
    topics: z.array(z.string()),
    data: z.string(),
    blockNumber: z.string(),
    timeStamp: z.string(),
    transactionHash: z.string(),
    logIndex: z.string().optional(),
});

export type RoutescanLog = z.infer<typeof RoutescanLogRow>;

const PAGE_SIZE = 1000;
const MAX_RETRIES = 3;

async function routescanGet<T>(base: string, params: Record<string, string | number>): Promise<T[]> {
    const searchParams = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const url = `${base}?${searchParams.toString()}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(30_000),
            });
            if (response.status === 429 || response.status >= 500) {
                throw new Error(`Routescan HTTP ${response.status}`);
            }
            if (!response.ok) {
                throw new Error(`Routescan HTTP ${response.status}`);
            }
            const body = RoutescanEnvelope.parse(await response.json());
            if (body.status === "0") {
                if (typeof body.result === "string" && /no records|no transactions/i.test(body.result)) {
                    return [];
                }
                throw new Error(`Routescan ${body.message}: ${JSON.stringify(body.result).slice(0, 200)}`);
            }
            if (!Array.isArray(body.result)) {
                throw new Error(`Routescan unexpected result shape: ${typeof body.result}`);
            }
            return body.result as T[];
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Routescan request failed");
}

export function paddedTopicAddress(address: string): `0x${string}` {
    return `0x${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

export function parseRoutescanInteger(value: string): number {
    const radix = value.startsWith("0x") ? 16 : 10;
    const parsed = Number.parseInt(value, radix);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid Routescan integer: ${value}`);
    }
    return parsed;
}

export async function getRoutescanLogs(args: {
    base: string;
    address?: string;
    topic0: string;
    topic1?: string | null;
    topic2?: string | null;
    topic3?: string | null;
    fromBlock: number;
    toBlock: number | "latest";
}): Promise<{ logs: RoutescanLog[]; pages: number }> {
    const logs: RoutescanLog[] = [];
    let pages = 0;
    let cursorFrom = args.fromBlock;
    const finalTo = args.toBlock === "latest" ? 99_999_999 : args.toBlock;

    while (true) {
        let page = 1;
        let pageRowsThisCursor = 0;

        while (true) {
            const params: Record<string, string | number> = {
                module: "logs",
                action: "getLogs",
                fromBlock: cursorFrom,
                toBlock: finalTo,
                topic0: args.topic0,
                page,
                offset: PAGE_SIZE,
            };
            if (args.address) params.address = args.address;
            if (args.topic1) {
                params.topic1 = args.topic1;
                params.topic0_1_opr = "and";
            }
            if (args.topic2) {
                params.topic2 = args.topic2;
                params.topic0_2_opr = "and";
            }
            if (args.topic3) {
                params.topic3 = args.topic3;
                params.topic0_3_opr = "and";
            }

            const rows = await routescanGet<unknown>(args.base, params);
            pages++;
            if (rows.length === 0) {
                if (pageRowsThisCursor < 10_000) return { logs, pages };
                break;
            }

            for (const row of rows) {
                logs.push(RoutescanLogRow.parse(row));
            }
            pageRowsThisCursor += rows.length;
            if (rows.length < PAGE_SIZE) {
                if (pageRowsThisCursor < 10_000) return { logs, pages };
                break;
            }
            page++;
        }

        const lastLog = logs[logs.length - 1];
        if (!lastLog) return { logs, pages };
        cursorFrom = parseRoutescanInteger(lastLog.blockNumber) + 1;
        if (cursorFrom > finalTo) return { logs, pages };
    }
}
