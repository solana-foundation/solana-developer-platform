"use client";

import {
  PAYMENT_TRANSFER_STATUSES,
  type PaymentTransferStatus,
  type UnifiedTransaction,
  type UnifiedTransactionStatus,
} from "@sdp/types";
import type { StatusTone } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { statusMessageKey } from "../payments-overview.utils";
import { PAYMENT_STATUS_TONE } from "../payments-presentation";

const UNIFIED_STATUS_TONE = {
  pending: "attention",
  succeeded: "positive",
  failed: "critical",
  canceled: "neutral",
} as const satisfies Record<UnifiedTransactionStatus, StatusTone>;

export function isPaymentTransferStatus(status: string): status is PaymentTransferStatus {
  return PAYMENT_TRANSFER_STATUSES.some((candidate) => candidate === status);
}

/**
 * A row's status in words and tone. Payments rows keep their own state ("Settling",
 * "Awaiting payment"); other modules read by the ledger's four-way status, since their module
 * states have no copy here.
 */
export function useTransactionStatus() {
  const t = useTranslations();
  return (transaction: UnifiedTransaction): { label: string; tone: StatusTone } =>
    transaction.module === "payments" && isPaymentTransferStatus(transaction.moduleStatus)
      ? {
          label: t(statusMessageKey(transaction.moduleStatus)),
          tone: PAYMENT_STATUS_TONE[transaction.moduleStatus],
        }
      : {
          label: t(`DashboardPayments.transactions.statuses.${transaction.status}` as MessageKey),
          tone: UNIFIED_STATUS_TONE[transaction.status],
        };
}

export function kindLabel(t: ReturnType<typeof useTranslations>, transaction: UnifiedTransaction) {
  return t(
    `DashboardPayments.transactions.kinds.${transaction.module}.${transaction.kind}` as MessageKey
  );
}
