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
    KeyPayload,
    KeyRecord,
    CreateKeyRequest,
    CreateKeyResponse,
    KeyValidationResult,
    ActiveSessionRecord,
    ActiveSessionStatus,
    SessionInactiveReason,
} from "./types.js";

// JWT operations
export { signKey, verifyKey, extractKeyId } from "./jwt.js";

// Storage operations
export {
    createKey,
    getKeyRecord,
    listUserKeys,
    isKeyRevoked,
    revokeKey,
    getKeyBudgetRemaining,
    getActiveSessionStatus,
    verifyActiveSessionKey,
} from "./storage.js";

// Middleware
export {
    extractKeyFromHeader,
    validateKey,
    hasKeyAuth,
    getKeyBudgetInfo,
} from "./middleware.js";

// Session Events (SSE)
export { registerSessionEventsRoute } from "./sse.js";

// Expiry Worker
export { expiryWorker } from "./expiry.js";
