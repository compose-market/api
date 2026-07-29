/**
 * Compose Keys Types
 * 
 * Type definitions for externally-usable API keys that enable
 * Cursor, OpenClaw, OpenCode, and other external clients to access Compose Market.
 * 
 * @module shared/keys/types
 */

import type { NetworkId } from "../configs/chains.js";

// =============================================================================
// JWT Payload
// =============================================================================

/**
 * Compose Key JWT payload
 * This is encoded in the `compose-...` token
 */
export interface KeyPayload {
    /** User's wallet address (subject) */
    sub: string;
    /** Key ID (UUID) */
    keyId: string;
    /** CAIP-2 network bound to this key */
    network: NetworkId;
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
 * Compose Key record stored in ValKey
 */
export type KeyPurpose = "session" | "api";

export interface KeyRecord {
    /** Unique key identifier */
    keyId: string;
    /** User's wallet address */
    userAddress: string;
    /** Whether the key powers the first-party session or an external API client */
    purpose: KeyPurpose;
    /** Budget allowed for this key in USDC wei */
    budgetLimit: number;
    /** Budget used so far in USDC wei */
    budgetUsed: number;
    /** Budget reserved by in-flight payment intents */
    budgetReserved?: number;
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
    /** CAIP-2 network bound to this key */
    network: NetworkId;
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
    /** Required key purpose */
    purpose: KeyPurpose;
    /** Optional name */
    name?: string;
    /** Required CAIP-2 network */
    network: NetworkId;
}

/**
 * Create key response
 */
export interface CreateKeyResponse {
    /** Unique key ID */
    keyId: string;
    /** Full token (compose-...) */
    token: string;
    /** Key purpose */
    purpose: KeyPurpose;
    /** CAIP-2 network */
    network: NetworkId;
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
    payload?: KeyPayload;
    /** Key record if valid */
    record?: KeyRecord;
}


// =============================================================================
// Session Lookup Types
// =============================================================================

export type SessionInactiveReason =
    | "none"
    | "expired"
    | "budget_exhausted"
    | "revoked"
    | "network_mismatch"
    | "missing_budget_state";

export interface ActiveSessionRecord {
    keyId: string;
    token: string;
    budgetLimit: number;
    budgetUsed: number;
    budgetLocked: number;
    budgetRemaining: number;
    expiresAt: number;
    network: NetworkId;
    name?: string;
}

export interface ActiveSessionStatus {
    session: ActiveSessionRecord | null;
    reason: SessionInactiveReason;
    latestKey?: {
        keyId: string;
        budgetLimit: number;
        budgetUsed: number;
        budgetLocked: number;
        budgetRemaining: number;
        expiresAt: number;
        network: NetworkId;
        name?: string;
        revokedAt?: number;
    };
}
