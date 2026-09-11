/**
 * Building the instruction list for `SettleDvp` and `CancelDvp`.
 *
 * Kept apart from broadcasting so the account wiring — which is where a mistake
 * silently sends someone else's tokens somewhere else — can be asserted without
 * a network.
 */

import { getCancelDvpInstruction, getSettleDvpInstruction } from "@sdp/dvp";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import type { DvpTradeRow } from "@/db/repositories";
import type { DvpCloseAction } from "./settle";
import type { DvpSettleAtas } from "./settle-atas";

/**
 * Creates every token account touched by the requested close action.
 *
 * The instructions are unconditional and idempotent, so existing accounts are
 * no-ops and dust at an uninitialized ATA address is absorbed by the associated
 * token program.
 *
 * The whole list fits alongside Settle — measured at 706 bytes against the 1232
 * limit — so there is no reason to make an operator run a separate preparation
 * step for accounts the trade cannot settle without.
 */
export function buildRequiredAtaInstructions(
  trade: DvpTradeRow,
  atas: DvpSettleAtas,
  payer: TransactionSigner,
  action: DvpCloseAction
): Instruction[] {
  const settleSpecs: ReadonlyArray<[keyof DvpSettleAtas, Address, Address, Address]> = [
    ["userADestinationAtaB", trade.userASettlementDestination, trade.mintB, trade.tokenProgramB],
    ["userBDestinationAtaA", trade.userBSettlementDestination, trade.mintA, trade.tokenProgramA],
    ["userAAtaA", trade.userA, trade.mintA, trade.tokenProgramA],
    ["userBAtaB", trade.userB, trade.mintB, trade.tokenProgramB],
  ];
  // Cancel needs only the two refund accounts, so it is not held up by a
  // delivery destination — a trade being unwound has nothing to deliver, and
  // requiring an account it will never use would block the escape hatch.
  const specs = action === "settle" ? settleSpecs : settleSpecs.slice(2);

  return specs.map(([key, owner, mint, tokenProgram]) =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      owner,
      mint,
      ata: atas[key],
      tokenProgram,
    })
  );
}

/**
 * Settles a trade: both legs delivered, surplus refunded, escrows and trade
 * account closed. Only the settlement authority can sign it.
 *
 * `legAExtrasCount` is 0 because V1 refuses transfer-hook mints before reaching
 * here. It splits the instruction's remaining accounts between the two legs'
 * hook extras, and resolving those off-chain is a separate piece of work —
 * passing a wrong count would mis-attribute accounts across legs.
 */
export function buildSettleInstruction(
  trade: DvpTradeRow,
  atas: DvpSettleAtas,
  settlementAuthority: TransactionSigner
): Instruction {
  return getSettleDvpInstruction({
    settlementAuthority,
    swapDvp: trade.swapDvp,
    mintA: trade.mintA,
    mintB: trade.mintB,
    dvpAtaA: trade.escrowA,
    dvpAtaB: trade.escrowB,
    userADestinationAtaB: atas.userADestinationAtaB,
    userBDestinationAtaA: atas.userBDestinationAtaA,
    userAAtaA: atas.userAAtaA,
    userBAtaB: atas.userBAtaB,
    tokenProgramA: trade.tokenProgramA,
    tokenProgramB: trade.tokenProgramB,
    memoProgram: MEMO_PROGRAM_ADDRESS,
    legAExtrasCount: 0,
  });
}

/**
 * Cancels a trade: each leg refunded to whoever deposited it, then closed.
 *
 * Takes only the two refund accounts, not the delivery destinations — nothing
 * changes hands, so there is nothing to deliver.
 */
export function buildCancelInstruction(
  trade: DvpTradeRow,
  atas: DvpSettleAtas,
  settlementAuthority: TransactionSigner
): Instruction {
  return getCancelDvpInstruction({
    settlementAuthority,
    swapDvp: trade.swapDvp,
    mintA: trade.mintA,
    mintB: trade.mintB,
    dvpAtaA: trade.escrowA,
    dvpAtaB: trade.escrowB,
    userAAtaA: atas.userAAtaA,
    userBAtaB: atas.userBAtaB,
    tokenProgramA: trade.tokenProgramA,
    tokenProgramB: trade.tokenProgramB,
    memoProgram: MEMO_PROGRAM_ADDRESS,
    legAExtrasCount: 0,
  });
}
