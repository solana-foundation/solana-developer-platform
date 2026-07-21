import { createFeePaymentAdapter } from "@sdp/payments/fee-payment";
import { getSolanaConfig } from "@sdp/rpc";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { getSdpDocsOrigin, WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  type AccountMeta,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
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
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { badRequest, notFound } from "@/lib/errors";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";
import {
  buildSplTransferInstructions,
  resolveTokenLabel,
  SOL_MINT,
} from "./payments/token-accounts";

const REQUEST_LABEL = "Solana Developer Platform";
const REQUEST_ICON = `${getSdpDocsOrigin()}/icon.svg`;

const transactionRequestBodySchema = z.object({ account: z.string() });

const pay = new Hono<{ Bindings: Env }>();

pay.get("/:token", async (c) => {
  const existing = await createPaymentRequestsRepository(c.env).getPaymentRequestByPublicToken(
    c.req.param("token")
  );
  if (!existing) {
    throw notFound("Payment request");
  }
  const request = await reconcilePaymentRequest(c.env, existing, { bestEffort: true });

  const expired = isPaymentRequestExpired(request.expires_at);
  const status = expired && request.status === "awaiting_payment" ? "expired" : request.status;
  const payable = status === "awaiting_payment";

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

pay.post("/:token/tx", async (c) => {
  const existing = await createPaymentRequestsRepository(c.env).getPaymentRequestByPublicToken(
    c.req.param("token")
  );
  if (!existing) {
    throw notFound("Payment request");
  }
  const request = await reconcilePaymentRequest(c.env, existing, { bestEffort: false });
  if (request.status !== "awaiting_payment" || isPaymentRequestExpired(request.expires_at)) {
    throw badRequest("Payment request is no longer payable");
  }

  const body = transactionRequestBodySchema.safeParse(await c.req.json());
  if (!body.success) {
    throw badRequest("account is required");
  }
  const payer = assertValidAddress(body.data.account, "account");
  const recipient = assertValidAddress(request.destination_address, "destinationAddress");
  const reference = assertValidAddress(request.reference, "reference");
  const withReference = (instruction: Instruction & { accounts: readonly AccountMeta[] }) => ({
    ...instruction,
    accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
  });

  const payerSigner = createNoopSigner(payer);
  const rpc = solanaRpc.createRpc(c.env);
  const feePayment = createFeePaymentAdapter(c.env);
  const [feePayer, { blockhash, lastValidBlockHeight }] = await Promise.all([
    feePayment.getFeePayer(),
    solanaRpc.getRecentBlockhash(rpc, "confirmed"),
  ]);

  let instructions: Instruction[];
  if (request.token === SOL_MINT) {
    const lamports = parseDecimalAmount(request.amount, WELL_KNOWN_TOKENS.SOL.decimals);
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
  const sponsored = await feePayment.signAsFeePayer(txBytes);

  return c.json({
    transaction: getBase64Decoder().decode(sponsored),
    message: `Pay ${request.amount} ${resolveTokenLabel(request.token)} to ${REQUEST_LABEL}`,
  });
});

export default pay;
