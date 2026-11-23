import { randomUUID } from "crypto";
import { isNetworkId, type NetworkId } from "../x402/configs/chains.js";
import {
  valkeyDel,
  valkeyGet,
  getValkeyClient,
  valkeyIncr,
  valkeySet,
  valkeySetNXEX,
  valkeyTTL,
} from "../x402/keys/valkey.js";
import { getActiveSessionStatus } from "../x402/keys/index.js";
import { verifyKey } from "../x402/keys/jwt.js";
import { extractKeyFromHeader } from "../x402/keys/middleware.js";

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
  network: NetworkId;
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
  keyId: string;
  agentCardCid: string;
  localVersion: string;
  deployedAt: number;
  network: NetworkId;
}

interface LocalLinkTokenRecord {
  version: number;
  token: string;
  mode: "local-first" | "web-first";
  issuedAt: number;
  expiresAt: number;
  boundDeviceId: string | null;
  network: NetworkId;
  agentWallet: string;
  agentCardCid: string;
  userAddress: string;
  keyId: string;
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
  network: NetworkId;
  agentWallet?: string;
  deviceId?: string;
  peers: LocalPeerSummary[];
}

interface StoredLocalPeerRecord {
  version: number;
  userAddress: string;
  network: NetworkId;
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
  keyId: string;
  agentCardCid: string;
  localVersion: string;
  deployedAt: number;
  network: NetworkId;
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

function parseNetwork(value: unknown): NetworkId {
  if (typeof value !== "string" || !isNetworkId(value)) {
    throw Object.assign(new Error("network must be a supported CAIP-2 network"), { statusCode: 400 });
  }
  return value;
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

function authError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 401 });
}

function errorStatusCode(error: unknown, fallback = 400): number {
  if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number") {
    return (error as { statusCode: number }).statusCode;
  }
  return fallback;
}

async function authorizeKeySession(event: LocalRouteEvent, userAddress: string, network: NetworkId) {
  const keyToken = extractKeyFromHeader(getHeader(event, "authorization"));
  if (!keyToken) {
    throw authError("Authorization header with Compose Key token is required");
  }

  const payload = verifyKey(keyToken);
  if (!payload) {
    throw authError("Invalid or expired Compose Key token");
  }
  if (payload.sub.toLowerCase() !== userAddress) {
    throw authError("Compose Key token user does not match x-session-user-address");
  }
  if (payload.network && payload.network !== network) {
    throw authError("Compose Key token network does not match requested network");
  }

  const activeSession = (await getActiveSessionStatus(userAddress, network)).session;
  if (!activeSession || activeSession.keyId !== payload.keyId) {
    throw authError("Compose Key token does not match the active session");
  }

  return {
    payload,
    activeSession,
  };
}

async function buildRedeemedContext(args: {
  userAddress: string;
  network: NetworkId;
  agentWallet: string;
  agentCardCid: string;
  deviceId: string;
  keyId?: string;
  sessionId?: string;
  budget?: string;
  duration?: number;
}) {
  const activeSession = (await getActiveSessionStatus(args.userAddress, args.network)).session;
  const key = activeSession && args.keyId
    ? {
      keyId: args.keyId,
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
    network: args.network,
    key,
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
  network: NetworkId;
  activeSession: {
    keyId: string;
    expiresAt: number;
    budgetLimit: number;
    budgetUsed: number;
    network: NetworkId;
  } | null;
}> {
  const userAddress = normalizeWallet(body.userAddress);
  if (!userAddress) {
    throw new Error("userAddress must be a valid wallet address");
  }

  const agentWallet = normalizeWallet(body.agentWallet || null);
  const network = parseNetwork(body.network);
  const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
  if (!headerUserAddress || headerUserAddress !== userAddress) {
    throw new Error("x-session-user-address must match userAddress");
  }

  const { activeSession } = await authorizeKeySession(event, userAddress, network);
  return {
    userAddress,
    agentWallet,
    network,
    activeSession: {
      keyId: activeSession.keyId,
      expiresAt: activeSession.expiresAt,
      budgetLimit: activeSession.budgetLimit,
      budgetUsed: activeSession.budgetUsed,
      network: activeSession.network ?? network,
    },
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
      network: auth.network,
      agentWallet: auth.agentWallet || "",
      agentCardCid,
      userAddress: auth.userAddress,
      keyId: auth.activeSession?.keyId || "",
      sessionId: auth.activeSession?.keyId || "",
      budget: auth.activeSession ? String(auth.activeSession.budgetLimit - auth.activeSession.budgetUsed) : "0",
      duration: auth.activeSession ? Math.max(0, auth.activeSession.expiresAt - issuedAt) : 0,
    };

    await valkeySet(
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

  const stored = await valkeyGet(linkTokenKey);
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

  const consumed = await valkeySetNXEX(consumedKey, deviceId, LOCAL_LINK_CONSUMED_TTL_SECONDS);
  if (!consumed) {
    return json(409, { error: "Local link token already redeemed" }, corsHeaders);
  }

  await valkeyDel(linkTokenKey);
  const context = await buildRedeemedContext({
    userAddress: record.userAddress,
    network: record.network,
    agentWallet: record.agentWallet || record.userAddress,
    agentCardCid: record.agentCardCid || "",
    deviceId: record.boundDeviceId || deviceId,
    keyId: record.keyId,
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

function peerSetKey(userAddress: string, network: NetworkId): string {
  return `${LOCAL_NETWORK_PEER_SET_PREFIX}${userAddress}:${network}`;
}

function peerRecordKey(userAddress: string, network: NetworkId, peerId: string): string {
  return `${LOCAL_NETWORK_PEER_PREFIX}${userAddress}:${network}:${peerId}`;
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

async function enforcePeerUpsertRateLimit(userAddress: string, network: NetworkId): Promise<void> {
  const key = `${LOCAL_NETWORK_UPSERT_RATE_PREFIX}${userAddress}:${network}`;
  const count = await valkeyIncr(key);
  if (count === 1) {
    await valkeySet(key, String(count), LOCAL_NETWORK_UPSERT_RATE_WINDOW_SECONDS);
  } else {
    const ttl = await valkeyTTL(key);
    if (ttl < 0) {
      await valkeySet(key, String(count), LOCAL_NETWORK_UPSERT_RATE_WINDOW_SECONDS);
    } else {
      await valkeySet(key, String(count), ttl);
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
    const network = parseNetwork(body.network);
    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress || headerUserAddress !== userAddress) {
      throw new Error("x-session-user-address must match userAddress");
    }

    await enforcePeerUpsertRateLimit(userAddress, network);

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

    const setKey = peerSetKey(userAddress, network);
    const agentWallet = normalizeWallet(body.agentWallet || null);
    const deviceId = normalizeDeviceId(body.deviceId || null);
    const updatedAt = Date.now();
    const valkey = await getValkeyClient();

    for (const peer of safePeers) {
      const key = peerRecordKey(userAddress, network, peer.peerId);
      const record: StoredLocalPeerRecord = {
        version: 1,
        userAddress,
        network,
        peerId: peer.peerId,
        agentWallet,
        deviceId,
        lastSeenAt: peer.lastSeenAt,
        stale: peer.stale,
        caps: peer.caps,
        listenMultiaddrs: peer.listenMultiaddrs,
        updatedAt,
      };
      await valkey.setex(key, LOCAL_NETWORK_PEER_TTL_SECONDS, JSON.stringify(record));
      await valkey.sadd(setKey, peer.peerId);
    }

    await valkey.expire(setKey, LOCAL_NETWORK_PEER_TTL_SECONDS);
    return json(200, {
      success: true,
      upserted: safePeers.length,
      network,
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
    const networkRaw = event.queryStringParameters?.network;
    const network = parseNetwork(networkRaw);
    const filterWallet = normalizeWallet(event.queryStringParameters?.agentWallet || null);
    const setKey = peerSetKey(userAddress, network);
    const valkey = await getValkeyClient();
    const peerIds = await valkey.smembers(setKey);
    const peers: StoredLocalPeerRecord[] = [];
    const stalePeerIds: string[] = [];

    for (const peerId of peerIds) {
      const key = peerRecordKey(userAddress, network, peerId);
      const raw = await valkey.get(key);
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
      await valkey.srem(setKey, stalePeerIds);
    }

    peers.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    return json(200, {
      success: true,
      network,
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

    const keyId = parseRequiredString(body.keyId, "keyId");
    const agentCardCid = parseRequiredString(body.agentCardCid, "agentCardCid");
    if (!CID_REGEX.test(agentCardCid)) throw new Error("agentCardCid format is invalid");
    const localVersion = parseRequiredString(body.localVersion, "localVersion");
    const deployedAt = parsePositiveInt(body.deployedAt, "deployedAt");
    const network = parseNetwork(body.network);

    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress || headerUserAddress !== userAddress) {
      throw new Error("x-session-user-address must match userAddress");
    }

    const authHeader = getHeader(event, "authorization");
    const keyToken = extractKeyFromHeader(authHeader);
    if (!keyToken) throw new Error("Authorization header with Compose Key token is required");

    const payload = verifyKey(keyToken);
    if (!payload) throw new Error("Invalid or expired Compose Key token");
    if (payload.sub.toLowerCase() !== userAddress) {
      throw new Error("Compose Key token user does not match userAddress");
    }
    if (payload.keyId !== keyId) {
      throw new Error("Compose Key token keyId does not match keyId");
    }

    const activeSession = (await getActiveSessionStatus(userAddress, network)).session;
    if (!activeSession || activeSession.keyId !== keyId) {
      throw new Error("keyId does not match active session");
    }

    const deploymentKey = `${LOCAL_DEPLOYMENT_PREFIX}${userAddress}:${agentWallet}:${keyId}`;
    const existing = await valkeyGet(deploymentKey);
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
      keyId,
      agentCardCid,
      localVersion,
      deployedAt,
      network,
      registeredAt: now,
      updatedAt: now,
    };

    await valkeySet(deploymentKey, JSON.stringify(record));

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
