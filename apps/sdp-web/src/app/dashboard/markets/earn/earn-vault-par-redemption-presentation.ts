import type {
  EarnVaultWithdrawalRequestRecord,
  EarnVaultWithdrawalRequestStatus,
} from "@sdp/types";
import type { BadgeVariant } from "@/components/ui/badge";
import type { MessageKey } from "@/i18n/messages";

export interface EarnVaultParRedemptionStatusPresentation {
  bodyKey: MessageKey;
  labelKey: MessageKey;
  variant: BadgeVariant;
  tone: "success" | "warning";
  terminal: boolean;
}

const PAR_REDEMPTION_STATUS_PRESENTATION = {
  creating: {
    bodyKey: "DashboardEarn.parRedemption.creatingBody",
    labelKey: "DashboardEarn.parRedemption.statusCreating",
    variant: "default",
    tone: "warning",
    terminal: false,
  },
  pending: {
    bodyKey: "DashboardEarn.parRedemption.pendingBody",
    labelKey: "DashboardEarn.parRedemption.statusPending",
    variant: "default",
    tone: "warning",
    terminal: false,
  },
  fulfillable: {
    bodyKey: "DashboardEarn.parRedemption.pendingBody",
    labelKey: "DashboardEarn.parRedemption.statusPending",
    variant: "default",
    tone: "warning",
    terminal: false,
  },
  expiredCancelable: {
    bodyKey: "DashboardEarn.parRedemption.pendingBody",
    labelKey: "DashboardEarn.parRedemption.statusPending",
    variant: "warning",
    tone: "warning",
    terminal: false,
  },
  cancelling: {
    bodyKey: "DashboardEarn.parRedemption.cancellingBody",
    labelKey: "DashboardEarn.parRedemption.statusCancelling",
    variant: "default",
    tone: "warning",
    terminal: false,
  },
  fulfilled: {
    bodyKey: "DashboardEarn.parRedemption.fulfilledBody",
    labelKey: "DashboardEarn.parRedemption.statusFulfilled",
    variant: "success",
    tone: "success",
    terminal: true,
  },
  cancelled: {
    bodyKey: "DashboardEarn.parRedemption.cancelledBody",
    labelKey: "DashboardEarn.parRedemption.statusCancelled",
    variant: "outline",
    tone: "success",
    terminal: true,
  },
  closedOrUnknown: {
    bodyKey: "DashboardEarn.parRedemption.closedOrUnknownBody",
    labelKey: "DashboardEarn.parRedemption.statusChecking",
    variant: "warning",
    tone: "warning",
    terminal: false,
  },
  failed: {
    bodyKey: "DashboardEarn.parRedemption.failedBody",
    labelKey: "DashboardEarn.parRedemption.statusFailed",
    variant: "danger",
    tone: "warning",
    terminal: true,
  },
} as const satisfies Record<
  EarnVaultWithdrawalRequestStatus,
  EarnVaultParRedemptionStatusPresentation
>;

export function earnVaultParRedemptionStatusPresentation(
  status: EarnVaultWithdrawalRequestStatus
): EarnVaultParRedemptionStatusPresentation {
  return PAR_REDEMPTION_STATUS_PRESENTATION[status];
}

export function isEarnVaultParRedemptionTerminal(status: EarnVaultWithdrawalRequestStatus) {
  return PAR_REDEMPTION_STATUS_PRESENTATION[status].terminal;
}

/** Hastra permits the owner to close a live operator request before fulfillment. */
export function isEarnVaultParRedemptionCancelable(
  request: Pick<EarnVaultWithdrawalRequestRecord, "mechanism" | "status">
): boolean {
  return request.mechanism === "operatorRedemption" && request.status === "pending";
}
