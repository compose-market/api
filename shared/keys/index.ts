/**
 * Compose Keys Module
 * 
 * Public API for Compose Key operations.
 * Enables external clients (Cursor, OpenClaw, OpenCode, ...) to access Compose Market.
 * 
 * @module shared/keys
 */

// Types
export type {
    ComposeKeyPayload,
    ComposeKeyRecord,
    CreateKeyRequest,
    CreateKeyResponse,
    KeyValidationResult,
} from "./types.js";

// JWT operations
export { signComposeKey, verifyComposeKey, extractKeyId } from "./jwt.js";

// Storage operations
export {
    createComposeKey,
    getKeyRecord,
    listUserKeys,
    recordKeyUsage,
    isKeyRevoked,
    revokeKey,
    getKeyBudgetRemaining,
    getActiveSession,
} from "./storage.js";

// Middleware
export {
    extractComposeKeyFromHeader,
    validateComposeKey,
    consumeKeyBudget,
    hasComposeKeyAuth,
    getKeyBudgetInfo,
} from "./middleware.js";
