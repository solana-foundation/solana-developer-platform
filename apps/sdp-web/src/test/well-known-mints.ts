import {
  type SolanaCluster,
  type WellKnownTokenSymbol,
  wellKnownMint,
} from "@sdp/types/well-known-tokens";

/** A token's mint on `cluster`, failing the test's setup when the token list lacks it. */
export function requiredWellKnownMint(
  symbol: WellKnownTokenSymbol,
  cluster: SolanaCluster
): string {
  const mint = wellKnownMint(symbol, cluster);
  if (mint === undefined) {
    throw new Error(`No ${cluster} ${symbol} mint in the well-known token list`);
  }
  return mint;
}
