import "dotenv/config";
import { execSync } from "child_process";
import fs from "fs";

/**
 * Production Deployment Orchestrator
 * Target: GCP Cloud Run & Cloud Run Jobs
 * Build: Source deploy (no Docker required - same as AWS Lambda!)
 * All environment variables are stored as secrets
 */

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
const REGION = "us-east1";
const SERVICE_NAME = "compose-market-api";
const SERVICE_ACCOUNT = `compose-api@${PROJECT_ID}.iam.gserviceaccount.com`;

if (!PROJECT_ID) {
    console.error("❌ Error: GOOGLE_CLOUD_PROJECT_ID not set in .env");
    process.exit(1);
}

function run(command: string, silent = false): string {
    if (!silent) console.log(`\n🏃 Executing: ${command}`);
    try {
        return execSync(command, { stdio: silent ? "pipe" : "inherit", encoding: "utf-8" }).trim();
    } catch {
        return "";
    }
}

function getOutput(command: string): string {
    try {
        return execSync(command, { stdio: "pipe", encoding: "utf-8" }).toString().trim();
    } catch {
        return "";
    }
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getAllSecretNames(): string[] {
    const envContent = fs.readFileSync(".env", "utf8");
    const lines = envContent.split("\n");
    const secrets: string[] = [];
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        
        const key = trimmed.substring(0, eqIndex).trim();
        if (key && !key.startsWith("VITE_")) {
            secrets.push(key);
        }
    }
    return secrets;
}

async function syncAllSecrets() {
    console.log("🛡️  Syncing ALL .env variables to GCP Secret Manager...");

    const envContent = fs.readFileSync(".env", "utf8");
    const lines = envContent.split("\n");
    const secretNames: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();

        if (!key || !value) continue;

        if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
        } else if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }

        if (key.startsWith("VITE_")) continue;

        secretNames.push(key);

        const exists = getOutput(`gcloud secrets describe ${key} --project=${PROJECT_ID} 2>/dev/null`);
        if (!exists) {
            console.log(`🆕 Creating secret: ${key}`);
            execSync(`gcloud secrets create ${key} --replication-policy="automatic" --project=${PROJECT_ID}`, { stdio: "inherit" });
        }

        const currentRemoteValue = getOutput(`gcloud secrets versions access latest --secret=${key} --project=${PROJECT_ID} 2>/dev/null`);
        if (currentRemoteValue === value) {
            console.log(`✅ ${key} is up to date.`);
        } else {
            console.log(`🔄 Updating ${key}...`);
            execSync(`gcloud secrets versions add ${key} --data-file=- --project=${PROJECT_ID}`, { input: value });
        }
    }

    return secretNames;
}

async function grantSecretAccess(secretNames: string[]) {
    console.log("\n🔐 Granting service account access to secrets...");
    
    run(`gcloud projects add-iam-policy-binding ${PROJECT_ID} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/secretmanager.secretAccessor" 2>/dev/null || true`, true);
    
    console.log(`   ✅ Granted secretAccessor role for ${secretNames.length} secrets`);
}

async function ensureInfrastructure() {
    console.log("\n👤 Ensuring service account exists...");
    run(`gcloud iam service-accounts create compose-api \
      --display-name="Compose API Service Account" \
      --project=${PROJECT_ID} 2>/dev/null || true`);

    console.log("\n🔐 Granting project-level IAM roles...");
    run(`gcloud projects add-iam-policy-binding ${PROJECT_ID} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/logging.logWriter" 2>/dev/null || true`);
    run(`gcloud projects add-iam-policy-binding ${PROJECT_ID} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/run.invoker" 2>/dev/null || true`);
}

function buildSecretFlags(secrets: string[]): string {
    return secrets.map(s => `${s}=${s}:latest`).join(",");
}

async function deployService(secrets: string[]) {
    console.log("\n🚀 Deploying Cloud Run service from source...");
    console.log("   (GCP builds the container automatically - no Docker needed!)");
    
    const secretFlags = buildSecretFlags(secrets);
    
    run(`gcloud run deploy ${SERVICE_NAME} \
      --source . \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --service-account ${SERVICE_ACCOUNT} \
      --allow-unauthenticated \
      --port 3000 \
      --cpu 2 \
      --memory 4Gi \
      --min-instances 1 \
      --max-instances 10 \
      --timeout 300 \
      --set-env-vars "NODE_ENV=production" \
      --set-secrets "${secretFlags}"`);
}

async function deployJobs(secrets: string[]) {
    console.log("\n⏲️  Deploying Cloud Run Jobs...");
    
    const jobSecrets = [
        "GOOGLE_CLOUD_PROJECT_ID", "VERTEX_PROJECT_ID", "CRONOS_TESTNET_CHAIN_ID",
        "DEV_USDC_E_ADDRESS", "DISPENSER_CONTRACT", "REDIS_TLS",
        "REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT", "REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT",
        "SERVER_WALLET_KEY", "DEPLOYER_KEY", "MANOWAR_INTERNAL_SECRET",
        "REDIS_KEYS_API_KEY", "REDIS_KEYS_DEFAULT_PASSWORD",
        "REDIS_MEMORY_API_KEY", "REDIS_MEMORY_DEFAULT_PASSWORD",
        "REDIS_API_KEY", "MONGO_MEMORY_PASSWORD"
    ];
    
    const secretFlags = jobSecrets.map(s => `${s}=${s}:latest`).join(",");
    
    const jobs = [
        { name: "compose-market-settlement", task: "batch-settlement", timeout: "600s" },
        { name: "compose-market-expiry", task: "expiry-scan", timeout: "300s" }
    ];

    const image = getOutput(`gcloud run services describe ${SERVICE_NAME} --platform managed --region ${REGION} --project ${PROJECT_ID} --format="value(status.imageDigest)" 2>/dev/null || gcloud run services describe ${SERVICE_NAME} --platform managed --region ${REGION} --project ${PROJECT_ID} --format="value(template.containers[0].image)" 2>/dev/null`);
    
    if (!image) {
        console.error("   ❌ Could not get image - service may not be deployed yet");
        return;
    }

    for (const job of jobs) {
        console.log(`\n📦 Deploying job: ${job.name}`);
        
        run(`gcloud run jobs update ${job.name} \
      --image ${image} \
      --tasks 1 \
      --max-retries 0 \
      --task-timeout ${job.timeout} \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --service-account ${SERVICE_ACCOUNT} \
      --set-env-vars "JOB_TASK=${job.task},NODE_ENV=production" \
      --set-secrets "${secretFlags}" 2>/dev/null || \
      gcloud run jobs create ${job.name} \
      --image ${image} \
      --tasks 1 \
      --max-retries 0 \
      --task-timeout ${job.timeout} \
      --region ${REGION} \
      --project ${PROJECT_ID} \
      --service-account ${SERVICE_ACCOUNT} \
      --set-env-vars "JOB_TASK=${job.task},NODE_ENV=production" \
      --set-secrets "${secretFlags}"`);
    }
}

async function deploy() {
    console.log(`🚀 Starting compose-api deployment to GCP Cloud Run...`);
    console.log(`   Project: ${PROJECT_ID}`);
    console.log(`   Region: ${REGION}`);
    console.log(`   Service: ${SERVICE_NAME}`);
    console.log(`   Method: Source Deploy (no Docker required - like AWS Lambda!)`);

    const args = process.argv.slice(2);
    const skipSecrets = args.includes("--skip-secrets");
    const skipJobs = args.includes("--skip-jobs");

    let secrets: string[] = [];
    
    if (!skipSecrets) {
        secrets = await syncAllSecrets();
        await ensureInfrastructure();
        await grantSecretAccess(secrets);
        console.log("\n⏳ Waiting 30s for IAM propagation...");
        await sleep(30000);
    } else {
        secrets = getAllSecretNames();
    }

    await deployService(secrets);

    if (!skipJobs) {
        await deployJobs(secrets);
    }

    console.log("\n✅ PRODUCTION DEPLOYMENT COMPLETE!");
    const url = getOutput(`gcloud run services describe ${SERVICE_NAME} --platform managed --region ${REGION} --project ${PROJECT_ID} --format="value(status.url)"`);
    console.log(`🔗 API URL: ${url}`);
    
    console.log("\n📋 Deployed Resources:");
    console.log(`   • Cloud Run Service: ${SERVICE_NAME}`);
    console.log(`   • Cloud Run Job: compose-market-settlement`);
    console.log(`   • Cloud Run Job: compose-market-expiry`);
    console.log(`   • Secrets: ${secrets.length} synced`);
}

deploy().catch(err => {
    console.error("❌ Deployment failed:", err);
    process.exit(1);
});