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
    PRICE_PER_TOKEN_WEI,
    MAX_TOKENS_PER_CALL,
    SESSION_BUDGET_PRESETS,
    calculateCostUSDC,
    formatUsdcAmount,
    parseUsdcAmount,
} from "../thirdweb.js";

export { INFERENCE_PRICE_WEI } from "../pricing.js";

// Chain objects (from chains.js single source of truth)
export {
    cronosTestnet,
    CHAIN_MAP,
    getChainObject,
} from "./chains.js";

/**
 * Default payment configuration for Compose Market
 * Defaults to Cronos Testnet with devUSDC.e token
 */
export const DEFAULT_PAYMENT_CONFIG = {
    network: "338", // Cronos Testnet (default for x402 payments)
    assetSymbol: "USDC",
    assetAddress: "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0" as `0x${string}`, // devUSDC.e
    scheme: "upto" as const,
};

/**
 * Pricing configuration for AI inference
 */
export const PRICING_CONFIG = {
    pricePerTokenWei: 1, // 0.000001 USDC per token
    maxTokensPerCall: 100_000,
};
