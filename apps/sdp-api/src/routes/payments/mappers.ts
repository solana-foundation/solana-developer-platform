import type { RampTransferSettlement } from "@sdp/types";
import {
  isRampTransferType,
  type PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";

export function mapTransferRow(row: TransferRow) {
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

  if (!isRampTransferType(row.type)) {
    return base;
  }

  if (!row.provider) {
    throw new AppError("INTERNAL_ERROR", "Ramp transfer is missing provider.");
  }

  const settlement = row.provider_data.settlement as RampTransferSettlement | undefined;
  return {
    ...base,
    provider: row.provider,
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    ...(row.provider_reference ? { providerReference: row.provider_reference } : {}),
    ...(row.delivery_mode ? { deliveryMode: row.delivery_mode } : {}),
    ...(row.fiat_currency ? { fiatCurrency: row.fiat_currency } : {}),
    ...(row.fiat_amount ? { fiatAmount: row.fiat_amount } : {}),
    ...(settlement ? { settlement } : {}),
  };
}
