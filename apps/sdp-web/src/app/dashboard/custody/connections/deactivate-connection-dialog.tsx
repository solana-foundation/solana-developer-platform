"use client";

import type { CustodyProvider } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { HoldToConfirmButton } from "@/components/ui/hold-to-confirm-button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { deactivateConnectionAction } from "./connection-actions";
import { useCustodyAction } from "./use-custody-action";

/**
 * Ends a connection permanently.
 *
 * Two shapes, one dialog. While active wallets remain the API refuses, so the
 * dialog explains why it cannot run *and* what it would mean if it could —
 * the blocked state is where people most need to understand the action they
 * are being denied. When it can run, the confirm is a hold rather than a
 * click: this cannot be undone.
 *
 * Deliberately distinct from cancelling an unfinished setup, and from
 * revoking the key at Privy — neither of which this does.
 */
export function DeactivateConnectionDialog({
  isOpen,
  onClose,
  connectionId,
  label,
  provider,
  activeWalletCount,
  isDefault,
}: {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  label: string;
  provider: CustodyProvider;
  activeWalletCount: number;
  isDefault: boolean;
}) {
  const t = useTranslations();
  const { pending, run } = useCustodyAction();
  const blocked = activeWalletCount > 0;

  const handleConfirm = async () => {
    const result = await run(
      () => deactivateConnectionAction(connectionId, provider),
      {
        successTitle: t("DashboardCustody.deactivateConnectionSuccessTitle"),
        successDescription: t("DashboardCustody.deactivateConnectionSuccessDescription"),
        failedTitle: t("DashboardCustody.deactivateConnectionFailedTitle"),
        unknownTitle: t("DashboardCustody.deactivateConnectionUnknownTitle"),
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
      ariaLabel={t("DashboardCustody.deactivateConnectionTitle", { label })}
    >
      <div className="space-y-4 p-6" data-custody-deactivate-connection-dialog>
        <h2 className="text-lg font-medium text-primary">
          {t("DashboardCustody.deactivateConnectionTitle", { label })}
        </h2>

        {blocked ? (
          <Callout variant="warning" title={t("DashboardCustody.deactivateBlockedTitle")}>
            {t("DashboardCustody.deactivateConnectionBlockedBody", { count: activeWalletCount })}
          </Callout>
        ) : null}

        <p className="text-sm leading-6 text-secondary">
          {blocked
            ? t("DashboardCustody.deactivateConnectionBlockedExplainer")
            : t("DashboardCustody.deactivateConnectionExplainer")}
        </p>

        {blocked ? null : (
          <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-secondary">
            <li>{t("DashboardCustody.deactivateConnectionPointIrreversible")}</li>
            <li>{t("DashboardCustody.deactivateConnectionPointProviderKey")}</li>
            {isDefault ? (
              <li>{t("DashboardCustody.deactivateConnectionPointDefault")}</li>
            ) : null}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {blocked ? t("DashboardCustody.close") : t("DashboardCustody.cancel")}
          </Button>
          {blocked ? (
            <Button type="button" variant="destructive" disabled>
              {t("DashboardCustody.deactivateConnectionConfirm")}
            </Button>
          ) : (
            <HoldToConfirmButton
              onConfirm={handleConfirm}
              disabled={pending}
              label={t("DashboardCustody.deactivateConnectionConfirm")}
              holdingLabel={t("DashboardCustody.deactivateConnectionHolding")}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
