"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { EarnOutcomeMark } from "./earn-flow-motion";

/**
 * Shared 202 approval-hold result view for the instant and queued withdrawal
 * modals: the custody wallet still owes a signature, so nothing was escrowed.
 */
export function EarnVaultApprovalResult({
  approvalRequestId,
  onClose,
  walletOperationId,
}: {
  approvalRequestId?: string;
  onClose: () => void;
  walletOperationId?: string;
}) {
  const t = useTranslations();
  return (
    <>
      <EarnOutcomeMark tone="warning" />
      <div className="flex items-center gap-2 pr-8">
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {t("DashboardEarn.vaultWithdraw.approvalTitle")}
        </h2>
        <Badge variant="warning">{t("DashboardEarn.vaultWithdraw.approvalStatus")}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">
        {t("DashboardEarn.vaultWithdraw.approvalBody")}
      </p>
      {approvalRequestId || walletOperationId ? (
        <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
          {approvalRequestId ? (
            <div className="flex items-start justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultApprovalRequest")}</dt>
              <dd className="max-w-64 break-all text-right text-primary">{approvalRequestId}</dd>
            </div>
          ) : null}
          {walletOperationId ? (
            <div className="flex items-start justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.withdraw.referenceLabel")}</dt>
              <dd className="max-w-64 break-all text-right text-primary">{walletOperationId}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}
