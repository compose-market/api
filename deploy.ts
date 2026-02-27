import "dotenv/config";
import { execSync } from "child_process";
import fs from "fs";

/**
 * Production Deployment Orchestrator
 * Target: GCP Cloud Run & Cloud Run Jobs
 * Build: Source deploy
 */

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
const REGION = "us-east1";
const SERVICE_NAME = "compose-market-api";
const SERVICE_ACCOUNT = `compose-api@${PROJECT_ID}.iam.gserviceaccount.com`;
const GCLOUD_ENV = {
    ...process.env,
    CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
};

if (!PROJECT_ID) {
    console.error("❌ Error: GOOGLE_CLOUD_PROJECT_ID not set in .env");
    process.exit(1);
}

type RunOptions = {
    silent?: boolean;
    allowFailure?: boolean;
    input?: string;
};

function formatExecError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const errWithIO = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    const stderr = errWithIO.stderr ? String(errWithIO.stderr).trim() : "";
    const stdout = errWithIO.stdout ? String(errWithIO.stdout).trim() : "";
    return [error.message, stderr, stdout].filter(Boolean).join("\n");
}

function run(command: string, options: RunOptions = {}): string {
    const { silent = false, allowFailure = false, input } = options;

    if (!silent) console.log(`\n🏃 Executing: ${command}`);
    try {
        return execSync(command, {
            stdio: silent ? "pipe" : "inherit",
            encoding: "utf-8",
            env: GCLOUD_ENV,
            ...(input !== undefined ? { input } : {}),
        }).trim();
    } catch (error) {
        if (allowFailure) return "";
        throw new Error(formatExecError(error));
    }
}

function getOutput(command: string): string {
    return run(command, { silent: true, allowFailure: true });
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvSecrets(): Array<{ key: string; value: string }> {
    const envContent = fs.readFileSync(".env", "utf8");
    const lines = envContent.split("\n");
    const entries = new Map<string, string>();

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if (!key || !value || key.startsWith("VITE_")) continue;

        if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
        } else if (value.startsWith("\"") && value.endsWith("\"")) {
            value = value.slice(1, -1);
        }

        // Keep the last value when duplicate keys exist in .env.
        entries.set(key, value);
    }

    return Array.from(entries.entries()).map(([key, value]) => ({ key, value }));
}

function getAllSecretNames(): string[] {
    return parseEnvSecrets().map((entry) => entry.key);
}

async function syncAllSecrets() {
    console.log("🛡️  Syncing ALL .env variables to GCP Secret Manager...");

    const entries = parseEnvSecrets();
    const secretNames: string[] = [];

    for (const { key, value } of entries) {
        secretNames.push(key);

        const exists = getOutput(`gcloud secrets describe ${key} --project=${PROJECT_ID} 2>/dev/null`);
        if (!exists) {
            console.log(`🆕 Creating secret: ${key}`);
            run(`gcloud secrets create ${key} --replication-policy="automatic" --project=${PROJECT_ID}`);
        }

        const currentRemoteValue = getOutput(
            `gcloud secrets versions access latest --secret=${key} --project=${PROJECT_ID} 2>/dev/null`,
        );
        if (currentRemoteValue === value) {
            console.log(`✅ ${key} is up to date.`);
        } else {
            console.log(`🔄 Updating ${key}...`);
            run(
                `gcloud secrets versions add ${key} --data-file=- --project=${PROJECT_ID}`,
                { silent: true, input: value },
            );
            console.log(`   ↳ Updated ${key}`);
        }
    }

    return secretNames;
}

async function grantSecretAccess(secretNames: string[]) {
    console.log("\n🔐 Granting service account access to secrets...");

    run(
        `gcloud projects add-iam-policy-binding ${PROJECT_ID} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/secretmanager.secretAccessor" 2>/dev/null || true`,
        { silent: true },
    );

    console.log(`   ✅ Granted secretAccessor role for ${secretNames.length} secrets`);
}

async function ensureInfrastructure() {
    console.log("\n👤 Ensuring service account exists...");
    run(
        `gcloud iam service-accounts create compose-api \
      --display-name="Compose API Service Account" \
      --project=${PROJECT_ID} 2>/dev/null || true`,
    );

    console.log("\n🔐 Granting project-level IAM roles...");
    run(
        `gcloud projects add-iam-policy-binding ${PROJECT_ID} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/logging.logWriter" 2>/dev/null || true`,
    );
    run(
        `gcloud projects add-iam-policy-binding ${PROJECT_ID} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/run.invoker" 2>/dev/null || true`,
    );
}

function buildSecretFlags(secrets: string[]): string {
    const unique = Array.from(new Set(secrets));
    return unique.map((secret) => `${secret}=${secret}:latest`).join(",");
}

async function deployService(secrets: string[], includeSecrets: boolean) {
    console.log("\n🚀 Deploying Cloud Run service from source...");
    console.log("   (GCP builds the container automatically)");

    const commandParts = [
        `gcloud run deploy ${SERVICE_NAME}`,
        `--source .`,
        `--region ${REGION}`,
        `--project ${PROJECT_ID}`,
        `--service-account ${SERVICE_ACCOUNT}`,
        `--allow-unauthenticated`,
        `--port 3000`,
        `--cpu 2`,
        `--memory 4Gi`,
        `--min-instances 1`,
        `--max-instances 10`,
        `--timeout 300`,
        `--set-env-vars "NODE_ENV=production"`,
    ];

    if (includeSecrets) {
        const secretFlags = buildSecretFlags(secrets);
        commandParts.push(`--set-secrets "${secretFlags}"`);
    } else {
        console.log("   ⚡ Fast mode: preserving existing service secrets/env bindings");
    }

    commandParts.push("--quiet");

    run(commandParts.join(" \\\n      "));
}

async function deployJobs() {
    console.log("\n⏲️  Deploying Cloud Run Jobs...");

    const jobSecrets = [
        "GOOGLE_CLOUD_PROJECT_ID",
        "VERTEX_PROJECT_ID",
        "CRONOS_TESTNET_CHAIN_ID",
        "DEV_USDC_E_ADDRESS",
        "DISPENSER_CONTRACT",
        "REDIS_TLS",
        "REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT",
        "SERVER_WALLET_KEY",
        "DEPLOYER_KEY",
        "MANOWAR_INTERNAL_SECRET",
        "REDIS_KEYS_API_KEY",
        "REDIS_KEYS_DEFAULT_PASSWORD",
        "REDIS_API_KEY",
    ];
    const secretFlags = buildSecretFlags(jobSecrets);

    const jobs = [
        { name: "compose-market-settlement", task: "batch-settlement", timeout: "600s" },
        { name: "compose-market-expiry", task: "expiry-scan", timeout: "300s" },
    ];

    const image = getOutput(
        `gcloud run services describe ${SERVICE_NAME} \
      --platform managed \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --format="value(template.containers[0].image)"`,
    );

    if (!image) {
        console.error("   ❌ Could not resolve deployed service image");
        return;
    }

    for (const job of jobs) {
        console.log(`\n📦 Deploying job: ${job.name}`);

        run(
            `gcloud run jobs update ${job.name} \
      --image ${image} \
      --tasks 1 \
      --max-retries 0 \
      --task-timeout ${job.timeout} \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --service-account ${SERVICE_ACCOUNT} \
      --set-env-vars "JOB_TASK=${job.task},NODE_ENV=production" \
      --set-secrets "${secretFlags}" \
      --quiet 2>/dev/null || \
      gcloud run jobs create ${job.name} \
      --image ${image} \
      --tasks 1 \
      --max-retries 0 \
      --task-timeout ${job.timeout} \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --service-account ${SERVICE_ACCOUNT} \
      --set-env-vars "JOB_TASK=${job.task},NODE_ENV=production" \
      --set-secrets "${secretFlags}" \
      --quiet`,
        );
    }
}

async function deploy() {
    console.log(`🚀 Starting compose-api deployment to GCP Cloud Run...`);
    console.log(`   Project: ${PROJECT_ID}`);
    console.log(`   Region: ${REGION}`);
    console.log(`   Service: ${SERVICE_NAME}`);

    const args = process.argv.slice(2);
    const fastMode = args.includes("--fast");
    const skipSecrets = fastMode || args.includes("--skip-secrets");
    const skipJobs = fastMode || args.includes("--skip-jobs");

    if (fastMode) {
        console.log("   Mode: FAST (skip secrets + jobs)");
    } else {
        console.log("   Mode: FULL");
    }

    let secrets: string[] = [];
    if (!skipSecrets) {
        secrets = await syncAllSecrets();
        await ensureInfrastructure();
        await grantSecretAccess(secrets);
        console.log("\n⏳ Waiting 30s for IAM propagation...");
        await sleep(30_000);
    }

    await deployService(secrets, !skipSecrets);

    if (!skipJobs) {
        await deployJobs();
    }

    const url = getOutput(
        `gcloud run services describe ${SERVICE_NAME} \
      --platform managed \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --format="value(status.url)"`,
    );

    console.log("\n✅ PRODUCTION DEPLOYMENT COMPLETE!");
    console.log(`🔗 API URL: ${url || "(unavailable)"}`);
}

deploy().catch((err) => {
    console.error("❌ Deployment failed:", err);
    process.exit(1);
});
