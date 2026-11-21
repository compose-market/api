import { NETWORK_IDS, type NearNetworkId } from "./configs/chains.js";

export const merchantWalletAddress = process.env.MERCHANT_WALLET_ADDRESS as `0x${string}`;
export const treasuryWalletAddress = process.env.TREASURY_SERVER_WALLET_PUBLIC as `0x${string}`;
export const svmMerchantWalletAddress = process.env.SVM_MERCHANT_WALLET_ADDRESS as string;
export const svmTreasuryWalletAddress = process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC as string;
export const nearMerchantWalletAddress = process.env.NEAR_MERCHANT_WALLET_ADDRESS as string;
export const nearTreasuryWalletAddress = process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC as string;

export function resolveNearMerchantWallet(network: NearNetworkId): string | undefined {
    if (network === NETWORK_IDS.nearTestnet) {
        const testnet = process.env.NEAR_TESTNET_MERCHANT_WALLET_ADDRESS?.trim();
        if (testnet) return testnet;
    }
    return (process.env.NEAR_MERCHANT_WALLET_ADDRESS ?? nearMerchantWalletAddress)?.trim() || undefined;
}

export function resolveNearTreasuryWallet(network: NearNetworkId): string | undefined {
    if (network === NETWORK_IDS.nearTestnet) {
        const testnet = process.env.NEAR_TESTNET_TREASURY_SERVER_WALLET_PUBLIC?.trim();
        if (testnet) return testnet;
    }
    return (process.env.NEAR_TREASURY_SERVER_WALLET_PUBLIC ?? nearTreasuryWalletAddress)?.trim() || undefined;
}

export function resolveNearFacilitatorWallet(network: NearNetworkId): string | undefined {
    if (network === NETWORK_IDS.nearTestnet) {
        const testnet = process.env.NEAR_TESTNET_FACILITATOR_ACCOUNT?.trim();
        if (testnet) return testnet;
    } else {
        const mainnet = process.env.NEAR_FACILITATOR_ACCOUNT?.trim();
        if (mainnet) return mainnet;
    }
    return resolveNearTreasuryWallet(network);
}
