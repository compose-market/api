import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as SessionKey from "@filoz/synapse-core/session-key";
import { Synapse, calibration, devnet, mainnet, type Chain } from "@filoz/synapse-sdk";
import { z } from "zod";
import { getActiveChainId } from "../x402/configs/chains.js";
import { getActiveSessionStatus } from "../x402/keys/index.js";
import { verifyComposeKey } from "../x402/keys/jwt.js";
import { extractComposeKeyFromHeader } from "../x402/keys/middleware.js";
import { type LocalRouteEvent, type LocalRouteResult } from "./network.js";

const COMPOSE_SYNAPSE_SOURCE = "compose";
const walletPattern = /^0x[a-fA-F0-9]{40}$/;
const privateKeyPattern = /^0x[a-fA-F0-9]{64}$/;
const deviceIdPattern = /^[A-Za-z0-9._-]{8,128}$/;

const EnvSchema = z.object({
  SYNAPSE_NETWORK: z.enum(["calibration", "mainnet", "devnet"]).default("calibration"),
  SYNAPSE_WALLET_PRIVATE_KEY: z.string().trim().min(1),
  SYNAPSE_PROJECT_NAMESPACE: z.string().trim().min(1).default(COMPOSE_SYNAPSE_SOURCE),
  SYNAPSE_RPC_URL: z.string().trim().min(1).optional(),
  FILECOIN_CALIBRATION_RPC: z.string().trim().min(1).optional(),
  FILECOIN_MAINNET_RPC: z.string().trim().min(1).optional(),
  FILECOIN_DEVNET_RPC: z.string().trim().min(1).optional(),
});

interface LocalSynapseSessionRequest {
  agentWallet: string;
  deviceId: string;
  sessionKeyAddress: string;
  sessionKeyExpiresAt: number;
  depositAmount?: string;
}

interface SynapseRouteConfig {
  network: "calibration" | "mainnet" | "devnet";
  walletPrivateKey: `0x${string}`;
  source: typeof COMPOSE_SYNAPSE_SOURCE;
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
    case "devnet":
      return devnet;
    case "calibration":
    default:
      return calibration;
  }
}

function loadSynapseRouteConfig(env: NodeJS.ProcessEnv = process.env): SynapseRouteConfig {
  const parsed = EnvSchema.parse(env);
  const rpcUrl = parsed.SYNAPSE_RPC_URL
    || (parsed.SYNAPSE_NETWORK === "mainnet" ? parsed.FILECOIN_MAINNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "devnet" ? parsed.FILECOIN_DEVNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "calibration" ? parsed.FILECOIN_CALIBRATION_RPC : undefined)
    || null;
  const source = parsed.SYNAPSE_PROJECT_NAMESPACE.trim().toLowerCase();
  if (source !== COMPOSE_SYNAPSE_SOURCE) {
    throw new Error(`SYNAPSE_PROJECT_NAMESPACE must be "${COMPOSE_SYNAPSE_SOURCE}" for Compose mesh anchors`);
  }

  return {
    network: parsed.SYNAPSE_NETWORK,
    walletPrivateKey: normalizeHexPrivateKey(parsed.SYNAPSE_WALLET_PRIVATE_KEY),
    source,
    rpcUrl,
  };
}

function effectiveExpiry(requested: number, activeSessionExpiresAt: number): number {
  return normalizeSynapseExpiryMs(Math.min(requested, activeSessionExpiresAt));
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
    const account = privateKeyToAccount(config.walletPrivateKey);
    const chain = resolveSynapseChain(config.network);
    const walletClient = createWalletClient({
      account,
      chain,
      transport: config.rpcUrl ? http(config.rpcUrl) : http(),
    });

    const expiresAt = effectiveExpiry(sessionKeyExpiresAt, activeSession.expiresAt);

    await SessionKey.loginSync(walletClient, {
      address: sessionKeyAddress,
      expiresAt: BigInt(Math.floor(expiresAt / 1000)),
      origin: "compose.local.mesh",
    });

    const synapse = Synapse.create({
      account,
      chain,
      transport: config.rpcUrl ? http(config.rpcUrl) : http(),
      source: config.source,
      withCDN: false,
    });

    let depositExecuted = false;
    if (depositAmount > 0n) {
      await synapse.payments.deposit({
        amount: depositAmount,
      });
      depositExecuted = true;
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

  if (method === "POST" && path === "/api/local/synapse/session") {
    return handleEnsureLocalSynapseSession(event, corsHeaders);
  }

  return null;
}
