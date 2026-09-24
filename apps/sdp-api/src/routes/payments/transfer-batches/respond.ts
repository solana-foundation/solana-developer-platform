import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { AppError, conflict } from "@/lib/errors";
import {
  type AppContext,
  getPaymentsRepository,
  getPaymentTransferBatchesRepository,
} from "../context";
import { mapTransferRow } from "../mappers";

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
 * Fingerprints recorded before the batch `externalId` joined the fingerprint
 * (SOLA9-418) are reference-blind: a batch that carried a reference at
 * creation stores one that no longer matches its own identical retry. For
 * those rows the persisted `external_id` is the reference the key was claimed
 * with, so a request whose reference-blind fingerprint matches the stored one
 * replays only when it names that same reference — a changed or newly added
 * reference is a different request and conflicts.
 *
 * @param repository - Transfer-batches repository.
 * @param organizationId - Tenant scope of the key lookup.
 * @param projectId - Tenant scope of the key lookup.
 * @param idempotencyKey - Idempotency-Key header value.
 * @param fingerprint - Fingerprint of the current request payload.
 * @param sourceCustodyWalletId - Exact wallet the key must be bound to.
 * @param legacyFingerprint - The same payload fingerprint computed the
 *   pre-SOLA9-418 way, with the batch `externalId` omitted entirely.
 * @param externalId - The request's top-level batch external reference
 *   (null when the request carries none).
 * @returns The original batch row, or null when no replay applies.
 */
export async function resolveTransferBatchIdempotencyReplay(
  repository: ReturnType<typeof getPaymentTransferBatchesRepository>,
  organizationId: string,
  projectId: string,
  idempotencyKey: string,
  fingerprint: string,
  sourceCustodyWalletId: string,
  legacyFingerprint: string,
  externalId: string | null
): Promise<PaymentTransferBatchRow | null> {
  const existing = await repository.findTransferBatchByIdempotency({
    organizationId,
    projectId,
    idempotencyKey,
  });
  if (!existing || existing.idempotency_fingerprint === null) {
    return null;
  }
  if (existing.source_custody_wallet_id !== sourceCustodyWalletId) {
    throw conflict("Idempotency key already used with different request payload");
  }
  const stored = existing.idempotency_fingerprint;
  if (stored === fingerprint) {
    return existing;
  }
  // The exact match failed only because the request carries the batch
  // externalId while the stored fingerprint predates it: the reference-blind
  // payload is identical, so the persisted reference decides replay versus
  // conflict. (When the request carries no externalId, `fingerprint` IS the
  // reference-blind shape and the exact match above already decided.)
  if (stored === legacyFingerprint && existing.external_id === externalId) {
    return existing;
  }
  throw conflict("Idempotency key already used with different request payload");
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
