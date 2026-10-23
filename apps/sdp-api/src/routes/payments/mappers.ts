import { formatDecimalAmount } from "@sdp/solana/amount";
import type { MovementQuote } from "@sdp/solana/movement-quote";
import { displayUnder } from "@sdp/solana/token-terms";
import {
  isRampTransferType,
  type PaymentSubscriptionCollectionAttempt,
  type RampCryptoDeposit,
  type RampFiatPayout,
  type RampTransferSettlement,
} from "@sdp/types/payments";
import { isRetiredRampProviderId, type PersistedRampProviderId } from "@sdp/types/provider-access";
import type {
  AmountVerification,
  AmountVerificationState,
  TokenMovementAmounts,
} from "@sdp/types/token-movements";
import type { PaymentSubscriptionCollectionAttemptRow } from "@/db/repositories/payment-subscriptions.repository";
import type { PaymentTransferRow as TransferRow } from "@/db/repositories/payments.repository";
import {
  type LegTotals,
  legTotals,
  type TokenMovementLeg,
} from "@/db/repositories/token-movement-legs.repository";
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

/** Which leg state a summary of several legs reports: the first in this order any leg is in. */
const VERIFICATION_SUMMARY_ORDER = [
  "mismatch",
  "pending",
  "verified",
  "not_required",
] as const satisfies readonly AmountVerificationState[];

/** Summed amounts in token units, with no display: a sum shows no single wallet's view. */
export function totalsAmounts(totals: LegTotals): TokenMovementAmounts {
  return {
    basis: totals.basis,
    debit: formatDecimalAmount(totals.debit, totals.decimals),
    fee: formatDecimalAmount(totals.fee, totals.decimals),
    credit: formatDecimalAmount(totals.credit, totals.decimals),
    decimals: totals.decimals,
  };
}

/**
 * The summed amounts of quotes of one movement, such as a batch estimate's.
 *
 * @throws AppError (500) when the quotes disagree on basis or decimals.
 */
export function quotedAmounts(quotes: readonly MovementQuote[]): TokenMovementAmounts {
  const [first] = quotes;
  if (first === undefined) {
    throw new AppError("INTERNAL_ERROR", "A movement has at least one quote");
  }
  if (
    quotes.some(
      (quote) => quote.intent.basis !== first.intent.basis || quote.decimals !== first.decimals
    )
  ) {
    throw new AppError("INTERNAL_ERROR", "Movement quotes disagree on basis or decimals");
  }
  const sum = (part: "debit" | "fee" | "credit") =>
    quotes.reduce((total, quote) => total + quote[part], 0n);
  return totalsAmounts({
    basis: first.intent.basis,
    decimals: first.decimals,
    debit: sum("debit"),
    fee: sum("fee"),
    credit: sum("credit"),
  });
}

/**
 * What a movement moves, in token units, summed over its legs: one leg for a
 * transfer, a chunk's recipients otherwise. Display values are shown for one
 * leg of a scaled or interest-bearing mint only.
 *
 * @throws Error when the legs disagree on basis or decimals: they are not one movement.
 */
export function movementAmounts(
  legs: readonly [TokenMovementLeg, ...TokenMovementLeg[]]
): TokenMovementAmounts {
  const amounts = totalsAmounts(legTotals(legs));
  const [first, ...rest] = legs;
  if (rest.length === 0 && first.displayRule !== null && first.asOf !== null) {
    const { displayRule, asOf, quoted } = first;
    const shown = (part: "debit" | "fee" | "credit") =>
      displayUnder(displayRule, first.decimals, quoted[part], asOf.unixTimestamp).value;
    amounts.display = {
      debit: shown("debit"),
      fee: shown("fee"),
      credit: shown("credit"),
      asOf: new Date(Number(asOf.unixTimestamp) * 1000).toISOString(),
    };
  }
  return amounts;
}

/** Whether SDP has checked what the legs moved, summarized over the legs. */
export function movementVerification(
  legs: readonly [TokenMovementLeg, ...TokenMovementLeg[]]
): AmountVerification {
  const state = VERIFICATION_SUMMARY_ORDER.find((candidate) =>
    legs.some((leg) => leg.verification.state === candidate)
  );
  const reporting = legs.find((leg) => leg.verification.state === state);
  if (state === undefined || reporting === undefined) {
    throw new AppError("INTERNAL_ERROR", "Movement leg has an unknown verification state");
  }
  const verification: AmountVerification = { state };
  if (reporting.verification.reason !== null) {
    verification.reason = reporting.verification.reason;
  }
  return verification;
}

/** The movement fields a row's legs add; a row with no leg (legacy) adds none. */
export interface MovementFields {
  amounts?: TokenMovementAmounts;
  amountVerification?: AmountVerification;
}

/** A transfer row with its legs' amounts and verification. */
export function mapTransferWithLegs(row: TransferRow, legs: readonly TokenMovementLeg[]) {
  const transfer: ReturnType<typeof mapTransferRow> & MovementFields = mapTransferRow(row);
  const [first, ...rest] = legs;
  if (first !== undefined) {
    transfer.amounts = movementAmounts([first, ...rest]);
    transfer.amountVerification = movementVerification([first, ...rest]);
  }
  return transfer;
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
