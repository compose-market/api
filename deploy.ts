import "dotenv/config";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Production Deployment Orchestrator
 * Target: GCP Cloud Run & Cloud Run Jobs
 * Build: cached image deploy
 */

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID ?? "";
const REGION = "us-east1";
const SERVICE_NAME = "compose-market-api";
const REPOSITORY_NAME = "compose";
const GCLOUD_ENV = {
    ...process.env,
    CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
};

function requireProjectId(): string {
    if (!PROJECT_ID) {
        throw new Error("GOOGLE_CLOUD_PROJECT_ID not set in .env");
    }
    return PROJECT_ID;
}

function getServiceAccount(): string {
    return `compose-api@${requireProjectId()}.iam.gserviceaccount.com`;
}

function getImageRepository(): string {
    return `${REGION}-docker.pkg.dev/${requireProjectId()}/${REPOSITORY_NAME}/${SERVICE_NAME}`;
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
        const result = execSync(command, {
            stdio: silent ? "pipe" : "inherit",
            encoding: "utf-8",
            env: GCLOUD_ENV,
            ...(input !== undefined ? { input } : {}),
        });
        return (result || "").toString().trim();
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

export function resolveServiceImageFromDescribe(describe: unknown): string {
    const service = describe as {
        spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } };
        template?: { containers?: Array<{ image?: string }> };
    };

    const image =
        service.spec?.template?.spec?.containers?.[0]?.image ??
        service.template?.containers?.[0]?.image;

    if (!image) {
        throw new Error("Could not resolve deployed service image");
    }

    return image;
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

async function syncAllSecrets(): Promise<{ secretNames: string[]; changed: boolean }> {
    console.log("🛡️  Syncing ALL .env variables to GCP Secret Manager...");

    const entries = parseEnvSecrets();
    const secretNames: string[] = [];
    let changed = false;
    const projectId = requireProjectId();

    for (const { key, value } of entries) {
        secretNames.push(key);

        const exists = getOutput(`gcloud secrets describe ${key} --project=${projectId} 2>/dev/null`);
        if (!exists) {
            console.log(`🆕 Creating secret: ${key}`);
            run(`gcloud secrets create ${key} --replication-policy="automatic" --project=${projectId}`);
            changed = true;
        }

        const currentRemoteValue = getOutput(
            `gcloud secrets versions access latest --secret=${key} --project=${projectId} 2>/dev/null`,
        );
        if (currentRemoteValue === value) {
            console.log(`✅ ${key} is up to date.`);
        } else {
            console.log(`🔄 Updating ${key}...`);
            run(
                `gcloud secrets versions add ${key} --data-file=- --project=${projectId}`,
                { silent: true, input: value },
            );
            console.log(`   ↳ Updated ${key}`);
            changed = true;
        }
    }

    return { secretNames, changed };
}

async function grantSecretAccess(secretNames: string[]) {
    console.log("\n🔐 Granting service account access to secrets...");
    const projectId = requireProjectId();
    const serviceAccount = getServiceAccount();

    run(
        `gcloud projects add-iam-policy-binding ${projectId} \
      --member="serviceAccount:${serviceAccount}" \
      --role="roles/secretmanager.secretAccessor" 2>/dev/null || true`,
        { silent: true },
    );

    console.log(`   ✅ Granted secretAccessor role for ${secretNames.length} secrets`);
}

async function ensureInfrastructure(): Promise<boolean> {
    const projectId = requireProjectId();
    const serviceAccount = getServiceAccount();
    let changed = false;

    console.log("\n👤 Ensuring service account exists...");
    const serviceAccountExists = getOutput(
        `gcloud iam service-accounts describe ${serviceAccount} --project=${projectId} --format="value(email)" 2>/dev/null`,
    );
    if (!serviceAccountExists) {
        run(
            `gcloud iam service-accounts create compose-api \
      --display-name="Compose API Service Account" \
      --project=${projectId}`,
        );
        changed = true;
    }

    console.log("\n🔐 Granting project-level IAM roles...");
    run(
        `gcloud projects add-iam-policy-binding ${projectId} \
      --member="serviceAccount:${serviceAccount}" \
      --role="roles/logging.logWriter" 2>/dev/null || true`,
    );
    run(
        `gcloud projects add-iam-policy-binding ${projectId} \
      --member="serviceAccount:${serviceAccount}" \
      --role="roles/run.invoker" 2>/dev/null || true`,
    );

    return changed;
}

function buildSecretFlags(secrets: string[]): string {
    const unique = Array.from(new Set(secrets));
    return unique.map((secret) => `${secret}=${secret}:latest`).join(",");
}

function buildImageTag(): string {
    const gitSha = getOutput("git rev-parse --short HEAD") || "manual";
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `${gitSha}-${timestamp}`;
}

function buildCloudBuildConfig(image: string, latestImage: string): string {
    return `steps:
  - name: 'gcr.io/cloud-builders/docker'
    id: 'pull-cache'
    entrypoint: 'bash'
    args:
      - '-lc'
      - 'docker pull ${latestImage} || true'
  - name: 'gcr.io/cloud-builders/docker'
    id: 'build'
    entrypoint: 'bash'
    args:
      - '-lc'
      - |
          docker build \\
            --cache-from ${latestImage} \\
            --platform linux/amd64 \\
            -t ${image} \\
            -t ${latestImage} \\
            .
  - name: 'gcr.io/cloud-builders/docker'
    id: 'push-version'
    args: ['push', '${image}']
  - name: 'gcr.io/cloud-builders/docker'
    id: 'push-latest'
    args: ['push', '${latestImage}']
options:
  logging: CLOUD_LOGGING_ONLY
  machineType: 'E2_HIGHCPU_8'
timeout: '1800s'
images:
  - '${image}'
  - '${latestImage}'
`;
}

async function buildImage(): Promise<string> {
    const imageRepository = getImageRepository();
    const image = `${imageRepository}:${buildImageTag()}`;
    const latestImage = `${imageRepository}:latest`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-api-deploy-"));
    const configPath = path.join(tempDir, "cloudbuild.generated.yaml");

    console.log("\n📦 Building container image...");
    console.log(`   Repository: ${imageRepository}`);
    console.log(`   Version: ${image}`);
    console.log("   Cache source: latest");

    fs.writeFileSync(configPath, buildCloudBuildConfig(image, latestImage), "utf8");

    try {
        run(
            `gcloud builds submit . \
      --project ${requireProjectId()} \
      --config ${configPath} \
      --quiet`,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    return image;
}

async function deployService(image: string, secrets: string[], includeSecrets: boolean) {
    console.log("\n🚀 Deploying Cloud Run service from image...");
    const projectId = requireProjectId();
    const serviceAccount = getServiceAccount();

    const commandParts = [
        `gcloud run deploy ${SERVICE_NAME}`,
        `--image ${image}`,
        `--region ${REGION}`,
        `--project ${projectId}`,
        `--service-account ${serviceAccount}`,
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

type JobConfig = {
    name: string;
    task: string;
    timeout: string;
    secretNames: string[];
};

function jobExists(jobName: string): boolean {
    const projectId = requireProjectId();
    const output = getOutput(
        `gcloud run jobs describe ${jobName} \
      --region ${REGION} \
      --project ${projectId} \
      --format="value(metadata.name)" 2>/dev/null`,
    );
    return output === jobName;
}

function buildJobDeployCommand(
    mode: "create" | "update",
    job: JobConfig,
    image: string,
): string {
    const projectId = requireProjectId();
    const serviceAccount = getServiceAccount();
    const commandParts = [
        `gcloud run jobs ${mode} ${job.name}`,
        `--image ${image}`,
        `--tasks 1`,
        `--max-retries 0`,
        `--task-timeout ${job.timeout}`,
        `--region ${REGION}`,
        `--project ${projectId}`,
        `--service-account ${serviceAccount}`,
        `--set-env-vars "JOB_TASK=${job.task},NODE_ENV=production"`,
    ];

    if (job.secretNames.length > 0) {
        commandParts.push(`--set-secrets "${buildSecretFlags(job.secretNames)}"`);
    }

    commandParts.push("--quiet");
    return commandParts.join(" \\\n      ");
}

async function deployJobs(image: string) {
    console.log("\n⏲️  Deploying Cloud Run Jobs...");

    const jobs: JobConfig[] = [
        {
            name: "compose-market-settlement",
            task: "batch-settlement",
            timeout: "600s",
            secretNames: [
                "GOOGLE_CLOUD_PROJECT_ID",
                "VERTEX_PROJECT_ID",
                "CRONOS_TESTNET_CHAIN_ID",
                "DEV_USDC_E_ADDRESS",
                "DISPENSER_CONTRACT",
                "REDIS_TLS",
                "REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT",
                "SERVER_WALLET_KEY",
                "DEPLOYER_KEY",
                "REDIS_KEYS_API_KEY",
                "REDIS_KEYS_DEFAULT_PASSWORD",
                "REDIS_API_KEY",
            ],
        },
        {
            name: "compose-market-expiry",
            task: "expiry-scan",
            timeout: "300s",
            secretNames: [
                "REDIS_KEYS_DATABASE_PUBLIC_ENDPOINT",
                "REDIS_KEYS_DEFAULT_PASSWORD",
                "REDIS_TLS",
            ],
        },
    ];

    for (const job of jobs) {
        console.log(`\n📦 Deploying job: ${job.name}`);
        const mode = jobExists(job.name) ? "update" : "create";
        run(buildJobDeployCommand(mode, job, image));
    }
}

async function deploy() {
    const projectId = requireProjectId();

    console.log(`🚀 Starting compose-api deployment to GCP Cloud Run...`);
    console.log(`   Project: ${projectId}`);
    console.log(`   Region: ${REGION}`);
    console.log(`   Service: ${SERVICE_NAME}`);

    const args = process.argv.slice(2);
    const fastMode = args.includes("--fast");
    const skipSecrets = fastMode || args.includes("--skip-secrets");
    const skipJobs = fastMode || args.includes("--skip-jobs");

    if (fastMode) {
        console.log("   Mode: FAST (skip secrets + jobs)");
        console.log("   ⚠️  FAST mode does NOT sync .env to Secret Manager and does NOT update --set-secrets bindings.");
        console.log("   ⚠️  Use `npm run deploy` (or `npm run deploy:full`) after changing secret names/values.");
    } else {
        console.log("   Mode: FULL");
    }

    let secrets: string[] = [];
    let secretsChanged = false;
    let infrastructureChanged = false;
    if (!skipSecrets) {
        const syncResult = await syncAllSecrets();
        secrets = syncResult.secretNames;
        secretsChanged = syncResult.changed;
        infrastructureChanged = await ensureInfrastructure();
        await grantSecretAccess(secrets);
        if (secretsChanged || infrastructureChanged) {
            console.log("\n⏳ Waiting 10s for IAM/secret propagation...");
            await sleep(10_000);
        }
    }

    const image = await buildImage();
    await deployService(image, secrets, !skipSecrets);

    if (!skipJobs) {
        await deployJobs(image);
    }

    const url = getOutput(
        `gcloud run services describe ${SERVICE_NAME} \
      --platform managed \
      --region ${REGION} \
      --project ${projectId} \
      --format="value(status.url)"`,
    );

    const deployedDescribe = getOutput(
        `gcloud run services describe ${SERVICE_NAME} \
      --platform managed \
      --region ${REGION} \
      --project ${projectId} \
      --format=json`,
    );
    let deployedImage = image;
    if (deployedDescribe) {
        try {
            deployedImage = resolveServiceImageFromDescribe(JSON.parse(deployedDescribe));
        } catch {
            deployedImage = image;
        }
    }

    console.log("\n✅ PRODUCTION DEPLOYMENT COMPLETE!");
    console.log(`🔗 API URL: ${url || "(unavailable)"}`);
    console.log(`📦 Image: ${deployedImage}`);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
    deploy().catch((err) => {
        console.error("❌ Deployment failed:", err);
        process.exit(1);
    });
}
