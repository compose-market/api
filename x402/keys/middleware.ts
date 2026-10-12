/**
 * Compose Keys - Middleware
 * 
 * HTTP request handling for Compose Key authentication.
 * Extracts Authorization header and validates keys.
 * 
 * @module shared/keys/middleware
 */

import { verifyKey } from "./jwt.js";
import { getKeyRecord, isKeyRevoked } from "./storage.js";
import type { KeyValidationResult, KeyPayload } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const COMPOSE_KEY_PREFIX = "compose-";
const BEARER_PREFIX = "Bearer ";

// =============================================================================
// Middleware Functions
// =============================================================================

/**
 * Extract Compose Key from Authorization header
 * 
 * @param authHeader - Authorization header value
 * @returns Token string or null
 */
export function extractKeyFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) return null;

    // Handle "Bearer compose-..."
    if (authHeader.startsWith(BEARER_PREFIX)) {
        const token = authHeader.slice(BEARER_PREFIX.length);
        if (token.startsWith(COMPOSE_KEY_PREFIX)) {
            return token;
        }
    }

    // Handle direct "compose-..." (less common)
    if (authHeader.startsWith(COMPOSE_KEY_PREFIX)) {
        return authHeader;
    }

    return null;
}

/**
 * Validate a Compose Key
 * 
 * Performs full validation:
 * 1. JWT signature verification
 * 2. Expiration check
 * 3. Revocation check
 * 4. Budget check
 * 
 * @param token - Full token including compose- prefix
 * @param requiredBudget - Minimum budget required in USDC wei
 * @returns Validation result
 */
export async function validateKey(
    token: string,
    requiredBudget: number = 0
): Promise<KeyValidationResult> {
    // Step 1: Verify JWT
    const payload = verifyKey(token);
    if (!payload) {
        return { valid: false, error: "Invalid or expired token" };
    }

    // Step 2 & 3: Check revocation and get current record in parallel
    const [revoked, record] = await Promise.all([
        isKeyRevoked(payload.keyId),
        getKeyRecord(payload.keyId),
    ]);
    if (revoked || record?.revokedAt) {
        return { valid: false, error: "Key has been revoked" };
    }

    if (!record) {
        return { valid: false, error: "Key not found" };
    }

    // Step 4: Check expiration (server-side check)
    if (record.expiresAt < Date.now()) {
        return { valid: false, error: "Key has expired" };
    }

    // Step 5: Check budget
    const remaining = record.budgetLimit - record.budgetUsed;
    if (remaining < requiredBudget) {
        return {
            valid: false,
            error: `Insufficient budget: ${remaining} wei available, ${requiredBudget} wei required`,
        };
    }

    return {
        valid: true,
        payload,
        record,
    };
}

/**
 * Check if request has Compose Key authentication
 */
export function hasKeyAuth(authHeader: string | undefined): boolean {
    return extractKeyFromHeader(authHeader) !== null;
}

/**
 * Get key budget info for response headers
 */
export async function getKeyBudgetInfo(keyId: string): Promise<{
    budgetLimit: number;
    budgetUsed: number;
    budgetRemaining: number;
} | null> {
    const record = await getKeyRecord(keyId);
    if (!record) return null;

    return {
        budgetLimit: record.budgetLimit,
        budgetUsed: record.budgetUsed,
        budgetRemaining: Math.max(0, record.budgetLimit - record.budgetUsed),
    };
}
