/**
 * Per-agent Composio account broker.
 *
 * Browser/channel routing is deliberately absent from this module. It only
 * creates, lists, checks, executes, and disconnects Composio connected accounts
 * scoped by (userAddress, agentWallet, toolkit, connectedAccountId).
 */

import { Composio } from "@composio/core";

import * as store from "./storage.js";

type AuthConfigResolution =
    | { id: string; mode: "explicit-custom" | "cached" | "existing-managed" | "created-managed" }
    | { id: string; mode: "existing-custom" | "created-custom" };

let composioInstance: InstanceType<typeof Composio> | null = null;
let composioClient: ReturnType<InstanceType<typeof Composio>["getClient"]> | null = null;

function client() {
    if (!composioClient) {
        const apiKey = process.env.COMPOSIO_API_KEY?.trim();
        if (!apiKey) {
            throw new Error("[Composio] COMPOSIO_API_KEY is not set");
        }
        composioInstance = new Composio({ apiKey });
        composioClient = composioInstance.getClient();
    }
    return composioClient;
}

function wallet(value: string, label: string): string {
    const normalized = value?.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
        throw new Error(`[Composio] ${label} must be a valid 0x-prefixed EVM address`);
    }
    return normalized;
}

function slug(value: string, label = "toolkit"): string {
    const normalized = value?.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,80}$/u.test(normalized)) {
        throw new Error(`[Composio] ${label} must be a toolkit slug`);
    }
    return normalized;
}

function text(value: string, label: string): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error(`[Composio] ${label} is required`);
    }
    return normalized;
}

function authKey(toolkit: string): string {
    return store.key("account", "auth", toolkit);
}

function routeKey(userAddress: string, agentWallet: string, toolkit: string, connectedAccountId: string): string {
    return store.key("account", "route", userAddress, agentWallet, toolkit, connectedAccountId);
}

function indexKey(userAddress: string, agentWallet: string): string {
    return store.key("account", "index", userAddress, agentWallet);
}

function toolkitKey(userAddress: string, agentWallet: string, toolkit: string): string {
    return store.key("account", "toolkit", userAddress, agentWallet, toolkit);
}

function routeId(toolkit: string, connectedAccountId: string): string {
    return `${toolkit}:${connectedAccountId}`;
}

function envKey(toolkit: string): string {
    return toolkit.replace(/[^a-zA-Z0-9]+/gu, "_").toUpperCase();
}

function explicit(toolkit: string): string | null {
    const direct = process.env[`COMPOSIO_AUTH_CONFIG_${envKey(toolkit)}`]?.trim();
    if (direct) return direct;

    const raw = process.env.COMPOSIO_AUTH_CONFIG_MAP?.trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const value = parsed[toolkit];
        return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch (error) {
        throw new Error(
            `[Composio] COMPOSIO_AUTH_CONFIG_MAP must be valid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
    }
}

function managed(toolkit: string): boolean {
    const blocked = (process.env.COMPOSIO_REQUIRE_CUSTOM_AUTH_TOOLKITS || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    if (blocked.includes(toolkit)) return false;

    const all = (process.env.COMPOSIO_REQUIRE_CUSTOM_AUTH || "").trim().toLowerCase();
    return !(all === "1" || all === "true" || all === "yes");
}

function name(toolkit: string): string {
    const brand = process.env.COMPOSIO_AUTH_BRAND_NAME?.trim() || "compose.market";
    return `${brand} ${toolkit}`;
}

async function auth(toolkit: string): Promise<AuthConfigResolution> {
    const pinned = explicit(toolkit);
    if (pinned) return { id: pinned, mode: "explicit-custom" };

    const cached = await store.get(authKey(toolkit));
    if (cached) return { id: cached, mode: "cached" };

    const api = client();
    const existing = await api.authConfigs.list({ toolkit_slug: toolkit } as any);
    const items = Array.isArray((existing as any).items) ? (existing as any).items : [];
    if (items.length > 0) {
        const id = text(items[0].id, "authConfigId");
        await store.set(authKey(toolkit), id);
        return {
            id,
            mode: (items[0] as any)?.type === "custom" ? "existing-custom" : "existing-managed",
        };
    }

    if (!managed(toolkit)) {
        throw new Error(
            `[Composio] Custom auth is required for ${toolkit}. Set COMPOSIO_AUTH_CONFIG_${envKey(toolkit)} or COMPOSIO_AUTH_CONFIG_MAP.`,
        );
    }

    const created = await api.authConfigs.create({
        toolkit: { slug: toolkit },
        auth_config: {
            type: "use_composio_managed_auth",
            name: name(toolkit),
        },
    } as any);
    const id = (created as any).auth_config?.id || (created as any).id;
    if (!id) {
        throw new Error(`[Composio] Failed to create auth config for ${toolkit}`);
    }
    await store.set(authKey(toolkit), id);
    return { id, mode: "created-managed" };
}

export function buildComposioUserId(userAddress: string, agentWallet: string): string {
    return `compose:${wallet(userAddress, "userAddress")}:agent:${wallet(agentWallet, "agentWallet")}`;
}

export interface ToolRouterSessionConfig {
    manage_connections: {
        enable: true;
        enable_connection_removal: true;
        enable_wait_for_connections: true;
        callback_url: string;
    };
    multi_account: {
        enable: true;
        max_accounts_per_toolkit: 10;
        require_explicit_selection: true;
    };
    workbench: {
        enable: true;
        enable_proxy_execution: true;
        auto_offload_threshold: number;
    };
}

export function buildToolRouterSessionConfig(callbackUrl: string): ToolRouterSessionConfig {
    const callback = text(callbackUrl, "callbackUrl");
    return {
        manage_connections: {
            enable: true,
            enable_connection_removal: true,
            enable_wait_for_connections: true,
            callback_url: callback,
        },
        multi_account: {
            enable: true,
            max_accounts_per_toolkit: 10,
            require_explicit_selection: true,
        },
        workbench: {
            enable: true,
            enable_proxy_execution: true,
            auto_offload_threshold: 20_000,
        },
    };
}

export interface AccountRoute {
    userAddress: string;
    agentWallet: string;
    toolkit: string;
    connectedAccountId: string;
    authConfigId: string;
    authMode: AuthConfigResolution["mode"];
    status: string;
    createdAt: number;
    updatedAt: number;
}

export interface ConnectionRequest {
    redirectUrl: string;
    userAddress: string;
    agentWallet: string;
    toolkit: string;
    connectedAccountId: string;
    authMode: AuthConfigResolution["mode"];
}

export interface ConnectionInfo {
    slug: string;
    name: string;
    connected: boolean;
    connectedAccountId: string;
    accountId: string;
    status: string;
    source: "composio";
}

async function save(route: AccountRoute): Promise<void> {
    const id = routeId(route.toolkit, route.connectedAccountId);
    await store.put(routeKey(route.userAddress, route.agentWallet, route.toolkit, route.connectedAccountId), route);
    await store.add(indexKey(route.userAddress, route.agentWallet), id);
    await store.add(toolkitKey(route.userAddress, route.agentWallet, route.toolkit), route.connectedAccountId);
}

async function read(
    userAddress: string,
    agentWallet: string,
    toolkit: string,
    connectedAccountId: string,
): Promise<AccountRoute | null> {
    return store.json<AccountRoute>(routeKey(userAddress, agentWallet, toolkit, connectedAccountId));
}

async function drop(route: AccountRoute): Promise<void> {
    await store.del(routeKey(route.userAddress, route.agentWallet, route.toolkit, route.connectedAccountId));
    await store.rem(indexKey(route.userAddress, route.agentWallet), routeId(route.toolkit, route.connectedAccountId));
    await store.rem(toolkitKey(route.userAddress, route.agentWallet, route.toolkit), route.connectedAccountId);
}

function map(account: any, route: AccountRoute): ConnectionInfo {
    const status = String(account?.status || route.status || "UNKNOWN");
    return {
        slug: route.toolkit,
        name: account?.toolkit?.slug || route.toolkit,
        connected: status === "ACTIVE",
        connectedAccountId: route.connectedAccountId,
        accountId: route.connectedAccountId,
        status,
        source: "composio",
    };
}

async function remote(userAddress: string, agentWallet: string): Promise<any[]> {
    const result = await client().connectedAccounts.list({
        user_id: buildComposioUserId(userAddress, agentWallet),
    } as any);
    return Array.isArray((result as any).items) ? (result as any).items : [];
}

export async function initiateConnection(
    userAddress: string,
    agentWallet: string,
    toolkit: string,
): Promise<ConnectionRequest> {
    const user = wallet(userAddress, "userAddress");
    const agent = wallet(agentWallet, "agentWallet");
    const tool = slug(toolkit);
    const config = await auth(tool);
    const callback = process.env.APP_URL
        ? `${process.env.APP_URL.replace(/\/+$/u, "")}/auth-success.html`
        : "https://compose.market/auth-success.html";

    const linked = await client().link.create({
        auth_config_id: config.id,
        user_id: buildComposioUserId(user, agent),
        callback_url: callback,
        connection_data: {
            redirectUrl: callback,
            composio_link_redirect_url: callback,
            long_redirect_url: true,
        },
    } as any);

    const redirectUrl = (linked as any).redirect_url;
    const connectedAccountId = (linked as any).connected_account_id;
    if (!redirectUrl || !connectedAccountId) {
        throw new Error(`[Composio] link.create did not return redirect_url and connected_account_id for ${tool}`);
    }

    const route: AccountRoute = {
        userAddress: user,
        agentWallet: agent,
        toolkit: tool,
        connectedAccountId,
        authConfigId: config.id,
        authMode: config.mode,
        status: "INITIATED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await save(route);

    return {
        redirectUrl,
        userAddress: user,
        agentWallet: agent,
        toolkit: tool,
        connectedAccountId,
        authMode: config.mode,
    };
}

export async function listConnections(
    userAddress: string,
    agentWallet: string,
    toolkit?: string,
): Promise<ConnectionInfo[]> {
    const user = wallet(userAddress, "userAddress");
    const agent = wallet(agentWallet, "agentWallet");
    const tool = toolkit ? slug(toolkit) : undefined;
    const ids = tool
        ? (await store.members(toolkitKey(user, agent, tool))).map((id) => routeId(tool, id))
        : await store.members(indexKey(user, agent));
    const routes = (await Promise.all(ids.map((id) => {
        const split = id.indexOf(":");
        const routeToolkit = id.slice(0, split);
        const account = id.slice(split + 1);
        return read(user, agent, routeToolkit, account);
    }))).filter((item): item is AccountRoute => Boolean(item));
    const accounts = await remote(user, agent);
    return routes.map((route) => {
        const account = accounts.find((item) => item?.id === route.connectedAccountId);
        return map(account, route);
    }).sort((left, right) => left.slug.localeCompare(right.slug) || left.connectedAccountId.localeCompare(right.connectedAccountId));
}

export async function checkConnection(input: {
    userAddress: string;
    agentWallet: string;
    toolkit: string;
    connectedAccountId: string;
}): Promise<ConnectionInfo> {
    const user = wallet(input.userAddress, "userAddress");
    const agent = wallet(input.agentWallet, "agentWallet");
    const tool = slug(input.toolkit);
    const accountId = text(input.connectedAccountId, "connectedAccountId");
    const route = await read(user, agent, tool, accountId);
    if (!route) {
        throw new Error(`Connected account route not found for ${tool}:${accountId}`);
    }
    const account = (await remote(user, agent)).find((item) => item?.id === accountId);
    return map(account, route);
}

export interface ToolkitActionExecutionParams {
    userAddress: string;
    agentWallet: string;
    toolkit: string;
    connectedAccountId: string;
    action: string;
    params?: Record<string, unknown>;
    text?: string;
}

export async function executeToolkitAction(
    params: ToolkitActionExecutionParams,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
    try {
        const user = wallet(params.userAddress, "userAddress");
        const agent = wallet(params.agentWallet, "agentWallet");
        const tool = slug(params.toolkit);
        const accountId = text(params.connectedAccountId, "connectedAccountId");
        const action = text(params.action, "action");
        const status = await checkConnection({
            userAddress: user,
            agentWallet: agent,
            toolkit: tool,
            connectedAccountId: accountId,
        });
        if (!status.connected) {
            return { success: false, error: `Connected account ${accountId} is ${status.status}` };
        }

        const result = await client().tools.execute(action, {
            connected_account_id: accountId,
            user_id: buildComposioUserId(user, agent),
            arguments: params.params,
            text: params.text,
        } as any);
        return { success: true, result };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function disconnectToolkit(input: {
    userAddress: string;
    agentWallet: string;
    toolkit: string;
    connectedAccountId: string;
}): Promise<{ success: boolean }> {
    const user = wallet(input.userAddress, "userAddress");
    const agent = wallet(input.agentWallet, "agentWallet");
    const tool = slug(input.toolkit);
    const accountId = text(input.connectedAccountId, "connectedAccountId");
    const route = await read(user, agent, tool, accountId);
    if (route) {
        await client().connectedAccounts.delete(accountId);
        await drop(route);
    }
    return { success: true };
}

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

export async function searchToolkits(query: string, limit = 20): Promise<ToolkitInfo[]> {
    const result = await client().toolkits.list({
        search: query || undefined,
        limit,
    } as any);
    const items = Array.isArray((result as any).items) ? (result as any).items : [];
    return items.map((item: any) => ({
        slug: item.slug || "",
        name: item.name || item.slug || "",
        logo: item.meta?.logo || "",
        description: item.meta?.description || "",
        categories: Array.isArray(item.meta?.categories) ? item.meta.categories.map((entry: any) => entry.name || entry.id || "") : [],
        authSchemes: item.auth_schemes || [],
        composioManagedSchemes: item.composio_managed_auth_schemes || [],
    }));
}

export async function listToolkitActions(toolkit: string, limit = 40): Promise<ToolkitActionInfo[]> {
    const tool = slug(toolkit);
    const result = await client().tools.list({
        toolkit_slug: tool,
        limit,
    } as any);
    const items = Array.isArray((result as any).items) ? (result as any).items : [];
    return items
        .filter((item: any) => !item?.is_deprecated)
        .map((item: any) => ({
            slug: item.slug || "",
            name: item.name || item.slug || "",
            description: item.human_description || item.description || "",
            toolkitSlug: item.toolkit?.slug || tool,
            toolkitName: item.toolkit?.name || item.toolkit?.slug || tool,
            noAuth: Boolean(item.no_auth),
            scopes: Array.isArray(item.scopes) ? item.scopes : [],
            inputParameters: item.input_parameters && typeof item.input_parameters === "object"
                ? item.input_parameters
                : {},
        }));
}
