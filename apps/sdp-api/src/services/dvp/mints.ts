/**
 * The mint checks that need chain state, done before a trade is signed.
 *
 * `validateDvpTerms` deliberately covers only the rules judgeable from the
 * payload, and its own header says the account-reading ones are "handled where
 * the trade is built". This is that place. Until now it was nowhere: a trade on
 * a mint the program refuses got signed, recorded and broadcast, and came back
 * as a raw `custom program error: 0xa` — after we had already spent a signature
 * and written a row.
 *
 * Two checks, both reading the mint account:
 *
 * 1. The mint is owned by the token program the caller named. Nothing else
 *    verifies this, and it is not cosmetic: the escrow ATA derives from
 *    (swapDvp, mint, tokenProgram), so a wrong program yields an address the
 *    program will not accept — and that address is the one we would publish for
 *    a counterparty to pay into.
 *
 * 2. The mint's Token Terms pass the `dvp` row of the capability table
 *    (`support` in `@sdp/solana/token-movement`, ADR 0012): the four
 *    extensions the program's `validate_mint_extensions` rejects with
 *    `BlockedMintExtension` (`program/src/processor/shared/token_utils.rs`, at
 *    CreateDvp and at SettleDvp alike), and what SDP cannot move yet even where
 *    the program accepts it. A trade SDP can create but never settle, cancel or
 *    reclaim is a trap for whoever funds it.
 */

import type { SolanaRpc } from "@sdp/rpc/solana";
import type { TokenAsset } from "@sdp/solana/asset-ref";
import {
  capabilityRefusals,
  type TokenMovementRefusal,
  type TokenMovementRefusalNotice,
} from "@sdp/solana/token-movement";
import { decodeTokenTerms, type MintTokenTerms, TokenTermsError } from "@sdp/solana/token-terms";
import { SPL_TOKEN_PROGRAMS, type TokenProgramKind } from "@sdp/types/well-known-tokens";
import {
  type Address,
  assertAccountExists,
  type EncodedAccount,
  fetchEncodedAccounts,
  type MaybeEncodedAccount,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { z } from "zod";

export interface DvpMintLeg {
  /** "mintA" or "mintB" — used only to name the offending field in the error. */
  label: string;
  mint: Address;
  tokenProgram: Address;
}

/** The token program kind a DvP leg names, or null for any other program. */
function tokenProgramKind(tokenProgram: Address): TokenProgramKind | null {
  if (tokenProgram === SPL_TOKEN_PROGRAMS["spl-token"]) return "spl-token";
  if (tokenProgram === SPL_TOKEN_PROGRAMS["token-2022"]) return "token-2022";
  return null;
}

/**
 * A leg mint's terms from its account and the Clock read with it, or null when
 * the bytes do not decode as a mint SDP can move. SDP cannot rule a transfer
 * hook out of a mint it cannot read, so callers refuse it.
 */
function decodeDvpMint(
  mint: EncodedAccount,
  clock: EncodedAccount,
  asset: TokenAsset
): MintTokenTerms | null {
  try {
    return decodeTokenTerms(asset, { mint, clock });
  } catch (error) {
    if (error instanceof TokenTermsError) {
      return null;
    }
    throw error;
  }
}

/** Whether the program itself refuses the state, rather than SDP. */
function refusedByProgram(refusal: TokenMovementRefusal): boolean {
  switch (refusal) {
    case "transfer_fee":
    case "display_rule":
    case "non_transferable":
      return true;
    case "transfer_hook":
    case "paused":
    case "default_frozen":
    case "hook_unresolved":
    case "memo_required":
    case "nothing_credited":
    case "destination_frozen":
    case "fee_above_tolerance":
      return false;
    default: {
      const exhaustive: never = refusal;
      throw new Error(`Unknown token movement refusal: ${String(exhaustive)}`);
    }
  }
}

/** The problem a create reports for one refusal of a leg's mint. */
export function dvpMintProblem(
  leg: Pick<DvpMintLeg, "label" | "mint">,
  refusal: TokenMovementRefusalNotice
): string {
  if (refusal.refusal === "paused") {
    return `${leg.label} ${leg.mint} is paused, so no leg of it can be funded, settled or refunded`;
  }
  return refusedByProgram(refusal.refusal)
    ? `${leg.label} ${leg.mint} carries the ${refusal.extension} extension, which DvP settlement refuses`
    : `${leg.label} ${leg.mint} carries the ${refusal.extension} extension, which SDP cannot settle, cancel or reclaim yet`;
}

/**
 * Reads both legs' mints and returns every problem, empty when they are sound.
 *
 * Reports all problems rather than the first, so a caller fixes one payload
 * instead of discovering the next failure on the next request — same contract
 * as `validateDvpTerms`.
 *
 * RPC budget: one `getMultipleAccounts` for both mints and the Clock (was one
 * `getAccountInfo` per mint).
 *
 * @param rpc - Solana RPC to read the mints from.
 * @param legs - The mint and declared token program of each leg.
 * @returns Human-readable problems, empty when the mints are acceptable.
 */
export async function validateDvpMints(
  rpc: SolanaRpc,
  legs: readonly DvpMintLeg[]
): Promise<string[]> {
  const problems: string[] = [];

  // Encoded reads, decoded only after the owner check: bytes that are not a
  // mint would otherwise throw before it ran, turning "you pasted a non-mint
  // address" from a named 400 into a 500.
  const [clock, ...accounts] = await fetchEncodedAccounts(rpc, [
    SYSVAR_CLOCK_ADDRESS,
    ...legs.map((leg) => leg.mint),
  ]);
  // The Clock sysvar always exists; a node answering otherwise fails like any read.
  assertAccountExists(clock);

  for (const [index, leg] of legs.entries()) {
    const program = tokenProgramKind(leg.tokenProgram);
    if (program === null) {
      problems.push(`${leg.label} token program ${leg.tokenProgram} is not an SPL token program`);
      continue;
    }

    const account = accounts[index];
    if (!account.exists) {
      problems.push(`${leg.label} ${leg.mint} does not exist on this cluster`);
      continue;
    }

    // The owner IS the token program. Trusting the caller's declared program
    // over the account's actual owner is what would publish an escrow address
    // derived under the wrong program.
    if (account.programAddress !== leg.tokenProgram) {
      problems.push(
        `${leg.label} ${leg.mint} is owned by ${account.programAddress}, not the declared token program ${leg.tokenProgram}`
      );
      continue;
    }

    const terms = decodeDvpMint(account, clock, { kind: "token", mint: leg.mint, program });
    if (terms === null) {
      // The program would still refuse its own four, but it accepts a transfer
      // hook, so a mint SDP cannot read is one it cannot rule a hook out of.
      problems.push(
        `${leg.label} ${leg.mint} has extension data SDP cannot read, so it cannot confirm the mint is settleable`
      );
      continue;
    }
    for (const refusal of capabilityRefusals(terms, "dvp")) {
      problems.push(dvpMintProblem(leg, refusal));
    }
  }

  return problems;
}

/** A leg mint read live: its terms, or why they cannot be had. */
const dvpLegMintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), terms: z.custom<MintTokenTerms>() }),
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("unreadable") }),
]);

export type DvpLegMint = z.infer<typeof dvpLegMintSchema>;

/**
 * A leg's mint from its account and the Clock read with it: unreadable when
 * the account is not the declared token program's, or does not decode as a
 * mint SDP can move.
 */
export function decodeDvpLegMint(
  account: MaybeEncodedAccount,
  clock: MaybeEncodedAccount,
  leg: Pick<DvpMintLeg, "mint" | "tokenProgram">
): DvpLegMint {
  // The Clock sysvar always exists; a node answering otherwise fails like any read.
  assertAccountExists(clock);
  if (!account.exists) {
    return { kind: "missing" };
  }
  const program = tokenProgramKind(leg.tokenProgram);
  if (program === null || account.programAddress !== leg.tokenProgram) {
    return { kind: "unreadable" };
  }
  const terms = decodeDvpMint(account, clock, { kind: "token", mint: leg.mint, program });
  return terms === null ? { kind: "unreadable" } : { kind: "read", terms };
}

/**
 * A leg's mint terms, read live with the Clock in one `getMultipleAccounts`.
 */
export async function readDvpLegMint(
  rpc: SolanaRpc,
  leg: Pick<DvpMintLeg, "mint" | "tokenProgram">
): Promise<DvpLegMint> {
  const [account, clock] = await fetchEncodedAccounts(rpc, [leg.mint, SYSVAR_CLOCK_ADDRESS]);
  return decodeDvpLegMint(account, clock, leg);
}

/**
 * A leg's mint terms and the funding wallet's token account of it, read in
 * one `getMultipleAccounts` (was a mint read, then the account read).
 *
 * @returns The mint, and the source account as read (missing or not).
 */
export async function readDvpFundingAccounts(
  rpc: SolanaRpc,
  leg: Pick<DvpMintLeg, "mint" | "tokenProgram">,
  source: Address
): Promise<{ mint: DvpLegMint; source: MaybeEncodedAccount }> {
  const [account, clock, sourceAccount] = await fetchEncodedAccounts(rpc, [
    leg.mint,
    SYSVAR_CLOCK_ADDRESS,
    source,
  ]);
  return { mint: decodeDvpLegMint(account, clock, leg), source: sourceAccount };
}
