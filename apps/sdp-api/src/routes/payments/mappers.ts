import type { PaymentTransferSummary, RampTransferSettlement } from "@sdp/types";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import {
  isRampTransferType,
  type PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { internalError } from "@/lib/errors";
import { mapMoneygramTransferDetails } from "./mappers/moneygram";

export interface TransferBatchMappingContext {
  batch: PaymentTransferBatchRow;
  recipients?: PaymentTransferRecipientRow[];
}

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

export function mapTransferRow(
  row: TransferRow,
  batchContext?: TransferBatchMappingContext
): PaymentTransferSummary {
  const base = {
    id: row.id,
    organizationId: row.organization_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    type: row.type,
    direction: row.direction,
    status: row.status,
    signature: row.signature,
    serializedTx: row.serialized_tx,
    slot: row.slot,
    blockTime: row.block_time,
    fee: row.fee,
    error: row.error,
    ...(row.initiated_by_key_id
      ? {
          initiatedBy: {
            type: "api_key",
            id: row.initiated_by_key_id,
          },
        }
      : {}),
    ...(row.source_address ? { source: row.source_address } : {}),
    ...(row.destination_address ? { destination: row.destination_address } : {}),
    ...(row.memo ? { memo: row.memo } : {}),
    token: row.token,
    ...(row.amount ? { amount: row.amount } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.type === "transfer_batch") {
    if (batchContext === undefined) {
      throw internalError(`Batch transfer ${row.id} is missing its batch mapping context.`);
    }
    const batchTransfer = {
      ...base,
      batch: mapBatchRow(batchContext.batch),
    };
    if (batchContext.recipients === undefined) {
      return batchTransfer;
    }
    return {
      ...batchTransfer,
      counterpartyRecipients: batchContext.recipients.map(mapRecipientRow),
    };
  }

  if (!isRampTransferType(row.type)) {
    return base;
  }

  if (!row.provider) {
    throw internalError("Ramp transfer is missing provider.");
  }

  const settlement = row.provider_data.settlement as RampTransferSettlement | undefined;
  const moneygram = mapMoneygramTransferDetails(row);
  return {
    ...base,
    provider: row.provider,
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    ...(row.provider_reference ? { providerReference: row.provider_reference } : {}),
    ...(row.delivery_mode ? { deliveryMode: row.delivery_mode } : {}),
    ...(row.fiat_currency ? { fiatCurrency: row.fiat_currency } : {}),
    ...(row.fiat_amount ? { fiatAmount: row.fiat_amount } : {}),
    ...(settlement ? { settlement } : {}),
    ...(moneygram ? { moneygram } : {}),
  };
}
