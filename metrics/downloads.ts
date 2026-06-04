import { ensure, rows, setState, sql, stateUpdatedAt } from "./db.js";

export const SDK_PACKAGE = "@compose-market/sdk";

type Fetch = typeof fetch;

interface NpmPackage {
    time?: {
        created?: string;
    };
}

interface NpmDownloads {
    downloads?: Array<{
        day?: string;
        downloads?: number;
    }>;
}

export interface DownloadSyncOptions {
    force?: boolean;
    fetcher?: Fetch;
}

const DAY_MS = 86_400_000;

function day(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function addDays(value: string, count: number): string {
    return day(new Date(Date.parse(`${value}T00:00:00.000Z`) + count * DAY_MS));
}

function minDay(a: string, b: string): string {
    return a <= b ? a : b;
}

function yesterday(): string {
    return day(new Date(Date.now() - DAY_MS));
}

function npmPackagePath(): string {
    return encodeURIComponent(SDK_PACKAGE);
}

async function json<T>(fetcher: Fetch, url: string): Promise<T> {
    const response = await fetcher(url, {
        headers: { "User-Agent": "compose-market-metrics" },
        signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`npm metrics request failed ${response.status}: ${body.slice(0, 240)}`);
    }
    return await response.json() as T;
}

async function packageCreated(fetcher: Fetch): Promise<string> {
    const metadata = await json<NpmPackage>(fetcher, `https://registry.npmjs.org/${npmPackagePath()}`);
    const created = metadata.time?.created;
    if (!created) {
        throw new Error(`npm metadata missing created time for ${SDK_PACKAGE}`);
    }
    return day(new Date(created));
}

async function lastDownloadedDay(): Promise<string | undefined> {
    await ensure();
    const result = await rows<{ day?: string }>(
        `SELECT to_char(max(day), 'YYYY-MM-DD') AS day
         FROM downloads
         WHERE package = $1`,
        [SDK_PACKAGE],
    );
    return result[0]?.day;
}

async function upsert(rows: Array<{ day: string; downloads: number }>): Promise<void> {
    if (rows.length === 0) return;
    await ensure();

    const values: string[] = [];
    const params: unknown[] = [];
    rows.forEach((row, index) => {
        const base = index * 3;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
        params.push(SDK_PACKAGE, row.day, row.downloads);
    });

    await sql().query(
        `INSERT INTO downloads (package, day, downloads)
         VALUES ${values.join(", ")}
         ON CONFLICT (package, day) DO UPDATE SET
           downloads = EXCLUDED.downloads,
           updated_at = now()`,
        params,
    );
}

async function fetchRange(fetcher: Fetch, from: string, to: string): Promise<Array<{ day: string; downloads: number }>> {
    const data = await json<NpmDownloads>(
        fetcher,
        `https://api.npmjs.org/downloads/range/${from}:${to}/${npmPackagePath()}`,
    );
    return (data.downloads ?? [])
        .map((item) => ({
            day: item.day || "",
            downloads: Number.isInteger(item.downloads) && item.downloads! >= 0 ? item.downloads! : 0,
        }))
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.day));
}

export async function syncDownloads(options: DownloadSyncOptions = {}): Promise<{ rows: number; from?: string; to?: string }> {
    const fetcher = options.fetcher ?? fetch;
    const end = yesterday();
    const created = await packageCreated(fetcher);
    const last = options.force ? undefined : await lastDownloadedDay();
    let cursor = last ? addDays(last, 1) : created;

    if (cursor > end) {
        await setState("downloads", end);
        return { rows: 0, from: cursor, to: end };
    }

    let total = 0;
    const first = cursor;
    while (cursor <= end) {
        const rangeEnd = minDay(addDays(cursor, 364), end);
        const rows = await fetchRange(fetcher, cursor, rangeEnd);
        await upsert(rows);
        total += rows.length;
        cursor = addDays(rangeEnd, 1);
    }

    await setState("downloads", end);
    return { rows: total, from: first, to: end };
}

export async function totalDownloads(): Promise<{ total: number; daily: number; updatedAt?: string }> {
    await ensure();
    const [result, daily] = await Promise.all([
        rows<{ total?: string | number }>(
            `SELECT COALESCE(sum(downloads), 0) AS total
             FROM downloads
             WHERE package = $1`,
            [SDK_PACKAGE],
        ),
        rows<{ downloads?: string | number }>(
            `SELECT downloads
             FROM downloads
             WHERE package = $1
             ORDER BY day DESC
             LIMIT 1`,
            [SDK_PACKAGE],
        ),
    ]);
    return {
        total: Number(result[0]?.total ?? 0),
        daily: Number(daily[0]?.downloads ?? 0),
        updatedAt: await stateUpdatedAt("downloads"),
    };
}

export const downloadsDay = {
    add: addDays,
    yesterday,
};
