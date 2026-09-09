import { type SolanaCluster, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import type { DvpCreateOption } from "./dvp-create.data";

/**
 * Stablecoins deployed on this cluster, for the cash leg.
 *
 * One pass. Filtering and then mapping walks the list twice, and the mint
 * lookup that decides membership is the same lookup that builds the option.
 */
export function cashOptionsFor(cluster: SolanaCluster): DvpCreateOption[] {
  const options: DvpCreateOption[] = [];
  for (const token of Object.values(WELL_KNOWN_TOKENS)) {
    if (!token.isUsdStable) {
      continue;
    }
    const mint = (token.mints as Record<string, { address: string; decimals: number }>)[cluster];
    if (!mint) {
      continue;
    }
    options.push({
      mint: mint.address,
      label: token.symbol,
      decimals: mint.decimals,
      // USDC and USDT are legacy SPL Token. Assuming Token-2022 here would have
      // create reject every stablecoin leg.
      tokenProgram: SPL_TOKEN_PROGRAMS[token.tokenProgram],
    });
  }
  return options;
}
