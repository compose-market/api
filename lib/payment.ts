/**
 * x402 Payment Module
 * 
 * Exact implementation from x402-starter-kit reference.
 * Uses settlePayment which handles both 402 response and settlement.
 */
import { createThirdwebClient } from "thirdweb";
import { facilitator, settlePayment } from "thirdweb/x402";
import { avalancheFuji, avalanche, USDC_ADDRESSES } from "../shared/thirdweb";

// Server-side client with secret key
const serverClient = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY!,
});

// Server wallet address (Thirdweb Server Wallet)
const serverWalletAddress = process.env.THIRDWEB_SERVER_WALLET_ADDRESS as `0x${string}`;

// Merchant wallet that receives payments
const merchantWalletAddress = process.env.MERCHANT_WALLET_ADDRESS as `0x${string}`;

// Payment chain
const paymentChain = process.env.USE_MAINNET === "true" ? avalanche : avalancheFuji;

// USDC token address
const usdcAddress = USDC_ADDRESSES[paymentChain.id];

// x402 Facilitator - exactly as in starter kit
const thirdwebFacilitator = facilitator({
  client: serverClient,
  serverWalletAddress,
});

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
 * Handle x402 payment - exactly as in starter kit
 */
export async function handleX402Payment(
  paymentData: string | null,
  resourceUrl: string,
  method: string,
  amountWei: string,
): Promise<{
  status: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
}> {
  console.log(`[x402] settlePayment for ${resourceUrl}`);
  console.log(`[x402] paymentData present: ${!!paymentData}`);
  console.log(`[x402] amount: ${amountWei}`);
  console.log(`[x402] payTo: ${merchantWalletAddress}`);
  console.log(`[x402] facilitator: ${serverWalletAddress}`);

  const result = await settlePayment({
    resourceUrl,
    method,
    paymentData,
    payTo: merchantWalletAddress,
    network: paymentChain,
    price: {
      amount: amountWei,
      asset: {
        address: usdcAddress,
      },
    },
    facilitator: thirdwebFacilitator,
  });

  console.log(`[x402] result status: ${result.status}`);

  // SettlePaymentResult is a union type:
  // - status 200: { paymentReceipt: {...} }
  // - status 402/500/etc: { responseBody: {...} }
  return {
    status: result.status,
    responseBody: result.status === 200
      ? { success: true, receipt: (result as { paymentReceipt: unknown }).paymentReceipt }
      : (result as { responseBody: unknown }).responseBody,
    responseHeaders: result.responseHeaders as Record<string, string>,
  };
}

// Export for use in other modules
export { serverWalletAddress, merchantWalletAddress, paymentChain, usdcAddress, serverClient };

