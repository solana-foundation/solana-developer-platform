/**
 * Moving SDP's own leg into escrow.
 *
 * The counterparty funds their leg with an ordinary `TransferChecked` and needs
 * nothing from us — that is the design, and it is what makes DvP easy to
 * integrate. But SDP holds the other leg, and until this existed nothing moved
 * it: completing a trade meant leaving DvP and sending a Payments transfer to
 * the escrow address by hand.
 *
 * The transfer itself is unremarkable. What matters is everything it refuses to
 * do, because each refusal prevents a hazard the trade cannot recover from.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getSignatureFromTransaction,
  getTransactionEncoder,
  isSolanaError,
  pipe,
  type Signature,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { signTransactionMessageWithSigners } from "@solana/signers";
import { findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token-2022";
import type { Context } from "hono";
import { createDvpTradeRepository, type DvpTradeRow, type DvpTradeStatus } from "@/db/repositories";
import { badRequest, conflict } from "@/lib/errors";
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { readMintDecimals } from "./mints";
import { readEscrowState } from "./read-chain";

/** Statuses from which SDP's leg can still be funded. */
const FUNDABLE: ReadonlySet<DvpTradeStatus> = new Set(["created", "partially_funded"]);

export interface DvpFundResult {
  signature: Signature;
  /** Which leg was funded, and how much moved. */
  leg: "a" | "b";
  amount: string;
}

/** The addresses and target for whichever leg SDP holds. */
interface DvpSdpLeg {
  mint: Address;
  tokenProgram: Address;
  escrow: Address;
  amount: bigint;
}

/**
 * Resolves SDP's own leg of a trade.
 *
 * One place decides which side is ours, because the shortfall the approvals
 * queue displays and the shortfall the transfer sends have to be the same
 * number derived the same way.
 */
function sdpLegOf(trade: DvpTradeRow): DvpSdpLeg {
  const sdpLegIsA = trade.sdpSide === "a";
  return {
    mint: (sdpLegIsA ? trade.mintA : trade.mintB) as Address,
    tokenProgram: (sdpLegIsA ? trade.tokenProgramA : trade.tokenProgramB) as Address,
    escrow: (sdpLegIsA ? trade.escrowA : trade.escrowB) as Address,
    amount: BigInt(sdpLegIsA ? trade.amountA : trade.amountB),
  };
}

/**
 * How much of SDP's leg is still outstanding, per the chain right now.
 *
 * Exported for the policy extractor: an approver has to be shown the amount
 * that will actually move, and funding sends the shortfall rather than the
 * target. Returns 0n for a leg that is already at or above its target.
 *
 * @param env - API process environment, for the RPC.
 * @param trade - The trade whose SDP leg is being funded.
 * @returns The outstanding base-unit amount, never negative.
 */
export async function readDvpLegShortfall(env: Env, trade: DvpTradeRow): Promise<bigint> {
  const leg = sdpLegOf(trade);
  const state = await readEscrowState(solanaRpc.createRpc(env), leg.escrow, leg.tokenProgram);
  const held = state?.amount ?? 0n;
  return held >= leg.amount ? 0n : leg.amount - held;
}

/**
 * Funds SDP's leg of a trade from the custody wallet that holds it.
 *
 * @param c - Request context, for the approved-operation effect fence.
 * @param trade - The trade whose SDP leg should be funded.
 * @returns The broadcast signature and what moved.
 */
export async function fundDvpTradeLeg(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow
): Promise<DvpFundResult> {
  const env = c.env;

  if (!FUNDABLE.has(trade.status)) {
    throw badRequest(`DvP trade ${trade.id} is ${trade.status} and can no longer be funded`);
  }

  const { mint, tokenProgram, escrow, amount } = sdpLegOf(trade);

  const rpc = solanaRpc.createRpc(env);

  // Read the escrow NOW rather than trusting the reconciler's last sweep. The
  // sweep runs once a minute, so acting on it would let two funding requests a
  // few seconds apart both believe the escrow was empty.
  const escrowState = await readEscrowState(rpc, escrow, tokenProgram);

  if (escrowState?.frozen) {
    // The transfer would bounce. Saying so costs nothing; learning it from a
    // failed broadcast costs a signature and leaves an unexplained failure.
    throw badRequest(
      `DvP trade ${trade.id}: the escrow for this leg is frozen, so a transfer into it would fail. The mint's freeze authority must thaw ${escrow} first.`
    );
  }

  const held = escrowState?.amount ?? 0n;
  if (held >= amount) {
    throw conflict(
      `DvP trade ${trade.id}: this leg already holds ${held} of ${amount}, so there is nothing left to fund.`
    );
  }

  // Send the SHORTFALL, not the full target. Somebody may already have put
  // part of the leg in, and sending the whole amount on top would leave a
  // surplus, which settlement refunds and which on a transfer-hook mint can
  // revert the whole settlement. Funding a partly funded leg has to top it up
  // exactly.
  const outstanding = amount - held;

  const signer = await createOrgSignerForCustodyWallet(
    env,
    trade.organizationId,
    trade.projectId,
    trade.sdpWalletId
  );

  const [source] = await findAssociatedTokenPda({
    owner: signer.address,
    mint,
    tokenProgram,
  });

  // TransferChecked, never `transfer`: the latter is deprecated under
  // Token-2022 and fails outright on a mint carrying extensions. It needs the
  // mint and its decimals, which is also the check that stops a decimals
  // mismatch moving the wrong quantity.
  const decimals = await readMintDecimals(rpc, mint);
  if (decimals === null) {
    throw badRequest(`DvP trade ${trade.id}: mint ${mint} could not be read`);
  }

  const instruction = getTransferCheckedInstruction(
    { source, mint, destination: escrow, authority: signer, amount: outstanding, decimals },
    { programAddress: tokenProgram }
  );

  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([instruction], m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  // Last look before anything is committed to. Everything between the first
  // balance read and here — resolving a signer at the custody provider above
  // all, which is a call out to a third party — is time in which the escrow ATA
  // could have received a transfer, because it accepts one from anyone. A
  // deposit inside that window leaves `outstanding` too large, and sending it
  // anyway over-funds the escrow; settlement then refunds the surplus, which on
  // a transfer-hook mint can revert the whole Settle. The claim below cannot
  // help with this one: it serialises OUR requests, not a stranger's transfer.
  //
  // Placed BEFORE the claim and the approval fence deliberately, so aborting
  // costs neither a claim to release nor a consumed approval lease.
  //
  // This NARROWS the window to one read; it does not close it, and it cannot be
  // closed from here. Funding is a bare `TransferChecked` with the program
  // uninvolved, SPL has no balance precondition, and the DvP program exposes no
  // deposit instruction that could carry one — only create, settle, cancel,
  // reject, reclaim and recover. Closing it properly needs a program-side
  // deposit capped at the target, which is a program change, not an API one.
  // Aborting is the safe half of the trade-off: a refused top-up is retryable,
  // an over-funded escrow depends on the surplus-refund path working.
  const recheck = await readEscrowState(rpc, escrow, tokenProgram);
  if ((recheck?.amount ?? 0n) !== held) {
    throw conflict(
      `DvP trade ${trade.id}: the escrow balance changed while this funding was being prepared, so ${outstanding} is no longer the amount owed. Nothing was sent — retry to fund the current shortfall.`
    );
  }

  // The balance read above and this transfer are not atomic, so two overlapping
  // requests would both see the same shortfall and both send. The claim is what
  // makes exactly one of them broadcast.
  // The expiry height rides with the claim. Past it the signed transaction can
  // never be accepted, which is what lets the sweep release a claim left behind
  // by a failure this code could not classify — the alternative was a leg that
  // stayed unfundable until somebody edited the database.
  const claimed = await createDvpTradeRepository(env).claimLegFunding(
    trade.id,
    signature,
    lastValidBlockHeight.toString()
  );
  if (!claimed) {
    throw conflict(`DvP trade ${trade.id}: this leg is already being funded by another request.`);
  }

  // Past this the tokens may have moved, so an approved operation that dies
  // here needs reconciling by hand rather than replaying: a blind retry would
  // over-fund.
  //
  // The fence itself is the exception. It runs before anything is broadcast, so
  // a failure here changed nothing on chain, and keeping the claim would leave
  // the leg permanently unfundable over an error that cost nothing.
  try {
    await beginApprovedWalletOperationEffect(c);
  } catch (error) {
    await createDvpTradeRepository(env).releaseLegFunding(trade.id, signature);
    throw error;
  }

  try {
    await solanaRpc.sendTransaction(rpc, new Uint8Array(getTransactionEncoder().encode(signed)));
  } catch (error) {
    // A preflight rejection never reached the network, so the claim can be
    // released and the leg funded again. Any other failure is ambiguous and
    // KEEPS the claim: releasing it would invite a second transfer on top of
    // one that may yet land.
    if (
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
    ) {
      await createDvpTradeRepository(env).releaseLegFunding(trade.id, signature);
    }
    throw error;
  }

  return { signature, leg: trade.sdpSide, amount: outstanding.toString() };
}
