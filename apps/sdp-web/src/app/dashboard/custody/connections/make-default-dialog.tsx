"use client";

import type { CustodyProvider } from "@sdp/types";
import { StarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { makeDefaultConnectionAction } from "./connection-actions";
import { useCustodyAction } from "./use-custody-action";

/**
 * Points the project's wallet-less requests at this connection.
 *
 * The bullets exist to head off the three things people reasonably assume this
 * does and it does not: it moves no wallets, moves no funds, and does not
 * re-target operations already pinned to a wallet. It is also reversible, which
 * is worth saying next to a decision that sounds structural.
 */
export function MakeDefaultDialog({
  isOpen,
  onClose,
  connectionId,
  label,
  provider,
  projectName,
  currentDefaultLabel,
}: {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  label: string;
  provider: CustodyProvider;
  projectName: string;
  currentDefaultLabel: string | null;
}) {
  const t = useTranslations();
  const { pending, run } = useCustodyAction();

  const handleConfirm = async () => {
    const result = await run(
      () => makeDefaultConnectionAction(connectionId, provider),
      {
        successTitle: t("DashboardCustody.makeDefaultSuccessTitle", { label }),
        successDescription: t("DashboardCustody.makeDefaultSuccessDescription"),
        failedTitle: t("DashboardCustody.makeDefaultFailedTitle"),
        unknownTitle: t("DashboardCustody.makeDefaultUnknownTitle"),
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
      ariaLabel={t("DashboardCustody.makeDefaultTitle", { label, project: projectName })}
    >
      <div className="space-y-4 p-6" data-custody-make-default-dialog>
        <h2 className="text-lg font-medium text-primary">
          {t("DashboardCustody.makeDefaultTitle", { label, project: projectName })}
        </h2>
        <p className="text-sm leading-6 text-secondary">
          {currentDefaultLabel
            ? t("DashboardCustody.makeDefaultExplainerWithCurrent", {
                current: currentDefaultLabel,
              })
            : t("DashboardCustody.makeDefaultExplainerNoCurrent")}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-secondary">
          <li>{t("DashboardCustody.makeDefaultPointFunds")}</li>
          <li>{t("DashboardCustody.makeDefaultPointPinned")}</li>
          <li>{t("DashboardCustody.makeDefaultPointReversible")}</li>
        </ul>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t("DashboardCustody.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            iconLeft={<StarIcon aria-hidden className="size-4" />}
          >
            {t("DashboardCustody.makeDefaultConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
