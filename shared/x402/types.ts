/**
 * x402 Payment Types
 * 
 * Type definitions for x402 payment operations.
 * Compatible with ThirdWeb x402 SDK.
 * 
 * @module shared/x402/types
 */

// =============================================================================
// ThirdWeb PaymentArgs (mirrors thirdweb/x402)
// =============================================================================

/**
 * PaymentArgs structure for verifyPayment() and settlePayment()
 */
export interface PaymentArgs {
    /** Facilitator instance from facilitator() */
    facilitator: unknown;
    /** HTTP method */
    method: "GET" | "POST" | "PUT" | "DELETE";
    /** ThirdWeb chain object or config */
    network: unknown;
    /** Payment scheme */
    scheme: "exact" | "upto";
    /** Price configuration */
    price: {
        amount: string;
        asset: {
            address: `0x${string}`;
        };
    };
    /** Resource URL being accessed */
    resourceUrl: string;
    /** Signed payment data from client */
    paymentData?: string | null;
}

// =============================================================================
// Payment Result Types
// =============================================================================

/**
 * Result from x402 payment settlement
 */
export interface X402SettlementResult {
    /** HTTP status code (200 = success, 402 = payment required) */
    status: number;
    /** Response body */
    responseBody: unknown;
    /** Response headers (includes x402 headers for 402 responses) */
    responseHeaders: Record<string, string>;
}

/**
 * Extracted payment info from request headers
 */
export interface PaymentInfo {
    /** Signed payment data from x-payment header */
    paymentData: string | null;
    /** Whether session is active */
    sessionActive: boolean;
    /** Remaining session budget in wei */
    sessionBudgetRemaining: number;
}

// =============================================================================
// Pricing Types
// =============================================================================

/**
 * Price calculation result
 */
export interface PriceResult {
    /** Provider cost in USD */
    providerCost: number;
    /** Platform fee in USD */
    platformFee: number;
    /** Total cost in USD */
    totalCost: number;
    /** Total cost in USDC wei (6 decimals) */
    costUsdcWei: bigint;
    /** Provider name (for routing) */
    provider?: string;
}

/**
 * Dynamic price lookup parameters
 */
export interface PriceLookupParams {
    /** Model ID */
    modelId?: string;
    /** Task type for multimodal pricing */
    taskType?: string;
    /** Tool source for tool pricing */
    toolSource?: "goat" | "mcp" | "eliza";
    /** Tool name */
    toolName?: string;
    /** Whether tool is a transaction */
    isTransaction?: boolean;
    /** Tool complexity */
    complexity?: "simple" | "complex";
}

// =============================================================================
// Session Types
// =============================================================================

/**
 * x402 session state
 */
export interface SessionState {
    /** Whether session is active */
    isActive: boolean;
    /** Total budget limit in wei */
    budgetLimit: number;
    /** Amount used so far */
    budgetUsed: number;
    /** Remaining budget */
    budgetRemaining: number;
    /** Expiration timestamp */
    expiresAt: number | null;
    /** Session key address (ERC4337) or session ID (x402 V2) */
    sessionKeyAddress: string | null;
    /** x402 V2 session token (for future migration) */
    x402SessionToken?: string;
}

// =============================================================================
// Agent Card Payment Types (from schema.ts)
// =============================================================================

/**
 * x402 payment method configuration
 */
export interface X402PaymentMethod {
    /** Local ID for referencing */
    id: string;
    /** Payment method type */
    method: "x402" | "ap2" | "custom" | "free";
    /** Chain ID as string */
    network: string;
    /** Asset symbol (e.g., "USDC") */
    assetSymbol: string;
    /** Asset contract address */
    assetAddress: string;
    /** Payee wallet address */
    payee: string;
    /** x402-specific configuration */
    x402?: {
        scheme: "exact" | "upto";
        facilitatorUrl?: string;
        facilitatorId?: string;
    };
}

/**
 * Skill pricing configuration
 */
export interface SkillPricing {
    /** Price unit: "call", "token", "second", etc. */
    unit: string;
    /** Price amount in smallest unit (wei) */
    amount: string;
    /** Reference to payment method ID */
    paymentMethodId?: string;
}
