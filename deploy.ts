import "dotenv/config";
import { createHash } from "crypto";
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
const MANIFEST_SECRET = `${SERVICE_NAME}-env-manifest`;
const GCLOUD_ENV = {
    ...process.env,
    CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "1",
};

export interface ServiceConfig {
    port: string;
    cpu: string;
    memory: string;
    minInstances: string;
    maxInstances: string;
    concurrency: string;
    timeout: string;
    ingress: string;
}

export interface SecretManifest {
    version: 1;
    secrets: Record<string, string>;
}

export interface SecretDiff {
    added: string[];
    removed: string[];
    changed: string[];
    unchanged: string[];
    keySetChanged: boolean;
    valueChanged: boolean;
}

function env(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
    const value = env[key]?.trim();
    return value && value.length > 0 ? value : fallback;
}

export function resolveServiceConfig(source: NodeJS.ProcessEnv = process.env): ServiceConfig {
    return {
        port: env(source, "API_CLOUD_RUN_PORT", "3000"),
        cpu: env(source, "API_CLOUD_RUN_CPU", "2"),
        memory: env(source, "API_CLOUD_RUN_MEMORY", "4Gi"),
        minInstances: env(source, "API_CLOUD_RUN_MIN_INSTANCES", "1"),
        maxInstances: env(source, "API_CLOUD_RUN_MAX_INSTANCES", "30"),
        concurrency: env(source, "API_CLOUD_RUN_CONCURRENCY", "80"),
        timeout: env(source, "API_CLOUD_RUN_TIMEOUT", "1800"),
        ingress: env(source, "API_CLOUD_RUN_INGRESS", "all"),
    };
}

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

function getProjectNumber(): string {
    const projectId = requireProjectId();
    const projectNumber = getOutput(
        `gcloud projects describe ${projectId} --format="value(projectNumber)"`,
    );
    if (!projectNumber) {
        throw new Error(`Could not resolve project number for ${projectId}`);
    }
    return projectNumber;
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

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function sort(values: Iterable<string>): string[] {
    return Array.from(values).sort((a, b) => a.localeCompare(b));
}

export function buildSecretManifest(entries: Array<{ key: string; value: string }>): SecretManifest {
    return {
        version: 1,
        secrets: Object.fromEntries(
            entries
                .map(({ key, value }) => [key, hash(value)] as const)
                .sort(([a], [b]) => a.localeCompare(b)),
        ),
    };
}

export function diffSecretManifest(current: SecretManifest, previous: SecretManifest | null): SecretDiff {
    if (!previous) {
        const added = sort(Object.keys(current.secrets));
        return {
            added,
            removed: [],
            changed: [],
            unchanged: [],
            keySetChanged: added.length > 0,
            valueChanged: added.length > 0,
        };
    }

    const currentKeys = new Set(Object.keys(current.secrets));
    const previousKeys = new Set(Object.keys(previous.secrets));
    const added = sort([...currentKeys].filter((key) => !previousKeys.has(key)));
    const removed = sort([...previousKeys].filter((key) => !currentKeys.has(key)));
    const shared = [...currentKeys].filter((key) => previousKeys.has(key));
    const changed = sort(shared.filter((key) => current.secrets[key] !== previous.secrets[key]));
    const unchanged = sort(shared.filter((key) => current.secrets[key] === previous.secrets[key]));

    return {
        added,
        removed,
        changed,
        unchanged,
        keySetChanged: added.length > 0 || removed.length > 0,
        valueChanged: added.length > 0 || removed.length > 0 || changed.length > 0,
    };
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

function readManifest(projectId: string): SecretManifest | null {
    const exists = getOutput(`gcloud secrets describe ${MANIFEST_SECRET} --project=${projectId} 2>/dev/null`);
    if (!exists) {
        return null;
    }

    const raw = getOutput(
        `gcloud secrets versions access latest --secret=${MANIFEST_SECRET} --project=${projectId} 2>/dev/null`,
    );
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as SecretManifest;
        if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== "object") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function writeManifest(projectId: string, manifest: SecretManifest): void {
    const exists = getOutput(`gcloud secrets describe ${MANIFEST_SECRET} --project=${projectId} 2>/dev/null`);
    if (!exists) {
        console.log(`🆕 Creating deploy manifest: ${MANIFEST_SECRET}`);
        run(`gcloud secrets create ${MANIFEST_SECRET} --replication-policy="automatic" --project=${projectId}`);
    }

    run(
        `gcloud secrets versions add ${MANIFEST_SECRET} --data-file=- --project=${projectId}`,
        { silent: true, input: JSON.stringify(manifest) },
    );
}

function ensureSecret(projectId: string, key: string): boolean {
    const exists = getOutput(`gcloud secrets describe ${key} --project=${projectId} 2>/dev/null`);
    if (exists) {
        return false;
    }

    console.log(`🆕 Creating secret: ${key}`);
    run(`gcloud secrets create ${key} --replication-policy="automatic" --project=${projectId}`);
    return true;
}

async function syncAllSecrets(): Promise<{ secretNames: string[]; changed: boolean; keySetChanged: boolean }> {
    console.log("🛡️  Syncing deployable .env variables to GCP Secret Manager...");

    const entries = parseEnvSecrets();
    const secretNames = sort(entries.map(({ key }) => key));
    const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
    const currentManifest = buildSecretManifest(entries);
    const previousManifest = readManifest(requireProjectId());
    const diff = diffSecretManifest(currentManifest, previousManifest);
    let changed = false;
    const projectId = requireProjectId();

    if (previousManifest) {
        console.log(`   Δ secrets: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed, ${diff.unchanged.length} unchanged.`);
    } else {
        console.log("   No deploy manifest found; checking all deployable secrets once.");
    }

    const dirtyKeys = previousManifest
        ? sort([...diff.added, ...diff.changed])
        : secretNames;

    for (const key of dirtyKeys) {
        const entry = entryByKey.get(key);
        if (!entry) continue;

        const created = ensureSecret(projectId, key);
        if (!previousManifest) {
            const currentRemoteValue = getOutput(
                `gcloud secrets versions access latest --secret=${key} --project=${projectId} 2>/dev/null`,
            );
            if (currentRemoteValue === entry.value) {
                console.log(`✅ ${key} is up to date.`);
                changed ||= created;
                continue;
            }
        }

        if (previousManifest && !created) {
            console.log(`🔄 Updating ${key}...`);
        } else if (!previousManifest) {
            console.log(`🔄 Updating ${key}...`);
        }
        run(
            `gcloud secrets versions add ${key} --data-file=- --project=${projectId}`,
            { silent: true, input: entry.value },
        );
        console.log(`   ↳ Updated ${key}`);
        changed = true;
    }

    if (diff.removed.length > 0) {
        console.log(`   Removed from service bindings: ${diff.removed.join(", ")}`);
        changed = true;
    }

    if (!previousManifest || diff.valueChanged) {
        writeManifest(projectId, currentManifest);
    }

    return { secretNames, changed, keySetChanged: !previousManifest || diff.keySetChanged };
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

function extractServiceSecretNames(describe: unknown): string[] {
    const service = describe as {
        spec?: { template?: { spec?: { containers?: Array<{ env?: Array<Record<string, unknown>> }> } } };
        template?: { containers?: Array<{ env?: Array<Record<string, unknown>> }> };
    };
    const env =
        service.spec?.template?.spec?.containers?.[0]?.env ??
        service.template?.containers?.[0]?.env ??
        [];

    return sort(env
        .filter((entry) => {
            const valueFrom = entry.valueFrom as { secretKeyRef?: unknown } | undefined;
            return Boolean(valueFrom?.secretKeyRef);
        })
        .map((entry) => String(entry.name || ""))
        .filter(Boolean));
}

function serviceSecretBindingsMatch(secretNames: string[]): boolean {
    const projectId = requireProjectId();
    const raw = getOutput(
        `gcloud run services describe ${SERVICE_NAME} \
      --platform managed \
      --region ${REGION} \
      --project ${projectId} \
      --format=json`,
    );

    if (!raw) {
        return false;
    }

    try {
        const bound = extractServiceSecretNames(JSON.parse(raw));
        const desired = sort(secretNames);
        return bound.length === desired.length && bound.every((name, index) => name === desired[index]);
    } catch {
        return false;
    }
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
    const config = resolveServiceConfig();

    const commandParts = [
        `gcloud run deploy ${SERVICE_NAME}`,
        `--image ${image}`,
        `--region ${REGION}`,
        `--project ${projectId}`,
        `--service-account ${serviceAccount}`,
        `--allow-unauthenticated`,
        `--ingress ${config.ingress}`,
        `--port ${config.port}`,
        `--cpu ${config.cpu}`,
        `--no-cpu-throttling`,
        `--memory ${config.memory}`,
        `--min-instances ${config.minInstances}`,
        `--max-instances ${config.maxInstances}`,
        `--concurrency ${config.concurrency}`,
        `--timeout ${config.timeout}`,
        `--set-env-vars "NODE_ENV=production,BATCH_SETTLEMENT_IDLE_SECONDS=0"`,
    ];

    if (includeSecrets) {
        const secretFlags = buildSecretFlags(secrets);
        commandParts.push(`--set-secrets "${secretFlags}"`);
    } else {
        console.log("   ⚡ Preserving existing service secrets/env bindings");
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

function schedulerJobExists(jobName: string): boolean {
    const projectId = requireProjectId();
    const output = getOutput(
        `gcloud scheduler jobs describe ${jobName} \
      --location ${REGION} \
      --project ${projectId} \
      --format="value(name)" 2>/dev/null`,
    );
    return output.endsWith(`/jobs/${jobName}`) || output === jobName;
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
        `--set-env-vars "JOB_TASK=${job.task},NODE_ENV=production${job.task === "batch-settlement" ? ",BATCH_SETTLEMENT_IDLE_SECONDS=0" : ""}"`,
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
                "DISPENSER_CONTRACT",
                "AVALANCHE_MAINNET_RPC",
                "ARC_TESTNET_RPC",
                "SEI_MAINNET_RPC",
                "MERCHANT_WALLET_ADDRESS",
                "SVM_MERCHANT_WALLET_ADDRESS",
                "VALKEY_TLS",
                "VALKEY_KEYS_SERVICE_URI",
                "SERVER_WALLET_KEY",
                "FACILITATOR_KEY",
                "SVM_FACILITATOR_KEY",
                "VALKEY_KEYS_PASSWORD",
            ],
        },
        {
            name: "compose-market-expiry",
            task: "expiry-scan",
            timeout: "300s",
            secretNames: [
                "VALKEY_KEYS_SERVICE_URI",
                "VALKEY_KEYS_PASSWORD",
                "VALKEY_TLS",
            ],
        },
    ];

    for (const job of jobs) {
        console.log(`\n📦 Deploying job: ${job.name}`);
        const mode = jobExists(job.name) ? "update" : "create";
        run(buildJobDeployCommand(mode, job, image));
    }
}

function buildSettlementSchedulerCommand(mode: "create" | "update"): string {
    const projectId = requireProjectId();
    const projectNumber = getProjectNumber();
    const serviceAccount = getServiceAccount();
    const uri = `https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectNumber}/jobs/compose-market-settlement:run`;
    return [
        `gcloud scheduler jobs ${mode} http compose-market-settlement-every-2-min`,
        `--location ${REGION}`,
        `--project ${projectId}`,
        `--schedule "*/2 * * * *"`,
        `--time-zone "Etc/UTC"`,
        `--uri "${uri}"`,
        `--http-method POST`,
        `--oauth-service-account-email ${serviceAccount}`,
        `--oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"`,
        `--attempt-deadline 180s`,
        "--quiet",
    ].join(" \\\n      ");
}

async function deploySettlementScheduler() {
    const projectId = requireProjectId();
    const serviceAccount = getServiceAccount();

    console.log("\n⏱️  Ensuring batch settlement scheduler...");
    run(`gcloud services enable cloudscheduler.googleapis.com --project ${projectId} --quiet`);
    run(
        `gcloud projects add-iam-policy-binding ${projectId} \
      --member="serviceAccount:${serviceAccount}" \
      --role="roles/run.invoker" 2>/dev/null || true`,
        { silent: true },
    );
    const mode = schedulerJobExists("compose-market-settlement-every-2-min") ? "update" : "create";
    run(buildSettlementSchedulerCommand(mode));
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
    let serviceSecretBindingsChanged = !skipSecrets;
    let infrastructureChanged = false;
    if (!skipSecrets) {
        const syncResult = await syncAllSecrets();
        secrets = syncResult.secretNames;
        secretsChanged = syncResult.changed;
        serviceSecretBindingsChanged = syncResult.keySetChanged || !serviceSecretBindingsMatch(secrets);
        infrastructureChanged = await ensureInfrastructure();
        await grantSecretAccess(secrets);
        if (secretsChanged || infrastructureChanged) {
            console.log("\n⏳ Waiting 10s for IAM/secret propagation...");
            await sleep(10_000);
        }
    }

    const image = await buildImage();
    await deployService(image, secrets, serviceSecretBindingsChanged);

    if (!skipJobs) {
        await deployJobs(image);
        await deploySettlementScheduler();
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
