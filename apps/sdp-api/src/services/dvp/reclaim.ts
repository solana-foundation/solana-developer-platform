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
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64Encoder,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
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
import { submitSponsoredTransaction } from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { readDvpAccounts } from "./read-chain";
import { buildReclaimInstructions } from "./reclaim-instructions";

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
 * Order: every local and chain refusal first, then sponsorship, then broadcast,
 * then the receipt is cleared. A crash anywhere before the broadcast costs
 * nothing; a crash after it leaves a receipt that a retry clears, because a
 * retry drains whatever is still there.
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

  // A funding still in flight on this leg could land after the reclaim, leaving
  // the leg funded again straight after somebody asked for it back.
  const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
  const inFlight = (await claims.listForTrade(trade.id)).some(
    (claim) => claim.side === side && claim.fundingTx === null
  );
  if (inFlight) {
    throw conflict(`DvP trade ${trade.id}: this leg is still being funded; nothing was sent`, {
      reason: DVP_LEG_REFUSAL.legFundingInProgress,
    });
  }

  const rpc = solanaRpc.createRpc(env);
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

  const leg = isA ? snapshot.legA : snapshot.legB;
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

  // `validate_mint_extensions` allows TransferHook, and the program forwards
  // hook accounts as trailing extras. SDP does not resolve those, so the
  // Token-2022 CPI would refuse the refund; say so instead of paying to find out.
  const mintAccount = await fetchMaybeMint(rpc, mint);
  if (!mintAccount.exists) {
    throw badRequest(`DvP trade ${trade.id}: mint ${mint} could not be read`, {
      reason: DVP_LEG_REFUSAL.mintUnreadable,
    });
  }
  const extensions = mintAccount.data.extensions;
  if (
    extensions.__option === "Some" &&
    extensions.value.some((extension) => extension.__kind === "TransferHook")
  ) {
    throw conflict(
      `DvP trade ${trade.id}: mint ${mint} carries a transfer hook, which reclaim does not support yet; nothing was sent`,
      { reason: DVP_LEG_REFUSAL.transferHookUnsupported }
    );
  }

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
      `DvP trade ${trade.id}: the custody wallet no longer signs as side ${side}'s party; nothing was sent`
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

  const reclaimSignature = await submitSponsoredTransaction({
    feePayment,
    rpc,
    transaction: new Uint8Array(getTransactionEncoder().encode(partiallySigned)),
    lastValidBlockHeight,
    store: {
      persistSigned: async ({ signature, signedTransaction }) => {
        await assertSponsorSignedSameMessage({
          unsignedOrPartiallySigned: partiallySigned,
          sponsorSigned: new Uint8Array(getBase64Encoder().encode(signedTransaction)),
          sponsor,
        });
        getLogger().info({ tradeId: trade.id, side, signature }, "DvP reclaim signed");
      },
      markStarted: async () => {},
      hasStarted: async () => false,
    },
  });

  // On the wire, so the deposit is on its way back. Clearing the receipt now is
  // safe even if this transaction drops: funding reads the escrow live and
  // refuses a leg that still holds its amount, so a lost reclaim cannot turn
  // into an over-funded leg, and retrying the reclaim drains what is left.
  await claims.deleteReceipt(trade.id, side);

  return { signature: reclaimSignature, leg: side, amount: leg.amount.toString() };
}
