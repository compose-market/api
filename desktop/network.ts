import { randomUUID } from "crypto";
import { getActiveChainId } from "../x402/configs/chains.js";
import {
  redisDel,
  redisGet,
  getRedisClient,
  redisIncr,
  redisSet,
  redisSetNXEX,
  redisTTL,
} from "../x402/keys/redis.js";
import { getActiveSession } from "../x402/keys/index.js";
import { verifyComposeKey } from "../x402/keys/jwt.js";
import { extractComposeKeyFromHeader } from "../x402/keys/middleware.js";

export interface DesktopRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers: Record<string, string | undefined>;
  body?: string;
  queryStringParameters?: Record<string, string>;
}

export interface DesktopRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const CID_REGEX = /^[A-Za-z0-9._-]{32,}$/;
const DEVICE_ID_REGEX = /^[A-Za-z0-9._-]{8,128}$/;

const DESKTOP_LINK_TOKEN_PREFIX = "desktop:link-token:";
const DESKTOP_LINK_CONSUMED_PREFIX = "desktop:link-token-consumed:";
const DESKTOP_DEPLOYMENT_PREFIX = "desktop:deployment:";
const DESKTOP_LINK_TOKEN_TTL_SECONDS = 5 * 60;
const DESKTOP_LINK_CONSUMED_TTL_SECONDS = 30 * 60;
const DESKTOP_DEPLOYMENT_RECORD_VERSION = 1;
const DESKTOP_NETWORK_PEER_PREFIX = "desktop:network:peer:";
const DESKTOP_NETWORK_PEER_SET_PREFIX = "desktop:network:peer-set:";
const DESKTOP_NETWORK_PEER_TTL_SECONDS = 90;
const DESKTOP_NETWORK_UPSERT_RATE_PREFIX = "desktop:network:upsert:rate:";
const DESKTOP_NETWORK_UPSERT_RATE_WINDOW_SECONDS = 60;
const DESKTOP_NETWORK_UPSERT_RATE_LIMIT = 120;

interface DesktopLinkTokenRequest {
  agentWallet?: string;
  agentCardCid?: string;
  userAddress: string;
  chainId?: number;
  deviceId?: string;
}

interface DesktopRedeemRequest {
  token: string;
  deviceId: string;
}

interface DesktopDeploymentRegisterRequest {
  agentWallet: string;
  userAddress: string;
  composeKeyId: string;
  agentCardCid: string;
  desktopVersion: string;
  deployedAt: number;
  chainId?: number;
}

interface DesktopLinkTokenRecord {
  version: number;
  token: string;
  mode: "desktop-first" | "web-first";
  issuedAt: number;
  expiresAt: number;
  boundDeviceId: string | null;
  chainId: number;
  agentWallet: string;
  agentCardCid: string;
  userAddress: string;
  composeKeyId: string;
  sessionId: string;
  budget: string;
  duration: number;
}

interface DesktopPeerSummary {
  peerId: string;
  lastSeenAt: number;
  stale: boolean;
  caps: string[];
  listenMultiaddrs: string[];
  deviceId?: string;
  agentWallet?: string;
}

interface DesktopPeerUpsertRequest {
  userAddress: string;
  chainId?: number;
  agentWallet?: string;
  deviceId?: string;
  peers: DesktopPeerSummary[];
}

interface StoredDesktopPeerRecord {
  version: number;
  userAddress: string;
  chainId: number;
  peerId: string;
  agentWallet: string | null;
  deviceId: string | null;
  lastSeenAt: number;
  stale: boolean;
  caps: string[];
  listenMultiaddrs: string[];
  updatedAt: number;
}

interface DesktopDeploymentRecord {
  version: number;
  deploymentId: string;
  agentWallet: string;
  userAddress: string;
  composeKeyId: string;
  agentCardCid: string;
  desktopVersion: string;
  deployedAt: number;
  chainId: number;
  registeredAt: number;
  updatedAt: number;
}

function json(
  statusCode: number,
  payload: unknown,
  corsHeaders: Record<string, string>,
): DesktopRouteResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function getHeader(event: DesktopRouteEvent, name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}

function parseJsonBody<T>(event: DesktopRouteEvent): T {
  if (!event.body) {
    throw new Error("Request body is required");
  }
  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function normalizeWallet(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return ETH_ADDRESS_REGEX.test(normalized) ? normalized : null;
}

function parsePositiveInt(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return number;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return DEVICE_ID_REGEX.test(normalized) ? normalized : null;
}

async function validateDesktopAuthorization(
  event: DesktopRouteEvent,
  body: DesktopLinkTokenRequest,
): Promise<{
  userAddress: string;
  agentWallet: string | null;
  chainId: number;
  activeSession: {
    keyId: string;
    expiresAt: number;
    budgetLimit: number;
    budgetUsed: number;
    chainId: number;
  } | null;
}> {
  const userAddress = normalizeWallet(body.userAddress);
  if (!userAddress) {
    throw new Error("userAddress must be a valid wallet address");
  }

  const agentWallet = normalizeWallet(body.agentWallet || null);
  const chainId = body.chainId ? parsePositiveInt(body.chainId, "chainId") : getActiveChainId();

  const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
  if (!headerUserAddress) {
    throw new Error("x-session-user-address header is required");
  }
  if (headerUserAddress !== userAddress) {
    throw new Error("x-session-user-address must match userAddress");
  }

  const activeSession = await getActiveSession(userAddress, chainId);
  return {
    userAddress,
    agentWallet,
    chainId,
    activeSession: activeSession
      ? {
        keyId: activeSession.keyId,
        expiresAt: activeSession.expiresAt,
        budgetLimit: activeSession.budgetLimit,
        budgetUsed: activeSession.budgetUsed,
        chainId: activeSession.chainId ?? chainId,
      }
      : null,
  };
}

async function handleCreateDesktopLinkToken(
  event: DesktopRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
  try {
    const body = parseJsonBody<DesktopLinkTokenRequest>(event);
    const auth = await validateDesktopAuthorization(event, body);
    const parsedDeviceId = normalizeDeviceId(body.deviceId || null);
    const mode: DesktopLinkTokenRecord["mode"] = parsedDeviceId ? "desktop-first" : "web-first";
    const agentCardCid = typeof body.agentCardCid === "string" && body.agentCardCid.trim().length > 0
      ? parseRequiredString(body.agentCardCid, "agentCardCid")
      : "";
    if (agentCardCid && !CID_REGEX.test(agentCardCid)) {
      throw new Error("agentCardCid format is invalid");
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + DESKTOP_LINK_TOKEN_TTL_SECONDS * 1000;
    const token = `${randomUUID()}-${randomUUID()}`;

    const record: DesktopLinkTokenRecord = {
      version: 1,
      token,
      mode,
      issuedAt,
      expiresAt,
      boundDeviceId: parsedDeviceId,
      chainId: auth.chainId,
      agentWallet: auth.agentWallet || "",
      agentCardCid,
      userAddress: auth.userAddress,
      composeKeyId: auth.activeSession?.keyId || "",
      sessionId: auth.activeSession?.keyId || "",
      budget: auth.activeSession ? String(auth.activeSession.budgetLimit - auth.activeSession.budgetUsed) : "0",
      duration: auth.activeSession ? Math.max(0, auth.activeSession.expiresAt - issuedAt) : 0,
    };

    await redisSet(
      `${DESKTOP_LINK_TOKEN_PREFIX}${token}`,
      JSON.stringify(record),
      DESKTOP_LINK_TOKEN_TTL_SECONDS,
    );

    return json(
      201,
      {
        success: true,
        token,
        mode,
        expiresAt,
        deepLinkUrl: `manowar://open?token=${encodeURIComponent(token)}`,
        hasSession: Boolean(auth.activeSession),
      },
      corsHeaders,
    );
  } catch (error) {
    return json(
      400,
      {
        error: error instanceof Error ? error.message : "Invalid request",
      },
      corsHeaders,
    );
  }
}

async function handleRedeemDesktopLinkToken(
  event: DesktopRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
  let requestBody: DesktopRedeemRequest;
  try {
    requestBody = parseJsonBody<DesktopRedeemRequest>(event);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  let token: string;
  let deviceId: string;
  try {
    token = parseRequiredString(requestBody.token, "token");
    const parsedDevice = normalizeDeviceId(requestBody.deviceId);
    if (!parsedDevice) {
      throw new Error("deviceId is invalid");
    }
    deviceId = parsedDevice;
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  const linkTokenKey = `${DESKTOP_LINK_TOKEN_PREFIX}${token}`;
  const consumedKey = `${DESKTOP_LINK_CONSUMED_PREFIX}${token}`;

  const stored = await redisGet(linkTokenKey);
  if (!stored) {
    return json(404, { error: "Desktop link token not found or expired" }, corsHeaders);
  }

  let record: DesktopLinkTokenRecord;
  try {
    record = JSON.parse(stored) as DesktopLinkTokenRecord;
  } catch {
    return json(500, { error: "Corrupted desktop link token payload" }, corsHeaders);
  }

  if (record.boundDeviceId && record.boundDeviceId !== deviceId) {
    return json(403, { error: "Desktop link token is bound to a different deviceId" }, corsHeaders);
  }

  const consumed = await redisSetNXEX(consumedKey, deviceId, DESKTOP_LINK_CONSUMED_TTL_SECONDS);
  if (!consumed) {
    return json(409, { error: "Desktop link token already redeemed" }, corsHeaders);
  }

  await redisDel(linkTokenKey);

  const activeSession = await getActiveSession(record.userAddress, record.chainId);
  const composeKey = activeSession && record.composeKeyId
    ? {
      keyId: record.composeKeyId,
      token: activeSession.token,
      expiresAt: activeSession.expiresAt,
    }
    : {
      keyId: "",
      token: "",
      expiresAt: 0,
    };

  const session = activeSession
    ? {
      sessionId: record.sessionId || activeSession.keyId,
      budget: record.budget || String(activeSession.budgetLimit - activeSession.budgetUsed),
      duration: record.duration || Math.max(0, activeSession.expiresAt - Date.now()),
      expiresAt: activeSession.expiresAt,
    }
    : {
      sessionId: "",
      budget: "0",
      duration: 0,
      expiresAt: 0,
    };

  return json(
    200,
    {
        success: true,
        context: {
        agentWallet: record.agentWallet || record.userAddress,
        userAddress: record.userAddress,
        chainId: record.chainId,
        composeKey,
        session,
        market: {
          entry: "desktop",
          agentWallet: record.agentWallet,
          agentCardCid: record.agentCardCid || null,
        },
        deviceId: record.boundDeviceId || deviceId,
        linkMode: record.mode || "desktop-first",
        hasSession: Boolean(activeSession),
      },
    },
    corsHeaders,
  );
}

function peerSetKey(userAddress: string, chainId: number): string {
  return `${DESKTOP_NETWORK_PEER_SET_PREFIX}${userAddress}:${chainId}`;
}

function peerRecordKey(userAddress: string, chainId: number, peerId: string): string {
  return `${DESKTOP_NETWORK_PEER_PREFIX}${userAddress}:${chainId}:${peerId}`;
}

function uniqueNormalizedStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const dedup = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized) continue;
    dedup.add(normalized);
  }
  return Array.from(dedup);
}

async function enforcePeerUpsertRateLimit(userAddress: string, chainId: number): Promise<void> {
  const key = `${DESKTOP_NETWORK_UPSERT_RATE_PREFIX}${userAddress}:${chainId}`;
  const count = await redisIncr(key);
  if (count === 1) {
    await redisSet(key, String(count), DESKTOP_NETWORK_UPSERT_RATE_WINDOW_SECONDS);
  } else {
    const ttl = await redisTTL(key);
    if (ttl < 0) {
      await redisSet(key, String(count), DESKTOP_NETWORK_UPSERT_RATE_WINDOW_SECONDS);
    } else {
      await redisSet(key, String(count), ttl);
    }
  }
  if (count > DESKTOP_NETWORK_UPSERT_RATE_LIMIT) {
    throw new Error("Peer upsert rate limit exceeded");
  }
}

async function handleUpsertDesktopNetworkPeers(
  event: DesktopRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
  let body: DesktopPeerUpsertRequest;
  try {
    body = parseJsonBody<DesktopPeerUpsertRequest>(event);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  try {
    const userAddress = normalizeWallet(body.userAddress);
    if (!userAddress) {
      throw new Error("userAddress must be a valid wallet address");
    }
    const chainId = body.chainId ? parsePositiveInt(body.chainId, "chainId") : getActiveChainId();
    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress || headerUserAddress !== userAddress) {
      throw new Error("x-session-user-address must match userAddress");
    }

    await enforcePeerUpsertRateLimit(userAddress, chainId);

    const peers = Array.isArray(body.peers) ? body.peers : [];
    const safePeers = peers
      .map((peer) => ({
        peerId: typeof peer.peerId === "string" ? peer.peerId.trim() : "",
        lastSeenAt: Number.isFinite(peer.lastSeenAt) ? Number(peer.lastSeenAt) : Date.now(),
        stale: Boolean(peer.stale),
        caps: uniqueNormalizedStrings(peer.caps),
        listenMultiaddrs: uniqueNormalizedStrings(peer.listenMultiaddrs),
      }))
      .filter((peer) => peer.peerId.length > 0)
      .slice(0, 512);

    const setKey = peerSetKey(userAddress, chainId);
    const agentWallet = normalizeWallet(body.agentWallet || null);
    const deviceId = normalizeDeviceId(body.deviceId || null);
    const updatedAt = Date.now();
    const redis = await getRedisClient();

    for (const peer of safePeers) {
      const key = peerRecordKey(userAddress, chainId, peer.peerId);
      const record: StoredDesktopPeerRecord = {
        version: 1,
        userAddress,
        chainId,
        peerId: peer.peerId,
        agentWallet,
        deviceId,
        lastSeenAt: peer.lastSeenAt,
        stale: peer.stale,
        caps: peer.caps,
        listenMultiaddrs: peer.listenMultiaddrs,
        updatedAt,
      };
      await redis.setEx(key, DESKTOP_NETWORK_PEER_TTL_SECONDS, JSON.stringify(record));
      await redis.sAdd(setKey, peer.peerId);
    }

    await redis.expire(setKey, DESKTOP_NETWORK_PEER_TTL_SECONDS);
    return json(200, {
      success: true,
      upserted: safePeers.length,
      chainId,
    }, corsHeaders);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }
}

async function handleListDesktopNetworkPeers(
  event: DesktopRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
  try {
    const rawUser = event.queryStringParameters?.userAddress;
    const userAddress = normalizeWallet(rawUser);
    if (!userAddress) {
      throw new Error("userAddress query parameter is required");
    }
    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress || headerUserAddress !== userAddress) {
      throw new Error("x-session-user-address must match userAddress");
    }
    const chainIdRaw = event.queryStringParameters?.chainId;
    const chainId = chainIdRaw ? parsePositiveInt(chainIdRaw, "chainId") : getActiveChainId();
    const filterWallet = normalizeWallet(event.queryStringParameters?.agentWallet || null);
    const setKey = peerSetKey(userAddress, chainId);
    const redis = await getRedisClient();
    const peerIds = await redis.sMembers(setKey);
    const peers: StoredDesktopPeerRecord[] = [];
    const stalePeerIds: string[] = [];

    for (const peerId of peerIds) {
      const key = peerRecordKey(userAddress, chainId, peerId);
      const raw = await redis.get(key);
      if (!raw) {
        stalePeerIds.push(peerId);
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as StoredDesktopPeerRecord;
        if (filterWallet && parsed.agentWallet && parsed.agentWallet !== filterWallet) {
          continue;
        }
        peers.push(parsed);
      } catch {
        stalePeerIds.push(peerId);
      }
    }

    if (stalePeerIds.length > 0) {
      await redis.sRem(setKey, stalePeerIds);
    }

    peers.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    return json(200, {
      success: true,
      chainId,
      userAddress,
      peers: peers.map((peer) => ({
        peerId: peer.peerId,
        agentWallet: peer.agentWallet,
        deviceId: peer.deviceId,
        lastSeenAt: peer.lastSeenAt,
        stale: peer.stale,
        caps: peer.caps,
        listenMultiaddrs: peer.listenMultiaddrs,
      })),
    }, corsHeaders);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }
}

async function handleRegisterDesktopDeployment(
  event: DesktopRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
  let body: DesktopDeploymentRegisterRequest;
  try {
    body = parseJsonBody<DesktopDeploymentRegisterRequest>(event);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  try {
    const agentWallet = normalizeWallet(body.agentWallet);
    const userAddress = normalizeWallet(body.userAddress);
    if (!agentWallet) throw new Error("agentWallet must be a valid wallet address");
    if (!userAddress) throw new Error("userAddress must be a valid wallet address");

    const composeKeyId = parseRequiredString(body.composeKeyId, "composeKeyId");
    const agentCardCid = parseRequiredString(body.agentCardCid, "agentCardCid");
    if (!CID_REGEX.test(agentCardCid)) throw new Error("agentCardCid format is invalid");
    const desktopVersion = parseRequiredString(body.desktopVersion, "desktopVersion");
    const deployedAt = parsePositiveInt(body.deployedAt, "deployedAt");
    const chainId = body.chainId ? parsePositiveInt(body.chainId, "chainId") : getActiveChainId();

    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress || headerUserAddress !== userAddress) {
      throw new Error("x-session-user-address must match userAddress");
    }

    const authHeader = getHeader(event, "authorization");
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);
    if (!composeKeyToken) throw new Error("Authorization header with Compose Key token is required");

    const payload = verifyComposeKey(composeKeyToken);
    if (!payload) throw new Error("Invalid or expired Compose Key token");
    if (payload.sub.toLowerCase() !== userAddress) {
      throw new Error("Compose Key token user does not match userAddress");
    }
    if (payload.keyId !== composeKeyId) {
      throw new Error("Compose Key token keyId does not match composeKeyId");
    }

    const activeSession = await getActiveSession(userAddress, chainId);
    if (!activeSession || activeSession.keyId !== composeKeyId) {
      throw new Error("composeKeyId does not match active session");
    }

    const deploymentKey = `${DESKTOP_DEPLOYMENT_PREFIX}${userAddress}:${agentWallet}:${composeKeyId}`;
    const existing = await redisGet(deploymentKey);
    if (existing) {
      const existingRecord = JSON.parse(existing) as DesktopDeploymentRecord;
      return json(200, {
        success: true,
        idempotent: true,
        deployment: existingRecord,
      }, corsHeaders);
    }

    const now = Date.now();
    const record: DesktopDeploymentRecord = {
      version: DESKTOP_DEPLOYMENT_RECORD_VERSION,
      deploymentId: randomUUID(),
      agentWallet,
      userAddress,
      composeKeyId,
      agentCardCid,
      desktopVersion,
      deployedAt,
      chainId,
      registeredAt: now,
      updatedAt: now,
    };

    await redisSet(deploymentKey, JSON.stringify(record));

    return json(201, {
      success: true,
      idempotent: false,
      deployment: record,
    }, corsHeaders);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }
}

export async function handleDesktopNetworkRoute(
  event: DesktopRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult | null> {
  const path = event.rawPath;
  const method = event.requestContext.http.method;

  if (!path.startsWith("/api/desktop/")) {
    return null;
  }

  if (method === "POST" && path === "/api/desktop/link-token") {
    return handleCreateDesktopLinkToken(event, corsHeaders);
  }
  if (method === "POST" && path === "/api/desktop/link-token/redeem") {
    return handleRedeemDesktopLinkToken(event, corsHeaders);
  }
  if (method === "POST" && path === "/api/desktop/deployments/register") {
    return handleRegisterDesktopDeployment(event, corsHeaders);
  }
  if (method === "POST" && path === "/api/desktop/network/peers/upsert") {
    return handleUpsertDesktopNetworkPeers(event, corsHeaders);
  }
  if (method === "GET" && path === "/api/desktop/network/peers") {
    return handleListDesktopNetworkPeers(event, corsHeaders);
  }

  return null;
}
