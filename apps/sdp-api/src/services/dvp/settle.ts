/**
 * Settling and cancelling a DvP trade.
 *
 * The same safety order as create: build, sign, record intent, send. Here the
 * "record" step is the approved-operation effect fence, which is what makes a
 * crash mid-broadcast recoverable rather than ambiguous.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { Context } from "hono";
import type { DvpTradeRow, DvpTradeStatus } from "@/db/repositories";
import { badRequest, conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { createRequestSponsorshipFeePayment } from "@/services/sponsorship.service";
import {
  type SignedSubmissionStore,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { readDvpAccounts } from "./read-chain";
import { deriveDvpSettleAtas } from "./settle-atas";
import {
  buildCancelInstruction,
  buildRequiredAtaInstructions,
  buildSettleInstruction,
} from "./settle-instructions";
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
}

/** Settles or cancels a trade on chain. `c` carries the approved-operation fence context. */
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
    userA: trade.userA,
    userB: trade.userB,
    userASettlementDestination: trade.userASettlementDestination,
    userBSettlementDestination: trade.userBSettlementDestination,
    mintA: trade.mintA,
    mintB: trade.mintB,
    tokenProgramA: trade.tokenProgramA,
    tokenProgramB: trade.tokenProgramB,
  });

  const rpc = solanaRpc.createRpc(env);
  const snapshot = await readDvpAccounts(rpc, trade.swapDvp, {
    a: { escrow: trade.escrowA, tokenProgram: trade.tokenProgramA, mint: trade.mintA },
    b: { escrow: trade.escrowB, tokenProgram: trade.tokenProgramB, mint: trade.mintB },
  });
  if (
    (!snapshot.legA.exists && snapshot.legA.tampered) ||
    (!snapshot.legB.exists && snapshot.legB.tampered)
  ) {
    throw conflict(
      `DvP trade ${trade.id}: the escrow for this leg is not the trade's token account (owner/mint/program mismatch); refusing to touch it`
    );
  }
  // Sponsorship is resolved only after every local refusal above, as in create.
  const feePayment = createRequestSponsorshipFeePayment(c);
  const sponsor = await feePayment.getFeePayer();

  const instructions = [
    ...buildRequiredAtaInstructions(trade, atas, createNoopSigner(sponsor), action),
    action === "settle"
      ? buildSettleInstruction(trade, atas, signer)
      : buildCancelInstruction(trade, atas, signer),
  ];

  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const bytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  // The fence sits between the sponsor signature and the broadcast: a sponsor
  // refusal leaves the approval retryable, while anything past markStarted may
  // have landed and is recovered by the reconciler from chain history.
  const store: SignedSubmissionStore = {
    persistSigned: async ({ signature }) => {
      getLogger().info({ tradeId: trade.id, action, signature }, "DvP close signed");
    },
    markStarted: () => beginApprovedWalletOperationEffect(c),
    // Consulted only when markStarted throws; a lost lease is not a started effect.
    hasStarted: async () => false,
  };

  const signature = await submitSponsoredTransaction({
    feePayment,
    rpc,
    transaction: bytes,
    lastValidBlockHeight,
    store,
  });

  return { signature };
}
