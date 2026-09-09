/**
 * Settling and cancelling a DvP trade.
 *
 * Both are signed by the project's settlement authority and both close the
 * trade. Settle delivers each leg to the other party; Cancel refunds each leg
 * to whoever deposited it. Nothing else can do either — the parties can only
 * unwind their own leg.
 *
 * The same safety order as create: build, sign, record intent, send. Here the
 * "record" step is the approved-operation effect fence, which is what makes a
 * crash mid-broadcast recoverable rather than ambiguous.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { signTransactionMessageWithSigners } from "@solana/signers";
import type { Context } from "hono";
import type { DvpTradeRow, DvpTradeStatus } from "@/db/repositories";
import { badRequest } from "@/lib/errors";
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import {
  buildCancelInstruction,
  buildMissingAtaInstructions,
  buildSettleInstruction,
} from "./settle-instructions";
import {
  type DvpSettleAtas,
  deriveDvpSettleAtas,
  findMissingSettleAtas,
  findSettlementFundingShortfall,
} from "./settle-preflight";
import { getOrCreateDvpSettlementWallet } from "./settlement-wallet";

/** Statuses from which a trade can still be acted on. */
const OPEN: ReadonlySet<DvpTradeStatus> = new Set([
  "created",
  "partially_funded",
  "funded",
  "expired",
]);

export type DvpCloseAction = "settle" | "cancel";

export interface DvpCloseResult {
  signature: Signature;
  /** Accounts this transaction created because settlement required them. */
  createdAccounts: string[];
}

/**
 * Settles or cancels a trade on chain.
 *
 * @param c - Request context, needed for the approved-operation effect fence.
 * @param trade - The trade to close, as stored.
 * @param action - Whether to deliver both legs or refund them.
 * @returns The broadcast signature and any accounts created along the way.
 */
export async function closeDvpTrade(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  action: DvpCloseAction
): Promise<DvpCloseResult> {
  const env = c.env;

  if (!OPEN.has(trade.status)) {
    // A closed trade's account is gone, so the instruction would fail on chain
    // anyway — but saying so here names the reason instead of surfacing a
    // program error, and avoids spending a signature to learn it.
    throw badRequest(`DvP trade ${trade.id} is ${trade.status} and can no longer be ${action}d`);
  }

  // Settle moves both legs, so it needs both actually funded. Cancel does not:
  // refunding an unfunded or half-funded trade is exactly what it is for.
  if (action === "settle" && trade.status !== "funded") {
    throw badRequest(
      `DvP trade ${trade.id} is ${trade.status}; settlement requires both legs funded`
    );
  }

  const settlement = await getOrCreateDvpSettlementWallet(env, {
    organizationId: trade.organizationId,
    projectId: trade.projectId,
  });
  // The authority is a PDA seed, so a project that rotated its settlement
  // wallet cannot settle trades created under the old one. Better to say that
  // than to send a transaction the program will reject.
  if (settlement.address !== trade.settlementAuthority) {
    throw badRequest(
      `DvP trade ${trade.id} was created under settlement authority ${trade.settlementAuthority}, which is no longer this project's. The authority is part of the trade's address and cannot be changed.`
    );
  }

  const signer = await createOrgSignerForCustodyWallet(
    env,
    trade.organizationId,
    trade.projectId,
    settlement.custodyWalletId
  );

  const atas = await deriveDvpSettleAtas({
    userA: trade.userA as never,
    userB: trade.userB as never,
    userASettlementDestination: trade.userASettlementDestination as never,
    userBSettlementDestination: trade.userBSettlementDestination as never,
    mintA: trade.mintA as never,
    mintB: trade.mintB as never,
    tokenProgramA: trade.tokenProgramA as never,
    tokenProgramB: trade.tokenProgramB as never,
  });

  const rpc = solanaRpc.createRpc(env);
  const missing = await resolveMissingAtas(rpc, atas, action);

  // Before a signature is spent. The settlement authority pays the fee and the
  // rent for every account this close creates, and it is provisioned empty — so
  // the first settle in a project failed in simulation with an error that named
  // neither the account nor the amount, and surfaced as "An internal error
  // occurred". Saying it plainly is the whole fix.
  const shortfall = await findSettlementFundingShortfall(rpc, signer.address, missing.size);
  if (shortfall) {
    throw badRequest(
      `DvP trade ${trade.id}: the settlement authority ${signer.address} holds ${shortfall.balance} lamports but needs about ${shortfall.required} to ${action} this trade — it pays the network fee and the rent for ${missing.size} token account(s) this close has to create. Send it at least ${shortfall.shortfall} more lamports and try again.`
    );
  }

  const instructions = [
    ...buildMissingAtaInstructions(trade, atas, signer, missing),
    action === "settle"
      ? buildSettleInstruction(trade, atas, signer)
      : buildCancelInstruction(trade, atas, signer),
  ];

  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  // The point of no return. Past this the transaction may land, so an approved
  // operation that dies here must be reconciled by hand rather than retried —
  // which is exactly what this fence records.
  await beginApprovedWalletOperationEffect(c);

  await solanaRpc.sendTransaction(rpc, new Uint8Array(getTransactionEncoder().encode(signed)));

  return {
    signature,
    createdAccounts: [...missing].map((key) => atas[key]),
  };
}

/**
 * Which of Settle's required accounts are missing and must be created first.
 *
 * Cancel needs only the two refund accounts, so it is not held up by a missing
 * delivery destination — a trade being unwound has nothing to deliver, and
 * requiring an account it will never use would block the escape hatch.
 */
async function resolveMissingAtas(
  rpc: solanaRpc.SolanaRpc,
  atas: DvpSettleAtas,
  action: DvpCloseAction
): Promise<ReadonlySet<keyof DvpSettleAtas>> {
  const missing = await findMissingSettleAtas(rpc, atas);

  const relevant: ReadonlyArray<keyof DvpSettleAtas> =
    action === "settle"
      ? ["userADestinationAtaB", "userBDestinationAtaA", "userAAtaA", "userBAtaB"]
      : ["userAAtaA", "userBAtaB"];

  return new Set(relevant.filter((key) => missing.has(key)));
}
