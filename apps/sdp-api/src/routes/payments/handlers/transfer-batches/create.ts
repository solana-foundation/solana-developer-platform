import * as solanaRpc from "@sdp/rpc/solana";
import { z } from "zod";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  deriveTransferBatchStatus,
  type PaymentTransferBatchRow,
  type PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { badRequest, internalError } from "@/lib/errors";
import { buildTransferBatchFingerprint } from "@/lib/idempotency";
import { success } from "@/lib/response";
import * as solanaServices from "@/services/solana";
import { type AppContext, getFeePayment, getPaymentTransferBatchesRepository } from "../../context";
import { mapTransferRow } from "../../mappers";
import { createTransferBatchSchema } from "../../schemas";
import { executeChunk } from "./execute";
import { enforceBatchPolicies } from "./policy";
import { resolveBatchRequest } from "./resolve";
import {
  buildTransferBatchResponse,
  mapBatchRow,
  mapRecipientRow,
  resolveTransferBatchIdempotencyReplay,
} from "./respond";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
} from "./transaction";

/**
 * POST /transfer-batches — creates the batch aggregate, submits all chunks
 * concurrently, and responds without waiting for on-chain confirmation:
 * transfers come back processing and the pending-transfers job settles them.
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
      return success(
        c,
        await buildTransferBatchResponse(
          c,
          replay,
          resolved.scope.auth.organizationId,
          resolved.projectId
        )
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
    const created = await batchRepository.createTransferBatchWithRecipients({
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
    });
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
        return success(
          c,
          await buildTransferBatchResponse(
            c,
            replay,
            resolved.scope.auth.organizationId,
            resolved.projectId
          )
        );
      }
    }
    throw error;
  }
  const recipientsByIndex = new Map<number, PaymentTransferRecipientRow>(
    resolved.recipients.map((recipient, position) => [recipient.index, recipientRows[position]])
  );

  const transfers = await Promise.all(
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

  const status = deriveTransferBatchStatus(transfers.map((transfer) => transfer.status));
  const finalBatch = await batchRepository.updateTransferBatch({
    batchId: batch.id,
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
    status,
    error:
      status === "failed" || status === "partially_failed"
        ? "One or more transfer batch transactions failed during execution"
        : null,
  });
  if (!finalBatch) {
    throw internalError("Transfer batch not found for update");
  }

  return success(c, {
    batch: mapBatchRow(finalBatch),
    recipients: Array.from(recipientsByIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, row]) => mapRecipientRow(row)),
    transfers: transfers.map(mapTransferRow),
  });
}
