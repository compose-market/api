import type { Receipt } from "../../http/request-context.js";
import { getValkeyClient } from "../../x402/keys/valkey.js";
import { ensure, rows, setState, stateUpdatedAt } from "./db.js";
import { formatUsdcAtomic, normalizeAtomic } from "./format.js";

const RECEIPT_PATTERN = "x402:receipt:rct_*";
const SCAN_COUNT = 100;
const UPSERT_SIZE = 100;

type SettlementStatus = NonNullable<Receipt["settlementStatus"]>;

export interface LogicalSettlement {
    receiptId: string;
    network: string;
    status: SettlementStatus;
    amountAtomic: string;
    settledAt?: Date;
    transactionHash?: string;
    paymentIntentId?: string;
    paymentChannelId?: string;
}

function timestamp(value: number | undefined): Date | undefined {
    if (!Number.isFinite(value)) return undefined;
    const date = new Date(value!);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

async function retryValkey<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
    throw lastError;
}

export function logicalSettlementFromReceipt(receipt: Receipt): LogicalSettlement | null {
    if (!receipt.id || !receipt.network || !receipt.settlementStatus) return null;
    const settledAt = timestamp(receipt.settledAt);
    if (receipt.settlementStatus === "settled" && !settledAt) return null;
    return {
        receiptId: receipt.id,
        network: receipt.network,
        status: receipt.settlementStatus,
        amountAtomic: normalizeAtomic(receipt.finalAmountWei),
        settledAt,
        transactionHash: receipt.txHash || receipt.settleTxHash,
        paymentIntentId: receipt.paymentIntentId,
        paymentChannelId: receipt.paymentChannelId,
    };
}

async function upsertSettlements(settlements: LogicalSettlement[]): Promise<number> {
    if (settlements.length === 0) return 0;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const [index, settlement] of settlements.entries()) {
        const offset = index * 8;
        values.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4}::numeric,$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8})`);
        params.push(
            settlement.receiptId,
            settlement.network,
            settlement.status,
            settlement.amountAtomic,
            settlement.settledAt?.toISOString() ?? null,
            settlement.transactionHash ?? null,
            settlement.paymentIntentId ?? null,
            settlement.paymentChannelId ?? null,
        );
    }
    const result = await rows<{ receipt_id: string }>(`
        INSERT INTO logical_settlements (
            receipt_id, network, status, amount_atomic, settled_at,
            transaction_hash, payment_intent_id, payment_channel_id
        ) VALUES ${values.join(",")}
        ON CONFLICT (receipt_id) DO UPDATE SET
            status = CASE
                WHEN logical_settlements.status = 'settled' THEN 'settled'
                WHEN EXCLUDED.status = 'settled' THEN 'settled'
                WHEN logical_settlements.status = 'failed' THEN 'failed'
                WHEN logical_settlements.status = 'submitted' AND EXCLUDED.status IN ('queued', 'claimed') THEN 'submitted'
                ELSE EXCLUDED.status
            END,
            settled_at = COALESCE(logical_settlements.settled_at, EXCLUDED.settled_at),
            transaction_hash = COALESCE(logical_settlements.transaction_hash, EXCLUDED.transaction_hash),
            payment_intent_id = COALESCE(logical_settlements.payment_intent_id, EXCLUDED.payment_intent_id),
            payment_channel_id = COALESCE(logical_settlements.payment_channel_id, EXCLUDED.payment_channel_id),
            updated_at = now()
        RETURNING receipt_id
    `, params);
    return result.length;
}

export async function syncLogicalSettlements(): Promise<{
    scanned: number;
    projected: number;
    settled: number;
}> {
    await ensure();
    const valkey = await getValkeyClient();
    let cursor = "0";
    let scanned = 0;
    let projected = 0;
    let settled = 0;
    do {
        const [nextCursor, rawKeys] = await retryValkey(
            () => valkey.scan(cursor, "MATCH", RECEIPT_PATTERN, "COUNT", SCAN_COUNT),
        );
        cursor = nextCursor;
        const keys = rawKeys.map(String);
        scanned += keys.length;
        if (keys.length === 0) continue;
        const encoded = await retryValkey(() => valkey.mget(...keys));
        const settlements = encoded.flatMap((raw) => {
            if (!raw) return [];
            try {
                const settlement = logicalSettlementFromReceipt(JSON.parse(String(raw)) as Receipt);
                return settlement ? [settlement] : [];
            } catch {
                return [];
            }
        });
        settled += settlements.filter((settlement) => settlement.status === "settled").length;
        for (let start = 0; start < settlements.length; start += UPSERT_SIZE) {
            projected += await upsertSettlements(settlements.slice(start, start + UPSERT_SIZE));
        }
    } while (cursor !== "0");
    await setState("logical-settlements", new Date().toISOString());
    return { scanned, projected, settled };
}

export async function settlementTotals(): Promise<{
    transactions: number;
    amountAtomic: string;
    amountUsdc: string;
    dailyTransactions: number;
    dailyAmountAtomic: string;
    updatedAt?: string;
}> {
    await ensure();
    const [total, daily] = await Promise.all([
        rows<{ transactions?: string | number; amount_atomic?: string }>(`
            SELECT count(*) AS transactions,
                   COALESCE(sum(amount_atomic), 0)::text AS amount_atomic
            FROM logical_settlements
            WHERE status = 'settled'
        `),
        rows<{ transactions?: string | number; amount_atomic?: string }>(`
            SELECT count(*) AS transactions,
                   COALESCE(sum(amount_atomic), 0)::text AS amount_atomic
            FROM logical_settlements
            WHERE status = 'settled'
              AND settled_at >= date_trunc('day', now())
        `),
    ]);
    const amountAtomic = total[0]?.amount_atomic ?? "0";
    return {
        transactions: Number(total[0]?.transactions ?? 0),
        amountAtomic,
        amountUsdc: formatUsdcAtomic(amountAtomic),
        dailyTransactions: Number(daily[0]?.transactions ?? 0),
        dailyAmountAtomic: daily[0]?.amount_atomic ?? "0",
        updatedAt: await stateUpdatedAt("logical-settlements"),
    };
}
