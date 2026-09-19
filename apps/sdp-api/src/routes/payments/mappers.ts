import type {
  PaymentSubscriptionCollectionAttempt,
  RampCryptoDeposit,
  RampTransferSettlement,
} from "@sdp/types";
import type { PaymentSubscriptionCollectionAttemptRow } from "@/db/repositories";
import {
  isRampTransferType,
  type PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import { bvnkProviderReference } from "./handlers/ramps/bvnk";
import { mapMoneygramTransferDetails } from "./mappers/moneygram";

/**
 * The provider-side payout reference mapped for a ramp transfer row. BVNK
 * routes through {@link bvnkProviderReference} (the payout uuid once the
 * on-ramp settlement exists, omitted before); every other provider keeps the
 * stored `provider_reference` as-is. The switch is exhaustive over the ramp
 * provider union.
 *
 * @param row - The payment transfer row being mapped.
 * @returns The provider reference to present, or undefined when omitted.
 */
function rampProviderReference(row: TransferRow): string | undefined {
  switch (row.provider) {
    case "bvnk":
      return bvnkProviderReference(row);
    case "moonpay":
    case "lightspark":
    case "moneygram":
    case "coinbase":
    case "mural":
    case "stripe":
      return row.provider_reference === null ? undefined : row.provider_reference;
    default: {
      if (row.provider === null) {
        throw new AppError("INTERNAL_ERROR", "Ramp transfer is missing provider.");
      }
      const exhaustive: never = row.provider;
      return exhaustive;
    }
  }
}

export function mapTransferRow(row: TransferRow) {
  const base = {
    id: row.id,
    organizationId: row.organization_id,
    custodyWalletId: row.custody_wallet_id,
    providerWalletId: row.wallet_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    type: row.type,
    kind: row.kind,
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
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    ...(row.counterparty_display_name
      ? { counterpartyDisplayName: row.counterparty_display_name }
      : {}),
    ...(row.memo ? { memo: row.memo } : {}),
    rampsMemo: row.ramps_memo,
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
  const cryptoDeposit = row.provider_data.cryptoDeposit as RampCryptoDeposit | null | undefined;
  const moneygram = mapMoneygramTransferDetails(row);
  const providerReference = rampProviderReference(row);
  return {
    ...base,
    provider: row.provider,
    ...(providerReference ? { providerReference } : {}),
    ...(row.delivery_mode ? { deliveryMode: row.delivery_mode } : {}),
    ...(row.fiat_currency ? { fiatCurrency: row.fiat_currency } : {}),
    ...(row.fiat_amount ? { fiatAmount: row.fiat_amount } : {}),
    ...(settlement ? { settlement } : {}),
    ...(cryptoDeposit ? { cryptoDeposit } : {}),
    ...(moneygram ? { moneygram } : {}),
  };
}

export function mapCollectionAttemptRow(
  row: PaymentSubscriptionCollectionAttemptRow
): PaymentSubscriptionCollectionAttempt {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    subscriptionId: row.subscription_id,
    transferId: row.transfer_id,
    token: row.token,
    amount: row.amount,
    dueAt: row.due_at,
    attemptedAt: row.attempted_at,
    status: row.status,
    signature: row.signature,
    error: row.error,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
