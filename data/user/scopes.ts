import {
  getSupportedNetworks,
  type NetworkId,
} from "../../x402/configs/chains.js";
import { resolveWalletPair } from "./store.js";
import type { WalletPair, WalletScope } from "./types.js";

type PairResolver = (address: string) => Promise<WalletPair>;

function selectedNetworks(networks?: readonly NetworkId[]): NetworkId[] {
  const supported = new Set(getSupportedNetworks().map((network) => network.id));
  const selected = networks?.length ? networks : [...supported];
  const unique = [...new Set(selected)].sort();
  if (unique.some((network) => !supported.has(network))) {
    const error = new Error("Invalid networks") as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return unique;
}

export function buildWalletScopes(
  pair: WalletPair,
  networks?: readonly NetworkId[],
): WalletScope[] {
  return selectedNetworks(networks).map((network) => ({
    network,
    address: network.startsWith("eip155:") ? pair.evmAddress.toLowerCase() : pair.svmAddress,
  }));
}

export async function resolveWalletScopes(
  lookupAddress: string,
  networks?: readonly NetworkId[],
  resolve: PairResolver = resolveWalletPair,
): Promise<WalletScope[]> {
  return buildWalletScopes(await resolve(lookupAddress), networks);
}
