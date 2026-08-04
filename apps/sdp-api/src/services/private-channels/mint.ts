/**
 * Instance token resolution.
 *
 * The persisted `PrivateChannelInstance` stores no explicit cluster or mint, so
 * both are derived: the cluster from the chain RPC URL, and the token from the
 * project's allowlist (`PRIVATE_CHANNEL_TOKEN_SYMBOLS` in `@sdp/types`, which is
 * also what the dashboard's token selector renders). Shared by the balance read
 * and the deposit/withdraw/transfer flows.
 */

import type { PrivateChannelToken, SolanaCluster } from "@sdp/types";
import { privateChannelTokens, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { badRequest } from "@/lib/errors";

// Re-exported so the API and the dashboard derive the cluster identically; a
// disagreement would mean one of them resolves the wrong cluster's mint.
export { inferCluster } from "@sdp/types";

/**
 * The channel token for a request: the caller's `mint` when the instance accepts
 * it, otherwise the allowlist's first entry.
 *
 * An unlisted mint is REJECTED rather than silently replaced by the default, so a
 * client asking for a token this instance does not accept learns that before
 * anything is persisted or broadcast.
 */
export function resolveChannelToken(cluster: SolanaCluster, mint?: string): PrivateChannelToken {
  const tokens = privateChannelTokens(cluster);
  const defaultToken = tokens[0];
  if (!defaultToken) {
    // Unreachable while the allowlist carries USDC, which is deployed on both
    // clusters — a 500 is right if the allowlist is ever emptied by mistake.
    throw new Error(`No private-channel token is available on cluster ${cluster}`);
  }
  if (mint === undefined) {
    return defaultToken;
  }
  const token = tokens.find((candidate) => candidate.mint === mint);
  if (!token) {
    const allowed = tokens.map((t) => `${t.symbol} (${t.mint})`).join(", ");
    throw badRequest(`mint ${mint} is not accepted by this instance. Allowed: ${allowed}`);
  }
  return token;
}

/**
 * Decimals and owning token program for a well-known mint on this cluster, or
 * undefined when the catalogue does not know it.
 *
 * Both facts come from one lookup because a caller that needs to size an amount
 * also needs to derive a token account, and getting the program wrong derives a
 * valid-looking address that holds nothing. Cluster-aware on purpose: the same
 * address can be a different mint on the other cluster.
 */
export function knownMintToken(
  mint: string,
  cluster: SolanaCluster
): { decimals: number; tokenProgram: string } | undefined {
  for (const token of Object.values(WELL_KNOWN_TOKENS)) {
    // Not every well-known token is deployed on every cluster (some carry only
    // a mainnet mint), so index the mint map defensively.
    const clusterMint = (
      token.mints as Partial<Record<SolanaCluster, { address: string; decimals: number }>>
    )[cluster];
    if (clusterMint?.address === mint) {
      return {
        decimals: clusterMint.decimals,
        tokenProgram: SPL_TOKEN_PROGRAMS[token.tokenProgram],
      };
    }
  }
  return undefined;
}
