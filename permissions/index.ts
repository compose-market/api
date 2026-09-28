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
    const trimmed = value?.trim() ?? "";
    if (/^0x[a-fA-F0-9]{40}$/u.test(trimmed) || /^0s[a-fA-F0-9]{40}$/u.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    if (/^0u[0123456789abcdefghjkmnpqrstvwxyz]{51}[0g]$/u.test(trimmed)) {
        return trimmed;
    }
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(trimmed)) {
        return trimmed;
    }
    if (
        trimmed.length >= 2
        && trimmed.length <= 64
        && (/^[0-9a-f]{64}$/u.test(trimmed) || /^(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+$/u.test(trimmed))
    ) {
        return trimmed;
    }
    throw new Error(`${label} must be a valid EVM, Solana, or NEAR address`);
}

function consent(value: string): ConsentType {
    const normalized = value?.trim().toLowerCase() as ConsentType;
    if (!consents.has(normalized)) {
        throw new Error("consentType must be a browser permission");
    }
    return normalized;
}