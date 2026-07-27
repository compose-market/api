import type { Request } from "express";

export const DEFAULT_PUBLIC_ORIGIN = "https://api.compose.market";

const PUBLIC_ORIGINS = new Map([
    ["api.compose.market", DEFAULT_PUBLIC_ORIGIN],
    ["api.inference.diy", "https://api.inference.diy"],
]);

function normalizeHost(value: string | undefined): string {
    const candidate = value?.split(",", 1)[0]?.trim().toLowerCase() || "";
    if (!candidate) return "";

    try {
        return new URL(`https://${candidate}`).hostname.toLowerCase();
    } catch {
        return "";
    }
}

export function publicOriginFromHost(value: string | undefined): string {
    return PUBLIC_ORIGINS.get(normalizeHost(value)) || DEFAULT_PUBLIC_ORIGIN;
}

export function publicOriginFromRequest(req: Request): string {
    const host = req.get("host");
    const hostname = normalizeHost(host);
    if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname)) {
        return `${req.protocol || "http"}://${host}`;
    }
    return publicOriginFromHost(host);
}

export function publicResourceUrl(req: Request): string {
    return `${publicOriginFromRequest(req)}${req.originalUrl || req.url}`;
}

export function isPublicHost(value: string | undefined): boolean {
    return PUBLIC_ORIGINS.has(normalizeHost(value));
}
