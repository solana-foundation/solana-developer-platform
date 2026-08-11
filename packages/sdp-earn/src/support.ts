import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import type { EarnDeclaredStrategySupport, ProviderStrategySnapshot } from "./types";

/**
 * Catalogue-sync validation: does a live strategy snapshot fall inside the
 * provider's declared support envelope? `declaredSupport` speaks token symbols
 * while snapshots speak mint addresses, so mints resolve through the pinned
 * well-known-token catalogue. Fails closed: a mint the catalogue does not know
 * — or an empty mint list — is out of support, so the sync skips/flags the
 * strategy instead of persisting a token nobody vetted.
 */
export function isStrategyWithinDeclaredSupport(
  support: EarnDeclaredStrategySupport,
  snapshot: Pick<ProviderStrategySnapshot, "sourceKind" | "depositMints">
): boolean {
  if (!support.sourceKinds.includes(snapshot.sourceKind)) {
    return false;
  }
  const declaredSymbols = new Set<string>(support.depositTokens);
  return (
    snapshot.depositMints.length > 0 &&
    snapshot.depositMints.every((mint) => {
      const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
      return token !== undefined && declaredSymbols.has(token.symbol);
    })
  );
}
