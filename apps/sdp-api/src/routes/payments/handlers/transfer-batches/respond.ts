import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { resolveIdempotencyReplay } from "@/lib/idempotency";
import {
  type AppContext,
  getPaymentsRepository,
  getPaymentTransferBatchesRepository,
} from "../../context";
import { mapTransferRow } from "../../mappers";

/**
 * Maps a batch row to its API response shape.
 *
 * @param row - Batch row from the repository.
 * @returns The camelCase API representation.
 */
export function mapBatchRow(row: PaymentTransferBatchRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    externalId: row.external_id,
    sourceWalletId: row.source_wallet_id,
    sourceAddress: row.source_address,
    token: row.token,
    status: row.status,
    totalAmount: row.total_amount,
    recipientCount: row.recipient_count,
    transactionCount: row.transaction_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a recipient row to its API response shape.
 *
 * @param row - Recipient row from the repository.
 * @returns The camelCase API representation.
 */
export function mapRecipientRow(row: PaymentTransferRecipientRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    transferId: row.transfer_id,
    externalId: row.external_id,
    counterpartyId: row.counterparty_id,
    counterpartyAccountId: row.counterparty_account_id,
    destination: row.destination_address,
    amount: row.amount,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Looks up an existing batch for an Idempotency-Key, verifying the stored
 * payload fingerprint matches before treating the request as a replay.
 *
 * @param repository - Transfer-batches repository.
 * @param idempotencyKey - Idempotency-Key header value.
 * @param fingerprint - Fingerprint of the current request payload.
 * @returns The original batch row, or null when no replay applies.
 */
export async function resolveTransferBatchIdempotencyReplay(
  repository: ReturnType<typeof getPaymentTransferBatchesRepository>,
  organizationId: string,
  projectId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<PaymentTransferBatchRow | null> {
  return resolveIdempotencyReplay(
    () => repository.findTransferBatchByIdempotency({ organizationId, projectId, idempotencyKey }),
    fingerprint
  );
}

/**
 * Assembles the full batch response — batch, recipients, and chunk transfers
 * — using one batched transfer lookup.
 *
 * @param c - Request context.
 * @param batch - Batch row to respond with.
 * @returns The JSON-serializable batch response body.
 */
export async function buildTransferBatchResponse(
  c: AppContext,
  batch: PaymentTransferBatchRow,
  organizationId: string,
  projectId: string
) {
  const recipients = await getPaymentTransferBatchesRepository(c).listTransferRecipientsByBatch({
    batchId: batch.id,
    organizationId,
    projectId,
    limit: 500,
    offset: 0,
  });
  const transferIds = Array.from(
    new Set(
      recipients.rows
        .map((recipient) => recipient.transfer_id)
        .filter((transferId): transferId is string => Boolean(transferId))
    )
  );
  const transferRows = await getPaymentsRepository(c).listTransfersByIds({
    transferIds,
    organizationId,
    projectId,
  });

  return {
    batch: mapBatchRow(batch),
    recipients: recipients.rows.map(mapRecipientRow),
    transfers: transferRows.map(mapTransferRow),
  };
}
