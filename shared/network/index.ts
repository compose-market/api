import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod";
import { getActiveChainId } from "../configs/chains.js";
import {
    redisDel,
    redisGet,
    redisSAdd,
    redisSMembers,
    redisSRem,
    redisSet,
    redisSetNXEX,
} from "../configs/redis.js";
import { getActiveSession } from "../keys/index.js";
import { verifyComposeKey } from "../keys/jwt.js";
import { extractComposeKeyFromHeader } from "../keys/middleware.js";

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
const PEER_ID_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,96}$/;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

const DESKTOP_LINK_TOKEN_PREFIX = "desktop:link-token:";
const DESKTOP_LINK_CONSUMED_PREFIX = "desktop:link-token-consumed:";
const DESKTOP_DEPLOYMENT_PREFIX = "desktop:deployment:";
const DESKTOP_LINK_TOKEN_TTL_SECONDS = 5 * 60;
const DESKTOP_LINK_CONSUMED_TTL_SECONDS = 30 * 60;
const DESKTOP_DEPLOYMENT_RECORD_VERSION = 1;

const DESKTOP_NETWORK_TOKEN_PREFIX = "desktop:network:token:";
const DESKTOP_NETWORK_TOKEN_BEARER_PREFIX = "desktopnet-";
const DESKTOP_NETWORK_TOKEN_VERSION = 1;
const DESKTOP_NETWORK_TOKEN_TTL_SECONDS = 5 * 60;

const DESKTOP_NETWORK_PRESENCE_PREFIX = "desktop:network:presence:";
const DESKTOP_NETWORK_PRESENCE_RECORD_VERSION = 1;
const DESKTOP_NETWORK_PRESENCE_MIN_TTL_SECONDS = 30;
const DESKTOP_NETWORK_PRESENCE_MAX_TTL_SECONDS = 10 * 60;
const DESKTOP_NETWORK_PRESENCE_DEFAULT_TTL_SECONDS = 90;
const DESKTOP_NETWORK_LIST_DEFAULT_LIMIT = 150;
const DESKTOP_NETWORK_LIST_MAX_LIMIT = 500;

const DESKTOP_NETWORK_GOSSIP_TOPIC_DEFAULT = "compose/global/presence/v1";
const DESKTOP_NETWORK_KAD_PROTOCOL_DEFAULT = "/compose-market/desktop/kad/1.0.0";
const DESKTOP_NETWORK_HEARTBEAT_DEFAULT_MS = 30_000;

const DESKTOP_NETWORK_SEED_PREFIX = "desktop:network:seed:";
const DESKTOP_NETWORK_SEED_INDEX_KEY = "desktop:network:seed:index";
const DESKTOP_NETWORK_SEED_RECORD_VERSION = 1;
const DESKTOP_NETWORK_SEED_MIN_TTL_SECONDS = 30;
const DESKTOP_NETWORK_SEED_MAX_TTL_SECONDS = 60 * 60;
const DESKTOP_NETWORK_SEED_DEFAULT_TTL_SECONDS = 5 * 60;
const DESKTOP_NETWORK_SEED_LIST_MAX_LIMIT = 500;

interface DesktopLinkTokenRequest {
    agentWallet?: string;
    userAddress: string;
    composeKeyId?: string;
    sessionId?: string;
    budget?: string | number;
    duration?: number;
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
    issuedAt: number;
    expiresAt: number;
    chainId: number;
    agentWallet: string;
    userAddress: string;
    composeKeyId: string;
    sessionId: string;
    budget: string;
    duration: number;
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

interface DesktopNetworkTokenPayload {
    version: number;
    tokenId: string;
    issuedAt: number;
    expiresAt: number;
    userAddress: string;
    agentWallet: string;
    composeKeyId: string;
    sessionId: string;
    deviceId: string;
    chainId: number;
}

interface DesktopNetworkPresenceRecord {
    version: number;
    userAddress: string;
    agentWallet: string;
    composeKeyId: string;
    sessionId: string;
    deviceId: string;
    chainId: number;
    peerId: string;
    announceMultiaddrs: string[];
    capabilitiesHash: string | null;
    configCid: string | null;
    metadata: Record<string, string>;
    lastSeenAt: number;
    expiresAt: number;
}

interface DesktopNetworkSeedRecord {
    version: number;
    seedId: string;
    provider: "digitalocean" | "azure" | "gcp" | "custom";
    instanceId: string;
    instanceName: string;
    region: string;
    zone: string | null;
    peerId: string;
    publicIp: string;
    announceMultiaddrs: string[];
    relayMultiaddrs: string[];
    healthUrl: string | null;
    lastSeenAt: number;
    expiresAt: number;
}

const NetworkTokenRequestSchema = z.object({
    agentWallet: z.string().trim().regex(ETH_ADDRESS_REGEX, "agentWallet must be a valid wallet address"),
    userAddress: z.string().trim().regex(ETH_ADDRESS_REGEX, "userAddress must be a valid wallet address").optional(),
    sessionId: z.string().trim().min(1).optional(),
    deviceId: z.string().trim().regex(DEVICE_ID_REGEX, "deviceId must be 8-128 characters"),
    chainId: z.coerce.number().int().positive().optional(),
});

const PresenceUpsertSchema = z.object({
    peerId: z.string().trim().regex(PEER_ID_REGEX, "peerId format is invalid"),
    announceMultiaddrs: z.array(z.string().trim().min(4).max(512)).max(32),
    capabilitiesHash: z.string().trim().min(16).max(256).optional(),
    configCid: z.string().trim().regex(CID_REGEX, "configCid format is invalid").optional(),
    metadata: z
        .record(z.string(), z.string().trim().max(512))
        .refine((value) => Object.keys(value).length <= 16, {
            message: "metadata can contain at most 16 keys",
        })
        .optional(),
    ttlSeconds: z.coerce.number().int().min(DESKTOP_NETWORK_PRESENCE_MIN_TTL_SECONDS).max(DESKTOP_NETWORK_PRESENCE_MAX_TTL_SECONDS).optional(),
});

const PresenceListQuerySchema = z.object({
    agentWallet: z.string().trim().regex(ETH_ADDRESS_REGEX, "agentWallet must be a valid wallet address").optional(),
    limit: z.coerce.number().int().positive().max(DESKTOP_NETWORK_LIST_MAX_LIMIT).optional(),
    includeSelf: z.coerce.boolean().optional(),
});

const SeedRegisterSchema = z.object({
    seedId: z.string().trim().min(3).max(160),
    provider: z.enum(["digitalocean", "azure", "gcp", "custom"]),
    instanceId: z.string().trim().min(1).max(200),
    instanceName: z.string().trim().min(1).max(200),
    region: z.string().trim().min(1).max(120),
    zone: z.string().trim().min(1).max(120).optional(),
    peerId: z.string().trim().regex(PEER_ID_REGEX, "peerId format is invalid"),
    publicIp: z.string().trim().min(7).max(64),
    announceMultiaddrs: z.array(z.string().trim().min(4).max(512)).min(1).max(32),
    relayMultiaddrs: z.array(z.string().trim().min(4).max(512)).min(1).max(32),
    healthUrl: z.string().trim().url().optional(),
    ttlSeconds: z.coerce.number().int().min(DESKTOP_NETWORK_SEED_MIN_TTL_SECONDS).max(DESKTOP_NETWORK_SEED_MAX_TTL_SECONDS).optional(),
});

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

    if (method === "POST" && path === "/api/desktop/network/token") {
        return handleCreateDesktopNetworkToken(event, corsHeaders);
    }
    if (method === "POST" && path === "/api/desktop/network/seeds/register") {
        return handleRegisterDesktopNetworkSeed(event, corsHeaders);
    }
    if (method === "DELETE" && path === "/api/desktop/network/seeds/register") {
        return handleDeleteDesktopNetworkSeed(event, corsHeaders);
    }
    if (method === "GET" && path === "/api/desktop/network/seeds") {
        return handleListDesktopNetworkSeeds(event, corsHeaders);
    }
    if (method === "GET" && path === "/api/desktop/network/bootstrap") {
        return handleGetDesktopNetworkBootstrap(event, corsHeaders);
    }
    if (method === "PUT" && path === "/api/desktop/network/presence") {
        return handleUpsertDesktopNetworkPresence(event, corsHeaders);
    }
    if (method === "GET" && path === "/api/desktop/network/presence") {
        return handleListDesktopNetworkPresence(event, corsHeaders);
    }
    if (method === "DELETE" && path === "/api/desktop/network/presence") {
        return handleDeleteDesktopNetworkPresence(event, corsHeaders);
    }

    return null;
}

function json(
    statusCode: number,
    body: Record<string, unknown>,
    corsHeaders: Record<string, string>,
): DesktopRouteResult {
    return {
        statusCode,
        headers: corsHeaders,
        body: JSON.stringify(body),
    };
}

function getHeader(event: DesktopRouteEvent, name: string): string | undefined {
    const direct = event.headers[name];
    if (typeof direct === "string" && direct.length > 0) return direct;

    const lower = event.headers[name.toLowerCase()];
    if (typeof lower === "string" && lower.length > 0) return lower;

    return undefined;
}

function parseJsonBody<T>(event: DesktopRouteEvent): T {
    if (!event.body || event.body.trim().length === 0) {
        throw new Error("Request body is required");
    }
    try {
        return JSON.parse(event.body) as T;
    } catch {
        throw new Error("Invalid JSON body");
    }
}

function normalizeWallet(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!ETH_ADDRESS_REGEX.test(trimmed)) return null;
    return trimmed.toLowerCase();
}

function parsePositiveInt(value: unknown, field: string): number {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${field} must be a positive integer`);
    }
    return parsed;
}

function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}

function normalizeDeviceId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!DEVICE_ID_REGEX.test(trimmed)) return null;
    return trimmed;
}

function getDesktopNetworkTokenSecret(): string {
    const composeSecret = process.env.COMPOSE_SESSION_SECRET;
    if (composeSecret) return composeSecret;
    const legacy = process.env.SESSION_SECRET;
    if (legacy) return legacy;
    throw new Error("COMPOSE_SESSION_SECRET (or legacy SESSION_SECRET) is required");
}

function base64urlEncode(data: string | Buffer): string {
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function base64urlDecode(data: string): Buffer {
    const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
    return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function desktopNetworkTokenRedisKey(tokenId: string): string {
    return `${DESKTOP_NETWORK_TOKEN_PREFIX}${tokenId}`;
}

function signDesktopNetworkTokenPayload(payloadBase64: string): string {
    const secret = getDesktopNetworkTokenSecret();
    const signature = createHmac("sha256", secret).update(payloadBase64).digest();
    return base64urlEncode(signature);
}

function mintDesktopNetworkToken(payload: DesktopNetworkTokenPayload): string {
    const payloadRaw = JSON.stringify(payload);
    const payloadBase64 = base64urlEncode(payloadRaw);
    const signature = signDesktopNetworkTokenPayload(payloadBase64);
    return `${DESKTOP_NETWORK_TOKEN_BEARER_PREFIX}${payloadBase64}.${signature}`;
}

function verifyDesktopNetworkToken(token: string): DesktopNetworkTokenPayload {
    if (!token.startsWith(DESKTOP_NETWORK_TOKEN_BEARER_PREFIX)) {
        throw new Error("Invalid desktop network token prefix");
    }

    const compact = token.slice(DESKTOP_NETWORK_TOKEN_BEARER_PREFIX.length);
    const parts = compact.split(".");
    if (parts.length !== 2) {
        throw new Error("Invalid desktop network token format");
    }

    const [payloadBase64, signature] = parts;
    if (!payloadBase64 || !signature || !BASE64URL_REGEX.test(payloadBase64) || !BASE64URL_REGEX.test(signature)) {
        throw new Error("Malformed desktop network token");
    }

    const expectedSignature = signDesktopNetworkTokenPayload(payloadBase64);
    const expectedBuffer = Buffer.from(expectedSignature);
    const actualBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
        throw new Error("Invalid desktop network token signature");
    }

    let payload: DesktopNetworkTokenPayload;
    try {
        const decoded = base64urlDecode(payloadBase64).toString("utf-8");
        payload = JSON.parse(decoded) as DesktopNetworkTokenPayload;
    } catch {
        throw new Error("Invalid desktop network token payload");
    }

    if (payload.version !== DESKTOP_NETWORK_TOKEN_VERSION) {
        throw new Error("Unsupported desktop network token version");
    }
    if (payload.expiresAt <= Date.now()) {
        throw new Error("Desktop network token expired");
    }
    if (!payload.tokenId || !payload.deviceId || !payload.sessionId || !payload.composeKeyId) {
        throw new Error("Desktop network token payload missing fields");
    }

    return payload;
}

function extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const value = authHeader.trim();
    if (value.length === 0) return null;

    if (value.startsWith("Bearer ")) {
        const token = value.slice("Bearer ".length).trim();
        return token.length > 0 ? token : null;
    }

    return value;
}

function desktopPresenceKey(chainId: number, agentWallet: string, deviceId: string): string {
    return `${DESKTOP_NETWORK_PRESENCE_PREFIX}${chainId}:${agentWallet}:${deviceId}`;
}

function desktopPresenceChainIndexKey(chainId: number): string {
    return `${DESKTOP_NETWORK_PRESENCE_PREFIX}index:chain:${chainId}`;
}

function desktopPresenceAgentIndexKey(chainId: number, agentWallet: string): string {
    return `${DESKTOP_NETWORK_PRESENCE_PREFIX}index:chain:${chainId}:agent:${agentWallet}`;
}

function parseDesktopPresenceKey(key: string): { chainId: number; agentWallet: string; deviceId: string } | null {
    if (!key.startsWith(DESKTOP_NETWORK_PRESENCE_PREFIX)) return null;
    const suffix = key.slice(DESKTOP_NETWORK_PRESENCE_PREFIX.length);
    const parts = suffix.split(":");
    if (parts.length !== 3) return null;

    const [chainRaw, agentRaw, deviceRaw] = parts;
    const chainId = Number.parseInt(chainRaw, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) return null;
    const agentWallet = normalizeWallet(agentRaw);
    const deviceId = normalizeDeviceId(deviceRaw);
    if (!agentWallet || !deviceId) return null;

    return { chainId, agentWallet, deviceId };
}

function desktopSeedKey(seedId: string): string {
    return `${DESKTOP_NETWORK_SEED_PREFIX}${seedId}`;
}

function getDesktopNetworkInternalSecret(): string {
    const explicit = process.env.NETWORK_INTERNAL_SECRET;
    if (explicit && explicit.length > 0) {
        return explicit;
    }
    const fallback = process.env.MANOWAR_INTERNAL_SECRET;
    if (fallback && fallback.length > 0) {
        return fallback;
    }
    throw new Error("NETWORK_INTERNAL_SECRET (or MANOWAR_INTERNAL_SECRET) is required");
}

function requireDesktopNetworkInternalAuth(event: DesktopRouteEvent): void {
    const actual = getHeader(event, "x-network-internal") || getHeader(event, "x-manowar-internal");
    const expected = getDesktopNetworkInternalSecret();
    if (!actual || actual !== expected) {
        throw new Error("x-network-internal authorization failed");
    }
}

function parseSeedIdFromQuery(event: DesktopRouteEvent): string {
    const seedId = event.queryStringParameters?.seedId?.trim();
    if (!seedId) {
        throw new Error("seedId query parameter is required");
    }
    if (seedId.length < 3 || seedId.length > 160) {
        throw new Error("seedId length is invalid");
    }
    return seedId;
}

async function listActiveDesktopNetworkSeeds(): Promise<DesktopNetworkSeedRecord[]> {
    const keys = await redisSMembers(DESKTOP_NETWORK_SEED_INDEX_KEY);
    const now = Date.now();
    const active: DesktopNetworkSeedRecord[] = [];

    for (const key of keys) {
        const raw = await redisGet(key);
        if (!raw) {
            await redisSRem(DESKTOP_NETWORK_SEED_INDEX_KEY, key);
            continue;
        }

        let record: DesktopNetworkSeedRecord;
        try {
            record = JSON.parse(raw) as DesktopNetworkSeedRecord;
        } catch {
            await redisDel(key);
            await redisSRem(DESKTOP_NETWORK_SEED_INDEX_KEY, key);
            continue;
        }

        if (record.version !== DESKTOP_NETWORK_SEED_RECORD_VERSION || record.expiresAt <= now) {
            await redisDel(key);
            await redisSRem(DESKTOP_NETWORK_SEED_INDEX_KEY, key);
            continue;
        }

        active.push(record);
    }

    active.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return active.slice(0, DESKTOP_NETWORK_SEED_LIST_MAX_LIMIT);
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
        token: string;
        expiresAt: number;
        budgetLimit: number;
        budgetUsed: number;
        chainId: number;
    } | null;
}> {
    const userAddress = normalizeWallet(body.userAddress);
    if (!userAddress) throw new Error("userAddress must be a valid wallet address");

    const agentWallet = normalizeWallet(body.agentWallet || null);
    const chainId = body.chainId ? parsePositiveInt(body.chainId, "chainId") : getActiveChainId();

    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress) throw new Error("x-session-user-address header is required");
    if (headerUserAddress !== userAddress) {
        throw new Error("x-session-user-address must match userAddress");
    }

    const activeSession = await getActiveSession(userAddress, chainId);
    return {
        userAddress,
        agentWallet,
        chainId,
        activeSession: activeSession ? {
            keyId: activeSession.keyId,
            token: activeSession.token,
            expiresAt: activeSession.expiresAt,
            budgetLimit: activeSession.budgetLimit,
            budgetUsed: activeSession.budgetUsed,
            chainId: activeSession.chainId ?? chainId,
        } : null,
    };
}

async function handleCreateDesktopLinkToken(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    try {
        const body = parseJsonBody<DesktopLinkTokenRequest>(event);
        const auth = await validateDesktopAuthorization(event, body);

        const issuedAt = Date.now();
        const expiresAt = issuedAt + DESKTOP_LINK_TOKEN_TTL_SECONDS * 1000;
        const token = `${randomUUID()}-${randomUUID()}`;

        const record: DesktopLinkTokenRecord = {
            version: 1,
            token,
            issuedAt,
            expiresAt,
            chainId: auth.chainId,
            agentWallet: auth.agentWallet || auth.userAddress,
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

        return json(201, {
            success: true,
            token,
            expiresAt,
            deepLinkUrl: `manowar://open?token=${encodeURIComponent(token)}`,
            hasSession: !!auth.activeSession,
        }, corsHeaders);
    } catch (error) {
        return json(400, {
            error: error instanceof Error ? error.message : "Invalid request",
        }, corsHeaders);
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
        if (!parsedDevice) throw new Error("deviceId is invalid");
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

    const consumed = await redisSetNXEX(consumedKey, deviceId, DESKTOP_LINK_CONSUMED_TTL_SECONDS);
    if (!consumed) {
        return json(409, { error: "Desktop link token already redeemed" }, corsHeaders);
    }

    await redisDel(linkTokenKey);

    let record: DesktopLinkTokenRecord;
    try {
        record = JSON.parse(stored) as DesktopLinkTokenRecord;
    } catch {
        return json(500, { error: "Corrupted desktop link token payload" }, corsHeaders);
    }

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

    return json(200, {
        success: true,
        context: {
            agentWallet: record.agentWallet,
            userAddress: record.userAddress,
            chainId: record.chainId,
            composeKey,
            session,
            market: {
                entry: "desktop",
                agentWallet: record.agentWallet,
            },
            deviceId,
            hasSession: !!activeSession,
        },
    }, corsHeaders);
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

async function handleCreateDesktopNetworkToken(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    let rawBody: unknown;
    try {
        rawBody = parseJsonBody<unknown>(event);
    } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "Invalid request body" }, corsHeaders);
    }

    const parsed = NetworkTokenRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
        return json(400, { error: parsed.error.issues[0]?.message || "Invalid request body" }, corsHeaders);
    }

    const agentWallet = normalizeWallet(parsed.data.agentWallet)!;
    const bodyUserAddress = parsed.data.userAddress ? normalizeWallet(parsed.data.userAddress) : null;
    const headerUserAddress = normalizeWallet(getHeader(event, "x-session-user-address"));
    if (!headerUserAddress) {
        return json(401, { error: "x-session-user-address header is required" }, corsHeaders);
    }
    if (bodyUserAddress && bodyUserAddress !== headerUserAddress) {
        return json(400, { error: "userAddress must match x-session-user-address header" }, corsHeaders);
    }
    const userAddress = bodyUserAddress || headerUserAddress;
    const chainId = parsed.data.chainId || getActiveChainId();

    const authHeader = getHeader(event, "authorization");
    const composeKeyToken = extractComposeKeyFromHeader(authHeader);
    if (!composeKeyToken) {
        return json(401, { error: "Authorization header with Compose Key token is required" }, corsHeaders);
    }

    const composePayload = verifyComposeKey(composeKeyToken);
    if (!composePayload) {
        return json(401, { error: "Invalid or expired Compose Key token" }, corsHeaders);
    }
    if (composePayload.sub.toLowerCase() !== userAddress) {
        return json(401, { error: "Compose Key token subject does not match userAddress" }, corsHeaders);
    }

    const activeSession = await getActiveSession(userAddress, chainId);
    if (!activeSession) {
        return json(401, { error: "No active session found for this user" }, corsHeaders);
    }
    if (activeSession.keyId !== composePayload.keyId) {
        return json(401, { error: "Compose Key does not match the active session" }, corsHeaders);
    }

    const requestedSession = parsed.data.sessionId ? parsed.data.sessionId.trim() : null;
    if (requestedSession && requestedSession !== activeSession.keyId) {
        return json(401, { error: "sessionId does not match active session" }, corsHeaders);
    }

    const tokenId = randomUUID();
    const issuedAt = Date.now();
    const sessionExpiresAt = activeSession.expiresAt;
    const expiresAt = Math.min(
        issuedAt + DESKTOP_NETWORK_TOKEN_TTL_SECONDS * 1000,
        sessionExpiresAt,
    );
    if (expiresAt <= issuedAt) {
        return json(401, { error: "Active session is already expired" }, corsHeaders);
    }

    const payload: DesktopNetworkTokenPayload = {
        version: DESKTOP_NETWORK_TOKEN_VERSION,
        tokenId,
        issuedAt,
        expiresAt,
        userAddress,
        agentWallet,
        composeKeyId: activeSession.keyId,
        sessionId: activeSession.keyId,
        deviceId: parsed.data.deviceId,
        chainId,
    };

    const token = mintDesktopNetworkToken(payload);
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt - issuedAt) / 1000));
    await redisSet(
        desktopNetworkTokenRedisKey(tokenId),
        JSON.stringify(payload),
        ttlSeconds,
    );

    return json(201, {
        success: true,
        token,
        expiresAt,
        chainId,
        agentWallet,
        sessionId: activeSession.keyId,
    }, corsHeaders);
}

async function requireDesktopNetworkToken(
    event: DesktopRouteEvent,
): Promise<DesktopNetworkTokenPayload> {
    const authHeader = getHeader(event, "authorization");
    const token = extractBearerToken(authHeader);
    if (!token) {
        throw new Error("Authorization Bearer desktop network token is required");
    }

    const payload = verifyDesktopNetworkToken(token);
    const redisPayload = await redisGet(desktopNetworkTokenRedisKey(payload.tokenId));
    if (!redisPayload) {
        throw new Error("Desktop network token is expired or revoked");
    }

    let stored: DesktopNetworkTokenPayload;
    try {
        stored = JSON.parse(redisPayload) as DesktopNetworkTokenPayload;
    } catch {
        throw new Error("Corrupted desktop network token state");
    }

    if (
        stored.tokenId !== payload.tokenId ||
        stored.userAddress !== payload.userAddress ||
        stored.agentWallet !== payload.agentWallet ||
        stored.deviceId !== payload.deviceId ||
        stored.sessionId !== payload.sessionId ||
        stored.composeKeyId !== payload.composeKeyId
    ) {
        throw new Error("Desktop network token state mismatch");
    }

    if (stored.expiresAt <= Date.now()) {
        throw new Error("Desktop network token expired");
    }

    return stored;
}

function parseCommaList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

async function handleRegisterDesktopNetworkSeed(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    try {
        requireDesktopNetworkInternalAuth(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    let rawBody: unknown;
    try {
        rawBody = parseJsonBody<unknown>(event);
    } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "Invalid request body" }, corsHeaders);
    }

    const parsed = SeedRegisterSchema.safeParse(rawBody);
    if (!parsed.success) {
        return json(400, { error: parsed.error.issues[0]?.message || "Invalid seed payload" }, corsHeaders);
    }

    const ttlSeconds = parsed.data.ttlSeconds || parsePositiveIntegerEnv(
        "LIBP2P_SEED_TTL_SECONDS",
        DESKTOP_NETWORK_SEED_DEFAULT_TTL_SECONDS,
    );
    const normalizedTtl = Math.max(
        DESKTOP_NETWORK_SEED_MIN_TTL_SECONDS,
        Math.min(ttlSeconds, DESKTOP_NETWORK_SEED_MAX_TTL_SECONDS),
    );
    const now = Date.now();
    const expiresAt = now + normalizedTtl * 1000;

    const record: DesktopNetworkSeedRecord = {
        version: DESKTOP_NETWORK_SEED_RECORD_VERSION,
        seedId: parsed.data.seedId,
        provider: parsed.data.provider,
        instanceId: parsed.data.instanceId,
        instanceName: parsed.data.instanceName,
        region: parsed.data.region,
        zone: parsed.data.zone || null,
        peerId: parsed.data.peerId,
        publicIp: parsed.data.publicIp,
        announceMultiaddrs: uniqueStrings(parsed.data.announceMultiaddrs),
        relayMultiaddrs: uniqueStrings(parsed.data.relayMultiaddrs),
        healthUrl: parsed.data.healthUrl || null,
        lastSeenAt: now,
        expiresAt,
    };

    const key = desktopSeedKey(record.seedId);
    await redisSet(key, JSON.stringify(record), normalizedTtl);
    await redisSAdd(DESKTOP_NETWORK_SEED_INDEX_KEY, key);

    return json(200, {
        success: true,
        seed: {
            seedId: record.seedId,
            provider: record.provider,
            instanceId: record.instanceId,
            instanceName: record.instanceName,
            region: record.region,
            zone: record.zone,
            peerId: record.peerId,
            publicIp: record.publicIp,
            announceMultiaddrs: record.announceMultiaddrs,
            relayMultiaddrs: record.relayMultiaddrs,
            healthUrl: record.healthUrl,
            lastSeenAt: record.lastSeenAt,
            expiresAt: record.expiresAt,
        },
    }, corsHeaders);
}

async function handleDeleteDesktopNetworkSeed(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    try {
        requireDesktopNetworkInternalAuth(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    let seedId: string;
    try {
        seedId = parseSeedIdFromQuery(event);
    } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "Invalid query parameters" }, corsHeaders);
    }

    const key = desktopSeedKey(seedId);
    const existed = await redisGet(key);
    await redisDel(key);
    await redisSRem(DESKTOP_NETWORK_SEED_INDEX_KEY, key);

    return json(200, {
        success: true,
        removed: Boolean(existed),
        seedId,
    }, corsHeaders);
}

async function handleListDesktopNetworkSeeds(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    try {
        requireDesktopNetworkInternalAuth(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    const activeSeeds = await listActiveDesktopNetworkSeeds();
    return json(200, {
        success: true,
        count: activeSeeds.length,
        seeds: activeSeeds.map((record) => ({
            seedId: record.seedId,
            provider: record.provider,
            instanceId: record.instanceId,
            instanceName: record.instanceName,
            region: record.region,
            zone: record.zone,
            peerId: record.peerId,
            publicIp: record.publicIp,
            announceMultiaddrs: record.announceMultiaddrs,
            relayMultiaddrs: record.relayMultiaddrs,
            healthUrl: record.healthUrl,
            lastSeenAt: record.lastSeenAt,
            expiresAt: record.expiresAt,
        })),
        serverTime: Date.now(),
    }, corsHeaders);
}

async function handleGetDesktopNetworkBootstrap(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    let token: DesktopNetworkTokenPayload;
    try {
        token = await requireDesktopNetworkToken(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    const bootstrapMultiaddrsStatic = parseCommaList(
        process.env.LIBP2P_BOOTSTRAP_MULTIADDRS || process.env.LIBP2P_BOOTSTRAP_PEERS,
    );
    const relayMultiaddrsStatic = parseCommaList(process.env.LIBP2P_RELAY_MULTIADDRS);
    let dynamicSeeds: DesktopNetworkSeedRecord[] = [];
    try {
        dynamicSeeds = await listActiveDesktopNetworkSeeds();
    } catch (error) {
        console.error("[desktop-network] failed to list dynamic seeds", error);
        dynamicSeeds = [];
    }
    const dynamicBootstrapAddrs = dynamicSeeds.flatMap((seed) => seed.announceMultiaddrs);
    const dynamicRelayAddrs = dynamicSeeds.flatMap((seed) => seed.relayMultiaddrs);
    const bootstrapMultiaddrs = uniqueStrings([...bootstrapMultiaddrsStatic, ...dynamicBootstrapAddrs]);
    const relayMultiaddrs = uniqueStrings([...relayMultiaddrsStatic, ...dynamicRelayAddrs]);
    const gossipTopic = process.env.LIBP2P_GOSSIP_TOPIC || DESKTOP_NETWORK_GOSSIP_TOPIC_DEFAULT;
    const kadProtocol = process.env.LIBP2P_KAD_PROTOCOL || DESKTOP_NETWORK_KAD_PROTOCOL_DEFAULT;
    const heartbeatMs = parsePositiveIntegerEnv("LIBP2P_HEARTBEAT_MS", DESKTOP_NETWORK_HEARTBEAT_DEFAULT_MS);
    const presenceTtlSeconds = parsePositiveIntegerEnv("LIBP2P_PRESENCE_TTL_SECONDS", DESKTOP_NETWORK_PRESENCE_DEFAULT_TTL_SECONDS);

    return json(200, {
        success: true,
        bootstrap: {
            bootstrapMultiaddrs,
            relayMultiaddrs,
            gossipTopic,
            kadProtocol,
            heartbeatMs,
            presenceTtlSeconds: Math.max(
                DESKTOP_NETWORK_PRESENCE_MIN_TTL_SECONDS,
                Math.min(presenceTtlSeconds, DESKTOP_NETWORK_PRESENCE_MAX_TTL_SECONDS),
            ),
        },
        seeds: {
            count: dynamicSeeds.length,
        },
        identity: {
            userAddress: token.userAddress,
            agentWallet: token.agentWallet,
            sessionId: token.sessionId,
            composeKeyId: token.composeKeyId,
            chainId: token.chainId,
            deviceId: token.deviceId,
            tokenExpiresAt: token.expiresAt,
        },
        serverTime: Date.now(),
    }, corsHeaders);
}

async function handleUpsertDesktopNetworkPresence(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    let token: DesktopNetworkTokenPayload;
    try {
        token = await requireDesktopNetworkToken(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    let bodyRaw: unknown;
    try {
        bodyRaw = parseJsonBody<unknown>(event);
    } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "Invalid request body" }, corsHeaders);
    }

    const parsed = PresenceUpsertSchema.safeParse(bodyRaw);
    if (!parsed.success) {
        return json(400, { error: parsed.error.issues[0]?.message || "Invalid presence payload" }, corsHeaders);
    }

    const now = Date.now();
    const ttlSeconds = parsed.data.ttlSeconds || parsePositiveIntegerEnv("LIBP2P_PRESENCE_TTL_SECONDS", DESKTOP_NETWORK_PRESENCE_DEFAULT_TTL_SECONDS);
    const normalizedTtl = Math.max(
        DESKTOP_NETWORK_PRESENCE_MIN_TTL_SECONDS,
        Math.min(ttlSeconds, DESKTOP_NETWORK_PRESENCE_MAX_TTL_SECONDS),
    );
    const expiresAt = now + normalizedTtl * 1000;

    const key = desktopPresenceKey(token.chainId, token.agentWallet, token.deviceId);
    const record: DesktopNetworkPresenceRecord = {
        version: DESKTOP_NETWORK_PRESENCE_RECORD_VERSION,
        userAddress: token.userAddress,
        agentWallet: token.agentWallet,
        composeKeyId: token.composeKeyId,
        sessionId: token.sessionId,
        deviceId: token.deviceId,
        chainId: token.chainId,
        peerId: parsed.data.peerId,
        announceMultiaddrs: parsed.data.announceMultiaddrs,
        capabilitiesHash: parsed.data.capabilitiesHash || null,
        configCid: parsed.data.configCid || null,
        metadata: parsed.data.metadata || {},
        lastSeenAt: now,
        expiresAt,
    };

    await redisSet(key, JSON.stringify(record), normalizedTtl);
    await redisSAdd(desktopPresenceChainIndexKey(token.chainId), key);
    await redisSAdd(desktopPresenceAgentIndexKey(token.chainId, token.agentWallet), key);

    return json(200, {
        success: true,
        presence: {
            chainId: record.chainId,
            agentWallet: record.agentWallet,
            deviceId: record.deviceId,
            peerId: record.peerId,
            announceMultiaddrs: record.announceMultiaddrs,
            capabilitiesHash: record.capabilitiesHash,
            configCid: record.configCid,
            metadata: record.metadata,
            lastSeenAt: record.lastSeenAt,
            expiresAt: record.expiresAt,
        },
    }, corsHeaders);
}

async function deletePresenceByKey(
    key: string,
    chainId: number,
    agentWallet: string,
): Promise<void> {
    await redisDel(key);
    await redisSRem(desktopPresenceChainIndexKey(chainId), key);
    await redisSRem(desktopPresenceAgentIndexKey(chainId, agentWallet), key);
}

function sanitizePresenceForResponse(record: DesktopNetworkPresenceRecord): {
    chainId: number;
    agentWallet: string;
    deviceId: string;
    peerId: string;
    announceMultiaddrs: string[];
    capabilitiesHash: string | null;
    configCid: string | null;
    metadata: Record<string, string>;
    lastSeenAt: number;
    expiresAt: number;
} {
    return {
        chainId: record.chainId,
        agentWallet: record.agentWallet,
        deviceId: record.deviceId,
        peerId: record.peerId,
        announceMultiaddrs: record.announceMultiaddrs,
        capabilitiesHash: record.capabilitiesHash,
        configCid: record.configCid,
        metadata: record.metadata,
        lastSeenAt: record.lastSeenAt,
        expiresAt: record.expiresAt,
    };
}

async function handleListDesktopNetworkPresence(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    let token: DesktopNetworkTokenPayload;
    try {
        token = await requireDesktopNetworkToken(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    const queryParsed = PresenceListQuerySchema.safeParse(event.queryStringParameters || {});
    if (!queryParsed.success) {
        return json(400, { error: queryParsed.error.issues[0]?.message || "Invalid query parameters" }, corsHeaders);
    }

    const queryAgentWallet = queryParsed.data.agentWallet
        ? normalizeWallet(queryParsed.data.agentWallet)
        : null;
    const limit = queryParsed.data.limit || DESKTOP_NETWORK_LIST_DEFAULT_LIMIT;
    const includeSelf = queryParsed.data.includeSelf ?? false;

    const indexKey = queryAgentWallet
        ? desktopPresenceAgentIndexKey(token.chainId, queryAgentWallet)
        : desktopPresenceChainIndexKey(token.chainId);
    const rawKeys = await redisSMembers(indexKey);
    const keys = rawKeys.slice(0, DESKTOP_NETWORK_LIST_MAX_LIMIT);

    const now = Date.now();
    const peers: Array<ReturnType<typeof sanitizePresenceForResponse>> = [];
    const staleKeys: Array<{ key: string; chainId: number; agentWallet: string }> = [];

    for (const key of keys) {
        const raw = await redisGet(key);
        const parsedKey = parseDesktopPresenceKey(key);
        if (!parsedKey) {
            continue;
        }
        if (!raw) {
            staleKeys.push(parsedKey ? { key, chainId: parsedKey.chainId, agentWallet: parsedKey.agentWallet } : {
                key,
                chainId: token.chainId,
                agentWallet: queryAgentWallet || token.agentWallet,
            });
            continue;
        }

        let record: DesktopNetworkPresenceRecord;
        try {
            record = JSON.parse(raw) as DesktopNetworkPresenceRecord;
        } catch {
            staleKeys.push({ key, chainId: parsedKey.chainId, agentWallet: parsedKey.agentWallet });
            continue;
        }

        if (record.expiresAt <= now) {
            staleKeys.push({ key, chainId: record.chainId, agentWallet: record.agentWallet });
            continue;
        }

        if (
            !includeSelf &&
            record.agentWallet === token.agentWallet &&
            record.deviceId === token.deviceId
        ) {
            continue;
        }

        peers.push(sanitizePresenceForResponse(record));
    }

    for (const stale of staleKeys) {
        await deletePresenceByKey(stale.key, stale.chainId, stale.agentWallet);
    }

    peers.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    return json(200, {
        success: true,
        peers: peers.slice(0, limit),
        count: Math.min(limit, peers.length),
        chainId: token.chainId,
        serverTime: now,
    }, corsHeaders);
}

async function handleDeleteDesktopNetworkPresence(
    event: DesktopRouteEvent,
    corsHeaders: Record<string, string>,
): Promise<DesktopRouteResult> {
    let token: DesktopNetworkTokenPayload;
    try {
        token = await requireDesktopNetworkToken(event);
    } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : "Unauthorized" }, corsHeaders);
    }

    const key = desktopPresenceKey(token.chainId, token.agentWallet, token.deviceId);
    const existed = await redisGet(key);
    await deletePresenceByKey(key, token.chainId, token.agentWallet);

    return json(200, {
        success: true,
        removed: Boolean(existed),
        chainId: token.chainId,
        agentWallet: token.agentWallet,
        deviceId: token.deviceId,
    }, corsHeaders);
}
