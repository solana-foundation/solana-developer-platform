import {
  type Address,
  address,
  getBase64Decoder,
  none,
  type ReadonlyUint8Array,
  some,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  getMintEncoder as getLegacyMintEncoder,
  type TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  type ExtensionArgs,
  extension,
  getMintEncoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { z } from "zod";
import type { ClusterRpcResponder, JsonRpcResult } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";

const SYSVAR_OWNER_ADDRESS = address("Sysvar1111111111111111111111111111111111111");

const SCALED_UI_AMOUNT_AUTHORITY = syntheticAddress(9_001);

/** A Token-2022 mint as a stubbed `getAccountInfo` serves it; `extensions` is null for none. */
export interface StubMint {
  decimals: number;
  extensions: ExtensionArgs[] | null;
}

/** A legacy SPL Token mint as a stubbed `getAccountInfo` serves it: 82 bytes, no extensions. */
export interface LegacyStubMint {
  tokenProgram: typeof TOKEN_PROGRAM_ADDRESS;
  decimals: number;
}

/**
 * A base64 `getAccountInfo` result for an account holding `data`.
 *
 * @param params.owner - The program that owns the account.
 * @param params.data - The account data.
 * @returns The JSON-RPC `result`.
 */
function base64AccountInfoResult(params: {
  owner: Address;
  data: ReadonlyUint8Array;
}): JsonRpcResult {
  return {
    context: { slot: 1 },
    value: {
      data: [getBase64Decoder().decode(params.data), "base64"],
      executable: false,
      lamports: 1_461_600,
      owner: params.owner,
      rentEpoch: 0,
      space: params.data.length,
    },
  };
}

/**
 * A `ScaledUiAmountConfig` extension: UI amounts are base units times `multiplier`, or times
 * `newMultiplier` once the cluster clock reaches `newMultiplierEffectiveTimestamp`.
 *
 * @param scale.multiplier - The multiplier in force before the effective timestamp.
 * @param scale.newMultiplier - The multiplier in force from the effective timestamp on.
 * @param scale.newMultiplierEffectiveTimestamp - The Unix timestamp `newMultiplier` takes over at.
 * @returns The extension, for {@link StubMint.extensions}.
 */
export function scaledUiAmountConfig(scale: {
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveTimestamp: bigint;
}): ExtensionArgs {
  return extension("ScaledUiAmountConfig", {
    authority: SCALED_UI_AMOUNT_AUTHORITY,
    multiplier: scale.multiplier,
    newMultiplier: scale.newMultiplier,
    newMultiplierEffectiveTimestamp: scale.newMultiplierEffectiveTimestamp,
  });
}

/**
 * A base64 `getAccountInfo` result for a Token-2022 or legacy SPL Token mint, encoded by its
 * owning program's own mint encoder.
 *
 * @param mint - The mint's decimals, and its extensions or legacy owner.
 * @returns The JSON-RPC `result` to pass to `answer("getAccountInfo", …)`.
 */
export function mintAccountInfoResult(mint: StubMint | LegacyStubMint): JsonRpcResult {
  if ("tokenProgram" in mint) {
    return base64AccountInfoResult({
      owner: mint.tokenProgram,
      data: getLegacyMintEncoder().encode({
        mintAuthority: none(),
        supply: 0n,
        decimals: mint.decimals,
        isInitialized: true,
        freezeAuthority: none(),
      }),
    });
  }
  return base64AccountInfoResult({
    owner: TOKEN_2022_PROGRAM_ADDRESS,
    data: getMintEncoder().encode({
      mintAuthority: none(),
      supply: 0n,
      decimals: mint.decimals,
      isInitialized: true,
      freezeAuthority: none(),
      extensions: mint.extensions === null ? none() : some(mint.extensions),
    }),
  });
}

/**
 * A base64 `getAccountInfo` result for the Clock sysvar at `clockUnixTimestamp`.
 *
 * @param clockUnixTimestamp - The cluster's Unix timestamp.
 * @returns The JSON-RPC `result`.
 */
function clockAccountInfoResult(clockUnixTimestamp: bigint): JsonRpcResult {
  return base64AccountInfoResult({
    owner: SYSVAR_OWNER_ADDRESS,
    data: getSysvarClockEncoder().encode({
      slot: 1n,
      epochStartTimestamp: unixTimestamp(clockUnixTimestamp),
      epoch: 0n,
      leaderScheduleEpoch: 1n,
      unixTimestamp: unixTimestamp(clockUnixTimestamp),
    }),
  });
}

/**
 * Answer every `getAccountInfo` of the current test by the address it asks for: each of `mints`
 * as its Token-2022 or legacy SPL Token mint, the Clock sysvar at `clockUnixTimestamp`, and any
 * other address as no account.
 *
 * @param rpc - The suite's cluster RPC responder.
 * @param params.mints - The mints the cluster holds, by address.
 * @param params.clockUnixTimestamp - The Unix timestamp the Clock sysvar reads.
 */
export function respondMintAccounts(
  rpc: ClusterRpcResponder,
  params: { mints: ReadonlyMap<string, StubMint | LegacyStubMint>; clockUnixTimestamp: bigint }
): void {
  rpc.respond("getAccountInfo", (request) => {
    const accountAddress = z.string().parse(request.params[0]);
    if (accountAddress === SYSVAR_CLOCK_ADDRESS) {
      return { result: clockAccountInfoResult(params.clockUnixTimestamp) };
    }
    const mint = params.mints.get(accountAddress);
    return {
      result:
        mint === undefined ? { context: { slot: 1 }, value: null } : mintAccountInfoResult(mint),
    };
  });
}
