import "dotenv/config";

import { syncDownloads } from "./downloads.js";
import { syncPayments } from "./payments.js";
import { setSessionBaseline, syncSessionsFromRedis } from "./sessions.js";
import { getMetricsSnapshot, refreshMetricsSnapshot } from "./snapshot.js";

async function syncAll(): Promise<void> {
    const downloads = await syncDownloads();
    const sessions = await syncSessionsFromRedis();
    const payments = await syncPayments();
    const snapshot = await refreshMetricsSnapshot();
    console.log(JSON.stringify({ downloads, sessions, payments, snapshot }, null, 2));
}

async function main(): Promise<void> {
    const command = process.argv[2] || "snapshot";

    switch (command) {
        case "snapshot":
            console.log(JSON.stringify(
                process.argv.includes("--refresh") ? await refreshMetricsSnapshot() : await getMetricsSnapshot(),
                null,
                2,
            ));
            break;
        case "sync":
            await syncAll();
            break;
        case "downloads":
            console.log(JSON.stringify(await syncDownloads({ force: process.argv.includes("--force") }), null, 2));
            break;
        case "payments":
            console.log(JSON.stringify({ payments: await syncPayments(), snapshot: await refreshMetricsSnapshot() }, null, 2));
            break;
        case "sessions":
            console.log(JSON.stringify({ sessions: await syncSessionsFromRedis(), snapshot: await refreshMetricsSnapshot() }, null, 2));
            break;
        case "sessions-baseline": {
            const total = Number.parseInt(process.argv[3] ?? "", 10);
            console.log(JSON.stringify({ baseline: await setSessionBaseline(total), snapshot: await refreshMetricsSnapshot() }, null, 2));
            break;
        }
        default:
            throw new Error(`Unknown metrics command: ${command}`);
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
