/**
 * Backpack Redis Storage
 *
 * Persists auth config IDs, channel bindings (Telegram chat_id, WhatsApp wa_id),
 * and deep-link codes across Lambda cold starts.
 *
 * Key patterns:
 *   backpack:authconfig:{slug}        → auth_config_id (permanent)
 *   backpack:linkcode:{code}          → JSON { userId, toolkit, createdAt } (10 min TTL)
 *   backpack:channel:{userId}:{slug}  → JSON { chatId, waId, boundAt } (permanent)
 *   backpack:system:connected:{slug}  → connected_account_id (permanent, system bot)
 */

import {
    redisGet,
    redisSet,
    redisDel,
    redisExpire,
} from "../config/redis.js";
import crypto from "crypto";

// =============================================================================
// Auth Config Cache (replaces in-memory Map)
// =============================================================================

const AUTH_CONFIG_PREFIX = "backpack:authconfig:";

export async function getCachedAuthConfig(slug: string): Promise<string | null> {
    return redisGet(`${AUTH_CONFIG_PREFIX}${slug}`);
}

export async function setCachedAuthConfig(slug: string, configId: string): Promise<void> {
    await redisSet(`${AUTH_CONFIG_PREFIX}${slug}`, configId);
    // No TTL — auth configs are permanent
}

// =============================================================================
// System Connected Accounts (single bot/business token per channel)
// =============================================================================

const SYSTEM_CONN_PREFIX = "backpack:system:connected:";

export async function getSystemConnectedAccount(slug: string): Promise<string | null> {
    return redisGet(`${SYSTEM_CONN_PREFIX}${slug}`);
}

export async function setSystemConnectedAccount(slug: string, connectedAccountId: string): Promise<void> {
    await redisSet(`${SYSTEM_CONN_PREFIX}${slug}`, connectedAccountId);
}

// =============================================================================
// Deep-Link Codes (short-lived, for Telegram/WhatsApp binding)
// =============================================================================

const LINK_CODE_PREFIX = "backpack:linkcode:";
const LINK_CODE_TTL = 600; // 10 minutes

export interface LinkCodeData {
    userId: string;
    toolkit: string;
    createdAt: number;
}

/**
 * Generate a short, URL-safe link code and store it with a 10-minute TTL.
 */
export async function createLinkCode(userId: string, toolkit: string): Promise<string> {
    const code = crypto.randomBytes(16).toString("base64url");
    const data: LinkCodeData = {
        userId,
        toolkit,
        createdAt: Date.now(),
    };
    const key = `${LINK_CODE_PREFIX}${code}`;
    await redisSet(key, JSON.stringify(data));
    await redisExpire(key, LINK_CODE_TTL);
    return code;
}

/**
 * Consume a link code — returns the data and deletes the code atomically.
 */
export async function consumeLinkCode(code: string): Promise<LinkCodeData | null> {
    const key = `${LINK_CODE_PREFIX}${code}`;
    const raw = await redisGet(key);
    if (!raw) return null;

    await redisDel(key);

    try {
        return JSON.parse(raw) as LinkCodeData;
    } catch {
        return null;
    }
}

// =============================================================================
// Channel Bindings (per-user Telegram/WhatsApp identity)
// =============================================================================

const CHANNEL_PREFIX = "backpack:channel:";

export interface ChannelBinding {
    chatId?: string;    // Telegram chat_id
    waId?: string;      // WhatsApp wa_id / phone
    boundAt: number;
}

export async function getChannelBinding(userId: string, slug: string): Promise<ChannelBinding | null> {
    const raw = await redisGet(`${CHANNEL_PREFIX}${userId}:${slug}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as ChannelBinding;
    } catch {
        return null;
    }
}

export async function setChannelBinding(
    userId: string,
    slug: string,
    binding: ChannelBinding
): Promise<void> {
    await redisSet(`${CHANNEL_PREFIX}${userId}:${slug}`, JSON.stringify(binding));
}

export async function deleteChannelBinding(userId: string, slug: string): Promise<void> {
    await redisDel(`${CHANNEL_PREFIX}${userId}:${slug}`);
}
