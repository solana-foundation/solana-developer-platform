import { FeePaymentError } from "@sdp/fee-payment/port";
import { hashString } from "@sdp/payments/hash";
import { createClusterRpc } from "@sdp/rpc/factory";
import { getRecentBlockhash } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { badRequest, rateLimited } from "@/lib/errors";
import { buildSplTransferInstructions } from "@/routes/payments/token-accounts";
import { AuditService } from "@/services/audit.service";
import { isPaymentRequestExpired } from "@/services/payments/payment-requests";
import { loadPaymentMint } from "@/services/payments/token-amount";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
  type SponsorshipFeePayment,
} from "@/services/sponsorship.service";
import { sponsoredMessageDigest } from "@/services/sponsorship-budget.service";
import type { Env } from "@/types/env";

/** A payment request whose Project is known: the only kind `/pay` sponsors. */
export type PayablePaymentRequest = PaymentRequestRow & { project_id: string };

/**
 * What a payer scanning a payment request gets: the sponsored transaction to sign, or how long
 * another payer's live claim on the request still holds.
 */
const sponsoredPaymentTransactionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed"), transaction: z.string() }),
  z.object({ kind: z.literal("held"), retryAfterSeconds: z.number().int().positive() }),
]);

export type SponsoredPaymentTransaction = z.infer<typeof sponsoredPaymentTransactionSchema>;

function assertNotExpired(request: PaymentRequestRow): void {
  if (isPaymentRequestExpired(request.expires_at)) {
    throw badRequest("Payment request is no longer payable");
  }
}

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
 * @returns The partially signed transaction, or the hold another payer's live claim places.
 * @throws AppError `RATE_LIMITED` when the claim is lost with no live claim to serve, or a
 *   concurrent claim superseded this one.
 * @throws AppError `BAD_REQUEST` when the payer is the sponsor or a SOL amount is not positive.
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
    assertNotExpired(request);
    if (claim.account !== payer) {
      const retryAfterSeconds = Math.ceil(
        Number(claim.lastValidBlockHeight - currentBlockHeight) * 0.4
      );
      return { kind: "held", retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
    }
    // Check the saved fee payer, including across sponsor rotations, before
    // signing an old claim or replaying bytes signed before this admission rule.
    assertSavedPayerIsNotSponsor(payer, claim.unsignedTransaction);
    if (claim.signedTransaction !== null) {
      return { kind: "signed", transaction: claim.signedTransaction };
    }
    return signAndStore(claim.unsignedTransaction);
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

  const signAndStore = async (unsignedBase64: string): Promise<SponsoredPaymentTransaction> => {
    assertNotExpired(request);
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
    // /pay bytes are partially signed by design: the payer signs client-side.
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(sponsored));
    const signedBase64 = getBase64Decoder().decode(sponsored);
    await auditService.completeCritical(c, auditIntent, { metadata: { signature } });
    const stored = await repository.storeSponsoredTransactionSignature({
      requestId: request.id,
      account: payer,
      unsignedTransaction: unsignedBase64,
      signedTransaction: signedBase64,
    });
    if (!stored) {
      const superseding = await repository.getSponsoredTransactionClaim(request.id);
      const heightNow = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      if (
        superseding !== null &&
        superseding.lastValidBlockHeight >= heightNow &&
        superseding.account === payer &&
        superseding.signedTransaction !== null
      ) {
        assertNotExpired(request);
        assertSavedPayerIsNotSponsor(payer, superseding.unsignedTransaction);
        return { kind: "signed", transaction: superseding.signedTransaction };
      }
      throw rateLimited("This payment request's sponsored transaction was superseded; retry");
    }
    return { kind: "signed", transaction: signedBase64 };
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
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const unsignedBase64 = await buildPaymentTransaction({
    ...params,
    feePayer,
    blockhash,
    lastValidBlockHeight,
  });

  const claimed = await repository.claimSponsoredTransactionWindow({
    requestId: request.id,
    account: payer,
    unsignedTransaction: unsignedBase64,
    lastValidBlockHeight,
    currentBlockHeight,
  });
  if (!claimed) {
    assertNotExpired(request);
    const winner = await serveLiveClaim();
    if (winner) {
      return winner;
    }
    throw rateLimited("Another payer holds this payment request's sponsored transaction");
  }

  return signAndStore(unsignedBase64);
}

/**
 * Compile the unsigned transfer a payment request asks for, with the request's reference account
 * on the transfer instruction so the payment can be found on chain.
 *
 * @param rpc - Solana RPC, for the SPL destination account lookup.
 * @param params - The transfer and its lifetime.
 * @param params.request - The payment request: token and amount.
 * @param params.payer - The account that pays and signs client-side.
 * @param params.recipient - The request's destination address.
 * @param params.reference - The request's Solana Pay reference account.
 * @param params.feePayer - The sponsor, which also pays a missing destination token account's rent.
 * @param params.blockhash - The lifetime blockhash.
 * @param params.lastValidBlockHeight - The block height the blockhash expires after.
 * @returns The compiled, unsigned transaction as base64.
 * @throws AppError `BAD_REQUEST` when a SOL request's amount is not positive.
 */
async function buildPaymentTransaction(params: {
  request: PaymentRequestRow;
  payer: Address;
  recipient: Address;
  reference: Address;
  feePayer: Address;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}): Promise<string> {
  const { request, recipient, reference, feePayer, blockhash, lastValidBlockHeight } = params;
  const withReference = (instruction: Instruction & { accounts: readonly AccountMeta[] }) => ({
    ...instruction,
    accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
  });
  const payerSigner = createNoopSigner(params.payer);

  let instructions: Instruction[];
  if (request.token === SOL_MINT) {
    const lamports = (await loadPaymentMint(address(SOL_MINT))).toBaseUnits(request.amount);
    if (lamports <= 0n) {
      throw badRequest("Transfer amount must be greater than zero");
    }
    const transferInstruction = getTransferSolInstruction({
      source: payerSigner,
      destination: recipient,
      amount: lamports,
    });
    instructions = [withReference(transferInstruction)];
  } else {
    const { createDestinationAtaInstruction, transferInstruction } =
      await buildSplTransferInstructions({
        authority: payerSigner,
        destination: recipient,
        mint: assertValidAddress(request.token, "token"),
        amount: request.amount,
        ataRentPayer: feePayer,
      });
    instructions = [createDestinationAtaInstruction, withReference(transferInstruction)];
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const txBytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  return getBase64Decoder().decode(txBytes);
}
