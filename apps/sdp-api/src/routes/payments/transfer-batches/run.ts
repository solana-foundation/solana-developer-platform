import { createClusterRpc } from "@sdp/rpc/factory";
import { getRecentBlockhash } from "@sdp/rpc/solana";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { badRequest, internalError } from "@/lib/errors";
import { type AppContext, getPaymentTransferBatchesRepository } from "@/routes/payments/context";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveRequestSponsorshipScope,
  type SponsorshipFeePayment,
} from "@/services/sponsorship.service";
import { executeChunk } from "./execute";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  type TransactionChunk,
} from "./transaction";
import type { RecentBlockhash, ResolvedBatchRequest } from "./types";

/** A batch's transactions, built before its rows are written so their count is known. */
export interface PreparedBatchChunks {
  feePayment: SponsorshipFeePayment;
  lifetime: RecentBlockhash;
  chunks: TransactionChunk[];
  /**
   * This attempt (a create, or a retry's claim): its recipients are written or
   * claimed under it, and only it may link or fail them (HOO-2343).
   */
  attemptId: string;
}

/**
 * Loads the custody signer and the sponsor through the signing waists
 * (ADR 0007) and chunks the resolved recipients into transactions. Signs
 * nothing: each chunk is signed in executeChunk, after its row is written.
 *
 * @param maxRecipientsPerTransaction - The batch's option, or the default.
 */
export async function prepareBatchChunks(
  c: AppContext,
  resolved: ResolvedBatchRequest,
  maxRecipientsPerTransaction: number | undefined
): Promise<PreparedBatchChunks> {
  const feePayment = createSponsorshipFeePayment(
    c.env,
    resolveRequestSponsorshipScope(c),
    "payments.transfer_batch",
    { custodyWalletId: resolved.sourceWallet.id }
  );
  const [signer, feePayer, lifetime] = await Promise.all([
    createOrgSignerForCustodyWallet(
      c.env,
      resolved.scope.auth.organizationId,
      resolved.projectId,
      resolved.sourceWallet.id,
      "payments.transfer_batch"
    ),
    feePayment.getFeePayer(),
    // The open cluster scope's pooled client, not one carried in from resolve.
    getRecentBlockhash(createClusterRpc(), "confirmed"),
  ]);
  if (signer.address !== resolved.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }
  const groups = await buildInstructionGroups({
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner: signer,
    feePayer,
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner: signer,
    feePayer,
    lifetime,
    maxRecipientsPerTransaction:
      maxRecipientsPerTransaction === undefined
        ? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION
        : maxRecipientsPerTransaction,
  });
  return { feePayment, lifetime, chunks, attemptId: crypto.randomUUID() };
}

/**
 * Submits a batch's chunks concurrently, for recipient rows already written
 * pending with no chunk transfer (`recipientRows[i]` is `resolved.recipients[i]`),
 * and responds without waiting for on-chain confirmation: transfers come back
 * processing and the pending-transfers job settles them.
 * A chunk whose execution throws is settled as failed recipients rather than
 * failing the request, so sibling submissions are never abandoned half-done.
 * That cleanup only touches recipients still unsent (pending, transfer_id
 * null): executeChunk creates its transfer row and links recipients in one
 * transaction, so a linked recipient implies a live transfer row that the
 * pending-transfers job settles via settleTransferBatch — unlinking it here
 * would orphan that transfer as permanently processing.
 * The final batch status comes from the locked repository recompute — never
 * from in-memory state — so a reconciliation run that settles chunks during
 * the request cannot be overwritten with a stale status.
 *
 * @returns The batch row after the recompute.
 */
export async function runBatchChunks(params: {
  c: AppContext;
  resolved: ResolvedBatchRequest;
  batchId: string;
  prepared: PreparedBatchChunks;
  recipientRows: PaymentTransferRecipientRow[];
  preflight: boolean;
}): Promise<PaymentTransferBatchRow> {
  const { c, resolved, prepared } = params;
  const organizationId = resolved.scope.auth.organizationId;
  const recipientsByIndex = new Map<number, PaymentTransferRecipientRow>(
    resolved.recipients.map((recipient, position) => [
      recipient.index,
      params.recipientRows[position],
    ])
  );

  const outcomes = await Promise.allSettled(
    prepared.chunks.map((chunk) =>
      executeChunk({
        c,
        resolved,
        chunk,
        recipientsByIndex,
        feePayment: prepared.feePayment,
        lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight,
        attemptId: prepared.attemptId,
        preflight: params.preflight,
      })
    )
  );
  for (const [position, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") continue;
    const unsentIds = prepared.chunks[position].recipientIndexes.flatMap((index) => {
      const row = recipientsByIndex.get(index);
      if (!row) {
        throw internalError("Transfer batch recipient row is missing");
      }
      return row.transfer_id === null ? [row.id] : [];
    });
    if (unsentIds.length === 0) continue;
    await getPaymentTransferBatchesRepository(c).updateTransferRecipientsStatus({
      recipientIds: unsentIds,
      organizationId,
      projectId: resolved.projectId,
      transferId: null,
      status: "failed",
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      requireUnsentFor: { attemptId: prepared.attemptId },
    });
  }

  return getPaymentTransferBatchesRepository(c).recomputeTransferBatchStatus({
    batchId: params.batchId,
    organizationId,
    projectId: resolved.projectId,
  });
}
