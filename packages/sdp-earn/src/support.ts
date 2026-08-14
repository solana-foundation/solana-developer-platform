import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type SdpEnvironment,
  type SolanaCluster,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
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

/**
 * THE fundability rule: a strategy can only take a deposit in an environment
 * whose cluster its instrument actually lives on.
 *
 * This exists because the catalogue and the fundable set are not the same set.
 * Kamino's K-Vaults are mainnet-only but are catalogued in BOTH environments so
 * sandbox integrators can browse the real shelf — those sandbox rows name a
 * live mainnet vault and mainnet mint, and nothing may treat them as
 * depositable there. Every gate that stands between a caller and a provider
 * mutation calls this one predicate: the API's `assertKnownYieldSources`, the
 * strategies read model's derived `fundable`, and the dashboard's
 * `fundableStrategies`. Do not re-derive the comparison anywhere else — a
 * second copy is a second thing that can drift toward permissive.
 *
 * Takes the cluster alone rather than a whole row so callers can pass a wire
 * `EarnStrategy`, a DB row, or a fresh `ProviderStrategySnapshot`.
 */
export function isClusterFundableInEnvironment(
  hostCluster: SolanaCluster,
  environment: SdpEnvironment
): boolean {
  return hostCluster === CLUSTER_BY_SDP_ENVIRONMENT[environment];
}
