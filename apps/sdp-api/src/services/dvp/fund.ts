/** Moving one side of a trade into escrow, from the custody wallet that owns that side's party address. */

import { decodeSwapDvpChecked, SwapDvpVerificationError, verifySwapDvpAccount } from "@sdp/dvp";
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
import { getDb } from "@/db";
import type { DvpTradeRow, DvpTradeSide, DvpTradeStatus } from "@/db/repositories";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { badRequest, conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { readMintDecimals } from "./mints";
import { readDvpAccounts, readEscrowState } from "./read-chain";

/** Statuses from which a leg can still be funded. */
const FUNDABLE: ReadonlySet<DvpTradeStatus> = new Set(["created", "partially_funded"]);

export interface DvpFundResult {
  signature: Signature;
  /** Which leg was funded, and how much moved. */
  leg: "a" | "b";
  amount: string;
}

/** The addresses and target for one leg of a trade. */
interface DvpSdpLeg {
  /** Which leg it is, carried out of the null check so callers need not redo it. */
  side: DvpTradeSide;
  mint: Address;
  tokenProgram: Address;
  escrow: Address;
  amount: bigint;
}

/**
 * One leg of a trade by side; the custody lookup decides who may fund it.
 */
export function legOfSide(trade: DvpTradeRow, side: DvpTradeSide): DvpSdpLeg {
  const isA = side === "a";
  return {
    side,
    mint: isA ? trade.mintA : trade.mintB,
    tokenProgram: isA ? trade.tokenProgramA : trade.tokenProgramB,
    escrow: isA ? trade.escrowA : trade.escrowB,
    amount: BigInt(isA ? trade.amountA : trade.amountB),
  };
}

/**
 * The outstanding base-unit shortfall of one leg, per the chain now. Exported
 * for the policy extractor — the approver is shown what will actually move.
 */
export async function readDvpLegShortfall(
  env: Env,
  trade: DvpTradeRow,
  side: DvpTradeSide
): Promise<bigint> {
  const leg = legOfSide(trade, side);
  const state = await readEscrowState(solanaRpc.createRpc(env), leg, trade.swapDvp);
  if (state === null) {
    throw conflict(`DvP trade ${trade.id}: the escrow for this leg is missing; nothing was sent`);
  }
  const held = state.amount;
  return held >= leg.amount ? 0n : leg.amount - held;
}

/**
 * Who signs a funding transfer, and where its lock lives. One plan shape for
 * every funder — creator and counterparty run the same safety properties, so
 * they cannot drift apart.
 */
export interface DvpFundingPlan {
  leg: DvpSdpLeg;
  /** Maximum shortfall authorized by policy for this execution. */
  approvedAmount: bigint;
  /** Whose wallet signs and pays. Not necessarily the trade's author. */
  signer: { organizationId: string; projectId: string; custodyWalletId: string };
  /** Takes the lock on this leg. False when somebody else already holds it. */
  claim(signature: Signature, expiryHeight: string): Promise<boolean>;
  /** Gives it back, when and only when nothing was broadcast. */
  release(signature: Signature): Promise<void>;
  /** Records the transfer once it is on the wire. */
  recordFundingTx(signature: Signature): Promise<void>;
}

/**
 * The funding plan for one side of a trade: leg, funder's wallet, and a claim
 * on `dvp_leg_funding_claims` keyed (trade, side) and owned by the FUNDING
 * org — opposite legs are different rows, so they never share a lock.
 */
export function fundingPlan(
  env: Env,
  trade: DvpTradeRow,
  side: DvpTradeSide,
  approvedAmount: bigint,
  signer: { organizationId: string; projectId: string; custodyWalletId: string }
): DvpFundingPlan {
  const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
  return {
    leg: legOfSide(trade, side),
    approvedAmount,
    signer,
    claim: (signature, expiryHeight) =>
      claims.claim({
        tradeId: trade.id,
        side,
        organizationId: signer.organizationId,
        projectId: signer.projectId,
        custodyWalletId: signer.custodyWalletId,
        signature,
        expiryHeight,
      }),
    release: (signature) => claims.release(trade.id, side, signature),
    recordFundingTx: (signature) => claims.recordFundingTx(trade.id, side, signature),
  };
}

/**
 * Funds one side from the caller's already-resolved custody wallet. Mechanical
 * by design: the custody lookup and re-read belong to the caller, so they run
 * at the right point relative to the policy gate.
 */
export async function fundDvpTradeLeg(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  params: {
    side: DvpTradeSide;
    custodyWalletId: string;
    organizationId: string;
    projectId: string;
    approvedAmount: bigint;
  }
): Promise<DvpFundResult> {
  return executeDvpFunding(
    c,
    trade,
    fundingPlan(c.env, trade, params.side, params.approvedAmount, {
      organizationId: params.organizationId,
      projectId: params.projectId,
      custodyWalletId: params.custodyWalletId,
    })
  );
}

/**
 * Reads the escrow, sends the shortfall, and records what happened.
 *
 * Shared by every funder; nothing below asks who is paying.
 */
export async function executeDvpFunding(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  plan: DvpFundingPlan
): Promise<DvpFundResult> {
  const env = c.env;

  if (!FUNDABLE.has(trade.status)) {
    throw badRequest(`DvP trade ${trade.id} is ${trade.status} and can no longer be funded`);
  }

  const { side, mint, tokenProgram, escrow, amount } = plan.leg;

  const rpc = solanaRpc.createRpc(env);

  // Read the escrow NOW rather than trusting the reconciler's last sweep. The
  // sweep runs once a minute, so acting on it would let two funding requests a
  // few seconds apart both believe the escrow was empty.
  const snapshot = await readDvpAccounts(rpc, trade.swapDvp, {
    a: {
      escrow: trade.escrowA,
      tokenProgram: trade.tokenProgramA,
      mint: trade.mintA,
    },
    b: {
      escrow: trade.escrowB,
      tokenProgram: trade.tokenProgramB,
      mint: trade.mintB,
    },
  });

  try {
    await verifySwapDvpAccount(snapshot.trade);
  } catch (error) {
    if (error instanceof SwapDvpVerificationError) {
      throw conflict(`DvP trade ${trade.id}: the trade is no longer on chain; nothing was sent`);
    }
    throw error;
  }

  const onChain = decodeSwapDvpChecked(snapshot.trade).data;
  const recorded = {
    userA: trade.userA,
    userB: trade.userB,
    mintA: trade.mintA,
    mintB: trade.mintB,
    amountA: BigInt(trade.amountA),
    amountB: BigInt(trade.amountB),
    expiryTimestamp: BigInt(trade.expiryTimestamp),
    userASettlementDestination: trade.userASettlementDestination,
    userBSettlementDestination: trade.userBSettlementDestination,
    settlementAuthority: trade.settlementAuthority,
  };
  const live = {
    userA: onChain.userA,
    userB: onChain.userB,
    mintA: onChain.mintA,
    mintB: onChain.mintB,
    amountA: onChain.amountA,
    amountB: onChain.amountB,
    expiryTimestamp: onChain.expiryTimestamp,
    userASettlementDestination: onChain.userASettlementDestination,
    userBSettlementDestination: onChain.userBSettlementDestination,
    settlementAuthority: onChain.settlementAuthority,
  };
  const mismatched = (Object.keys(recorded) as (keyof typeof recorded)[]).filter(
    (term) => live[term] !== recorded[term]
  );
  if (mismatched.length > 0) {
    getLogger().warn(
      { tradeId: trade.id, swapDvp: trade.swapDvp, mismatched, recorded, onChain: live },
      "dvp funding: on-chain trade does not match recorded terms"
    );
    throw conflict(
      `DvP trade ${trade.id}: the on-chain trade does not match the recorded terms; nothing was sent`
    );
  }

  const legObservation = side === "a" ? snapshot.legA : snapshot.legB;
  if (!legObservation.exists) {
    throw conflict(`DvP trade ${trade.id}: the escrow for this leg is missing; nothing was sent`);
  }
  const escrowState = { amount: legObservation.amount, frozen: legObservation.frozen };

  if (escrowState.frozen) {
    // The transfer would bounce. Saying so costs nothing; learning it from a
    // failed broadcast costs a signature and leaves an unexplained failure.
    throw badRequest(
      `DvP trade ${trade.id}: the escrow for this leg is frozen, so a transfer into it would fail. The mint's freeze authority must thaw ${escrow} first.`
    );
  }

  const held = escrowState.amount;
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
  if (outstanding > plan.approvedAmount) {
    throw conflict(
      `DvP trade ${trade.id}: the shortfall grew to ${outstanding} after approval for ${plan.approvedAmount}; re-authorize`
    );
  }

  const signer = await createOrgSignerForCustodyWallet(
    env,
    plan.signer.organizationId,
    plan.signer.projectId,
    plan.signer.custodyWalletId
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
  const recheck = await readEscrowState(rpc, plan.leg, trade.swapDvp);
  if (recheck === null) {
    throw conflict(`DvP trade ${trade.id}: the escrow for this leg is missing; nothing was sent`);
  }
  if (recheck.amount !== held) {
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
  const claimed = await plan.claim(signature, lastValidBlockHeight.toString());
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
    await plan.release(signature);
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
      await plan.release(signature);
    }
    throw error;
  }

  // On the wire, so the receipt is owed regardless of what the claim does next.
  // The claim is released on a rejected broadcast and swept once its blockhash
  // expires; a leg that funded correctly ends up with no claim at all, which is
  // why this cannot be the same column.
  await plan.recordFundingTx(signature);

  return { signature, leg: side, amount: outstanding.toString() };
}
