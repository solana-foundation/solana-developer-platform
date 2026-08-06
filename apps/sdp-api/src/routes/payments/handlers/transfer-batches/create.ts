import * as solanaRpc from "@sdp/rpc/solana";
import { z } from "zod";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { AppError, badRequest, internalError } from "@/lib/errors";
import { buildTransferBatchFingerprint } from "@/lib/idempotency";
import { success } from "@/lib/response";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import * as solanaServices from "@/services/solana";
import { type AppContext, getFeePayment, getPaymentTransferBatchesRepository } from "../../context";
import { createTransferBatchSchema } from "../../schemas";
import { applyRecipientRowUpdates, executeChunk, updateRecipientRows } from "./execute";
import { enforceBatchPolicies } from "./policy";
import { resolveBatchRequest } from "./resolve";
import { buildTransferBatchResponse, resolveTransferBatchIdempotencyReplay } from "./respond";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
} from "./transaction";

type TransferBatchResponse = Awaited<ReturnType<typeof buildTransferBatchResponse>>;

async function assertApprovedBatchReplayCompleted(
  c: AppContext,
  response: TransferBatchResponse
): Promise<void> {
  if (!approvedWalletOperationId(c)) {
    return;
  }

  const transfersById = new Map(
    response.transfers.map((transfer) => [transfer.id, transfer] as const)
  );
  const incomplete =
    response.batch.status === "pending" ||
    response.recipients.length !== response.batch.recipientCount ||
    response.recipients.some((recipient) => {
      if (recipient.status === "pending") {
        return true;
      }
      if (recipient.status !== "processing" && recipient.status !== "confirmed") {
        return false;
      }
      return !recipient.transferId || !transfersById.get(recipient.transferId)?.signature;
    });
  if (!incomplete) {
    return;
  }

  // The atomic creation path cannot expose a batch before its approval fence.
  // Fence legacy/inconsistent state before failing so recovery cannot convert
  // a stranded batch into a successful approved operation.
  await beginApprovedWalletOperationEffect(c);
  throw new AppError(
    "CONFLICT",
    "Approved transfer batch is incomplete and requires manual reconciliation"
  );
}

async function respondToTransferBatchReplay(
  c: AppContext,
  batch: PaymentTransferBatchRow,
  organizationId: string,
  projectId: string
) {
  const response = await buildTransferBatchResponse(c, batch, organizationId, projectId);
  await assertApprovedBatchReplayCompleted(c, response);
  return success(c, response);
}

/**
 * POST /transfer-batches — creates the batch aggregate, submits all chunks
 * concurrently, and responds without waiting for on-chain confirmation:
 * transfers come back processing and the pending-transfers job settles them.
 * A chunk whose execution throws is settled as failed recipients rather than
 * failing the request, so sibling submissions are never abandoned half-done.
 * That cleanup only touches recipients still unlinked (transfer_id null):
 * executeChunk creates its transfer row and links recipients in one
 * transaction, so a linked recipient implies a live transfer row that the
 * pending-transfers job settles via settleTransferBatch — unlinking it here
 * would orphan that transfer as permanently processing.
 * The final batch status comes from the locked repository recompute — never
 * from in-memory state — so a reconciliation run that settles chunks during
 * the request cannot be overwritten with a stale status.
 * Replays idempotently by Idempotency-Key + payload fingerprint.
 *
 * @param c - Request context.
 * @returns JSON batch response with recipients and chunk transfers.
 */
export async function createTransferBatch(c: AppContext) {
  const body = await c.req.json();
  const parsed = createTransferBatchSchema.safeParse(body);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? null;

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const resolved = await resolveBatchRequest(c, parsed.data, ["payments:write"]);
  const idempotencyFingerprint = idempotencyKey
    ? buildTransferBatchFingerprint({
        sourceAddress: resolved.sourceAddress,
        token: resolved.tokenContext.token,
        recipients: resolved.recipients.map((recipient) => ({
          externalId: recipient.externalId,
          counterpartyId: recipient.counterpartyId,
          counterpartyAccountId: recipient.counterpartyAccountId,
          destinationAddress: recipient.destinationAddress,
          amount: recipient.amount,
        })),
        options: parsed.data.options,
      })
    : null;
  if (idempotencyKey && idempotencyFingerprint) {
    const replay = await resolveTransferBatchIdempotencyReplay(
      getPaymentTransferBatchesRepository(c),
      resolved.scope.auth.organizationId,
      resolved.projectId,
      idempotencyKey,
      idempotencyFingerprint
    );
    if (replay) {
      return respondToTransferBatchReplay(
        c,
        replay,
        resolved.scope.auth.organizationId,
        resolved.projectId
      );
    }
  }
  await enforceBatchPolicies(c, resolved, parsed.data);

  const feePayment = getFeePayment(c);
  const [signer, feePayer, lifetime] = await Promise.all([
    solanaServices.createOrgSigner(
      c.env,
      resolved.scope.auth.organizationId,
      resolved.projectId,
      resolved.sourceWallet.walletId
    ),
    feePayment.getFeePayer(),
    solanaRpc.getRecentBlockhash(resolved.rpc, "confirmed"),
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
      parsed.data.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  });

  const batchRepository = getPaymentTransferBatchesRepository(c);
  let batch: PaymentTransferBatchRow;
  let recipientRows: PaymentTransferRecipientRow[];
  try {
    const created = await runApprovedWalletOperationEffectTransaction(c, (db) =>
      createPostgresPaymentTransferBatchesRepository(db).createTransferBatchWithRecipients({
        batch: {
          organizationId: resolved.scope.auth.organizationId,
          projectId: resolved.projectId,
          externalId: parsed.data.externalId ?? null,
          sourceWalletId: resolved.sourceWallet.walletId,
          sourceAddress: resolved.sourceAddress,
          token: resolved.tokenContext.token,
          status: "processing",
          totalAmount: resolved.totalAmount,
          recipientCount: resolved.recipients.length,
          transactionCount: chunks.length,
          options: parsed.data.options ?? {},
          initiatedByKeyId: resolved.scope.auth.id,
          idempotencyKey,
          idempotencyFingerprint,
        },
        recipients: resolved.recipients.map((recipient) => ({
          organizationId: resolved.scope.auth.organizationId,
          projectId: resolved.projectId,
          externalId: recipient.externalId,
          counterpartyId: recipient.counterpartyId,
          counterpartyAccountId: recipient.counterpartyAccountId,
          destinationAddress: recipient.destinationAddress,
          amount: recipient.amount,
          status: "pending",
          error: null,
        })),
      })
    );
    batch = created.batch;
    recipientRows = created.recipients;
  } catch (error) {
    if (idempotencyKey && idempotencyFingerprint && isPostgresUniqueViolation(error)) {
      const replay = await resolveTransferBatchIdempotencyReplay(
        batchRepository,
        resolved.scope.auth.organizationId,
        resolved.projectId,
        idempotencyKey,
        idempotencyFingerprint
      );
      if (replay) {
        return respondToTransferBatchReplay(
          c,
          replay,
          resolved.scope.auth.organizationId,
          resolved.projectId
        );
      }
    }
    throw error;
  }
  const recipientsByIndex = new Map<number, PaymentTransferRecipientRow>(
    resolved.recipients.map((recipient, position) => [recipient.index, recipientRows[position]])
  );

  const outcomes = await Promise.allSettled(
    chunks.map((chunk) =>
      executeChunk({
        c,
        resolved,
        chunk,
        recipientsByIndex,
        feePayment,
        preflight: parsed.data.options?.preflight !== false,
      })
    )
  );
  for (const [position, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      const unlinkedIndexes = chunks[position].recipientIndexes.filter((index) => {
        const row = recipientsByIndex.get(index);
        if (!row) {
          throw internalError("Transfer batch recipient row is missing");
        }
        return row.transfer_id === null;
      });
      if (unlinkedIndexes.length === 0) {
        continue;
      }
      const updates = await updateRecipientRows({
        repository: getPaymentTransferBatchesRepository(c),
        recipientsByIndex,
        recipientIndexes: unlinkedIndexes,
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        transferId: null,
        status: "failed",
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      applyRecipientRowUpdates(recipientsByIndex, updates);
    }
  }

  const finalBatch = await batchRepository.recomputeTransferBatchStatus({
    batchId: batch.id,
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
  });

  return success(
    c,
    await buildTransferBatchResponse(
      c,
      finalBatch,
      resolved.scope.auth.organizationId,
      resolved.projectId
    )
  );
}
