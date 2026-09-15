/**
 * Settling and cancelling a DvP trade.
 *
 * The handler authorizes the settlement wallet. Kora sponsors the transaction
 * fees and ATA rent; closing never selects or provisions another wallet.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import { DVP_CLOSE_REFUSAL } from "@sdp/types";
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { Context } from "hono";
import { getDb } from "@/db";
import { createDvpTradeRepository, type DvpTradeRow, type DvpTradeStatus } from "@/db/repositories";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { badRequest, conflict, transactionFailed } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { createRequestSponsorshipFeePayment } from "@/services/sponsorship.service";
import {
  isDefiniteSubmissionError,
  type SignedSubmissionStore,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { isPastDvpExpiry } from "./observe";
import { readDvpAccounts } from "./read-chain";
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

/** How long a close waits for its own confirmation before leaving it to the reconciler. */
const CLOSE_CONFIRM_TIMEOUT_MS = 15_000;

export interface DvpCloseResult {
  signature: Signature;
  /** Whether the close is confirmed. Only a confirmed close is recorded as settled or cancelled. */
  landed: boolean;
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
 * @param clusterNow - The cluster clock's `unixTimestamp`, read with the escrows.
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

  // The authority is a PDA seed, so a project that rotated its settlement
  // wallet cannot settle trades created under the old one. Better to say that
  // than to send a transaction the program will reject.
  if (settlement.address !== trade.settlementAuthority) {
    throw badRequest(
      `DvP trade ${trade.id} was created under settlement authority ${trade.settlementAuthority}, which is no longer this project's. The authority is part of the trade's address and cannot be changed.`
    );
  }

  // After the local refusals, so a trade the row already rules out is answered
  // without a chain read, and an unreachable RPC cannot mask that answer. Before
  // the custody signer, so a refusal here never calls the provider.
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
  if (action === "settle") {
    assertInsideSettlementWindow(trade, snapshot.clusterUnixTimestamp);
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
  const authoritySignatureBytes = partiallySigned.signatures[signer.address];
  if (authoritySignatureBytes === null || authoritySignatureBytes === undefined) {
    throw new Error("DvP close transaction is missing the settlement authority signature");
  }
  const claimSignature = signature(getBase58Decoder().decode(authoritySignatureBytes));

  // The trade's close lock, before anything is sponsored or sent, so of two
  // closes only one goes out. Then the leg locks, which a funding or reclaim
  // takes before it sends: whichever of the two locks commits second sees the
  // first, so a close and a leg action never both go out.
  const trades = createDvpTradeRepository(env);
  const claimed = await trades.claimClose(trade.id, {
    action,
    signature: claimSignature,
    expiryHeight: lastValidBlockHeight.toString(),
  });
  if (!claimed) {
    throw conflict(`DvP trade ${trade.id}: another settle or cancel is already in flight`, {
      reason: DVP_CLOSE_REFUSAL.closeInProgress,
    });
  }
  const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  if (
    await createPostgresDvpLegFundingClaimRepository(getDb(env)).hasLiveClaim(trade.id, blockHeight)
  ) {
    await trades.releaseCloseClaim(trade.id, claimSignature);
    throw conflict(`DvP trade ${trade.id}: a leg is still being funded or reclaimed`, {
      reason: DVP_CLOSE_REFUSAL.legMoving,
    });
  }

  let heldSignature: Signature = claimSignature;
  const store: SignedSubmissionStore = {
    persistSigned: async ({ signature: sponsored }) => {
      if (!(await trades.rebindCloseClaim(trade.id, claimSignature, sponsored))) {
        throw new Error("close lock was released before the sponsored signature could be attached");
      }
      heldSignature = sponsored;
      getLogger().info({ tradeId: trade.id, action, signature: sponsored }, "DvP close signed");
    },
    markStarted: async () => {},
    hasStarted: async () => false,
  };

  let closeSignature: Signature;
  try {
    closeSignature = await submitSponsoredTransaction({
      feePayment,
      rpc,
      transaction: new Uint8Array(getTransactionEncoder().encode(partiallySigned)),
      lastValidBlockHeight,
      store,
    });
  } catch (error) {
    // Never signed, or refused before the network: nothing can land. Anything
    // ambiguous keeps the lock until its blockhash expires.
    if (heldSignature === claimSignature || isDefiniteSubmissionError(error)) {
      await trades.releaseCloseClaim(trade.id, heldSignature);
    }
    throw error;
  }

  return {
    signature: closeSignature,
    landed: await closeOutcome(trades, rpc, trade.id, action, closeSignature),
  };
}

/**
 * What became of a close on the wire. The status is written only from this,
 * never from the RPC accepting the transaction: a second close can be accepted
 * and still be the one that fails.
 *
 * @returns True once the close is confirmed. False while it is unconfirmed; the
 *   lock stays until its blockhash expires and the reconciler records whatever
 *   landed.
 * @throws 400 `dvp_close_failed_on_chain` when the program refused it.
 */
async function closeOutcome(
  trades: ReturnType<typeof createDvpTradeRepository>,
  rpc: ReturnType<typeof solanaRpc.createRpc>,
  tradeId: string,
  action: DvpCloseAction,
  closeSignature: Signature
): Promise<boolean> {
  let confirmation: Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>;
  try {
    confirmation = await solanaRpc.confirmTransaction(rpc, closeSignature, {
      timeoutMs: CLOSE_CONFIRM_TIMEOUT_MS,
    });
  } catch (error) {
    getLogger().warn(
      { error, tradeId, action, signature: closeSignature },
      "dvp close: not confirmed in time; the reconciler records the close once it lands"
    );
    return false;
  }
  if (
    confirmation.confirmationStatus !== "confirmed" &&
    confirmation.confirmationStatus !== "finalized"
  ) {
    return false;
  }
  if (confirmation.err !== null) {
    await trades.releaseCloseClaim(tradeId, closeSignature);
    throw transactionFailed(
      `DvP trade ${tradeId}: the ${action} was refused on chain; nothing moved`,
      { reason: DVP_CLOSE_REFUSAL.closeFailedOnChain }
    );
  }
  return true;
}
