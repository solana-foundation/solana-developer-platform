import * as solanaRpc from "@sdp/rpc/solana";
import { getBase64EncodedWireTransaction, getTransactionEncoder } from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { PaymentTransferRecipientRow } from "@/db/repositories/payment-transfer-batches.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
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
 * Updates the recipient rows belonging to one chunk and refreshes the shared
 * recipient map with the returned rows.
 *
 * @param params.recipientsByIndex - Mutable recipient-index map shared across chunks.
 * @param params.recipientIndexes - Recipient indexes owned by this chunk.
 * @param params.transferId - Transfer row the recipients are linked to, or null when the chunk failed before its transfer row existed.
 * @param params.status - New recipient status.
 * @param params.error - Failure detail, or null.
 * @returns The updated recipient rows.
 */
export async function updateRecipientRows(
  c: AppContext,
  params: {
    recipientsByIndex: Map<number, PaymentTransferRecipientRow>;
    recipientIndexes: number[];
    organizationId: string;
    projectId: string;
    transferId: string | null;
    status: PaymentTransferRecipientRow["status"];
    error: string | null;
  }
): Promise<PaymentTransferRecipientRow[]> {
  const targets = params.recipientIndexes.map((index) => {
    const existing = params.recipientsByIndex.get(index);
    if (!existing) {
      throw internalError("Transfer batch recipient row is missing");
    }
    return { index, id: existing.id };
  });

  const updatedRows = await getPaymentTransferBatchesRepository(c).updateTransferRecipientsStatus({
    recipientIds: targets.map((target) => target.id),
    organizationId: params.organizationId,
    projectId: params.projectId,
    transferId: params.transferId,
    status: params.status,
    error: params.error,
  });

  const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
  for (const target of targets) {
    const updated = updatedById.get(target.id);
    if (!updated) {
      throw internalError("Transfer batch recipient row not found for update");
    }
    params.recipientsByIndex.set(target.index, updated);
  }

  return updatedRows;
}

/**
 * Signs and submits one transaction chunk without awaiting on-chain
 * confirmation: the transfer and its recipients settle as processing with the
 * signature stored, and the pending-transfers job finalizes them later.
 * Simulation or send failures settle the chunk as failed instead of throwing.
 *
 * @param params.resolved - Resolved batch request.
 * @param params.chunk - Chunk to sign and submit.
 * @param params.recipientsByIndex - Mutable recipient-index map shared across chunks.
 * @param params.feePayment - Fee-payment adapter used to sponsor and send.
 * @param params.preflight - Whether to simulate before sending.
 * @returns The chunk's transfer row in its post-submit state.
 */
export async function executeChunk(params: {
  c: AppContext;
  resolved: ResolvedBatchRequest;
  chunk: TransactionChunk;
  recipientsByIndex: Map<number, PaymentTransferRecipientRow>;
  feePayment: ReturnType<typeof getFeePayment>;
  preflight: boolean;
}): Promise<PaymentTransferRow> {
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
  const transfer = await getPaymentsRepository(c).createTransfer({
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

  if (!transfer) {
    throw internalError("Failed to create payment transfer record");
  }

  await updateRecipientRows(c, {
    recipientsByIndex: params.recipientsByIndex,
    recipientIndexes: chunk.recipientIndexes,
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
    transferId: transfer.id,
    status: "processing",
    error: null,
  });

  const settle = async (params2: {
    status: PaymentTransferStatus;
    recipientStatus: PaymentTransferRecipientRow["status"];
    signature?: string;
    error: string | null;
  }): Promise<PaymentTransferRow> => {
    await updateRecipientRows(c, {
      recipientsByIndex: params.recipientsByIndex,
      recipientIndexes: chunk.recipientIndexes,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      transferId: transfer.id,
      status: params2.recipientStatus,
      error: params2.error,
    });
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
    return settle({
      status: "failed",
      recipientStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return settle({
    status: "processing",
    recipientStatus: "processing",
    signature,
    error: null,
  });
}
