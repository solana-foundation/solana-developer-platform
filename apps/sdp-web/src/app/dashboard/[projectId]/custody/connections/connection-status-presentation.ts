import type { CustodyConnectionFailureCode, CustodyConnectionLifecycle } from "@sdp/types";
import type { BadgeVariant } from "@/components/ui/badge";
import type { useTranslations } from "@/i18n/provider";

/**
 * The lookups and copy behind the status cell, kept out of the component file
 * so Fast Refresh can preserve state there. Colour is status only: no lifecycle
 * gets a tint it has not earned, and `deactivated` is deliberately neutral
 * rather than red — it is a finished state, not a fault.
 */
export const STATUS_BADGE_VARIANTS: Record<CustodyConnectionLifecycle, BadgeVariant> = {
  pending: "warning",
  checking: "info",
  active: "success",
  failed: "danger",
  deactivated: "outline",
};

type Translate = ReturnType<typeof useTranslations>;

export function statusLabel(status: CustodyConnectionLifecycle, t: Translate): string {
  switch (status) {
    case "pending":
      return t("DashboardCustody.connectionStatusPending");
    case "checking":
      return t("DashboardCustody.connectionStatusChecking");
    case "active":
      return t("DashboardCustody.connectionStatusActive");
    case "failed":
      return t("DashboardCustody.connectionStatusFailed");
    case "deactivated":
      return t("DashboardCustody.connectionStatusDeactivated");
  }
}

/**
 * Short, secret-free explanation for a conclusively failed install. Codes come
 * from the installation service; anything unrecognized gets the generic line.
 */
export function failureHint(
  failureCode: CustodyConnectionFailureCode | null,
  t: Translate
): string {
  switch (failureCode) {
    case "invalid_credentials":
      return t("DashboardCustody.connectionFailureInvalidCredentials");
    case "provider_account_already_connected":
      return t("DashboardCustody.connectionFailureAccountAlreadyConnected");
    case "wallet_conflict":
      return t("DashboardCustody.connectionFailureWalletConflict");
    case "provider_response_unknown":
    case null:
      return t("DashboardCustody.connectionFailureGeneric");
    default: {
      const exhaustive: never = failureCode;
      return exhaustive;
    }
  }
}
