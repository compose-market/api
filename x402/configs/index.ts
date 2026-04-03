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
    USDC_ADDRESSES,
    CHAIN_CONFIG,
    getActiveChainId,
    getUsdcAddress,
    getChainConfig,
    getRpcUrl,
    isTestnet,
    getSupportedChainIds,
    getTestnetChainIds,
    getMainnetChainIds,
    getViemChain,
    VIEM_CHAIN_MAP,
    type ChainId,
    type ChainConfig,
} from "./chains.js";

// Wallet addresses and payment chain setup
export {
    serverWalletAddress,
    merchantWalletAddress,
    treasuryWalletAddress,
    paymentChain,
    paymentChainId,
    paymentAsset,
} from "../wallets.js";

/**
 * Default payment configuration for Compose Market
 * Defaults to Avalanche Fuji with USDC.
 */
export const DEFAULT_PAYMENT_CONFIG = {
    network: "43113",
    assetSymbol: "USDC",
    assetAddress: "0x5425890298aed601595a70AB815c96711a31Bc65" as `0x${string}`,
    scheme: "exact" as const,
};
