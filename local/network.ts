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
import { getActiveSessionStatus } from "../x402/keys/index.js";
import { verifyComposeKey } from "../x402/keys/jwt.js";
import { extractComposeKeyFromHeader } from "../x402/keys/middleware.js";

export interface LocalRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers: Record<string, string | undefined>;
  body?: string;
  queryStringParameters?: Record<string, string>;
}

export interface LocalRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const CID_REGEX = /^[A-Za-z0-9._-]{32,}$/;
const DEVICE_ID_REGEX = /^[A-Za-z0-9._-]{8,128}$/;

const LOCAL_LINK_TOKEN_PREFIX = "local:link-token:";
const LOCAL_LINK_CONSUMED_PREFIX = "local:link-token-consumed:";
const LOCAL_DEPLOYMENT_PREFIX = "local:deployment:";
const LOCAL_LINK_TOKEN_TTL_SECONDS = 5 * 60;
const LOCAL_LINK_CONSUMED_TTL_SECONDS = 30 * 60;
const LOCAL_DEPLOYMENT_RECORD_VERSION = 1;
const LOCAL_NETWORK_PEER_PREFIX = "local:network:peer:";
const LOCAL_NETWORK_PEER_SET_PREFIX = "local:network:peer-set:";
const LOCAL_NETWORK_PEER_TTL_SECONDS = 90;
const LOCAL_NETWORK_UPSERT_RATE_PREFIX = "local:network:upsert:rate:";
const LOCAL_NETWORK_UPSERT_RATE_WINDOW_SECONDS = 60;
const LOCAL_NETWORK_UPSERT_RATE_LIMIT = 120;

interface LocalLinkTokenRequest {
  agentWallet?: string;
  agentCardCid?: string;
  userAddress: string;
  chainId?: number;
  deviceId?: string;
}

interface LocalRedeemRequest {
  token?: string;
  deviceId: string;
  connectedUserAddress?: string;
}

interface LocalDeploymentRegisterRequest {
  agentWallet: string;
  userAddress: string;
  composeKeyId: string;
  agentCardCid: string;
  localVersion: string;
  deployedAt: number;
  chainId?: number;
}

interface LocalLinkTokenRecord {
  version: number;
  token: string;
  mode: "local-first" | "web-first";
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

interface LocalPeerSummary {
  peerId: string;
  lastSeenAt: number;
  stale: boolean;
  caps: string[];
  listenMultiaddrs: string[];
  deviceId?: string;
  agentWallet?: string;
}

interface LocalPeerUpsertRequest {
  userAddress: string;
  chainId?: number;
  agentWallet?: string;
  deviceId?: string;
  peers: LocalPeerSummary[];
}

interface StoredLocalPeerRecord {
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

interface LocalDeploymentRecord {
  version: number;
  deploymentId: string;
  agentWallet: string;
  userAddress: string;
  composeKeyId: string;
  agentCardCid: string;
  localVersion: string;
  deployedAt: number;
  chainId: number;
  registeredAt: number;
  updatedAt: number;
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

async function authorizeComposeKeySession(event: LocalRouteEvent, userAddress: string, chainId: number) {
  const composeKeyToken = extractComposeKeyFromHeader(getHeader(event, "authorization"));
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

  return {
    payload,
    activeSession,
  };
}

async function buildRedeemedContext(args: {
  userAddress: string;
  chainId: number;
  agentWallet: string;
  agentCardCid: string;
  deviceId: string;
  composeKeyId?: string;
  sessionId?: string;
  budget?: string;
  duration?: number;
}) {
  const activeSession = (await getActiveSessionStatus(args.userAddress, args.chainId)).session;
  const composeKey = activeSession && args.composeKeyId
    ? {
      keyId: args.composeKeyId,
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
      sessionId: args.sessionId || activeSession.keyId,
      budget: args.budget || String(activeSession.budgetLimit - activeSession.budgetUsed),
      duration: args.duration || Math.max(0, activeSession.expiresAt - Date.now()),
      expiresAt: activeSession.expiresAt,
    }
    : {
      sessionId: "",
      budget: "0",
      duration: 0,
      expiresAt: 0,
    };

  return {
    agentWallet: args.agentWallet || args.userAddress,
    userAddress: args.userAddress,
    chainId: args.chainId,
    composeKey,
    session,
    market: {
      entry: "local",
      agentWallet: args.agentWallet,
      agentCardCid: args.agentCardCid || null,
    },
    deviceId: args.deviceId,
    hasSession: Boolean(activeSession),
  };
}

async function validateLocalAuthorization(
  event: LocalRouteEvent,
  body: LocalLinkTokenRequest,
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
  if (!headerUserAddress || headerUserAddress !== userAddress) {
    throw new Error("x-session-user-address must match userAddress");
  }

  if (extractComposeKeyFromHeader(getHeader(event, "authorization"))) {
    await authorizeComposeKeySession(event, userAddress, chainId);
  }

  const activeSession = (await getActiveSessionStatus(userAddress, chainId)).session;
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

async function handleCreateLocalLinkToken(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult> {
  try {
    const body = parseJsonBody<LocalLinkTokenRequest>(event);
    const auth = await validateLocalAuthorization(event, body);
    const parsedDeviceId = normalizeDeviceId(body.deviceId || null);
    const mode: LocalLinkTokenRecord["mode"] = parsedDeviceId ? "local-first" : "web-first";
    const agentCardCid = typeof body.agentCardCid === "string" && body.agentCardCid.trim().length > 0
      ? parseRequiredString(body.agentCardCid, "agentCardCid")
      : "";
    if (agentCardCid && !CID_REGEX.test(agentCardCid)) {
      throw new Error("agentCardCid format is invalid");
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + LOCAL_LINK_TOKEN_TTL_SECONDS * 1000;
    const token = `${randomUUID()}-${randomUUID()}`;

    const record: LocalLinkTokenRecord = {
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
      `${LOCAL_LINK_TOKEN_PREFIX}${token}`,
      JSON.stringify(record),
      LOCAL_LINK_TOKEN_TTL_SECONDS,
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

async function handleRedeemLocalLinkToken(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult> {
  let requestBody: LocalRedeemRequest;
  try {
    requestBody = parseJsonBody<LocalRedeemRequest>(event);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  let token: string | null = null;
  let deviceId: string;
  let connectedUserAddress: string | null = null;
  try {
    const parsedDevice = normalizeDeviceId(requestBody.deviceId);
    if (!parsedDevice) {
      throw new Error("deviceId is invalid");
    }
    deviceId = parsedDevice;
    connectedUserAddress = normalizeWallet(requestBody.connectedUserAddress || null);
    token = typeof requestBody.token === "string" && requestBody.token.trim().length > 0
      ? parseRequiredString(requestBody.token, "token")
      : null;
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }

  if (!token) {
    return json(400, { error: "token is required" }, corsHeaders);
  }

  const linkTokenKey = `${LOCAL_LINK_TOKEN_PREFIX}${token}`;
  const consumedKey = `${LOCAL_LINK_CONSUMED_PREFIX}${token}`;

  const stored = await redisGet(linkTokenKey);
  if (!stored) {
    return json(404, { error: "Local link token not found or expired" }, corsHeaders);
  }

  let record: LocalLinkTokenRecord;
  try {
    record = JSON.parse(stored) as LocalLinkTokenRecord;
  } catch {
    return json(500, { error: "Corrupted local link token payload" }, corsHeaders);
  }

  if (record.boundDeviceId && record.boundDeviceId !== deviceId) {
    return json(403, { error: "Local link token is bound to a different deviceId" }, corsHeaders);
  }
  if (connectedUserAddress && connectedUserAddress !== record.userAddress) {
    return json(403, { error: "Deep-link userAddress does not match the connected Mesh wallet" }, corsHeaders);
  }

  const consumed = await redisSetNXEX(consumedKey, deviceId, LOCAL_LINK_CONSUMED_TTL_SECONDS);
  if (!consumed) {
    return json(409, { error: "Local link token already redeemed" }, corsHeaders);
  }

  await redisDel(linkTokenKey);
  const context = await buildRedeemedContext({
    userAddress: record.userAddress,
    chainId: record.chainId,
    agentWallet: record.agentWallet || record.userAddress,
    agentCardCid: record.agentCardCid || "",
    deviceId: record.boundDeviceId || deviceId,
    composeKeyId: record.composeKeyId,
    sessionId: record.sessionId,
    budget: record.budget,
    duration: record.duration,
  });

  return json(
    200,
    {
      success: true,
      context: {
        ...context,
        linkMode: record.mode || "local-first",
      },
    },
    corsHeaders,
  );
}

function peerSetKey(userAddress: string, chainId: number): string {
  return `${LOCAL_NETWORK_PEER_SET_PREFIX}${userAddress}:${chainId}`;
}

function peerRecordKey(userAddress: string, chainId: number, peerId: string): string {
  return `${LOCAL_NETWORK_PEER_PREFIX}${userAddress}:${chainId}:${peerId}`;
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
  const key = `${LOCAL_NETWORK_UPSERT_RATE_PREFIX}${userAddress}:${chainId}`;
  const count = await redisIncr(key);
  if (count === 1) {
    await redisSet(key, String(count), LOCAL_NETWORK_UPSERT_RATE_WINDOW_SECONDS);
  } else {
    const ttl = await redisTTL(key);
    if (ttl < 0) {
      await redisSet(key, String(count), LOCAL_NETWORK_UPSERT_RATE_WINDOW_SECONDS);
    } else {
      await redisSet(key, String(count), ttl);
    }
  }
  if (count > LOCAL_NETWORK_UPSERT_RATE_LIMIT) {
    throw new Error("Peer upsert rate limit exceeded");
  }
}

async function handleUpsertLocalNetworkPeers(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult> {
  let body: LocalPeerUpsertRequest;
  try {
    body = parseJsonBody<LocalPeerUpsertRequest>(event);
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
      const record: StoredLocalPeerRecord = {
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
      await redis.setEx(key, LOCAL_NETWORK_PEER_TTL_SECONDS, JSON.stringify(record));
      await redis.sAdd(setKey, peer.peerId);
    }

    await redis.expire(setKey, LOCAL_NETWORK_PEER_TTL_SECONDS);
    return json(200, {
      success: true,
      upserted: safePeers.length,
      chainId,
    }, corsHeaders);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "Invalid request" }, corsHeaders);
  }
}

async function handleListLocalNetworkPeers(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult> {
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
    const peers: StoredLocalPeerRecord[] = [];
    const stalePeerIds: string[] = [];

    for (const peerId of peerIds) {
      const key = peerRecordKey(userAddress, chainId, peerId);
      const raw = await redis.get(key);
      if (!raw) {
        stalePeerIds.push(peerId);
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as StoredLocalPeerRecord;
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

async function handleRegisterLocalDeployment(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult> {
  let body: LocalDeploymentRegisterRequest;
  try {
    body = parseJsonBody<LocalDeploymentRegisterRequest>(event);
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
    const localVersion = parseRequiredString(body.localVersion, "localVersion");
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

    const activeSession = (await getActiveSessionStatus(userAddress, chainId)).session;
    if (!activeSession || activeSession.keyId !== composeKeyId) {
      throw new Error("composeKeyId does not match active session");
    }

    const deploymentKey = `${LOCAL_DEPLOYMENT_PREFIX}${userAddress}:${agentWallet}:${composeKeyId}`;
    const existing = await redisGet(deploymentKey);
    if (existing) {
      const existingRecord = JSON.parse(existing) as LocalDeploymentRecord;
      return json(200, {
        success: true,
        idempotent: true,
        deployment: existingRecord,
      }, corsHeaders);
    }

    const now = Date.now();
    const record: LocalDeploymentRecord = {
      version: LOCAL_DEPLOYMENT_RECORD_VERSION,
      deploymentId: randomUUID(),
      agentWallet,
      userAddress,
      composeKeyId,
      agentCardCid,
      localVersion,
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

export async function handleLocalNetworkRoute(
  event: LocalRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<LocalRouteResult | null> {
  const path = event.rawPath;
  const method = event.requestContext.http.method;

  if (!path.startsWith("/api/local/")) {
    return null;
  }

  if (method === "POST" && path === "/api/local/link-token") {
    return handleCreateLocalLinkToken(event, corsHeaders);
  }
  if (method === "POST" && path === "/api/local/link-token/redeem") {
    return handleRedeemLocalLinkToken(event, corsHeaders);
  }
  if (method === "POST" && path === "/api/local/deployments/register") {
    return handleRegisterLocalDeployment(event, corsHeaders);
  }
  if (method === "POST" && path === "/api/local/network/peers/upsert") {
    return handleUpsertLocalNetworkPeers(event, corsHeaders);
  }
  if (method === "GET" && path === "/api/local/network/peers") {
    return handleListLocalNetworkPeers(event, corsHeaders);
  }

  return null;
}
