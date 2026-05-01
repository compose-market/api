import "dotenv/config";

import { closeRedis } from "../x402/keys/redis.js";
import { getMetricsSnapshot, runMetricsWatch } from "./service.js";
import { runMetricsBackfill } from "./onchain.js";

function readArg(name: string): string | undefined {
    const prefix = `--${name}=`;
    const directIndex = process.argv.indexOf(`--${name}`);
    if (directIndex !== -1) return process.argv[directIndex + 1];
    const inline = process.argv.find((arg) => arg.startsWith(prefix));
    return inline ? inline.slice(prefix.length) : undefined;
}

function readPositiveIntArg(name: string): number | undefined {
    const value = readArg(name);
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
}

async function main(): Promise<void> {
    const command = process.argv[2] || "snapshot";
    switch (command) {
        case "snapshot": {
            const refresh = !process.argv.includes("--no-refresh");
            console.log(JSON.stringify(await getMetricsSnapshot({ refresh }), null, 2));
            await closeRedis();
            return;
        }
        case "backfill": {
            const summary = await runMetricsBackfill({
                fromDate: readArg("from-date"),
                maxRanges: readPositiveIntArg("max-ranges"),
                skipDeploymentDiscovery: process.argv.includes("--fast")
                    || process.argv.includes("--skip-deployments"),
            });
            console.log(JSON.stringify(summary, null, 2));
            await closeRedis();
            return;
        }
        case "watch": {
            const controller = new AbortController();
            process.once("SIGINT", () => controller.abort(new Error("SIGINT")));
            process.once("SIGTERM", () => controller.abort(new Error("SIGTERM")));
            await runMetricsWatch({
                signal: controller.signal,
                maxRangesPerTick: readPositiveIntArg("max-ranges"),
            });
            return;
        }
        case "help":
        case "--help":
        case "-h":
            console.log([
                "Usage: tsx metrics/cli.ts <snapshot|backfill|watch>",
                "  snapshot [--no-refresh]",
                "  backfill [--from-date 2025-12-01T00:00:00.000Z] [--max-ranges 250] [--fast]",
                "  watch [--max-ranges 50]",
            ].join("\n"));
            return;
        default:
            throw new Error(`Unknown metrics command: ${command}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
