/**
 * Checking that a settlement destination can actually receive a leg.
 *
 * A destination is not where tokens land. It is the OWNER whose associated
 * token account they land in: `settle-preflight.ts` derives an ATA from this
 * address and `SettleDvp` pays into that, creating it first when it does not
 * exist. So the address given here is fed straight into an ATA derivation, and
 * an address that cannot own a token account breaks settlement rather than
 * merely being odd.
 *
 * The rule is simply that a token program must not own it.
 *
 * SPL Token and Token-2022 own exactly three kinds of account — mints, token
 * accounts and multisigs — and not one of them is a thing that can hold an ATA.
 * A MINT is never a valid transfer recipient. A TOKEN ACCOUNT as owner derives
 * the nested-ATA shape that the associated-token program ships a dedicated
 * `RecoverNested` instruction to dig people out of. Deriving "for" either
 * produces a real, canonical-looking address, which is what makes this worth
 * refusing up front: nothing downstream looks wrong until settle reverts, and
 * settle moves both legs at once, so a bad destination does not fail one side —
 * it strands a trade both parties have already funded.
 *
 * Deliberately NOT distinguishing which of the three it is. An earlier version
 * tried, using account size, and it was wrong in a way that mattered: a
 * Token-2022 mint carrying extensions measures 368 bytes rather than a legacy
 * mint's 82, so it sailed past the mint check, and a mint with one small
 * extension would land between 82 and 165 and be waved through entirely. The
 * decoders are no better a discriminator — both of them reject a Token-2022
 * mint's raw bytes. Ownership is the fact that actually settles it, and one
 * message naming both cases is worth more than a precise label derived wrongly.
 *
 * An address with NO account is deliberately fine. ATA derivation is pure — it
 * seeds on the owner's bytes and never reads the owner's account — so an
 * unfunded wallet is an ordinary destination, and refusing it would rule out
 * paying anyone who has not transacted yet.
 */

import { getAccountInfo, type SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

/** Why a destination was refused, or null when it is usable. */
export type DvpDestinationProblem = "token-program-owned";

/**
 * Whether an address can own the token account a settlement leg pays into.
 *
 * Returns the reason it cannot, or null when it can. Never throws for an
 * address that is merely unreadable: this is one check inside create, and an
 * RPC that will not answer must not turn a valid trade into a 400. The chain
 * still enforces the real rule at settle.
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param destination - The settlement destination to check.
 * @returns The problem, or null when the address is a usable owner.
 */
export async function findDvpDestinationProblem(
  rpc: SolanaRpc,
  destination: Address
): Promise<DvpDestinationProblem | null> {
  const account = await getAccountInfo(rpc, destination);

  // Nothing there. A pure derivation does not care, so neither do we.
  if (!account) {
    return null;
  }

  const owner = account.owner;
  if (owner === TOKEN_PROGRAM_ADDRESS || owner === TOKEN_2022_PROGRAM_ADDRESS) {
    return "token-program-owned";
  }

  // The System Program for an ordinary wallet, or another program for a PDA. A
  // program-owned destination is a real case — a vault delivering to its own
  // authority — and the associated-token program allows an off-curve owner, so
  // this deliberately does not judge it.
  return null;
}

/** The problem, phrased for the caller who sent the address. */
export function describeDvpDestinationProblem(field: string): string {
  return `${field} is owned by a token program, so it is a mint or a token account rather than an account that can hold one. A settlement destination must be the owner that will receive the tokens.`;
}
