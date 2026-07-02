import "dotenv/config";

import { syncDownloads } from "./downloads.js";
import { syncPayments } from "./payments.js";
import { setSessionBaseline, syncSessionsFromValkey } from "./sessions.js";
import { getMetricsSnapshot, refreshMetricsSnapshot } from "./snapshot.js";
import { syncAllExpenses, syncOpenAIExpenses, syncAzureExpenses, syncFireworksExpenses, volumeTotals } from "./expenses/index.js";

async function syncAll(): Promise<void> {
    const downloads = await syncDownloads();
    const sessions = await syncSessionsFromValkey();
    const payments = await syncPayments();
    const expenses = await syncAllExpenses();
    const snapshot = await refreshMetricsSnapshot();
    console.log(JSON.stringify({ downloads, sessions, payments, expenses, snapshot }, null, 2));
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
            console.log(JSON.stringify({ sessions: await syncSessionsFromValkey(), snapshot: await refreshMetricsSnapshot() }, null, 2));
            break;
        case "sessions-baseline": {
            const total = Number.parseInt(process.argv[3] ?? "", 10);
            console.log(JSON.stringify({ baseline: await setSessionBaseline(total), snapshot: await refreshMetricsSnapshot() }, null, 2));
            break;
        }
        case "expenses":
            console.log(JSON.stringify({ expenses: await syncAllExpenses(), snapshot: await refreshMetricsSnapshot() }, null, 2));
            break;
        case "expenses-openai":
            console.log(JSON.stringify({ openai: await syncOpenAIExpenses() }, null, 2));
            break;
        case "expenses-azure":
            console.log(JSON.stringify({ azure: await syncAzureExpenses() }, null, 2));
            break;
        case "expenses-fireworks":
            console.log(JSON.stringify({ fireworks: await syncFireworksExpenses() }, null, 2));
            break;
        case "volume":
            console.log(JSON.stringify(await volumeTotals(), null, 2));
            break;
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
