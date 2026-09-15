/**
 * Settling and cancelling a DvP trade.
 *
 * The handler authorizes the settlement wallet. Kora sponsors the transaction
 * fees and ATA rent; closing never selects or provisions another wallet.
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
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { createRequestSponsorshipFeePayment } from "@/services/sponsorship.service";
import {
  type SignedSubmissionStore,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { isPastDvpExpiry } from "./observe";
import { readClusterUnixTimestamp, readDvpAccounts } from "./read-chain";
import { deriveDvpSettleAtas } from "./settle-atas";
import {
  buildCancelInstruction,
  buildRequiredAtaInstructions,
  buildSettleInstruction,
} from "./settle-instructions";
import type { DvpSettlementWallet } from "./settlement-wallet";

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

/**
 * Refuses a settle the program would refuse on time alone.
 *
 * Judged by the cluster's `Clock` sysvar, the value `settle_dvp.rs` reads, not
 * the host clock: a host a few seconds off would refuse settlements the program
 * accepts, before preflight could say otherwise. And not trusted to the status:
 * the row is only as fresh as its last observation, so a trade can still read
 * `funded` for a few seconds after it expired. Cancel has no window
 * (`cancel_dvp.rs:17-20`), which is why only settle comes through here.
 *
 * The clock only moves forward, so a read that is already past expiry is past it
 * for the transaction too. An earliest time is the one edge that can close
 * between this read and execution, a slot or two later; that refusal is retryable.
 *
 * @param trade - The trade about to settle.
 * @param clusterNow - The cluster clock's `unixTimestamp`.
 */
function assertInsideSettlementWindow(
  trade: Pick<DvpTradeRow, "id" | "expiryTimestamp" | "earliestSettlementTimestamp">,
  clusterNow: bigint
): void {
  if (isPastDvpExpiry(trade.expiryTimestamp, clusterNow)) {
    throw badRequest(`DvP trade ${trade.id} is past its expiry and can only be cancelled`);
  }
  // `settle_dvp.rs:144-146`: `now >= earliest` when the trade sets one.
  if (
    trade.earliestSettlementTimestamp !== null &&
    clusterNow < BigInt(trade.earliestSettlementTimestamp)
  ) {
    throw badRequest(
      `DvP trade ${trade.id} cannot settle before its earliest settlement time ${trade.earliestSettlementTimestamp}`
    );
  }
}

/** Settles or cancels a trade using the wallet already authorized by the handler. */
export async function closeDvpTrade(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  action: DvpCloseAction,
  settlement: DvpSettlementWallet
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

  // After the local refusals, so a trade the row already rules out is answered
  // without a chain read, and an unreachable RPC cannot mask that answer.
  const rpc = solanaRpc.createRpc(env);
  if (action === "settle") {
    assertInsideSettlementWindow(trade, await readClusterUnixTimestamp(rpc));
  }

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
  if (signer.address !== trade.settlementAuthority) {
    throw badRequest("DvP settlement wallet no longer matches the trade's authority");
  }
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
  const store: SignedSubmissionStore = {
    persistSigned: async ({ signature }) => {
      getLogger().info({ tradeId: trade.id, action, signature }, "DvP close signed");
    },
    markStarted: async () => {},
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
