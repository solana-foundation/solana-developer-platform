import * as solanaRpc from "@sdp/rpc/solana";
import type { TransactionMessageBytesBase64 } from "@solana/kit";
import { compileTransaction, createNoopSigner } from "@solana/kit";
import { getTokenSize } from "@solana-program/token-2022";
import { z } from "zod";
import { badRequest, estimateNotAvailable } from "@/lib/errors";
import { buildFeePaymentSizeProbeInstruction } from "@/lib/fee-payment";
import { success } from "@/lib/response";
import { type AppContext, getFeePayment } from "../../context";
import { estimateTransferBatchSchema } from "../../schemas";
import { resolveBatchRequest } from "./resolve";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  type RecipientInstructionGroup,
  type TransactionChunk,
} from "./transaction";
import type { Rpc, TokenContext } from "./types";

/**
 * Sums the network fee across all chunk transactions via getFeeForMessage.
 *
 * @param rpc - Solana RPC client.
 * @param chunks - Chunks the batch would submit.
 * @returns Total network fee in lamports.
 */
async function estimateNetworkFeeLamports(rpc: Rpc, chunks: TransactionChunk[]): Promise<bigint> {
  const fees = await Promise.all(
    chunks.map(async (chunk) => {
      const { messageBytes } = compileTransaction(chunk.message);
      const message = Buffer.from(messageBytes).toString("base64") as TransactionMessageBytesBase64;
      const { value } = await rpc.getFeeForMessage(message, { commitment: "confirmed" }).send();
      if (value === null) {
        throw estimateNotAvailable("Unable to estimate Solana transaction fees");
      }
      return value;
    })
  );

  return fees.reduce((total, fee) => total + fee, 0n);
}

/**
 * Estimates the rent the fee payer would fund for recipient token accounts
 * that do not exist yet. Zero for SOL batches.
 *
 * @param rpc - Solana RPC client.
 * @param groups - Instruction groups with derived destination token accounts.
 * @param tokenContext - Resolved token parameters for the batch.
 * @returns Total rent-exemption lamports for missing token accounts.
 */
async function estimateMissingAtaRentLamports(
  rpc: Rpc,
  groups: RecipientInstructionGroup[],
  tokenContext: TokenContext
): Promise<bigint> {
  if (tokenContext.kind === "sol") {
    return 0n;
  }

  const [rentLamports, existence] = await Promise.all([
    solanaRpc.getMinimumBalanceForRentExemption(rpc, getTokenSize()),
    Promise.all(
      groups.map((group) =>
        group.destinationTokenAccount
          ? solanaRpc.accountExists(rpc, group.destinationTokenAccount)
          : Promise.resolve(true)
      )
    ),
  ]);

  const missing = existence.filter((exists) => !exists).length;
  return rentLamports * BigInt(missing);
}

/**
 * POST /transfer-batches/estimate — prices a batch without executing it:
 * transaction count, network fees, and sponsored token-account rent.
 *
 * @param c - Request context.
 * @returns JSON estimate response.
 */
export async function estimateTransferBatch(c: AppContext) {
  const body = await c.req.json();
  const parsed = estimateTransferBatchSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const resolved = await resolveBatchRequest(c, parsed.data, ["payments:read"]);
  const feePayment = getFeePayment(c);
  const sourceSigner = createNoopSigner(resolved.sourceAddress);
  const [feePayer, lifetime, sizeProbeInstruction] = await Promise.all([
    feePayment.getFeePayer(),
    solanaRpc.getRecentBlockhash(resolved.rpc, "confirmed"),
    buildFeePaymentSizeProbeInstruction({
      env: c.env,
      feePayment,
      wallet: resolved.sourceWallet,
      sourceSigner,
    }),
  ]);
  const groups = await buildInstructionGroups({
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner,
    feePayer,
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner,
    feePayer,
    lifetime,
    maxRecipientsPerTransaction:
      parsed.data.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
    sizeProbeInstruction,
  });
  const [networkFeeLamports, tokenAccountRentLamports] = await Promise.all([
    estimateNetworkFeeLamports(resolved.rpc, chunks),
    estimateMissingAtaRentLamports(resolved.rpc, groups, resolved.tokenContext),
  ]);

  return success(c, {
    estimate: {
      recipientCount: resolved.recipients.length,
      transactionCount: chunks.length,
      estimatedFees: {
        networkFeeLamports: networkFeeLamports.toString(),
        priorityFeeLamports: "0",
        tokenAccountRentLamports: tokenAccountRentLamports.toString(),
        sponsored: sizeProbeInstruction === null,
      },
    },
  });
}
