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

  const sdpLegIsA = trade.sdpSide === "a";
  const mint = (sdpLegIsA ? trade.mintA : trade.mintB) as Address;
  const tokenProgram = (sdpLegIsA ? trade.tokenProgramA : trade.tokenProgramB) as Address;
  const escrow = (sdpLegIsA ? trade.escrowA : trade.escrowB) as Address;
  const amount = BigInt(sdpLegIsA ? trade.amountA : trade.amountB);

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

  // The balance read above and this transfer are not atomic, so two overlapping
  // requests would both see the same shortfall and both send. The claim is what
  // makes exactly one of them broadcast.
  const claimed = await createDvpTradeRepository(env).claimLegFunding(trade.id, signature);
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
