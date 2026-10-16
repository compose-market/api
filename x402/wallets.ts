import { getDefaultNetwork, getNetwork, NETWORK_IDS, type NearNetworkId, type NetworkId } from "./configs/chains.js";
import { decodePaymentSignatureHeader, getNetworkFromPaymentPayload } from "./facilitator.js";

export const serverWalletAddress = process.env.THIRDWEB_SERVER_WALLET_ADDRESS as `0x${string}`;
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

export const paymentNetwork = getDefaultNetwork();
export const paymentAsset = getNetwork(paymentNetwork).asset;

export function getNetworkFromPaymentData(paymentData: string | null): NetworkId {
    if (!paymentData) return paymentNetwork;
    return getNetworkFromPaymentPayload(decodePaymentSignatureHeader(paymentData));
}
