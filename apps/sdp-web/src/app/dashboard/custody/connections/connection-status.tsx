"use client";

import type { CustodyConnectionFailureCode, CustodyConnectionLifecycle } from "@sdp/types";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import { failureHint, STATUS_BADGE_VARIANTS, statusLabel } from "./connection-status-presentation";

/**
 * Explains when an active connection cannot sign.
 *
 * This is a different fact from the connection's lifecycle status and has to
 * read as one: an entitlement change or a runtime flag can stop signing while
 * the connection stays perfectly Active, and a single merged badge would make
 * that look like the connection had been removed. Healthy active connections
 * need no extra line; the other lifecycle states already explain availability.
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
  if (status !== "active" || isRuntimeExecutionAllowed) {
    return null;
  }
  return (
    <span className="mt-1 block text-[11px] text-warning" data-signing-state="paused">
      {t("DashboardCustody.connectionSigningPaused")}
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
