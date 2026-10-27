import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { AppError } from "@/lib/errors";
import {
  type AppContext,
  getPaymentsRepository,
  getPaymentTransferBatchesRepository,
} from "@/routes/payments/context";
import { mapTransferRow } from "@/routes/payments/mappers";

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
    sourceCustodyWalletId: row.source_custody_wallet_id,
    sourceProviderWalletId: row.source_wallet_id,
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
function mapRecipientRow(row: PaymentTransferRecipientRow) {
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
  if (
    transferRows.some((transfer) => transfer.custody_wallet_id !== batch.source_custody_wallet_id)
  ) {
    throw new AppError("CONFLICT", "Transfer batch wallet identity is inconsistent");
  }

  return {
    batch: mapBatchRow(batch),
    recipients: recipients.rows.map(mapRecipientRow),
    transfers: transferRows.map(mapTransferRow),
  };
}
