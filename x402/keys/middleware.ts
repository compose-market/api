/**
 * Compose Keys - Middleware
 * 
 * HTTP request handling for Compose Key authentication.
 * Extracts Authorization header and validates keys.
 * 
 * @module shared/keys/middleware
 */

import { verifyComposeKey } from "./jwt.js";
import { getKeyRecord, isKeyRevoked, recordKeyUsage, getKeyBudgetRemaining } from "./storage.js";
import type { KeyValidationResult, ComposeKeyPayload } from "./types.js";

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
export function extractComposeKeyFromHeader(authHeader: string | undefined): string | null {
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
export async function validateComposeKey(
    token: string,
    requiredBudget: number = 0
): Promise<KeyValidationResult> {
    // Step 1: Verify JWT
    const payload = verifyComposeKey(token);
    if (!payload) {
        return { valid: false, error: "Invalid or expired token" };
    }

    // Step 2: Check revocation
    if (await isKeyRevoked(payload.keyId)) {
        return { valid: false, error: "Key has been revoked" };
    }

    // Step 3: Get current record (for up-to-date budget)
    const record = await getKeyRecord(payload.keyId);
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
 * Consume budget from a Compose Key
 * 
 * @param keyId - Key ID
 * @param amountWei - Amount to consume
 * @returns New total used, or -1 if failed
 */
export async function consumeKeyBudget(keyId: string, amountWei: number): Promise<number> {
    return recordKeyUsage(keyId, amountWei);
}

/**
 * Check if request has Compose Key authentication
 */
export function hasComposeKeyAuth(authHeader: string | undefined): boolean {
    return extractComposeKeyFromHeader(authHeader) !== null;
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
