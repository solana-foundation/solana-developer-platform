"use client";

import type { CustodyConnectionFailureCode, CustodyConnectionLifecycle } from "@sdp/types";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";

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

/**
 * Whether signing currently runs through this connection, as a line of its own.
 *
 * This is a different fact from the connection's lifecycle status and has to
 * read as one: an entitlement change or a runtime flag can stop signing while
 * the connection stays perfectly Active, and a single merged badge would make
 * that look like the connection had been removed. Only an active connection
 * makes the claim at all — on a pending or failed one there is nothing yet to
 * pause.
 *
 * @param status - The connection's lifecycle status.
 * @param isRuntimeExecutionAllowed - Whether the API would sign through it now.
 */
export function SigningLine({
  status,
  isRuntimeExecutionAllowed,
}: {
  status: CustodyConnectionLifecycle;
  isRuntimeExecutionAllowed: boolean;
}) {
  const t = useTranslations();
  if (status !== "active") {
    return null;
  }
  return (
    <span
      className={`mt-1 block text-[11px] ${
        isRuntimeExecutionAllowed ? "text-tertiary" : "text-warning"
      }`}
      data-signing-state={isRuntimeExecutionAllowed ? "allowed" : "paused"}
    >
      {isRuntimeExecutionAllowed
        ? t("DashboardCustody.connectionSigningAllowed")
        : t("DashboardCustody.connectionSigningPaused")}
    </span>
  );
}

/** Status badge plus whichever explanatory line the state earns. */
export function ConnectionStatusCell({
  status,
  failureCode,
  isRuntimeExecutionAllowed,
}: {
  status: CustodyConnectionLifecycle;
  failureCode: CustodyConnectionFailureCode | null;
  isRuntimeExecutionAllowed: boolean;
}) {
  const t = useTranslations();
  return (
    <>
      <Badge variant={STATUS_BADGE_VARIANTS[status]}>{statusLabel(status, t)}</Badge>
      {status === "failed" ? (
        <span className="mt-1 block text-[11px] text-tertiary">{failureHint(failureCode, t)}</span>
      ) : null}
      <SigningLine status={status} isRuntimeExecutionAllowed={isRuntimeExecutionAllowed} />
    </>
  );
}
