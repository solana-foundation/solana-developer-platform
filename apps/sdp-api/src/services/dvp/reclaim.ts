/**
 * Pulling a funded leg back out of an open trade, to the party that funded it.
 *
 * `ReclaimDvp` (`program/src/processor/reclaim_dvp.rs`) drains the escrow's
 * actual balance into the signer's canonical token account for that mint. Only
 * the leg's own party can sign, and the signer's identity is what picks the
 * leg, so for a leg SDP funded the signer is the custody wallet holding the
 * party address. There is no expiry gate on chain: a deposit can always come
 * back. The trade stays open, and the leg can be funded again.
 */

import { SwapDvpVerificationError, verifySwapDvpAccount } from "@sdp/dvp";
import * as solanaRpc from "@sdp/rpc/solana";
import { DVP_LEG_REFUSAL } from "@sdp/types";
import {
  type Address,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { fetchMaybeMint, findAssociatedTokenPda } from "@solana-program/token-2022";
import type { Context } from "hono";
import { getDb } from "@/db";
import type { DvpTradeRow, DvpTradeSide, DvpTradeStatus } from "@/db/repositories";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { badRequest, conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  assertSponsorSignedSameMessage,
  createProjectSponsorshipFeePayment,
} from "@/services/sponsorship.service";
import {
  isDefiniteSubmissionError,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { readDvpFundingReceipt } from "./funding-receipt";
import { readDvpAccounts } from "./read-chain";
import { buildReclaimInstructions } from "./reclaim-instructions";

/** How long a reclaim waits for its own confirmation before leaving the lock to the sweep. */
const RECLAIM_CONFIRM_TIMEOUT_MS = 15_000;

/** Statuses whose escrows are still on chain. Expired included: reclaim has no expiry gate. */
const RECLAIMABLE: ReadonlySet<DvpTradeStatus> = new Set([
  "created",
  "partially_funded",
  "funded",
  "expired",
]);

export interface DvpReclaimResult {
  signature: Signature;
  leg: DvpTradeSide;
  /** The escrow balance read before sending, in base units. The program drains what is there at execution. */
  amount: string;
}

/**
 * Reclaims one side's escrow into the custody wallet that holds its party address.
 *
 * Order: every local and chain refusal (including what any funding receipt on
 * the leg actually did), then sign, then take the leg's lock, then send, then
 * confirm, then release the lock. A crash before the lock costs nothing; a
 * crash while holding it leaves a lock the expiry sweep frees.
 *
 * @param c - Request context, for the sponsorship budget.
 * @param trade - The trade, already authorized for this side.
 * @param params - The side and the custody wallet the handler re-read for it.
 * @returns The reclaim signature and the balance it set out to return.
 */
export async function reclaimDvpTradeLeg(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  params: {
    side: DvpTradeSide;
    custodyWalletId: string;
    organizationId: string;
    projectId: string;
  }
): Promise<DvpReclaimResult> {
  const env = c.env;
  const { side } = params;

  if (!RECLAIMABLE.has(trade.status)) {
    throw badRequest(`DvP trade ${trade.id} is ${trade.status}; its escrows are closed`, {
      reason: DVP_LEG_REFUSAL.tradeNotReclaimable,
    });
  }

  const isA = side === "a";
  const party = isA ? trade.userA : trade.userB;
  const mint = isA ? trade.mintA : trade.mintB;
  const tokenProgram = isA ? trade.tokenProgramA : trade.tokenProgramB;
  const escrow = isA ? trade.escrowA : trade.escrowB;

  const rpc = solanaRpc.createRpc(env);
  const held = await readReclaimableEscrow(rpc, trade, side);

  await refuseTransferHookMint(rpc, trade.id, mint);

  const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
  const receipt = await takeoverableReceipt(claims, rpc, trade.id, side);

  const signer = await createOrgSignerForCustodyWallet(
    env,
    params.organizationId,
    params.projectId,
    params.custodyWalletId
  );
  // The handler matched this wallet to the party address from the database.
  // The program only accepts the party itself, so a signer that resolves to
  // anything else would be a transaction it refuses.
  if (signer.address !== party) {
    throw conflict(
      `DvP trade ${trade.id}: the custody wallet no longer signs as side ${side}'s party; nothing was sent`,
      { reason: DVP_LEG_REFUSAL.signerNotParty }
    );
  }

  const [destination] = await findAssociatedTokenPda({ owner: party, mint, tokenProgram });

  // Sponsorship only after every refusal above, as in fund and settle.
  const feePayment = await createProjectSponsorshipFeePayment(env, {
    organizationId: params.organizationId,
    projectId: params.projectId,
    actor: { type: "wallet", id: params.custodyWalletId },
  });
  const sponsor = await feePayment.getFeePayer();

  // The sponsor pays rent for the destination when it has to be created, like
  // the accounts settle creates.
  const instructions = buildReclaimInstructions(
    { swapDvp: trade.swapDvp, mint, tokenProgram, escrow },
    signer,
    destination,
    createNoopSigner(sponsor)
  );

  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const walletSignatureBytes = partiallySigned.signatures[party];
  if (walletSignatureBytes === null || walletSignatureBytes === undefined) {
    throw new Error("DvP reclaim transaction is missing the custody wallet signature");
  }
  const claimSignature = signature(getBase58Decoder().decode(walletSignatureBytes));

  // The leg's lock, the same one funding takes, held from before the broadcast
  // until the reclaim confirms. Without it a funding could start between a check
  // and the send and land after the reclaim. Taking over is guarded on the exact
  // receipt checked above, so a row that changed since then refuses. The expiry
  // height rides with the lock so the sweep frees one an unconfirmed send leaves.
  const claimed = await claims.claimForReclaim(
    {
      tradeId: trade.id,
      side,
      organizationId: params.organizationId,
      projectId: params.projectId,
      custodyWalletId: params.custodyWalletId,
      signature: claimSignature,
      expiryHeight: lastValidBlockHeight.toString(),
    },
    receipt
  );
  if (!claimed) {
    throw conflict(`DvP trade ${trade.id}: this leg is already being moved; nothing was sent`, {
      reason: DVP_LEG_REFUSAL.legFundingInProgress,
    });
  }

  let heldSignature: Signature = claimSignature;
  let reclaimSignature: Signature;
  try {
    reclaimSignature = await submitSponsoredTransaction({
      feePayment,
      rpc,
      transaction: new Uint8Array(getTransactionEncoder().encode(partiallySigned)),
      lastValidBlockHeight,
      store: {
        persistSigned: async ({ signature: sponsored, signedTransaction }) => {
          await assertSponsorSignedSameMessage({
            unsignedOrPartiallySigned: partiallySigned,
            sponsorSigned: new Uint8Array(getBase64Encoder().encode(signedTransaction)),
            sponsor,
          });
          if (!(await claims.rebindSignature(trade.id, side, claimSignature, sponsored))) {
            throw new Error(
              "reclaim lock was released before the sponsored signature could be attached"
            );
          }
          heldSignature = sponsored;
          getLogger().info({ tradeId: trade.id, side, signature: sponsored }, "DvP reclaim signed");
        },
        markStarted: async () => {},
        hasStarted: async () => claims.hasClaim(trade.id, side, heldSignature),
      },
    });
  } catch (error) {
    // Rejected before the network, or never signed: nothing can land, so the
    // leg is free again. Anything ambiguous keeps the lock until its blockhash
    // expires, because the reclaim may still land.
    if (heldSignature === claimSignature || isDefiniteSubmissionError(error)) {
      await claims.release(trade.id, side, heldSignature);
    }
    throw error;
  }

  await releaseOnceConfirmed(
    claims,
    rpc,
    { tradeId: trade.id, side },
    heldSignature,
    reclaimSignature
  );

  return { signature: reclaimSignature, leg: side, amount: held.toString() };
}

type FundingClaims = ReturnType<typeof createPostgresDvpLegFundingClaimRepository>;
type Rpc = ReturnType<typeof solanaRpc.createRpc>;

/**
 * Reads the leg's escrow live and refuses anything reclaim cannot act on: a
 * trade no longer on chain, a missing or tampered escrow, or an empty one.
 *
 * @returns The escrow balance, in base units.
 */
async function readReclaimableEscrow(rpc: Rpc, trade: DvpTradeRow, side: DvpTradeSide) {
  const snapshot = await readDvpAccounts(rpc, trade.swapDvp, {
    a: { escrow: trade.escrowA, tokenProgram: trade.tokenProgramA, mint: trade.mintA },
    b: { escrow: trade.escrowB, tokenProgram: trade.tokenProgramB, mint: trade.mintB },
  });
  try {
    await verifySwapDvpAccount(snapshot.trade);
  } catch (error) {
    if (error instanceof SwapDvpVerificationError) {
      throw conflict(`DvP trade ${trade.id}: the trade is no longer on chain; nothing was sent`, {
        reason: DVP_LEG_REFUSAL.tradeNotOnChain,
      });
    }
    throw error;
  }

  const leg = side === "a" ? snapshot.legA : snapshot.legB;
  if (!leg.exists) {
    if (leg.tampered) {
      throw conflict(
        `DvP trade ${trade.id}: the escrow for this leg is not the trade's token account (owner/mint/program mismatch); refusing to touch it`,
        { reason: DVP_LEG_REFUSAL.escrowMismatch }
      );
    }
    throw conflict(`DvP trade ${trade.id}: the escrow for this leg is missing; nothing was sent`, {
      reason: DVP_LEG_REFUSAL.escrowMissing,
    });
  }
  // The program no-ops an empty escrow, so sending one would spend a sponsored
  // fee to move nothing.
  if (leg.amount === 0n) {
    throw conflict(`DvP trade ${trade.id}: this leg's escrow holds nothing to reclaim`, {
      reason: DVP_LEG_REFUSAL.nothingToReclaim,
    });
  }
  return leg.amount;
}

/**
 * `validate_mint_extensions` allows TransferHook, and the program forwards hook
 * accounts as trailing extras. SDP does not resolve those, so the Token-2022 CPI
 * would refuse the refund; say so instead of paying to find out.
 */
async function refuseTransferHookMint(rpc: Rpc, tradeId: string, mint: Address) {
  const mintAccount = await fetchMaybeMint(rpc, mint);
  if (!mintAccount.exists) {
    throw badRequest(`DvP trade ${tradeId}: mint ${mint} could not be read`, {
      reason: DVP_LEG_REFUSAL.mintUnreadable,
    });
  }
  const extensions = mintAccount.data.extensions;
  if (
    extensions.__option === "Some" &&
    extensions.value.some((extension) => extension.__kind === "TransferHook")
  ) {
    throw conflict(
      `DvP trade ${tradeId}: mint ${mint} carries a transfer hook, which reclaim does not support yet; nothing was sent`,
      { reason: DVP_LEG_REFUSAL.transferHookUnsupported }
    );
  }
}

/**
 * The funding receipt a reclaim may take over, or null when the leg has no row.
 *
 * A funding row is either a lock (still being sent) or a receipt (`funding_tx`
 * set straight after broadcast, before anything confirms). Only a receipt whose
 * transfer the chain confirmed, or one that provably moved nothing, may be taken
 * over: reclaiming ahead of a funding that has not landed drains today's balance
 * and leaves that funding to land afterwards, re-funding the leg the caller was
 * just told was reclaimed.
 *
 * @throws 409 `legFundingInProgress` while a funding on the leg can still land.
 */
async function takeoverableReceipt(
  claims: FundingClaims,
  rpc: Rpc,
  tradeId: string,
  side: DvpTradeSide
): Promise<string | null> {
  const existing = (await claims.listForTrade(tradeId)).find((row) => row.side === side);
  if (existing === undefined) {
    return null;
  }
  const state =
    existing.fundingTx === null
      ? "pending"
      : await readDvpFundingReceipt(rpc, {
          fundingTx: existing.fundingTx,
          expiryHeight: existing.expiryHeight,
        });
  if (state === "pending") {
    throw conflict(`DvP trade ${tradeId}: this leg is already being moved; nothing was sent`, {
      reason: DVP_LEG_REFUSAL.legFundingInProgress,
    });
  }
  return existing.fundingTx;
}

/**
 * Releases the reclaim's lock once its transaction is confirmed.
 *
 * On the wire is not landed. Until it confirms the balance anyone reads is
 * stale, and a second reclaim or a funding let in now would read the escrow
 * still full and send on top of it. A confirmed failure is final too, so it
 * releases. An unconfirmed send keeps the lock until its blockhash expires and
 * `releaseExpired` frees it.
 */
async function releaseOnceConfirmed(
  claims: FundingClaims,
  rpc: Rpc,
  leg: { tradeId: string; side: DvpTradeSide },
  heldSignature: Signature,
  reclaimSignature: Signature
) {
  try {
    const confirmation = await solanaRpc.confirmTransaction(rpc, reclaimSignature, {
      timeoutMs: RECLAIM_CONFIRM_TIMEOUT_MS,
    });
    if (
      confirmation.confirmationStatus === "confirmed" ||
      confirmation.confirmationStatus === "finalized"
    ) {
      await claims.release(leg.tradeId, leg.side, heldSignature);
    }
  } catch (error) {
    getLogger().warn(
      { error, ...leg, signature: reclaimSignature },
      "dvp reclaim: not confirmed in time; the leg stays locked until its blockhash expires"
    );
  }
}
