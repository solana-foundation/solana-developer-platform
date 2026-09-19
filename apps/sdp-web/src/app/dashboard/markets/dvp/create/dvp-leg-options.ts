import {
  type SolanaCluster,
  SPL_TOKEN_PROGRAMS,
  WELL_KNOWN_TOKENS,
  type WellKnownToken,
} from "@sdp/types";
import type { DvpCreateOption } from "./dvp-create.data";

/**
 * The curated tokens deployed on this cluster, as leg options.
 *
 * One pass. Filtering and then mapping walks the list twice, and the mint
 * lookup that decides membership is the same lookup that builds the option.
 *
 * @param cluster - The cluster whose deployments to offer.
 * @param include - Which catalogue entries belong in this leg's list.
 * @returns The options, in catalogue order.
 */
function wellKnownOptionsFor(
  cluster: SolanaCluster,
  include: (token: WellKnownToken) => boolean
): DvpCreateOption[] {
  const options: DvpCreateOption[] = [];
  // Read at the DECLARED type, not the frozen literal one. `Object.values` over
  // an `as const` table yields a union in which the tokens deployed only on
  // mainnet have no `devnet` key at all, so a cluster lookup stops type-checking
  // and the old code reached for a cast to silence it.
  const catalogue: WellKnownToken[] = Object.values(WELL_KNOWN_TOKENS);
  for (const token of catalogue) {
    if (!include(token)) {
      continue;
    }
    // Indexed, not cast: `mints` declares devnet optional, so a token deployed
    // only on mainnet is `undefined` here rather than a lie about its address.
    const mint = token.mints[cluster];
    if (!mint) {
      continue;
    }
    options.push({
      mint: mint.address,
      label: token.symbol,
      name: token.name,
      decimals: mint.decimals,
      // USDC and USDT are legacy SPL Token. Assuming Token-2022 here would have
      // create reject every stablecoin leg.
      tokenProgram: SPL_TOKEN_PROGRAMS[token.tokenProgram],
    });
  }
  return options;
}

/** Stablecoins deployed on this cluster, for the cash leg. */
export function cashOptionsFor(cluster: SolanaCluster): DvpCreateOption[] {
  return wellKnownOptionsFor(cluster, (token) => token.isUsdStable);
}

/**
 * What the asset leg can offer: the org's own issued tokens, then the curated
 * catalogue for this cluster.
 *
 * The list used to be the issued tokens alone, on the reasoning that a seller
 * trades what it minted. That holds only while both sides are the same org. The
 * moment a party is a pasted address or a registered counterparty — which is
 * the case DvP exists for — the asset being delivered is one nobody here
 * issued, and the picker went empty with no way forward but a paste nothing
 * advertised.
 *
 * Issued tokens come first because they are the org's own and the likelier
 * pick. Dedupe is by mint and keeps that first entry: an issued token that also
 * appears in the catalogue carries the org's own naming and decimals.
 *
 * Nothing here decides whether DvP will ACCEPT a mint. Each leg inspects its
 * chosen mint and names what rules it out, which is a better answer than a list
 * that carries no extension data could give.
 *
 * @param cluster - The cluster whose catalogue deployments to offer.
 * @param issuedTokens - The org's deployed tokens, from `/v1/issuance/tokens`.
 * @returns The options, issued tokens first.
 */
export function assetOptionsFor(
  cluster: SolanaCluster,
  issuedTokens: DvpCreateOption[]
): DvpCreateOption[] {
  const byMint = new Map<string, DvpCreateOption>();
  for (const option of [...issuedTokens, ...wellKnownOptionsFor(cluster, () => true)]) {
    if (!byMint.has(option.mint)) {
      byMint.set(option.mint, option);
    }
  }
  return [...byMint.values()];
}
