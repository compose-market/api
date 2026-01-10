/**
 * Compose Keys Types
 * 
 * Type definitions for externally-usable API keys that enable
 * Cursor, VSCode, and other external clients to access Compose Market.
 * 
 * @module shared/keys/types
 */

// =============================================================================
// JWT Payload
// =============================================================================

/**
 * Compose Key JWT payload
 * This is encoded in the `compose-...` token
 */
export interface ComposeKeyPayload {
    /** User's wallet address (subject) */
    sub: string;
    /** Key ID (UUID) */
    keyId: string;
    /** Budget allowed for this key in USDC wei (6 decimals) */
    budgetLimit: number;
    /** Budget already used in USDC wei */
    budgetUsed: number;
    /** Expiration timestamp (Unix seconds) */
    exp: number;
    /** Issued at timestamp (Unix seconds) */
    iat: number;
}

// =============================================================================
// Key Record (for storage/API response)
// =============================================================================

/**
 * Compose Key record stored in Redis
 */
export interface ComposeKeyRecord {
    /** Unique key identifier */
    keyId: string;
    /** User's wallet address */
    userAddress: string;
    /** Budget allowed for this key in USDC wei */
    budgetLimit: number;
    /** Budget used so far in USDC wei */
    budgetUsed: number;
    /** Creation timestamp */
    createdAt: number;
    /** Expiration timestamp */
    expiresAt: number;
    /** Revocation timestamp (if revoked) */
    revokedAt?: number;
    /** User-provided name/label */
    name?: string;
    /** Last usage timestamp */
    lastUsedAt?: number;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Create key request
 */
export interface CreateKeyRequest {
    /** Budget in USDC wei */
    budgetLimit: number;
    /** Expiration timestamp */
    expiresAt: number;
    /** Optional name */
    name?: string;
}

/**
 * Create key response
 */
export interface CreateKeyResponse {
    /** Unique key ID */
    keyId: string;
    /** Full token (compose-...) */
    token: string;
    /** Budget limit */
    budgetLimit: number;
    /** Expiration */
    expiresAt: number;
    /** Name if provided */
    name?: string;
}

/**
 * Key validation result
 */
export interface KeyValidationResult {
    /** Whether the key is valid */
    valid: boolean;
    /** Error message if invalid */
    error?: string;
    /** Key payload if valid */
    payload?: ComposeKeyPayload;
    /** Key record if valid */
    record?: ComposeKeyRecord;
}
