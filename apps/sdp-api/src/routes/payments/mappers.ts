import type { PaymentTransferRow as TransferRow } from "@/db/repositories/payments.repository";

export function mapTransferRow(row: TransferRow) {
  return {
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
    source: row.source_address,
    destination: row.destination_address,
    ...(row.memo ? { memo: row.memo } : {}),
    token: row.token,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
