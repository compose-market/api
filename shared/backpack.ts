/**
 * Backpack - Centralized Permission & OAuth Token Storage
 * 
 * Stores user permissions (filesystem, camera, etc.) and OAuth tokens
 * for external services (Google, Notion, X, etc.).
 * 
 * Hierarchy: per-user > per-session > per-agent
 * 
 * Agent proactively checks this before tool execution:
 * - If permission/OAuth needed and not granted → prompt user
 * - If granted → proceed with tool execution
 */

// =============================================================================
// Types
// =============================================================================

/** Browser permission types */
export type ConsentType =
    | "filesystem"
    | "camera"
    | "microphone"
    | "geolocation"
    | "clipboard"
    | "notifications";

/** OAuth providers (extensible) */
export type OAuthProvider =
    | "google"
    | "notion"
    | "twitter"
    | "github"
    | "discord"
    | "instagram"
    | "perplexity"
    | string; // Allow custom providers

/** User permission record */
export interface UserPermission {
    userId: string;
    sessionId?: string;  // Optional: session-scoped
    agentId?: string;    // Optional: agent-scoped
    consentType: ConsentType | string;
    granted: boolean;
    grantedAt: number;
    expiresAt?: number;  // Optional: time-limited consent
}

/** OAuth token record */
export interface OAuthToken {
    userId: string;
    provider: OAuthProvider;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scopes: string[];
    metadata?: Record<string, unknown>;
}

/** API key record (for tools needing user's own API keys) */
export interface UserApiKey {
    userId: string;
    service: string;  // e.g., "openai", "anthropic", "notion"
    apiKey: string;
    addedAt: number;
    metadata?: Record<string, unknown>;
}

// =============================================================================
// In-Memory Storage (replace with database in production)
// =============================================================================

const permissions = new Map<string, UserPermission>();
const oauthTokens = new Map<string, OAuthToken>();
const apiKeys = new Map<string, UserApiKey>();

// Storage key helpers
function permissionKey(userId: string, consentType: string, sessionId?: string, agentId?: string): string {
    return `${userId}:${consentType}:${sessionId || '*'}:${agentId || '*'}`;
}

function oauthKey(userId: string, provider: string): string {
    return `${userId}:${provider}`;
}

function apiKeyKey(userId: string, service: string): string {
    return `${userId}:${service}`;
}

// =============================================================================
// Permission API
// =============================================================================

/**
 * Check if user has granted a permission
 * Checks in order: agent-specific → session-specific → user-wide
 */
export function checkPermission(
    userId: string,
    consentType: ConsentType | string,
    sessionId?: string,
    agentId?: string
): boolean {
    // Check agent-specific first
    if (agentId && sessionId) {
        const agentPerm = permissions.get(permissionKey(userId, consentType, sessionId, agentId));
        if (agentPerm?.granted) return true;
    }

    // Check session-specific
    if (sessionId) {
        const sessionPerm = permissions.get(permissionKey(userId, consentType, sessionId));
        if (sessionPerm?.granted) return true;
    }

    // Check user-wide
    const userPerm = permissions.get(permissionKey(userId, consentType));
    if (userPerm?.granted) {
        // Check expiry
        if (userPerm.expiresAt && Date.now() > userPerm.expiresAt) {
            permissions.delete(permissionKey(userId, consentType));
            return false;
        }
        return true;
    }

    return false;
}

/**
 * Grant a permission
 */
export function grantPermission(params: {
    userId: string;
    consentType: ConsentType | string;
    sessionId?: string;
    agentId?: string;
    expiresAt?: number;
}): void {
    const key = permissionKey(params.userId, params.consentType, params.sessionId, params.agentId);
    permissions.set(key, {
        userId: params.userId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        consentType: params.consentType,
        granted: true,
        grantedAt: Date.now(),
        expiresAt: params.expiresAt,
    });
    console.log(`[Backpack] Permission granted: ${params.consentType} for user ${params.userId}`);
}

/**
 * Revoke a permission
 */
export function revokePermission(
    userId: string,
    consentType: ConsentType | string,
    sessionId?: string,
    agentId?: string
): void {
    const key = permissionKey(userId, consentType, sessionId, agentId);
    permissions.delete(key);
    console.log(`[Backpack] Permission revoked: ${consentType} for user ${userId}`);
}

/**
 * List all permissions for a user
 */
export function listPermissions(userId: string): UserPermission[] {
    const userPerms: UserPermission[] = [];
    for (const [key, perm] of permissions) {
        if (key.startsWith(`${userId}:`)) {
            userPerms.push(perm);
        }
    }
    return userPerms;
}

// =============================================================================
// OAuth Token API
// =============================================================================

/**
 * Store an OAuth token
 */
export function storeOAuthToken(token: OAuthToken): void {
    const key = oauthKey(token.userId, token.provider);
    oauthTokens.set(key, token);
    console.log(`[Backpack] OAuth token stored: ${token.provider} for user ${token.userId}`);
}

/**
 * Get an OAuth token
 */
export function getOAuthToken(userId: string, provider: OAuthProvider): OAuthToken | null {
    const key = oauthKey(userId, provider);
    const token = oauthTokens.get(key);

    if (!token) return null;

    // Check expiry
    if (token.expiresAt && Date.now() > token.expiresAt) {
        // Token expired - could trigger refresh here
        console.log(`[Backpack] OAuth token expired: ${provider} for user ${userId}`);
        return null; // Caller should handle refresh
    }

    return token;
}

/**
 * Remove an OAuth token (disconnect account)
 */
export function removeOAuthToken(userId: string, provider: OAuthProvider): void {
    const key = oauthKey(userId, provider);
    oauthTokens.delete(key);
    console.log(`[Backpack] OAuth token removed: ${provider} for user ${userId}`);
}

/**
 * List all OAuth tokens for a user
 */
export function listOAuthTokens(userId: string): Array<{ provider: string; connected: boolean; expiresAt?: number }> {
    const tokens: Array<{ provider: string; connected: boolean; expiresAt?: number }> = [];
    for (const [key, token] of oauthTokens) {
        if (key.startsWith(`${userId}:`)) {
            tokens.push({
                provider: token.provider,
                connected: true,
                expiresAt: token.expiresAt,
            });
        }
    }
    return tokens;
}

// =============================================================================
// API Key Storage (for user-provided API keys)
// =============================================================================

/**
 * Store a user's API key for a service
 */
export function storeApiKey(params: {
    userId: string;
    service: string;
    apiKey: string;
    metadata?: Record<string, unknown>;
}): void {
    const key = apiKeyKey(params.userId, params.service);
    apiKeys.set(key, {
        userId: params.userId,
        service: params.service,
        apiKey: params.apiKey,
        addedAt: Date.now(),
        metadata: params.metadata,
    });
    console.log(`[Backpack] API key stored: ${params.service} for user ${params.userId}`);
}

/**
 * Get a user's API key for a service
 */
export function getApiKey(userId: string, service: string): string | null {
    const key = apiKeyKey(userId, service);
    return apiKeys.get(key)?.apiKey || null;
}

/**
 * Remove a user's API key
 */
export function removeApiKey(userId: string, service: string): void {
    const key = apiKeyKey(userId, service);
    apiKeys.delete(key);
    console.log(`[Backpack] API key removed: ${service} for user ${userId}`);
}

/**
 * List all API keys for a user (service names only, not the actual keys)
 */
export function listApiKeys(userId: string): string[] {
    const services: string[] = [];
    for (const [key] of apiKeys) {
        if (key.startsWith(`${userId}:`)) {
            const service = key.split(':')[1];
            services.push(service);
        }
    }
    return services;
}

// =============================================================================
// Unified Check API (for agent pre-execution checks)
// =============================================================================

export interface ToolRequirement {
    type: "permission" | "oauth" | "apiKey";
    value: string;  // consentType, provider, or service name
}

/**
 * Check if all requirements for a tool are met
 * Returns list of missing requirements
 */
export function checkToolRequirements(
    userId: string,
    requirements: ToolRequirement[],
    sessionId?: string,
    agentId?: string
): ToolRequirement[] {
    const missing: ToolRequirement[] = [];

    for (const req of requirements) {
        switch (req.type) {
            case "permission":
                if (!checkPermission(userId, req.value, sessionId, agentId)) {
                    missing.push(req);
                }
                break;
            case "oauth":
                if (!getOAuthToken(userId, req.value)) {
                    missing.push(req);
                }
                break;
            case "apiKey":
                if (!getApiKey(userId, req.value)) {
                    missing.push(req);
                }
                break;
        }
    }

    return missing;
}
