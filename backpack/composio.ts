/**
 * Composio Credential Broker
 * 
 * Manages OAuth connections via Composio's v3 API (SDK v0.6.x).
 * The application NEVER touches user credentials — Composio handles the
 * entire OAuth handshake, token storage, and refresh lifecycle.
 * 
 * Supports two authentication models:
 *   A. OAuth toolkits (Gmail, Notion, etc.) — per-user popup flow
 *   B. Channel toolkits (Telegram, WhatsApp) — single system bot token,
 *      users bind via deep link / message handshake
 * 
 * Flow (OAuth):
 *   1. Backend calls authConfigs.create (once per toolkit) → auth_config_id
 *   2. Backend calls link.create(auth_config_id, user_id) → redirect_url
 *   3. Frontend opens redirect_url in popup — user authenticates
 *   4. Popup redirects to /auth-success.html which auto-closes
 *   5. Backend checks connectedAccounts via polling
 * 
 * Flow (Channel — Telegram):
 *   1. Backend generates deep-link code → t.me/ComposeBot?start=<code>
 *   2. User taps Start in Telegram
 *   3. Webhook receives /start <code> → binds chat_id to user
 */

import { Composio, AuthScheme } from "@composio/core";
import {
    getCachedAuthConfig,
    setCachedAuthConfig,
    createLinkCode,
    consumeLinkCode,
    setChannelBinding,
    getChannelBinding,
    deleteChannelBinding,
    getSystemConnectedAccount,
    setSystemConnectedAccount,
} from "./storage.js";

type AuthConfigResolution =
    | { id: string; mode: "explicit-custom" | "cached" | "existing-managed" | "created-managed" }
    | { id: string; mode: "existing-custom" | "created-custom" };

// =============================================================================
// Client Initialization
// =============================================================================

let composioInstance: InstanceType<typeof Composio> | null = null;
let composioClient: ReturnType<InstanceType<typeof Composio>["getClient"]> | null = null;

function getClient() {
    if (!composioClient) {
        const apiKey = process.env.COMPOSIO_API_KEY;
        if (!apiKey) {
            throw new Error("[Composio] COMPOSIO_API_KEY is not set in environment variables");
        }
        composioInstance = new Composio({ apiKey });
        composioClient = composioInstance.getClient();
        console.log("[Composio] Client initialized");
    }
    return composioClient;
}

function getComposioInstance() {
    if (!composioInstance) {
        const apiKey = process.env.COMPOSIO_API_KEY;
        if (!apiKey) {
            throw new Error("[Composio] COMPOSIO_API_KEY is not set in environment variables");
        }
        composioInstance = new Composio({ apiKey });
        composioClient = composioInstance.getClient();
    }
    return composioInstance;
}

// =============================================================================
// Auth Config (Redis-backed)
// =============================================================================

function slugToEnvKey(toolkitSlug: string): string {
    return toolkitSlug.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

function getExplicitAuthConfigId(toolkitSlug: string): string | null {
    const directKey = `COMPOSIO_AUTH_CONFIG_${slugToEnvKey(toolkitSlug)}`;
    const directValue = process.env[directKey]?.trim();
    if (directValue) {
        return directValue;
    }

    const rawMap = process.env.COMPOSIO_AUTH_CONFIG_MAP?.trim();
    if (!rawMap) {
        return null;
    }

    try {
        const parsed = JSON.parse(rawMap) as Record<string, unknown>;
        const entry = parsed[toolkitSlug];
        return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null;
    } catch (error) {
        throw new Error(
            `[Composio] COMPOSIO_AUTH_CONFIG_MAP must be valid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
    }
}

function useManagedAuthFallback(toolkitSlug: string): boolean {
    const requiredList = (process.env.COMPOSIO_REQUIRE_CUSTOM_AUTH_TOOLKITS || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);

    if (requiredList.includes(toolkitSlug.toLowerCase())) {
        return false;
    }

    const requireAllCustom = (process.env.COMPOSIO_REQUIRE_CUSTOM_AUTH || "").trim().toLowerCase();
    if (requireAllCustom === "1" || requireAllCustom === "true" || requireAllCustom === "yes") {
        return false;
    }

    return true;
}

function buildAuthConfigName(toolkitSlug: string): string {
    const brandName = process.env.COMPOSIO_AUTH_BRAND_NAME?.trim() || "compose.market";
    return `${brandName} ${toolkitSlug}`;
}

/**
 * Get or create a Composio-managed auth config for a toolkit.
 * Auth config IDs are cached in Redis (permanent) to survive Api cold starts.
 */
async function getOrCreateAuthConfig(toolkitSlug: string): Promise<AuthConfigResolution> {
    const explicit = getExplicitAuthConfigId(toolkitSlug);
    if (explicit) {
        return { id: explicit, mode: "explicit-custom" };
    }

    // Check Redis cache first
    const cached = await getCachedAuthConfig(toolkitSlug);
    if (cached) {
        console.log(`[Composio] Using cached auth config for ${toolkitSlug}: ${cached}`);
        return { id: cached, mode: "cached" };
    }

    const client = getClient();

    // Check if an auth config already exists on Composio's side
    const existing = await client.authConfigs.list({
        toolkit_slug: toolkitSlug,
    } as any);

    if (existing.items && existing.items.length > 0) {
        const configId = existing.items[0].id;
        await setCachedAuthConfig(toolkitSlug, configId);
        console.log(`[Composio] Using existing auth config for ${toolkitSlug}: ${configId}`);
        const authType = (existing.items[0] as any)?.type;
        return {
            id: configId,
            mode: authType === "custom" ? "existing-custom" : "existing-managed",
        };
    }

    if (!useManagedAuthFallback(toolkitSlug)) {
        throw new Error(
            `[Composio] Custom auth is required for ${toolkitSlug}. Set COMPOSIO_AUTH_CONFIG_${slugToEnvKey(toolkitSlug)} or COMPOSIO_AUTH_CONFIG_MAP.`,
        );
    }

    // Create a new Composio-managed auth config
    const result = await client.authConfigs.create({
        toolkit: { slug: toolkitSlug },
        auth_config: {
            type: "use_composio_managed_auth",
            name: buildAuthConfigName(toolkitSlug),
        },
    } as any);

    const configId = (result as any).auth_config?.id;
    if (!configId) {
        throw new Error(`[Composio] Failed to create auth config for ${toolkitSlug}`);
    }

    await setCachedAuthConfig(toolkitSlug, configId);
    console.log(`[Composio] Created auth config for ${toolkitSlug}: ${configId}`);
    return { id: configId, mode: "created-managed" };
}

// =============================================================================
// OAuth Connection Flow
// =============================================================================

export interface ConnectionRequest {
    redirectUrl: string;
    toolkit: string;
    connectedAccountId: string;
    authMode: AuthConfigResolution["mode"];
}

/**
 * Initiate an OAuth connection for a specific toolkit.
 * Returns a redirectUrl (Composio hosted) to be opened in a popup window.
 * After auth, the popup redirects to /auth-success.html which auto-closes.
 */
export async function initiateConnection(
    userAddress: string,
    toolkit: string
): Promise<ConnectionRequest> {
    console.log(`[Composio] Initiating connection: ${toolkit} for user ${userAddress}`);

    const client = getClient();

    // Step 1: Get the auth config for this toolkit
    const authConfig = await getOrCreateAuthConfig(toolkit);
    const authConfigId = authConfig.id;

    // Step 2: Create a connection link with auto-close redirect
    const successUrl = process.env.APP_URL
        ? `${process.env.APP_URL}/auth-success.html`
        : "https://compose.market/auth-success.html";

    const linkResult = await client.link.create({
        auth_config_id: authConfigId,
        user_id: userAddress,
        callback_url: successUrl,
        connection_data: {
            redirectUrl: successUrl,
            composio_link_redirect_url: successUrl,
            long_redirect_url: true,
        },
    } as any);

    const result = linkResult as any;
    const redirectUrl = result.redirect_url;
    const connectedAccountId = result.connected_account_id;

    if (!redirectUrl) {
        throw new Error(`[Composio] No redirect URL returned for toolkit: ${toolkit}`);
    }

    console.log(`[Composio] Redirect URL generated for ${toolkit}: ${redirectUrl}`);

    return {
        redirectUrl,
        toolkit,
        connectedAccountId,
        authMode: authConfig.mode,
    };
}

// =============================================================================
// Channel-Based Connection Flow (Telegram / WhatsApp)
// =============================================================================

const TG_BOT_USERNAME = process.env.TG_BOT_USERNAME;

/**
 * Create a Telegram deep-link URL for binding a user's chat_id.
 * The code is stored in Redis with a 10-minute TTL.
 */
export async function initiateTelegramLink(userAddress: string): Promise<{
    deepLinkUrl: string;
    linkCode: string;
}> {
    console.log(`[Composio] Generating Telegram deep link for user ${userAddress}`);

    const code = await createLinkCode(userAddress, "telegram");
    const deepLinkUrl = `https://t.me/${TG_BOT_USERNAME}?start=${code}`;

    console.log(`[Composio] Telegram deep link: ${deepLinkUrl}`);
    return { deepLinkUrl, linkCode: code };
}

/**
 * Handle a Telegram bot webhook update.
 * Parses /start <code> and binds the user's chat_id.
 */
export async function handleTelegramWebhook(update: any): Promise<{
    bound: boolean;
    userAddress?: string;
    chatId?: string;
}> {
    const msg = update?.message;
    const text: string | undefined = msg?.text;

    if (!text?.startsWith("/start ")) {
        return { bound: false };
    }

    const code = text.slice("/start ".length).trim();
    if (!code) return { bound: false };

    // Consume the link code (one-time use)
    const linkData = await consumeLinkCode(code);
    if (!linkData) {
        console.log(`[Composio] Invalid or expired link code: ${code}`);
        return { bound: false };
    }

    const chatId = String(msg.chat.id);
    const userAddress = linkData.userAddress;

    // Store the channel binding
    await setChannelBinding(userAddress, "telegram", {
        chatId,
        boundAt: Date.now(),
    });

    console.log(`[Composio] Bound Telegram chat ${chatId} to user ${userAddress}`);

    // Ensure we have a system connected account for Telegram
    await ensureSystemTelegramAccount();

    return { bound: true, userAddress, chatId };
}

/**
 * Ensure a system Composio connected account exists for the Telegram bot.
 * Creates one if missing, using COMPOSE_BOT_HTTP_API env var.
 */
async function ensureSystemTelegramAccount(): Promise<string | null> {
    // Check if we already have a system account
    const existing = await getSystemConnectedAccount("telegram");
    if (existing) return existing;

    const botToken = process.env.COMPOSE_BOT_HTTP_API;
    if (!botToken) {
        console.warn("[Composio] COMPOSE_BOT_HTTP_API not set — cannot create system Telegram account");
        return null;
    }

    try {
        const composio = getComposioInstance();

        // First ensure an auth config exists for telegram API_KEY
        let authConfigId = await getCachedAuthConfig("telegram");

        if (!authConfigId) {
            const client = getClient();
            // Check if one exists on Composio's side
            const existingConfigs = await client.authConfigs.list({
                toolkit_slug: "telegram",
            } as any);

            if (existingConfigs.items && existingConfigs.items.length > 0) {
                authConfigId = existingConfigs.items[0].id;
            } else {
                // Create a custom auth config for API_KEY
                const configResult = await client.authConfigs.create({
                    toolkit: { slug: "telegram" },
                    auth_config: {
                        type: "use_custom_auth",
                        authScheme: "API_KEY",
                        name: buildAuthConfigName("telegram"),
                    },
                } as any);
                authConfigId = (configResult as any).auth_config?.id || (configResult as any).id;
            }

            if (authConfigId) {
                await setCachedAuthConfig("telegram", authConfigId);
            }
        }

        if (!authConfigId) {
            console.error("[Composio] Could not create/find Telegram auth config");
            return null;
        }

        // Create connected account with the bot token
        const connResult = await composio.connectedAccounts.initiate(
            "system_telegram_bot",
            authConfigId,
            {
                config: AuthScheme.APIKey({ api_key: botToken }),
            }
        );

        const connId = (connResult as any).id || (connResult as any).connectedAccountId;
        if (connId) {
            await setSystemConnectedAccount("telegram", connId);
            console.log(`[Composio] Created system Telegram connected account: ${connId}`);
            return connId;
        }
    } catch (error) {
        console.error("[Composio] Error creating system Telegram account:", error);
    }

    return null;
}

/**
 * Check if a user has a Telegram channel binding.
 */
export async function checkTelegramBinding(userAddress: string): Promise<{
    bound: boolean;
    chatId?: string;
}> {
    const binding = await getChannelBinding(userAddress, "telegram");
    return {
        bound: !!binding?.chatId,
        chatId: binding?.chatId,
    };
}

// =============================================================================
// Connection Management (shared)
// =============================================================================

export interface ConnectionInfo {
    slug: string;
    name: string;
    connected: boolean;
    accountId?: string;
    status?: string;
}

/**
 * List all connected accounts for a user.
 * Fetches from Composio's connectedAccounts API.
 */
export async function listConnections(userAddress: string): Promise<ConnectionInfo[]> {
    console.log(`[Composio] Listing connections for user ${userAddress}`);

    const client = getClient();

    const result = await client.connectedAccounts.list({
        user_id: userAddress,
    } as any);

    const accounts = (result as any).items || [];

    const connections: ConnectionInfo[] = accounts.map((account: any) => ({
        slug: account.toolkit?.slug || "",
        name: account.toolkit?.slug || "",
        connected: account.status === "ACTIVE",
        accountId: account.id,
        status: account.status,
    }));

    // Also check for channel bindings (Telegram, WhatsApp)
    const tgBinding = await getChannelBinding(userAddress, "telegram");
    if (tgBinding?.chatId) {
        const hasTg = connections.some(c => c.slug === "telegram");
        if (!hasTg) {
            connections.push({
                slug: "telegram",
                name: "telegram",
                connected: true,
                status: "CHANNEL_BOUND",
            });
        }
    }

    const connectedCount = connections.filter(c => c.connected).length;
    console.log(`[Composio] Found ${connectedCount}/${connections.length} connected accounts for user ${userAddress}`);

    return connections;
}

/**
 * Check if a specific toolkit is connected for a user.
 */
export async function checkConnection(
    userAddress: string,
    toolkit: string
): Promise<{ connected: boolean; accountId?: string }> {
    // For channel-based toolkits, check bindings
    if (toolkit === "telegram") {
        const binding = await checkTelegramBinding(userAddress);
        return { connected: binding.bound };
    }

    const connections = await listConnections(userAddress);
    const match = connections.find(c => c.slug === toolkit);

    return {
        connected: match?.connected ?? false,
        accountId: match?.accountId,
    };
}

export interface ToolkitActionExecutionParams {
    userAddress: string;
    toolkit: string;
    action: string;
    params?: Record<string, unknown>;
    text?: string;
}

export async function executeToolkitAction(
    params: ToolkitActionExecutionParams
): Promise<{ success: boolean; result?: unknown; error?: string }> {
    if (!params.userAddress || !params.toolkit || !params.action) {
        return { success: false, error: "userAddress, toolkit and action are required" };
    }

    try {
        const client = getClient();

        let connectedAccountId: string | undefined;
        if (params.toolkit === "telegram" || params.toolkit === "whatsapp") {
            connectedAccountId = await getSystemConnectedAccount(params.toolkit) || undefined;
        } else {
            const connection = await checkConnection(params.userAddress, params.toolkit);
            if (!connection.connected || !connection.accountId) {
                return {
                    success: false,
                    error: `Toolkit '${params.toolkit}' is not connected for user ${params.userAddress}`,
                };
            }
            connectedAccountId = connection.accountId;
        }

        const result = await client.tools.execute(params.action, {
            connected_account_id: connectedAccountId,
            user_id: params.userAddress,
            arguments: params.params,
            text: params.text,
        } as any);

        return { success: true, result };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Disconnect a toolkit for a user.
 */
export async function disconnectToolkit(
    userAddress: string,
    toolkit: string
): Promise<{ success: boolean }> {
    console.log(`[Composio] Disconnecting ${toolkit} for user ${userAddress}`);

    try {
        // For channel-based toolkits, delete the binding
        if (toolkit === "telegram") {
            await deleteChannelBinding(userAddress, "telegram");
            console.log(`[Composio] Removed Telegram binding for user ${userAddress}`);
            return { success: true };
        }

        if (toolkit === "whatsapp") {
            await deleteChannelBinding(userAddress, "whatsapp");
            console.log(`[Composio] Removed WhatsApp binding for user ${userAddress}`);
            return { success: true };
        }

        // For OAuth toolkits, delete the connected account
        const connection = await checkConnection(userAddress, toolkit);
        if (!connection.connected || !connection.accountId) {
            console.log(`[Composio] ${toolkit} is not connected for user ${userAddress}`);
            return { success: true }; // Already disconnected
        }

        const client = getClient();
        await client.connectedAccounts.delete(connection.accountId);

        console.log(`[Composio] Disconnected ${toolkit} for user ${userAddress}`);
        return { success: true };
    } catch (error) {
        console.error(`[Composio] Error disconnecting ${toolkit}:`, error);
        return { success: false };
    }
}

// =============================================================================
// Toolkit Search
// =============================================================================

export interface ToolkitInfo {
    slug: string;
    name: string;
    logo: string;
    description: string;
    categories: string[];
    authSchemes: string[];
    composioManagedSchemes: string[];
}

export interface ToolkitActionInfo {
    slug: string;
    name: string;
    description: string;
    toolkitSlug: string;
    toolkitName: string;
    noAuth: boolean;
    scopes: string[];
    inputParameters: Record<string, unknown>;
}

/**
 * Search Composio's toolkit catalog (870+ integrations).
 */
export async function searchToolkits(
    query: string,
    limit = 20
): Promise<ToolkitInfo[]> {
    const client = getClient();

    const result = await client.toolkits.list({
        search: query || undefined,
        limit,
    } as any);

    const items = (result as any).items || [];

    return items.map((tk: any) => ({
        slug: tk.slug || "",
        name: tk.name || tk.slug || "",
        logo: tk.meta?.logo || "",
        description: tk.meta?.description || "",
        categories: (tk.meta?.categories || []).map((c: any) => c.name || c.id || ""),
        authSchemes: tk.auth_schemes || [],
        composioManagedSchemes: tk.composio_managed_auth_schemes || [],
    }));
}

export async function listToolkitActions(
    toolkit: string,
    limit = 40,
): Promise<ToolkitActionInfo[]> {
    const client = getClient();

    const result = await client.tools.list({
        toolkit_slug: toolkit,
        limit,
    } as any);

    const items = (result as any).items || [];

    return items
        .filter((tool: any) => !tool?.is_deprecated)
        .map((tool: any) => ({
            slug: tool.slug || "",
            name: tool.name || tool.slug || "",
            description: tool.human_description || tool.description || "",
            toolkitSlug: tool.toolkit?.slug || toolkit,
            toolkitName: tool.toolkit?.name || tool.toolkit?.slug || toolkit,
            noAuth: Boolean(tool.no_auth),
            scopes: Array.isArray(tool.scopes) ? tool.scopes : [],
            inputParameters: (tool.input_parameters && typeof tool.input_parameters === "object")
                ? tool.input_parameters
                : {},
        }));
}
