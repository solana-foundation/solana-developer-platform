"use client";

import type { CustodyProvider } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { deactivateCredentialAction } from "./connection-actions";
import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { useCustodyAction } from "./use-custody-action";

/**
 * Deletes SDP's stored copy of a secret nothing uses any more.
 *
 * A different action from deactivating a connection, and the copy says so: this
 * is credential housekeeping, and the API refuses it while any non-deactivated
 * connection still references the credential. The blocked state names those
 * connections and their projects, because "still in use" is only actionable if
 * you know by what.
 *
 * It does not revoke anything at the provider — that has to be done in the
 * Privy dashboard.
 */
export function DeactivateCredentialsDialog({
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
  const { pending, run } = useCustodyAction();

  const projectNames = new Map(lifecycle.impact.projects.map((p) => [p.id, p.name]));
  const references = lifecycle.impact.connections;
  const blocked = references.length > 0;

  const handleConfirm = async () => {
    const result = await run(
      () =>
        deactivateCredentialAction(lifecycle.providerCredential.id, provider, connectionId),
      {
        successTitle: t("DashboardCustody.deactivateCredentialsSuccessTitle"),
        successDescription: t("DashboardCustody.deactivateCredentialsSuccessDescription"),
        failedTitle: t("DashboardCustody.deactivateCredentialsFailedTitle"),
        unknownTitle: t("DashboardCustody.deactivateCredentialsUnknownTitle"),
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
      ariaLabel={t("DashboardCustody.deactivateCredentialsTitle", {
        label: lifecycle.providerCredential.label,
      })}
    >
      <div className="space-y-4 p-6" data-custody-deactivate-credentials-dialog>
        <h2 className="text-lg font-medium text-primary">
          {t("DashboardCustody.deactivateCredentialsTitle", {
            label: lifecycle.providerCredential.label,
          })}
        </h2>

        {blocked ? (
          <Callout variant="warning" title={t("DashboardCustody.credentialsStillInUseTitle")}>
            {t("DashboardCustody.credentialsStillInUseBody", {
              count: references.length,
              projects: [
                ...new Set(
                  references.map((r) => projectNames.get(r.projectId) ?? r.projectId)
                ),
              ].join(", "),
            })}
          </Callout>
        ) : null}

        <p className="text-sm leading-6 text-secondary">
          {t("DashboardCustody.deactivateCredentialsExplainer")}
        </p>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {blocked ? t("DashboardCustody.close") : t("DashboardCustody.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={blocked || pending}
          >
            {t("DashboardCustody.deactivateCredentialsConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
