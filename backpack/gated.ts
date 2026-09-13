/**
 * Per-user gated-connector credential broker.
 *
 * Users connect credential-gated catalog connectors (API keys) here. Values
 * are stored AES-256-GCM encrypted and are only ever decrypted for the
 * internal resolve call made by the connectors broker at execute time, so
 * agents and the runtime never see raw credentials. Usage is authorized by
 * a (userAddress, agentWallet, slug) grant, mirroring the backpack
 * permission model.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import * as store from "./storage.js";

export interface EncryptedBlob {
    v: 1;
    iv: string;
    ct: string;
}

export interface GatedConnection {
    userAddress: string;
    slug: string;
    enc: EncryptedBlob;
    varNames: string[];
    status: "active" | "invalid";
    createdAt: number;
    updatedAt: number;
}

export interface GatedConnectionInfo {
    slug: string;
    varNames: string[];
    status: "active" | "invalid";
    createdAt: number;
    updatedAt: number;
    source: "catalog";
}

export interface GatedGrant {
    userAddress: string;
    agentWallet: string;
    slug: string;
    granted: boolean;
    grantedAt: number;
}

function wallet(value: string, label: string): string {
    const normalized = value?.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
        throw new Error(`${label} must be a valid 0x-prefixed EVM address`);
    }
    return normalized;
}

function slug(value: string): string {
    const normalized = value?.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,80}$/u.test(normalized)) {
        throw new Error("slug must be a connector slug");
    }
    return normalized;
}

function varName(value: string): string {
    const normalized = value?.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(normalized)) {
        throw new Error(`invalid credential variable name: ${value}`);
    }
    return normalized.toUpperCase();
}

function connKey(userAddress: string, slugValue: string): string {
    return store.key("gated", "conn", userAddress, slugValue);
}

function indexKey(userAddress: string): string {
    return store.key("gated", "index", userAddress);
}

function grantKey(userAddress: string, agentWallet: string, slugValue: string): string {
    return store.key("gated", "grant", userAddress, agentWallet, slugValue);
}

function grantsKey(userAddress: string): string {
    return store.key("gated", "grants", userAddress);
}

function auditKey(userAddress: string, slugValue: string): string {
    return store.key("gated", "audit", userAddress, slugValue);
}

function grantId(agentWallet: string, slugValue: string): string {
    return `${agentWallet}:${slugValue}`;
}

function credentialKey(): Buffer {
    const raw = process.env.BACKPACK_CREDENTIAL_KEY?.trim();
    if (!raw) {
        throw new Error("BACKPACK_CREDENTIAL_KEY is not set");
    }
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
        throw new Error("BACKPACK_CREDENTIAL_KEY must be 32 bytes base64-encoded");
    }
    return key;
}

function encryptVars(vars: Record<string, string>): EncryptedBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(vars), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { v: 1, iv: iv.toString("base64"), ct: Buffer.concat([ct, tag]).toString("base64") };
}

function decryptVars(enc: EncryptedBlob): Record<string, string> {
    const data = Buffer.from(enc.ct, "base64");
    const tag = data.subarray(data.length - 16);
    const ct = data.subarray(0, data.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(enc.iv, "base64"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("corrupt gated credential record");
    }
    return parsed as Record<string, string>;
}

function info(record: GatedConnection): GatedConnectionInfo {
    return {
        slug: record.slug,
        varNames: record.varNames,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        source: "catalog",
    };
}

export async function connectGated(input: {
    userAddress: string;
    slug: string;
    vars: Record<string, string>;
}): Promise<GatedConnectionInfo> {
    const user = wallet(input.userAddress, "userAddress");
    const slugValue = slug(input.slug);
    const entries = Object.entries(input.vars || {});
    if (entries.length === 0) {
        throw new Error("vars is required: at least one credential variable");
    }
    const vars: Record<string, string> = {};
    for (const [name, value] of entries) {
        const key = varName(name);
        const secret = typeof value === "string" ? value.trim() : "";
        if (!secret) {
            throw new Error(`credential variable ${key} is empty`);
        }
        vars[key] = secret;
    }

    const existing = await store.json<GatedConnection>(connKey(user, slugValue));
    const now = Date.now();
    const record: GatedConnection = {
        userAddress: user,
        slug: slugValue,
        enc: encryptVars(vars),
        varNames: Object.keys(vars).sort(),
        status: "active",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    await store.put(connKey(user, slugValue), record);
    await store.add(indexKey(user), slugValue);
    return info(record);
}

export async function getGated(userAddress: string, slugInput: string): Promise<GatedConnectionInfo | null> {
    const user = wallet(userAddress, "userAddress");
    const slugValue = slug(slugInput);
    const record = await store.json<GatedConnection>(connKey(user, slugValue));
    return record ? info(record) : null;
}

export async function listGated(userAddress: string): Promise<GatedConnectionInfo[]> {
    const user = wallet(userAddress, "userAddress");
    const slugs = await store.members(indexKey(user));
    const records = await Promise.all(slugs.map((slugValue) => store.json<GatedConnection>(connKey(user, slugValue))));
    return records
        .filter((record): record is GatedConnection => Boolean(record))
        .map(info)
        .sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function markGatedStatus(userAddress: string, slugInput: string, status: "active" | "invalid"): Promise<void> {
    const user = wallet(userAddress, "userAddress");
    const slugValue = slug(slugInput);
    const record = await store.json<GatedConnection>(connKey(user, slugValue));
    if (!record || record.status === status) return;
    await store.put(connKey(user, slugValue), { ...record, status, updatedAt: Date.now() });
}

export async function disconnectGated(userAddress: string, slugInput: string): Promise<{ success: boolean }> {
    const user = wallet(userAddress, "userAddress");
    const slugValue = slug(slugInput);
    const record = await store.json<GatedConnection>(connKey(user, slugValue));
    if (record) {
        await store.del(connKey(user, slugValue));
        await store.rem(indexKey(user), slugValue);
    }
    const grants = await store.members(grantsKey(user));
    const stale = grants.filter((id) => id.endsWith(`:${slugValue}`));
    if (stale.length > 0) {
        await store.rem(grantsKey(user), ...stale);
        await store.del(...stale.map((id) => {
            const split = id.indexOf(":");
            return grantKey(user, id.slice(0, split), id.slice(split + 1));
        }));
    }
    return { success: true };
}

export async function grantGated(input: {
    userAddress: string;
    agentWallet: string;
    slug: string;
}): Promise<GatedGrant> {
    const user = wallet(input.userAddress, "userAddress");
    const agent = wallet(input.agentWallet, "agentWallet");
    const slugValue = slug(input.slug);
    const record: GatedGrant = {
        userAddress: user,
        agentWallet: agent,
        slug: slugValue,
        granted: true,
        grantedAt: Date.now(),
    };
    await store.put(grantKey(user, agent, slugValue), record);
    await store.add(grantsKey(user), grantId(agent, slugValue));
    return record;
}

export async function revokeGated(input: {
    userAddress: string;
    agentWallet: string;
    slug: string;
}): Promise<void> {
    const user = wallet(input.userAddress, "userAddress");
    const agent = wallet(input.agentWallet, "agentWallet");
    const slugValue = slug(input.slug);
    await store.del(grantKey(user, agent, slugValue));
    await store.rem(grantsKey(user), grantId(agent, slugValue));
}

export async function hasGatedGrant(userAddress: string, agentWallet: string, slugInput: string): Promise<boolean> {
    const user = wallet(userAddress, "userAddress");
    const agent = wallet(agentWallet, "agentWallet");
    const slugValue = slug(slugInput);
    const record = await store.json<GatedGrant>(grantKey(user, agent, slugValue));
    return Boolean(record?.granted);
}

export async function listGatedGrants(userAddress: string): Promise<GatedGrant[]> {
    const user = wallet(userAddress, "userAddress");
    const ids = await store.members(grantsKey(user));
    const records = await Promise.all(ids.map((id) => {
        const split = id.indexOf(":");
        return store.json<GatedGrant>(grantKey(user, id.slice(0, split), id.slice(split + 1)));
    }));
    return records
        .filter((record): record is GatedGrant => Boolean(record?.granted))
        .sort((left, right) => left.slug.localeCompare(right.slug) || left.agentWallet.localeCompare(right.agentWallet));
}

export async function resolveGated(input: {
    userAddress: string;
    agentWallet: string;
    slug: string;
    runId?: string;
}): Promise<{ vars: Record<string, string> } | null> {
    const user = wallet(input.userAddress, "userAddress");
    const agent = wallet(input.agentWallet, "agentWallet");
    const slugValue = slug(input.slug);
    const record = await store.json<GatedConnection>(connKey(user, slugValue));
    if (!record || record.status !== "active") return null;
    if (!(await hasGatedGrant(user, agent, slugValue))) return null;
    const vars = decryptVars(record.enc);
    await store.push(auditKey(user, slugValue), JSON.stringify({
        agentWallet: agent,
        ...(input.runId ? { runId: input.runId } : {}),
        ts: Date.now(),
    }), 32, 30 * 24 * 3600);
    return { vars };
}
