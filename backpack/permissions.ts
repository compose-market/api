import * as store from "./storage.js";

export type ConsentType =
    | "filesystem"
    | "camera"
    | "microphone"
    | "geolocation"
    | "clipboard"
    | "notifications";

export interface UserPermission {
    userAddress: string;
    agentWallet: string;
    consentType: ConsentType;
    granted: boolean;
    grantedAt: number;
    expiresAt?: number;
}

const consents = new Set<ConsentType>([
    "filesystem",
    "camera",
    "microphone",
    "geolocation",
    "clipboard",
    "notifications",
]);

function wallet(value: string, label: string): string {
    const normalized = value?.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
        throw new Error(`${label} must be a valid 0x-prefixed EVM address`);
    }
    return normalized;
}

function consent(value: string): ConsentType {
    const normalized = value?.trim().toLowerCase() as ConsentType;
    if (!consents.has(normalized)) {
        throw new Error("consentType must be a browser permission");
    }
    return normalized;
}

function perm(userAddress: string, agentWallet: string, consentType: string): string {
    return store.key("permission", userAddress, agentWallet, consentType);
}

function index(userAddress: string, agentWallet: string): string {
    return store.key("permissions", userAddress, agentWallet);
}

function live(record: UserPermission): boolean {
    return !record.expiresAt || Date.now() <= record.expiresAt;
}

export async function checkPermission(
    userAddress: string,
    agentWallet: string,
    consentType: ConsentType | string,
): Promise<boolean> {
    const user = wallet(userAddress, "userAddress");
    const agent = wallet(agentWallet, "agentWallet");
    const type = consent(consentType);
    const key = perm(user, agent, type);
    const record = await store.json<UserPermission>(key);
    if (!record?.granted) return false;
    if (live(record)) return true;
    await store.del(key);
    await store.rem(index(user, agent), type);
    return false;
}

export async function grantPermission(params: {
    userAddress: string;
    agentWallet: string;
    consentType: ConsentType | string;
    expiresAt?: number;
}): Promise<UserPermission> {
    const user = wallet(params.userAddress, "userAddress");
    const agent = wallet(params.agentWallet, "agentWallet");
    const type = consent(params.consentType);
    const record: UserPermission = {
        userAddress: user,
        agentWallet: agent,
        consentType: type,
        granted: true,
        grantedAt: Date.now(),
        ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    };
    await store.put(perm(user, agent, type), record);
    await store.add(index(user, agent), type);
    return record;
}

export async function revokePermission(
    userAddress: string,
    agentWallet: string,
    consentType: ConsentType | string,
): Promise<void> {
    const user = wallet(userAddress, "userAddress");
    const agent = wallet(agentWallet, "agentWallet");
    const type = consent(consentType);
    await store.del(perm(user, agent, type));
    await store.rem(index(user, agent), type);
}

export async function listPermissions(
    userAddress: string,
    agentWallet: string,
): Promise<UserPermission[]> {
    const user = wallet(userAddress, "userAddress");
    const agent = wallet(agentWallet, "agentWallet");
    const types = await store.members(index(user, agent));
    const records = await Promise.all(types.map((type) => store.json<UserPermission>(perm(user, agent, type))));
    const out: UserPermission[] = [];
    for (const record of records) {
        if (!record) continue;
        if (record.granted && live(record)) {
            out.push(record);
            continue;
        }
        await store.del(perm(user, agent, record.consentType));
        await store.rem(index(user, agent), record.consentType);
    }
    return out.sort((left, right) => left.consentType.localeCompare(right.consentType));
}
