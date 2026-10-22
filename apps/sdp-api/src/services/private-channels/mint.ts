/**
 * Instance token resolution.
 *
 * Private Channels starts with SDP's cluster-aware token registry, then checks
 * the connected escrow instance's on-chain `allowedMint` PDA. Write paths use
 * the intersection; balance reads remain general and only use the registry for
 * their default mint and metadata.
 */

import { AmountError } from "@sdp/solana/amount";
import {
  type BaseUnits,
  parseTokenAmount,
  type TokenAmount,
  toBaseUnits,
} from "@sdp/solana/token-amount";
import { support } from "@sdp/solana/token-movement";
import { decodeTokenTerms, type MintTokenTerms, TokenTermsError } from "@sdp/solana/token-terms";
import { findAllowedMintPda } from "@sdp/spc-escrow";
import type {
  PrivateChannelInstance,
  PrivateChannelToken,
  PrivateChannelTokenEligibility,
} from "@sdp/types/private-channels";
import { privateChannelTokens } from "@sdp/types/private-channels";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import {
  SPL_TOKEN_PROGRAMS,
  type TokenProgramKind,
  WELL_KNOWN_TOKENS,
} from "@sdp/types/well-known-tokens";
import {
  address,
  assertAccountExists,
  fetchEncodedAccounts,
  type MaybeEncodedAccount,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
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

/** A registered token a write moves, with its mint's Token Terms read live. */
export interface ChannelTokenForWrite {
  token: PrivateChannelToken;
  terms: MintTokenTerms;
}

type WriteTokenRead =
  | Readonly<{ kind: "enabled"; token: PrivateChannelToken; terms: MintTokenTerms }>
  | Readonly<{ kind: "disabled"; token: PrivateChannelToken }>
  | Readonly<{ kind: "unavailable"; token: PrivateChannelToken }>;

function tokenProgramKind(token: PrivateChannelToken): TokenProgramKind {
  if (token.tokenProgram === SPL_TOKEN_PROGRAMS["spl-token"]) return "spl-token";
  if (token.tokenProgram === SPL_TOKEN_PROGRAMS["token-2022"]) return "token-2022";
  throw new Error(`Private Channels token ${token.symbol} names an unknown token program`);
}

/**
 * One registered token's allowlist entry, mint and the Clock, in one
 * `getMultipleAccounts`: the entry says whether the instance enables it, and
 * the mint's terms are what the write converts and gates with.
 */
async function readWriteToken(
  instance: TokenEligibilityInstance,
  projectRpc: PrivateChannelProjectRpcClient,
  token: PrivateChannelToken
): Promise<WriteTokenRead> {
  const mint = address(token.mint);
  const [allowedMint] = await findAllowedMintPda(
    { instance: address(instance.escrowInstanceAddr), mint },
    { programAddress: address(instance.escrowProgramId) }
  );
  let accounts: MaybeEncodedAccount[];
  try {
    accounts = await fetchEncodedAccounts(projectRpc.rpc, [
      allowedMint,
      mint,
      SYSVAR_CLOCK_ADDRESS,
    ]);
  } catch {
    // An outage is no verdict on the token: the caller answers 503.
    return { kind: "unavailable", token };
  }
  const [allowed, mintAccount, clock] = accounts;
  if (!allowed.exists || allowed.programAddress !== instance.escrowProgramId) {
    return { kind: "disabled", token };
  }
  if (!mintAccount.exists) {
    throw badRequest(`${token.symbol} mint ${token.mint} does not exist on ${projectRpc.cluster}`);
  }
  // The Clock sysvar always exists; a node answering otherwise fails like any read.
  assertAccountExists(clock);
  try {
    const terms = decodeTokenTerms(
      { kind: "token", mint, program: tokenProgramKind(token) },
      { mint: mintAccount, clock }
    );
    return { kind: "enabled", token, terms };
  } catch (error) {
    if (error instanceof TokenTermsError) {
      throw badRequest(error.message, { reason: error.reason });
    }
    throw error;
  }
}

/**
 * Resolve one token for a write: require its on-chain allowlist PDA, read its
 * mint's Token Terms live, and refuse what the `private_channels` row of the
 * capability table cannot move (ADR 0012): SPC's escrow and its unchecked
 * `Transfer` cannot state a transfer fee or pass a hook's accounts, and
 * cannot thaw the accounts a frozen-by-default mint opens.
 *
 * RPC budget: one `getMultipleAccounts` (allowlist entry, mint, Clock) per
 * registered token for the default token, one in all for a named mint (was one
 * `getAccountInfo` per registered token either way).
 *
 * @throws AppError (400) for an unregistered, disabled or refused mint, (503)
 * when the instance's allowlist cannot be read.
 */
export async function resolveChannelToken(
  instance: TokenEligibilityInstance,
  projectRpc: PrivateChannelProjectRpcClient,
  mint?: string
): Promise<ChannelTokenForWrite> {
  const registered = privateChannelTokens(projectRpc.cluster);
  const named = mint === undefined ? registered : registered.filter((token) => token.mint === mint);
  if (named.length === 0) {
    const allowed = registered
      .map((candidate) => `${candidate.symbol} (${candidate.mint})`)
      .join(", ");
    throw badRequest(`mint ${mint} is not registered for Private Channels. Registered: ${allowed}`);
  }
  const reads = await Promise.all(
    named.map((token) => readWriteToken(instance, projectRpc, token))
  );
  const enabled = reads.find(
    (read): read is Extract<WriteTokenRead, { kind: "enabled" }> => read.kind === "enabled"
  );
  if (enabled === undefined) {
    if (reads.some((read) => read.kind === "unavailable")) {
      throw serviceUnavailable(
        "We could not read token access from the Private Channels instance."
      );
    }
    throw badRequest(
      mint === undefined
        ? "This Private Channels instance does not enable an SDP-supported token."
        : `${named[0]?.symbol} is not enabled by this Private Channels instance.`
    );
  }
  const decision = support(enabled.terms, "private_channels");
  if (!decision.supported) {
    throw badRequest(decision.message, { reason: decision.refusal });
  }
  return { token: enabled.token, terms: enabled.terms };
}

/**
 * The base units of a write's amount, at the mint's live decimals.
 *
 * @throws AppError (400) when the amount is not a positive decimal the mint can hold.
 */
export function channelAmountBaseUnits(amount: string, terms: MintTokenTerms): BaseUnits {
  let parsed: TokenAmount;
  try {
    parsed = parseTokenAmount(amount, terms.decimals);
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
  const units = toBaseUnits(parsed);
  if (units === 0n) {
    throw badRequest("amount must be greater than zero");
  }
  return units;
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
