import { FeePaymentError } from "@sdp/fee-payment/port";
import { hashString } from "@sdp/payments/hash";
import { createClusterRpc } from "@sdp/rpc/factory";
import { getRecentBlockhash } from "@sdp/rpc/solana";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import {
  type RecordedLegQuote,
  recordedLegQuote,
} from "@/db/repositories/token-movement-legs.repository";
import { badRequest, rateLimited } from "@/lib/errors";
import { AuditService } from "@/services/audit.service";
import {
  assertPlanMeetsExpectation,
  paymentRequestPayment,
} from "@/services/payments/payment-requests";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
  type SponsorshipFeePayment,
} from "@/services/sponsorship.service";
import { sponsoredMessageDigest } from "@/services/sponsorship-budget.service";
import {
  buildPlannedPaymentRequestLeg,
  type PlannedLeg,
  type PlannedTokenMovement,
  planTokenMovement,
} from "@/services/token-movement/build";
import type { Env } from "@/types/env";

/** A payment request whose Project is known: the only kind `/pay` sponsors. */
export type PayablePaymentRequest = PaymentRequestRow & { project_id: string };

/**
 * What a payer scanning a payment request gets: the sponsored transaction to sign with the quote
 * it moves, or how long another payer's live claim on the request still holds.
 */
const sponsoredPaymentTransactionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("signed"),
    transaction: z.string(),
    // Built in memory from the quote this request's window recorded; the
    // ledger's own columns and checks are its validation.
    quote: z.custom<RecordedLegQuote>(),
  }),
  z.object({ kind: z.literal("held"), retryAfterSeconds: z.number().int().positive() }),
]);

export type SponsoredPaymentTransaction = z.infer<typeof sponsoredPaymentTransactionSchema>;

/** Saved claims retain their original sponsor even after the configured signer rotates. */
function assertSavedPayerIsNotSponsor(payer: Address, unsignedBase64: string): void {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(unsignedBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (payer === message.staticAccounts[0]) {
    throw badRequest("Payment payer cannot be the fee sponsor");
  }
}

/**
 * Issue the fee-sponsored transaction a payer signs to settle a payment request. One sponsored
 * transaction per blockhash window, claimed on the request row. Everyone who scans while a claim
 * is live gets the claimed payer's candidate back, or a hold; a claim is never released early
 * because a signed transaction is a bearer instrument until its blockhash expires, and two live
 * ones would double the sponsor's exposure.
 *
 * @param c - The request context, under the payment request's cluster scope (it builds and reads
 *   on that cluster), for the bindings and the sponsor-signature audit entry.
 * @param params - The payable request and the parties to the transfer.
 * @param params.request - The reconciled, payable payment request; its Project sponsors.
 * @param params.payer - The account that pays and signs client-side.
 * @param params.recipient - The request's destination address.
 * @param params.reference - The request's Solana Pay reference account.
 * @returns The partially signed transaction and its quote, or the hold another payer's live claim
 *   places. A live claim the previous revision made has no issued record to settle by, so it is
 *   held until it expires.
 * @throws AppError `RATE_LIMITED` when the claim is lost with no live claim to serve, or a
 *   concurrent claim superseded this one.
 * @throws AppError `BAD_REQUEST` when the payer is the sponsor, or the token movement is refused
 *   (an unsupported mint, a missing payer token account, a mint changed since creation).
 */
export async function issuePaymentRequestTransaction(
  c: Context<{ Bindings: Env }>,
  params: {
    request: PayablePaymentRequest;
    payer: Address;
    recipient: Address;
    reference: Address;
  }
): Promise<SponsoredPaymentTransaction> {
  const { request, payer } = params;
  const repository = createSystemPaymentRequestsRepository(c.env);
  const rpc = createClusterRpc();
  const currentBlockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();

  const serveLiveClaim = async (): Promise<SponsoredPaymentTransaction | null> => {
    const claim = await repository.getSponsoredTransactionClaim(request.id);
    if (claim === null || claim.lastValidBlockHeight < currentBlockHeight) {
      return null;
    }
    if (claim.account !== payer || claim.issued === null) {
      const retryAfterSeconds = Math.ceil(
        Number(claim.lastValidBlockHeight - currentBlockHeight) * 0.4
      );
      return { kind: "held", retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
    }
    // Check the saved fee payer, including across sponsor rotations, before
    // signing an old claim or replaying bytes signed before this admission rule.
    assertSavedPayerIsNotSponsor(payer, claim.unsignedTransaction);
    if (claim.signedTransaction !== null) {
      return { kind: "signed", transaction: claim.signedTransaction, quote: claim.issued.quote };
    }
    return signAndStore(claim.unsignedTransaction, claim.issued.quote);
  };

  let feePaymentInstance: SponsorshipFeePayment | null = null;
  const getFeePayment = async () => {
    feePaymentInstance ??= createSponsorshipFeePayment(
      c.env,
      await resolveProjectSponsorshipScope(c.env, {
        organizationId: request.organization_id,
        projectId: request.project_id,
        actor: { type: "wallet", id: request.wallet_id },
      }),
      "payments.pay_request",
      // No custody wallet signs a `/pay` transaction: the payer signs it.
      { custodyWalletId: null }
    );
    return feePaymentInstance;
  };

  const signAndStore = async (
    unsignedBase64: string,
    quote: RecordedLegQuote
  ): Promise<SponsoredPaymentTransaction> => {
    const feePayment = await getFeePayment();
    const unsignedBytes = new Uint8Array(getBase64Encoder().encode(unsignedBase64));
    // The intent is durable before signAsFeePayer reserves budget and Kora
    // signs, so no reservation can exist without its audit record.
    const auditService = new AuditService(getDb(c.env));
    const auditIntent = await auditService.beginCritical(c, {
      organizationId: request.organization_id,
      action: "sign",
      resourceType: "payment_request",
      resourceId: request.id,
      metadata: {
        organizationId: request.organization_id,
        projectId: request.project_id,
        sponsoredAccount: payer,
        amount: request.amount,
        debit: quote.quoted.debit.toString(),
        transferFee: quote.quoted.fee.toString(),
        // Named tokenMint: a bare "token" key is scrubbed as a credential by
        // the audit redaction policy, and a mint address is not a secret.
        tokenMint: request.token,
        destination: request.destination_address,
        walletId: request.wallet_id,
        transactionDigest: sponsoredMessageDigest(
          getTransactionDecoder().decode(unsignedBytes).messageBytes
        ),
        claimHash: await hashString(unsignedBase64),
      },
    });
    let sponsored: Uint8Array;
    try {
      sponsored = await feePayment.signAsFeePayer(unsignedBytes);
    } catch (error) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        // A code, never the message: Kora and RPC error text can carry provider context the
        // audit scrubber does not decode.
        metadata: {
          errorCode: error instanceof FeePaymentError ? error.code : "UNCLASSIFIED_ERROR",
        },
      });
      throw error;
    }
    // /pay bytes are partially signed by design: the payer signs client-side. The sponsor, the
    // fee payer, signs first, so its signature is the transaction id settlement reads.
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(sponsored));
    const signedBase64 = getBase64Decoder().decode(sponsored);
    await auditService.completeCritical(c, auditIntent, { metadata: { signature } });
    const stored = await repository.storeSponsoredTransactionSignature({
      requestId: request.id,
      account: payer,
      unsignedTransaction: unsignedBase64,
      signedTransaction: signedBase64,
      signature,
    });
    if (!stored) {
      const superseding = await repository.getSponsoredTransactionClaim(request.id);
      const heightNow = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      if (
        superseding !== null &&
        superseding.lastValidBlockHeight >= heightNow &&
        superseding.account === payer &&
        superseding.signedTransaction !== null &&
        superseding.issued !== null
      ) {
        assertSavedPayerIsNotSponsor(payer, superseding.unsignedTransaction);
        return {
          kind: "signed",
          transaction: superseding.signedTransaction,
          quote: superseding.issued.quote,
        };
      }
      throw rateLimited("This payment request's sponsored transaction was superseded; retry");
    }
    return { kind: "signed", transaction: signedBase64, quote };
  };

  const served = await serveLiveClaim();
  if (served) {
    return served;
  }

  const feePayment = await getFeePayment();
  const feePayer = await feePayment.getFeePayer();
  if (payer === feePayer) {
    throw badRequest("Payment payer cannot be the fee sponsor");
  }
  const { plan, leg } = await planPaymentRequestTransfer(request, payer, params.recipient);
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const unsignedBase64 = compilePaymentTransaction({
    plan,
    leg,
    payer,
    reference: params.reference,
    feePayer,
    blockhash,
    lastValidBlockHeight,
  });
  const quote = recordedLegQuote(leg.quote);

  const claimed = await repository.claimSponsoredTransactionWindow({
    requestId: request.id,
    account: payer,
    unsignedTransaction: unsignedBase64,
    lastValidBlockHeight,
    currentBlockHeight,
    quote,
  });
  if (!claimed) {
    const winner = await serveLiveClaim();
    if (winner) {
      return winner;
    }
    throw rateLimited("Another payer holds this payment request's sponsored transaction");
  }

  return signAndStore(unsignedBase64, quote);
}

/**
 * Plans the transfer a payer signs for a payment request (ADR 0012): the request's credit,
 * quoted as a credit under the terms read now, so the payer pays the current transfer fee and
 * the destination gets exactly the credit; from the payer's largest token account of the mint.
 * Native SOL is a system transfer.
 *
 * RPC budget (before → now): a token mint's owner read and the payer's token accounts → the
 * mint, the Clock and the destination token account in one `getMultipleAccounts`, beside the
 * payer's token accounts (at once for a catalogue mint); a hook mint adds its validation account
 * and any extra account read from data; a frozen-by-default Token ACL mint whose destination
 * account the payment creates adds its config and its gate's thaw list, and the payer signs the
 * thaw. Native SOL: none → none.
 *
 * @throws AppError (400) when the movement is refused, or no longer meets the expectation.
 */
async function planPaymentRequestTransfer(
  request: PaymentRequestRow,
  payer: Address,
  recipient: Address
): Promise<{ plan: PlannedTokenMovement; leg: PlannedLeg }> {
  const payment = paymentRequestPayment(request);
  const plan = await planTokenMovement({
    asset: payment.asset,
    basis: "credit",
    source: payer,
    destinations: [{ owner: recipient, amount: payment.amount }],
    memo: null,
  });
  assertPlanMeetsExpectation(plan, payment.expectation);
  const [leg] = plan.legs;
  if (leg === undefined) {
    throw badRequest("Payment request transfer has no destination");
  }
  return { plan, leg };
}

/**
 * Compiles the unsigned transfer a payment request asks for, built by `buildTokenMovement` with
 * the request's Solana Pay reference on the transfer instruction.
 *
 * @returns The compiled, unsigned transaction as base64.
 */
function compilePaymentTransaction(params: {
  plan: PlannedTokenMovement;
  leg: PlannedLeg;
  payer: Address;
  reference: Address;
  feePayer: Address;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}): string {
  const { feePayer, blockhash, lastValidBlockHeight } = params;
  const instructions = buildPlannedPaymentRequestLeg(params.plan, params.leg, {
    payer: params.payer,
    feePayer,
    reference: params.reference,
  });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const txBytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  return getBase64Decoder().decode(txBytes);
}
