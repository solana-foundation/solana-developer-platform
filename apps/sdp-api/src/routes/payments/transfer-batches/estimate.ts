import { getRecentBlockhash } from "@sdp/rpc/solana";
import {
  compileTransaction,
  createNoopSigner,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import { estimateNotAvailable } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  resolveRequestSponsorshipScope,
  resolveSponsoredFeePayer,
  resolveSponsoredOutflowLimit,
} from "@/services/sponsorship.service";
import { planBatchTransactions } from "./plan";
import { resolveBatchRequest } from "./resolve";
import type { estimateTransferBatchSchema } from "./schemas";
import { DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION, type TransactionChunk } from "./transaction";
import type { Rpc } from "./types";

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
 * POST /transfer-batches/estimate — prices a batch without executing it:
 * transaction count, network fees, and sponsored token-account rent. It plans
 * chunks exactly as create does, against the same live Kora outflow limit.
 *
 * @param c - Request context.
 * @returns JSON estimate response.
 */
export async function estimateTransferBatch(
  c: ValidatedBodyContext<typeof estimateTransferBatchSchema>
) {
  const body = c.req.valid("json");
  const resolved = await resolveBatchRequest(c, body);
  const sourceSigner = createNoopSigner(resolved.sourceAddress);
  const sponsorshipScope = resolveRequestSponsorshipScope(c);
  const [feePayer, maxSponsoredLamportsPerTransaction, lifetime] = await Promise.all([
    resolveSponsoredFeePayer(c.env, sponsorshipScope),
    resolveSponsoredOutflowLimit(c.env, sponsorshipScope),
    getRecentBlockhash(resolved.rpc, "confirmed"),
  ]);
  const { chunks, rentBudget } = await planBatchTransactions({
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner,
    feePayer,
    lifetime,
    maxRecipientsPerTransaction:
      body.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
    maxSponsoredLamportsPerTransaction,
  });
  const networkFeeLamports = await estimateNetworkFeeLamports(resolved.rpc, chunks);
  const tokenAccountRentLamports =
    rentBudget.rentPerTokenAccount * BigInt(rentBudget.missingTokenAccounts.size);

  return success(c, {
    estimate: {
      recipientCount: resolved.recipients.length,
      transactionCount: chunks.length,
      estimatedFees: {
        networkFeeLamports: networkFeeLamports.toString(),
        priorityFeeLamports: "0",
        tokenAccountRentLamports: tokenAccountRentLamports.toString(),
        sponsored: true,
      },
    },
  });
}
