import {
  isRampTransferType,
  type PaymentSubscriptionCollectionAttempt,
  type RampCryptoDeposit,
  type RampFiatPayout,
  type RampTransferSettlement,
} from "@sdp/types/payments";
import { isRetiredRampProviderId, type PersistedRampProviderId } from "@sdp/types/provider-access";
import type { PaymentSubscriptionCollectionAttemptRow } from "@/db/repositories/payment-subscriptions.repository";
import type { PaymentTransferRow as TransferRow } from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import {
  currentProviderSettlement,
  readDeliveryMismatch,
} from "@/services/payments/ramp-provider-settlement";

/** The stored provider reference for a ramp transfer, including retired providers. */
function rampProviderReference(row: TransferRow): string | undefined {
  if (row.provider === null) {
    throw new AppError("INTERNAL_ERROR", "Ramp transfer is missing provider.");
  }
  return row.provider_reference ?? undefined;
}

/**
 * The settlement a ramp transfer row presents. A retired provider's settlement
 * shape left the response contract with its code, so its rows read without
 * one; the stored value stays in `provider_data`.
 *
 * @param provider - The transfer's ramp provider.
 * @param providerData - The transfer row's stored provider data.
 * @returns The settlement to present, or undefined when there is none to show.
 */
function rampTransferSettlement(
  provider: PersistedRampProviderId,
  providerData: TransferRow["provider_data"]
): RampTransferSettlement | undefined {
  if (isRetiredRampProviderId(provider)) {
    return undefined;
  }
  // SAFETY: `provider_data.settlement` is only ever written from a live
  // provider's typed settlement event (`applyRampSettlementEvent`).
  return providerData.settlement as RampTransferSettlement | undefined;
}

/**
 * The fiat an off-ramp's provider reports paying out, from its settlement for
 * the transfer's current reference. Omitted until the provider names both the
 * amount and its currency.
 */
function rampFiatPayout(row: TransferRow): RampFiatPayout | undefined {
  if (row.type !== "offramp") return undefined;
  const settled = currentProviderSettlement(row);
  if (settled?.receivedAmount === undefined || settled.receivedCurrency === undefined) {
    return undefined;
  }
  const payout: RampFiatPayout = {
    amount: settled.receivedAmount,
    currency: settled.receivedCurrency,
  };
  if (settled.observedAt) payout.reportedAt = settled.observedAt;
  return payout;
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
    confirmedAt: row.confirmed_at ?? undefined,
    fee: row.fee,
    error: row.error,
    fireblocks: row.provider_data.fireblocksTransfer
      ? {
          transactionId: row.provider_reference,
          status:
            typeof row.provider_data.fireblocksStatus === "string"
              ? row.provider_data.fireblocksStatus
              : "SUBMISSION_PENDING",
          subStatus:
            typeof row.provider_data.fireblocksSubStatus === "string"
              ? row.provider_data.fireblocksSubStatus
              : null,
        }
      : undefined,
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

  const settlement = rampTransferSettlement(row.provider, row.provider_data);
  const cryptoDeposit = row.provider_data.cryptoDeposit as RampCryptoDeposit | null | undefined;
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
    fiatPayout: rampFiatPayout(row),
    deliveryMismatch: readDeliveryMismatch(row.provider_data),
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
