/**
 * Building the instruction list for `SettleDvp` and `CancelDvp`.
 *
 * Kept apart from broadcasting so the account wiring — which is where a mistake
 * silently sends someone else's tokens somewhere else — can be asserted without
 * a network.
 */

import { getCancelDvpInstruction, getSettleDvpInstruction } from "@sdp/dvp";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import type { DvpTradeRow } from "@/db/repositories";
import type { DvpSettleAtas } from "./settle-preflight";

/**
 * SPL Memo. Settle passes it so a destination with MemoTransfer enabled can be
 * paid — without it, a transfer to such an account reverts, which would be a
 * silent denial of service on an otherwise valid trade.
 */
// biome-ignore lint/security/noSecrets: the SPL Memo program id, a public constant.
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;

/**
 * Creates any of Settle's four required token accounts that are missing.
 *
 * Idempotent by construction, which is what makes checking-then-creating safe:
 * an account that appears between the pre-flight read and the broadcast makes
 * these no-ops rather than failing the transaction.
 *
 * The whole list fits alongside Settle — measured at 706 bytes against the 1232
 * limit — so there is no reason to make an operator run a separate preparation
 * step for accounts the trade cannot settle without.
 */
export function buildMissingAtaInstructions(
  trade: DvpTradeRow,
  atas: DvpSettleAtas,
  payer: TransactionSigner,
  missing: ReadonlySet<keyof DvpSettleAtas>
): Instruction[] {
  const specs: ReadonlyArray<[keyof DvpSettleAtas, Address, Address, Address]> = [
    [
      "userADestinationAtaB",
      trade.userASettlementDestination as Address,
      trade.mintB as Address,
      trade.tokenProgramB as Address,
    ],
    [
      "userBDestinationAtaA",
      trade.userBSettlementDestination as Address,
      trade.mintA as Address,
      trade.tokenProgramA as Address,
    ],
    ["userAAtaA", trade.userA as Address, trade.mintA as Address, trade.tokenProgramA as Address],
    ["userBAtaB", trade.userB as Address, trade.mintB as Address, trade.tokenProgramB as Address],
  ];

  return specs
    .filter(([key]) => missing.has(key))
    .map(([key, owner, mint, tokenProgram]) =>
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
    swapDvp: trade.swapDvp as Address,
    mintA: trade.mintA as Address,
    mintB: trade.mintB as Address,
    dvpAtaA: trade.escrowA as Address,
    dvpAtaB: trade.escrowB as Address,
    userADestinationAtaB: atas.userADestinationAtaB,
    userBDestinationAtaA: atas.userBDestinationAtaA,
    userAAtaA: atas.userAAtaA,
    userBAtaB: atas.userBAtaB,
    tokenProgramA: trade.tokenProgramA as Address,
    tokenProgramB: trade.tokenProgramB as Address,
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
    swapDvp: trade.swapDvp as Address,
    mintA: trade.mintA as Address,
    mintB: trade.mintB as Address,
    dvpAtaA: trade.escrowA as Address,
    dvpAtaB: trade.escrowB as Address,
    userAAtaA: atas.userAAtaA,
    userBAtaB: atas.userBAtaB,
    tokenProgramA: trade.tokenProgramA as Address,
    tokenProgramB: trade.tokenProgramB as Address,
    memoProgram: MEMO_PROGRAM_ADDRESS,
    legAExtrasCount: 0,
  });
}
