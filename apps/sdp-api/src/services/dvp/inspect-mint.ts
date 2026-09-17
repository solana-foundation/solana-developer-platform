/**
 * What a form needs to know about a mint before anyone types an amount.
 *
 * The create form can offer a human amount only where the decimals are known,
 * and until this existed they were known only for a token SDP had itself
 * issued. A pasted mint fell back to base units — so the asset leg, the side
 * carrying the security, was the one field asking for `1000000000` where the
 * cash leg asked for `10`. `dvp-amount.ts` names that hazard in its own header:
 * base units are "correct for a machine and hostile to a person", and mixing
 * the two conventions in one form is how a trade goes out three orders of
 * magnitude wrong.
 *
 * The decimals were always one account read away. This is that read, plus the
 * eligibility answer the form would otherwise only discover by submitting.
 */

import type { SolanaRpc } from "@sdp/rpc/solana";
import type { Account, Address } from "@solana/kit";
import { fetchEncodedAccount } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeMint, type Mint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { BLOCKED_MINT_EXTENSIONS, UNSUPPORTED_MINT_EXTENSIONS } from "./mints";

export interface DvpMintInspection {
  mint: string;
  /** The program that actually owns the mint, never the caller's claim. */
  tokenProgram: string;
  /** Null when the mint exists but its data could not be decoded. */
  decimals: number | null;
  /** From the Token-2022 metadata extension, when the mint carries one inline. */
  name: string | null;
  symbol: string | null;
  /**
   * False when a trade on this mint would be refused: by the program, or by SDP
   * because it could not settle, cancel or reclaim it. Create refuses the same.
   */
  eligible: boolean;
  /**
   * The extension that rules it out, when it is not eligible. Named rather than
   * described, so the form can say which one without parsing prose.
   */
  blockedBy: string | null;
}

/** The reason a mint SDP cannot decode is refused, as the form renders it. */
export const UNREADABLE_MINT_REASON = "unreadable extension data";

/**
 * Reads a mint and reports what the create form needs.
 *
 * Returns null for an address that holds no mint — a wrong paste is the common
 * case here, and it should render as "we could not read that" rather than a
 * 500. A failed RPC read throws instead: it is not an answer about the mint.
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param mint - The mint address to inspect.
 * @returns The inspection, or null when no mint is at that address.
 * @throws When the account read itself fails.
 */
export async function inspectDvpMint(
  rpc: SolanaRpc,
  mint: Address
): Promise<DvpMintInspection | null> {
  // One read, and a failed one throws. An RPC error says nothing about the mint,
  // so it is neither "nothing at that address" nor "unreadable": either answer
  // would turn a transient outage into a verdict on a valid token.
  const account = await fetchEncodedAccount(rpc, mint);
  if (!account.exists) {
    return null;
  }

  // Only the two token programs own mints. Anything else at this address is not
  // a mint, and decoding it anyway would produce a confident wrong answer.
  const owner = account.programAddress;
  if (owner !== TOKEN_PROGRAM_ADDRESS && owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    return null;
  }

  let decoded: Account<Mint>;
  try {
    decoded = decodeMint(account);
  } catch {
    // Owned by a token program but undecodable: the account is there, so this
    // is not "nothing at that address". SDP cannot rule a transfer hook out of
    // a mint it cannot read, and create refuses it for that reason, so the
    // form is told the same thing rather than being told the token is missing.
    return {
      mint,
      tokenProgram: owner,
      // Unknown, not zero: without a scale the form refuses to convert an amount.
      decimals: null,
      name: null,
      symbol: null,
      eligible: false,
      blockedBy: UNREADABLE_MINT_REASON,
    };
  }

  // A legacy mint carries no extensions by construction, so there is neither
  // metadata to read nor a blocked extension to find.
  const extensions =
    owner === TOKEN_2022_PROGRAM_ADDRESS && decoded.data.extensions.__option === "Some"
      ? decoded.data.extensions.value
      : [];

  const blockedBy =
    extensions
      .map((extension) => extension.__kind)
      .find((kind) => BLOCKED_MINT_EXTENSIONS.has(kind) || UNSUPPORTED_MINT_EXTENSIONS.has(kind)) ??
    null;

  const metadata = extensions.find((extension) => extension.__kind === "TokenMetadata");
  const name =
    metadata && metadata.__kind === "TokenMetadata" ? metadata.name.trim() || null : null;
  const symbol =
    metadata && metadata.__kind === "TokenMetadata" ? metadata.symbol.trim() || null : null;

  return {
    mint,
    tokenProgram: owner,
    decimals: decoded.data.decimals,
    name,
    symbol,
    eligible: blockedBy === null,
    blockedBy,
  };
}
