import { getMinimumBalanceForRentExemption, getRecentBlockhash } from "@sdp/rpc/solana";
import { associatedTokenAccountSize } from "@sdp/solana/token-movement";
import {
  compileTransaction,
  createNoopSigner,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import { estimateNotAvailable } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { quotedAmounts } from "@/routes/payments/mappers";
import {
  resolveRequestSponsorshipScope,
  resolveSponsoredFeePayer,
} from "@/services/sponsorship.service";
import { resolveBatchRequest } from "./resolve";
import type { estimateTransferBatchSchema } from "./schemas";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  type TransactionChunk,
} from "./transaction";
import type { ResolvedBatchRequest, Rpc } from "./types";

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
 * that do not exist yet, sized for the mint's account extensions. The batch's
 * account read already saw each one, so this reads only the rent. Zero for
 * native SOL.
 *
 * @param rpc - Solana RPC client.
 * @param resolved - The resolved batch, its recipients' destinations read.
 * @returns Total rent-exemption lamports for missing token accounts.
 */
async function estimateMissingAtaRentLamports(
  rpc: Rpc,
  resolved: ResolvedBatchRequest
): Promise<bigint> {
  const { terms } = resolved.plan;
  // Native SOL opens no token account.
  if (terms.readAt === null) {
    return 0n;
  }
  const missing = new Set(
    resolved.recipients.flatMap(({ leg }) =>
      leg.accounts.kind === "token" && !leg.accounts.destination.exists
        ? [leg.accounts.destination.tokenAccount]
        : []
    )
  );
  if (missing.size === 0) {
    return 0n;
  }
  const rentLamports = await getMinimumBalanceForRentExemption(
    rpc,
    associatedTokenAccountSize(terms)
  );
  return rentLamports * BigInt(missing.size);
}

/**
 * POST /transfer-batches/estimate — prices a batch without executing it:
 * transaction count, network fees, and sponsored token-account rent.
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
  const [feePayer, lifetime] = await Promise.all([
    resolveSponsoredFeePayer(c.env, resolveRequestSponsorshipScope(c)),
    getRecentBlockhash(resolved.rpc, "confirmed"),
  ]);
  const groups = buildInstructionGroups({
    plan: resolved.plan,
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
      body.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  });
  const [networkFeeLamports, tokenAccountRentLamports] = await Promise.all([
    estimateNetworkFeeLamports(resolved.rpc, chunks),
    estimateMissingAtaRentLamports(resolved.rpc, resolved),
  ]);

  return success(c, {
    estimate: {
      recipientCount: resolved.recipients.length,
      transactionCount: chunks.length,
      amounts: quotedAmounts(resolved.recipients.map((recipient) => recipient.leg.quote)),
      estimatedFees: {
        networkFeeLamports: networkFeeLamports.toString(),
        priorityFeeLamports: "0",
        tokenAccountRentLamports: tokenAccountRentLamports.toString(),
        sponsored: true,
      },
    },
  });
}
