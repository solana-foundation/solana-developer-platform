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
import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeMint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { BLOCKED_MINT_EXTENSIONS } from "./mints";

export interface DvpMintInspection {
  mint: string;
  /** The program that actually owns the mint, never the caller's claim. */
  tokenProgram: string;
  decimals: number;
  /** From the Token-2022 metadata extension, when the mint carries one inline. */
  name: string | null;
  symbol: string | null;
  /** False when DvP settlement would refuse this mint outright. */
  eligible: boolean;
  /**
   * The extension that rules it out, when it is not eligible. Named rather than
   * described, so the form can say which one without parsing prose.
   */
  blockedBy: string | null;
}

/**
 * Reads a mint and reports what the create form needs.
 *
 * Returns null rather than throwing for anything that is not a readable mint —
 * a wrong paste is the common case here, and it should render as "we could not
 * read that" rather than a 500.
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param mint - The mint address to inspect.
 * @returns The inspection, or null when nothing readable is at that address.
 */
export async function inspectDvpMint(
  rpc: SolanaRpc,
  mint: Address
): Promise<DvpMintInspection | null> {
  let account: Awaited<ReturnType<typeof fetchMaybeMint>>;
  try {
    account = await fetchMaybeMint(rpc, mint);
  } catch {
    return null;
  }

  if (!account.exists) {
    return null;
  }

  // Only the two token programs own mints. Anything else at this address is not
  // a mint, and decoding it anyway would produce a confident wrong answer.
  const owner = account.programAddress;
  if (owner !== TOKEN_PROGRAM_ADDRESS && owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    return null;
  }

  // A legacy mint carries no extensions by construction, so there is neither
  // metadata to read nor a blocked extension to find.
  const extensions =
    owner === TOKEN_2022_PROGRAM_ADDRESS && account.data.extensions.__option === "Some"
      ? account.data.extensions.value
      : [];

  const blockedBy =
    extensions
      .map((extension) => extension.__kind)
      .find((kind) => BLOCKED_MINT_EXTENSIONS.has(kind)) ?? null;

  const metadata = extensions.find((extension) => extension.__kind === "TokenMetadata");
  const name =
    metadata && metadata.__kind === "TokenMetadata" ? metadata.name.trim() || null : null;
  const symbol =
    metadata && metadata.__kind === "TokenMetadata" ? metadata.symbol.trim() || null : null;

  return {
    mint,
    tokenProgram: owner,
    decimals: account.data.decimals,
    name,
    symbol,
    eligible: blockedBy === null,
    blockedBy,
  };
}
