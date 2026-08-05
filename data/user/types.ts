import type { NetworkId } from "../../x402/configs/chains.js";

export interface WalletPair {
  evmAddress: string;
  svmAddress: string;
}

export interface WalletScope {
  network: NetworkId;
  address: string;
}
