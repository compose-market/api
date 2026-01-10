/**
 * Compose Keys - JWT Operations
 * 
 * Handles signing and verification of Compose Key JWTs.
 * Uses SESSION_SECRET from environment for HMAC-SHA256 signing.
 * 
 * @module shared/keys/jwt
 */

import { createHmac } from "crypto";
import type { ComposeKeyPayload } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const COMPOSE_KEY_PREFIX = "compose-";
const ALGORITHM = "HS256";

// =============================================================================
// Helpers
// =============================================================================

function getSecret(): string {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error("SESSION_SECRET environment variable required");
    }
    return secret;
}

/**
 * Base64url encode (URL-safe base64)
 */
function base64urlEncode(data: string | Buffer): string {
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * Base64url decode
 */
function base64urlDecode(data: string): string {
    const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
    return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
}

/**
 * Create HMAC-SHA256 signature
 */
function sign(data: string, secret: string): string {
    const hmac = createHmac("sha256", secret);
    hmac.update(data);
    return base64urlEncode(hmac.digest());
}

// =============================================================================
// JWT Operations
// =============================================================================

/**
 * Sign a Compose Key JWT
 * 
 * @param payload - Key payload to encode
 * @returns Full token with `compose-` prefix
 */
export function signComposeKey(payload: Omit<ComposeKeyPayload, "iat">): string {
    const secret = getSecret();

    const header = { alg: ALGORITHM, typ: "JWT" };
    const fullPayload: ComposeKeyPayload = {
        ...payload,
        iat: Math.floor(Date.now() / 1000),
    };

    const headerB64 = base64urlEncode(JSON.stringify(header));
    const payloadB64 = base64urlEncode(JSON.stringify(fullPayload));
    const signature = sign(`${headerB64}.${payloadB64}`, secret);

    const jwt = `${headerB64}.${payloadB64}.${signature}`;
    return `${COMPOSE_KEY_PREFIX}${jwt}`;
}

/**
 * Verify and decode a Compose Key JWT
 * 
 * @param token - Full token including `compose-` prefix
 * @returns Decoded payload or null if invalid
 */
export function verifyComposeKey(token: string): ComposeKeyPayload | null {
    // Check prefix
    if (!token.startsWith(COMPOSE_KEY_PREFIX)) {
        return null;
    }

    const jwt = token.slice(COMPOSE_KEY_PREFIX.length);
    const parts = jwt.split(".");

    if (parts.length !== 3) {
        return null;
    }

    const [headerB64, payloadB64, signature] = parts;

    try {
        const secret = getSecret();

        // Verify signature
        const expectedSig = sign(`${headerB64}.${payloadB64}`, secret);
        if (signature !== expectedSig) {
            console.log("[keys/jwt] Signature mismatch");
            return null;
        }

        // Decode payload
        const payload: ComposeKeyPayload = JSON.parse(base64urlDecode(payloadB64));

        // Check expiration
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
            console.log("[keys/jwt] Token expired");
            return null;
        }

        return payload;
    } catch (err) {
        console.error("[keys/jwt] Verification error:", err);
        return null;
    }
}

/**
 * Extract key ID from token without full verification
 * Useful for logging and quick lookups
 */
export function extractKeyId(token: string): string | null {
    if (!token.startsWith(COMPOSE_KEY_PREFIX)) {
        return null;
    }

    try {
        const jwt = token.slice(COMPOSE_KEY_PREFIX.length);
        const [, payloadB64] = jwt.split(".");
        const payload = JSON.parse(base64urlDecode(payloadB64));
        return payload.keyId || null;
    } catch {
        return null;
    }
}
