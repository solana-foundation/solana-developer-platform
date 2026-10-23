import type { TokenMovementAmounts } from "@sdp/types/token-movements";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import {
  type LegTotals,
  legTotals,
  type TokenMovementLeg,
} from "@/db/repositories/token-movement-legs.repository";
import { AppError } from "@/lib/errors";
import {
  type AppContext,
  getPaymentsRepository,
  getPaymentTransferBatchesRepository,
  getTokenMovementLegsRepository,
} from "@/routes/payments/context";
import {
  type MovementFields,
  mapTransferWithLegs,
  movementAmounts,
  movementVerification,
  totalsAmounts,
} from "@/routes/payments/mappers";

/**
 * Maps a batch row to its API response shape.
 *
 * @param row - Batch row from the repository.
 * @param totals - Its recipients' summed legs; null for a batch written before quotes.
 * @returns The camelCase API representation.
 */
export function mapBatchRow(row: PaymentTransferBatchRow, totals: LegTotals | null) {
  const batch: ReturnType<typeof mapBatchFields> & { amounts?: TokenMovementAmounts } =
    mapBatchFields(row);
  if (totals !== null) {
    batch.amounts = totalsAmounts(totals);
  }
  return batch;
}

function mapBatchFields(row: PaymentTransferBatchRow) {
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
 * @param leg - Its leg; null for a recipient written before quotes.
 * @returns The camelCase API representation.
 */
export function mapRecipientRow(row: PaymentTransferRecipientRow, leg: TokenMovementLeg | null) {
  const recipient: ReturnType<typeof mapRecipientFields> & MovementFields = mapRecipientFields(row);
  if (leg !== null) {
    recipient.amounts = movementAmounts([leg]);
    recipient.amountVerification = movementVerification([leg]);
  }
  return recipient;
}

function mapRecipientFields(row: PaymentTransferRecipientRow) {
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
 * — using one batched transfer lookup and one read of the recipients' legs.
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
  const [transferRows, recipientLegs] = await Promise.all([
    getPaymentsRepository(c).listTransfersByIds({ transferIds, organizationId, projectId }),
    getTokenMovementLegsRepository(c).listLegsByRecipients(
      recipients.rows.map((recipient) => recipient.id)
    ),
  ]);
  if (
    transferRows.some((transfer) => transfer.custody_wallet_id !== batch.source_custody_wallet_id)
  ) {
    throw new AppError("CONFLICT", "Transfer batch wallet identity is inconsistent");
  }

  // A chunk transfer's legs are its recipients' legs, so they need no second read.
  const transferLegs = new Map<string, TokenMovementLeg[]>();
  for (const row of recipients.rows) {
    const leg = recipientLegs.get(row.id);
    if (row.transfer_id !== null && leg !== undefined) {
      const chunkLegs = transferLegs.get(row.transfer_id) ?? [];
      chunkLegs.push(leg);
      transferLegs.set(row.transfer_id, chunkLegs);
    }
  }
  // A batch written before quotes has no legs (legacy = no leg).
  const legs = [...recipientLegs.values()];
  const [first, ...rest] = legs;
  return {
    batch: mapBatchRow(batch, first === undefined ? null : legTotals([first, ...rest])),
    recipients: recipients.rows.map((row) =>
      mapRecipientRow(row, recipientLegs.get(row.id) ?? null)
    ),
    transfers: transferRows.map((row) => mapTransferWithLegs(row, transferLegs.get(row.id) ?? [])),
  };
}
