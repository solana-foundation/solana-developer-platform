import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { Hono } from "hono";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { parseDecimalAmount } from "@/lib/amount";
import { badRequest, notFound } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import {
  resolveMintDecimals,
  resolveMintTokenProgram,
  resolveTokenLabel,
  SOL_MINT,
} from "./payments/token-accounts";

const REQUEST_LABEL = "Solana Developer Platform";

function appendReference(instruction: Instruction, reference: string): Instruction {
  const existing = instruction.accounts ? instruction.accounts : [];
  return {
    ...instruction,
    accounts: [
      ...existing,
      { address: assertValidAddress(reference, "reference"), role: AccountRole.READONLY },
    ],
  };
}

const pay = new Hono<{ Bindings: Env }>();

// Solana Pay transaction request — the wallet GETs the label to display.
pay.get("/:token/tx", (c) => {
  return c.json({ label: REQUEST_LABEL });
});

// Solana Pay transaction request — the wallet POSTs its account, we return a
// serialized transfer transaction (fee payer = the payer) for it to sign.
pay.post("/:token/tx", async (c) => {
  const request = await createPaymentRequestsRepository(c.env).getPaymentRequestByPublicToken(
    c.req.param("token")
  );
  if (!request) {
    throw notFound("Payment request");
  }
  const expired = request.expires_at !== null && Date.parse(request.expires_at) <= Date.now();
  if (request.status !== "awaiting_payment" || expired) {
    throw badRequest("Payment request is no longer payable");
  }

  const body = await c.req.json<{ account?: string }>();
  if (!body.account) {
    throw badRequest("Missing payer account");
  }
  const account = assertValidAddress(body.account, "account");
  const destination = assertValidAddress(request.destination_address, "destinationAddress");

  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");

  let instructions: Instruction[];
  if (request.token === SOL_MINT) {
    const lamports = parseDecimalAmount(request.amount, 9);
    if (lamports <= 0n) {
      throw badRequest("Amount must be greater than zero");
    }
    const transfer = getTransferSolInstruction({
      source: createNoopSigner(account),
      destination,
      amount: lamports,
    });
    instructions = [appendReference(transfer, request.reference)];
  } else {
    const mint = assertValidAddress(request.token, "token");
    const tokenProgram = await resolveMintTokenProgram(rpc, mint);
    const decimals = await resolveMintDecimals(rpc, mint);
    const amount = parseDecimalAmount(request.amount, decimals);
    if (amount <= 0n) {
      throw badRequest("Amount must be greater than zero");
    }
    const [sourceAta] = await findAssociatedTokenPda({ owner: account, tokenProgram, mint });
    const [destinationAta] = await findAssociatedTokenPda({
      owner: destination,
      tokenProgram,
      mint,
    });
    const payer = createNoopSigner(account);
    const createDestinationAta = getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: destinationAta,
      owner: destination,
      mint,
      tokenProgram,
    });
    const transfer = getTransferCheckedInstruction(
      {
        source: sourceAta,
        mint,
        destination: destinationAta,
        authority: payer,
        amount,
        decimals,
      },
      { programAddress: tokenProgram }
    );
    instructions = [createDestinationAta, appendReference(transfer, request.reference)];
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(account, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  return c.json({
    transaction: getBase64EncodedWireTransaction(compileTransaction(message)),
    message: `Pay ${request.amount} ${resolveTokenLabel(request.token)} to ${REQUEST_LABEL}`,
  });
});

pay.get("/:token", async (c) => {
  const request = await createPaymentRequestsRepository(c.env).getPaymentRequestByPublicToken(
    c.req.param("token")
  );
  if (!request) {
    throw notFound("Payment request");
  }

  const expired = request.expires_at !== null && Date.parse(request.expires_at) <= Date.now();
  const status = expired && request.status === "awaiting_payment" ? "expired" : request.status;
  const payable = status === "awaiting_payment";

  let solanaPayUrl: string | null = null;
  if (payable) {
    // Mirror issuance's resolveMetadataOrigin: an optional PUBLIC_API_ORIGIN
    // override (set it to the public/tunnel origin so the QR is reachable from a
    // phone) else the request origin. A malformed override fails loud.
    const configured = c.env.PUBLIC_API_ORIGIN?.trim();
    const origin = configured ? new URL(configured).origin : new URL(c.req.url).origin;
    solanaPayUrl = `solana:${origin}/pay/${request.public_token}/tx`;
  }

  return c.json({
    amount: request.amount,
    token: request.token,
    tokenSymbol: resolveTokenLabel(request.token),
    recipient: request.destination_address,
    reference: request.reference,
    status,
    expiresAt: request.expires_at,
    solanaPayUrl,
  });
});

export default pay;
