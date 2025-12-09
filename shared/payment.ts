/**
 * x402 Payment Helpers
 * 
 * ThirdWeb-native helpers for x402 payment verification and settlement.
 * Wraps facilitator, verifyPayment, and settlePayment from thirdweb/x402.
 */
import type { ComposeAgentCard, ComposeAgentSkill, ComposePaymentMethod } from "./schema.js";
import { THIRDWEB_CHAIN_IDS, DEFAULT_PAYMENT_CONFIG } from "./schema.js";

/**
 * ThirdWeb PaymentArgs structure (mirrors thirdweb/x402)
 * 
 * This is the structure expected by verifyPayment() and settlePayment()
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

/**
 * Build PaymentArgs for a skill call
 * 
 * This creates the payment args structure compatible with ThirdWeb's
 * verifyPayment() and settlePayment() functions.
 */
export function createSkillPaymentArgs(
  skill: ComposeAgentSkill,
  card: ComposeAgentCard,
  options: {
    facilitator: unknown;
    network: unknown;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    resourceUrl: string;
    paymentData?: string | null;
  }
): PaymentArgs | null {
  // Find the payment method for this skill
  const paymentMethodId = skill.pricing?.paymentMethodId;
  if (!paymentMethodId) {
    return null;
  }
  
  const paymentMethod = card.payments.find((p) => p.id === paymentMethodId);
  if (!paymentMethod || paymentMethod.method !== "x402") {
    return null;
  }
  
  // Build the payment args
  return {
    facilitator: options.facilitator,
    method: options.method || "POST",
    network: options.network,
    scheme: paymentMethod.x402?.scheme || "upto",
    price: {
      amount: skill.pricing?.amount || "0",
      asset: {
        address: paymentMethod.assetAddress as `0x${string}`,
      },
    },
    resourceUrl: options.resourceUrl,
    paymentData: options.paymentData,
  };
}

/**
 * Get the default payment method from a card
 */
export function getDefaultPaymentMethod(
  card: ComposeAgentCard
): ComposePaymentMethod | null {
  // Look for x402 method first
  const x402 = card.payments.find((p) => p.method === "x402");
  if (x402) {
    return x402;
  }
  
  // Fall back to first payment method
  return card.payments[0] || null;
}

/**
 * Check if a skill requires payment
 */
export function skillRequiresPayment(skill: ComposeAgentSkill): boolean {
  return !!(skill.pricing && skill.pricing.amount && skill.pricing.amount !== "0");
}

/**
 * Calculate total cost for multiple skill calls
 */
export function calculateTotalCost(
  skills: ComposeAgentSkill[],
  callCounts: Record<string, number>
): bigint {
  let total = BigInt(0);
  
  for (const skill of skills) {
    const count = callCounts[skill.id] || 0;
    if (count > 0 && skill.pricing?.amount) {
      total += BigInt(skill.pricing.amount) * BigInt(count);
    }
  }
  
  return total;
}

/**
 * Format USDC amount from wei to human-readable
 */
export function formatUsdcAmount(weiAmount: string | bigint): string {
  const wei = typeof weiAmount === "string" ? BigInt(weiAmount) : weiAmount;
  const usdc = Number(wei) / 1e6;
  return usdc.toFixed(6);
}

/**
 * Parse USDC amount from human-readable to wei
 */
export function parseUsdcAmount(usdcAmount: string | number): string {
  const usdc = typeof usdcAmount === "string" ? parseFloat(usdcAmount) : usdcAmount;
  const wei = Math.floor(usdc * 1e6);
  return wei.toString();
}

/**
 * Get chain config for a payment method
 */
export function getChainConfig(paymentMethod: ComposePaymentMethod): {
  chainId: number;
  name: string;
  isTestnet: boolean;
} {
  const chainId = parseInt(paymentMethod.network, 10);
  
  switch (chainId) {
    case 43113:
      return { chainId, name: "Avalanche Fuji", isTestnet: true };
    case 43114:
      return { chainId, name: "Avalanche", isTestnet: false };
    case 42161:
      return { chainId, name: "Arbitrum One", isTestnet: false };
    case 421614:
      return { chainId, name: "Arbitrum Sepolia", isTestnet: true };
    case 137:
      return { chainId, name: "Polygon", isTestnet: false };
    case 80001:
      return { chainId, name: "Polygon Mumbai", isTestnet: true };
    case 1:
      return { chainId, name: "Ethereum", isTestnet: false };
    case 11155111:
      return { chainId, name: "Sepolia", isTestnet: true };
    case 8453:
      return { chainId, name: "Base", isTestnet: false };
    case 84532:
      return { chainId, name: "Base Sepolia", isTestnet: true };
    default:
      return { chainId, name: `Chain ${chainId}`, isTestnet: false };
  }
}

/**
 * Validate payment data header
 */
export function validatePaymentDataHeader(header: string | undefined | null): {
  valid: boolean;
  error?: string;
} {
  if (!header) {
    return { valid: false, error: "Missing x-payment header" };
  }
  
  // Basic format validation (should be base64-encoded JSON)
  try {
    // Payment data should be a non-empty string
    if (typeof header !== "string" || header.length < 10) {
      return { valid: false, error: "Invalid payment data format" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid payment data encoding" };
  }
}

/**
 * Extract payment info from request headers
 */
export function extractPaymentInfo(headers: Record<string, string | string[] | undefined>): {
  paymentData: string | null;
  sessionActive: boolean;
  sessionBudgetRemaining: number;
} {
  const paymentData = typeof headers["x-payment"] === "string" ? headers["x-payment"] : null;
  const sessionActive = headers["x-session-active"] === "true";
  const sessionBudgetRemaining = parseInt(
    typeof headers["x-session-budget-remaining"] === "string" 
      ? headers["x-session-budget-remaining"] 
      : "0",
    10
  );
  
  return {
    paymentData,
    sessionActive,
    sessionBudgetRemaining,
  };
}

/**
 * Build x402 response headers for payment required
 */
export function buildPaymentRequiredHeaders(
  paymentMethod: ComposePaymentMethod,
  skill: ComposeAgentSkill
): Record<string, string> {
  return {
    "X-Payment-Required": "true",
    "X-Payment-Network": paymentMethod.network,
    "X-Payment-Asset": paymentMethod.assetAddress,
    "X-Payment-Amount": skill.pricing?.amount || "0",
    "X-Payment-Scheme": paymentMethod.x402?.scheme || "exact",
    "X-Payment-Payee": paymentMethod.payee,
  };
}

