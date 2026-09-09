/**
 * Instance token resolution.
 *
 * Private Channels starts with SDP's cluster-aware token registry, then checks
 * the connected escrow instance's on-chain `allowedMint` PDA. Write paths use
 * the intersection; balance reads remain general and only use the registry for
 * their default mint and metadata.
 */

import { findAllowedMintPda } from "@sdp/spc-escrow";
import type {
  PrivateChannelInstance,
  PrivateChannelToken,
  PrivateChannelTokenEligibility,
  SolanaCluster,
} from "@sdp/types";
import { privateChannelTokens, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { address } from "@solana/kit";
import { badRequest, serviceUnavailable } from "@/lib/errors";
import type { PrivateChannelProjectRpcClient } from "./project-rpc";

type TokenEligibilityInstance = Pick<
  PrivateChannelInstance,
  "escrowProgramId" | "escrowInstanceAddr"
>;

/** Read every registered mint's enablement from the connected escrow instance. */
export async function readPrivateChannelTokenEligibility(
  instance: TokenEligibilityInstance,
  projectRpc: PrivateChannelProjectRpcClient
): Promise<PrivateChannelTokenEligibility[]> {
  const programAddress = address(instance.escrowProgramId);
  const instanceAddress = address(instance.escrowInstanceAddr);

  return Promise.all(
    privateChannelTokens(projectRpc.cluster).map(async (token) => {
      try {
        const [allowedMint] = await findAllowedMintPda(
          { instance: instanceAddress, mint: address(token.mint) },
          { programAddress }
        );
        const account = (
          await projectRpc.rpc
            .getAccountInfo(allowedMint, {
              encoding: "base64",
              dataSlice: { offset: 0, length: 0 },
            })
            .send()
        ).value;
        const enabled = account?.owner === instance.escrowProgramId;
        return {
          ...token,
          enabled,
          exclusionReasons: enabled
            ? []
            : [
                {
                  code: "NOT_ALLOWED_BY_INSTANCE" as const,
                  message: `${token.symbol} is not enabled by this Private Channels instance.`,
                },
              ],
        };
      } catch {
        return {
          ...token,
          enabled: false,
          exclusionReasons: [
            {
              code: "ALLOWLIST_UNAVAILABLE" as const,
              message: `We could not check whether ${token.symbol} is enabled.`,
            },
          ],
        };
      }
    })
  );
}

/**
 * Resolve a request mint from SDP's cluster-aware token registry.
 *
 * An unlisted mint is REJECTED rather than silently replaced by the default, so a
 * client asking for a token this instance does not accept learns that before
 * anything is persisted or broadcast.
 */
export function resolveRegisteredChannelToken(
  cluster: SolanaCluster,
  mint?: string
): PrivateChannelToken {
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

/** Resolve one token and require its on-chain allowlist PDA before any write. */
export async function resolveChannelToken(
  instance: TokenEligibilityInstance,
  projectRpc: PrivateChannelProjectRpcClient,
  mint?: string
): Promise<PrivateChannelToken> {
  const tokens = await readPrivateChannelTokenEligibility(instance, projectRpc);
  if (mint === undefined) {
    const defaultToken = tokens.find((candidate) => candidate.enabled);
    if (defaultToken) return defaultToken;
    if (
      tokens.some((candidate) =>
        candidate.exclusionReasons.some((reason) => reason.code === "ALLOWLIST_UNAVAILABLE")
      )
    ) {
      throw serviceUnavailable(
        "We could not read token access from the Private Channels instance."
      );
    }
    throw badRequest("This Private Channels instance does not enable an SDP-supported token.");
  }

  const token = tokens.find((candidate) => candidate.mint === mint);
  if (!token) {
    const registered = privateChannelTokens(projectRpc.cluster);
    const allowed = registered
      .map((candidate) => `${candidate.symbol} (${candidate.mint})`)
      .join(", ");
    throw badRequest(`mint ${mint} is not registered for Private Channels. Registered: ${allowed}`);
  }
  if (token.enabled) return token;

  if (token.exclusionReasons.some((reason) => reason.code === "ALLOWLIST_UNAVAILABLE")) {
    throw serviceUnavailable("We could not read token access from the Private Channels instance.");
  }
  throw badRequest(token.exclusionReasons[0]?.message);
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
