/**
 * Lambda Deployment Script
 * 
 * Builds and deploys the API Lambda function to AWS.
 * Uses credentials from .env file.
 */

import { build } from "esbuild";
import { rm, mkdir, readFile, writeFile } from "fs/promises";
import { execSync } from "child_process";
import path from "path";
import { config } from "dotenv";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from lambda/.env
config({ path: path.join(__dirname, ".env") });

// AWS credentials (support both naming conventions)
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY;

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET) {
  console.error("❌ AWS credentials not found in .env");
  console.error("   Required: AWS_ACCESS_KEY (or AWS_ACCESS_KEY_ID) and AWS_SECRET_ACCESS_KEY");
  process.exit(1);
}

const FUNCTION_NAME = "compose-market-api";
const REGION = process.env.AWS_REGION || "us-east-1";
const RUNTIME = "nodejs20.x";
const HANDLER = "index.handler";
const TIMEOUT = 30;
const MEMORY = 512;

// Environment variables to pass to Lambda
// Map from .env name to Lambda env name (if different)
const LAMBDA_ENV_VARS: Record<string, string> = {
  THIRDWEB_SECRET_KEY: "THIRDWEB_SECRET_KEY",
  TREASURY_SERVER_WALLET_PUBLIC: "TREASURY_SERVER_WALLET_PUBLIC",
  GOOGLE_GENERATIVE_AI_API_KEY: "GOOGLE_GENERATIVE_AI_API_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  ASI_ONE_API_KEY: "ASI_API_KEY", // Code uses ASI_API_KEY
  HUGGING_FACE_INFERENCE_TOKEN: "HUGGING_FACE_INFERENCE_TOKEN",
  AGENTVERSE_API_KEY: "AGENTVERSE_API_KEY",
};

// Clean env value (remove inline comments)
function cleanEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Remove inline comments (// or #) but preserve the value
  return value.split(/\s*\/\/\s*/)[0].split(/\s*#\s*/)[0].trim();
}

// AWS environment for all commands
const awsEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: AWS_SECRET,
};

async function deploy() {
  const distDir = path.join(__dirname, "dist");
  const zipPath = path.join(__dirname, "function.zip");

  console.log("🧹 Cleaning dist directory...");
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  console.log("📦 Building Lambda bundle...");
  await build({
    entryPoints: [path.join(__dirname, "handler.ts")],
    platform: "node",
    target: "node20",
    bundle: true,
    format: "cjs",
    outfile: path.join(distDir, "index.js"),
    minify: true,
    sourcemap: false,
    external: [
      // AWS SDK is provided by Lambda runtime
      "@aws-sdk/*",
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "info",
  });

  console.log("🗜️ Creating deployment package...");
  // Create zip file
  execSync(`cd ${distDir} && zip -r ${zipPath} .`, { stdio: "inherit" });

  // Check if function exists
  let functionExists = false;
  try {
    execSync(`aws lambda get-function --function-name ${FUNCTION_NAME} --region ${REGION}`, {
      stdio: "pipe",
      env: awsEnv,
    });
    functionExists = true;
  } catch {
    functionExists = false;
  }

  // Build environment variables JSON
  const envVars: Record<string, string> = {};
  for (const [envKey, lambdaKey] of Object.entries(LAMBDA_ENV_VARS)) {
    const value = cleanEnvValue(process.env[envKey]);
    if (value) {
      envVars[lambdaKey] = value;
    }
  }
  console.log("📋 Environment variables to deploy:", Object.keys(envVars).join(", "));
  const envVarsJson = JSON.stringify({ Variables: envVars });

  if (functionExists) {
    console.log("📤 Updating existing Lambda function...");
    execSync(
      `aws lambda update-function-code \
        --function-name ${FUNCTION_NAME} \
        --zip-file fileb://${zipPath} \
        --region ${REGION}`,
      { stdio: "inherit", env: awsEnv }
    );

    // Update environment variables
    console.log("🔧 Updating environment variables...");
    execSync(
      `aws lambda update-function-configuration \
        --function-name ${FUNCTION_NAME} \
        --environment '${envVarsJson}' \
        --timeout ${TIMEOUT} \
        --memory-size ${MEMORY} \
        --region ${REGION}`,
      { stdio: "inherit", env: awsEnv }
    );
  } else {
    console.log("🆕 Creating new Lambda function...");
    
    // First, check if the execution role exists
    const roleName = "compose-market-lambda-role";
    let roleArn: string;
    
    try {
      const roleOutput = execSync(
        `aws iam get-role --role-name ${roleName}`,
        { stdio: "pipe", env: awsEnv }
      ).toString();
      roleArn = JSON.parse(roleOutput).Role.Arn;
    } catch {
      // Create the role
      console.log("📋 Creating IAM execution role...");
      const trustPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      });

      const createRoleOutput = execSync(
        `aws iam create-role \
          --role-name ${roleName} \
          --assume-role-policy-document '${trustPolicy}'`,
        { stdio: "pipe", env: awsEnv }
      ).toString();
      roleArn = JSON.parse(createRoleOutput).Role.Arn;

      // Attach basic execution policy
      execSync(
        `aws iam attach-role-policy \
          --role-name ${roleName} \
          --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
        { stdio: "inherit", env: awsEnv }
      );

      // Wait for role to propagate
      console.log("⏳ Waiting for IAM role to propagate...");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    execSync(
      `aws lambda create-function \
        --function-name ${FUNCTION_NAME} \
        --runtime ${RUNTIME} \
        --handler ${HANDLER} \
        --role ${roleArn} \
        --zip-file fileb://${zipPath} \
        --timeout ${TIMEOUT} \
        --memory-size ${MEMORY} \
        --environment '${envVarsJson}' \
        --region ${REGION}`,
      { stdio: "inherit", env: awsEnv }
    );
  }

  // Create or update Function URL (for direct HTTP access without API Gateway)
  console.log("🌐 Configuring Function URL...");
  const corsConfig = JSON.stringify({
    AllowOrigins: ["*"],
    AllowMethods: ["*"],
    AllowHeaders: ["*"],
    AllowCredentials: false,
  });
  
  try {
    execSync(
      `aws lambda create-function-url-config \
        --function-name ${FUNCTION_NAME} \
        --auth-type NONE \
        --cors '${corsConfig}' \
        --region ${REGION}`,
      { stdio: "pipe", env: awsEnv }
    );
  } catch {
    // URL config already exists, update it
    execSync(
      `aws lambda update-function-url-config \
        --function-name ${FUNCTION_NAME} \
        --auth-type NONE \
        --cors '${corsConfig}' \
        --region ${REGION}`,
      { stdio: "inherit", env: awsEnv }
    );
  }

  // Add permission for public access
  try {
    execSync(
      `aws lambda add-permission \
        --function-name ${FUNCTION_NAME} \
        --statement-id FunctionURLAllowPublicAccess \
        --action lambda:InvokeFunctionUrl \
        --principal "*" \
        --function-url-auth-type NONE \
        --region ${REGION}`,
      { stdio: "pipe", env: awsEnv }
    );
  } catch {
    // Permission already exists
  }

  // Get the function URL
  const urlOutput = execSync(
    `aws lambda get-function-url-config --function-name ${FUNCTION_NAME} --region ${REGION}`,
    { stdio: "pipe", env: awsEnv }
  ).toString();
  const functionUrl = JSON.parse(urlOutput).FunctionUrl;

  console.log("\n✅ Deployment complete!");
  console.log(`\n🔗 Lambda Function URL: ${functionUrl}`);
  console.log("\nEndpoints:");
  console.log(`  POST ${functionUrl}api/inference`);
  console.log(`  GET  ${functionUrl}api/models`);
  console.log(`  GET  ${functionUrl}api/hf/models`);
  console.log(`  GET  ${functionUrl}api/hf/tasks`);
  console.log(`  GET  ${functionUrl}api/agentverse/agents`);

  // Save URL to app/.env for frontend
  const appEnvPath = path.join(__dirname, "..", "..", "app", ".env");
  const apiUrlLine = `VITE_API_URL=${functionUrl}`;
  
  try {
    const envContent = await readFile(appEnvPath, "utf-8");
    if (envContent.includes("VITE_API_URL=")) {
      const updated = envContent.replace(/VITE_API_URL=.*/g, apiUrlLine);
      await writeFile(appEnvPath, updated);
    } else {
      await writeFile(appEnvPath, envContent + "\n" + apiUrlLine + "\n");
    }
  } catch {
    // Create new .env file
    await writeFile(appEnvPath, apiUrlLine + "\n");
  }
  
  console.log(`\n📝 Updated app/.env with VITE_API_URL=${functionUrl}`);
}

deploy().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});

