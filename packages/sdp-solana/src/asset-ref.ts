/**
 * One asset identity for every token movement (ADR 0012).
 *
 * A request names a token as a symbol or a mint address. It is resolved once,
 * here, to an asset. Only the symbol "SOL" means native SOL. The wrapped SOL
 * mint is an SPL token like any other: treating it as native SOL is the bug
 * the security scan found twice (SOLA9-758, SOLA9-838).
 *
 * Client-safe: no RPC and no Node-only import.
 */

import {
  isWellKnownTokenSymbol,
  type SolanaCluster,
  type TokenProgramKind,
  WELL_KNOWN_TOKEN_BY_MINT,
  WELL_KNOWN_TOKENS,
  wellKnownMint,
} from "@sdp/types/well-known-tokens";
import { type Address, address, isAddress } from "@solana/kit";

/** Native SOL, moved by a system transfer in lamports. */
export type NativeAsset = Readonly<{ kind: "native" }>;

/** An SPL token: a mint and the token program that owns it. */
export type TokenAsset = Readonly<{ kind: "token"; mint: Address; program: TokenProgramKind }>;

/** The asset a movement moves. It is stored on every movement leg. */
export type AssetRef = NativeAsset | TokenAsset;

/**
 * A mint the catalogue does not know. Its token program is not known until
 * the mint account is read; reading the terms turns it into a `TokenAsset`.
 */
export type UnreadMint = Readonly<{ kind: "mint"; mint: Address }>;

/** What a request names, before the mint is read. */
export type AssetRequest = AssetRef | UnreadMint;

export const NATIVE_ASSET: NativeAsset = { kind: "native" };

export const ASSET_RESOLUTION_REFUSALS = {
  invalidToken: "invalid_token",
  notOnCluster: "not_on_cluster",
} as const satisfies Record<string, string>;

export type AssetResolutionRefusal =
  (typeof ASSET_RESOLUTION_REFUSALS)[keyof typeof ASSET_RESOLUTION_REFUSALS];

/** A token string that names no asset on the cluster. */
export class AssetResolutionError extends Error {
  readonly reason: AssetResolutionRefusal;

  constructor(reason: AssetResolutionRefusal, message: string) {
    super(message);
    this.name = "AssetResolutionError";
    this.reason = reason;
  }
}

/**
 * Resolves a request's token string on one cluster.
 *
 * - "SOL", in any casing, is native SOL.
 * - Another catalogue symbol, in any casing, is that cluster's mint with the
 *   catalogue's token program.
 * - A catalogue mint address is that token, if it is deployed on the cluster.
 *   The wrapped SOL mint resolves here, to an SPL token, never to native SOL.
 * - Any other address is an unread mint.
 *
 * @param token - A symbol or a mint address; surrounding whitespace is ignored.
 * @param cluster - The cluster the movement runs on.
 * @returns The asset the request names.
 * @throws {AssetResolutionError} When the string is neither a catalogue
 * symbol nor an address, or names a catalogue token not deployed on `cluster`.
 */
export function resolveAssetRequest(token: string, cluster: SolanaCluster): AssetRequest {
  const trimmed = token.trim();
  const symbol = trimmed.toUpperCase();
  if (symbol === "SOL") {
    return NATIVE_ASSET;
  }

  if (isWellKnownTokenSymbol(symbol)) {
    const entry = WELL_KNOWN_TOKENS[symbol];
    const mint = wellKnownMint(symbol, cluster);
    if (mint === undefined) {
      throw new AssetResolutionError(
        ASSET_RESOLUTION_REFUSALS.notOnCluster,
        `${entry.symbol} is not available on ${cluster}`
      );
    }
    return { kind: "token", mint: address(mint), program: entry.tokenProgram };
  }

  if (!isAddress(trimmed)) {
    throw new AssetResolutionError(
      ASSET_RESOLUTION_REFUSALS.invalidToken,
      "Token must be a known symbol or a mint address"
    );
  }

  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(trimmed);
  if (wellKnown === undefined) {
    return { kind: "mint", mint: trimmed };
  }
  if (!wellKnown.clusters.includes(cluster)) {
    throw new AssetResolutionError(
      ASSET_RESOLUTION_REFUSALS.notOnCluster,
      `${wellKnown.symbol} mint ${trimmed} is not available on ${cluster}`
    );
  }
  return { kind: "token", mint: trimmed, program: wellKnown.tokenProgram };
}

/**
 * Whether two assets are the same asset: both native SOL, or the same mint
 * under the same token program.
 */
export function isSameAsset(left: AssetRef, right: AssetRef): boolean {
  switch (left.kind) {
    case "native":
      return right.kind === "native";
    case "token":
      return right.kind === "token" && right.mint === left.mint && right.program === left.program;
    default: {
      const exhaustive: never = left;
      throw new Error(`Unknown asset kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
