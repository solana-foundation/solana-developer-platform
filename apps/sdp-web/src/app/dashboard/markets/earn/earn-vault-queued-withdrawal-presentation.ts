import type { EarnVaultWithdrawalRequestStatus } from "@sdp/types";
import type { BadgeVariant } from "@/components/ui/badge";
import type { MessageKey } from "@/i18n/messages";

export interface EarnVaultQueuedWithdrawalStatusPresentation {
  bodyKey: MessageKey;
  labelKey: MessageKey;
  variant: BadgeVariant;
  tone: "success" | "warning";
  terminal: boolean;
  awaitingProvider: boolean;
}

/** Queue-specific states and copy, shared by every queue mechanism surface. */
const QUEUED_STATUS_PRESENTATION = {
  creating: {
    bodyKey: "DashboardEarn.queuedWithdraw.creatingBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusCreating",
    variant: "default",
    tone: "warning",
    terminal: false,
    awaitingProvider: false,
  },
  pending: {
    bodyKey: "DashboardEarn.queuedWithdraw.pendingBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusPending",
    variant: "default",
    tone: "warning",
    terminal: false,
    awaitingProvider: true,
  },
  fulfillable: {
    bodyKey: "DashboardEarn.queuedWithdraw.pendingBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusPending",
    variant: "default",
    tone: "warning",
    terminal: false,
    awaitingProvider: true,
  },
  expiredCancelable: {
    bodyKey: "DashboardEarn.queuedWithdraw.pendingBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusRecoverable",
    variant: "warning",
    tone: "warning",
    terminal: false,
    awaitingProvider: false,
  },
  cancelling: {
    bodyKey: "DashboardEarn.queuedWithdraw.pendingBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusCancelling",
    variant: "default",
    tone: "warning",
    terminal: false,
    awaitingProvider: false,
  },
  fulfilled: {
    bodyKey: "DashboardEarn.queuedWithdraw.fulfilledBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusFulfilled",
    variant: "success",
    tone: "success",
    terminal: true,
    awaitingProvider: false,
  },
  cancelled: {
    bodyKey: "DashboardEarn.queuedWithdraw.cancelledBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusCancelled",
    variant: "outline",
    tone: "success",
    terminal: true,
    awaitingProvider: false,
  },
  closedOrUnknown: {
    bodyKey: "DashboardEarn.queuedWithdraw.closedOrUnknownBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusChecking",
    variant: "warning",
    tone: "warning",
    terminal: false,
    awaitingProvider: false,
  },
  failed: {
    bodyKey: "DashboardEarn.queuedWithdraw.failedBody",
    labelKey: "DashboardEarn.queuedWithdraw.statusFailed",
    variant: "danger",
    tone: "warning",
    terminal: true,
    awaitingProvider: false,
  },
} as const satisfies Record<
  EarnVaultWithdrawalRequestStatus,
  EarnVaultQueuedWithdrawalStatusPresentation
>;

export function earnVaultQueuedWithdrawalStatusPresentation(
  status: EarnVaultWithdrawalRequestStatus
): EarnVaultQueuedWithdrawalStatusPresentation {
  return QUEUED_STATUS_PRESENTATION[status];
}

export function isEarnVaultQueuedWithdrawalTerminal(
  status: EarnVaultWithdrawalRequestStatus
): boolean {
  return QUEUED_STATUS_PRESENTATION[status].terminal;
}
