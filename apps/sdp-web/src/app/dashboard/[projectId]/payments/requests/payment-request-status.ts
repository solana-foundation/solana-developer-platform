import type { PaymentRequestStatus } from "@sdp/types";
import type { StatusTone } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";

export const REQUEST_STATUS_TRANSLATION_KEYS = {
  awaiting_payment: "DashboardPayments.requests.awaitingPayment",
  paid: "DashboardPayments.requests.paid",
  canceled: "DashboardPayments.requests.canceled",
  expired: "DashboardPayments.requests.expired",
} as const satisfies Record<PaymentRequestStatus, MessageKey>;

export const REQUEST_STATUS_TONE = {
  paid: "positive",
  awaiting_payment: "attention",
  canceled: "neutral",
  expired: "neutral",
} as const satisfies Record<PaymentRequestStatus, StatusTone>;
