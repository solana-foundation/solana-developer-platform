"use client";

import type { CustodyProvider } from "@sdp/types";
import { Loader2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { rollbackCredentialAction } from "./connection-actions";
import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { rollbackHoursRemaining } from "./connection-detail.data";
import { CredentialImpactList } from "./credential-impact-list";
import { useCustodyAction } from "./use-custody-action";

/**
 * Returns to the immediately previous credentials.
 *
 * The window leads the dialog because it is the part that expires: after it the
 * previous secret is deleted and a fresh rotation is the only way forward. Like
 * rotation this is all-or-nothing over the whole connection set — the API
 * re-verifies the old secret against the provider before committing, so a
 * confirm here is a request, not a guarantee.
 */
export function RollbackDialog({
  isOpen,
  onClose,
  lifecycle,
  provider,
  connectionId,
}: {
  isOpen: boolean;
  onClose: () => void;
  lifecycle: CustodyCredentialLifecycle;
  provider: CustodyProvider;
  connectionId: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { pending, run } = useCustodyAction();

  const rollback = lifecycle.rollback;
  if (!rollback) {
    return null;
  }

  const expiresAt = new Date(rollback.expiresAt);
  const expiresLabel = Number.isNaN(expiresAt.getTime())
    ? rollback.expiresAt
    : expiresAt.toLocaleString(locale, {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      });

  const handleConfirm = async () => {
    const result = await run(
      () =>
        rollbackCredentialAction(lifecycle.providerCredential.id, provider, connectionId),
      {
        successTitle: t("DashboardCustody.rollbackSuccessTitle"),
        successDescription: t("DashboardCustody.rollbackSuccessDescription", {
          count: lifecycle.impact.connections.length,
        }),
        failedTitle: t("DashboardCustody.rollbackFailedTitle"),
        unknownTitle: t("DashboardCustody.rollbackUnknownTitle"),
      }
    );
    if (result.status === "success") {
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={pending ? undefined : onClose}
      closeDisabled={pending}
      size="lg"
      ariaLabel={t("DashboardCustody.rollbackTitle")}
    >
      <div className="space-y-5 p-6" data-custody-rollback-dialog>
        <div className="space-y-1">
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardCustody.rollbackTitle")}
          </h2>
          <p className="text-sm text-tertiary">
            {t("DashboardCustody.rollbackSubtitle", {
              label: lifecycle.providerCredential.label,
            })}
          </p>
        </div>

        <p className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-sm leading-6 text-secondary">
          {t("DashboardCustody.rollbackWindow", {
            expiresAt: expiresLabel,
            hours: rollbackHoursRemaining(rollback.expiresAt),
          })}
        </p>

        <CredentialImpactList impact={lifecycle.impact} provider={provider} />

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t("DashboardCustody.rollbackKeepCurrent")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            iconLeft={
              pending ? (
                <Loader2Icon aria-hidden className="size-4 animate-spin" />
              ) : (
                <Undo2Icon aria-hidden className="size-4" />
              )
            }
          >
            {t("DashboardCustody.rollbackConfirm", {
              count: lifecycle.impact.connections.length,
            })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
