import { getRecentBlockhash } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS } from "@sdp/types/well-known-tokens";
import {
  compileTransaction,
  createNoopSigner,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import { estimateNotAvailable } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  describeSolRentShortfall,
  findSolRentShortfall,
  type SolMovement,
  type SolRentShortfall,
} from "@/services/payments/sol-rent-minimum";
import {
  getManagedSponsorshipProviderConfiguration,
  resolveRequestSponsorshipScope,
  resolveSponsoredFeePayer,
} from "@/services/sponsorship.service";
import { resolveBatchRequest } from "./resolve";
import type { estimateTransferBatchSchema } from "./schemas";
import { solBatchMovement } from "./sol-movement";
import { readSponsoredRentLimit } from "./sponsored-rent";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  type TransactionChunk,
} from "./transaction";
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

function rentShortfallOf(movement: SolMovement | null): Promise<SolRentShortfall | null> {
  return movement === null ? Promise.resolve(null) : findSolRentShortfall(movement);
}

/** The estimate's warnings for what create would refuse for rent (HOO-2375). */
function rentWarnings(shortfall: SolRentShortfall) {
  const { minimumAmount } = shortfall;
  const recipients = shortfall.recipientIndexes.map((recipientIndex) => ({
    code: "AMOUNT_BELOW_RENT_MINIMUM" as const,
    recipientIndex,
    minimumAmount,
    message: `Recipient ${recipientIndex}'s address has no account, so it must receive at least ${minimumAmount} SOL, the rent-exempt minimum`,
  }));
  if (shortfall.sourceRemainderLamports === null) return recipients;
  return [
    ...recipients,
    {
      code: "SOURCE_BELOW_RENT_MINIMUM" as const,
      minimumAmount,
      sourceRemainder: formatDecimalAmount(shortfall.sourceRemainderLamports, SOL_DECIMALS),
      message: describeSolRentShortfall({ ...shortfall, recipientIndexes: [] }, "batch"),
    },
  ];
}

/**
 * POST /transfer-batches/estimate — prices a batch without executing it:
 * transaction count, network fees, sponsored token-account rent, and
 * warnings for recipients create would refuse (HOO-2375).
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
  const groups = await buildInstructionGroups({
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner,
    feePayer,
  });
  const sponsoredRent = await readSponsoredRentLimit({
    rpc: resolved.rpc,
    groups,
    tokenContext: resolved.tokenContext,
    readConfiguration: () => getManagedSponsorshipProviderConfiguration(c.env),
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner,
    feePayer,
    lifetime,
    sponsoredRent,
    maxRecipientsPerTransaction:
      body.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  });
  const [networkFeeLamports, rentShortfall] = await Promise.all([
    estimateNetworkFeeLamports(resolved.rpc, chunks),
    rentShortfallOf(solBatchMovement(resolved, chunks)),
  ]);
  let tokenAccountRentLamports = 0n;
  for (const rent of sponsoredRent.rentByTokenAccount.values()) tokenAccountRentLamports += rent;
  const warnings = rentShortfall === null ? [] : rentWarnings(rentShortfall);

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
      warnings,
    },
  });
}
