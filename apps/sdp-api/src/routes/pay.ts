import { getSolanaConfig } from "@sdp/rpc";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { getSdpDocsOrigin, SOL_DECIMALS } from "@sdp/types";
import {
  type AccountMeta,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { encodeURL } from "@solana/pay";
import { getTransferSolInstruction } from "@solana-program/system";
import { Hono } from "hono";
import { z } from "zod";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { badRequest, notFound, rateLimited } from "@/lib/errors";
import { type ValidatedBodyContext, validateBody } from "@/middleware/validate";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";
import { solanaAddressSchema } from "./payments/schemas";
import {
  buildSplTransferInstructions,
  resolveTokenLabel,
  SOL_MINT,
} from "./payments/token-accounts";

const REQUEST_LABEL = "Solana Developer Platform";
const REQUEST_ICON = `${getSdpDocsOrigin()}/icon.svg`;

const transactionRequestBodySchema = z.object({ account: solanaAddressSchema("account") });

const pay = new Hono<{ Bindings: Env }>();

pay.get("/:token", async (c) => {
  const existing = await createSystemPaymentRequestsRepository(
    c.env
  ).getPaymentRequestByPublicToken(c.req.param("token"));
  if (!existing) {
    throw notFound("Payment request");
  }
  const request = await reconcilePaymentRequest(c.env, existing, { bestEffort: true });

  const expired = isPaymentRequestExpired(request.expires_at);
  const status = expired && request.status === "awaiting_payment" ? "expired" : request.status;
  const payable = status === "awaiting_payment" && request.custody_wallet_id !== null;

  let solanaPayUrl: string | null = null;
  if (payable) {
    const link = new URL(`/pay/${c.req.param("token")}/tx`, c.req.url);
    link.protocol = "https:";
    solanaPayUrl = encodeURL({ link }).toString();
  }

  return c.json({
    amount: request.amount,
    token: request.token,
    tokenSymbol: resolveTokenLabel(request.token),
    recipient: request.destination_address,
    reference: request.reference,
    status,
    expiresAt: request.expires_at,
    network: getSolanaConfig(c.env).network,
    solanaPayUrl,
  });
});

pay.get("/:token/tx", (c) => {
  return c.json({ label: REQUEST_LABEL, icon: REQUEST_ICON });
});

pay.post(
  "/:token/tx",
  validateBody(transactionRequestBodySchema),
  async (c: ValidatedBodyContext<typeof transactionRequestBodySchema>) => {
    const { token } = c.req.param();

    const repository = createSystemPaymentRequestsRepository(c.env);
    const existing = await repository.getPaymentRequestByPublicToken(token);
    if (!existing) {
      throw notFound("Payment request");
    }
    const request = await reconcilePaymentRequest(c.env, existing, { bestEffort: false });
    if (request.status !== "awaiting_payment" || isPaymentRequestExpired(request.expires_at)) {
      throw badRequest("Payment request is no longer payable");
    }
    if (!request.project_id) {
      throw badRequest("Payment request is not eligible for sponsored fees");
    }

    const payer = assertValidAddress(c.req.valid("json").account, "account");
    const recipient = assertValidAddress(request.destination_address, "destinationAddress");
    const reference = assertValidAddress(request.reference, "reference");

    const rpc = solanaRpc.createRpc(c.env);
    const currentBlockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();

    // One sponsored transaction per blockhash window, claimed on the request
    // row. Everyone who scans while a claim is live gets the claimed payer's
    // candidate back, or a Retry-After; a claim is never released early
    // because a signed transaction is a bearer instrument until its blockhash
    // expires, and two live ones would double the sponsor's exposure.
    const respondWithClaim = async (signedTransaction: string) =>
      c.json({
        transaction: signedTransaction,
        message: `Pay ${request.amount} ${resolveTokenLabel(request.token)} to ${REQUEST_LABEL}`,
      });

    const serveLiveClaim = async () => {
      const claim = await repository.getSponsoredTransactionClaim(request.id);
      if (claim === null || claim.lastValidBlockHeight < currentBlockHeight) {
        return null;
      }
      if (claim.account !== payer) {
        const retryAfterSeconds = Math.ceil(
          Number(claim.lastValidBlockHeight - currentBlockHeight) * 0.4
        );
        c.header("Retry-After", String(Math.max(retryAfterSeconds, 1)));
        throw rateLimited("Another payer holds this payment request's sponsored transaction");
      }
      if (claim.signedTransaction !== null) {
        return respondWithClaim(claim.signedTransaction);
      }
      return signAndStore(claim.unsignedTransaction);
    };

    let feePaymentInstance: Awaited<ReturnType<typeof createProjectSponsorshipFeePayment>> | null =
      null;
    const getFeePayment = async () => {
      feePaymentInstance ??= await createProjectSponsorshipFeePayment(c.env, {
        organizationId: request.organization_id,
        projectId: request.project_id as string,
        actor: { type: "wallet", id: request.wallet_id },
      });
      return feePaymentInstance;
    };

    const signAndStore = async (unsignedBase64: string) => {
      const feePayment = await getFeePayment();
      const unsignedBytes = new Uint8Array(getBase64Encoder().encode(unsignedBase64));
      const sponsored = await feePayment.signAsFeePayer(unsignedBytes);
      const signedBase64 = getBase64Decoder().decode(sponsored);
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
          return respondWithClaim(superseding.signedTransaction);
        }
        throw rateLimited("This payment request's sponsored transaction was superseded; retry");
      }
      return respondWithClaim(signedBase64);
    };

    const served = await serveLiveClaim();
    if (served) {
      return served;
    }

    const withReference = (instruction: Instruction & { accounts: readonly AccountMeta[] }) => ({
      ...instruction,
      accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
    });
    const payerSigner = createNoopSigner(payer);
    const feePayment = await getFeePayment();
    const [feePayer, { blockhash, lastValidBlockHeight }] = await Promise.all([
      feePayment.getFeePayer(),
      solanaRpc.getRecentBlockhash(rpc, "confirmed"),
    ]);

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
    const unsignedBase64 = getBase64Decoder().decode(txBytes);

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
);

export default pay;
