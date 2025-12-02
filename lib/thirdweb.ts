import { createThirdwebClient } from "thirdweb";
import { 
  avalancheFuji, 
  avalanche, 
  USDC_ADDRESSES,
  PRICE_PER_TOKEN_WEI,
  MAX_TOKENS_PER_CALL,
} from "../shared/thirdweb";

// Server-side thirdweb client (uses secret key - NEVER expose to client)
export const serverClient = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY!,
});

// Treasury wallet address that receives x402 payments
export const serverWalletAddress = process.env.TREASURY_SERVER_WALLET_PUBLIC as `0x${string}`;

// Payment chain configuration
export const paymentChain = process.env.USE_MAINNET === "true" 
  ? avalanche 
  : avalancheFuji;

export const paymentAsset = {
  address: USDC_ADDRESSES[paymentChain.id],
};

// Re-export shared constants
export { PRICE_PER_TOKEN_WEI, MAX_TOKENS_PER_CALL };

