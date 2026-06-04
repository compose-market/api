import { getState, setState, stateUpdatedAt } from "./db.js";
import { formatUsdcAtomic, normalizeAtomic } from "./format.js";
import type { MetricsSnapshot } from "./types.js";

const key = "snapshot";

function parse(value: string | undefined): MetricsSnapshot | undefined {
    if (!value) return undefined;
    try {
        const snapshot = JSON.parse(value) as MetricsSnapshot;
        if (!snapshot?.totals || !snapshot.daily || typeof snapshot.updatedAt !== "string") {
            return undefined;
        }
        return snapshot;
    } catch {
        return undefined;
    }
}

export async function readSnapshot(): Promise<MetricsSnapshot | undefined> {
    return parse(await getState(key));
}

export async function writeSnapshot(snapshot: MetricsSnapshot): Promise<MetricsSnapshot> {
    await setState(key, JSON.stringify(snapshot));
    return snapshot;
}

export async function snapshotUpdatedAt(): Promise<string | undefined> {
    return stateUpdatedAt(key);
}

export async function bumpPaymentSnapshot(amountAtomic: string | number | bigint): Promise<void> {
    const snapshot = await readSnapshot();
    if (!snapshot) return;

    const nextAmount = (BigInt(snapshot.totals.payments.amountAtomic || "0") + BigInt(normalizeAtomic(amountAtomic))).toString();
    const now = new Date().toISOString();
    snapshot.updatedAt = now;
    snapshot.totals.payments.transactions += 1;
    snapshot.totals.payments.amountAtomic = nextAmount;
    snapshot.totals.payments.amountUsdc = formatUsdcAtomic(nextAmount);
    snapshot.daily.payments.transactions += 1;
    snapshot.daily.payments.amountAtomic = (BigInt(snapshot.daily.payments.amountAtomic || "0") + BigInt(normalizeAtomic(amountAtomic))).toString();
    snapshot.daily.payments.amountUsdc = formatUsdcAtomic(snapshot.daily.payments.amountAtomic);
    snapshot.sources.payments.updatedAt = now;
    await writeSnapshot(snapshot);
}

export async function bumpSessionSnapshot(): Promise<void> {
    const snapshot = await readSnapshot();
    if (!snapshot) return;

    const now = new Date().toISOString();
    snapshot.updatedAt = now;
    snapshot.totals.sessions += 1;
    snapshot.daily.sessions += 1;
    snapshot.sources.sessions.updatedAt = now;
    await writeSnapshot(snapshot);
}
