import { getRedisClient } from "../x402/keys/redis.js";
import { loadMetricsConfig } from "./config.js";
import { refreshDownloadMetrics } from "./downloads.js";
import {
    assertFujiRpc,
    createMetricsPublicClient,
    refreshConfiguredAgentFactories,
    runMetricsBackfill,
} from "./onchain.js";
import { readMetricsSnapshot } from "./redis.js";

let watchStarted = false;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason || new Error("aborted"));
            return;
        }
        const timeout = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(signal.reason || new Error("aborted"));
        }, { once: true });
    });
}

export async function getMetricsSnapshot(options: { refresh?: boolean } = {}) {
    const config = loadMetricsConfig();
    if (options.refresh) {
        const client = createMetricsPublicClient(config);
        await Promise.all([
            assertFujiRpc(client, config).then(() => refreshConfiguredAgentFactories(client, config)),
            refreshDownloadMetrics({ force: true, config }),
        ]);
    }
    return readMetricsSnapshot(config);
}

export async function getMetricsHealth() {
    const config = loadMetricsConfig();
    const client = createMetricsPublicClient(config);
    const redis = await getRedisClient();
    const [chainId, blockNumber, redisPing] = await Promise.all([
        client.getChainId(),
        client.getBlockNumber(),
        redis.ping(),
    ]);
    return {
        ok: chainId === config.chainId && redisPing === "PONG",
        dataset: config.dataset,
        chainId,
        blockNumber: blockNumber.toString(),
        redis: redisPing,
        warnings: config.warnings,
    };
}

export async function runMetricsWatch(options: {
    signal?: AbortSignal;
    maxRangesPerTick?: number;
} = {}): Promise<void> {
    const config = loadMetricsConfig();
    console.log(`[metrics] watch started dataset=${config.dataset} intervalMs=${config.pollIntervalMs}`);
    while (!options.signal?.aborted) {
        try {
            const summary = await runMetricsBackfill({
                maxRanges: options.maxRangesPerTick
                    ?? Number.parseInt(process.env.METRICS_WATCH_MAX_RANGES || "50", 10),
                skipDeploymentDiscovery: process.env.METRICS_WATCH_DEPLOYMENT_DISCOVERY !== "true",
            });
            await refreshDownloadMetrics({ config }).catch((error) => {
                console.error("[metrics] downloads refresh failed:", error);
            });
            console.log("[metrics] watch tick", JSON.stringify({
                receiptCursor: summary.receiptCursor,
                deploymentCursor: summary.deploymentCursor,
                transferLogsProcessed: summary.transferLogsProcessed,
                deploymentsDiscovered: summary.deploymentsDiscovered,
            }));
        } catch (error) {
            console.error("[metrics] watch tick failed:", error);
        }
        await sleep(config.pollIntervalMs, options.signal).catch(() => undefined);
    }
}

export function startMetricsWatchService(): void {
    if (watchStarted || process.env.METRICS_WATCH_ENABLED !== "true") {
        return;
    }
    watchStarted = true;
    void runMetricsWatch().catch((error) => {
        watchStarted = false;
        console.error("[metrics] watch service stopped:", error);
    });
}
