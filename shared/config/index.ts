/**
 * Config Module
 * 
 * Single entry point for all configuration.
 * Import from this file instead of individual config files.
 * 
 * @module shared/config
 */

// Chain configuration (multi-EVM)
export {
    CHAIN_IDS,
    CHAIN_ID_STRINGS,
    THIRDWEB_CHAIN_IDS,
    USDC_ADDRESSES,
    CHAIN_CONFIG,
    getActiveChainId,
    getUsdcAddress,
    getChainConfig,
    isTestnet,
    getSupportedChainIds,
    getTestnetChainIds,
    getMainnetChainIds,
    type ChainId,
    type ChainConfig,
} from "./chains.js";

// ThirdWeb client and x402 setup
export {
    serverClient,
    serverWalletAddress,
    merchantWalletAddress,
    treasuryWalletAddress,
    paymentChain,
    paymentChainId,
    paymentAsset,
    thirdwebFacilitator,
    INFERENCE_PRICE_WEI,
    PRICE_PER_TOKEN_WEI,
    MAX_TOKENS_PER_CALL,
    SESSION_BUDGET_PRESETS,
    calculateCostUSDC,
    formatUsdcAmount,
    parseUsdcAmount,
    avalancheFuji,
    avalanche,
} from "./thirdweb.js";

/**
 * Default payment configuration for Compose Market
 */
export const DEFAULT_PAYMENT_CONFIG = {
    network: "43113", // Avalanche Fuji (from getActiveChainId in production)
    assetSymbol: "USDC",
    assetAddress: "0x5425890298aed601595a70AB815c96711a31Bc65" as `0x${string}`,
    scheme: "upto" as const,
};

/**
 * Pricing configuration for AI inference
 */
export const PRICING_CONFIG = {
    pricePerTokenWei: 1, // 0.000001 USDC per token
    maxTokensPerCall: 100_000,
};
