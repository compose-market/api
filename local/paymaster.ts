import { createWalletClient, http } from "viem";
import { createNonceManager, jsonRpc } from "viem/nonce";
import { privateKeyToAccount } from "viem/accounts";
import * as SessionKey from "@filoz/synapse-core/session-key";
import { Synapse, calibration, mainnet, type Chain } from "@filoz/synapse-sdk";
import { checkAndSetAllowances, depositUSDFC } from "filecoin-pin/core/payments";
import { z } from "zod";
import { getActiveChainId } from "../x402/configs/chains.js";
import { getActiveSessionStatus } from "../x402/keys/index.js";
import { verifyComposeKey } from "../x402/keys/jwt.js";
import { extractComposeKeyFromHeader } from "../x402/keys/middleware.js";
import { type LocalRouteEvent, type LocalRouteResult } from "./network.js";

const walletPattern = /^0x[a-fA-F0-9]{40}$/;
const privateKeyPattern = /^0x[a-fA-F0-9]{64}$/;
const deviceIdPattern = /^[A-Za-z0-9._-]{8,128}$/;
const PAYMASTER_WRITE_MAX_ATTEMPTS = 4;
const PAYMASTER_WRITE_RETRY_DELAY_MS = 200;
const PAYMASTER_NONCE_ERROR_PATTERNS = [
  /nonce too low/i,
  /nonce has already been used/i,
  /replacement transaction underpriced/i,
  /transaction underpriced/i,
  /already known/i,
  /already imported/i,
  /invalid transaction nonce/i,
] as const;
const paymasterNonceManager = createNonceManager({ source: jsonRpc() });

const EnvSchema = z.object({
  SYNAPSE_NETWORK: z.enum(["calibration", "mainnet"]).default("calibration"),
  SYNAPSE_PROJECT_NAMESPACE: z.string().trim().min(1),
  SYNAPSE_WALLET_PRIVATE_KEY: z.string().trim().min(1),
  SYNAPSE_RPC_URL: z.string().trim().min(1).optional(),
  FILECOIN_CALIBRATION_RPC: z.string().trim().min(1).optional(),
  FILECOIN_MAINNET_RPC: z.string().trim().min(1).optional(),
});

function normalizeInlineCommentedEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

interface LocalSynapseSessionRequest {
  agentWallet: string;
  deviceId: string;
  sessionKeyAddress: string;
  sessionKeyExpiresAt: number;
  depositAmount?: string;
  ensureAllowances?: boolean;
}

interface SynapseRouteConfig {
  network: "calibration" | "mainnet";
  walletPrivateKey: `0x${string}`;
  source: string;
  rpcUrl: string | null;
}

function normalizeSynapseExpiryMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value / 1000) * 1000;
}

function json(
  statusCode: number,
  payload: unknown,
  corsHeaders: Record<string, string>,
): LocalRouteResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function getHeader(event: LocalRouteEvent, name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}

function parseJsonBody<T>(event: LocalRouteEvent): T {
  if (!event.body) {
    throw new Error("Request body is required");
  }
  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function normalizeWallet(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a valid wallet address`);
  }
  const normalized = value.trim().toLowerCase();
  if (!walletPattern.test(normalized)) {
    throw new Error(`${field} must be a valid wallet address`);
  }
  return normalized as `0x${string}`;
}

function normalizeDeviceId(value: unknown): string {
  if (typeof value !== "string" || !deviceIdPattern.test(value.trim())) {
    throw new Error("deviceId is invalid");
  }
  return value.trim();
}

function parsePositiveInt(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return number;
}

function parseDepositAmount(value: unknown): bigint {
  if (value === undefined || value === null || value === "") {
    return 0n;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("depositAmount must be a non-negative integer string");
  }
  return BigInt(normalized);
}

function parseEnsureAllowances(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  throw new Error("ensureAllowances must be a boolean");
}

function normalizeHexPrivateKey(value: string): `0x${string}` {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!privateKeyPattern.test(normalized)) {
    throw new Error("SYNAPSE_WALLET_PRIVATE_KEY must be a valid hex private key");
  }
  return normalized as `0x${string}`;
}

function resolveSynapseChain(network: SynapseRouteConfig["network"]): Chain {
  switch (network) {
    case "mainnet":
      return mainnet;
    case "calibration":
    default:
      return calibration;
  }
}

export function loadSynapseRouteConfig(env: NodeJS.ProcessEnv = process.env): SynapseRouteConfig {
  const parsed = EnvSchema.parse({
    ...env,
    SYNAPSE_NETWORK: normalizeInlineCommentedEnvValue(env.SYNAPSE_NETWORK),
    SYNAPSE_PROJECT_NAMESPACE: normalizeInlineCommentedEnvValue(env.SYNAPSE_PROJECT_NAMESPACE),
    SYNAPSE_WALLET_PRIVATE_KEY: normalizeInlineCommentedEnvValue(env.SYNAPSE_WALLET_PRIVATE_KEY),
    SYNAPSE_RPC_URL: normalizeInlineCommentedEnvValue(env.SYNAPSE_RPC_URL),
    FILECOIN_CALIBRATION_RPC: normalizeInlineCommentedEnvValue(env.FILECOIN_CALIBRATION_RPC),
    FILECOIN_MAINNET_RPC: normalizeInlineCommentedEnvValue(env.FILECOIN_MAINNET_RPC),
  });
  const rpcUrl = parsed.SYNAPSE_RPC_URL
    || (parsed.SYNAPSE_NETWORK === "mainnet" ? parsed.FILECOIN_MAINNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "calibration" ? parsed.FILECOIN_CALIBRATION_RPC : undefined)
    || null;
  return {
    network: parsed.SYNAPSE_NETWORK,
    walletPrivateKey: normalizeHexPrivateKey(parsed.SYNAPSE_WALLET_PRIVATE_KEY),
    source: parsed.SYNAPSE_PROJECT_NAMESPACE,
    rpcUrl,
  };
}

function effectiveExpiry(requested: number, activeSessionExpiresAt: number): number {
  return normalizeSynapseExpiryMs(Math.min(requested, activeSessionExpiresAt));
}

function isPaymasterNonceError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && !visited.has(current)) {
    visited.add(current);

    if (typeof current === "string") {
      const message = current;
      return PAYMASTER_NONCE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
    }

    if (current instanceof Error) {
      const message = current.message;
      if (PAYMASTER_NONCE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
        return true;
      }
      current = "cause" in current ? current.cause : null;
      continue;
    }

    current = null;
  }

  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPaymasterWrite<T>(input: {
  accountAddress: `0x${string}`;
  chainId: number;
  task: () => Promise<T>;
}): Promise<T> {
  for (let attempt = 0; attempt < PAYMASTER_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await input.task();
    } catch (error) {
      if (!isPaymasterNonceError(error) || attempt === PAYMASTER_WRITE_MAX_ATTEMPTS - 1) {
        throw error;
      }

      paymasterNonceManager.reset({
        address: input.accountAddress,
        chainId: input.chainId,
      });
      await wait(PAYMASTER_WRITE_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw new Error("Paymaster funding failed");
}

async function handleEnsureLocalSynapseSession(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult> {
  let body: LocalSynapseSessionRequest;
  try {
    body = parseJsonBody<LocalSynapseSessionRequest>(event);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  try {
    const agentWallet = normalizeWallet(body.agentWallet, "agentWallet");
    const deviceId = normalizeDeviceId(body.deviceId);
    const sessionKeyAddress = normalizeWallet(body.sessionKeyAddress, "sessionKeyAddress");
    const sessionKeyExpiresAt = parsePositiveInt(body.sessionKeyExpiresAt, "sessionKeyExpiresAt");
    const depositAmount = parseDepositAmount(body.depositAmount);
    const ensureAllowances = parseEnsureAllowances(body.ensureAllowances);
    const chainId = getHeader(event, "x-chain-id")
      ? parsePositiveInt(getHeader(event, "x-chain-id"), "x-chain-id")
      : getActiveChainId();
    const userAddress = normalizeWallet(getHeader(event, "x-session-user-address"), "x-session-user-address");

    const authHeader = getHeader(event, "authorization");
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);
    if (!composeKeyToken) {
      throw new Error("Authorization header with Compose Key token is required");
    }

    const payload = verifyComposeKey(composeKeyToken);
    if (!payload) {
      throw new Error("Invalid or expired Compose Key token");
    }
    if (payload.sub.toLowerCase() !== userAddress) {
      throw new Error("Compose Key token user does not match x-session-user-address");
    }

    const activeSession = (await getActiveSessionStatus(userAddress, chainId)).session;
    if (!activeSession || activeSession.keyId !== payload.keyId) {
      throw new Error("Compose Key token does not match the active session");
    }

    const config = loadSynapseRouteConfig();
    const account = privateKeyToAccount(config.walletPrivateKey, {
      nonceManager: paymasterNonceManager,
    });
    const chain = resolveSynapseChain(config.network);
    const transport = config.rpcUrl ? http(config.rpcUrl) : http();
    const walletClient = createWalletClient({
      account,
      chain,
      transport,
    });

    const expiresAt = effectiveExpiry(sessionKeyExpiresAt, activeSession.expiresAt);

    const synapse = Synapse.create({
      account,
      chain,
      transport,
      source: config.source,
      withCDN: false,
    });

    await runPaymasterWrite({
      accountAddress: account.address,
      chainId: chain.id,
      task: async () => SessionKey.loginSync(walletClient, {
        address: sessionKeyAddress,
        expiresAt: BigInt(Math.floor(expiresAt / 1000)),
        origin: "compose.local.mesh",
      }),
    });

    let depositExecuted = false;
    if (depositAmount > 0n) {
      await runPaymasterWrite({
        accountAddress: account.address,
        chainId: chain.id,
        task: async () => depositUSDFC(synapse, depositAmount),
      });
      depositExecuted = true;
    }

    if (ensureAllowances) {
      await runPaymasterWrite({
        accountAddress: account.address,
        chainId: chain.id,
        task: async () => checkAndSetAllowances(synapse),
      });
    }

    const accountInfo = await synapse.payments.accountInfo();

    return json(200, {
      success: true,
      agentWallet,
      deviceId,
      payerAddress: account.address,
      sessionKeyAddress,
      sessionKeyExpiresAt: expiresAt,
      availableFunds: accountInfo.availableFunds.toString(),
      depositAmount: depositAmount.toString(),
      depositExecuted,
      network: config.network,
      source: config.source,
    }, corsHeaders);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }
}

export async function handleLocalSynapseRoute(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult | null> {
  const path = event.rawPath;
  const method = event.requestContext.http.method;

  if (
    method === "POST"
    && (path === "/api/local/synapse/session" || path === "/api/local/paymaster/session")
  ) {
    return handleEnsureLocalSynapseSession(event, corsHeaders);
  }

  return null;
}
