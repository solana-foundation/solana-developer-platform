import type {
  PaymentTransferBatch,
  PaymentTransferRecipient,
  PaymentTransferStatus,
  PaymentTransferSummary,
} from "@sdp/types";
import type { StatusTone } from "@/components/ui/status-text";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

/**
 * How each transfer status reads in a refresh list. Finer than the shared success / pending /
 * danger / neutral tone: a transfer the rails are moving ("processing", "settling") is
 * progress, while one waiting on a person or a payer ("pending", "awaiting payment") needs
 * attention.
 */
export const PAYMENT_STATUS_TONE = {
  pending: "attention",
  processing: "progress",
  confirmed: "positive",
  finalized: "positive",
  failed: "critical",
  awaiting_payment: "attention",
  settling: "progress",
  completed: "positive",
  canceled: "neutral",
  expired: "neutral",
} as const satisfies Record<PaymentTransferStatus, StatusTone>;

export type ActivityKind = "pay" | "deposit" | "transfer" | "batch";

/**
 * The one word a Payments activity row leads with. Kinds the ledger names win; older rows
 * without a kind fall back to their type and direction.
 *
 * @param transfer - The transfer summary.
 * @returns What kind of movement the row is.
 */
export function activityKind(
  transfer: Pick<PaymentTransferSummary, "kind" | "type" | "direction">
): ActivityKind {
  switch (transfer.kind) {
    case "batch_pay":
      return "batch";
    case "pay":
    case "confidential_pay":
    case "recurring_pay":
    case "offramp":
      return "pay";
    case "deposit":
    case "request_deposit":
    case "onramp":
      return "deposit";
    default:
      break;
  }
  if (transfer.type === "transfer_batch") return "batch";
  if (transfer.type === "onramp") return "deposit";
  if (transfer.type === "offramp") return "pay";
  return transfer.direction === "inbound" ? "deposit" : "transfer";
}

export const ACTIVITY_KIND_MESSAGE_KEYS = {
  pay: "DashboardPayments.activityKind.pay",
  deposit: "DashboardPayments.activityKind.deposit",
  transfer: "DashboardPayments.activityKind.transfer",
  batch: "DashboardPayments.activityKind.batch",
} as const satisfies Record<ActivityKind, MessageKey>;

/**
 * A decimal amount with grouping and at least two fraction digits ("12,000.00"), keeping up
 * to nine (the most an SPL token carries) so no nonzero amount rounds to "0.00". Non-numeric
 * input passes through.
 *
 * @param value - Decimal string.
 * @param locale - Formatting locale.
 * @returns The formatted amount.
 */
export function formatDecimalAmount(value: string, locale?: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  }).format(numeric);
}

/**
 * An amount with the sign of its direction and its asset: "+18.40 SOL", "−2,400.00 USDC".
 * Uses the typographic minus so signed columns align.
 *
 * @param amount - Unsigned or signed decimal string.
 * @param direction - "inbound" signs +, "outbound" signs −, anything else is unsigned.
 * @param asset - Asset label appended after a space, when known.
 * @param locale - Formatting locale.
 * @returns The signed amount, or null without an amount.
 */
export function formatSignedAmount(
  amount: string | undefined,
  direction: "inbound" | "outbound" | undefined,
  asset: string | undefined,
  locale?: string
): string | null {
  if (!amount) return null;
  const unsigned = formatDecimalAmount(amount.replace(/^[-+]/, ""), locale);
  const sign = direction === "inbound" ? "+" : direction === "outbound" ? "−" : "";
  return `${sign}${unsigned}${asset ? ` ${asset}` : ""}`;
}

const ELAPSED_UNITS = [
  { unit: "minute", ms: 60_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "day", ms: 86_400_000 },
] as const;

/**
 * How long ago, in one narrow unit: "2m", "3h", "5d" (locale-aware). Under a minute reads
 * as "1m"; a week or more, and anything in the future, reads as a short date.
 *
 * @param iso - ISO timestamp.
 * @param locale - Formatting locale.
 * @param now - Reference time, for tests.
 * @returns The elapsed label, or null for a missing or invalid timestamp.
 */
export function formatElapsedShort(
  iso: string | undefined,
  locale?: string,
  now: number = Date.now()
): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  const elapsed = now - time;
  if (elapsed < 0 || elapsed >= 7 * 86_400_000) {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(time);
  }
  const { unit, ms } =
    [...ELAPSED_UNITS].reverse().find((candidate) => elapsed >= candidate.ms) ?? ELAPSED_UNITS[0];
  const value = Math.max(1, Math.floor(elapsed / ms));
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(
    value
  );
}

export interface BatchSummary {
  key: MessageKey;
  values: TranslationValues;
  tone: StatusTone;
}

/**
 * What a batch row says about its payments. With recipients it counts them ("1 of 8 failed",
 * "18 of 40 confirmed"); without, it reads the batch's own status, which cannot say how many.
 *
 * @param batch - The batch.
 * @param recipients - The batch's recipients, when they were fetched.
 * @returns The message, its values and its tone.
 */
export function summarizeBatch(
  batch: Pick<PaymentTransferBatch, "status" | "recipientCount">,
  recipients?: readonly Pick<PaymentTransferRecipient, "status">[]
): BatchSummary {
  const count = recipients?.length ?? batch.recipientCount;
  if (batch.status === "archived") {
    return { key: "DashboardPayments.batchSummary.archived", values: { count }, tone: "neutral" };
  }
  if (recipients && recipients.length > 0) {
    const failed = recipients.filter((recipient) => recipient.status === "failed").length;
    const confirmed = recipients.filter((recipient) => recipient.status === "confirmed").length;
    if (failed === count) {
      return {
        key: "DashboardPayments.batchSummary.allFailed",
        values: { count },
        tone: "critical",
      };
    }
    if (failed > 0) {
      return {
        key: "DashboardPayments.batchSummary.someFailed",
        values: { failed, count },
        tone: "attention",
      };
    }
    if (confirmed === count) {
      return {
        key: "DashboardPayments.batchSummary.allSettled",
        values: { count },
        tone: "positive",
      };
    }
    return {
      key: "DashboardPayments.batchSummary.confirmedOf",
      values: { confirmed, count },
      tone: "progress",
    };
  }
  switch (batch.status) {
    case "confirmed":
      return {
        key: "DashboardPayments.batchSummary.allSettled",
        values: { count },
        tone: "positive",
      };
    case "failed":
      return {
        key: "DashboardPayments.batchSummary.allFailed",
        values: { count },
        tone: "critical",
      };
    case "partially_failed":
      return {
        key: "DashboardPayments.batchSummary.partiallyFailed",
        values: { count },
        tone: "attention",
      };
    case "processing":
      return { key: "DashboardPayments.batchSummary.sending", values: { count }, tone: "progress" };
    default:
      return {
        key: "DashboardPayments.batchSummary.pending",
        values: { count },
        tone: "attention",
      };
  }
}

/**
 * A list's created-at cell: "Aug 22, 2026, 10:18 AM".
 *
 * @param iso - ISO timestamp.
 * @param locale - Formatting locale.
 * @returns The formatted date and time, or null for a missing or invalid timestamp.
 */
export function formatDateTime(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(time);
}

/**
 * A list's date-only cell: "Aug 5, 2026".
 *
 * @param iso - ISO timestamp.
 * @param locale - Formatting locale.
 * @returns The formatted date, or null for a missing or invalid timestamp.
 */
export function formatDate(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(time);
}
