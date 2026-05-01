import { loadMetricsConfig, type MetricsConfig } from "./config.js";
import { recordDownloadsSnapshotMetric, readDownloadsSnapshot } from "./redis.js";
import type { MetricsDownloadsSnapshot } from "./types.js";

interface NpmDownloadPoint {
    downloads?: number;
}

interface GitHubAsset {
    name?: string;
    download_count?: number;
}

interface GitHubRelease {
    tag_name?: string;
    assets?: GitHubAsset[];
}

interface GitHubTrafficSummary {
    count?: number;
    uniques?: number;
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
        ...init,
        headers: {
            Accept: "application/json",
            "User-Agent": "compose-market-metrics",
            ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
}

async function fetchNpmDownloads(packageName: string, period: "last-day" | "last-week" | "last-month" | "last-year"): Promise<number> {
    const encoded = encodeURIComponent(packageName);
    const body = await fetchJson<NpmDownloadPoint>(`https://api.npmjs.org/downloads/point/${period}/${encoded}`);
    return Number.isFinite(body.downloads) ? Number(body.downloads) : 0;
}

async function fetchGitHubJson<T>(path: string, config: MetricsConfig): Promise<T> {
    const headers: Record<string, string> = {
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (config.githubToken) {
        headers.Authorization = `Bearer ${config.githubToken}`;
    }
    return fetchJson<T>(`https://api.github.com${path}`, { headers });
}

async function fetchMeshReleaseDownloads(config: MetricsConfig): Promise<{
    releases: number;
    total: number;
    assets: MetricsDownloadsSnapshot["mesh"]["assets"];
}> {
    let page = 1;
    let releases = 0;
    const assets: MetricsDownloadsSnapshot["mesh"]["assets"] = [];

    while (true) {
        const rows = await fetchGitHubJson<GitHubRelease[]>(
            `/repos/${config.meshRepoOwner}/${config.meshRepoName}/releases?per_page=100&page=${page}`,
            config,
        );
        if (rows.length === 0) break;
        releases += rows.length;
        for (const release of rows) {
            for (const asset of release.assets || []) {
                assets.push({
                    name: asset.name || "unnamed",
                    downloadCount: Number.isFinite(asset.download_count) ? Number(asset.download_count) : 0,
                    ...(release.tag_name ? { releaseTag: release.tag_name } : {}),
                });
            }
        }
        if (rows.length < 100) break;
        page++;
    }

    return {
        releases,
        total: assets.reduce((sum, asset) => sum + asset.downloadCount, 0),
        assets: assets
            .sort((a, b) => b.downloadCount - a.downloadCount)
            .slice(0, 50),
    };
}

async function fetchTraffic(config: MetricsConfig): Promise<Partial<MetricsDownloadsSnapshot["mesh"]>> {
    if (!config.githubToken) {
        return {};
    }
    const [clones, views] = await Promise.all([
        fetchGitHubJson<GitHubTrafficSummary>(
            `/repos/${config.meshRepoOwner}/${config.meshRepoName}/traffic/clones`,
            config,
        ),
        fetchGitHubJson<GitHubTrafficSummary>(
            `/repos/${config.meshRepoOwner}/${config.meshRepoName}/traffic/views`,
            config,
        ),
    ]);
    return {
        clonesLast14Days: Number.isFinite(clones.count) ? Number(clones.count) : 0,
        uniqueClonersLast14Days: Number.isFinite(clones.uniques) ? Number(clones.uniques) : 0,
        viewsLast14Days: Number.isFinite(views.count) ? Number(views.count) : 0,
        uniqueViewersLast14Days: Number.isFinite(views.uniques) ? Number(views.uniques) : 0,
    };
}

export async function refreshDownloadMetrics(options: {
    force?: boolean;
    config?: MetricsConfig;
} = {}): Promise<MetricsDownloadsSnapshot> {
    const config = options.config || loadMetricsConfig();
    const cached = await readDownloadsSnapshot(config);
    const cachedAt = Math.max(cached.sdk.updatedAt || 0, cached.mesh.updatedAt || 0);
    if (!options.force && cachedAt && Date.now() - cachedAt < config.downloadsRefreshMs) {
        return cached;
    }

    const warnings: string[] = [];
    const now = Date.now();
    const [lastDay, lastWeek, lastMonth, lastYear] = await Promise.all([
        fetchNpmDownloads(config.sdkPackageName, "last-day"),
        fetchNpmDownloads(config.sdkPackageName, "last-week"),
        fetchNpmDownloads(config.sdkPackageName, "last-month"),
        fetchNpmDownloads(config.sdkPackageName, "last-year"),
    ]);

    const releaseDownloads = await fetchMeshReleaseDownloads(config);
    let traffic: Partial<MetricsDownloadsSnapshot["mesh"]> = {};
    try {
        traffic = await fetchTraffic(config);
        if (!config.githubToken) {
            warnings.push("GitHub clone/view traffic requires METRICS_GITHUB_TOKEN or GITHUB_TOKEN; release asset downloads are still public.");
        }
    } catch (error) {
        warnings.push(`GitHub clone/view traffic unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const snapshot: MetricsDownloadsSnapshot = {
        totalObserved: lastMonth + releaseDownloads.total,
        sdk: {
            packageName: config.sdkPackageName,
            downloads: {
                lastDay,
                lastWeek,
                lastMonth,
                lastYear,
            },
            source: "npm",
            updatedAt: now,
        },
        mesh: {
            repository: `${config.meshRepoOwner}/${config.meshRepoName}`,
            releaseAssetDownloads: releaseDownloads.total,
            releases: releaseDownloads.releases,
            assets: releaseDownloads.assets,
            ...traffic,
            source: "github",
            updatedAt: now,
        },
        warnings,
    };
    await recordDownloadsSnapshotMetric(snapshot, config);
    return snapshot;
}
