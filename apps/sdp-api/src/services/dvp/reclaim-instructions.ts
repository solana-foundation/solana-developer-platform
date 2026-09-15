/**
 * Building the instruction list for `ReclaimDvp`.
 *
 * Kept apart from broadcasting, like `settle-instructions.ts`, so the account
 * wiring can be asserted without a network and run against a real program.
 */

import { getReclaimDvpInstruction } from "@sdp/dvp";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";

/** One leg of a trade, as reclaim needs it. */
export interface DvpReclaimLeg {
  swapDvp: Address;
  mint: Address;
  tokenProgram: Address;
  escrow: Address;
}

/**
 * Creates the party's token account if it is missing, then drains the escrow into it.
 *
 * `reclaim_dvp.rs` requires the destination to be the signer's canonical ATA for
 * the leg's mint under the leg's own token program, and to exist when the escrow
 * is not empty. The create is idempotent, so an existing account costs nothing.
 *
 * @param leg - The leg to reclaim.
 * @param party - The leg's party, which is the only signer the program accepts.
 * @param destination - The party's canonical ATA for the leg's mint.
 * @param payer - Pays rent for the destination when it has to be created.
 * @returns The two instructions, in order.
 */
export function buildReclaimInstructions(
  leg: DvpReclaimLeg,
  party: TransactionSigner,
  destination: Address,
  payer: TransactionSigner
): Instruction[] {
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      owner: party.address,
      mint: leg.mint,
      ata: destination,
      tokenProgram: leg.tokenProgram,
    }),
    getReclaimDvpInstruction({
      signer: party,
      swapDvp: leg.swapDvp,
      mint: leg.mint,
      dvpSourceAta: leg.escrow,
      signerDestAta: destination,
      tokenProgram: leg.tokenProgram,
      memoProgram: MEMO_PROGRAM_ADDRESS,
    }),
  ];
}
