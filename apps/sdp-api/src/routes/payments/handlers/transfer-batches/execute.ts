import * as solanaRpc from "@sdp/rpc/solana";
import { getBase64EncodedWireTransaction, getTransactionEncoder } from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getDb } from "@/db";
import { asTransactionalClient } from "@/db/client";
import type {
  PaymentTransferBatchesRepository,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { internalError, transactionFailed } from "@/lib/errors";
import {
  type AppContext,
  type getFeePayment,
  getPaymentsRepository,
  getPaymentTransferBatchesRepository,
} from "../../context";
import type { TransactionChunk } from "./transaction";
import type { ResolvedBatchRequest } from "./types";

/**
 * Updates a chunk's payment_transfers row, failing loudly if it vanished.
 *
 * @param params.transferId - Transfer row to update.
 * @param params.status - New transfer status.
 * @param params.signature - Transaction signature, once submitted.
 * @param params.serializedTx - Base64 wire transaction for the chunk.
 * @param params.error - Failure detail, or null.
 * @returns The updated transfer row.
 */
async function updateTransferRecord(
  c: AppContext,
  params: {
    transferId: string;
    organizationId: string;
    projectId: string;
    status: PaymentTransferStatus;
    signature?: string;
    serializedTx: string;
    error: string | null;
  }
): Promise<PaymentTransferRow> {
  const updated = await getPaymentsRepository(c).updateTransfer({
    transferId: params.transferId,
    organizationId: params.organizationId,
    projectId: params.projectId,
    status: params.status,
    signature: params.signature,
    serializedTx: params.serializedTx,
    error: params.error,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw internalError("Payment transfer record not found for update");
  }

  return updated;
}

/**
 * Updates the recipient rows belonging to one chunk and returns the updated
 * rows keyed by recipient index. Callers apply the result to the shared
 * recipient map via applyRecipientRowUpdates once the write is durable —
 * transactional callers must wait for commit so a rollback never leaves the
 * map claiming a link the database does not have.
 *
 * @param params.repository - Batches repository to write through; pass a
 * transaction-bound repository to compose with other writes.
 * @param params.recipientsByIndex - Recipient-index map shared across chunks (read only here).
 * @param params.recipientIndexes - Recipient indexes owned by this chunk.
 * @param params.transferId - Transfer row the recipients are linked to, or null when the chunk failed before its transfer row existed.
 * @param params.status - New recipient status.
 * @param params.error - Failure detail, or null.
 * @returns Updated recipient rows keyed by recipient index.
 */
export async function updateRecipientRows(params: {
  repository: PaymentTransferBatchesRepository;
  recipientsByIndex: Map<number, PaymentTransferRecipientRow>;
  recipientIndexes: number[];
  organizationId: string;
  projectId: string;
  transferId: string | null;
  status: PaymentTransferRecipientRow["status"];
  error: string | null;
}): Promise<Map<number, PaymentTransferRecipientRow>> {
  const targets = params.recipientIndexes.map((index) => {
    const existing = params.recipientsByIndex.get(index);
    if (!existing) {
      throw internalError("Transfer batch recipient row is missing");
    }
    return { index, id: existing.id };
  });

  const updatedRows = await params.repository.updateTransferRecipientsStatus({
    recipientIds: targets.map((target) => target.id),
    organizationId: params.organizationId,
    projectId: params.projectId,
    transferId: params.transferId,
    status: params.status,
    error: params.error,
  });

  const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
  const updatesByIndex = new Map<number, PaymentTransferRecipientRow>();
  for (const target of targets) {
    const updated = updatedById.get(target.id);
    if (!updated) {
      throw internalError("Transfer batch recipient row not found for update");
    }
    updatesByIndex.set(target.index, updated);
  }

  return updatesByIndex;
}

/**
 * Applies committed recipient-row updates to the shared recipient map.
 *
 * @param recipientsByIndex - Mutable recipient-index map shared across chunks.
 * @param updates - Updated rows keyed by recipient index.
 */
export function applyRecipientRowUpdates(
  recipientsByIndex: Map<number, PaymentTransferRecipientRow>,
  updates: Map<number, PaymentTransferRecipientRow>
): void {
  for (const [index, row] of updates) {
    recipientsByIndex.set(index, row);
  }
}

/**
 * Signs and submits one transaction chunk without awaiting on-chain
 * confirmation: the pending-transfers job finalizes the chunk later.
 * Simulation or send failures settle the chunk as failed instead of throwing.
 * The transfer row and its recipient links are written in ONE transaction so
 * a processing chunk transfer always has linked recipients — the invariant
 * settleTransferBatch enforces when the pending-transfers job settles it.
 * After signAndSend the signature is persisted as the sole immediate write
 * (recipients are already processing and linked), keeping the window where a
 * submitted payment lacks its recovery signature to a single database call.
 *
 * @param params.resolved - Resolved batch request.
 * @param params.chunk - Chunk to sign and submit.
 * @param params.recipientsByIndex - Mutable recipient-index map shared across chunks.
 * @param params.feePayment - Fee-payment adapter used to sponsor and send.
 * @param params.preflight - Whether to simulate before sending.
 */
export async function executeChunk(params: {
  c: AppContext;
  resolved: ResolvedBatchRequest;
  chunk: TransactionChunk;
  recipientsByIndex: Map<number, PaymentTransferRecipientRow>;
  feePayment: ReturnType<typeof getFeePayment>;
  preflight: boolean;
}): Promise<void> {
  const { c, resolved, chunk } = params;
  const partiallySigned = await partiallySignTransactionMessageWithSigners(chunk.message);
  const serializedTx = getBase64EncodedWireTransaction(partiallySigned);
  const txBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  const recipientRows = chunk.recipientIndexes.map((index) => {
    const row = params.recipientsByIndex.get(index);
    if (!row) {
      throw internalError("Transfer batch recipient row is missing");
    }
    return row;
  });

  const firstRecipient = recipientRows[0];
  const linkedTransfer = await getDb(c.env).transaction(async (tx) => {
    const txClient = asTransactionalClient(tx);
    const created = await createPostgresPaymentsRepository(txClient).createTransfer({
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      walletId: resolved.sourceWallet.walletId,
      counterpartyId: recipientRows.length === 1 ? firstRecipient.counterparty_id : null,
      sourceAddress: resolved.sourceAddress,
      destinationAddress: recipientRows.length === 1 ? firstRecipient.destination_address : null,
      token: resolved.tokenContext.token,
      amount: chunk.amount,
      memo: null,
      type: "transfer_batch",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {
        batchRecipientCount: recipientRows.length,
        recipientIds: recipientRows.map((row) => row.id),
      },
      serializedTx,
      signature: null,
      slot: null,
      initiatedByKeyId: resolved.scope.auth.id,
    });

    if (!created) {
      throw internalError("Failed to create payment transfer record");
    }

    const linked = await updateRecipientRows({
      repository: createPostgresPaymentTransferBatchesRepository(txClient),
      recipientsByIndex: params.recipientsByIndex,
      recipientIndexes: chunk.recipientIndexes,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      transferId: created.id,
      status: "processing",
      error: null,
    });

    return { created, linked };
  });
  applyRecipientRowUpdates(params.recipientsByIndex, linkedTransfer.linked);
  const transfer = linkedTransfer.created;

  const settle = async (params2: {
    status: PaymentTransferStatus;
    recipientStatus: PaymentTransferRecipientRow["status"];
    signature?: string;
    error: string | null;
  }): Promise<PaymentTransferRow> => {
    const updates = await updateRecipientRows({
      repository: getPaymentTransferBatchesRepository(c),
      recipientsByIndex: params.recipientsByIndex,
      recipientIndexes: chunk.recipientIndexes,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      transferId: transfer.id,
      status: params2.recipientStatus,
      error: params2.error,
    });
    applyRecipientRowUpdates(params.recipientsByIndex, updates);
    return updateTransferRecord(c, {
      transferId: transfer.id,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      status: params2.status,
      signature: params2.signature,
      serializedTx,
      error: params2.error,
    });
  };

  let signature: Awaited<ReturnType<typeof params.feePayment.signAndSend>>;
  try {
    if (params.preflight) {
      const simulated = await solanaRpc.simulateTransaction(resolved.rpc, txBytes);
      if (!simulated.success) {
        throw transactionFailed(
          `Batch transfer preflight failed: ${simulated.error ?? "unknown simulation error"}`,
          { logs: simulated.logs }
        );
      }
    }
    signature = await params.feePayment.signAndSend(txBytes);
  } catch (error) {
    await settle({
      status: "failed",
      recipientStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await updateTransferRecord(c, {
    transferId: transfer.id,
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
    status: "processing",
    signature,
    serializedTx,
    error: null,
  });
}
