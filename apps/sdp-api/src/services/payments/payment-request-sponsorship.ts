import { hashString } from "@sdp/payments/hash";
import { createClusterRpc } from "@sdp/rpc/factory";
import { getRecentBlockhash, type SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS, SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
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
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
  type SponsorshipFeePayment,
} from "@/services/sponsorship.service";
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
 * @throws AppError `BAD_REQUEST` when a SOL request's amount is not positive.
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
    if (claim.account !== payer) {
      const retryAfterSeconds = Math.ceil(
        Number(claim.lastValidBlockHeight - currentBlockHeight) * 0.4
      );
      return { kind: "held", retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
    }
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
      "payments.pay_request"
    );
    return feePaymentInstance;
  };

  const signAndStore = async (unsignedBase64: string): Promise<SponsoredPaymentTransaction> => {
    const feePayment = await getFeePayment();
    const unsignedBytes = new Uint8Array(getBase64Encoder().encode(unsignedBase64));
    const sponsored = await feePayment.signAsFeePayer(unsignedBytes);
    // /pay bytes are partially signed by design: the payer signs client-side.
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(sponsored));
    const signedBase64 = getBase64Decoder().decode(sponsored);
    await new AuditService(getDb(c.env)).log(c, {
      organizationId: request.organization_id,
      action: "sign",
      resourceType: "payment_request",
      resourceId: request.id,
      metadata: {
        sponsoredAccount: payer,
        amount: request.amount,
        token: request.token,
        destination: request.destination_address,
        walletId: request.wallet_id,
        signature,
        claimHash: await hashString(unsignedBase64),
      },
    });
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
  const [feePayer, { blockhash, lastValidBlockHeight }] = await Promise.all([
    feePayment.getFeePayer(),
    getRecentBlockhash(rpc, "confirmed"),
  ]);
  const unsignedBase64 = await buildPaymentTransaction(rpc, {
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
async function buildPaymentTransaction(
  rpc: SolanaRpc,
  params: {
    request: PaymentRequestRow;
    payer: Address;
    recipient: Address;
    reference: Address;
    feePayer: Address;
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }
): Promise<string> {
  const { request, recipient, reference, feePayer, blockhash, lastValidBlockHeight } = params;
  const withReference = (instruction: Instruction & { accounts: readonly AccountMeta[] }) => ({
    ...instruction,
    accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
  });
  const payerSigner = createNoopSigner(params.payer);

  let instructions: Instruction[];
  if (request.token === SOL_MINT) {
    const lamports = parseDecimalAmount(request.amount, SOL_DECIMALS);
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
      await buildSplTransferInstructions(rpc, {
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
