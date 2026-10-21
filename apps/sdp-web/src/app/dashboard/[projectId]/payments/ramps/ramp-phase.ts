import type {
  PaymentTransferSummary,
  RampDeliveryMismatchReason,
  RampDirection,
} from "@sdp/types/payments";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { formatDecimalAmount } from "@/app/dashboard/[projectId]/payments/payments-presentation";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { getRampProviderLabel } from "@/lib/ramps";
import { getRampTransferState } from "./ramp-transfer-state";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/** Whose move it is, or how a finished ramp ended; each surface picks its icon from it. */
export type RampPhaseTone = "action" | "progress" | "attention" | "success" | "error";

export type RampPhaseKind =
  | "checkout"
  | "awaiting_funds"
  | "ready_to_send"
  | "awaiting_instruction"
  | "sending_deposit"
  | "provider_delivering"
  | "confirming_delivery"
  | "paying_out"
  | "payout_reported"
  | "needs_review"
  | "completed"
  | "failed"
  | "expired"
  | "canceled"
  | "unknown";

const PHASE_TONE = {
  checkout: "action",
  awaiting_funds: "action",
  ready_to_send: "action",
  awaiting_instruction: "progress",
  sending_deposit: "progress",
  provider_delivering: "progress",
  confirming_delivery: "progress",
  paying_out: "progress",
  payout_reported: "progress",
  needs_review: "attention",
  completed: "success",
  failed: "error",
  expired: "error",
  canceled: "error",
  unknown: "progress",
} as const satisfies Record<RampPhaseKind, RampPhaseTone>;

export interface RampPhase {
  kind: RampPhaseKind;
  tone: RampPhaseTone;
}

function phase(kind: RampPhaseKind): RampPhase {
  return { kind, tone: PHASE_TONE[kind] };
}

/** The customer acts inside a provider window rather than on copied instructions. */
function paysInProviderWindow(transfer: PaymentTransferSummary, hosted: boolean): boolean {
  return hosted || transfer.deliveryMode === "hosted" || transfer.deliveryMode === "session_widget";
}

/**
 * Where a ramp transfer stands, read from the whole transfer so the wizard,
 * the detail page and the receipt say the same thing. A provider's report
 * alone never reads as done: only `completed`, which SDP writes after it
 * verifies the delivery onchain, does.
 *
 * @param transfer - The ramp transfer as the API returns it.
 * @param hosted - The caller knows the customer pays in a provider window.
 * @returns The phase and its tone.
 */
export function rampPhase(transfer: PaymentTransferSummary, hosted = false): RampPhase {
  const offramp = transfer.type === "offramp";
  if (transfer.deliveryMismatch) return phase("needs_review");
  switch (transfer.status) {
    case "pending":
      return phase(
        offramp || paysInProviderWindow(transfer, hosted) ? "checkout" : "awaiting_funds"
      );
    case "awaiting_payment":
      if (offramp) return phase(transfer.cryptoDeposit ? "ready_to_send" : "awaiting_instruction");
      return phase(paysInProviderWindow(transfer, hosted) ? "checkout" : "awaiting_funds");
    case "processing":
      return phase(offramp ? "sending_deposit" : "provider_delivering");
    // A settling on-ramp carries the provider's delivery signature once the provider reports
    // the tokens sent; until SDP verifies that transaction, it is still confirming.
    case "settling":
      if (offramp) return phase(transfer.fiatPayout ? "payout_reported" : "paying_out");
      return phase(transfer.signature ? "confirming_delivery" : "provider_delivering");
    case "completed":
      return phase("completed");
    case "failed":
      return phase("failed");
    case "expired":
      return phase("expired");
    case "canceled":
      return phase("canceled");
    // Wallet-send statuses: no writer puts a ramp row in either.
    case "confirmed":
    case "finalized":
      return phase("unknown");
    default: {
      const unhandled: never = transfer.status;
      throw new Error(`Unhandled ramp transfer status: ${String(unhandled)}`);
    }
  }
}

/** How long to wait between reads in each phase; a final transfer is never read again. */
const PHASE_POLL_INTERVAL_MS = {
  checkout: 3_000,
  awaiting_funds: 3_000,
  ready_to_send: 3_000,
  awaiting_instruction: 3_000,
  sending_deposit: 3_000,
  provider_delivering: 3_000,
  confirming_delivery: 3_000,
  paying_out: 15_000,
  payout_reported: 3_000,
  needs_review: 30_000,
  completed: 0,
  failed: 0,
  expired: 0,
  canceled: 0,
  unknown: 3_000,
} as const satisfies Record<RampPhaseKind, number>;

/**
 * How often to read a ramp transfer while it can still change: quickly while
 * a person or the chain is about to act, slowly through a bank payout or a
 * hold that only a new provider report clears, never once it is final.
 */
export function rampTransferPollInterval(transfer: PaymentTransferSummary | undefined): number {
  if (!transfer) return 3_000;
  if (getRampTransferState(transfer.status).terminal) return 0;
  return PHASE_POLL_INTERVAL_MS[rampPhase(transfer).kind];
}

type PhaseCopyKeys = { title: MessageKey; description: MessageKey };

const BUY_COPY = {
  checkout: {
    title: "DashboardPayments.ramps.phase.buy.checkoutTitle",
    description: "DashboardPayments.ramps.phase.buy.checkoutDescription",
  },
  awaiting_funds: {
    title: "DashboardPayments.ramps.phase.buy.awaitingFundsTitle",
    description: "DashboardPayments.ramps.phase.buy.awaitingFundsDescription",
  },
  provider_delivering: {
    title: "DashboardPayments.ramps.phase.buy.providerDeliveringTitle",
    description: "DashboardPayments.ramps.phase.buy.providerDeliveringDescription",
  },
  confirming_delivery: {
    title: "DashboardPayments.ramps.phase.buy.confirmingDeliveryTitle",
    description: "DashboardPayments.ramps.phase.buy.confirmingDeliveryDescription",
  },
  completed: {
    title: "DashboardPayments.ramps.phase.buy.completedTitle",
    description: "DashboardPayments.ramps.phase.buy.completedDescription",
  },
  failed: {
    title: "DashboardPayments.ramps.phase.buy.failedTitle",
    description: "DashboardPayments.ramps.phase.buy.failedDescription",
  },
  expired: {
    title: "DashboardPayments.ramps.status.quoteExpired",
    description: "DashboardPayments.ramps.status.quoteExpiredFundingDescription",
  },
  canceled: {
    title: "DashboardPayments.ramps.status.canceled",
    description: "DashboardPayments.ramps.status.canceledFundingDescription",
  },
} as const satisfies Partial<Record<RampPhaseKind, PhaseCopyKeys>>;

const SELL_COPY = {
  checkout: {
    title: "DashboardPayments.ramps.phase.sell.checkoutTitle",
    description: "DashboardPayments.ramps.phase.sell.checkoutDescription",
  },
  ready_to_send: {
    title: "DashboardPayments.ramps.phase.sell.readyToSendTitle",
    description: "DashboardPayments.ramps.phase.sell.readyToSendDescription",
  },
  awaiting_instruction: {
    title: "DashboardPayments.ramps.phase.sell.awaitingInstructionTitle",
    description: "DashboardPayments.ramps.phase.sell.awaitingInstructionDescription",
  },
  sending_deposit: {
    title: "DashboardPayments.ramps.phase.sell.sendingDepositTitle",
    description: "DashboardPayments.ramps.phase.sell.sendingDepositDescription",
  },
  paying_out: {
    title: "DashboardPayments.ramps.phase.sell.payingOutTitle",
    description: "DashboardPayments.ramps.phase.sell.payingOutDescription",
  },
  payout_reported: {
    title: "DashboardPayments.ramps.phase.sell.payoutReportedTitle",
    description: "DashboardPayments.ramps.phase.sell.payoutReportedDescription",
  },
  completed: {
    title: "DashboardPayments.ramps.phase.sell.completedTitle",
    description: "DashboardPayments.ramps.phase.sell.completedDescription",
  },
  failed: {
    title: "DashboardPayments.ramps.phase.sell.failedTitle",
    description: "DashboardPayments.ramps.phase.sell.failedDescription",
  },
  expired: {
    title: "DashboardPayments.ramps.status.quoteExpired",
    description: "DashboardPayments.ramps.status.quoteExpiredPayoutDescription",
  },
  canceled: {
    title: "DashboardPayments.ramps.status.canceled",
    description: "DashboardPayments.ramps.status.canceledPayoutDescription",
  },
} as const satisfies Partial<Record<RampPhaseKind, PhaseCopyKeys>>;

const REVIEW_COPY = {
  onramp: {
    title: "DashboardPayments.ramps.phase.review.buyTitle",
    reasons: {
      provider_report_mismatch: "DashboardPayments.ramps.phase.review.buyReportMismatch",
      transaction_failed: "DashboardPayments.ramps.phase.review.buyTransactionFailed",
      predates_transfer: "DashboardPayments.ramps.phase.review.buyPredatesTransfer",
      not_delivered: "DashboardPayments.ramps.phase.review.buyNotDelivered",
      amount_mismatch: "DashboardPayments.ramps.phase.review.buyAmountMismatch",
      transaction_not_found: "DashboardPayments.ramps.phase.review.buyNotFound",
    },
  },
  offramp: {
    title: "DashboardPayments.ramps.phase.review.sellTitle",
    reasons: {
      provider_report_mismatch: "DashboardPayments.ramps.phase.review.sellReportMismatch",
      transaction_failed: "DashboardPayments.ramps.phase.review.sellTransactionFailed",
      predates_transfer: "DashboardPayments.ramps.phase.review.sellReportMismatch",
      not_delivered: "DashboardPayments.ramps.phase.review.sellReportMismatch",
      amount_mismatch: "DashboardPayments.ramps.phase.review.sellReportMismatch",
      transaction_not_found: "DashboardPayments.ramps.phase.review.sellReportMismatch",
    },
  },
} as const satisfies Record<
  RampDirection,
  { title: MessageKey; reasons: Record<RampDeliveryMismatchReason, MessageKey> }
>;

export interface RampPhaseCopy extends RampPhase {
  title: string;
  description: string;
}

/**
 * The phase in words, for the wizard's status, the detail page and the receipt.
 *
 * @param t - Translator.
 * @param transfer - The ramp transfer as the API returns it.
 * @param options - The asset's label when the caller knows it, the locale, and the hosted flag.
 * @returns The phase with its title and description.
 */
export function rampPhaseCopy(
  t: Translate,
  transfer: PaymentTransferSummary,
  options: { tokenLabel?: string | null; locale?: string; hosted?: boolean } = {}
): RampPhaseCopy {
  const current = rampPhase(transfer, options.hosted);
  const direction: RampDirection = transfer.type === "offramp" ? "offramp" : "onramp";
  const provider = transfer.provider
    ? getRampProviderLabel(transfer.provider)
    : t("DashboardPayments.ramps.phase.providerFallback");
  const token =
    options.tokenLabel ||
    (transfer.token ? WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token)?.symbol : undefined) ||
    t("DashboardPayments.transactionDetail.theTokens");
  // Every digit: a review compares amounts that may differ past six places.
  const amountOf = (value: string | undefined, unit: string) =>
    value === undefined ? null : `${formatDecimalAmount(value, options.locale)} ${unit}`;
  const values: TranslationValues = {
    provider,
    token,
    amount: amountOf(transfer.cryptoDeposit?.amount, token) ?? token,
    payout: transfer.fiatPayout
      ? (amountOf(transfer.fiatPayout.amount, transfer.fiatPayout.currency) ?? "")
      : "",
  };

  if (current.kind === "needs_review" && transfer.deliveryMismatch) {
    const mismatch = transfer.deliveryMismatch;
    const copy = REVIEW_COPY[direction];
    const withAmounts =
      mismatch.reason === "amount_mismatch" &&
      direction === "onramp" &&
      mismatch.reportedAmount !== undefined &&
      mismatch.observedAmount !== undefined;
    return {
      ...current,
      title: t(copy.title),
      description: withAmounts
        ? t("DashboardPayments.ramps.phase.review.buyAmountMismatchAmounts", {
            ...values,
            reported: amountOf(mismatch.reportedAmount, token) ?? "",
            observed: amountOf(mismatch.observedAmount, token) ?? "",
          })
        : t(copy.reasons[mismatch.reason], values),
    };
  }

  const table: Partial<Record<RampPhaseKind, PhaseCopyKeys>> =
    direction === "offramp" ? SELL_COPY : BUY_COPY;
  const keys = table[current.kind];
  if (!keys) {
    return {
      ...current,
      title: t("DashboardPayments.ramps.status.updated"),
      description: t("DashboardPayments.ramps.status.currentProviderStatus", {
        status: transfer.status,
      }),
    };
  }
  const reason = current.kind === "failed" ? transfer.error?.trim() : undefined;
  if (reason) {
    return {
      ...current,
      title: t(keys.title, values),
      description: t(
        direction === "offramp"
          ? "DashboardPayments.ramps.phase.sell.failedWithReasonDescription"
          : "DashboardPayments.ramps.phase.buy.failedWithReasonDescription",
        { ...values, reason }
      ),
    };
  }
  const paidOut = current.kind === "completed" && direction === "offramp" && transfer.fiatPayout;
  return {
    ...current,
    title: t(keys.title, values),
    description: paidOut
      ? t("DashboardPayments.ramps.phase.sell.completedWithPayoutDescription", values)
      : t(keys.description, values),
  };
}
