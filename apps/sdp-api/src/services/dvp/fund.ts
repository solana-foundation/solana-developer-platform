/** Moving one side of a trade into escrow, from the custody wallet that owns that side's party address. */
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
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { readMintDecimals } from "./mints";
import { readEscrowState } from "./read-chain";

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
 * One leg of a trade by side, with no claim about who holds it.
 *
 * This answers "what is leg B", which is the question a party funding its own
 * leg has: each side names an address, and the custody lookup decides who may
 * pay it — nothing on the leg itself does.
 *
 * @param trade - The trade to read the leg from.
 * @param side - Which leg, by side.
 * @returns That leg's mint, token program, escrow address and target amount.
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
 * How much of one leg is still outstanding, per the chain right now.
 *
 * Exported for the policy extractor: an approver has to be shown the amount
 * that will actually move, and funding sends the shortfall rather than the
 * target. Returns 0n for a leg that is already at or above its target.
 *
 * @param env - API process environment, for the RPC.
 * @param trade - The trade whose leg is being funded.
 * @param side - Which leg to read, by side.
 * @returns The outstanding base-unit amount, never negative.
 */
export async function readDvpLegShortfall(
  env: Env,
  trade: DvpTradeRow,
  side: DvpTradeSide
): Promise<bigint> {
  const leg = legOfSide(trade, side);
  const state = await readEscrowState(solanaRpc.createRpc(env), leg.escrow, leg.tokenProgram);
  const held = state?.amount ?? 0n;
  return held >= leg.amount ? 0n : leg.amount - held;
}

/**
 * Who signs a funding transfer, and where its lock lives.
 *
 * One plan shape for every funder — the creating organization funding the leg
 * its wallet is named on and a counterparty funding theirs run the SAME code
 * from the escrow read to the receipt. Every safety property below — the
 * pre-read, the shortfall, the frozen refusal, the re-read before signing, the
 * claim, the approval fence, the ambiguous-failure rule — is identical for
 * both, and none of it is specific to who is paying. Two copies would be two
 * places for those to drift.
 */
export interface DvpFundingPlan {
  leg: DvpSdpLeg;
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
 * The funding plan for one side of a trade: that side's leg, the funder's
 * wallet, and a claim on `dvp_leg_funding_claims` keyed (trade, side) and
 * owned by the FUNDING organization.
 *
 * The lock lives on the claims table, keyed by (trade, side) and owned by the
 * funding organization, so two parties funding opposite legs cannot collide
 * and no cross-organization write is needed — the creating org funding its
 * own leg and a counterparty funding theirs take DIFFERENT rows on the same
 * table, never the same lock.
 *
 * @param env - API process environment, for the database.
 * @param trade - The trade whose leg is being funded.
 * @param side - Which leg, by side.
 * @param signer - Whose wallet pays: the funding organization's own custody
 *   wallet, resolved by the caller from the side's party address.
 * @returns The plan `executeDvpFunding` runs.
 */
export function fundingPlan(
  env: Env,
  trade: DvpTradeRow,
  side: DvpTradeSide,
  signer: { organizationId: string; projectId: string; custodyWalletId: string }
): DvpFundingPlan {
  const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
  return {
    leg: legOfSide(trade, side),
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
 * Funds one side of a trade from the custody wallet that owns that side's
 * party address.
 *
 * Mechanical by design: the authorization decision — resolving the funding
 * wallet through the custody lookup and re-reading it from the database
 * before broadcast — belongs to the caller (the policy extractor and the
 * handler), because it has to happen at the right point relative to the gate.
 * This function takes the already-resolved wallet and moves the shortfall.
 *
 * @param c - Request context, for the approved-operation effect fence.
 * @param trade - The trade whose leg should be funded.
 * @param params - Which side, and the funding organization's custody wallet.
 * @param params.side - The leg being funded, by side.
 * @param params.custodyWalletId - The funding wallet's custody record id.
 * @param params.organizationId - The funding organization.
 * @param params.projectId - The funding organization's project.
 * @returns The broadcast signature and what moved.
 */
export async function fundDvpTradeLeg(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  params: {
    side: DvpTradeSide;
    custodyWalletId: string;
    organizationId: string;
    projectId: string;
  }
): Promise<DvpFundResult> {
  return executeDvpFunding(
    c,
    trade,
    fundingPlan(c.env, trade, params.side, {
      organizationId: params.organizationId,
      projectId: params.projectId,
      custodyWalletId: params.custodyWalletId,
    })
  );
}

/**
 * Reads the escrow, sends the shortfall, and records what happened.
 *
 * Shared by every funder. The plan decides which leg, who signs and where the
 * lock lives; nothing below asks who is paying.
 *
 * @param c - Request context, for the approved-operation effect fence.
 * @param trade - The trade being funded, for its status.
 * @param plan - Which leg, whose wallet, and the claim that serialises it.
 * @returns The broadcast signature, which leg moved, and how much.
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
